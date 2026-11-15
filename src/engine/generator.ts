/**
 * 十协议 × 各 10000 条报文合成器。
 * 每条样本 = { hex, expected }, expected 是与解码树节点 value 对齐的嵌套对象,
 * 用于批量解码的逐字段一致性校验。使用确定性 PRNG, 结果可复现。
 */
import { Encoder } from './encoder';
import { ProtocolRegistry } from './registry';
import {
  P1_METER, P2_ENV, P3_GPS, P4_GW, P5_ACL,
} from './protocols1';
import {
  P6_TLV, P7_VIB, P8_FRAG, P8_INNER, P9_CTRL_V1, P9_CTRL_V2, P10_WATER,
} from './protocols2';
import type { ProtocolDef } from './types';

/** mulberry32 确定性 PRNG */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ri = (r: () => number, min: number, max: number) => min + Math.floor(r() * (max - min + 1));
const pick = <T,>(r: () => number, arr: T[]): T => arr[Math.floor(r() * arr.length)];

export interface GeneratedSample {
  protocolId: string;
  version: string;
  hex: string;
  expected: Record<string, unknown>;
}

function toHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

function bcdNumber(r: () => number, digits: number): number {
  let s = '';
  for (let i = 0; i < digits; i++) s += ri(r, 0, 9);
  return Number(s);
}

/** BCD 字符串: 保留前导零, 与 BCD 字节数严格对齐 */
function bcdString(r: () => number, digits: number): string {
  let s = '';
  for (let i = 0; i < digits; i++) s += ri(r, 0, 9);
  return s;
}

function asciiFill(r: () => number, len: number): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[ri(r, 0, chars.length - 1)];
  return s;
}

function gbkFill(r: () => number, charCount: number): string {
  // 常用汉字, TextEncoder 可编码为 GBK
  const han = '华东水务仪表园区清源计量监测智慧管网';
  let s = '';
  for (let i = 0; i < charCount; i++) s += han[ri(r, 0, han.length - 1)];
  return s;
}

/* ---------------- 各协议生成器 ---------------- */

function genP1(r: () => number): Record<string, unknown> {
  return {
    head: 0x68,
    addr: bcdString(r, 12),
    cmd: pick(r, [1, 2, 3]),
    energy: ri(r, 0, 5_000_000) * 0.01, // 展示值 kWh (raw*0.01, 精确)
    voltage: ri(r, 1800, 2600) * 0.1, // 展示值 V
  };
}

function genP2(r: () => number): Record<string, unknown> {
  return {
    head: Uint8Array.from([0xa5, 0x5a]),
    deviceId: ri(r, 1, 0xffffffff),
    status: {
      workMode: ri(r, 0, 2),
      doorOpen: ri(r, 0, 1),
      batteryLow: ri(r, 0, 1),
      reserved: ri(r, 0, 15),
    },
    temperature: ri(r, -400, 850) * 0.1,
    humidity: ri(r, 0, 1000) * 0.1,
    pressure: ri(r, -10000, 10000) * 0.01,
    battery: ri(r, 2800, 4200),
    seq: ri(r, 0, 65535),
  };
}

function genP3(r: () => number): Record<string, unknown> {
  return {
    head: Uint8Array.from([0x47, 0x50]),
    imei: bcdString(r, 10),
    lat: parseFloat((r() * 80 - 10).toFixed(6)),
    lon: parseFloat((r() * 140 - 70).toFixed(6)),
    speed: ri(r, 0, 12000) * 0.01,
    heading: ri(r, 0, 3600) * 0.1,
    altitude: ri(r, -500, 5000),
    fix: { fixType: ri(r, 0, 2), satellites: ri(r, 0, 31) },
    timestamp: ri(r, 1_700_000_000, 1_800_000_000),
  };
}

function genP4(r: () => number): Record<string, unknown> {
  const msgType = pick(r, [0, 1, 2, 3]);
  const v: Record<string, unknown> = {
    head: 0xeb,
    gwId: ri(r, 1, 65535),
    net: { rssi: ri(r, -110, -30), network: ri(r, 1, 3), cellId: ri(r, 1, 0xffffffff) },
    msgType,
  };
  if (msgType === 0) {
    v.reason = ri(r, 1, 3);
  } else {
    const n = ri(r, 1, 16);
    v.payloadLen = n;
    v.payload = Uint8Array.from({ length: n }, () => ri(r, 0, 255));
  }
  return v;
}

function genP5(r: () => number): Record<string, unknown> {
  const pinLen = ri(r, 0, 8);
  return {
    head: Uint8Array.from([0x10, 0x02]),
    doorId: ri(r, 1, 65535),
    event: ri(r, 1, 4),
    cardNo: asciiFill(r, 10),
    pinLen,
    pinDigits: Array.from({ length: pinLen }, () => ri(r, 0, 9)),
    result: ri(r, 0, 1),
    time: ri(r, 1_700_000_000, 1_800_000_000),
  };
}

