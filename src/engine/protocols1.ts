import type { ProtocolDef } from './types';

/**
 * 协议 1-5: 偏定长结构, 覆盖大小端/BCD/位域/有符号/缩放/CRC32/累加和。
 */

/* ---------- P1 智能电表 (大端 + BCD + CRC16-Modbus) ---------- */
export const P1_METER: ProtocolDef = {
  id: 'P1-METER',
  name: '智能电表协议',
  vendor: '华电',
  version: '1.0',
  endian: 'be',
  frame: { magic: [0x68], minSize: 16, maxSize: 16 },
  fields: [
    { name: 'head', type: 'uint', size: 1, description: '帧头 0x68' },
    { name: 'addr', type: 'bcd', size: 6, description: '表号 BCD12 位' },
    { name: 'cmd', type: 'enum', size: 1, mapping: { '1': '读数据', '2': '写参数', '3': '事件上报' } },
    { name: 'energy', type: 'uint', size: 4, scale: 0.01, units: 'kWh' },
    { name: 'voltage', type: 'uint', size: 2, scale: 0.1, units: 'V' },
    { name: 'crc', type: 'crc', size: 2, crc: { algo: 'crc16-modbus', endian: 'le' } },
  ],
};

/* ---------- P2 环境传感器 (小端 + 有符号 + 位域) ---------- */
export const P2_ENV: ProtocolDef = {
  id: 'P2-ENV',
  name: '环境传感协议',
  vendor: '绿感',
  version: '1.0',
  endian: 'le',
  frame: { magic: [0xa5, 0x5a], minSize: 21, maxSize: 21 },
  fields: [
    { name: 'head', type: 'bytes', length: 2 },
    { name: 'deviceId', type: 'uint', size: 4 },
    {
      name: 'status',
      type: 'bits',
      size: 1,
      bitOrder: 'msb',
      children: [
        { name: 'workMode', bits: 2, mapping: { '0': '正常', '1': '省电', '2': '校准' } },
        { name: 'doorOpen', bits: 1 },
        { name: 'batteryLow', bits: 1 },
        { name: 'reserved', bits: 4 },
      ],
    },
    { name: 'temperature', type: 'int', size: 2, scale: 0.1, units: '℃' },
    { name: 'humidity', type: 'uint', size: 2, scale: 0.1, units: '%RH' },
    { name: 'pressure', type: 'int', size: 4, scale: 0.01, units: 'Pa' },
    { name: 'battery', type: 'uint', size: 2, units: 'mV' },
    { name: 'seq', type: 'uint', size: 2 },
    { name: 'crc', type: 'crc', size: 2, crc: { algo: 'crc16-ccitt' } },
  ],
};

/* ---------- P3 GPS 定位器 (混合大小端 + 浮点 + 位域) ---------- */
export const P3_GPS: ProtocolDef = {
  id: 'P3-GPS',
  name: 'GPS 定位协议',
  vendor: '北斗星',
  version: '1.0',
  endian: 'be',
  frame: { magic: [0x47, 0x50], minSize: 30, maxSize: 30 },
  fields: [
    { name: 'head', type: 'bytes', length: 2 },
    { name: 'imei', type: 'bcd', size: 5, description: 'IMEI 后 10 位' },
    { name: 'lat', type: 'float', size: 4, endian: 'be', units: '°' },
    { name: 'lon', type: 'float', size: 4, endian: 'le', units: '°' },
    { name: 'speed', type: 'uint', size: 2, endian: 'le', scale: 0.01, units: 'km/h' },
    { name: 'heading', type: 'uint', size: 2, scale: 0.1, units: '°' },
    { name: 'altitude', type: 'int', size: 2, endian: 'le', units: 'm' },
    {
      name: 'fix',
      type: 'bits',
      size: 1,
      bitOrder: 'lsb',
      children: [
        { name: 'fixType', bits: 3, mapping: { '0': '无定位', '1': '2D', '2': '3D' } },
        { name: 'satellites', bits: 5 },
      ],
    },
    { name: 'timestamp', type: 'uint', size: 4 },
    { name: 'crc', type: 'crc', size: 4, crc: { algo: 'crc32', endian: 'be' } },
  ],
};

/* ---------- P4 工业网关 (嵌套 struct + 条件字段) ---------- */
export const P4_GW: ProtocolDef = {
  id: 'P4-GW',
  name: '工业网关协议',
  vendor: '智联',
  version: '1.0',
  endian: 'be',
  frame: { magic: [0xeb], minSize: 1, maxSize: 64 },
  fields: [
    { name: 'head', type: 'uint', size: 1 },
    { name: 'gwId', type: 'uint', size: 2 },
    {
      name: 'net',
      type: 'struct',
      fields: [
        { name: 'rssi', type: 'int', size: 1, units: 'dBm' },
        { name: 'network', type: 'enum', size: 1, mapping: { '1': '4G', '2': 'NB-IoT', '3': 'LoRa' } },
        { name: 'cellId', type: 'uint', size: 4 },
      ],
    },
    { name: 'msgType', type: 'uint', size: 1 },
    { name: 'payloadLen', type: 'uint', size: 1 },
    {
      name: 'payload',
      type: 'bytes',
      lengthOf: { field: 'payloadLen' },
      when: '$msgType != 0',
    },
    {
      name: 'reason',
      type: 'enum',
      size: 1,
      mapping: { '1': '心跳超时', '2': '远程重启', '3': '升级' },
      when: '$msgType == 0',
    },
    { name: 'crc', type: 'crc', size: 1, crc: { algo: 'checksum8' } },
  ],
};

/* ---------- P5 门禁控制器 (字符串 + 数组 + CRC16) ---------- */
export const P5_ACL: ProtocolDef = {
  id: 'P5-ACL',
  name: '门禁控制协议',
  vendor: '守门',
  version: '1.0',
  endian: 'be',
  frame: { magic: [0x10, 0x02], minSize: 1, maxSize: 128 },
  fields: [
    { name: 'head', type: 'bytes', length: 2 },
    { name: 'doorId', type: 'uint', size: 2 },
    { name: 'event', type: 'enum', size: 1, mapping: { '1': '刷卡', '2': '密码', '3': '远程开门', '4': '报警' } },
    { name: 'cardNo', type: 'string', size: 10, length: 10, encoding: 'ascii' },
    { name: 'pinLen', type: 'uint', size: 1 },
    {
      name: 'pinDigits',
      type: 'array',
      countOf: 'pinLen',
      element: { name: 'digit', type: 'uint', size: 1 },
    },
    { name: 'result', type: 'bool', size: 1 },
    { name: 'time', type: 'uint', size: 4 },
    { name: 'crc', type: 'crc', size: 2, crc: { algo: 'crc16-ccitt', init: 0xffff } },
  ],
};

export const PROTOCOLS_1_5 = [P1_METER, P2_ENV, P3_GPS, P4_GW, P5_ACL];
