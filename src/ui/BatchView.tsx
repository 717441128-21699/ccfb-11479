import { useMemo, useState } from 'react';
import { Decoder } from '../engine/decoder';
import { compareResult } from '../engine/compare';
import { generateSamples } from '../engine/generator';
import { hexToBytes } from './hexutil';
import type { DecodeResult, ProtocolDef } from '../engine/types';
import type { ProtocolStore } from './store';
import { FieldTree } from './FieldTree';

interface BatchRow {
  index: number;
  hex: string;
  matched?: ProtocolDef;
  result?: DecodeResult;
  ok: boolean;
  crcOk?: boolean;
  elapsedUs: number;
  error?: string;
}

interface ExpectedItem {
  hex: string;
  protocolId?: string;
  expected?: Record<string, unknown>;
}

export function BatchView({ store, notify }: { store: ProtocolStore; notify: (m: string, e?: boolean) => void }) {
  const [input, setInput] = useState('');
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [detail, setDetail] = useState<BatchRow | null>(null);
  const [autoDetect, setAutoDetect] = useState(true);

  const stats = useMemo(() => {
    const total = rows.length;
    const ok = rows.filter((r) => r.ok).length;
    const crcBad = rows.filter((r) => r.crcOk === false).length;
    const totalUs = rows.reduce((s, r) => s + r.elapsedUs, 0);
    return { total, ok, fail: total - ok, crcBad, avgUs: total ? totalUs / total : 0, tps: elapsed ? total / (elapsed / 1000) : 0 };
  }, [rows, elapsed]);

  const parseInput = (): ExpectedItem[] => {
    const text = input.trim();
    if (!text) return [];
    // 支持 JSON 数组 (生成器格式 [{hex, expected}]) 或每行一条纯 hex
    if (text.startsWith('[')) {
      const arr = JSON.parse(text) as ExpectedItem[];
      return arr;
    }
    return text.split(/\r?\n/).map((line) => ({ hex: line.trim() })).filter((x) => x.hex);
  };

  const run = () => {
    let items: ExpectedItem[];
    try {
      items = parseInput();
    } catch (e) {
      notify(`输入解析失败: ${(e as Error).message}`, true);
      return;
    }
    if (!items.length) { notify('没有可解码的报文', true); return; }

    const out: BatchRow[] = [];
    const t0 = performance.now();
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const t1 = performance.now();
      try {
        const bytes = hexToBytes(item.hex);
        let proto: ProtocolDef | undefined;
        if (item.protocolId) {
          proto = store.registry.get(item.protocolId);
        } else if (autoDetect) {
          const candidates = store.registry.matchFrame(bytes);
          proto = candidates[0];
        } else {
          proto = store.registry.list()[0];
        }
        if (!proto) {
          out.push({ index: i, hex: item.hex, ok: false, elapsedUs: (performance.now() - t1) * 1000, error: '无匹配协议' });
          continue;
        }
        const result = new Decoder(proto).decode(bytes);
        const crcNode = Object.values(result.flat).find((n) => n.type === 'crc');
        let ok = result.ok;
        if (item.expected) {
          const mm = compareResult(result, item.expected);
          if (mm.length) ok = false;
        }
        out.push({
          index: i,
          hex: item.hex,
          matched: proto,
          result,
          ok,
          crcOk: crcNode?.crcOk,
          elapsedUs: (performance.now() - t1) * 1000,
          error: result.errors.join('; ') || undefined,
        });
      } catch (e) {
        out.push({ index: i, hex: item.hex, ok: false, elapsedUs: (performance.now() - t1) * 1000, error: (e as Error).message });
      }
    }
    const dt = performance.now() - t0;
    setElapsed(dt);
    setRows(out);
    setDetail(null);
    notify(`解码 ${out.length} 帧, 成功 ${out.filter((r) => r.ok).length}, 耗时 ${dt.toFixed(1)} ms`);
  };

  const loadDemo = () => {
    const samples = generateSamples(1000);
    // 混合: 每个协议取若干条, 保留 expected 用于一致性核对
    const mixed = samples.filter((_, i) => i % 1000 < 30);
    setInput(JSON.stringify(mixed, null, 0));
    notify(`已载入 ${mixed.length} 帧混合样本 (含期望结果)`);
  };

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-header">
          批量解码
          <div style={{ flex: 1 }} />
          <label className="row" style={{ margin: 0 }}>
            <input type="checkbox" checked={autoDetect} onChange={(e) => setAutoDetect(e.target.checked)} />
            按帧头自动识别协议
          </label>
          <button className="sm" onClick={loadDemo}>载入演示样本</button>
          <button className="sm primary" onClick={run}>开始批量解码</button>
        </div>
        <div className="panel-body" style={{ paddingBottom: 8 }}>
          <textarea
            className="mono"
            rows={5}
            style={{ width: '100%' }}
            placeholder={'每行一条 hex, 或粘贴 JSON 数组 [{"hex":"…","protocolId":"…","expected":{…}}]'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            spellCheck={false}
          />
        </div>
      </div>

      {rows.length > 0 && (
        <>
          <div className="row">
            <div className="pill-stat"><div className="num">{stats.total}</div><div className="lbl">总帧数</div></div>
            <div className="pill-stat"><div className="num" style={{ color: 'var(--ok)' }}>{stats.ok}</div><div className="lbl">成功</div></div>
            <div className="pill-stat"><div className="num" style={{ color: 'var(--err)' }}>{stats.fail}</div><div className="lbl">失败</div></div>
            <div className="pill-stat"><div className="num" style={{ color: 'var(--warn)' }}>{stats.crcBad}</div><div className="lbl">校验失败</div></div>
            <div className="pill-stat"><div className="num">{elapsed.toFixed(1)}<span style={{ fontSize: 12 }}> ms</span></div><div className="lbl">总耗时</div></div>
            <div className="pill-stat"><div className="num">{stats.tps.toFixed(0)}</div><div className="lbl">帧/秒</div></div>
            <div className="pill-stat"><div className="num">{stats.avgUs.toFixed(1)}<span style={{ fontSize: 12 }}> µs</span></div><div className="lbl">单帧平均</div></div>
          </div>

          <div className="split" style={{ flex: 1, minHeight: 0 }}>
            <div className="panel">
              <div className="panel-header">逐帧结果</div>
              <div className="panel-body" style={{ padding: 0 }}>
                <table>
                  <thead><tr><th>#</th><th>匹配协议</th><th>版本</th><th>状态</th><th>校验</th><th>µs</th><th>报文(截断)</th></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.index} onClick={() => setDetail(r)} style={{ cursor: 'pointer', background: detail?.index === r.index ? '#1a2740' : undefined }}>
                        <td className="mono">{r.index}</td>
                        <td className="mono">{r.matched?.id ?? '—'}</td>
                        <td>{r.matched?.version ?? '—'}</td>
                        <td><span className={`tag ${r.ok ? 'ok' : 'err'}`}>{r.ok ? 'OK' : 'FAIL'}</span></td>
                        <td>{r.crcOk === undefined ? '—' : <span className={`tag ${r.crcOk ? 'ok' : 'err'}`}>{r.crcOk ? '通过' : '失败'}</span>}</td>
                        <td className="mono muted">{r.elapsedUs.toFixed(1)}</td>
                        <td className="mono muted" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.hex.slice(0, 48)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="panel">
              <div className="panel-header">{detail ? `帧 #${detail.index} 解码树` : '帧详情'}</div>
              <div className="panel-body">
                {!detail && <div className="muted">点击左侧行查看完整字段树</div>}
                {detail?.result && <FieldTree node={detail.result.root} selectedPath={null} onSelect={() => {}} />}
                {detail?.error && <div className="tag err">{detail.error}</div>}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