function genP6(r: () => number): Record<string, unknown> {
  const present = [
    { name: 'temperature', make: () => ri(r, -400, 850) * 0.1 },
    { name: 'humidity', make: () => ri(r, 0, 1000) * 0.1 },
    { name: 'firmware', make: () => asciiFill(r, 6) },
    { name: 'config', make: () => Uint8Array.from({ length: 4 }, () => ri(r, 0, 255)) },
  ];
  // 每条报文随机出现 2-4 个 tag
  const shuffled = [...present].sort(() => r() - 0.5).slice(0, ri(r, 2, 4));
  const attrs: Record<string, unknown> = {};
  for (const p of shuffled) attrs[p.name] = p.make();
  return {
    head: Uint8Array.from([0x7e, 0x81]),
    nodeId: ri(r, 1, 65535),
    tlvCount: shuffled.length,
    attrs,
  };
}

function genP7(r: () => number): Record<string, unknown> {
  const n = ri(r, 1, 12);
  const samples = Array.from({ length: n }, (_, i) => ({
    ts: 1_700_000_000 + i * 10,
    axis: { x: ri(r, -32768, 32767), y: ri(r, -32768, 32767), z: ri(r, -32768, 32767) },
    amp: ri(r, 0, 10000) * 0.001,
  }));
  const chCount = ri(r, 1, 6);
  return {
    head: 0xaa,
    sensorId: ri(r, 1, 0xffffffff),
    sampleCount: n,
    samples,
    channels: Array.from({ length: chCount }, () => ri(r, 1, 16)),
  };
}

function genP8(r: () => number): Record<string, unknown> {
  const n = ri(r, 1, 16);
  const payload = Uint8Array.from({ length: n }, () => ri(r, 0, 255));
  return {
    head: 0xfb,
    deviceId: ri(r, 1, 65535),
    msgId: ri(r, 1, 65535),
    seq: 0, // 分片样本在分片测试中单独构造
    total: 1,
    payloadLen: n,
    payload,
  };
}

function genP8Inner(r: () => number): Record<string, unknown> {
  const n = ri(r, 1, 10);
  return {
    innerHead: 0x99,
    telemetryCount: n,
    items: Array.from({ length: n }, () => ({
      metricId: ri(r, 1, 20),
      value: ri(r, -100000, 100000) * 0.01,
    })),
  };
}

function genP9V1(r: () => number): Record<string, unknown> {
  return {
    head: 0xc0,
    devId: ri(r, 1, 65535),
    cmd: ri(r, 1, 3),
    param: ri(r, 0, 65535),
  };
}

function genP9V2(r: () => number): Record<string, unknown> {
  return {
    head: 0xc0,
    devId: ri(r, 1, 65535),
    zone: ri(r, 1, 20),
    cmd: ri(r, 1, 5),
    param: ri(r, 0, 0xffffffff),
  };
}

function genP10(r: () => number): Record<string, unknown> {
  const metrics: Record<string, unknown> = {
    flow: ri(r, 0, 1_000_000) * 0.001,
    reverseFlow: ri(r, 0, 10000),
    state: {
      valveOpen: ri(r, 0, 1),
      leak: ri(r, 0, 1),
      tamper: ri(r, 0, 1),
      battery: ri(r, 0, 3),
      reserved: ri(r, 0, 7),
    },
  };
  return {
    head: 0x77,
    meterNo: bcdString(r, 8),
    owner: gbkFill(r, 4),
    readings: { tlvCount: 3, metrics },
  };
}

/* ---------------- 统一入口 ---------------- */

interface GenSpec {
  /** 用于编码/解码的协议 id 与版本 (经 registry 展开继承链) */
  id: string;
  version: string;
  gen: (r: () => number) => Record<string, unknown>;
}

/** 全部协议定义注册到统一 registry, 处理版本继承 */
export function buildRegistry(): ProtocolRegistry {
  const registry = new ProtocolRegistry();
  for (const p of [
    P1_METER, P2_ENV, P3_GPS, P4_GW, P5_ACL,
    P6_TLV, P7_VIB, P8_FRAG, P8_INNER,
    P9_CTRL_V1, P9_CTRL_V2, P10_WATER,
  ]) {
    registry.upsert(p);
  }
  return registry;
}

export function getGenerators(): GenSpec[] {
  return [
    { id: P1_METER.id, version: '1.0', gen: genP1 },
    { id: P2_ENV.id, version: '1.0', gen: genP2 },
    { id: P3_GPS.id, version: '1.0', gen: genP3 },
    { id: P4_GW.id, version: '1.0', gen: genP4 },
    { id: P5_ACL.id, version: '1.0', gen: genP5 },
    { id: P6_TLV.id, version: '1.0', gen: genP6 },
    { id: P7_VIB.id, version: '1.0', gen: genP7 },
    { id: P8_FRAG.id, version: '1.0', gen: genP8 },
    { id: P9_CTRL_V1.id, version: '1.0', gen: genP9V1 },
    { id: P9_CTRL_V2.id, version: '2.0', gen: genP9V2 },
  ];
}

export function generateSamples(perProtocol = 10000, seedBase = 42): GeneratedSample[] {
  const registry = buildRegistry();
  const specs = getGenerators();
  const out: GeneratedSample[] = [];
  specs.forEach((spec, idx) => {
    const resolved = registry.get(spec.id, spec.version);
    const r = rng(seedBase + idx * 1009);
    const enc = new Encoder(resolved);
    for (let i = 0; i < perProtocol; i++) {
      const values = spec.gen(r);
      const frame = enc.encode(values);
      out.push({
        protocolId: spec.id,
        version: spec.version,
        hex: toHex(frame),
        expected: values,
      });
    }
  });
  return out;
}

export { P8_INNER, genP8Inner, P8_FRAG };
