/**
 * 协议逆向辅助:给一批未知协议的报文样本,猜测字段边界,给出声明式描述建议。
 * 纯启发式,产出是"建议稿",用户在编辑器里确认修改。
 */

import { computeChecksum } from './crc.js';
import type { ChecksumAlgorithm, FieldDef } from './types.js';
import { toHex } from './decoder.js';

export interface GuessResult {
  fields: FieldDef[];
  checksum?: { algorithm: ChecksumAlgorithm; endian: 'big' | 'little'; confidence: string };
  notes: string[];
}

const CRC_CANDIDATES: { algorithm: ChecksumAlgorithm; size: number }[] = [
  { algorithm: 'crc16-modbus', size: 2 },
  { algorithm: 'crc16-ccitt-false', size: 2 },
  { algorithm: 'crc16-x25', size: 2 },
  { algorithm: 'crc16-xmodem', size: 2 },
  { algorithm: 'crc32-ieee', size: 4 },
  { algorithm: 'sum8', size: 1 },
  { algorithm: 'sum16', size: 2 },
  { algorithm: 'xor8', size: 1 },
];

export function guessProtocol(samples: Uint8Array[]): GuessResult {
  const notes: string[] = [];
  if (samples.length === 0) return { fields: [], notes: ['没有样本'] };
  const minLen = Math.min(...samples.map((s) => s.length));
  const maxLen = Math.max(...samples.map((s) => s.length));
  const variable = minLen !== maxLen;
  if (variable) {
    notes.push(`报文长度不固定(${minLen}~${maxLen} 字节),存在变长部分`);
  }

  // 1. 校验猜测:对每条样本尝试"末尾 N 字节 = 前面字节的校验"
  let checksum: GuessResult['checksum'];
  let dataEnd = minLen;
  outer: for (const c of CRC_CANDIDATES) {
    for (const endian of ['big', 'little'] as const) {
      let ok = 0;
      for (const s of samples) {
        if (s.length < c.size + 2) continue;
        const actual = computeChecksum(c.algorithm, s, 0, s.length - c.size);
        const stored = readEndian(s, s.length - c.size, c.size, endian);
        if (actual === stored) ok++;
      }
      if (ok === samples.length && samples.length >= 2) {
        checksum = { algorithm: c.algorithm, endian, confidence: '高(全部样本匹配)' };
        dataEnd = minLen - c.size;
        notes.push(`末尾 ${c.size} 字节疑似 ${c.algorithm} 校验(${endian} 字节序),全部样本匹配`);
        break outer;
      }
    }
  }
  if (!checksum) {
    // 放宽到 90%
    outer2: for (const c of CRC_CANDIDATES) {
      for (const endian of ['big', 'little'] as const) {
        let ok = 0;
        for (const s of samples) {
          if (s.length < c.size + 2) continue;
          const actual = computeChecksum(c.algorithm, s, 0, s.length - c.size);
          const stored = readEndian(s, s.length - c.size, c.size, endian);
          if (actual === stored) ok++;
        }
        if (ok >= Math.max(2, Math.floor(samples.length * 0.9))) {
          checksum = { algorithm: c.algorithm, endian, confidence: `中(${ok}/${samples.length} 样本匹配)` };
          dataEnd = minLen - c.size;
          notes.push(`末尾 ${c.size} 字节疑似 ${c.algorithm} 校验,${ok}/${samples.length} 匹配`);
          break outer2;
        }
      }
    }
  }

  // 2. 公共前缀:所有样本一致的开头字节 -> 帧头常量
  let prefixLen = 0;
  while (prefixLen < dataEnd) {
    const b = samples[0][prefixLen];
    if (samples.every((s) => s[prefixLen] === b)) prefixLen++;
    else break;
  }
  const fields: FieldDef[] = [];
  if (prefixLen > 0) {
    fields.push({
      kind: 'bytes',
      name: 'header',
      label: '帧头(常量)',
      length: prefixLen,
    });
    notes.push(`前 ${prefixLen} 字节为常量帧头: ${toHex(samples[0], 0, prefixLen)}`);
  }

  // 3. 长度字段:某字节的值 == 其后到数据区末尾的长度,或 == 总长
  let lengthFieldAt = -1;
  let lengthMode: 'remaining' | 'total' = 'remaining';
  const csSize = checksum ? (CRC_CANDIDATES.find((c) => c.algorithm === checksum.algorithm)!.size) : 0;
  for (let o = prefixLen; o < Math.min(prefixLen + 6, dataEnd); o++) {
    let remOk = true;
    let totalOk = true;
    for (const s of samples) {
      const v = s[o];
      if (v !== s.length - o - 1 - csSize) remOk = false;
      if (v !== s.length) totalOk = false;
    }
    if (remOk && variable) {
      lengthFieldAt = o;
      lengthMode = 'remaining';
      break;
    }
    if (totalOk) {
      lengthFieldAt = o;
      lengthMode = 'total';
      break;
    }
  }
  if (lengthFieldAt >= 0) {
    fields.push({ kind: 'uint', name: 'length', label: '长度字段', bits: 8 });
    notes.push(
      `偏移 ${lengthFieldAt} 处的字节疑似长度字段(${lengthMode === 'remaining' ? '后续数据长度' : '报文总长'})`,
    );
  }

  // 4. 中间区域:按跨样本的变化模式切分字段
  const regionStart = lengthFieldAt >= 0 ? lengthFieldAt + 1 : prefixLen;
  const regionEnd = dataEnd;
  if (regionEnd > regionStart) {
    const classes: string[] = [];
    for (let p = regionStart; p < regionEnd; p++) {
      classes.push(classifyPosition(samples, p));
    }
    // 按类别合并连续段
    let segStart = 0;
    let idx = regionStart;
    const flush = (end: number) => {
      const cls = classes[segStart];
      const len = end - segStart;
      const offset = regionStart + segStart;
      if (len <= 0) return;
      if (cls === 'const') {
        fields.push({ kind: 'bytes', name: `const_${offset}`, label: '常量/保留', length: len });
      } else if (cls === 'bcd') {
        fields.push({ kind: 'bcd', name: `bcd_${offset}`, bytes: len });
      } else if (cls === 'ascii') {
        fields.push({ kind: 'bytes', name: `text_${offset}`, length: len, encoding: 'ascii' });
      } else {
        // 数值段:1/2/4 字节对齐切分
        let p = 0;
        while (p < len) {
          const remain = len - p;
          const size = remain >= 4 && (len - p) % 4 === 0 ? 4 : remain >= 2 && (len - p) % 2 === 0 ? 2 : 1;
          const off = regionStart + segStart + p;
          const endian = size > 1 ? guessEndian(samples, off, size) : undefined;
          fields.push({
            kind: 'uint',
            name: `field_${off}`,
            bits: (size * 8) as 8 | 16 | 32,
            ...(endian ? { endian } : {}),
          });
          p += size;
        }
      }
    };
    for (idx = 1; idx < classes.length; idx++) {
      if (classes[idx] !== classes[segStart]) {
        flush(idx);
        segStart = idx;
      }
    }
    flush(classes.length);
  }

  // 5. 变长尾巴
  if (variable) {
    fields.push({ kind: 'rest', name: 'payload', label: '变长数据' });
    if (lengthFieldAt >= 0) {
      notes.push('变长部分建议用 lengthFrom 关联长度字段,或 rest 类型兜底');
    }
  }

  if (notes.length === 0) notes.push('样本太少或模式不明显,建议提供更多样本');
  return { fields, checksum, notes };
}

