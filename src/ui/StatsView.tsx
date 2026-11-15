import { useMemo, useState } from 'react';
import { Decoder } from '../engine/decoder';
import { generateSamples } from '../engine/generator';
import { hexToBytes } from './hexutil';
import type { DecodeNode, ProtocolDef } from '../engine/types';
import type { ProtocolStore } from './store';

interface FieldStat {
  path: string;
  name: string;
  type: string;
  count: number;
  distinct: Set<string>;
  numeric?: number[];
  min?: number;
  max?: number;
  mean?: number;
  enumCount: Map<string, number>;
  crcFail: number;
}

function isNumericType(t: string): boolean {
  return ['uint', 'int', 'float', 'bcd', 'bool', 'enum', 'bits'].includes(t);
}

function walkCollect(node: DecodeNode, acc: Map<string, FieldStat>): void {
  if (node.type !== 'root') {
    let stat = acc.get(node.path);
    if (!stat) {
      stat = { path: node.path, name: node.name, type: node.type, count: 0, distinct: new Set(), enumCount: new Map(), crcFail: 0 };
      acc.set(node.path, stat);
    }
    stat.count++;
    const key = typeof node.value === 'object' ? JSON.stringify(node.value) : String(node.value);
    stat.distinct.add(key);
    if (node.type === 'crc' && node.crcOk === false) stat.crcFail++;
    if (isNumericType(node.type) && typeof node.value === 'number') {
      (stat.numeric ??= []).push(node.value);
    }
    if (node.type === 'enum') {
      const label = node.display ?? String(node.value);
      stat.enumCount.set(label, (stat.enumCount.get(label) ?? 0) + 1);
    }
  }
  for (const c of node.children ?? []) walkCollect(c, acc);
}

export function StatsView({ store, notify }: { store: ProtocolStore; notify: (m: string, e?: boolean) => void }) {
  const [input, setInput] = useState('');
  const [protoId, setProtoId] = useState(store.protocols[0]?.id ?? '');
  const [stats, setStats] = useState<FieldStat[] | null>(null);
  const [frameCount, setFrameCount] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  const proto: ProtocolDef | undefined = useMemo(() => {
    try { return store.registry.get(protoId); } catch { return undefined; }
  }, [store, protoId]);

  const run = () => {
    if (!proto) { notify('协议不可用', true); return; }
    const lines = input.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) { notify('请输入报文, 每行一条', true); return; }
    const acc = new Map<string, FieldStat>();
    const decoder = new Decoder(proto);
    const t0 = performance.now();
    let n = 0;
    for (const line of lines) {
      try {
        const bytes = hexToBytes(line);
        const r = decoder.decode(bytes);
        walkCollect(r.root, acc);
        n++;
      } catch (e) {
        notify(`第 ${n + 1} 帧跳过: ${(e as Error).message}`, true);
      }
    }
    const dt = performance.now() - t0;
    const list = [...acc.values()].map((s) => {
      if (s.numeric?.length) {
        s.min = Math.min(...s.numeric);
        s.max = Math.max(...s.numeric);
        s.mean = s.numeric.reduce((a, b) => a + b, 0) / s.numeric.length;
      }
      return s;
    });
    setStats(list);
    setFrameCount(n);
    setElapsed(dt);
  };

  const loadDemo = () => {
    const samples = generateSamples(2000).filter((s) => s.protocolId === protoId);
    setInput(samples.map((s) => s.hex).join('\n'));
    notify(`已载入 ${samples.length} 帧 ${protoId} 样本`);
  };

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-header">
          字段统计
          <select value={protoId} onChange={(e) => setProtoId(e.target.value)}>
            {[...new Set(store.protocols.map((p) => p.id))].map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
          <div style={{ flex: 1 }} />
          <button className="sm" onClick={loadDemo}>载入 2000 帧演示</button>
          <button className="sm primary" onClick={run}>统计</button>
        </div>
        <div className="panel-body" style={{ paddingBottom: 8 }}>
          <textarea className="mono" rows={4} style={{ width: '100%' }} placeholder="每行一条同协议 hex 报文" value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} />
        </div>
      </div>

      {stats && (
        <div className="panel" style={{ flex: 1, minHeight: 0 }}>
          <div className="panel-header">
            统计结果
            <span className="tag info">{frameCount} 帧 · {elapsed.toFixed(1)} ms · {stats.length} 个字段路径</span>
          </div>
          <div className="panel-body" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr><th>字段路径</th><th>类型</th><th>出现次数</th><th>不同值</th><th>最小</th><th>最大</th><th>均值</th><th>枚举分布 / 校验</th></tr>
              </thead>
              <tbody>
                {stats.map((s) => (
                  <tr key={s.path}>
                    <td className="mono">{s.path.replace('$.', '')}</td>
                    <td><span className="tag purple">{s.type}</span></td>
                    <td className="mono">{s.count}</td>
                    <td className="mono">{s.distinct.size}</td>
                    <td className="mono">{s.min !== undefined ? formatNum(s.min) : '—'}</td>
                    <td className="mono">{s.max !== undefined ? formatNum(s.max) : '—'}</td>
                    <td className="mono">{s.mean !== undefined ? formatNum(s.mean) : '—'}</td>
                    <td style={{ maxWidth: 320 }}>
                      {s.type === 'crc' && (
                        <span className={`tag ${s.crcFail ? 'err' : 'ok'}`}>{s.crcFail ? `${s.crcFail} 帧失败` : '全部通过'}</span>
                      )}
                      {s.enumCount.size > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {[...s.enumCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => (
                            <span key={k} className="tag info">{k}: {v}</span>
                          ))}
                        </div>
                      )}
                      {s.type !== 'enum' && s.type !== 'crc' && s.distinct.size <= 5 && (
                        <span className="muted" style={{ fontSize: 11 }}>{[...s.distinct].slice(0, 5).join(', ')}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return Number.isInteger(n) ? String(n) : n.toPrecision(8).replace(/0+$/, '').replace(/\.$/, '');
}
