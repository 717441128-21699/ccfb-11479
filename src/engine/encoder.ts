/**
 * 声明式编码器: 与 decoder 严格对称, 依据同一份 ProtocolDef 把值对象编码为字节帧。
 * 用于合成带"期望解码结果"的测试报文, 保证编解码 round-trip。
 */
import { computeCrc } from './crc';
import { evalTruthy } from './expr';
import type { FieldDef, ProtocolDef, TlvConfig } from './types';

type Value = unknown;

class Writer {
  private chunks: number[] = [];
  get length(): number {
    return this.chunks.length;
  }
  u8(v: number): void { this.chunks.push(Math.floor(v) & 0xff); }
  bytes(b: Uint8Array | number[]): void { for (const x of b) this.chunks.push(Math.floor(x) & 0xff); }
  /** 纯数学取模写整数, 不经过 32 位位运算, 支持 size<=8 与负数二补码输入 */
  uint(v: number, n: number, endian: 'le' | 'be'): void {
    let x = Math.floor(v);
    if (x < 0) x += 256 ** n;
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      out[i] = x % 256;
      x = Math.floor(x / 256);
    }
    if (endian === 'be') for (let i = n - 1; i >= 0; i--) this.chunks.push(out[i]);
    else for (let i = 0; i < n; i++) this.chunks.push(out[i]);
  }
  float(v: number, n: 4 | 8, endian: 'le' | 'be'): void {
    const ab = new ArrayBuffer(n);
    const dv = new DataView(ab);
    if (n === 4) dv.setFloat32(0, v, endian === 'le');
    else dv.setFloat64(0, v, endian === 'le');
    this.bytes(new Uint8Array(ab));
  }
  toBytes(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

export class Encoder {
  constructor(private protocol: ProtocolDef) {}

  encode(values: Record<string, Value>): Uint8Array {
    const w = new Writer();
    const scope = new Map<string, Value>();
    this.encodeFields(this.protocol.fields, values, w, scope);
    return w.toBytes();
  }

  private encodeFields(fields: FieldDef[], values: Record<string, Value>, w: Writer, scope: Map<string, Value>): void {
    for (const f of fields) {
      if (!evalTruthy(f.when, (n) => scope.get(n))) continue;
      this.encodeField(f, values[f.name], w, scope, values);
    }
  }

  private resolveLen(f: FieldDef, v: Value, scope: Map<string, Value>): number {
    if (f.lengthOf) {
      const ref = Number(scope.get(f.lengthOf.field));
      return ref * (f.lengthOf.unit ?? 1) + (f.lengthOf.adjust ?? 0);
    }
    if (f.length !== undefined) return f.length;
    if (f.size !== undefined) return f.size;
    if (typeof v === 'string') return v.length;
    if (v instanceof Uint8Array) return v.length;
    if (Array.isArray(v)) return v.length;
    throw new Error(`字段 ${f.name} 无法确定长度`);
  }

  private encodeField(f: FieldDef, v: Value, w: Writer, scope: Map<string, Value>, root: Record<string, Value>): void {
    const endian = f.endian ?? this.protocol.endian;
    // 生成器给的是"展示值"(缩放后), 编码前还原为线上原始值
    const undoScale = (x: number): number => {
      if (f.scale !== undefined || f.offset !== undefined) {
        return Math.round((x - (f.offset ?? 0)) / (f.scale ?? 1));
      }
      return x;
    };
    switch (f.type) {
      case 'uint':
      case 'enum':
      case 'bool':
        w.uint(undoScale(Number(v)), f.size ?? 1, endian);
        break;
      case 'int': {
        const size = f.size ?? 1;
        let x = undoScale(Number(v));
        if (x < 0) x = 2 ** (size * 8) + x; // 二补码, 用 2^n+x 避免 x<<32 溢出
        w.uint(x, size, endian);
        break;
      }
      case 'float':
        w.float(Number(v), (f.size ?? 4) as 4 | 8, endian);
        break;
      case 'bcd': {
        const size = f.size ?? 1;
        const maxDigits = size * 2;
        // 直接按字符串逐 nibble 编码, 不经过 Number (保留前导零);
        // 数字位数为奇数时, 最高 nibble 填 0xF (与 reader.bcd 的填充约定一致)
        let digits: string;
        if (typeof v === 'string') digits = v.replace(/\D/g, '');
        else digits = String(Math.abs(undoScale(Number(v))));
        if (digits.length > maxDigits) digits = digits.slice(-maxDigits);
        if (digits.length % 2 === 1) digits = 'F' + digits;
        while (digits.length < maxDigits) digits = '0' + digits;
        for (let i = 0; i < size; i++) {
          const hi = digits[i * 2];
          const lo = digits[i * 2 + 1];
          w.u8((hi === 'F' ? 0x0f : Number(hi)) * 16 + Number(lo));
        }
        break;
      }
      case 'string': {
        const len = this.resolveLen(f, v, scope);
        const enc = f.encoding ?? 'ascii';
        let bytes: Uint8Array;
        if (enc === 'hex') bytes = hexToBytes(String(v));
        else bytes = new TextEncoder().encode(String(v));
        w.bytes(bytes);
        for (let i = bytes.length; i < len; i++) w.u8(0); // 零填充到定长
        break;
      }
      case 'bytes': {
        const b = v instanceof Uint8Array ? v : hexToBytes(String(v));
        const len = this.resolveLen(f, v, scope);
        w.bytes(b);
        for (let i = b.length; i < len; i++) w.u8(0);
        break;
      }
      case 'bits':
        this.encodeBits(f, v as Record<string, number>, w, endian);
        break;
      case 'struct':
        this.encodeFields(f.fields ?? [], v as Record<string, Value>, w, scope);
        break;
      case 'array':
        this.encodeArray(f, v as Value[], w, scope, root);
        break;
      case 'tlv':
        this.encodeTlv(f, v as Record<string, Value>, w, scope);
        break;
      case 'crc':
        this.encodeCrc(f, w);
        break;
      default:
        throw new Error(`编码器不支持类型: ${f.type}`);
    }
    scope.set(f.name, v);
  }

  private encodeBits(f: FieldDef, v: Record<string, number>, w: Writer, endian: 'le' | 'be'): void {
    const size = f.size ?? 1;
    const total = size * 8;
    const order = f.bitOrder ?? 'msb';
    let word = 0;
    let cursor = 0;
    for (const bit of f.children ?? []) {
      let raw = Number(v[bit.name]);
      if (bit.scale !== undefined || bit.offset !== undefined) {
        raw = Math.round((raw - (bit.offset ?? 0)) / (bit.scale ?? 1));
      }
      const bitStart = order === 'msb' ? total - cursor - bit.bits : cursor;
      const mask = bit.bits >= 32 ? 0xffffffff : (1 << bit.bits) - 1;
      word |= (raw & mask) << bitStart;
      cursor += bit.bits;
    }
    // 用字节序列写入, 避免 32 位有符号位运算问题
    const bytes: number[] = [];
    for (let i = 0; i < size; i++) bytes.push((word >>> (8 * (size - 1 - i))) & 0xff);
    if (endian === 'be') w.bytes(bytes);
    else w.bytes([...bytes].reverse());
  }

  private encodeArray(f: FieldDef, list: Value[], w: Writer, scope: Map<string, Value>, root: Record<string, Value>): void {
    const el = f.element!;
    for (const item of list) {
      this.encodeField(el, item, w, scope, root);
    }
    if (f.terminator !== undefined) w.u8(f.terminator);
  }

  private encodeTlv(f: FieldDef, values: Record<string, Value>, w: Writer, scope: Map<string, Value>): void {
    const cfg = f.tlv!;
    const tagEndian = cfg.tag.endian ?? this.protocol.endian;
    const lenEndian = cfg.length.endian ?? this.protocol.endian;
    for (const tagDef of cfg.tags ?? []) {
      const tagVal = Array.isArray(tagDef.tag) ? tagDef.tag[0] : tagDef.tag;
      if (!(tagDef.name in values)) continue;
      if (!evalTruthy(tagDef.when, (n) => scope.get(n))) continue;
      // 先把 value 编码到独立 buffer 以获取长度
      const vw = new Writer();
      this.encodeField({ ...tagDef, name: tagDef.name }, values[tagDef.name], vw, scope, values);
      const valueBytes = vw.toBytes();
      w.uint(tagVal, cfg.tag.size, tagEndian);
      let lenField = valueBytes.length;
      if (cfg.length.includes === 'total') lenField += cfg.tag.size + cfg.length.size;
      else if (cfg.length.includes === 'remaining') lenField += cfg.length.size;
      w.uint(lenField, cfg.length.size, lenEndian);
      w.bytes(valueBytes);
    }
  }

  private encodeCrc(f: FieldDef, w: Writer): void {
    const spec = f.crc ?? { algo: 'crc16-modbus' };
    const size = f.size ?? (spec.algo === 'crc32' ? 4 : spec.algo === 'checksum8' ? 1 : 2);
    const frame = w.toBytes();
    const start = spec.rangeStart ?? 0;
    const end = spec.rangeEnd ?? frame.length;
    const crc = computeCrc(spec, frame, start, end);
    w.uint(crc, size, f.endian ?? spec.endian ?? this.protocol.endian);
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/0x/i, '').replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function encodeFrame(protocol: ProtocolDef, values: Record<string, Value>): Uint8Array {
  return new Encoder(protocol).encode(values);
}
