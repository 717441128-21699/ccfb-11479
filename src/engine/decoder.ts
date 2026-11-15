import { ByteReader, DecodeError } from './reader';
import { computeCrc } from './crc';
import { evalTruthy } from './expr';
import type {
  BitDef,
  CrcSpec,
  DecodeNode,
  DecodeResult,
  FieldDef,
  ProtocolDef,
  TlvConfig,
  TlvTagDef,
} from './types';

const tdCache = new Map<string, TextDecoder>();
function decodeText(bytes: Uint8Array, enc: string): string {
  let td = tdCache.get(enc);
  if (!td) {
    td = new TextDecoder(enc as string);
    tdCache.set(enc, td);
  }
  return td.decode(bytes);
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function applyScale(raw: number, scale?: number, offset?: number): number {
  if (scale === undefined && offset === undefined) return raw;
  return raw * (scale ?? 1) + (offset ?? 0);
}

function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  // 缩放后的浮点保留合理精度
  return Number.isInteger(v) ? String(v) : String(parseFloat(v.toPrecision(12)));
}

interface Scope {
  values: Map<string, unknown>;
}

export class Decoder {
  constructor(private protocol: ProtocolDef) {}

  decode(frame: Uint8Array): DecodeResult {
    const warnings: string[] = [];
    const errors: string[] = [];
    const flat: Record<string, DecodeNode> = {};
    const scope: Scope = { values: new Map() };

    // 空帧/非法输入返回结构化错误, 而非抛异常
    if (!frame || frame.length === 0) {
      const empty: DecodeNode = { name: this.protocol.name, path: '$', type: 'root', start: 0, end: 0, value: undefined, children: [] };
      return {
        ok: false, protocolId: this.protocol.id, version: this.protocol.version,
        root: empty, bytes: 0, warnings, errors: ['空报文: 没有可解码的字节'], flat,
      };
    }
    const root: DecodeNode = {
      name: this.protocol.name,
      path: '$',
      type: 'root',
      start: 0,
      end: frame.length,
      value: undefined,
      children: [],
    };

    const reader = new ByteReader(frame);
    try {
      this.decodeFields(this.protocol.fields, reader, root, '$', scope, flat, warnings, errors);
      if (reader.remaining() > 0) {
        warnings.push(`帧尾剩余 ${reader.remaining()} 字节未被协议定义覆盖 (偏移 ${reader.absPos})`);
      }
      this.checkFrameLength(frame, scope, warnings);
    } catch (e) {
      const msg = e instanceof DecodeError ? e.message : String(e);
      errors.push(msg);
    }

    root.end = frame.length;
    return {
      ok: errors.length === 0,
      protocolId: this.protocol.id,
      version: this.protocol.version,
      root,
      bytes: Math.min(reader.absPos, frame.length),
      warnings,
      errors,
      flat,
    };
  }

  /* ---------------- 帧级长度校验 ---------------- */

  private checkFrameLength(frame: Uint8Array, scope: Scope, warnings: string[]) {
    const fl = this.protocol.frame?.lengthField;
    if (!fl) return;
    const lenVal = scope.values.get(fl);
    if (typeof lenVal !== 'number') return;
    const expected = lenVal + (this.protocol.frame?.lengthAdjust ?? 0);
    if (expected !== frame.length) {
      warnings.push(`长度字段 ${fl}=${lenVal} 推算帧长 ${expected}, 实际帧长 ${frame.length}`);
    }
  }

  /* ---------------- 字段序列 ---------------- */

  private decodeFields(
    fields: FieldDef[],
    reader: ByteReader,
    parent: DecodeNode,
    parentPath: string,
    scope: Scope,
    flat: Record<string, DecodeNode>,
    warnings: string[],
    errors: string[],
  ) {
    for (const field of fields) {
      if (!evalTruthy(field.when, (n) => this.lookup(scope, n))) continue;
      try {
        const node = this.decodeField(field, reader, parentPath, scope, flat, warnings, errors);
        parent.children!.push(node);
      } catch (e) {
        const msg = e instanceof DecodeError ? e.message : String(e);
        errors.push(`字段 ${field.name} 解析失败: ${msg}`);
        throw e;
      }
    }
  }

  private lookup(scope: Scope, name: string): unknown {
    // 支持 a.b 形式时退化为按末级名查找
    const direct = scope.values.get(name);
    if (direct !== undefined) return direct;
    const tail = name.split('.').pop()!;
    return scope.values.get(tail);
  }

  private resolveLength(field: FieldDef, scope: Scope): number {
    if (field.lengthOf) {
      const v = this.lookup(scope, field.lengthOf.field);
      if (typeof v !== 'number' && typeof v !== 'bigint') {
        throw new DecodeError(`长度引用字段 ${field.lengthOf.field} 不存在或非数值`);
      }
      const n = Number(v);
      return n * (field.lengthOf.unit ?? 1) + (field.lengthOf.adjust ?? 0);
    }
    if (field.length !== undefined) return field.length;
    if (field.size !== undefined) return field.size;
    throw new DecodeError(`字段 ${field.name} 缺少长度定义`);
  }

