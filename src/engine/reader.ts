import type { Endian } from './types';

/**
 * 字节游标: 所有解码操作的统一入口, 记录每个节点对应的字节区间。
 * 内部基于 Uint8Array, 零拷贝切片。
 */
export class ByteReader {
  readonly buf: Uint8Array;
  pos = 0;
  readonly start: number; // 本游标在父帧中的绝对起点
  readonly length: number;

  constructor(buf: Uint8Array, offset = 0, length?: number) {
    this.buf = buf;
    this.start = offset;
    this.length = length ?? buf.length - offset;
  }

  get absPos(): number {
    return this.start + this.pos;
  }

  remaining(): number {
    return this.length - this.pos;
  }

  eof(): boolean {
    return this.pos >= this.length;
  }

  /** 限定 [pos, pos+n) 的子游标 (用于 TLV value / struct 嵌套) */
  sub(n: number): ByteReader {
    if (this.pos + n > this.length) throw new DecodeError(`越界读取: 需要 ${n} 字节, 剩余 ${this.remaining()}`);
    const r = new ByteReader(this.buf, this.absPos, n);
    this.pos += n;
    return r;
  }

  /** 不限定子长度的子游标 (共享同一底层 buffer, 到帧尾) */
  tail(): ByteReader {
    const r = new ByteReader(this.buf, this.absPos, this.remaining());
    this.pos = this.length;
    return r;
  }

  slice(n: number): Uint8Array {
    if (this.pos + n > this.length) throw new DecodeError(`越界读取: 需要 ${n} 字节, 剩余 ${this.remaining()}`);
    const out = this.buf.subarray(this.start + this.pos, this.start + this.pos + n);
    this.pos += n;
    return out;
  }

  u8(): number {
    if (this.pos >= this.length) throw new DecodeError('越界读取 u8');
    return this.buf[this.start + this.pos++];
  }

  peek(): number {
    return this.buf[this.start + this.pos];
  }

  uint(n: number, endian: Endian): number {
    if (this.pos + n > this.length) throw new DecodeError(`越界读取 uint${n * 8}`);
    let v = 0;
    const base = this.start + this.pos;
    if (endian === 'be') {
      for (let i = 0; i < n; i++) v = v * 256 + this.buf[base + i];
    } else {
      for (let i = n - 1; i >= 0; i--) v = v * 256 + this.buf[base + i];
    }
    this.pos += n;
    return v;
  }

  /** 有符号整数 (二补码), 超过 32 位用 BigInt; 避免 1<<31 的 32 位有符号截断 */
  int(n: number, endian: Endian): number | bigint {
    const u = this.uint(n, endian);
    if (n <= 4) {
      const mod = 256 ** n;
      const sign = mod / 2;
      return u >= sign ? u - mod : u;
    }
    let big = BigInt(u);
    const sign = 1n << BigInt(n * 8 - 1);
    big = (big ^ sign) - sign;
    return big;
  }

  float(n: 4 | 8, endian: Endian): number {
    const bytes = this.slice(n);
    // DataView 要求显式 littleEndian
    const dv = new DataView(bytes.buffer, bytes.byteOffset, n);
    return n === 4 ? dv.getFloat32(0, endian === 'le') : dv.getFloat64(0, endian === 'le');
  }

  /**
   * BCD: 逐半字节累积十进制。高半字节为 0xF 表示该 nibble 是填充位 (奇数位 BCD),
   * 跳过不累积; 0x0 是合法数字 0。定长偶数位 BCD 不会出现 0xF, 行为即标准两位/字节。
   */
  bcd(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const b = this.u8();
      const hi = b >> 4;
      const lo = b & 0x0f;
      if (hi !== 0x0f) v = v * 10 + hi;
      v = v * 10 + lo;
    }
    return v;
  }
}

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecodeError';
  }
}
