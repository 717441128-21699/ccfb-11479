/**
 * 端到端烟雾测试: 模拟浏览器 UI 各视图背后的引擎调用, 确保 UI 依赖的所有路径可用。
 * 覆盖: 协议库加载/识别、单帧解析双向高亮数据、推断、批量、统计、重组、版本、坏帧。
 */
import { Decoder } from '../src/engine/decoder';
import { buildRegistry, generateSamples } from '../src/engine/generator';
import { inferProtocol } from '../src/engine/infer';
import { Reassembler, hexToBytes, bytesToHex } from '../src/engine/reassembly';
import { compareResult } from '../src/engine/compare';
import { findNodeAtByte, flattenNodes } from '../src/ui/FieldTree';
import { toHexRows } from '../src/ui/hexutil';
import { P8_FRAG } from '../src/engine/protocols2';
import { Encoder } from '../src/engine/encoder';
import { genP8Inner, P8_INNER } from '../src/engine/generator';
import { rng } from '../src/engine/generator';

let fails = 0;
const check = (c: boolean, m: string) => { if (!c) { fails++; console.error('  ✗', m); } else console.log('  ✓', m); };

console.log('== 1. 协议库 (registry 内置 11 个定义, 含 P9 两版本) ==');
const reg = buildRegistry();
check(reg.list().length === 12, `内置定义数 ${reg.list().length} (期望 12: 10 协议 + P8 内层 + P9 双版本)`);
check(reg.versions('P9-CTRL').length === 2, 'P9 有两个版本');

console.log('\n== 2. 单帧解析 + 双向高亮数据 ==');
const samples = generateSamples(100);
const s0 = samples[0];
const proto0 = reg.get(s0.protocolId, s0.version);
const bytes0 = hexToBytes(s0.hex);
const r0 = new Decoder(proto0).decode(bytes0);
check(r0.ok, '首帧解析成功');
const flat = flattenNodes(r0.root);
check(flat.length > 5, `字段树节点数 ${flat.length}`);
// 字节 -> 字段 反查 (HexViewer 点击)
const node = findNodeAtByte(flat, 2);
check(!!node && 2 >= node.start && 2 < node.end, '字节偏移 2 能反查到包含它的最小字段');
// 字段 -> 字节 区间 (FieldTree 点击高亮)
check(flat.every((n) => n.end > n.start || n.type === 'root'), '所有节点携带有效字节区间');
// hex rows 渲染数据
const rows = toHexRows(bytes0);
check(rows.length === Math.ceil(bytes0.length / 16), `hex 行数 ${rows.length}`);

console.log('\n== 3. 自动推断 (未知样本) ==');
const r = rng(77);
const hexes: string[] = [];
for (let i = 0; i < 10; i++) {
  const body = [0xab, 0xcd, 12, i % 3, i & 0xff, ri(r), ri(r), ri(r), ri(r)];
  let sum = 0; for (const b of body) sum = (sum + b) & 0xff;
  body.push(sum);
  hexes.push(bytesToHex(Uint8Array.from(body), ''));
}
const inf = inferProtocol(hexes, 'be');
check(inf.fields.some((f) => f.role === 'magic'), '推断出魔数');
check(inf.fields.some((f) => f.role === 'checksum'), '推断出校验');
check(inf.fields.every((f) => f.suggested.name && f.suggested.type), '每个建议都可生成 FieldDef 草案');

console.log('\n== 4. 批量解码 (按样本自带 protocolId 精确选择, 模拟真实路由) ==');
let okCount = 0;
let noMagicCount = 0;
for (const s of samples) {
  const b = hexToBytes(s.hex);
  // 真实场景: 接入侧已知来源协议, 按 id+version 精确取定义
  const p = reg.get(s.protocolId, s.version);
  const rr = new Decoder(p).decode(b);
  if (rr.ok && compareResult(rr, s.expected as Record<string, unknown>).length === 0) okCount++;
  // 同时验证 matchFrame 不会把该帧漏判 (至少能识别出正确 id 候选)
  if (!reg.matchFrame(b).some((c) => c.id === s.protocolId)) noMagicCount++;
}
check(okCount === samples.length, `精确路由批量 ${okCount}/${samples.length} 全部正确`);
check(noMagicCount === 0, `所有帧都能被 matchFrame 识别到正确协议族 (漏判 ${noMagicCount})`);

