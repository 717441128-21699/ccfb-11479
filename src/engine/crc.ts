import type { CrcSpec } from './types';

/* ---------- CRC 查表 (惰性初始化缓存) ---------- */

const tableCache = new Map<string, Uint16Array | Uint32Array>();

function crc16Table(poly: number): Uint16Array {
  let t = tableCache.get(`c16-${poly}`) as Uint16Array | undefined;
  if (t) return t;
  t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) crc = crc & 1 ? (crc >> 1) ^ poly : crc >> 1;
    t[i] = crc;
  }
  tableCache.set(`c16-${poly}`, t);
  return t;
}

function crc32Table(): Uint32Array {
  let t = tableCache.get('c32') as Uint32Array | undefined;
  if (t) return t;
  t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    t[i] = crc >>> 0;
  }
  tableCache.set('c32', t);
  return t;
}

/** CRC16-Modbus (poly 0xA001 反射, init 0xFFFF) */
export function crc16Modbus(data: Uint8Array): number {
  const t = crc16Table(0xa001);
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) crc = (crc >> 8) ^ t[(crc ^ data[i]) & 0xff];
  return crc & 0xffff;
}

/** CRC16-CCITT/XModem (poly 0x1021, init 0x0000, 不反射) */
export function crc16Ccitt(data: Uint8Array, init = 0x0000): number {
  let crc = init & 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc & 0xffff;
}

/** CRC32 (IEEE 802.3, init 0xFFFFFFFF, 结果取反) */
export function crc32(data: Uint8Array): number {
  const t = crc32Table();
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ t[(crc ^ data[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

export function checksum8(data: Uint8Array, init = 0, xorOut = 0): number {
  let s = init & 0xff;
  for (let i = 0; i < data.length; i++) s = (s + data[i]) & 0xff;
  return (s ^ xorOut) & 0xff;
}

export function checksum16(data: Uint8Array, init = 0, xorOut = 0): number {
  let s = init & 0xffff;
  for (let i = 0; i < data.length; i++) s = (s + data[i]) & 0xffff;
  return (s ^ xorOut) & 0xffff;
}

/** 按 spec 计算给定区间的校验值 */
export function computeCrc(spec: CrcSpec, frame: Uint8Array, start: number, end: number): number {
  const region = frame.subarray(start, end);
  switch (spec.algo) {
    case 'crc16-modbus':
      return crc16Modbus(region);
    case 'crc16-ccitt':
      return crc16Ccitt(region, spec.init ?? 0);
    case 'crc32':
      return crc32(region);
    case 'checksum8':
      return checksum8(region, spec.init ?? 0, spec.xorOut ?? 0);
    case 'checksum16':
      return checksum16(region, spec.init ?? 0, spec.xorOut ?? 0);
  }
}

export const CRC_ALGO_LABELS: Record<string, string> = {
  'crc16-modbus': 'CRC16-Modbus',
  'crc16-ccitt': 'CRC16-CCITT',
  crc32: 'CRC32 (IEEE)',
  checksum8: '累加和 8bit',
  checksum16: '累加和 16bit',
};
