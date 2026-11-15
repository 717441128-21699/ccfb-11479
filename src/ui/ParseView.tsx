import { useMemo, useRef, useState } from 'react';
import { Decoder } from '../engine/decoder';
import { Reassembler } from '../engine/reassembly';
import { inferProtocol, type InferredField } from '../engine/infer';
import type { DecodeNode, DecodeResult, ProtocolDef } from '../engine/types';
import type { ProtocolStore } from './store';
import { HexViewer } from './HexViewer';
import { FieldTree, findNodeAtByte, flattenNodes } from './FieldTree';
import { hexToBytes, isHexInput } from './hexutil';

type Mode = 'decode' | 'infer' | 'reasm';

export function ParseView({ store, notify }: { store: ProtocolStore; notify: (m: string, e?: boolean) => void }) {
  const [mode, setMode] = useState<Mode>('decode');
  const [hex, setHex] = useState('');
  const [protoId, setProtoId] = useState(store.protocols[0]?.id ?? '');
  const [version, setVersion] = useState<string>('');
  const [selected, setSelected] = useState<DecodeNode | null>(null);
  const [inferEndian, setInferEndian] = useState<'le' | 'be'>('be');

  const proto: ProtocolDef | undefined = useMemo(() => {
    try {
      return store.registry.get(protoId, version || undefined);
    } catch {
      return undefined;
    }
  }, [store, protoId, version]);

  const bytes = useMemo(() => {
    try { return isHexInput(hex) ? hexToBytes(hex) : new Uint8Array(); }
    catch { return new Uint8Array(); }
  }, [hex]);

  const result: DecodeResult | null = useMemo(() => {
    if (mode !== 'decode' || !proto || bytes.length === 0) return null;
    try { return new Decoder(proto).decode(bytes); }
    catch { return null; }
  }, [mode, proto, bytes]);

  const allNodes = useMemo(() => (result ? flattenNodes(result.root) : []), [result]);
  const badRanges = useMemo(
    () => allNodes.filter((n) => n.type === 'crc' && n.crcOk === false).map((n) => ({ start: n.start, end: n.end })),
    [allNodes],
  );

  const onByteClick = (index: number) => {
    const node = findNodeAtByte(allNodes, index);
    if (node) setSelected(node);
  };

  /* ---------- 自动推断 ---------- */
  const inferInputs = useMemo(() => hex.split(/\n+|;|；/).map((s) => s.trim()).filter(Boolean), [hex]);
  const inferResult = useMemo(() => {
    if (mode !== 'infer' || inferInputs.length < 2) return null;
    try {
      return inferProtocol(inferInputs, inferEndian);
    } catch (e) {
      notify(`推断失败: ${(e as Error).message}`, true);
      return null;
    }
  }, [mode, inferInputs, inferEndian, notify]);

  const applyInfer = (f: InferredField) => {
    notify(`已生成字段草案: ${f.name} (${f.role}), 可到协议编辑器细化`);
  };

  /* ---------- 分片重组 ---------- */
  const [reasmOutput, setReasmOutput] = useState<ReturnType<Reassembler['addFragment']> | null>(null);
  const [reasmLog, setReasmLog] = useState<string[]>([]);
  const sessionRef = useRef<Reassembler | null>(null);
  const reasmProto = useMemo(
    () => store.protocols.find((p) => p.id === protoId && p.reassembly),
    [store.protocols, protoId],
  );
  const feedFragment = () => {
    if (!reasmProto) { notify('所选协议未配置 reassembly', true); return; }
    if (!isHexInput(hex)) { notify('请输入合法十六进制分片帧', true); return; }
    try {
      if (!sessionRef.current || sessionRef.current.protocolId !== reasmProto.id) {
        sessionRef.current = new Reassembler(reasmProto);
        setReasmLog([]);
      }
      const out = sessionRef.current.addFragment(hexToBytes(hex));
      setReasmOutput(out);
      setReasmLog((l) => [
        ...l,
        `+ 帧 [${hex.replace(/\s/g, '').slice(0, 20)}…] → 组 ${out.key} 进度 ${out.receivedCount}/${out.total}${out.complete ? ' ✓ 完整' : ` 缺片 [${out.missing.join(',')}]`}`,
      ]);
      if (out.complete && out.payload) {
        const innerId = reasmProto.reassembly?.innerProtocol;
        if (innerId) {
          try {
            const inner = store.registry.get(innerId);
            out.inner = new Decoder(inner).decode(out.payload);
          } catch { /* 内层协议未注册时仅展示净荷 */ }
        }
      }
      setHex('');
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-header">
          <button className={`sm ${mode === 'decode' ? 'primary' : ''}`} onClick={() => setMode('decode')}>单帧解析</button>
          <button className={`sm ${mode === 'infer' ? 'primary' : ''}`} onClick={() => setMode('infer')}>未知样本推断</button>
          <button className={`sm ${mode === 'reasm' ? 'primary' : ''}`} onClick={() => setMode('reasm')}>分片重组</button>
          <div style={{ flex: 1 }} />
          {mode !== 'infer' && (
            <>
              <select value={protoId} onChange={(e) => { setProtoId(e.target.value); setVersion(''); setSelected(null); }}>
                {[...new Set(store.protocols.map((p) => p.id))].map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
              <select value={version} onChange={(e) => setVersion(e.target.value)}>
                <option value="">最新版本</option>
                {store.registry.versions(protoId).map((p) => <option key={p.version} value={p.version}>v{p.version}{p.basedOn ? ` (继承 ${p.basedOn})` : ''}</option>)}
              </select>
            </>
          )}
          {mode === 'infer' && (
            <select value={inferEndian} onChange={(e) => setInferEndian(e.target.value as 'le' | 'be')}>
              <option value="be">假设大端</option><option value="le">假设小端</option>
            </select>
          )}
        </div>
        <div className="panel-body" style={{ paddingBottom: 8 }}>
          <textarea
            className="mono"
            rows={mode === 'infer' ? 5 : 3}
            style={{ width: '100%' }}
            placeholder={
              mode === 'infer'
                ? '粘贴多条同类未知报文, 每行一条 (建议 ≥5 条), 自动猜测字段边界…'
                : '粘贴十六进制报文, 支持空格/无分隔, 如: 68 40 56 0f …'
            }
            value={hex}
            onChange={(e) => setHex(e.target.value)}
            spellCheck={false}
          />
          <div className="row mt8">
            {mode === 'reasm' ? (
              <>
                <button className="primary" onClick={feedFragment}>投递分片</button>
                <span className="muted">协议 {reasmProto ? `${reasmProto.id} 已配置重组` : '当前协议无 reassembly 配置'}</span>
              </>
            ) : (
              <span className="muted">{bytes.length > 0 ? `${bytes.length} 字节` : '等待输入…'}</span>
            )}
          </div>
        </div>
      </div>

      {mode === 'decode' && result && (
        <div className="split" style={{ flex: 1, minHeight: 0 }}>
          <div className="panel">
            <div className="panel-header">
              十六进制
              {result.warnings.length > 0 && <span className="tag warn">{result.warnings.length} 警告</span>}
              {result.errors.length > 0 && <span className="tag err">{result.errors.length} 错误</span>}
            </div>
            <div className="panel-body">
              <HexViewer bytes={bytes} highlight={selected ? { start: selected.start, end: selected.end } : null} onByteClick={onByteClick} badRanges={badRanges} />
            </div>
          </div>
          <div className="panel">
            <div className="panel-header">
              字段树
              {selected && <span className="tag info">{selected.name} [{selected.start}–{selected.end})</span>}
            </div>
            <div className="panel-body">
              <FieldTree node={result.root} selectedPath={selected?.path ?? null} onSelect={setSelected} />
            </div>
          </div>
        </div>
      )}

      {mode === 'infer' && (
        <div className="panel" style={{ flex: 1, minHeight: 0 }}>
          <div className="panel-header">
            字段边界建议
            {inferResult && <span className="tag info">{inferResult.sampleCount} 条样本 · 长度 {inferResult.minLen}~{inferResult.maxLen}</span>}
          </div>
          <div className="panel-body">
            {!inferResult && <div className="muted">至少输入 2 条同类报文 (每行一条) 后自动推断</div>}
            {inferResult && (
              <>
                {inferResult.notes.map((n, i) => <div key={i} className="tag warn mb8" style={{ marginRight: 6 }}>{n}</div>)}
                <table>
                  <thead><tr><th>建议字段名</th><th>推断角色</th><th>偏移</th><th>宽度</th><th>置信度</th><th>依据</th><th></th></tr></thead>
                  <tbody>
                    {inferResult.fields.map((f, i) => (
                      <tr key={i}>
                        <td className="mono">{f.name}</td>
                        <td><span className="tag purple">{f.role}</span></td>
                        <td className="mono">{f.start}</td>
                        <td className="mono">{f.size}</td>
                        <td>
                          <div className="bar" style={{ width: 90 }}><i style={{ width: `${f.confidence * 100}%`, background: f.confidence > 0.8 ? 'var(--ok)' : f.confidence > 0.5 ? 'var(--warn)' : 'var(--err)' }} /></div>
                          <span className="muted mono" style={{ fontSize: 10 }}>{(f.confidence * 100) | 0}%</span>
                        </td>
                        <td className="muted">{f.reason}</td>
                        <td><button className="sm" onClick={() => applyInfer(f)}>加入草案</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </div>
      )}

      {mode === 'reasm' && (
        <div className="split" style={{ flex: 1, minHeight: 0 }}>
          <div className="panel">
            <div className="panel-header">投递日志</div>
            <div className="panel-body">
              {reasmLog.length === 0 && <div className="muted">逐片粘贴分片帧并投递, 按 deviceId+msgId 自动归组</div>}
              {reasmLog.map((l, i) => <div key={i} className="mono" style={{ padding: '4px 0', fontSize: 11, borderBottom: '1px solid #212c3a' }}>{l}</div>)}
            </div>
          </div>
          <div className="panel">
            <div className="panel-header">重组状态</div>
            <div className="panel-body">
              {!reasmOutput && <div className="muted">等待分片…</div>}
              {reasmOutput && (
                <>
                  <div className="row mb8">
                    <span className={`tag ${reasmOutput.complete ? 'ok' : 'warn'}`}>{reasmOutput.complete ? '重组完整' : '缺包'}</span>
                    <span className="tag info">组 {reasmOutput.key}</span>
                    <span className="tag">{reasmOutput.receivedCount}/{reasmOutput.total} 片</span>
                  </div>
                  {!reasmOutput.complete && (
                    <div className="tag err mb8">缺失序号: [{reasmOutput.missing.join(', ')}]</div>
                  )}
                  {reasmOutput.payload && (
                    <div className="field">
                      <label>重组后完整净荷 ({reasmOutput.payload.length} 字节)</label>
                      <pre className="mono scroll" style={{ background: 'var(--bg)', padding: 10, borderRadius: 8, fontSize: 11, maxHeight: 160, overflow: 'auto' }}>
                        {[...reasmOutput.payload].map((b) => b.toString(16).padStart(2, '0')).join(' ')}
                      </pre>
                    </div>
                  )}
                  {reasmOutput.inner && (
                    <div className="field">
                      <label>内层协议 {reasmProto?.reassembly?.innerProtocol} 继续解码</label>
                      <FieldTree node={reasmOutput.inner.root} selectedPath={null} onSelect={() => {}} />
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