  private decodeField(
    field: FieldDef,
    reader: ByteReader,
    parentPath: string,
    scope: Scope,
    flat: Record<string, DecodeNode>,
    warnings: string[],
    errors: string[],
  ): DecodeNode {
    const path = `${parentPath}.${field.name}`;
    const start = reader.absPos;
    const endian = field.endian ?? this.protocol.endian;
    let node: DecodeNode;

    switch (field.type) {
      case 'uint':
      case 'int':
      case 'bool':
      case 'enum': {
        const size = field.size ?? 1;
        let raw: number | bigint;
        if (field.type === 'int') raw = reader.int(size, endian);
        else raw = reader.uint(size, endian);
        const rawNum = Number(raw);
        let value: unknown = raw;
        let display: string;
        if (field.type === 'bool') {
          value = rawNum !== 0;
          display = value ? 'true' : 'false';
        } else if (field.type === 'enum' && field.mapping) {
          const label = field.mapping[String(rawNum)];
          value = rawNum;
          display = label ? `${rawNum} (${label})` : String(rawNum);
        } else {
          const scaled = applyScale(rawNum, field.scale, field.offset);
          value = field.scale !== undefined || field.offset !== undefined ? scaled : raw;
          display = formatNumber(Number(value)) + (field.units ? ` ${field.units}` : '');
        }
        node = this.leaf(field, path, start, reader.absPos, value, display, raw);
        break;
      }

      case 'float': {
        const size = (field.size ?? 4) as 4 | 8;
        const raw = reader.float(size, endian);
        const scaled = applyScale(raw, field.scale, field.offset);
        node = this.leaf(
          field,
          path,
          start,
          reader.absPos,
          field.scale !== undefined || field.offset !== undefined ? scaled : raw,
          formatNumber(field.scale !== undefined || field.offset !== undefined ? scaled : raw) +
            (field.units ? ` ${field.units}` : ''),
          raw,
        );
        break;
      }

      case 'bcd': {
        const size = field.size ?? 1;
        const raw = reader.bcd(size);
        // 统计实际 nibble 数 (0xF 填充位除外), 输出保留前导零的定长数字串
        let nibbles = size * 2;
        for (let i = 0; i < size; i++) {
          if (reader.buf[reader.absPos - size + i] >> 4 === 0x0f) nibbles--;
        }
        const text = String(raw).padStart(nibbles, '0');
        const scaled = applyScale(raw, field.scale, field.offset);
        node = this.leaf(
          field,
          path,
          start,
          reader.absPos,
          field.scale !== undefined || field.offset !== undefined ? scaled : text,
          `BCD:${field.scale !== undefined || field.offset !== undefined ? formatNumber(scaled) : text}` +
            (field.units ? ` ${field.units}` : ''),
          raw,
        );
        break;
      }

      case 'string': {
        const len = this.resolveLength(field, scope);
        const raw = reader.slice(len);
        const enc = field.encoding ?? 'ascii';
        let text: string;
        if (enc === 'hex') text = toHex(raw);
        else text = decodeText(raw, enc === 'gbk' ? 'gbk' : enc);
        if (field.trim ?? true) text = text.replace(/[\0\s]+$/g, '');
        node = this.leaf(field, path, start, reader.absPos, text, `"${text}"`, toHex(raw));
        break;
      }

      case 'bytes': {
        const len = this.resolveLength(field, scope);
        const raw = reader.slice(len);
        node = this.leaf(field, path, start, reader.absPos, toHex(raw), `0x${toHex(raw)}`, raw);
        break;
      }

      case 'bits':
        node = this.decodeBits(field, reader, path, start);
        break;

      case 'struct': {
        node = {
          name: field.name,
          path,
          type: 'struct',
          start,
          end: start,
          value: undefined,
          children: [],
        };
        this.decodeFields(field.fields ?? [], reader, node, path, scope, flat, warnings, errors);
        node.end = reader.absPos;
        break;
      }

      case 'array':
        node = this.decodeArray(field, reader, path, start, scope, flat, warnings, errors);
        break;

      case 'tlv':
        node = this.decodeTlv(field, reader, path, start, scope, flat, warnings, errors);
        break;

      case 'crc':
        node = this.decodeCrc(field, reader, path, start);
        if (node.crcOk === false) {
          const msg = `校验失败 @${field.name}: 报文值 0x${Number(node.raw).toString(16)}, 计算值 0x${String(node.value).slice(2)}`;
          node.warning = msg;
          warnings.push(msg);
        }
        break;

      default:
        throw new DecodeError(`未知字段类型: ${(field as FieldDef).type}`);
    }

    flat[path] = node;
    scope.values.set(field.name, node.raw ?? node.value);
    return node;
  }

