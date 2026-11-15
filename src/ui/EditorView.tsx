import { useEffect, useState } from 'react';
import type { FieldDef, ProtocolDef } from '../engine/types';
import type { ProtocolStore } from './store';
import { Decoder } from '../engine/decoder';

interface Props {
  store: ProtocolStore;
  initial: ProtocolDef | null;
  notify: (msg: string, err?: boolean) => void;
  onDone: () => void;
}

const TYPES: FieldDef['type'][] = ['uint', 'int', 'float', 'bcd', 'bool', 'enum', 'bits', 'string', 'bytes', 'array', 'struct', 'tlv', 'crc'];

function blankProtocol(): ProtocolDef {
  return {
    id: 'P-NEW',
    name: '新协议',
    vendor: '',
    version: '1.0',
    endian: 'be',
    fields: [{ name: 'head', type: 'uint', size: 1 }],
  };
}

export function EditorView({ store, initial, notify, onDone }: Props) {
  const [proto, setProto] = useState<ProtocolDef>(() => structuredClone(initial ?? blankProtocol()));
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [testHex, setTestHex] = useState('');

  useEffect(() => { setJsonText(JSON.stringify(proto, null, 2)); }, [proto, jsonMode]);

  const patch = (p: Partial<ProtocolDef>) => setProto((prev) => ({ ...prev, ...p }));

  const updateField = (idx: number, patchField: Partial<FieldDef>) => {
    setProto((prev) => {
      const fields = prev.fields.map((f, i) => (i === idx ? { ...f, ...patchField } : f));
      return { ...prev, fields };
    });
  };

  const addField = () =>
    setProto((prev) => ({ ...prev, fields: [...prev.fields, { name: `field${prev.fields.length + 1}`, type: 'uint', size: 1 }] }));
  const removeField = (idx: number) => setProto((prev) => ({ ...prev, fields: prev.fields.filter((_, i) => i !== idx) }));
  const moveField = (idx: number, dir: -1 | 1) =>
    setProto((prev) => {
      const fields = [...prev.fields];
      const j = idx + dir;
      if (j < 0 || j >= fields.length) return prev;
      [fields[idx], fields[j]] = [fields[j], fields[idx]];
      return { ...prev, fields };
    });

  const applyJson = () => {
    try {
      const parsed = JSON.parse(jsonText) as ProtocolDef;
      if (!parsed.id || !parsed.version || !Array.isArray(parsed.fields)) throw new Error('缺少 id/version/fields');
      setProto(parsed);
      notify('JSON 已应用到结构化模型');
    } catch (e) {
      notify(`JSON 错误: ${(e as Error).message}`, true);
    }
  };

  const save = () => {
    try {
      // 基础校验 + 试解码 (若有测试报文)
      if (!/^[A-Za-z0-9_-]+$/.test(proto.id)) throw new Error('协议 id 只能含字母数字-_');
      const names = new Set<string>();
      for (const f of proto.fields) {
        if (names.has(f.name)) throw new Error(`字段名重复: ${f.name}`);
        names.add(f.name);
      }
      store.upsert(proto);
      notify(`已保存协议 ${proto.id} v${proto.version}`);
      onDone();
    } catch (e) {
      notify(`保存失败: ${(e as Error).message}`, true);
    }
  };

  const testDecode = () => {
    try {
      const bytes = Uint8Array.from(testHex.replace(/[^0-9a-fA-F]/g, '').match(/.{2}/g)!.map((h) => parseInt(h, 16)));
      const r = new Decoder(proto).decode(bytes);
      return r;
    } catch (e) {
      notify(`测试解码异常: ${(e as Error).message}`, true);
      return null;
    }
  };
  const testResult = jsonMode ? null : testHex ? testDecode() : null;

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-header">
          协议编辑
          <div className="spacer" style={{ flex: 1 }} />
          <button className="sm" onClick={() => setJsonMode(!jsonMode)}>
            {jsonMode ? '切换结构化编辑' : '切换 JSON 编辑'}
          </button>
          <button className="sm" onClick={onDone}>取消</button>
          <button className="sm primary" onClick={save}>保存协议</button>
        </div>
      </div>

      {!jsonMode ? (
        <div className="split" style={{ flex: 1, minHeight: 0 }}>
          <div className="panel">
            <div className="panel-header">基本信息与字段</div>
            <div className="panel-body">
              <div className="grid2">
                <div className="field"><label>协议 ID</label><input value={proto.id} onChange={(e) => patch({ id: e.target.value })} /></div>
                <div className="field"><label>名称</label><input value={proto.name} onChange={(e) => patch({ name: e.target.value })} /></div>
                <div className="field"><label>厂家</label><input value={proto.vendor ?? ''} onChange={(e) => patch({ vendor: e.target.value })} /></div>
                <div className="field"><label>版本</label><input value={proto.version} onChange={(e) => patch({ version: e.target.value })} /></div>
                <div className="field">
                  <label>默认字节序</label>
                  <select value={proto.endian} onChange={(e) => patch({ endian: e.target.value as 'le' | 'be' })}>
                    <option value="be">大端 BE</option><option value="le">小端 LE</option>
                  </select>
                </div>
                <div className="field">
                  <label>继承版本 (basedOn)</label>
                  <input value={proto.basedOn ?? ''} placeholder="如 1.0" onChange={(e) => patch({ basedOn: e.target.value || undefined })} />
                </div>
              </div>

              <div className="row mt8 mb8">
                <strong>字段序列 ({proto.fields.length})</strong>
                <div style={{ flex: 1 }} />
                <button className="sm primary" onClick={addField}>+ 新增字段</button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {proto.fields.map((f, idx) => (
                  <div key={idx} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, background: 'var(--bg)' }}>
                    <div className="row">
                      <input style={{ width: 130 }} value={f.name} onChange={(e) => updateField(idx, { name: e.target.value })} placeholder="字段名" />
                      <select style={{ width: 100 }} value={f.type} onChange={(e) => updateField(idx, { type: e.target.value as FieldDef['type'] })}>
                        {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <select style={{ width: 80 }} value={f.endian ?? ''} onChange={(e) => updateField(idx, { endian: (e.target.value || undefined) as 'le' | 'be' | undefined })}>
                        <option value="">继承序</option><option value="be">BE</option><option value="le">LE</option>
                      </select>
                      {['uint', 'int', 'float', 'bcd', 'enum', 'crc'].includes(f.type) && (
                        <input style={{ width: 70 }} type="number" min={1} max={8} value={f.size ?? 1} onChange={(e) => updateField(idx, { size: Number(e.target.value) })} title="字节宽度 size" />
                      )}
                      {['string', 'bytes'].includes(f.type) && (
                        <input style={{ width: 90 }} type="number" value={f.length ?? 0} onChange={(e) => updateField(idx, { length: Number(e.target.value) })} placeholder="length" title="定长 length" />
                      )}
                      <div style={{ flex: 1 }} />
                      <button className="sm" onClick={() => moveField(idx, -1)}>↑</button>
                      <button className="sm" onClick={() => moveField(idx, 1)}>↓</button>
                      <button className="sm danger" onClick={() => removeField(idx)}>删除</button>
                    </div>
                    <div className="row mt8">
                      {(f.type === 'uint' || f.type === 'int' || f.type === 'float') && (
                        <>
                          <label style={{ margin: 0 }}>缩放</label>
                          <input style={{ width: 80 }} type="number" step="any" value={f.scale ?? ''} placeholder="scale" onChange={(e) => updateField(idx, { scale: e.target.value === '' ? undefined : Number(e.target.value) })} />
                          <label style={{ margin: 0 }}>偏移</label>
                          <input style={{ width: 80 }} type="number" step="any" value={f.offset ?? ''} placeholder="offset" onChange={(e) => updateField(idx, { offset: e.target.value === '' ? undefined : Number(e.target.value) })} />
                          <label style={{ margin: 0 }}>单位</label>
                          <input style={{ width: 80 }} value={f.units ?? ''} onChange={(e) => updateField(idx, { units: e.target.value })} />
                        </>
                      )}
                      {f.type === 'crc' && (
                        <select value={f.crc?.algo ?? 'crc16-modbus'} onChange={(e) => updateField(idx, { crc: { ...(f.crc ?? { algo: e.target.value }), algo: e.target.value as FieldDef['crc'] extends infer C ? any : never } })}>
                          {['crc16-modbus', 'crc16-ccitt', 'crc32', 'checksum8', 'checksum16'].map((a) => <option key={a} value={a}>{a}</option>)}
                        </select>
                      )}
                      <label style={{ margin: 0 }}>条件 when</label>
                      <input style={{ width: 160 }} className="mono" value={f.when ?? ''} placeholder="$msgType == 0" onChange={(e) => updateField(idx, { when: e.target.value || undefined })} />
                    </div>
                    {f.type === 'tlv' && (
                      <div className="muted mt8 mono" style={{ fontSize: 11 }}>
                        TLV 标签定义数: {f.tlv?.tags?.length ?? 0} · tag {f.tlv?.tag.size ?? 1}B / len {f.tlv?.length.size ?? 1}B
                        （复杂 TLV 请用 JSON 模式编辑 tags）
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">实时试解码</div>
            <div className="panel-body">
              <label>粘贴十六进制报文测试当前定义</label>
              <textarea className="mono" rows={4} style={{ width: '100%' }} value={testHex} onChange={(e) => setTestHex(e.target.value)} placeholder="a5 5a c0 77 ..." />
              {testResult && (
                <div className="mt8">
                  <div className="row mb8">
                    <span className={`tag ${testResult.ok ? 'ok' : 'err'}`}>{testResult.ok ? '解析成功' : '解析出错'}</span>
                    {testResult.warnings.map((w, i) => <span key={i} className="tag warn">{w}</span>)}
                    {testResult.errors.map((e, i) => <span key={i} className="tag err">{e}</span>)}
                  </div>
                  <pre className="mono scroll" style={{ fontSize: 11, maxHeight: 300, overflow: 'auto', background: 'var(--bg)', padding: 10, borderRadius: 8 }}>
                    {JSON.stringify(testResult.root, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="panel" style={{ flex: 1 }}>
          <div className="panel-header">
            声明式 JSON
            <div style={{ flex: 1 }} />
            <button className="sm" onClick={applyJson}>应用 JSON 到模型</button>
          </div>
          <div className="panel-body">
            <textarea className="json-editor mono" style={{ width: '100%' }} value={jsonText} onChange={(e) => setJsonText(e.target.value)} spellCheck={false} />
          </div>
        </div>
      )}
    </div>
  );
}
