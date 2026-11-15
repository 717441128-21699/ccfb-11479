/**
 * 未知协议样本的字段边界推断 (启发式)。
 * 输入若干十六进制样本, 输出建议的字段切分与类型猜测, 带置信度。
 *
 * 思路:
 *  1. 按字节统计每个偏移的取值范围/可打印率/跨样本稳定性, 推断角色
 *     (帧头魔数 / 长度字段 / 序号 / 校验 / 文本 / 数据)。
 *  2. 多长度样本对齐: 公共前缀部分按定长字段处理, 可变尾部按长度字段关联。
 *  3. 给出可直接导入编辑器的 FieldDef 草案与置信度。
 */
import type { Endian, FieldDef } from './types';
import { hexToBytes } from './reassembly';

export type InferRole = 'magic' | 'length' | 'seq' | 'counter' | 'enum' | 'text' | 'data' | 'checksum';

export interface InferredField {
  name: string;
  role: InferRole;
  start: number;
  size: number;
  confidence: number; // 0-1
  reason: string;
  suggested: FieldDef;
}

export interface InferResult {
  sampleCount: number;
  minLen: number;
  maxLen: number;
  endianGuess: Endian;
  fields: InferredField[];
  notes: string[];
}

interface ColStat {
  values: number[];
  printableRatio: number;
  distinct: Set<number>;
  constant: boolean;
  range: [number, number];
}

function statsAt(samples: Uint8Array[], offset: number): ColStat | null {
  const values: number[] = [];
  let printable = 0;
  let present = 0;
  const distinct = new Set<number>();
  for (const s of samples) {
    if (offset >= s.length) continue;
    const v = s[offset];
    values.push(v);
    distinct.add(v);
    present++;
    if (v >= 0x20 && v <= 0x7e) printable++;
  }
  if (!present) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  return {
    values,
    printableRatio: printable / present,
    distinct,
    constant: distinct.size === 1,
    range: [min, max],
  };
}

const ROLE_NAMES: Record<InferRole, string> = {
  magic: '帧头魔数',
  length: '长度字段',
  seq: '序号',
  counter: '计数/状态',
  enum: '枚举',
  text: '文本',
  data: '数据区',
  checksum: '校验',
};

