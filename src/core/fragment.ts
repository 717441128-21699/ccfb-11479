/**
 * 分包重组:把按序号到达的分片拼回完整报文,并检测丢包。
 */

import { decodeMessage } from './decoder.js';
import type { DecodeResult, FragmentDef, ProtocolDef } from './types.js';

export interface ReassembleEvent {
  type: 'complete' | 'progress' | 'gap-warning' | 'session-replaced' | 'incomplete';
  session: string;
  /** complete 时:拼回的完整报文 */
  data?: Uint8Array;
  /** complete 且配置了 innerProtocolId 时:完整报文的解码结果 */
  decoded?: DecodeResult;
  received?: number;
  total?: number;
  /** 缺失的序号 */
  missing?: number[];
  message: string;
}

interface SessionState {
  total: number;
  seqBase: number;
  parts: Map<number, Uint8Array>;
  createdAt: number;
}

export class Reassembler {
  private sessions = new Map<string, SessionState>();

  constructor(
    private proto: ProtocolDef,
    private innerProto?: ProtocolDef,
  ) {}

  private fragmentDef(): FragmentDef {
    // 分片描述在版本上;取第一个带 fragment 的版本
    for (const v of this.proto.versions) {
      if (v.fragment) return v.fragment;
    }
    throw new Error(`协议 ${this.proto.id} 没有分包描述`);
  }

  /** 喂入一个分片帧,返回产生的事件(可能拼出完整报文) */
  push(frame: Uint8Array): ReassembleEvent[] {
    const frag = this.fragmentDef();
    const decoded = decodeMessage(frame, this.proto);
    const events: ReassembleEvent[] = [];
    if (!decoded.ok) {
      events.push({
        type: 'gap-warning',
        session: '?',
        message: `分片帧解码失败: ${decoded.errors.join('; ')}`,
      });
      return events;
    }
    const session = String(decoded.values[frag.session]);
    const seq = Number(decoded.values[frag.seq]);
    const total = Number(decoded.values[frag.total]);
    const payloadHex = String(decoded.values[frag.payload] ?? '');
    const payload = new Uint8Array(payloadHex.length / 2);
    for (let i = 0; i < payload.length; i++) {
      payload[i] = parseInt(payloadHex.substr(i * 2, 2), 16);
    }
    const seqBase = frag.seqBase ?? 0;

    let st = this.sessions.get(session);
    if (st && st.total !== total) {
      // 同会话号新一轮:旧会话作废,报告缺失
      events.push({
        type: 'session-replaced',
        session,
        missing: missingSeqs(st, seqBase),
        message: `会话 ${session} 重新开始,上一轮的 ${st.parts.size}/${st.total} 个分片被丢弃`,
      });
      st = undefined;
    }
    if (!st) {
      st = { total, seqBase, parts: new Map(), createdAt: Date.now() };
      this.sessions.set(session, st);
    }
    st.parts.set(seq, payload);

    if (st.parts.size === st.total) {
      const missing = missingSeqs(st, seqBase);
      this.sessions.delete(session);
      if (missing.length > 0) {
        events.push({
          type: 'incomplete',
          session,
          received: st.parts.size,
          total: st.total,
          missing,
          message: `会话 ${session} 数量凑齐但序号缺失: ${missing.join(', ')}`,
        });
        return events;
      }
      // 按序号拼接
      const all: number[] = [];
      for (let s = seqBase; s < seqBase + st.total; s++) {
        all.push(...Array.from(st.parts.get(s)!));
      }
      const data = Uint8Array.from(all);
      const ev: ReassembleEvent = {
        type: 'complete',
        session,
        data,
        received: st.total,
        total: st.total,
        message: `会话 ${session} 拼回完整报文(${st.total} 片, ${data.length} 字节)`,
      };
      if (this.innerProto) {
        ev.decoded = decodeMessage(data, this.innerProto);
      }
      events.push(ev);
    } else {
      // 序号跳变提示可能丢包
      const expected = seqBase + st.parts.size - 1;
      const ev: ReassembleEvent = {
        type: 'progress',
        session,
        received: st.parts.size,
        total: st.total,
        message: `会话 ${session} 已收 ${st.parts.size}/${st.total}`,
      };
      if (seq > expected) {
        events.push({
          type: 'gap-warning',
          session,
          message: `会话 ${session} 序号跳变: 期望 ${expected},实到 ${seq},可能丢包`,
        });
      }
      events.push(ev);
    }
    return events;
  }

  /** 收尾:报告所有未完成的会话及其缺失序号 */
  finalize(): ReassembleEvent[] {
    const events: ReassembleEvent[] = [];
    for (const [session, st] of this.sessions) {
      events.push({
        type: 'incomplete',
        session,
        received: st.parts.size,
        total: st.total,
        missing: missingSeqs(st, st.seqBase),
        message: `会话 ${session} 未完成: ${st.parts.size}/${st.total},缺失序号 ${missingSeqs(st, st.seqBase).join(', ')}`,
      });
    }
    this.sessions.clear();
    return events;
  }
}

function missingSeqs(st: SessionState, seqBase: number): number[] {
  const missing: number[] = [];
  for (let s = seqBase; s < seqBase + st.total; s++) {
    if (!st.parts.has(s)) missing.push(s);
  }
  return missing;
}
