/**
 * 内置协议库:10 种风格各异的私有协议,覆盖
 * 定长/变长/TLV 嵌套/位域/数组/BCD/有符号/缩放/大小端混排/多种校验/分包/多版本。
 */

import type { ProtocolDef } from '../core/types.js';

/** 1. Modbus 风格电表:大端定长 + 计数前缀数组 + CRC16-Modbus(小端存储) */
export const modbusMeter: ProtocolDef = {
  id: 'modbus-meter',
  name: 'Modbus 电表',
  description: '大端固定头 + 寄存器数组 + CRC16-Modbus',
  versions: [
    {
      version: '1',
      fields: [
        { kind: 'bytes', name: 'header', label: '帧头', length: 2 },
        { kind: 'uint', name: 'addr', label: '站地址', bits: 8 },
        {
          kind: 'uint',
          name: 'func',
          label: '功能码',
          bits: 8,
          enum: { '3': '读保持寄存器', '4': '读输入寄存器', '16': '写多寄存器' },
        },
        { kind: 'uint', name: 'seq', label: '序号', bits: 16, endian: 'big' },
        { kind: 'uint', name: 'regCount', label: '寄存器数', bits: 8 },
        {
          kind: 'array',
          name: 'regs',
          label: '寄存器',
          countFrom: 'regCount',
          element: { kind: 'uint', name: 'reg', bits: 16, endian: 'big', scale: 0.1, unit: 'kWh' },
        },
      ],
      checksum: { algorithm: 'crc16-modbus' },
    },
  ],
};

/** 2. GPS 定位终端:小端有符号缩放 + 位域 + BCD 时间 + CRC16-CCITT */
export const gpsTracker: ProtocolDef = {
  id: 'gps-tracker',
  name: 'GPS 定位终端',
  description: '小端有符号坐标 + 状态位域 + BCD 时间戳 + CRC16-CCITT-FALSE',
  versions: [
    {
      version: '1',
      fields: [
        { kind: 'bytes', name: 'header', label: '帧头', length: 1 },
        { kind: 'uint', name: 'deviceId', label: '设备 ID', bits: 32, endian: 'little' },
        { kind: 'int', name: 'latitude', label: '纬度', bits: 32, endian: 'little', scale: 1e-7, unit: '°' },
        { kind: 'int', name: 'longitude', label: '经度', bits: 32, endian: 'little', scale: 1e-7, unit: '°' },
        { kind: 'uint', name: 'speed', label: '速度', bits: 16, endian: 'little', scale: 0.01, unit: 'km/h' },
        { kind: 'uint', name: 'course', label: '航向', bits: 16, endian: 'little', scale: 0.1, unit: '°' },
        {
          kind: 'bits',
          name: 'status',
          label: '状态字',
          bytes: 1,
          bitOrder: 'lsb',
          fields: [
            { name: 'gpsValid', bits: 1, label: '定位有效', enum: { '0': '无效', '1': '有效' } },
            { name: 'charging', bits: 1, label: '充电中' },
            { name: 'alarm', bits: 2, label: '报警类型', enum: { '0': '无', '1': '超速', '2': '围栏', '3': '低电' } },
            { name: 'mode', bits: 4, label: '工作模式' },
          ],
        },
        { kind: 'bcd', name: 'timestamp', label: '时间戳', bytes: 6 },
      ],
      checksum: { algorithm: 'crc16-ccitt-false' },
    },
  ],
};

