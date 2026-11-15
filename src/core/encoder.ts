/**
 * 编码器:解码器的逆运算。把"解码形态"的值对象编码回二进制报文。
 * 主要用于测试数据生成,也验证了解码器声明式描述是完备可逆的。
 *
 * 值对象形状与解码结果对应:
 *   - 叶子字段:工程值(uint/int 为数字,bcd 无缩放为数字字符串,bytes 为 hex/文本)
 *   - group:嵌套对象;array:数组;tlv:[{ type, ...字段值 }] 或未知类型 { type, raw: 'hex' }
 *   - 枚举字段可直接给原始值,也可给标签字符串
 * lengthFrom / countFrom 引用的长度、个数字段会自动推导,不需要手工给值。
 */

import {
  checksumDefaultEndian,
  checksumSize,
  type FieldDef,
  type ProtocolDef,
  type ProtocolVersion,
} from './types.js';
import { computeChecksum, writeChecksumBytes } from './crc.js';
import { fromHex } from './decoder.js';

const textEncoder = new TextEncoder();

export function encodeMessage(
  proto: ProtocolDef,
  values: Record<string, unknown>,
  version?: string,
): Uint8Array {
  const v = version
    ? proto.versions.find((x) => x.version === version)
    : proto.versions[proto.versions.length - 1];
  if (!v) throw new Error(`协议 ${proto.id} 没有版本 ${version}`);
  return encodeWithVersion(v, values);
}

export function encodeWithVersion(
  version: ProtocolVersion,
  values: Record<string, unknown>,
): Uint8Array {
  const scope: Record<string, unknown> = { ...values };
  derive(version.fields, scope);
  const out: number[] = [];
  encodeFields(version.fields, scope, out);
  if (version.checksum) {
    const alg = version.checksum.algorithm;
    const data = Uint8Array.from(out);
    const crc = computeChecksum(alg, data, version.checksum.startOffset ?? 0, data.length);
    const endian = version.checksum.endian ?? checksumDefaultEndian(alg);
    out.push(...writeChecksumBytes(crc, checksumSize(alg), endian));
  }
  return Uint8Array.from(out);
}

/** 自动推导 lengthFrom / countFrom 引用的字段值(原地写入 scope) */
export function derive(fields: FieldDef[], scope: Record<string, unknown>): void {
  for (const f of fields) {
    if ((f.kind === 'bytes' || f.kind === 'rest') && (f as { lengthFrom?: string }).lengthFrom) {
      const ref = (f as { lengthFrom?: string }).lengthFrom!;
      scope[ref] = byteLengthOf(f, scope[f.name]);
    }
    if (f.kind === 'array' && f.countFrom) {
      scope[f.countFrom] = (scope[f.name] as unknown[]).length;
    }
    if (f.kind === 'group') {
      derive(f.fields, scope[f.name] as Record<string, unknown>);
    }
    if (f.kind === 'array' && f.element.kind === 'group') {
      for (const item of scope[f.name] as Record<string, unknown>[]) {
        derive(f.element.fields, item);
      }
    }
  }
}

function byteLengthOf(f: FieldDef, value: unknown): number {
  if (f.kind === 'bytes' || f.kind === 'rest') {
    if (f.encoding === 'ascii' || f.encoding === 'utf8') {
      return textEncoder.encode(String(value)).length;
    }
    return fromHex(String(value)).length;
  }
  throw new Error(`无法计算字段 ${f.name} 的字节长度`);
}

function encodeFields(fields: FieldDef[], scope: Record<string, unknown>, out: number[]): void {
  for (const f of fields) {
    encodeField(f, scope[f.name], scope, out);
  }
}

function enumRaw(map: Record<string, string> | undefined, v: unknown): number {
  if (typeof v === 'number') return v;
  if (map) {
    for (const [raw, label] of Object.entries(map)) {
      if (label === v) return Number(raw);
    }
  }
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`枚举值无法解析: ${String(v)}`);
  return n;
}

function unscale(value: unknown, scale?: number, add?: number): number {
  let v = typeof value === 'number' ? value : Number(value);
  if (scale !== undefined || add !== undefined) {
    v = Math.round((v - (add ?? 0)) / (scale ?? 1));
  }
  return v;
}

function pushUint(out: number[], raw: number, bits: number, endian: 'big' | 'little'): void {
  const bytes = bits / 8;
  let v = BigInt(raw) & ((1n << BigInt(bits)) - 1n);
  const arr: number[] = [];
  for (let i = 0; i < bytes; i++) {
    arr.push(Number(v & 0xffn));
    v >>= 8n;
  }
  if (endian === 'big') arr.reverse();
  out.push(...arr);
}