function readEndian(s: Uint8Array, offset: number, size: number, endian: 'big' | 'little'): number {
  let v = 0;
  if (endian === 'little') {
    for (let i = size - 1; i >= 0; i--) v = v * 256 + s[offset + i];
  } else {
    for (let i = 0; i < size; i++) v = v * 256 + s[offset + i];
  }
  return v;
}

/** 按跨样本表现给某个字节位置分类 */
function classifyPosition(samples: Uint8Array[], pos: number): string {
  const first = samples[0][pos];
  let allSame = true;
  let allBcd = true;
  let allAscii = true;
  for (const s of samples) {
    const b = s[pos];
    if (b !== first) allSame = false;
    const hi = (b >> 4) & 0xf;
    const lo = b & 0xf;
    if (hi > 9 || lo > 9) allBcd = false;
    if (b < 0x20 || b > 0x7e) allAscii = false;
  }
  if (allSame) return 'const';
  if (allAscii) return 'ascii';
  if (allBcd) return 'bcd';
  return 'num';
}

/** 多字节数值段的大小端猜测:变化更剧烈的是低位字节 */
function guessEndian(samples: Uint8Array[], offset: number, size: number): 'big' | 'little' {
  const variance: number[] = [];
  for (let i = 0; i < size; i++) {
    const vals = samples.map((s) => s[offset + i]);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    variance.push(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  }
  // 大端:最后一个字节是低位,方差最大;小端:第一个字节是低位
  return variance[size - 1] >= variance[0] ? 'big' : 'little';
}
