import type { FieldDef, ProtocolDef, TlvTagDef } from './types';

function mergeField(base: FieldDef, override: FieldDef): FieldDef {
  const merged: FieldDef = { ...base, ...override };
  // 嵌套字段按 name 对齐合并
  if (base.fields && override.fields) {
    merged.fields = mergeFieldList(base.fields, override.fields);
  }
  // TLV tags 按 tag 值对齐
  if (base.tlv?.tags && override.tlv?.tags) {
    merged.tlv = {
      ...base.tlv,
      ...override.tlv,
      tags: mergeTlvTags(base.tlv.tags, override.tlv.tags),
    };
  }
  // 位域 children 按 name 对齐
  if (base.children && override.children) {
    const map = new Map(base.children.map((c) => [c.name, c]));
    merged.children = override.children.map((c) => ({ ...(map.get(c.name) ?? {}), ...c }));
  }
  if (base.element && override.element) {
    merged.element = mergeField(base.element, override.element);
  }
  return merged;
}

function mergeFieldList(base: FieldDef[], override: FieldDef[]): FieldDef[] {
  const map = new Map<string, FieldDef>();
  for (const f of base) map.set(f.name, f);
  // 以父版字段顺序为骨架, 同名字段原地替换; 新字段按 override 顺序追加
  const out: FieldDef[] = base.map((b) => {
    const o = override.find((x) => x.name === b.name);
    return o ? mergeField(b, o) : b;
  });
  const known = new Set(base.map((b) => b.name));
  for (const o of override) {
    if (!known.has(o.name)) out.push(o);
  }
  return out;
}

function mergeTlvTags(base: TlvTagDef[], override: TlvTagDef[]): TlvTagDef[] {
  const keyOf = (t: TlvTagDef) => String(Array.isArray(t.tag) ? t.tag[0] : t.tag);
  const map = new Map(base.map((t) => [keyOf(t), t]));
  const out: TlvTagDef[] = [];
  const handled = new Set<string>();
  for (const o of override) {
    const b = map.get(keyOf(o));
    out.push(b ? (mergeField(b, o) as TlvTagDef) : o);
    handled.add(keyOf(o));
  }
  for (const b of base) if (!handled.has(keyOf(b))) out.push(b);
  return out;
}

/** 按 basedOn 链展开版本继承, 得到完整协议定义 */
export function resolveProtocol(protocol: ProtocolDef, all: Map<string, ProtocolDef[]>): ProtocolDef {
  if (!protocol.basedOn) return protocol;
  const versions = all.get(protocol.id);
  const parent = versions?.find((p) => p.version === protocol.basedOn);
  if (!parent) throw new Error(`协议 ${protocol.id} 基于不存在的版本 ${protocol.basedOn}`);
  const resolvedParent = resolveProtocol(parent, all);
  return {
    ...resolvedParent,
    ...protocol,
    endian: protocol.endian,
    frame: { ...resolvedParent.frame, ...protocol.frame },
    reassembly: protocol.reassembly ?? resolvedParent.reassembly,
    fields: mergeFieldList(resolvedParent.fields, protocol.fields),
  };
}

export class ProtocolRegistry {
  /** id -> 各版本原始定义 */
  private raw = new Map<string, ProtocolDef[]>();
  /** id#version -> 展开后定义 */
  private resolved = new Map<string, ProtocolDef>();

  upsert(protocol: ProtocolDef): void {
    const list = this.raw.get(protocol.id) ?? [];
    const idx = list.findIndex((p) => p.version === protocol.version);
    if (idx >= 0) list[idx] = protocol;
    else list.push(protocol);
    this.raw.set(protocol.id, list);
    this.rebuild();
  }

  remove(id: string, version?: string): void {
    if (!version) {
      this.raw.delete(id);
    } else {
      const list = this.raw.get(id);
      if (list) this.raw.set(id, list.filter((p) => p.version !== version));
    }
    this.rebuild();
  }

  private rebuild(): void {
    this.resolved.clear();
    for (const [id, versions] of this.raw) {
      for (const p of versions) {
        const r = resolveProtocol(p, this.raw);
        // key 必须按父版本(展开后的定义)登记, 否则 basedOn 链会自引用
        this.resolved.set(`${id}#${r.version}`, r);
      }
    }
  }

  get(id: string, version?: string): ProtocolDef {
    if (version) {
      const p = this.resolved.get(`${id}#${version}`);
      if (p) return p;
    }
    const versions = this.raw.get(id);
    if (!versions?.length) throw new Error(`协议不存在: ${id}`);
    // 默认取最高版本 (语义化版本号简单比较)
    const latest = [...versions].sort(compareVersion).at(-1)!;
    return this.resolved.get(`${id}#${latest.version}`)!;
  }

  list(): ProtocolDef[] {
    return [...this.resolved.values()];
  }

  versions(id: string): ProtocolDef[] {
    return [...(this.raw.get(id) ?? [])].sort(compareVersion);
  }

  /** 按帧头魔数识别协议; 返回所有候选 (同 id 多版本均可能匹配) */
  matchFrame(frame: Uint8Array): ProtocolDef[] {
    // 先按 magic 匹配 (magic 是跨版本稳定的版本无关特征)
    const candidates: ProtocolDef[] = [];
    for (const p of this.resolved.values()) {
      const magic = p.frame?.magic;
      if (magic && magic.length) {
        const off = p.frame?.magicOffset ?? 0;
        if (frame.length < off + magic.length) continue;
        let ok = true;
        for (let i = 0; i < magic.length; i++) {
          if (frame[off + i] !== magic[i]) { ok = false; break; }
        }
        if (!ok) continue;
      }
      candidates.push(p);
    }
    // 同 id 存在多版本时, 帧长约束不作为过滤条件 (老帧天然比新版短);
    // 仅对单版本协议应用 min/maxSize
    return candidates.filter((p) => {
      const versionCount = this.raw.get(p.id)?.length ?? 1;
      if (versionCount > 1) return true;
      if (p.frame?.minSize && frame.length < p.frame.minSize) return false;
      if (p.frame?.maxSize && frame.length > p.frame.maxSize) return false;
      return true;
    });
  }
}

function compareVersion(a: ProtocolDef, b: ProtocolDef): number {
  const pa = a.version.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.version.split('.').map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