function encodeField(
  f: FieldDef,
  value: unknown,
  scope: Record<string, unknown>,
  out: number[],
): void {
  switch (f.kind) {
    case 'uint':
    case 'int': {
      const raw = f.enum ? enumRaw(f.enum, value) : unscale(value, f.scale, f.add);
      pushUint(out, raw, f.bits, f.endian ?? 'big');
      return;
    }
    case 'bcd': {
      let digits: string;
      if (f.scale !== undefined || f.add !== undefined) {
        digits = String(unscale(value, f.scale, f.add));
      } else {
        digits = String(value);
      }
      digits = digits.padStart(f.bytes * 2, '0');
      if (digits.length !== f.bytes * 2) throw new Error(`BCD 字段 ${f.name} 位数不符: ${digits}`);
      for (let i = 0; i < f.bytes; i++) {
        out.push((parseInt(digits[i * 2], 10) << 4) | parseInt(digits[i * 2 + 1], 10));
      }
      return;
    }
    case 'bytes':
    case 'rest': {
      let bytes: number[];
      if (f.encoding === 'ascii' || f.encoding === 'utf8') {
        bytes = Array.from(textEncoder.encode(String(value)));
      } else {
        bytes = Array.from(fromHex(String(value)));
      }
      if (f.kind === 'bytes' && f.length !== undefined && bytes.length !== f.length) {
        throw new Error(`字段 ${f.name} 长度应为 ${f.length},实际 ${bytes.length}`);
      }
      out.push(...bytes);
      return;
    }
    case 'bits': {
      const totalBits = f.bytes * 8;
      const order = f.bitOrder ?? 'lsb';
      let container = 0n;
      let consumed = 0;
      const obj = (value ?? scope[f.name]) as Record<string, unknown>;
      for (const sub of f.fields) {
        const raw = BigInt(enumRaw(sub.enum, obj[sub.name]));
        const shift = order === 'lsb' ? consumed : totalBits - consumed - sub.bits;
        container |= (raw & ((1n << BigInt(sub.bits)) - 1n)) << BigInt(shift);
        consumed += sub.bits;
      }
      const arr: number[] = [];
      for (let i = 0; i < f.bytes; i++) {
        arr.push(Number(container & 0xffn));
        container >>= 8n;
      }
      if ((f.endian ?? 'big') === 'big') arr.reverse();
      out.push(...arr);
      return;
    }
    case 'array': {
      const items = value as unknown[];
      for (const item of items) {
        encodeField(f.element, item, scope, out);
      }
      return;
    }
    case 'group': {
      encodeFields(f.fields, value as Record<string, unknown>, out);
      return;
    }
    case 'tlv': {
      const items = value as Record<string, unknown>[];
      for (const item of items) {
        const type = Number(item.type);
        const def = f.types[String(type)];
        const body: number[] = [];
        if (def) {
          const itemScope = { ...item };
          derive(def.fields, itemScope);
          encodeFields(def.fields, itemScope, body);
        } else {
          body.push(...Array.from(fromHex(String(item.raw ?? ''))));
        }
        pushUint(out, type, f.typeBytes * 8, f.endian ?? 'big');
        pushUint(out, body.length, f.lengthBytes * 8, f.endian ?? 'big');
        out.push(...body);
      }
      return;
    }
    case 'pad': {
      const v = value !== undefined ? Array.from(fromHex(String(value))) : null;
      for (let i = 0; i < f.bytes; i++) out.push(v ? v[i] ?? 0 : 0);
      return;
    }
  }
}

/**
 * 把编码用的值对象按解码器的路径规则扁平化,生成"期望解码结果"。
 * 与 decodeMessage 返回的 values 一一对应(校验值除外,由生成器补上)。
 */
export function flattenValues(
  fields: FieldDef[],
  scope: Record<string, unknown>,
  prefix = '',
  out: Record<string, unknown> = {},
): Record<string, unknown> {
  for (const f of fields) {
    const path = prefix ? `${prefix}.${f.name}` : f.name;
    const value = scope[f.name];
    switch (f.kind) {
      case 'uint':
      case 'int': {
        out[path] = f.enum ? enumRaw(f.enum, value) : value;
        break;
      }
      case 'bcd': {
        if (f.scale !== undefined || f.add !== undefined) {
          out[path] = value;
        } else {
          out[path] = String(value).padStart(f.bytes * 2, '0');
        }
        break;
      }
      case 'bytes':
      case 'rest': {
        if (f.encoding === 'ascii' || f.encoding === 'utf8') {
          out[path] = String(value);
        } else {
          out[path] = fromHex(String(value)).length
            ? Array.from(fromHex(String(value)), (b) => b.toString(16).padStart(2, '0')).join('')
            : '';
        }
        break;
      }
      case 'bits': {
        const obj = value as Record<string, unknown>;
        for (const sub of f.fields) {
          out[`${path}.${sub.name}`] = enumRaw(sub.enum, obj[sub.name]);
        }
        break;
      }
      case 'array': {
        const items = value as unknown[];
        items.forEach((item, i) => {
          flattenFieldValue(f.element, item, `${path}[${i}]`, out);
        });
        break;
      }
      case 'group': {
        flattenValues(f.fields, value as Record<string, unknown>, path, out);
        break;
      }
      case 'tlv': {
        const items = value as Record<string, unknown>[];
        items.forEach((item, i) => {
          const type = Number(item.type);
          out[`${path}[${i}].type`] = type;
          const def = f.types[String(type)];
          if (def) {
            flattenValues(def.fields, item, `${path}[${i}]`, out);
          } else {
            out[`${path}[${i}].raw`] = String(item.raw ?? '').toLowerCase();
          }
        });
        break;
      }
      case 'pad':
        break;
    }
  }
  return out;
}

function flattenFieldValue(
  f: FieldDef,
  value: unknown,
  path: string,
  out: Record<string, unknown>,
): void {
  const wrapper: Record<string, unknown> = { [f.name]: value };
  const tmp: Record<string, unknown> = {};
  flattenValues([f], wrapper, '', tmp);
  for (const [k, v] of Object.entries(tmp)) {
    // k 以 f.name 开头,替换成 path
    out[path + k.slice(f.name.length)] = v;
  }
}
