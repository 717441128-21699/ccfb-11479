/**
 * 协议库:注册、查找、按版本解码。浏览器端可挂 localStorage 持久化。
 */

import { decodeMessage, type DecodeOptions } from './decoder.js';
import type { DecodeResult, ProtocolDef } from './types.js';

export class ProtocolRegistry {
  private protos = new Map<string, ProtocolDef>();

  register(proto: ProtocolDef): void {
    if (!proto.id || !proto.versions?.length) {
      throw new Error('协议定义必须包含 id 和至少一个版本');
    }
    this.protos.set(proto.id, proto);
  }

  remove(id: string): boolean {
    return this.protos.delete(id);
  }

  get(id: string): ProtocolDef | undefined {
    return this.protos.get(id);
  }

  list(): ProtocolDef[] {
    return Array.from(this.protos.values());
  }

  decode(buf: Uint8Array, protocolId: string, opts: DecodeOptions = {}): DecodeResult {
    const proto = this.protos.get(protocolId);
    if (!proto) throw new Error(`未知协议: ${protocolId}`);
    return decodeMessage(buf, proto, opts);
  }

  /** 导出全部协议为 JSON */
  exportJson(): string {
    return JSON.stringify(this.list(), null, 2);
  }

  /** 从 JSON 导入(合并,同 id 覆盖) */
  importJson(json: string): number {
    const arr = JSON.parse(json) as ProtocolDef[];
    if (!Array.isArray(arr)) throw new Error('协议库 JSON 必须是数组');
    for (const p of arr) this.register(p);
    return arr.length;
  }
}

/** localStorage 持久化(仅浏览器) */
export function persistUserProtocols(registry: ProtocolRegistry, key = 'iot-decoder-protocols'): void {
  const g = globalThis as { localStorage?: Storage };
  if (!g.localStorage) return;
  const builtin = new Set(builtinIds);
  const user = registry.list().filter((p) => !builtin.has(p.id));
  g.localStorage.setItem(key, JSON.stringify(user));
}

export function loadUserProtocols(registry: ProtocolRegistry, key = 'iot-decoder-protocols'): number {
  const g = globalThis as { localStorage?: Storage };
  if (!g.localStorage) return 0;
  const raw = g.localStorage.getItem(key);
  if (!raw) return 0;
  try {
    const arr = JSON.parse(raw) as ProtocolDef[];
    for (const p of arr) registry.register(p);
    return arr.length;
  } catch {
    return 0;
  }
}

let builtinIds: string[] = [];
export function markBuiltin(ids: string[]): void {
  builtinIds = ids;
}
