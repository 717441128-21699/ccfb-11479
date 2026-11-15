/** UI 共享状态:协议注册表 + 最近一次批量解码结果 */

import { ProtocolRegistry, loadUserProtocols, markBuiltin, persistUserProtocols } from '../core/registry.js';
import { builtinProtocols } from '../protocols/library.js';
import type { DecodeResult } from '../core/types.js';

export const registry = new ProtocolRegistry();
for (const p of builtinProtocols) registry.register(p);
markBuiltin(builtinProtocols.map((p) => p.id));
loadUserProtocols(registry);

export function persist(): void {
  persistUserProtocols(registry);
}

export const builtinIds = new Set(builtinProtocols.map((p) => p.id));

/** 最近一次批量解码的结果,供字段统计使用 */
export const batchState = {
  protocolId: '',
  results: [] as DecodeResult[],
  /** 每条报文的原始 hex(与 results 对齐) */
  hexes: [] as string[],
};