  private leaf(
    field: FieldDef,
    path: string,
    start: number,
    end: number,
    value: unknown,
    display: string,
    raw: unknown,
  ): DecodeNode {
    return { name: field.name, path, type: field.type, start, end, value, display, raw };
  }

  /* ---------------- 位域 ---------------- */

  private decodeBits(field: FieldDef, reader: ByteReader, path: string, start: number): DecodeNode {
    const size = field.size ?? 1;
    const bytes = reader.slice(size);
    const endian = field.endian ?? this.protocol.endian;
    let word = 0;
    if (endian === 'be') for (const b of bytes) word = word * 256 + b;
    else for (let i = bytes.length - 1; i >= 0; i--) word = word * 256 + bytes[i];

    const totalBits = size * 8;
    const order = field.bitOrder ?? 'msb';
    const children = field.children ?? [];
    const bitNodes: NonNullable<DecodeNode['bits']> = [];
    const obj: Record<string, number> = {};
    let cursor = 0;

    for (const bit of children) {
      const bitStart = order === 'msb' ? totalBits - cursor - bit.bits : cursor;
      const bitEnd = bitStart + bit.bits - 1;
      const mask = bit.bits >= 32 ? 0xffffffff : (1 << bit.bits) - 1;
      // 移位超过 30 位用无符号右移避免 1<<31 负值问题
      const shifted = bitStart >= 31 ? word / 2 ** bitStart : word >>> bitStart;
      let v = Math.floor(shifted) & mask;
      if (bit.signed === 'signed') {
        const sign = 1 << (bit.bits - 1);
        v = (v ^ sign) - sign;
      }
      if (bit.scale !== undefined || bit.offset !== undefined) {
        const scaled = applyScale(v, bit.scale, bit.offset);
        obj[bit.name] = scaled;
      } else {
        obj[bit.name] = v;
      }
      let display = String(obj[bit.name]);
      if (bit.mapping) display = bit.mapping[String(v)] ? `${v} (${bit.mapping[String(v)]})` : display;
      bitNodes.push({ name: bit.name, bitStart, bitEnd, value: v, display });
      cursor += bit.bits;
    }

    return {
      name: field.name,
      path,
      type: 'bits',
      start,
      end: reader.absPos,
      value: obj,
      display: bitNodes.map((b) => `${b.name}=${b.display}`).join(', '),
      raw: word,
      bits: bitNodes,
    };
  }

  /* ---------------- 数组 ---------------- */

  private decodeArray(
    field: FieldDef,
    reader: ByteReader,
    path: string,
    start: number,
    scope: Scope,
    flat: Record<string, DecodeNode>,
    warnings: string[],
    errors: string[],
  ): DecodeNode {
    const element = field.element;
    if (!element) throw new DecodeError(`数组 ${field.name} 缺少 element 定义`);

    let count = field.count;
    if (count === undefined && field.countOf !== undefined) {
      const v = this.lookup(scope, field.countOf);
      count = Number(v);
    }

    const node: DecodeNode = {
      name: field.name,
      path,
      type: 'array',
      start,
      end: start,
      value: [],
      children: [],
    };

    const pushItem = (i: number) => {
      const itemPath = `${path}.${element.name}[${i}]`;
      const itemStart = reader.absPos;
      const item = this.decodeField(element, reader, path, scope, flat, warnings, errors);
      item.path = itemPath;
      item.name = `${element.name}[${i}]`;
      flat[itemPath] = item;
      void itemStart;
      node.children!.push(item);
      (node.value as unknown[]).push(item.value);
    };

    if (field.terminator !== undefined) {
      let i = 0;
      // 终止符模式: 逐元素解码直到读到终止字节 (终止符独立成字节时按 bytes 元素处理)
      while (!reader.eof()) {
        if (reader.peek() === field.terminator) {
          reader.u8();
          if (field.includeTerminator === false) break;
          break;
        }
        pushItem(i++);
      }
    } else {
      if (count === undefined) throw new DecodeError(`数组 ${field.name} 缺少 count/countOf/terminator`);
      for (let i = 0; i < count; i++) pushItem(i);
    }

    node.end = reader.absPos;
    return node;
  }

  /* ---------------- TLV ---------------- */

