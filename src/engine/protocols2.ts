import type { ProtocolDef } from './types';

/* ---------- P6 TLV 传感节点 (TLV 嵌套 + 未知 tag 容错 + 累加和16) ---------- */
export const P6_TLV: ProtocolDef = {
  id: 'P6-TLV',
  name: 'TLV 传感协议',
  vendor: '微感',
  version: '1.0',
  endian: 'be',
  frame: { magic: [0x7e, 0x81], minSize: 4, maxSize: 256 },
  fields: [
    { name: 'head', type: 'bytes', length: 2 },
    { name: 'nodeId', type: 'uint', size: 2 },
    { name: 'tlvCount', type: 'uint', size: 1, description: '后续 TLV 条目数' },
    {
      name: 'attrs',
      type: 'tlv',
      tlv: {
        countField: 'tlvCount',
        tag: { size: 1 },
        length: { size: 1 },
        unknown: 'raw',
        tags: [
          { name: 'temperature', tag: 0x01, type: 'int', size: 2, scale: 0.1, units: '℃' },
          { name: 'humidity', tag: 0x02, type: 'uint', size: 2, scale: 0.1, units: '%RH' },
          { name: 'firmware', tag: 0x03, type: 'string', length: 6, encoding: 'ascii' },
          { name: 'config', tag: 0x10, type: 'bytes', length: 4 },
        ],
      },
    },
    { name: 'checksum', type: 'crc', size: 2, crc: { algo: 'checksum16' } },
  ],
};

/* ---------- P7 振动监测 (定长结构数组 + 终止符数组) ---------- */
export const P7_VIB: ProtocolDef = {
  id: 'P7-VIB',
  name: '振动监测协议',
  vendor: '磐石',
  version: '1.0',
  endian: 'le',
  frame: { magic: [0xaa], minSize: 1, maxSize: 512 },
  fields: [
    { name: 'head', type: 'uint', size: 1 },
    { name: 'sensorId', type: 'uint', size: 4 },
    { name: 'sampleCount', type: 'uint', size: 1 },
    {
      name: 'samples',
      type: 'array',
      countOf: 'sampleCount',
      element: {
        name: 'sample',
        type: 'struct',
        fields: [
          { name: 'ts', type: 'uint', size: 4 },
          {
            name: 'axis',
            type: 'struct',
            fields: [
              { name: 'x', type: 'int', size: 2 },
              { name: 'y', type: 'int', size: 2 },
              { name: 'z', type: 'int', size: 2 },
            ],
          },
          { name: 'amp', type: 'uint', size: 2, scale: 0.001, units: 'g' },
        ],
      },
    },
    {
      name: 'channels',
      type: 'array',
      terminator: 0x00,
      element: { name: 'ch', type: 'uint', size: 1 },
    },
    { name: 'crc', type: 'crc', size: 1, crc: { algo: 'checksum8' } },
  ],
};

/* ---------- P8 分片上报协议 + 重组内层协议 ---------- */
export const P8_FRAG: ProtocolDef = {
  id: 'P8-FRAG',
  name: '分片上报协议',
  vendor: '汇流',
  version: '1.0',
  endian: 'be',
  frame: { magic: [0xfb], minSize: 8, maxSize: 128 },
  fields: [
    { name: 'head', type: 'uint', size: 1 },
    { name: 'deviceId', type: 'uint', size: 2 },
    { name: 'msgId', type: 'uint', size: 2 },
    { name: 'seq', type: 'uint', size: 1 },
    { name: 'total', type: 'uint', size: 1 },
    { name: 'payloadLen', type: 'uint', size: 1 },
    { name: 'payload', type: 'bytes', lengthOf: { field: 'payloadLen' } },
    { name: 'crc', type: 'crc', size: 2, crc: { algo: 'crc16-modbus' } },
  ],
  reassembly: {
    seqField: 'seq',
    totalField: 'total',
    groupKeyFields: ['deviceId', 'msgId'],
    payloadField: 'payload',
    innerProtocol: 'P8-INNER',
  },
};