/** 3. TLV 环境传感器:TLV 嵌套 TLV + 累加和校验 */
export const tlvSensor: ProtocolDef = {
  id: 'tlv-sensor',
  name: 'TLV 环境传感器',
  description: 'TLV 结构,环境组内嵌套子 TLV,sum8 校验',
  versions: [
    {
      version: '1',
      fields: [
        { kind: 'bytes', name: 'header', label: '帧头', length: 1 },
        { kind: 'uint', name: 'version', label: '版本', bits: 8 },
        {
          kind: 'tlv',
          name: 'items',
          label: 'TLV 项',
          typeBytes: 1,
          lengthBytes: 1,
          types: {
            '1': {
              name: '温度',
              fields: [{ kind: 'int', name: 'temperature', bits: 16, endian: 'big', scale: 0.1, unit: '℃' }],
            },
            '2': {
              name: '湿度',
              fields: [{ kind: 'uint', name: 'humidity', bits: 16, endian: 'big', scale: 0.1, unit: '%RH' }],
            },
            '3': {
              name: '环境组',
              fields: [
                {
                  kind: 'tlv',
                  name: 'env',
                  label: '子 TLV',
                  typeBytes: 1,
                  lengthBytes: 1,
                  types: {
                    '1': { name: 'PM2.5', fields: [{ kind: 'uint', name: 'pm25', bits: 16, endian: 'big', unit: 'µg/m³' }] },
                    '2': { name: 'CO2', fields: [{ kind: 'uint', name: 'co2', bits: 16, endian: 'big', unit: 'ppm' }] },
                  },
                },
              ],
            },
            '4': {
              name: '设备序列号',
              fields: [{ kind: 'bytes', name: 'sn', length: 4 }],
            },
          },
        },
      ],
      checksum: { algorithm: 'sum8' },
    },
  ],
};

/** 4. 智能电表(DL/T 645 风格):BCD 为主 + CRC32(小端存储) */
export const smartMeter: ProtocolDef = {
  id: 'smart-meter',
  name: '智能电表',
  description: 'BCD 表号/电量 + 费率枚举 + CRC32-IEEE 小端存储',
  versions: [
    {
      version: '1',
      fields: [
        { kind: 'bytes', name: 'header', label: '帧头', length: 1 },
        { kind: 'bcd', name: 'meterId', label: '表号', bytes: 6 },
        { kind: 'bcd', name: 'energy', label: '正向有功总电能', bytes: 4, scale: 0.01, unit: 'kWh' },
        {
          kind: 'uint',
          name: 'tariff',
          label: '当前费率',
          bits: 8,
          enum: { '1': '尖', '2': '峰', '3': '平', '4': '谷' },
        },
        { kind: 'uint', name: 'voltage', label: '电压', bits: 16, endian: 'little', scale: 0.1, unit: 'V' },
      ],
      checksum: { algorithm: 'crc32-ieee', endian: 'little' },
    },
  ],
};

/** 5. 报警主机:多字节位域 + 事件数组 + 异或校验 */
export const alarmPanel: ProtocolDef = {
  id: 'alarm-panel',
  name: '报警主机',
  description: '16 位防区位域 + 计数前缀事件数组 + XOR8 校验',
  versions: [
    {
      version: '1',
      fields: [
        { kind: 'bytes', name: 'header', label: '帧头', length: 2 },
        {
          kind: 'bits',
          name: 'zones',
          label: '防区状态',
          bytes: 2,
          endian: 'big',
          bitOrder: 'lsb',
          fields: [
            { name: 'zoneGroupA', bits: 4, label: '防区 1-4' },
            { name: 'zoneGroupB', bits: 4, label: '防区 5-8' },
            { name: 'zoneGroupC', bits: 4, label: '防区 9-12' },
            { name: 'zoneGroupD', bits: 4, label: '防区 13-16' },
          ],
        },
        { kind: 'uint', name: 'eventCount', label: '事件数', bits: 8 },
        {
          kind: 'array',
          name: 'events',
          label: '事件',
          countFrom: 'eventCount',
          element: {
            kind: 'group',
            name: 'event',
            fields: [
              {
                kind: 'uint',
                name: 'type',
                bits: 8,
                enum: { '1': '入侵', '2': '火警', '3': '故障', '4': '恢复' },
              },
              { kind: 'uint', name: 'zone', bits: 8 },
              { kind: 'uint', name: 'timeOffset', bits: 16, endian: 'little', unit: 's' },
            ],
          },
        },
      ],
      checksum: { algorithm: 'xor8' },
    },
  ],
};

