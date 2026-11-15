/** CRC 与累加和校验,表驱动实现,供解码校验与编码生成共用。 */

import type { ChecksumAlgorithm, Endian } from './types.js';

const crc16ModbusTable = makeCrc16Table(0xa001); // 反射多项式 0x8005
const crc16CcittTable = makeCrc16TableMsb(0x1021);
const crc32Table = makeCrc32Table();

function makeCrc16Table(poly: number): Uint16Array {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let b = 0; b < 8; b++) c = c & 1 ? (c >> 1) ^ poly : c >> 1;
    t[i] = c;
  }
  return t;
}

function makeCrc16TableMsb(poly: number): Uint16Array {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let b = 0; b < 8; b++) c = c & 0x8000 ? ((c << 1) ^ poly) & 0xffff : (c << 1) & 0xffff;
    t[i] = c;
  }
  return t;
}

function makeCrc32Table(): Uint32Array {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let b = 0; b < 8; b++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
}

export function crc16Modbus(data: Uint8Array, start = 0, end = data.length): number {
  let crc = 0xffff;
  for (let i = start; i < end; i++) crc = (crc >> 8) ^ crc16ModbusTable[(crc ^ data[i]) & 0xff];
  return crc & 0xffff;
}

export function crc16CcittFalse(data: Uint8Array, start = 0, end = data.length): number {
  let crc = 0xffff;
  for (let i = start; i < end; i++) crc = ((crc << 8) & 0xffff) ^ crc16CcittTable[((crc >> 8) ^ data[i]) & 0xff];
  return crc & 0xffff;
}

export function crc16Xmodem(data: Uint8Array, start = 0, end = data.length): number {
  let crc = 0;
  for (let i = start; i < end; i++) crc = ((crc << 8) & 0xffff) ^ crc16CcittTable[((crc >> 8) ^ data[i]) & 0xff];
  return crc & 0xffff;
}

// X25:反射的 CCITT(多项式 0x1021 反射为 0x8408),初值/终值均 0xFFFF
const crc16X25Table = makeCrc16Table(0x8408);
export function crc16X25(data: Uint8Array, start = 0, end = data.length): number {
  let crc = 0xffff;
  for (let i = start; i < end; i++) crc = (crc >> 8) ^ crc16X25Table[(crc ^ data[i]) & 0xff];
  return (crc ^ 0xffff) & 0xffff;
}

export function crc32Ieee(data: Uint8Array, start = 0, end = data.length): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = (crc >>> 8) ^ crc32Table[(crc ^ data[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

export function sumChecksum(data: Uint8Array, start: number, end: number, bytes: 1 | 2): number {
  let s = 0;
  for (let i = start; i < end; i++) s += data[i];
  return bytes === 1 ? s & 0xff : s & 0xffff;
}

export function xorChecksum(data: Uint8Array, start: number, end: number): number {
  let x = 0;
  for (let i = start; i < end; i++) x ^= data[i];
  return x & 0xff;
}

export function computeChecksum(
  algorithm: ChecksumAlgorithm,
  data: Uint8Array,
  start: number,
  end: number,
): number {
  switch (algorithm) {
    case 'crc16-modbus':
      return crc16Modbus(data, start, end);
    case 'crc16-ccitt-false':
      return crc16CcittFalse(data, start, end);
    case 'crc16-x25':
      return crc16X25(data, start, end);
    case 'crc16-xmodem':
      return crc16Xmodem(data, start, end);
    case 'crc32-ieee':
      return crc32Ieee(data, start, end);
    case 'sum8':
      return sumChecksum(data, start, end, 1);
    case 'sum16':
      return sumChecksum(data, start, end, 2);
    case 'xor8':
      return xorChecksum(data, start, end);
  }
}

/** 把校验值按字节序写入字节数组 */
export function writeChecksumBytes(value: number, bytes: number, endian: Endian): number[] {
  const out: number[] = [];
  if (endian === 'little') {
    for (let i = 0; i < bytes; i++) out.push((value >> (8 * i)) & 0xff);
  } else {
    for (let i = bytes - 1; i >= 0; i--) out.push((value >> (8 * i)) & 0xff);
  }
  return out;
}

export function readUint(data: Uint8Array, offset: number, bytes: number, endian: Endian): number {
  let v = 0;
  if (endian === 'little') {
    for (let i = bytes - 1; i >= 0; i--) v = v * 256 + data[offset + i];
  } else {
    for (let i = 0; i < bytes; i++) v = v * 256 + data[offset + i];
  }
  return v;
}