  private decodeTlv(
    field: FieldDef,
    reader: ByteReader,
    path: string,
    start: number,
    scope: Scope,
    flat: Record<string, DecodeNode>,
    warnings: string[],
    errors: string[],
  ): DecodeNode {
    const cfg: TlvConfig = field.tlv!;
    const node: DecodeNode = {
      name: field.name,
      path,
      type: 'tlv',
      start,
      end: start,
      value: undefined,
      children: [],
    };

    const tagEndian = cfg.tag.endian ?? this.protocol.endian;
    const lenEndian = cfg.length.endian ?? this.protocol.endian;
    let index = 0;
    const maxItems = cfg.countField ? Number(this.lookup(scope, cfg.countField)) : Infinity;

    while (!reader.eof() && index < maxItems) {
      const itemStart = reader.absPos;
      const tag = reader.uint(cfg.tag.size, tagEndian);
      const lengthRaw = reader.uint(cfg.length.size, lenEndian);
      let valueLen = lengthRaw;
      if (cfg.length.includes === 'total') valueLen = lengthRaw - cfg.tag.size - cfg.length.size;
      else if (cfg.length.includes === 'remaining') valueLen = lengthRaw - cfg.length.size;
      if (valueLen < 0) throw new DecodeError(`TLV tag=0x${tag.toString(16)} 长度字段值 ${lengthRaw} 非法`);

      const tagDef = this.findTagDef(cfg, tag);
      const itemPath = `${path}.${tagDef?.name ?? 'tag' + tag.toString(16)}[${index}]`;

      if (!tagDef && cfg.unknown === 'error') {
        throw new DecodeError(`TLV 出现未定义 tag=0x${tag.toString(16)}`);
      }

      const valueReader = cfg.greedy ? reader.tail() : reader.sub(valueLen);
      const itemNode: DecodeNode = {
        name: tagDef ? tagDef.name : `unknown_0x${tag.toString(16)}`,
        path: itemPath,
        type: 'tlv-item',
        start: itemStart,
        end: itemStart,
        value: undefined,
        display: `tag=0x${tag.toString(16)}, len=${lengthRaw}`,
        children: [],
      };

      if (!tagDef || cfg.unknown === 'skip') {
        if (!tagDef && cfg.unknown === 'skip') {
          // 已 sub 消费, 不挂节点
        } else {
          // raw 模式: 保留原始字节
          const raw = valueReader.slice(valueReader.remaining());
          itemNode.value = toHex(raw);
          itemNode.display += ` (未知 tag, ${raw.length} 字节)`;
          itemNode.end = reader.absPos;
          itemNode.children = undefined;
          node.children!.push(itemNode);
          flat[itemPath] = itemNode;
        }
      } else {
        const childField: FieldDef = { ...tagDef, name: tagDef.name };
        const decoded = this.decodeField(childField, valueReader, path, scope, flat, warnings, errors);
        // 叶子 tag 直接作为 item 节点, 保留 tag/len 展示信息
        decoded.path = itemPath;
        decoded.name = tagDef.name;
        decoded.type = 'tlv-item';
        decoded.display = `tag=0x${tag.toString(16)}, len=${lengthRaw} → ${tagDef.name}=${decoded.display ?? decoded.value}`;
        node.children!.push(decoded);
        flat[itemPath] = decoded;
      }

      if (cfg.greedy) break;
      index++;
    }

    node.end = reader.absPos;
    return node;
  }

  private findTagDef(cfg: TlvConfig, tag: number): TlvTagDef | undefined {
    return (cfg.tags ?? []).find((t) =>
      Array.isArray(t.tag) ? t.tag.includes(tag) : t.tag === tag,
    );
  }

  /* ---------------- CRC ---------------- */

  private decodeCrc(field: FieldDef, reader: ByteReader, path: string, start: number): DecodeNode {
    const spec: CrcSpec = field.crc ?? { algo: 'crc16-modbus' };
    const size = field.size ?? (spec.algo === 'crc32' ? 4 : spec.algo === 'checksum8' ? 1 : 2);
    const endian = field.endian ?? spec.endian ?? this.protocol.endian;
    const wireValue = reader.uint(size, endian);

    const rangeStart = spec.rangeStart ?? 0;
    const rangeEnd = spec.rangeEnd ?? start;
    const calc = computeCrc(spec, reader.buf, rangeStart, rangeEnd);
    const ok = calc === wireValue;

    return {
      name: field.name,
      path,
      type: 'crc',
      start,
      end: reader.absPos,
      value: '0x' + calc.toString(16).padStart(size * 2, '0'),
      raw: wireValue,
      display: `报文=0x${wireValue.toString(16).padStart(size * 2, '0')} 计算=0x${calc
        .toString(16)
        .padStart(size * 2, '0')} ${ok ? '✓' : '✗'}`,
      crcOk: ok,
    };
  }
}

/** 便捷函数: 单帧解码 */
export function decodeFrame(protocol: ProtocolDef, frame: Uint8Array): DecodeResult {
  const t0 = performance.now();
  const result = new Decoder(protocol).decode(frame);
  result.elapsedUs = (performance.now() - t0) * 1000;
  return result;
}
