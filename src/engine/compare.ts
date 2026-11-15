/**
 * 解码结果与期望对象的深度比对器。
 * 期望对象由生成器产出 (嵌套普通对象 / 数组 / Uint8Array),
 * 解码树按节点 path 逐字段核对, 返回全部不一致项。
 */
import type { DecodeNode, DecodeResult } from './types';

export interface Mismatch {
  path: string;
  expected: unknown;
  actual: unknown;
  reason: string;
}

function isUint8Array(v: unknown): v is Uint8Array {
  return v instanceof Uint8Array;
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/** 数值容差比较: 覆盖 float32 编解码的精度损失 (~1e-6 相对误差) */
function closeEnough(a: number, b: number): boolean {
  if (a === b) return true;
  const tol = Math.max(1e-6, Math.abs(b) * 1e-6);
  return Math.abs(a - b) <= tol;
}

function compareScalar(path: string, actual: unknown, expected: unknown, mismatches: Mismatch[]): void {
  // Uint8Array <-> hex string
  if (isUint8Array(expected)) {
    const actualHex = typeof actual === 'string' ? actual : isUint8Array(actual) ? bytesToHex(actual) : null;
    if (actualHex !== bytesToHex(expected)) {
      mismatches.push({ path, expected: bytesToHex(expected), actual, reason: '字节序列不一致' });
    }
    return;
  }
  if (typeof expected === 'boolean') {
    if (Boolean(actual) !== expected) {
      mismatches.push({ path, expected, actual, reason: '布尔值不一致' });
    }
    return;
  }
  if (typeof expected === 'number') {
    const an = Number(actual);
    if (!closeEnough(an, expected)) {
      mismatches.push({ path, expected, actual, reason: '数值不一致' });
    }
    return;
  }
  if (String(actual) !== String(expected)) {
    mismatches.push({ path, expected, actual, reason: '标量值不一致' });
  }
}

function findChild(node: DecodeNode, name: string): DecodeNode | undefined {
  if (!node.children) return undefined;
  // 直接同名 (struct 子字段), 数组元素 name[i], 或 TLV item (其内部子节点携带字段名)
  const direct = node.children.find((c) => c.name === name || c.name.startsWith(name + '['));
  if (direct) return direct;
  // TLV 容器: item 节点本身按 tag 命名, 其 children 里才有字段名
  for (const item of node.children) {
    if (item.type === 'tlv-item') {
      const inner = item.children?.find((c) => c.name === name);
      if (inner) return inner;
    }
  }
  return undefined;
}

export function compareResult(result: DecodeResult, expected: Record<string, unknown>): Mismatch[] {
  const mismatches: Mismatch[] = [];
  walk(result.root, expected, '$', mismatches);
  // CRC 等校验节点单独确认全部通过
  checkCrc(result.root, mismatches);
  return mismatches;
}

function walk(node: DecodeNode, expected: unknown, path: string, mismatches: Mismatch[]): void {
  if (expected === null || expected === undefined) return;

  if (Array.isArray(expected)) {
    const children = node.children ?? [];
    if (children.length !== expected.length) {
      mismatches.push({ path, expected: `数组长度 ${expected.length}`, actual: `数组长度 ${children.length}`, reason: '数组长度不一致' });
      return;
    }
    expected.forEach((item, i) => walk(children[i], item, `${path}[${i}]`, mismatches));
    return;
  }

  if (typeof expected === 'object') {
    // 字节字段: 期望值是 Uint8Array, 解码节点 value 为 hex 字符串
    if (isUint8Array(expected)) {
      compareScalar(path, node.value, expected, mismatches);
      return;
    }
    const children = node.children ?? [];
    for (const [key, expVal] of Object.entries(expected as Record<string, unknown>)) {
      const child = findChild(node, key);
      if (!child) {
        // 位域容器的子字段在 node.bits 中
        const bit = node.bits?.find((b) => b.name === key);
        if (bit) {
          compareScalar(`${path}.${key}`, bit.value, expVal, mismatches);
          continue;
        }
        mismatches.push({ path: `${path}.${key}`, expected: expVal, actual: undefined, reason: '解码树缺少该字段' });
        continue;
      }
      walk(child, expVal, child.path, mismatches);
    }
    return;
  }

  // 标量叶子
  compareScalar(path, node.value, expected, mismatches);
}

function checkCrc(node: DecodeNode, mismatches: Mismatch[]): void {
  if (node.type === 'crc' && node.crcOk === false) {
    mismatches.push({ path: node.path, expected: '校验通过', actual: node.display, reason: 'CRC/校验和不通过' });
  }
  for (const c of node.children ?? []) checkCrc(c, mismatches);
}