console.log('\n== 5. 字段统计数据可聚合 ==');
const acc = new Map<string, { count: number; values: number[] }>();
const p2 = reg.get('P2-ENV');
for (const s of samples.filter((x) => x.protocolId === 'P2-ENV')) {
  const rr = new Decoder(p2).decode(hexToBytes(s.hex));
  for (const n of flattenNodes(rr.root)) {
    if (typeof n.value === 'number') {
      const a = acc.get(n.path) ?? { count: 0, values: [] };
      a.count++; a.values.push(n.value); acc.set(n.path, a);
    }
  }
}
const tempStat = acc.get('$.temperature');
check(!!tempStat && tempStat.count === 100, `温度字段聚合 ${tempStat?.count} 帧`);
check((tempStat?.values.length ?? 0) === 100 && Math.min(...tempStat!.values) < Math.max(...tempStat!.values), '温度有数值分布');

console.log('\n== 6. CRC 坏帧标红 ==');
const good = samples.find((x) => x.protocolId === 'P1-METER')!;
const bad = hexToBytes(good.hex);
bad[4] ^= 0xff;
const rb = new Decoder(reg.get('P1-METER')).decode(bad);
const crcNode = rb.flat['$.crc'];
check(crcNode?.crcOk === false, '篡改后 CRC 节点 crcOk=false (UI 标红依据)');
check(rb.warnings.some((w) => w.includes('校验失败')), 'warnings 含校验失败');

console.log('\n== 7. 分片重组 + 丢包 + 内层解码 ==');
{
  const innerBytes = new Encoder(P8_INNER).encode(genP8Inner(rng(5)));
  const chunk = 5;
  const total = Math.ceil(innerBytes.length / chunk);
  const re = new Reassembler(P8_FRAG);
  const mk = (seq: number) => {
    const part = innerBytes.subarray(seq * chunk, Math.min((seq + 1) * chunk, innerBytes.length));
    return new Encoder(P8_FRAG).encode({ head: 0xfb, deviceId: 9, msgId: 1, seq, total, payloadLen: part.length, payload: part });
  };
  // 先投 seq 0, 2..total-1, 唯独缺 seq=1, 验证缺包中间态
  re.addFragment(mk(0));
  let partial: ReturnType<Reassembler['addFragment']> | null = null;
  for (let seq = 2; seq < total; seq++) partial = re.addFragment(mk(seq));
  check(!partial!.complete && partial!.missing.includes(1), `缺 seq=1 被明确报告 (missing=[${partial!.missing}])`);
  // 补齐 seq=1
  const o1 = re.addFragment(mk(1));
  check(o1.complete && !!o1.payload && bytesToHex(o1.payload, '') === bytesToHex(innerBytes, ''), '补齐后重组净荷一致');
  if (o1.payload) {
    const inner = new Decoder(P8_INNER).decode(o1.payload);
    check(inner.ok, '内层协议解码成功');
  }
}

console.log('\n== 8. 版本: 老报文按旧版解 ==');
{
  const v1 = reg.get('P9-CTRL', '1.0');
  const frame = new Encoder(v1).encode({ head: 0xc0, devId: 7, cmd: 1, param: 42 });
  const d1 = new Decoder(reg.get('P9-CTRL', '1.0')).decode(frame);
  check(d1.ok && d1.flat['$.param']?.value === 42, 'v1 老报文按 1.0 解出 param=42');
}

console.log(`\n${fails === 0 ? '✅ 端到端烟雾测试全部通过' : `❌ ${fails} 项失败`}`);
process.exit(fails ? 1 : 0);

function ri(r: () => number) { return Math.floor(r() * 256); }
