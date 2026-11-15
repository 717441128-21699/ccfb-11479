/** localStorage 持久化的协议库状态 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProtocolDef } from '../engine/types';
import { buildRegistry } from '../engine/generator';
import { ProtocolRegistry } from '../engine/registry';

const STORAGE_KEY = 'tlv-decoder.protocols.v1';

function seedProtocols(): ProtocolDef[] {
  return buildRegistry().list();
}

function load(): ProtocolDef[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ProtocolDef[];
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch {
    /* 损坏数据回退到内置 */
  }
  return seedProtocols();
}

export interface ProtocolStore {
  protocols: ProtocolDef[];
  registry: ProtocolRegistry;
  upsert: (p: ProtocolDef) => void;
  remove: (id: string, version?: string) => void;
  reset: () => void;
  importJson: (text: string) => number;
  exportJson: () => string;
}

export function useProtocolStore(): ProtocolStore {
  const [protocols, setProtocols] = useState<ProtocolDef[]>(load);
  const registryRef = useRef<ProtocolRegistry>(new ProtocolRegistry());

  useEffect(() => {
    const reg = new ProtocolRegistry();
    for (const p of protocols) reg.upsert(p);
    registryRef.current = reg;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(protocols));
    } catch {
      /* 配额超限时忽略持久化 */
    }
  }, [protocols]);

  // 首次也填充 registry
  if (registryRef.current.list().length === 0) {
    const reg = new ProtocolRegistry();
    for (const p of protocols) reg.upsert(p);
    registryRef.current = reg;
  }

  const upsert = useCallback((p: ProtocolDef) => {
    setProtocols((prev) => {
      const others = prev.filter((x) => !(x.id === p.id && x.version === p.version));
      return [...others, p];
    });
  }, []);

  const remove = useCallback((id: string, version?: string) => {
    setProtocols((prev) => prev.filter((p) => !(p.id === id && (version ? p.version === version : true))));
  }, []);

  const reset = useCallback(() => setProtocols(seedProtocols()), []);

  const importJson = useCallback((text: string) => {
    const data = JSON.parse(text);
    const list: ProtocolDef[] = Array.isArray(data) ? data : [data];
    setProtocols((prev) => {
      let next = [...prev];
      for (const p of list) {
        if (!p.id || !p.version || !Array.isArray(p.fields)) {
          throw new Error('协议定义缺少 id/version/fields');
        }
        next = next.filter((x) => !(x.id === p.id && x.version === p.version));
        next.push(p);
      }
      return next;
    });
    return list.length;
  }, []);

  const exportJson = useCallback(() => JSON.stringify(protocols, null, 2), [protocols]);

  return { protocols, registry: registryRef.current, upsert, remove, reset, importJson, exportJson };
}
