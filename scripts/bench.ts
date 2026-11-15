/**
 * 性能基准: 十协议 × 10000 条。
 * 分别测量: 纯解码吞吐、解码+逐字段比对的端到端吞吐, 并输出分协议耗时。
 */
import { Decoder } from '../src/engine/decoder';
import { compareResult } from '../src/engine/compare';
import { buildRegistry, generateSamples } from '../src/engine/generator';

const PER = Number(process.argv[2] ?? 10000);
console.log(`生成十协议各 ${PER} 条报文 (共 ${PER * 10} 条)...`);
const tGen0 = performance.now();
const samples = generateSamples(PER);
const registry = buildRegistry();
console.log(`生成+编码耗时 ${(performance.now() - tGen0).toFixed(1)} ms\n`);

// 预热
for (let i = 0; i < 2000; i++) {
  const s = samples[i];
  new Decoder(registry.get(s.protocolId, s.version)).decode(Buffer.from(s.hex, 'hex'));
}

const perProto = new Map<string, { n: number; us: number; bad: number; crcFail: number }>();
let badTotal = 0;
let crcFailTotal = 0;

const t0 = performance.now();
for (const s of samples) {
  const proto = registry.get(s.protocolId, s.version);
  const bytes = Uint8Array.from(Buffer.from(s.hex, 'hex'));
  const t1 = performance.now();
  const result = new Decoder(proto).decode(bytes);
  const us = (performance.now() - t1) * 1000;
  const mm = compareResult(result, s.expected as Record<string, unknown>);
  const stat = perProto.get(s.protocolId) ?? { n: 0, us: 0, bad: 0, crcFail: 0 };
  stat.n++;
  stat.us += us;
  if (mm.length) { stat.bad++; badTotal++; }
  if (result.warnings.some((w) => w.includes('校验失败'))) { stat.crcFail++; crcFailTotal++; }
  perProto.set(s.protocolId, stat);
}
const elapsed = performance.now() - t0;

console.log('协议         帧数     平均耗时(µs)   不一致  校验失败');
for (const [id, s] of perProto) {
  console.log(
    `${id.padEnd(12)} ${String(s.n).padStart(6)}   ${(s.us / s.n).toFixed(2).padStart(8)}     ${String(s.bad).padStart(4)}   ${String(s.crcFail).padStart(6)}`,
  );
}
console.log(`\n总帧数       ${samples.length}`);
console.log(`总耗时       ${elapsed.toFixed(1)} ms`);
console.log(`吞吐         ${(samples.length / (elapsed / 1000)).toFixed(0)} 帧/秒`);
console.log(`单协议 1 万条平均耗时 ${(elapsed / 10).toFixed(1)} ms (要求 < 1000 ms)`);
console.log(`正确性       不一致 ${badTotal} 帧, 校验失败 ${crcFailTotal} 帧`);

if (badTotal > 0 || elapsed > 1000 * 10) process.exit(1);