/** 6. 环境监测仪:多版本协议,v2 增加 PM2.5 并修改温度分辨率 */
export const envSensor: ProtocolDef = {
  id: 'env-sensor',
  name: '环境监测仪',
  description: '多版本:v1 温湿度+电量;v2 增加 PM2.5,温度分辨率提高到 0.01℃',
  versions: [
    {
      version: '1',
      match: [{ path: 'version', equals: 1 }],
      fields: [
        { kind: 'bytes', name: 'header', label: '帧头', length: 1 },
        { kind: 'uint', name: 'version', label: '版本', bits: 8 },
        { kind: 'int', name: 'temperature', label: '温度', bits: 16, endian: 'big', scale: 0.1, unit: '℃' },
        { kind: 'uint', name: 'humidity', label: '湿度', bits: 16, endian: 'big', scale: 0.1, unit: '%RH' },
        { kind: 'uint', name: 'battery', label: '电量', bits: 8, unit: '%' },
      ],
      checksum: { algorithm: 'sum8' },
    },
    {
      version: '2',
      match: [{ path: 'version', equals: 2 }],
      fields: [
        { kind: 'bytes', name: 'header', label: '帧头', length: 1 },
        { kind: 'uint', name: 'version', label: '版本', bits: 8 },
        { kind: 'int', name: 'temperature', label: '温度', bits: 16, endian: 'big', scale: 0.01, unit: '℃' },
        { kind: 'uint', name: 'humidity', label: '湿度', bits: 16, endian: 'big', scale: 0.1, unit: '%RH' },
        { kind: 'uint', name: 'battery', label: '电量', bits: 8, unit: '%' },
        { kind: 'uint', name: 'pm25', label: 'PM2.5', bits: 16, endian: 'big', unit: 'µg/m³' },
      ],
      checksum: { algorithm: 'sum8' },
    },
  ],
};

/** 7. 分片上行通道:大报文拆片传输,按序号重组 */
export const fragUplink: ProtocolDef = {
  id: 'frag-uplink',
  name: '分片上行帧',
  description: '会话+序号+总数分片传输,sum8 校验,拼回后按 frag-payload 解码',
  versions: [
    {
      version: '1',
      fields: [
        { kind: 'bytes', name: 'header', label: '帧头', length: 1 },
        { kind: 'uint', name: 'session', label: '会话号', bits: 16, endian: 'big' },
        { kind: 'uint', name: 'seq', label: '分片序号', bits: 8 },
        { kind: 'uint', name: 'total', label: '分片总数', bits: 8 },
        { kind: 'rest', name: 'payload', label: '分片负载' },
      ],
      checksum: { algorithm: 'sum8' },
      fragment: {
        session: 'session',
        seq: 'seq',
        total: 'total',
        payload: 'payload',
        seqBase: 0,
        innerProtocolId: 'frag-payload',
      },
    },
  ],
};

/** 7b. 分片重组后的完整负载 */
export const fragPayload: ProtocolDef = {
  id: 'frag-payload',
  name: '分片负载(完整报文)',
  description: '重组后的完整应用报文:设备号+时间戳+3 通道采样',
  versions: [
    {
      version: '1',
      fields: [
        { kind: 'uint', name: 'deviceId', label: '设备号', bits: 16, endian: 'big' },
        { kind: 'uint', name: 'timestamp', label: '时间戳', bits: 32, endian: 'big' },
        {
          kind: 'array',
          name: 'samples',
          label: '采样',
          count: 3,
          element: { kind: 'int', name: 'sample', bits: 16, endian: 'little', scale: 0.1, unit: '℃' },
        },
      ],
    },
  ],
};

