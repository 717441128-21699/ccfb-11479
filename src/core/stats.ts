/**
 * 字段统计:对一批解码结果按字段路径聚合。
 * 数字字段给最值/均值/唯一值数;所有字段给取值频次 Top N。
 */

import type { DecodeResult } from './types.js';

export interface FieldStat {
  path: string;
  count: number;
  numeric: boolean;
  min?: number;
  max?: number;
  mean?: number;
  unique: number;
  top: { value: string; count: number }[];
}

/** 数组下标归一化:channels[2].samples[1] -> channels[].samples[] */
export function normalizePath(path: string): string {
  return path.replace(/\[\d+\]/g, '[]');
}

export function computeStats(results: DecodeResult[], topN = 10): FieldStat[] {
  interface Acc {
    count: number;
    numeric: boolean;
    sum: number;
    min: number;
    max: number;
    freq: Map<string, number>;
  }
  const accs = new Map<string, Acc>();

  for (const r of results) {
    if (!r.ok) continue;
    for (const [rawPath, value] of Object.entries(r.values)) {
      const path = normalizePath(rawPath);
      let acc = accs.get(path);
      if (!acc) {
        acc = { count: 0, numeric: true, sum: 0, min: Infinity, max: -Infinity, freq: new Map() };
        accs.set(path, acc);
      }
      acc.count++;
      const key = String(value);
      acc.freq.set(key, (acc.freq.get(key) ?? 0) + 1);
      if (typeof value === 'number' && Number.isFinite(value)) {
        acc.sum += value;
        if (value < acc.min) acc.min = value;
        if (value > acc.max) acc.max = value;
      } else {
        acc.numeric = false;
      }
    }
  }

  const stats: FieldStat[] = [];
  for (const [path, acc] of accs) {
    const top = Array.from(acc.freq.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, topN);
    const stat: FieldStat = {
      path,
      count: acc.count,
      numeric: acc.numeric,
      unique: acc.freq.size,
      top,
    };
    if (acc.numeric && acc.count > 0) {
      stat.min = acc.min;
      stat.max = acc.max;
      stat.mean = Number((acc.sum / acc.count).toFixed(6));
    }
    stats.push(stat);
  }
  return stats.sort((a, b) => a.path.localeCompare(b.path));
}