export const P8_INNER: ProtocolDef = {
  id: 'P8-INNER',
  name: '分片内层遥测协议',
  vendor: '汇流',
  version: '1.0',
  endian: 'be',
  frame: { magic: [0x99], minSize: 2, maxSize: 512 },
  fields: [
    { name: 'innerHead', type: 'uint', size: 1 },
    { name: 'telemetryCount', type: 'uint', size: 1 },
    {
      name: 'items',
      type: 'array',
      countOf: 'telemetryCount',
      element: {
        name: 'item',
        type: 'struct',
        fields: [
          { name: 'metricId', type: 'uint', size: 1 },
          { name: 'value', type: 'int', size: 4, scale: 0.01 },
        ],
      },
    },
    { name: 'checksum', type: 'crc', size: 1, crc: { algo: 'checksum8' } },
  ],
};

/* ---------- P9 版本化控制协议: v1 与 v2 共存 ---------- */
export const P9_CTRL_V1: ProtocolDef = {
  id: 'P9-CTRL',
  name: '远程控制协议',
  vendor: '云控',
  version: '1.0',
  endian: 'be',
  frame: { magic: [0xc0], minSize: 7, maxSize: 7 },
  fields: [
    { name: 'head', type: 'uint', size: 1 },
    { name: 'devId', type: 'uint', size: 2 },
    { name: 'cmd', type: 'enum', size: 1, mapping: { '1': '开机', '2': '关机', '3': '重启' } },
    { name: 'param', type: 'uint', size: 2 },
    { name: 'crc', type: 'crc', size: 1, crc: { algo: 'checksum8' } },
  ],
};

export const P9_CTRL_V2: ProtocolDef = {
  id: 'P9-CTRL',
  name: '远程控制协议',
  vendor: '云控',
  version: '2.0',
  basedOn: '1.0',
  endian: 'be',
  frame: { magic: [0xc0], minSize: 10, maxSize: 10 },
  fields: [
    // 在 devId 之后插入 zone; cmd 枚举扩展, param 由 2 字节扩为 4 字节
    { name: 'zone', type: 'uint', size: 1 },
    {
      name: 'cmd',
      type: 'enum',
      size: 1,
      mapping: { '1': '开机', '2': '关机', '3': '重启', '4': '固件升级', '5': '配置下发' },
    },
    { name: 'param', type: 'uint', size: 4 },
  ],};

/* ---------- P10 水务综合协议 (GBK + struct 内嵌 TLV + 位域 + CRC32-LE) ---------- */
export const P10_WATER: ProtocolDef = {
  id: 'P10-WATER',
  name: '水务计量协议',
  vendor: '清源',
  version: '1.0',
  endian: 'le',
  frame: { magic: [0x77], minSize: 1, maxSize: 256 },
  fields: [
    { name: 'head', type: 'uint', size: 1 },
    { name: 'meterNo', type: 'bcd', size: 4 },
    { name: 'owner', type: 'string', size: 8, length: 8, encoding: 'gbk' },
    {
      name: 'readings',
      type: 'struct',
      fields: [
        { name: 'tlvCount', type: 'uint', size: 1 },
        {
          name: 'metrics',
          type: 'tlv',
          tlv: {
            countField: 'tlvCount',
            tag: { size: 1 },
            length: { size: 1 },
            tags: [
              { name: 'flow', tag: 0x01, type: 'uint', size: 4, scale: 0.001, units: 'm³' },
              { name: 'reverseFlow', tag: 0x02, type: 'uint', size: 4 },
              {
                name: 'state',
                tag: 0x03,
                type: 'bits',
                size: 1,
                bitOrder: 'msb',
                children: [
                  { name: 'valveOpen', bits: 1 },
                  { name: 'leak', bits: 1 },
                  { name: 'tamper', bits: 1 },
                  { name: 'battery', bits: 2, mapping: { '0': '满', '1': '良', '2': '低', '3': '告警' } },
                  { name: 'reserved', bits: 3 },
                ],
              },
            ],
          },
        },
      ],
    },
    { name: 'crc', type: 'crc', size: 4, crc: { algo: 'crc32', endian: 'le' } },
  ],
};

export const PROTOCOLS_6_10 = [P6_TLV, P7_VIB, P8_FRAG, P8_INNER, P9_CTRL_V1, P9_CTRL_V2, P10_WATER];
