/**
 * 批量解码一致性测试 + 性能基准:
 *  - 10 种协议 x 10000 条,解码结果与期望值逐字段比对,必须完全一致
 *  - 每种协议 10000 条解码耗时必须 < 1 秒
 *  - 附加正确性用例:校验失败检出、分包丢包提示、版本自动匹配
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { decodeMessage, fromHex } from '../core/decoder.js';
import { Reassembler } from '../core/fragment.js';
import { ProtocolRegistry } from '../core/registry.js';
import { builtinProtocols, envSensor, fragPayload, fragUplink } from '../protocols/library.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '../../data');

const registry = new ProtocolRegistry();
for (const p of builtinProtocols) registry.register(p);

interface MessageFile {
  protocolId: string;
  fragmented: boolean;
  messages: { hex?: string; frames?: string[]; expected: Record<string, unknown> }[];
}

let failures = 0;

function diff(expected: Record<string, unknown>, actual: Record<string, unknown>): string[] {
  const diffs: string[] = [];
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const k of keys) {
    const e = expected[k];
    const a = actual[k];
    if (typeof e === 'number' && typeof a === 'number') {
      if (Math.abs(e - a) > 1e-9) diffs.push(`${k}: 期望 ${e}, 实际 ${a}`);
    } else if (e !== a) {
      diffs.push(`${k}: 期望 ${JSON.stringify(e)}, 实际 ${JSON.stringify(a)}`);
    }
  }
  return diffs;
}

function testSimpleProtocol(file: MessageFile): void {
  const proto = registry.get(file.protocolId)!;
  const t0 = performance.now();
  let mismatch = 0;
  let checksumFail = 0;
  let firstDiffs: string[] = [];
  for (const msg of file.messages) {
    const buf = fromHex(msg.hex!);
    const result = decodeMessage(buf, proto); // 不指定版本,走自动匹配
    if (!result.checksum?.ok && proto.versions.some((v) => v.checksum)) checksumFail++;
    const d = diff(msg.expected, result.values);
    if (d.length > 0) {
      mismatch++;
      if (firstDiffs.length === 0) firstDiffs = d.slice(0, 5);
    }
  }
  const ms = performance.now() - t0;
  const ok = mismatch === 0 && checksumFail === 0 && ms < 1000;
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${file.protocolId}: ${file.messages.length} 条, ` +
      `不一致 ${mismatch}, 校验失败 ${checksumFail}, 耗时 ${ms.toFixed(1)}ms`,
  );
  if (mismatch > 0) console.log(`  首条差异: ${firstDiffs.join(' | ')}`);
  if (!ok) failures++;
}

function testFragmentedProtocol(file: MessageFile): void {
  const t0 = performance.now();
  let mismatch = 0;
  let completed = 0;
  let firstDiffs: string[] = [];
  for (const msg of file.messages) {
    const reasm = new Reassembler(fragUplink, fragPayload);
    let decodedValues: Record<string, unknown> | undefined;
    for (const frameHex of msg.frames!) {
      for (const ev of reasm.push(fromHex(frameHex))) {
        if (ev.type === 'complete') decodedValues = ev.decoded!.values;
      }
    }
    if (!decodedValues) {
      mismatch++;
      if (firstDiffs.length === 0) firstDiffs = ['未拼出完整报文'];
      continue;
    }
    completed++;
    const d = diff(msg.expected, decodedValues);
    if (d.length > 0) {
      mismatch++;
      if (firstDiffs.length === 0) firstDiffs = d.slice(0, 5);
    }
  }
  const ms = performance.now() - t0;
  const ok = mismatch === 0 && ms < 1000;
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${file.protocolId}: ${file.messages.length} 条(分片), ` +
      `拼回 ${completed}, 不一致 ${mismatch}, 耗时 ${ms.toFixed(1)}ms`,
  );
  if (mismatch > 0) console.log(`  首条差异: ${firstDiffs.join(' | ')}`);
  if (!ok) failures++;
}

/** 附加用例 1:篡改一个字节后校验必须失败 */
function testChecksumDetection(): void {
  const file = load('modbus-meter.json');
  let detected = 0;
  const N = 200;
  for (let i = 0; i < N; i++) {
    const buf = fromHex(file.messages[i].hex!);
    buf[3] ^= 0xff; // 篡改
    const result = decodeMessage(buf, registry.get('modbus-meter')!);
    if (result.checksum && !result.checksum.ok) detected++;
  }
  const ok = detected === N;
  console.log(`${ok ? 'PASS' : 'FAIL'} 校验失败检出: ${detected}/${N} 条篡改报文被标出`);
  if (!ok) failures++;
}

/** 附加用例 2:分片丢失必须提示 */
function testFragmentLoss(): void {
  const file = load('frag-uplink.json');
  let lossReported = 0;
  const N = 200;
  for (let i = 0; i < N; i++) {
    const reasm = new Reassembler(fragUplink, fragPayload);
    const frames = file.messages[i].frames!;
    // 丢掉中间一片
    const dropIdx = 1 % frames.length;
    let sawIncomplete = false;
    frames.forEach((f, idx) => {
      if (idx === dropIdx) return;
      for (const ev of reasm.push(fromHex(f))) {
        if (ev.type === 'incomplete' || ev.type === 'gap-warning') sawIncomplete = true;
      }
    });
    for (const ev of reasm.finalize()) {
      if (ev.type === 'incomplete' && ev.missing && ev.missing.includes(dropIdx)) sawIncomplete = true;
    }
    if (sawIncomplete) lossReported++;
  }
  const ok = lossReported === N;
  console.log(`${ok ? 'PASS' : 'FAIL'} 分包丢包提示: ${lossReported}/${N} 个丢包会话被报告`);
  if (!ok) failures++;
}

/** 附加用例 3:版本自动匹配 */
function testVersionMatch(): void {
  const file = load('env-sensor.json');
  let wrong = 0;
  for (let i = 0; i < 1000; i++) {
    const buf = fromHex(file.messages[i].hex!);
    const result = decodeMessage(buf, envSensor);
    const expectedVersion = String(file.messages[i].expected['version']);
    if (result.version !== expectedVersion) wrong++;
  }
  const ok = wrong === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'} 版本自动匹配: 1000 条抽样,匹配错误 ${wrong} 条`);
  if (!ok) failures++;
}

function load(name: string): MessageFile {
  return JSON.parse(readFileSync(join(dataDir, name), 'utf-8')) as MessageFile;
}

const files = readdirSync(dataDir).filter((f) => f.endsWith('.json')).sort();
if (files.length === 0) {
  console.error('data/ 目录没有测试数据,先运行 npm run gen');
  process.exit(1);
}

console.log('=== 批量解码一致性 + 性能 ===');
for (const name of files) {
  const file = load(name);
  if (file.fragmented) testFragmentedProtocol(file);
  else testSimpleProtocol(file);
}

console.log('=== 附加正确性用例 ===');
testChecksumDetection();
testFragmentLoss();
testVersionMatch();

if (failures > 0) {
  console.error(`\n共 ${failures} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
