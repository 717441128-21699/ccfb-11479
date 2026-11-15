/**
 * 测试数据生成器:为 10 种协议各生成 10000 条报文 + 期望解码结果。
 * 用固定种子的伪随机数,保证每次生成的数据完全一致。
 * 输出到 data/<protocolId>.json。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { derive, encodeMessage, encodeWithVersion, flattenValues } from '../core/encoder.js';
import { checksumDefaultEndian, checksumSize, type ProtocolDef } from '../core/types.js';
import { computeChecksum, readUint } from '../core/crc.js';
import { toHex } from '../core/decoder.js';
import {
  alarmPanel,
  envSensor,
  fragPayload,
  fragUplink,
  gpsTracker,
  modbusMeter,
  nestedArray,
  signedIndustrial,
  smartMeter,
  stringDevice,
  tlvSensor,
} from '../protocols/library.js';

const COUNT = 10000;
const outDir = join(dirname(fileURLToPath(import.meta.url)), '../../data');

/** mulberry32 伪随机数,确定性 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

function randint(r: Rng, min: number, max: number): number {
  return min + Math.floor(r() * (max - min + 1));
}

function pick<T>(r: Rng, arr: T[]): T {
  return arr[Math.floor(r() * arr.length)];
}

/** 生成带 scale 的工程值:先取原始整数,再乘系数并按系数位数圆整 */
function scaled(r: Rng, scale: number, rawMin: number, rawMax: number): number {
  const raw = randint(r, rawMin, rawMax);
  const decimals = Math.max(0, -Math.floor(Math.log10(scale)));
  return Number((raw * scale).toFixed(decimals));
}

function hexRandom(r: Rng, bytes: number): string {
  let s = '';
  for (let i = 0; i < bytes; i++) s += randint(r, 0, 255).toString(16).padStart(2, '0');
  return s;
}

function digits(r: Rng, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += String(randint(r, 0, 9));
  return s;
}

const NAMES = ['水泵房1号', 'temp-sensor', '配电柜A相', 'roof-01', '车间东门的表', 'AHU-3F-02', '冷库7号机组', 'gateway'];

// ---------- 各协议的随机值生成器 ----------

function genModbusMeter(r: Rng): Record<string, unknown> {
  const regCount = randint(r, 1, 8);
  return {
    header: '55aa',
    addr: randint(r, 1, 247),
    func: pick(r, [3, 4, 16]),
    seq: randint(r, 0, 65535),
    regs: Array.from({ length: regCount }, () => scaled(r, 0.1, 0, 50000)),
  };
}

function genGpsTracker(r: Rng): Record<string, unknown> {
  return {
    header: '7e',
    deviceId: randint(r, 0, 0xffffffff),
    latitude: scaled(r, 1e-7, -900000000, 900000000),
    longitude: scaled(r, 1e-7, -1800000000, 1800000000),
    speed: scaled(r, 0.01, 0, 12000),
    course: scaled(r, 0.1, 0, 3600),
    status: {
      gpsValid: randint(r, 0, 1),
      charging: randint(r, 0, 1),
      alarm: randint(r, 0, 3),
      mode: randint(r, 0, 15),
    },
    timestamp:
      String(randint(r, 0, 99)).padStart(2, '0') +
      String(randint(r, 1, 12)).padStart(2, '0') +
      String(randint(r, 1, 28)).padStart(2, '0') +
      String(randint(r, 0, 23)).padStart(2, '0') +
      String(randint(r, 0, 59)).padStart(2, '0') +
      String(randint(r, 0, 59)).padStart(2, '0'),
  };
}

function genTlvSensor(r: Rng): Record<string, unknown> {
  const items: Record<string, unknown>[] = [
    { type: 1, temperature: scaled(r, 0.1, -200, 600) },
  ];
  if (r() < 0.7) items.push({ type: 2, humidity: scaled(r, 0.1, 0, 1000) });
  if (r() < 0.6) {
    const env: Record<string, unknown>[] = [{ type: 1, pm25: randint(r, 0, 500) }];
    if (r() < 0.5) env.push({ type: 2, co2: randint(r, 400, 5000) });
    items.push({ type: 3, env });
  }
  if (r() < 0.4) items.push({ type: 4, sn: hexRandom(r, 4) });
  return { header: 'ab', version: 1, items };
}

function genSmartMeter(r: Rng): Record<string, unknown> {
  return {
    header: '68',
    meterId: digits(r, 12),
    energy: scaled(r, 0.01, 0, 99999999),
    tariff: randint(r, 1, 4),
    voltage: scaled(r, 0.1, 1800, 2600),
  };
}

function genAlarmPanel(r: Rng): Record<string, unknown> {
  const eventCount = randint(r, 0, 5);
  return {
    header: 'eb90',
    zones: {
      zoneGroupA: randint(r, 0, 15),
      zoneGroupB: randint(r, 0, 15),
      zoneGroupC: randint(r, 0, 15),
      zoneGroupD: randint(r, 0, 15),
    },
    events: Array.from({ length: eventCount }, () => ({
      type: randint(r, 1, 4),
      zone: randint(r, 1, 16),
      timeOffset: randint(r, 0, 65535),
    })),
  };
}

function genEnvSensor(r: Rng): { version: string; values: Record<string, unknown> } {
  const version = r() < 0.5 ? '1' : '2';
  const values: Record<string, unknown> = {
    header: '55',
    version: Number(version),
    temperature:
      version === '1' ? scaled(r, 0.1, -400, 850) : scaled(r, 0.01, -4000, 8500),
    humidity: scaled(r, 0.1, 0, 1000),
    battery: randint(r, 0, 100),
  };
  if (version === '2') values.pm25 = randint(r, 0, 500);
  return { version, values };
}

