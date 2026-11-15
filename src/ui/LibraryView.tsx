import { useMemo, useState } from 'react';
import type { ProtocolDef } from '../engine/types';
import type { ProtocolStore } from './store';

interface Props {
  store: ProtocolStore;
  onEdit: (p: ProtocolDef) => void;
  notify: (msg: string, err?: boolean) => void;
}

export function LibraryView({ store, onEdit, notify }: Props) {
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const list = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return store.protocols
      .filter((p) => !kw || p.id.toLowerCase().includes(kw) || p.name.includes(kw) || (p.vendor ?? '').includes(kw))
      .sort((a, b) => (a.id + a.version).localeCompare(b.id + b.version));
  }, [store.protocols, q]);

  const current = selected ? store.protocols.find((p) => `${p.id}#${p.version}` === selected) : null;

  const doExport = (p: ProtocolDef) => {
    const blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${p.id}-v${p.version}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const doExportAll = () => {
    const blob = new Blob([store.exportJson()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'protocol-library.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const doImport = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const n = store.importJson(String(reader.result));
        notify(`成功导入 ${n} 个协议定义`);
      } catch (e) {
        notify(`导入失败: ${(e as Error).message}`, true);
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="split">
      <div className="panel" style={{ flex: 1.2 }}>
        <div className="panel-header">
          协议库
          <span className="tag info">{store.protocols.length} 个定义</span>
          <div className="spacer" style={{ flex: 1 }} />
          <input placeholder="搜索 id/名称/厂家" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 180 }} />
          <button className="sm" onClick={doExportAll}>导出全部</button>
          <label className="btn sm" style={{ margin: 0 }}>
            导入 JSON
            <input type="file" accept=".json" hidden onChange={(e) => e.target.files?.[0] && doImport(e.target.files[0])} />
          </label>
          <button className="sm danger" onClick={() => { if (confirm('恢复内置十协议? 当前自定义将丢失')) { store.reset(); notify('已重置为内置协议库'); } }}>
            重置内置
          </button>
        </div>
        <div className="panel-body" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr><th>协议 ID</th><th>名称</th><th>厂家</th><th>版本</th><th>继承</th><th>字节序</th><th>字段数</th><th></th></tr>
            </thead>
            <tbody>
              {list.map((p) => {
                const key = `${p.id}#${p.version}`;
                return (
                  <tr key={key} onClick={() => setSelected(key)} style={{ cursor: 'pointer', background: selected === key ? '#1a2740' : undefined }}>
                    <td className="mono">{p.id}</td>
                    <td>{p.name}</td>
                    <td>{p.vendor ?? '—'}</td>
                    <td><span className="tag purple">v{p.version}</span></td>
                    <td className="muted">{p.basedOn ? `← v${p.basedOn}` : '—'}</td>
                    <td>{p.endian.toUpperCase()}</td>
                    <td>{p.fields.length}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <button className="sm" onClick={() => onEdit(p)}>编辑</button>{' '}
                      <button className="sm" onClick={() => doExport(p)}>导出</button>{' '}
                      <button className="sm danger" onClick={() => { if (confirm(`删除 ${key}?`)) { store.remove(p.id, p.version); setSelected(null); } }}>删除</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel" style={{ flex: 1 }}>
        <div className="panel-header">{current ? `${current.id} v${current.version} 详情` : '协议详情'}</div>
        <div className="panel-body">
          {!current && <div className="muted">在左侧选择一个协议查看声明式定义</div>}
          {current && (
            <>
              <div className="row mb8">
                <strong>{current.name}</strong>
                <span className="tag info">{current.vendor}</span>
                {current.reassembly && <span className="tag warn">支持分片重组</span>}
              </div>
              {current.description && <p className="muted">{current.description}</p>}
              <pre className="mono scroll" style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, fontSize: 11, maxHeight: '60vh', overflow: 'auto' }}>
                {JSON.stringify(current, null, 2)}
              </pre>
              <button className="primary mt8" onClick={() => onEdit(current)}>在编辑器中打开</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
