import { useCallback, useState } from 'react';
import { useProtocolStore } from './store';
import { LibraryView } from './LibraryView';
import { EditorView } from './EditorView';
import { ParseView } from './ParseView';
import { BatchView } from './BatchView';
import { StatsView } from './StatsView';
import type { ProtocolDef } from '../engine/types';

type Tab = 'parse' | 'library' | 'editor' | 'batch' | 'stats';

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: 'parse', label: '报文解析', icon: '🔍' },
  { key: 'library', label: '协议库', icon: '📚' },
  { key: 'editor', label: '协议编辑', icon: '✏️' },
  { key: 'batch', label: '批量解码', icon: '⚡' },
  { key: 'stats', label: '字段统计', icon: '📊' },
];

export default function App() {
  const store = useProtocolStore();
  const [tab, setTab] = useState<Tab>('parse');
  const [editing, setEditing] = useState<ProtocolDef | null>(null);
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);

  const notify = useCallback((msg: string, err?: boolean) => {
    setToast({ msg, err });
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  const openEditor = (p: ProtocolDef | null) => {
    setEditing(p);
    setTab('editor');
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">TLV<span>Decoder</span> · 可配置报文解码平台</div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
              <span>{t.icon}</span>{t.label}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <div className="env">TS · React · 声明式协议引擎 · {store.protocols.length} 定义</div>
      </header>

      <main className="content">
        {tab === 'parse' && <ParseView store={store} notify={notify} />}
        {tab === 'library' && <LibraryView store={store} onEdit={openEditor} notify={notify} />}
        {tab === 'editor' && <EditorView store={store} initial={editing} notify={notify} onDone={() => { setEditing(null); setTab('library'); }} />}
        {tab === 'batch' && <BatchView store={store} notify={notify} />}
        {tab === 'stats' && <StatsView store={store} notify={notify} />}
      </main>

      {toast && <div className={`toast ${toast.err ? 'err' : ''}`}>{toast.msg}</div>}
    </div>
  );
}
