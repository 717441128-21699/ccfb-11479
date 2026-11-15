/**
 * 解码引擎:按声明式协议描述把二进制报文解成字段树。
 * 设计目标:纯函数、零依赖、浏览器和 Node 通用;1 万条/秒级性能。
 */

import {
  checksumDefaultEndian,
  checksumSize,
  type ChecksumResult,
  type DecodeNode,
  type DecodeResult,
  type FieldDef,
  type ProtocolDef,
  type ProtocolVersion,
} from './types.js';
import { computeChecksum, readUint } from './crc.js';

export interface DecodeOptions {
  version?: string; // 指定版本;缺省按 match 自动匹配,都不匹配用最后一个版本
}

interface Ctx {
  buf: Uint8Array;
  pos: number;
  end: number; // 报文中数据区终点(不含校验)
  byName: Map<string, unknown>; // 已解码字段按名字索引,供 lengthFrom/countFrom 引用
  values: Record<string, unknown>;
  errors: string[];
}

const textDecoder = new TextDecoder('utf-8', { fatal: false });

export function toHex(buf: Uint8Array, start = 0, end = buf.length): string {
  let s = '';
  for (let i = start; i < end; i++) s += buf[i].toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 !== 0) throw new Error('十六进制长度必须为偶数');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/** 缩放系数的小数位,用于把浮点误差圆整掉,保证编解码往返一致 */
function scaleDecimals(scale: number): number {
  if (!isFinite(scale) || scale === 0) return 0;
  const e = Math.floor(Math.log10(Math.abs(scale)));
  return Math.max(0, -e);
}

function applyScale(raw: number, scale?: number, add?: number): number {
  if (scale === undefined && add === undefined) return raw;
  const v = raw * (scale ?? 1) + (add ?? 0);
  const d = scale !== undefined ? scaleDecimals(scale) + 2 : 10;
  return Number(v.toFixed(Math.min(d, 12)));
}

export function decodeMessage(
  buf: Uint8Array,
  proto: ProtocolDef,
  opts: DecodeOptions = {},
): DecodeResult {
  const version = pickVersion(buf, proto, opts);
  return decodeWithVersion(buf, proto, version);
}

function pickVersion(buf: Uint8Array, proto: ProtocolDef, opts: DecodeOptions): ProtocolVersion {
  if (opts.version !== undefined) {
    const v = proto.versions.find((x) => x.version === opts.version);
    if (!v) throw new Error(`协议 ${proto.id} 没有版本 ${opts.version}`);
    return v;
  }
  for (const v of proto.versions) {
    if (!v.match || v.match.length === 0) continue;
    try {
      const r = decodeWithVersion(buf, proto, v);
      if (r.ok && v.match.every((m) => r.values[m.path] === m.equals)) return v;
    } catch {
      /* 尝试下一个版本 */
    }
  }
  return proto.versions[proto.versions.length - 1];
}

export function decodeWithVersion(
  buf: Uint8Array,
  proto: ProtocolDef,
  version: ProtocolVersion,
): DecodeResult {
  const csSize = version.checksum ? checksumSize(version.checksum.algorithm) : 0;
  const ctx: Ctx = {
    buf,
    pos: 0,
    end: buf.length - csSize,
    byName: new Map(),
    values: {},
    errors: [],
  };
  if (ctx.end < 0) ctx.end = 0;

  const root: DecodeNode = {
    name: proto.name,
    path: '',
    kind: 'message',
    offset: 0,
    length: buf.length,
    children: [],
  };

  decodeFields(version.fields, ctx, root, '');

  // 校验
  let checksum: ChecksumResult | undefined;
  if (version.checksum) {
    const alg = version.checksum.algorithm;
    const endian = version.checksum.endian ?? checksumDefaultEndian(alg);
    const start = version.checksum.startOffset ?? 0;
    const actual = computeChecksum(alg, buf, start, buf.length - csSize);
    const expected =
      buf.length >= csSize ? readUint(buf, buf.length - csSize, csSize, endian) : -1;
    checksum = { ok: expected === actual, algorithm: alg, expected, actual };
    const node: DecodeNode = {
      name: 'checksum',
      path: 'checksum',
      kind: 'checksum',
      offset: buf.length - csSize,
      length: csSize,
      value: expected,
      display: `${alg}: 报文值 0x${expected.toString(16)} / 计算值 0x${actual.toString(16)}`,
    };
    if (!checksum.ok) {
      node.error = '校验失败';
      ctx.errors.push(
        `校验失败(${alg}): 报文 0x${expected.toString(16)} ≠ 计算 0x${actual.toString(16)}`,
      );
    }
    root.children!.push(node);
    ctx.values['checksum'] = expected;
  }

  if (ctx.pos !== ctx.end) {
    ctx.errors.push(`解码后剩余 ${ctx.end - ctx.pos} 字节未消费`);
  }

  return {
    ok: ctx.errors.length === 0,
    protocolId: proto.id,
    version: version.version,
    root,
    values: ctx.values,
    checksum,
    errors: ctx.errors,
  };
}

