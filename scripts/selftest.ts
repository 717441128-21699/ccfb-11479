/**
 * 全量自测:
 *  A. 十协议各 10000 条 (共 10 万) 编解码 round-trip, 逐字段比对期望值
 *  B. CRC/校验和坏帧必须被标记
 *  C. v2 协议升级后, v1 老报文仍按旧版正确解码
 *  D. 分片重组: 正常拼回 + 丢包提示 + 内层继续解码
 *  E. 未知样本字段边界推断给出建议
 */
import { Decoder } from '../src/engine/decoder';
import { Encoder } from '../src/engine/encoder';
import { compareResult } from '../src/engine/compare';
import { generateSamples, rng, genP8Inner, P8_INNER, buildRegistry } from '../src/engine/generator';
import { Reassembler } from '../src/engine/reassembly';
import { inferProtocol } from '../src/engine/infer';
import { P8_FRAG, P9_CTRL_V1 } from '../src/engine/protocols2';
import { crc16Modbus } from '../src/engine/crc';

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (!cond) {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}

function banner(t: string): void {
  console.log(`\n=== ${t} ===`);
}

/* ---------------- A. 10 万条 round-trip ---------------- */
banner('A. 十协议 × 10000 条 = 100000 条报文逐字段比对');
const PER = 10000;
const samples = generateSamples(PER);
const registry = buildRegistry();

const perProtocol = new Map<string, { total: number; bad: number; firstMismatch?: unknown }>();
const t0 = performance.now();
for (const s of samples) {
  const proto = registry.get(s.protocolId, s.version);
  const bytes = Uint8Array.from(Buffer.from(s.hex, 'hex'));
  const result = new Decoder(proto).decode(bytes);
  const mm = compareResult(result, s.expected as Record<string, unknown>);
  const stat = perProtocol.get(s.protocolId) ?? { total: 0, bad: 0 };
  stat.total++;
  if (!result.ok || mm.length) {
    stat.bad++;
    stat.firstMismatch ??= { hex: s.hex, errors: result.errors, warnings: result.warnings, mm: mm.slice(0, 3) };
  }
  perProtocol.set(s.protocolId, stat);
}
const elapsed = performance.now() - t0;

let allOk = true;
for (const [id, stat] of perProtocol) {
  const ok = stat.bad === 0;
  allOk &&= ok;
  console.log(`  ${ok ? '✓' : '✗'} ${id.padEnd(10)} ${stat.total} 条, 不一致 ${stat.bad} 条`);
  if (!ok) console.log('    首例:', JSON.stringify(stat.firstMismatch, null, 2));
}
check(allOk, '存在解码不一致的报文');
const throughput = samples.length / (elapsed / 1000);
console.log(`  解码总耗时 ${elapsed.toFixed(1)} ms, 吞吐 ${throughput.toFixed(0)} 帧/秒`);
check(elapsed < 1000, `性能未达标: 10 万条耗时 ${elapsed.toFixed(1)}ms (>1000ms)`);

/* ---------------- B. 坏帧 CRC 必须标红 ---------------- */
banner('B. 校验失败检测 (篡改 CRC 与净荷)');
{
  const proto = registry.get('P2-ENV');
  const good = samples.find((s) => s.protocolId === 'P2-ENV')!;
  const bytes = Uint8Array.from(Buffer.from(good.hex, 'hex'));
  bytes[5] ^= 0xff; // 篡改温度字段, CRC 必然失配
  const r = new Decoder(proto).decode(bytes);
  const crcNode = r.flat['$.crc'];
  check(crcNode?.crcOk === false, '篡改净荷后 CRC 未报失败');
  check(r.warnings.some((w) => w.includes('校验失败')), '校验失败未进入 warnings');

  // P1 CRC16-Modbus 字节序
  const p1 = registry.get('P1-METER');
  const good1 = samples.find((s) => s.protocolId === 'P1-METER')!;
  const b1 = Uint8Array.from(Buffer.from(good1.hex, 'hex'));
  const calc = crc16Modbus(b1.subarray(0, b1.length - 2));
  const wireLe = b1[b1.length - 2] | (b1[b1.length - 1] << 8);
  check(calc === wireLe, 'P1 CRC16-Modbus(LE) 字节序不符');
  void p1;

  // checksum8 (P4)
  const p4good = samples.find((s) => s.protocolId === 'P4-GW')!;
  const b4 = Uint8Array.from(Buffer.from(p4good.hex, 'hex'));
  b4[2] = (b4[2] + 1) & 0xff;
  const r4 = new Decoder(registry.get('P4-GW')).decode(b4);
  check(r4.flat['$.crc']?.crcOk === false, 'P4 累加和未报失败');
}