function genFragPayloadInner(r: Rng): Record<string, unknown> {
  return {
    deviceId: randint(r, 1, 65535),
    timestamp: randint(r, 1700000000, 1800000000),
    samples: [scaled(r, 0.1, -300, 800), scaled(r, 0.1, -300, 800), scaled(r, 0.1, -300, 800)],
  };
}

function genStringDevice(r: Rng): Record<string, unknown> {
  return {
    header: '33',
    imei: digits(r, 15),
    devName: pick(r, NAMES),
    msgId: randint(r, 0, 0x7fffffff),
  };
}

function genSignedIndustrial(r: Rng): Record<string, unknown> {
  return {
    header: '99',
    ambient: randint(r, -40, 85),
    probe: scaled(r, 0.1, -400, 1200),
    compensated: scaled(r, 0.01, -4000, 12000),
    pressure: scaled(r, 0.001, 0, 16000000),
    alarms: {
      critical: randint(r, 0, 1),
      warning: randint(r, 0, 1),
      code: randint(r, 0, 63),
    },
  };
}

function genNestedArray(r: Rng): Record<string, unknown> {
  const channelCount = randint(r, 1, 4);
  return {
    header: 'cb',
    channels: Array.from({ length: channelCount }, () => ({
      id: randint(r, 1, 8),
      samples: [scaled(r, 0.1, -300, 800), scaled(r, 0.1, -300, 800), scaled(r, 0.1, -300, 800)],
      gain: scaled(r, 0.1, 0, 255),
    })),
  };
}

// ---------- 生成主流程 ----------

interface MessageFile {
  protocolId: string;
  fragmented: boolean;
  messages: { hex?: string; frames?: string[]; expected: Record<string, unknown> }[];
}

function expectedWithChecksum(
  proto: ProtocolDef,
  versionIdx: number,
  values: Record<string, unknown>,
  frame: Uint8Array,
): Record<string, unknown> {
  const version = proto.versions[versionIdx];
  // 期望值要包含自动推导出的长度/个数字段,先复制一份再推导
  const scope = structuredClone(values);
  derive(version.fields, scope);
  const expected = flattenValues(version.fields, scope);
  if (version.checksum) {
    const alg = version.checksum.algorithm;
    const size = checksumSize(alg);
    const endian = version.checksum.endian ?? checksumDefaultEndian(alg);
    expected['checksum'] = readUint(frame, frame.length - size, size, endian);
  }
  return expected;
}

function writeProtocol(file: MessageFile): void {
  const path = join(outDir, `${file.protocolId}.json`);
  writeFileSync(path, JSON.stringify(file));
  console.log(`${file.protocolId}: ${file.messages.length} 条 -> ${path}`);
}

function generateSimple(
  proto: ProtocolDef,
  gen: (r: Rng) => Record<string, unknown>,
  seed: number,
): void {
  const r = rng(seed);
  const messages: MessageFile['messages'] = [];
  for (let i = 0; i < COUNT; i++) {
    const values = gen(r);
    const frame = encodeMessage(proto, values);
    messages.push({ hex: toHex(frame), expected: expectedWithChecksum(proto, 0, values, frame) });
  }
  writeProtocol({ protocolId: proto.id, fragmented: false, messages });
}

function generateEnvSensor(seed: number): void {
  const r = rng(seed);
  const messages: MessageFile['messages'] = [];
  for (let i = 0; i < COUNT; i++) {
    const { version, values } = genEnvSensor(r);
    const vIdx = envSensor.versions.findIndex((v) => v.version === version);
    const frame = encodeWithVersion(envSensor.versions[vIdx], values);
    messages.push({ hex: toHex(frame), expected: expectedWithChecksum(envSensor, vIdx, values, frame) });
  }
  writeProtocol({ protocolId: envSensor.id, fragmented: false, messages });
}

function generateFragUplink(seed: number): void {
  const r = rng(seed);
  const messages: MessageFile['messages'] = [];
  for (let i = 0; i < COUNT; i++) {
    const inner = genFragPayloadInner(r);
    const payload = encodeMessage(fragPayload, inner);
    const total = randint(r, 2, 4);
    // 把负载切成 total 片
    const parts: Uint8Array[] = [];
    const base = Math.floor(payload.length / total);
    for (let p = 0; p < total; p++) {
      const start = p * base;
      const end = p === total - 1 ? payload.length : start + base;
      parts.push(payload.subarray(start, end));
    }
    const session = randint(r, 1, 65535);
    const frames = parts.map((part, seq) => {
      const frameValues = {
        header: 'f1',
        session,
        seq,
        total,
        payload: toHex(part),
      };
      return toHex(encodeMessage(fragUplink, frameValues));
    });
    const expected = flattenValues(fragPayload.versions[0].fields, inner);
    messages.push({ frames, expected });
  }
  writeProtocol({ protocolId: fragUplink.id, fragmented: true, messages });
}

mkdirSync(outDir, { recursive: true });
generateSimple(modbusMeter, genModbusMeter, 101);
generateSimple(gpsTracker, genGpsTracker, 102);
generateSimple(tlvSensor, genTlvSensor, 103);
generateSimple(smartMeter, genSmartMeter, 104);
generateSimple(alarmPanel, genAlarmPanel, 105);
generateEnvSensor(106);
generateFragUplink(107);
generateSimple(stringDevice, genStringDevice, 108);
generateSimple(signedIndustrial, genSignedIndustrial, 109);
generateSimple(nestedArray, genNestedArray, 110);
console.log('全部生成完毕');
