import { Decoder } from './decoder';
import type { DecodeResult, ProtocolDef } from './types';

export interface ReasmFragment {
  /** 原始分片帧 */
  frame: Uint8Array;
  /** 可选: 已解出的分片帧节点(避免重复解码) */
  decoded?: DecodeResult;
}

export interface ReasmGroup {
  key: string;
  total: number;
  received: Map<number, Uint8Array>;
  firstSeen: number;
  complete: boolean;
  /** 缺失序号 */
  missing: number[];
}

export interface ReasmOutput {
  key: string;
  complete: boolean;
  total: number;
  receivedCount: number;
  missing: number[];
  /** 重组后的完整净荷 (complete=false 时为 null) */
  payload: Uint8Array | null;
  /** 若配置 innerProtocol, 对重组净荷继续解码 */
  inner?: DecodeResult;
}

/**
 * 数据上报型分片重组:
 * 每帧带 groupKey(设备号/消息id) + seq(序号) + total(总片数) + payload。
 * 按组缓存, 集齐后按序号拼接; 缺片明确提示。
 */
export class Reassembler {
  private groups = new Map<string, ReasmGroup>();
  constructor(private protocol: ProtocolDef) {
    if (!protocol.reassembly) throw new Error('该协议未配置 reassembly');
  }

  private cfg() {
    return this.protocol.reassembly!;
  }

  addFragment(frame: Uint8Array): ReasmOutput {
    const cfg = this.cfg();
    const decoded = new Decoder(this.protocol).decode(frame);
    const flat = decoded.flat;

    const seqNode = flat[`$.${cfg.seqField}`];
    const totalNode = flat[`$.${cfg.totalField}`];
    const payloadNode = flat[`$.${cfg.payloadField}`];
    if (seqNode == null || totalNode == null || payloadNode == null) {
      throw new Error(`分片帧缺少重组字段 (${cfg.seqField}/${cfg.totalField}/${cfg.payloadField})`);
    }
    const seq = Number(seqNode.raw ?? seqNode.value);
    const total = Number(totalNode.raw ?? totalNode.value);
    const payload = payloadNode.raw instanceof Uint8Array
      ? payloadNode.raw
      : hexToBytes(String(payloadNode.value));

    const keyParts = cfg.groupKeyFields.map((f) => {
      const n = flat[`$.${f}`];
      return String(n?.raw ?? n?.value ?? '');
    });
    const key = keyParts.join('|');

    let group = this.groups.get(key);
    if (!group) {
      group = { key, total, received: new Map(), firstSeen: Date.now(), complete: false, missing: [] };
      this.groups.set(key, group);
    }
    group.received.set(seq, payload);

    return this.buildOutput(group);
  }

  private buildOutput(group: ReasmGroup): ReasmOutput {
    const missing: number[] = [];
    for (let i = 0; i < group.total; i++) {
      if (!group.received.has(i)) missing.push(i);
    }
    group.missing = missing;
    group.complete = missing.length === 0 && group.received.size === group.total;

    let payload: Uint8Array | null = null;
    let inner: DecodeResult | undefined;
    if (group.complete) {
      const totalLen = [...group.received.values()].reduce((s, b) => s + b.length, 0);
      payload = new Uint8Array(totalLen);
      let off = 0;
      for (let i = 0; i < group.total; i++) {
        const part = group.received.get(i)!;
        payload.set(part, off);
        off += part.length;
      }
    }

    const out: ReasmOutput = {
      key: group.key,
      complete: group.complete,
      total: group.total,
      receivedCount: group.received.size,
      missing,
      payload,
      inner,
    };
    return out;
  }

  /** 清理超过 ttlMs 仍未集齐的组, 返回被清理组的诊断信息 (丢包提示用) */
  sweep(ttlMs = 60_000): ReasmOutput[] {
    const now = Date.now();
    const stale: ReasmOutput[] = [];
    for (const [key, group] of this.groups) {
      if (group.complete || now - group.firstSeen < ttlMs) continue;
      stale.push(this.buildOutput(group));
      this.groups.delete(key);
    }
    return stale;
  }

  groupCount(): number {
    return this.groups.size;
  }

  get protocolId(): string {
    return this.protocol.id;
  }
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/0x/i, '').replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array, sep = ''): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0');
    if (sep && i < bytes.length - 1) s += sep;
  }
  return s;
}