/** 8. 字符串设备:变长 UTF-8 字符串 + 64 位序号 + XOR8 */
export const stringDevice: ProtocolDef = {
  id: 'string-device',
  name: '字符串设备',
  description: '长度前缀变长字符串 + ASCII IMEI + uint64 序号 + XOR8',
  versions: [
    {
      version: '1',
      fields: [
        { kind: 'bytes', name: 'header', label: '帧头', length: 1 },
        { kind: 'bytes', name: 'imei', label: 'IMEI', length: 15, encoding: 'ascii' },
        { kind: 'uint', name: 'nameLen', label: '名称长度', bits: 8 },
        { kind: 'bytes', name: 'devName', label: '设备名', lengthFrom: 'nameLen', encoding: 'utf8' },
        { kind: 'uint', name: 'msgId', label: '消息序号', bits: 64, endian: 'big' },
      ],
      checksum: { algorithm: 'xor8' },
    },
  ],
};

/** 9. 工业变送器:混合有符号数 + 24 位无符号 + MSB 位域 + sum16 */
export const signedIndustrial: ProtocolDef = {
  id: 'signed-industrial',
  name: '工业变送器',
  description: 'int8/int16LE/int32BE 混合 + uint24 + MSB 优先位域 + sum16 大端',
  versions: [
    {
      version: '1',
      fields: [
        { kind: 'bytes', name: 'header', label: '帧头', length: 1 },
        { kind: 'int', name: 'ambient', label: '环境温度', bits: 8, unit: '℃' },
        { kind: 'int', name: 'probe', label: '探头温度', bits: 16, endian: 'little', scale: 0.1, unit: '℃' },
        { kind: 'int', name: 'compensated', label: '补偿温度', bits: 32, endian: 'big', scale: 0.01, unit: '℃' },
        { kind: 'uint', name: 'pressure', label: '压力', bits: 24, endian: 'big', scale: 0.001, unit: 'MPa' },
        {
          kind: 'bits',
          name: 'alarms',
          label: '报警字',
          bytes: 1,
          bitOrder: 'msb',
          fields: [
            { name: 'critical', bits: 1, label: '严重', enum: { '0': '无', '1': '报警' } },
            { name: 'warning', bits: 1, label: '警告', enum: { '0': '无', '1': '报警' } },
            { name: 'code', bits: 6, label: '故障码' },
          ],
        },
      ],
      checksum: { algorithm: 'sum16' },
    },
  ],
};

/** 10. 多通道采集器:计数前缀数组嵌套定长数组 + CRC16-XModem */
export const nestedArray: ProtocolDef = {
  id: 'nested-array',
  name: '多通道采集器',
  description: '通道数组(计数前缀)嵌套采样数组(定长)+ CRC16-XModem',
  versions: [
    {
      version: '1',
      fields: [
        { kind: 'bytes', name: 'header', label: '帧头', length: 1 },
        { kind: 'uint', name: 'channelCount', label: '通道数', bits: 8 },
        {
          kind: 'array',
          name: 'channels',
          label: '通道',
          countFrom: 'channelCount',
          element: {
            kind: 'group',
            name: 'channel',
            fields: [
              { kind: 'uint', name: 'id', label: '通道号', bits: 8 },
              {
                kind: 'array',
                name: 'samples',
                label: '采样',
                count: 3,
                element: { kind: 'int', name: 'sample', bits: 16, endian: 'little', scale: 0.1, unit: '℃' },
              },
              { kind: 'uint', name: 'gain', label: '增益', bits: 8, scale: 0.1 },
            ],
          },
        },
      ],
      checksum: { algorithm: 'crc16-xmodem' },
    },
  ],
};

export const builtinProtocols: ProtocolDef[] = [
  modbusMeter,
  gpsTracker,
  tlvSensor,
  smartMeter,
  alarmPanel,
  envSensor,
  fragUplink,
  fragPayload,
  stringDevice,
  signedIndustrial,
  nestedArray,
];