function decodeFields(fields: FieldDef[], ctx: Ctx, parent: DecodeNode, prefix: string): void {
  for (const f of fields) {
    decodeField(f, ctx, parent, prefix);
    if (ctx.errors.length > 0 && ctx.pos > ctx.end) return; // 已经越界,停止
  }
}

function need(ctx: Ctx, n: number, name: string): boolean {
  if (ctx.pos + n > ctx.end) {
    ctx.errors.push(`字段 ${name}: 需要 ${n} 字节,只剩 ${Math.max(0, ctx.end - ctx.pos)} 字节`);
    return false;
  }
  return true;
}

function refNumber(ctx: Ctx, ref: string, fieldName: string): number {
  const v = ctx.byName.get(ref);
  if (typeof v !== 'number') {
    ctx.errors.push(`字段 ${fieldName}: 引用的字段 ${ref} 不存在或不是数字`);
    return 0;
  }
  return v;
}

function decodeField(
  f: FieldDef,
  ctx: Ctx,
  parent: DecodeNode,
  prefix: string,
  pathOverride?: string,
): void {
  const path = pathOverride ?? (prefix ? `${prefix}.${f.name}` : f.name);
  const start = ctx.pos;
  const node: DecodeNode = { name: f.name, path, kind: f.kind, offset: start, length: 0 };
  parent.children!.push(node);

  switch (f.kind) {
    case 'uint':
    case 'int': {
      const bytes = f.bits / 8;
      if (!need(ctx, bytes, f.name)) return;
      const endian = f.endian ?? 'big';
      let raw: number;
      if (f.bits === 64) {
        // 64 位用 BigInt 读,安全范围内转 number
        let v = 0n;
        if (endian === 'little') {
          for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(ctx.buf[start + i]);
        } else {
          for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(ctx.buf[start + i]);
        }
        if (f.kind === 'int' && v >= 1n << 63n) v -= 1n << 64n;
        raw = v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(-Number.MAX_SAFE_INTEGER)
          ? Number(v)
          : Number(v); // 超出安全范围会有精度损失,展示层用 display
        node.display = v.toString();
        ctx.pos += 8;
        node.length = 8;
        node.value = raw;
        ctx.byName.set(f.name, raw);
        ctx.values[path] = raw;
        return;
      }
      raw = readUint(ctx.buf, start, bytes, endian);
      if (f.kind === 'int') {
        const mod = 2 ** f.bits; // 不用位移,避免 32 位时 JS 位运算溢出
        if (raw >= mod / 2) raw -= mod;
      }
      ctx.pos += bytes;
      node.length = bytes;
      const value = applyScale(raw, f.scale, f.add);
      node.value = value;
      const enumLabel = f.enum?.[String(raw)];
      node.display = enumLabel !== undefined ? `${enumLabel} (${raw})` : undefined;
      node.unit = f.unit;
      ctx.byName.set(f.name, raw);
      ctx.values[path] = value;
      return;
    }

    case 'bcd': {
      if (!need(ctx, f.bytes, f.name)) return;
      let digits = '';
      for (let i = 0; i < f.bytes; i++) {
        const b = ctx.buf[start + i];
        digits += ((b >> 4) & 0xf).toString() + (b & 0xf).toString();
      }
      ctx.pos += f.bytes;
      node.length = f.bytes;
      if (f.scale !== undefined || f.add !== undefined) {
        const value = applyScale(parseInt(digits, 10), f.scale, f.add);
        node.value = value;
        ctx.values[path] = value;
        ctx.byName.set(f.name, value);
      } else {
        node.value = digits;
        ctx.values[path] = digits;
        ctx.byName.set(f.name, digits);
      }
      node.unit = f.unit;
      return;
    }

    case 'bytes': {
      const len = f.length ?? (f.lengthFrom ? refNumber(ctx, f.lengthFrom, f.name) : 0);
      if (!need(ctx, len, f.name)) return;
      const bytes = ctx.buf.subarray(start, start + len);
      ctx.pos += len;
      node.length = len;
      let value: string;
      if (f.encoding === 'ascii' || f.encoding === 'utf8') {
        value = textDecoder.decode(bytes);
      } else {
        value = toHex(bytes);
      }
      node.value = value;
      ctx.values[path] = value;
      ctx.byName.set(f.name, f.encoding === 'hex' || !f.encoding ? value : value);
      return;
    }

    case 'bits': {
      if (!need(ctx, f.bytes, f.name)) return;
      const endian = f.endian ?? 'big';
      let container = 0n;
      if (endian === 'little') {
        for (let i = f.bytes - 1; i >= 0; i--) container = (container << 8n) | BigInt(ctx.buf[start + i]);
      } else {
        for (let i = 0; i < f.bytes; i++) container = (container << 8n) | BigInt(ctx.buf[start + i]);
      }
      ctx.pos += f.bytes;
      node.length = f.bytes;
      node.children = [];
      const totalBits = f.bytes * 8;
      const order = f.bitOrder ?? 'lsb';
      let consumed = 0;
      for (const sub of f.fields) {
        const shift = order === 'lsb' ? consumed : totalBits - consumed - sub.bits;
        const mask = (1n << BigInt(sub.bits)) - 1n;
        const raw = Number((container >> BigInt(shift)) & mask);
        const subPath = `${path}.${sub.name}`;
        const enumLabel = sub.enum?.[String(raw)];
        node.children.push({
          name: sub.name,
          path: subPath,
          kind: 'bit',
          offset: start,
          length: f.bytes,
          bitOffset: shift,
          bitLength: sub.bits,
          value: raw,
          display: enumLabel !== undefined ? `${enumLabel} (${raw})` : undefined,
        });
        ctx.values[subPath] = raw;
        ctx.byName.set(sub.name, raw);
        consumed += sub.bits;
      }
      if (consumed > totalBits) {
        node.error = `位域总位数 ${consumed} 超过 ${totalBits}`;
        ctx.errors.push(`字段 ${f.name}: 位域总位数 ${consumed} 超过 ${totalBits}`);
      }
      return;
    }

    case 'array': {
      const count = f.count ?? (f.countFrom ? refNumber(ctx, f.countFrom, f.name) : 0);
      node.children = [];
      for (let i = 0; i < count; i++) {
        decodeField(f.element, ctx, node, '', `${path}[${i}]`);
        if (ctx.errors.length > 0 && ctx.pos > ctx.end) break;
      }
      node.length = ctx.pos - start;
      return;
    }

    case 'group': {
      node.children = [];
      decodeFields(f.fields, ctx, node, path);
      node.length = ctx.pos - start;
      return;
    }

    case 'tlv': {
      node.children = [];
      const endian = f.endian ?? 'big';
      const max = f.maxItems ?? 1024;
      let i = 0;
      const hdr = f.typeBytes + f.lengthBytes;
      while (ctx.pos + hdr <= ctx.end && i < max) {
        const itemStart = ctx.pos;
        const type = readUint(ctx.buf, ctx.pos, f.typeBytes, endian);
        const len = readUint(ctx.buf, ctx.pos + f.typeBytes, f.lengthBytes, endian);
        const valueStart = itemStart + hdr;
        if (valueStart + len > ctx.end) {
          ctx.errors.push(`TLV ${f.name}[${i}]: 声明长度 ${len} 超出剩余报文`);
          break;
        }
        const def = f.types[String(type)];
        const itemNode: DecodeNode = {
          name: def ? def.name : `未知类型0x${type.toString(16)}`,
          path: `${path}[${i}]`,
          kind: 'tlv-item',
          offset: itemStart,
          length: hdr + len,
          children: [],
        };
        itemNode.children!.push({
          name: 'type',
          path: `${path}[${i}].type`,
          kind: 'uint',
          offset: itemStart,
          length: f.typeBytes,
          value: type,
        });
        itemNode.children!.push({
          name: 'length',
          path: `${path}[${i}].length`,
          kind: 'uint',
          offset: itemStart + f.typeBytes,
          length: f.lengthBytes,
          value: len,
        });
        ctx.values[`${path}[${i}].type`] = type;
        ctx.pos = valueStart;
        if (def) {
          const subEnd = ctx.end;
          ctx.end = valueStart + len; // 限制嵌套解码范围
          decodeFields(def.fields, ctx, itemNode, `${path}[${i}]`);
          ctx.end = subEnd;
        } else {
          const hex = toHex(ctx.buf, valueStart, valueStart + len);
          itemNode.children!.push({
            name: 'raw',
            path: `${path}[${i}].raw`,
            kind: 'bytes',
            offset: valueStart,
            length: len,
            value: hex,
          });
          ctx.values[`${path}[${i}].raw`] = hex;
        }
        ctx.pos = valueStart + len;
        node.children!.push(itemNode);
        i++;
      }
      node.length = ctx.pos - start;
      return;
    }

    case 'pad': {
      if (!need(ctx, f.bytes, f.name)) return;
      ctx.pos += f.bytes;
      node.length = f.bytes;
      node.value = toHex(ctx.buf, start, start + f.bytes);
      return;
    }

    case 'rest': {
      const len = Math.max(0, ctx.end - ctx.pos);
      const bytes = ctx.buf.subarray(start, start + len);
      ctx.pos += len;
      node.length = len;
      const value =
        f.encoding === 'ascii' || f.encoding === 'utf8' ? textDecoder.decode(bytes) : toHex(bytes);
      node.value = value;
      ctx.values[path] = value;
      ctx.byName.set(f.name, value);
      return;
    }
  }
}
