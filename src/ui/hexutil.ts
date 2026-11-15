/** 十六进制与字节工具 (UI 层) */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 !== 0) throw new Error('十六进制长度必须为偶数');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array, sep = ' '): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(sep);
}

export function isHexInput(text: string): boolean {
  const clean = text.replace(/0x/gi, '').replace(/\s+/g, '');
  return clean.length > 0 && clean.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(clean);
}

/** 把字节数组按每行 16 字节分块, 供 hex viewer 渲染 */
export interface HexRow {
  offset: number;
  bytes: { value: number; index: number }[];
  ascii: string;
}

export function toHexRows(bytes: Uint8Array, bytesPerRow = 16): HexRow[] {
  const rows: HexRow[] = [];
  for (let off = 0; off < bytes.length; off += bytesPerRow) {
    const slice = bytes.subarray(off, Math.min(off + bytesPerRow, bytes.length));
    rows.push({
      offset: off,
      bytes: [...slice].map((value, i) => ({ value, index: off + i })),
      ascii: [...slice].map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '·')).join(''),
    });
  }
  return rows;
}