export function inferProtocol(hexSamples: string[], endian: Endian = 'be'): InferResult {
  const samples = hexSamples.map((h) => hexToBytes(h));
  const notes: string[] = [];
  if (samples.length < 2) notes.push('样本较少(建议≥5条), 推断结果置信度有限');

  const lengths = samples.map((s) => s.length);
  const minLen = Math.min(...lengths);
  const maxLen = Math.max(...lengths);
  const variable = minLen !== maxLen;
  if (variable) notes.push(`样本长度不一致 (${minLen}~${maxLen}), 存在变长区域`);

  // 逐列统计
  const cols: (ColStat | null)[] = [];
  for (let off = 0; off < maxLen; off++) cols.push(statsAt(samples, off));

  const fields: InferredField[] = [];
  let off = 0;
  let seqIdx = 0;
  let nameCounter = 0;
  const autoName = (role: InferRole) => {
    if (role === 'magic') return 'magic';
    if (role === 'length') return 'length';
    if (role === 'checksum') return 'checksum';
    return `${role}_${nameCounter++}`;
  };

  const pushField = (role: InferRole, start: number, size: number, confidence: number, reason: string, extra?: Partial<FieldDef>) => {
    const name = autoName(role);
    const base: FieldDef = {
      name,
      type: role === 'text' ? 'string' : role === 'data' ? 'bytes' : role === 'checksum' ? 'crc' : 'uint',
      size: role === 'text' || role === 'data' ? undefined : size,
      endian: role === 'magic' || role === 'text' || role === 'data' ? undefined : endian,
      ...extra,
    };
    fields.push({ name, role, start, size, confidence, reason, suggested: base });
    seqIdx++;
  };

  // 1) 帧头: 开头连续常量字节
  let p = 0;
  while (p < minLen && cols[p]?.constant) p++;
  if (p > 0) {
    const magic = samples[0].slice(0, p);
    pushField('magic', 0, p, 0.95, `前 ${p} 字节在所有样本中恒定: ${[...magic].map((b) => '0x' + b.toString(16)).join(' ')}`, {
      size: p,
    });
    off = p;
  }

  // 2) 长度字段: 找与帧长线性相关的 1/2 字节位置
  let lengthOff = -1;
  let lengthSize = 0;
  let lengthAdjust = 0;
  outer: for (let size = 2; size >= 1; size--) {
    for (let o = off; o + size <= minLen; o++) {
      let corr = true;
      const adjusts = new Set<number>();
      for (const s of samples) {
        let v = 0;
        for (let i = 0; i < size; i++) v = endian === 'be' ? v * 256 + s[o + i] : v + s[o + i] * 256 ** i;
        if (v === 0) { corr = false; break; }
        adjusts.add(s.length - v);
      }
      if (corr && adjusts.size <= 2) {
        lengthOff = o;
        lengthSize = size;
        lengthAdjust = [...adjusts].sort((a, b) => Math.abs(a) - Math.abs(b))[0];
        break outer;
      }
    }
  }

  // 3) 逐字段扫描定长区
  while (off < minLen) {
    if (off === lengthOff) {
      pushField(
        'length',
        off,
        lengthSize,
        variable ? 0.9 : 0.6,
        `取值与整帧长度线性相关 (frameLen = value + ${lengthAdjust})`,
        { size: lengthSize },
      );
      off += lengthSize;
      continue;
    }

    // 尾部 1/2/4 字节疑似校验: 仅帧尾高随机, 且不吞并中间普通字段
    const remainToMinEnd = minLen - off;
    if (remainToMinEnd <= 4 && remainToMinEnd > 0 && samples.length >= 3) {
      const tailCol = cols[minLen - 1];
      const tailHighEntropy = !!tailCol && tailCol.distinct.size >= Math.min(samples.length, 8);
      if (tailHighEntropy) {
        // 校验宽度从最后 1 字节起, 连续高随机则扩展, 最多 4
        let size = 1;
        while (
          size < 4 &&
          size < remainToMinEnd &&
          cols[minLen - 1 - size]?.distinct.size! >= Math.min(samples.length, 8)
        ) {
          size++;
        }
        // 回退 reader 到校验起点
        off = minLen - size;
        pushField(
          'checksum',
          off,
          size,
          0.55,
          `尾部 ${size} 字节取值高度离散, 疑似校验/摘要 (需用校验工具复核算法)`,
          { size, crc: { algo: size === 1 ? 'checksum8' : size === 4 ? 'crc32' : 'crc16-modbus' } },
        );
        off = minLen;
        continue;
      }
    }

    // 连续可打印文本段
    if ((cols[off]?.printableRatio ?? 0) >= 0.9) {
      let q = off;
      while (q < minLen && (cols[q]?.printableRatio ?? 0) >= 0.9) q++;
      pushField('text', off, q - off, 0.75, `${q - off} 字节高比例可打印 ASCII`, {
        encoding: 'ascii',
        length: q - off,
      });
      off = q;
      continue;
    }

    // 枚举: 取值集合很小
    const c = cols[off]!;
    if (c.distinct.size <= Math.max(3, samples.length * 0.25) && c.distinct.size > 1) {
      pushField('enum', off, 1, 0.7, `仅出现 ${c.distinct.size} 种取值: ${[...c.distinct].join('/')}`, {
        size: 1,
        mapping: Object.fromEntries([...c.distinct].map((v) => [String(v), `值${v}`])),
      });
      off += 1;
      continue;
    }

    // 单调递增 → 序号/计数 (尝试 2 字节合并)
    if (off + 1 < minLen && looksLikeCounter(samples, off, 2, endian)) {
      pushField('seq', off, 2, 0.7, '2 字节取值随样本单调变化, 疑似序号/计数器', { size: 2 });
      off += 2;
      continue;
    }
    if (looksLikeCounter(samples, off, 1, endian)) {
      pushField('seq', off, 1, 0.55, '单字节取值随样本单调变化, 疑似序号/计数器', { size: 1 });
      off += 1;
      continue;
    }

    // 兜底: 单字节数据
    pushField('data', off, 1, 0.3, `取值范围 0x${c.range[0].toString(16)}~0x${c.range[1].toString(16)}, 角色不明确`, {
      size: 1,
    });
    off += 1;
  }

  // 4) 变长尾部
  if (variable) {
    const tailPrintable = samples
      .filter((s) => s.length > minLen)
      .every((s) => {
        const tail = s.subarray(minLen);
        let pr = 0;
        for (const b of tail) if (b >= 0x20 && b <= 0x7e) pr++;
        return pr / tail.length >= 0.8;
      });
    if (tailPrintable) {
      pushField('text', minLen, maxLen - minLen, 0.6, '变长尾部以可打印字符为主, 疑似变长字符串', {
        encoding: 'ascii',
        lengthOf: lengthOff >= 0 ? { field: 'length', adjust: lengthAdjust - minLen } : undefined,
        length: lengthOff < 0 ? maxLen - minLen : undefined,
      });
    } else {
      pushField('data', minLen, maxLen - minLen, 0.5, `变长数据区 (${maxLen - minLen} 字节级差), 建议按 length 字段关联`, {
        lengthOf: lengthOff >= 0 ? { field: 'length', adjust: lengthAdjust - minLen } : undefined,
        length: lengthOff < 0 ? undefined : undefined,
      });
    }
  }

  void seqIdx;
  return {
    sampleCount: samples.length,
    minLen,
    maxLen,
    endianGuess: endian,
    fields,
    notes,
  };
}

function looksLikeCounter(samples: Uint8Array[], off: number, size: number, endian: Endian): boolean {
  const vals = samples.map((s) => {
    let v = 0;
    for (let i = 0; i < size; i++) {
      const idx = endian === 'be' ? off + i : off + size - 1 - i;
      v = v * 256 + (s[idx] ?? 0);
    }
    return v;
  });
  let increasing = 0;
  for (let i = 1; i < vals.length; i++) {
    const d = vals[i] - vals[i - 1];
    if (d > 0 && d < 256) increasing++;
    else if (d !== 0) return false;
  }
  return increasing >= Math.max(1, (vals.length - 1) * 0.6);
}

export const INFER_ROLE_LABELS = ROLE_NAMES;