/* ---------------- C. 版本兼容: 老报文按旧版解 ---------------- */
banner('C. 协议版本升级向后兼容 (P9 v1/v2)');
{
  const r = rng(7);
  const encV1 = new Encoder(P9_CTRL_V1);
  const v1Values = { head: 0xc0, devId: 1234, cmd: 2, param: 500 };
  const v1Frame = encV1.encode(v1Values);
  check(v1Frame.length === 7, `v1 帧长应为 7, 实际 ${v1Frame.length}`);

  // 默认拿最新版, 但显式指定 v1 必须能解老帧
  const asV1 = new Decoder(registry.get('P9-CTRL', '1.0')).decode(v1Frame);
  const mm1 = compareResult(asV1, v1Values);
  check(asV1.ok && mm1.length === 0, `v1 老报文按 1.0 解码失败: ${JSON.stringify(mm1)}`);

  const v2Resolved = registry.get('P9-CTRL', '2.0');
  const encV2 = new Encoder(v2Resolved);
  const v2Values = { head: 0xc0, devId: 1234, zone: 7, cmd: 4, param: 999999 };
  const v2Frame = encV2.encode(v2Values);
  check(v2Frame.length === 10, `v2 帧长应为 10, 实际 ${v2Frame.length}`);
  const asV2 = new Decoder(registry.get('P9-CTRL', '2.0')).decode(v2Frame);
  const mm2 = compareResult(asV2, v2Values);
  check(asV2.ok && mm2.length === 0, `v2 报文按 2.0 解码失败: ${JSON.stringify(mm2)}`);

  // v1 帧不能被 v2 正常解析 (长度约束/字段错位), 确认版本隔离
  const cross = new Decoder(registry.get('P9-CTRL', '2.0')).decode(v1Frame);
  check(cross.warnings.length > 0 || !cross.ok, 'v1 帧被 v2 静默误解, 版本隔离失效');

  // matchFrame 能识别同 magic 的两个版本候选
  const matches = registry.matchFrame(v1Frame).filter((p) => p.id === 'P9-CTRL');
  check(matches.length === 2, `应识别到 P9 两个版本候选, 实际 ${matches.length}`);
}

/* ---------------- D. 分片重组 + 丢包 ---------------- */
banner('D. 分包重组 (含丢包提示与内层解码)');
{
  const r = rng(99);
  const innerValues = genP8Inner(r);
  const innerBytes = new Encoder(P8_INNER).encode(innerValues);

  const deviceId = 4321;
  const msgId = 88;
  const chunkSize = 7;
  const total = Math.ceil(innerBytes.length / chunkSize);
  const reasm = new Reassembler(P8_FRAG);

  const makeFrag = (seq: number): Uint8Array => {
    const part = innerBytes.subarray(seq * chunkSize, Math.min((seq + 1) * chunkSize, innerBytes.length));
    return new Encoder(P8_FRAG).encode({
      head: 0xfb, deviceId, msgId, seq, total, payloadLen: part.length, payload: part,
    });
  };

  // 先只投递除第 1 片外的所有片 → 不完整, 明确缺片
  for (let seq = 0; seq < total; seq++) {
    if (seq === 1) continue;
    const out = reasm.addFragment(makeFrag(seq));
    if (seq !== 1) check(!out.complete && out.missing.includes(1), `缺少 seq=1 时应报告 missing [1], 实际 ${out.missing}`);
  }
  const before = reasm.addFragment(makeFrag(0));
  check(!before.complete, '缺片状态下不应判定 complete');

  // 补齐第 1 片
  const done = reasm.addFragment(makeFrag(1));
  check(done.complete, '补齐后应 complete');
  check(done.payload !== null && bytesEq(done.payload, innerBytes), '重组净荷与原始内层报文不一致');

  // 内层继续解码
  const innerResult = new Decoder(P8_INNER).decode(done.payload!);
  const mm = compareResult(innerResult, innerValues as Record<string, unknown>);
  check(innerResult.ok && mm.length === 0, `重组后内层解码失败: ${JSON.stringify(mm)}`);

  // 乱序投递另一组也能正确重组
  const reasm2 = new Reassembler(P8_FRAG);
  const seqs = Array.from({ length: total }, (_, i) => i).reverse();
  let last = reasm2.addFragment(makeFrag(seqs[0]));
  for (const seq of seqs.slice(1)) last = reasm2.addFragment(makeFrag(seq));
  check(last.complete && bytesEq(last.payload!, innerBytes), '乱序分片重组失败');
}

/* ---------------- E. 字段推断 ---------------- */
banner('E. 未知样本字段边界推断');
{
  // 构造一批结构未知但有规律的样本: 固定头 + 长度 + 枚举 + 递增序号 + 数据 + 尾校验
  const r = rng(2024);
  const hexes: string[] = [];
  for (let i = 0; i < 12; i++) {
    const body: number[] = [0xab, 0xcd, 0, r() > 0.5 ? 1 : 2, i & 0xff, ri8(r), ri8(r), ri8(r)];
    const len = body.length + 1;
    body[2] = len;
    let sum = 0;
    for (const b of body) sum = (sum + b) & 0xff;
    body.push(sum);
    hexes.push(body.map((b) => b.toString(16).padStart(2, '0')).join(''));
  }
  const infer = inferProtocol(hexes, 'be');
  const roles = infer.fields.map((f) => f.role);
  check(roles.includes('magic'), '未推断出帧头魔数');
  check(roles.includes('length'), '未推断出长度字段');
  check(roles.includes('enum') || roles.includes('seq') || roles.includes('counter'), '未推断出枚举/序号字段');
  check(roles.includes('checksum'), '未推断出尾部校验');
  console.log(`  推断字段: ${infer.fields.map((f) => `${f.name}[${f.role}@${f.start}+${f.size},${(f.confidence * 100) | 0}%]`).join(' ')}`);
  console.log(`  备注: ${infer.notes.join('; ') || '无'}`);
}

function ri8(r: () => number): number {
  return Math.floor(r() * 256);
}
function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

console.log(`\n${failures === 0 ? '✅ 全部自测通过' : `❌ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
