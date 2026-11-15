/**
 * 声明式协议描述的类型定义。
 * 一个协议(ProtocolDef)包含多个版本(ProtocolVersion),每个版本描述一帧报文的完整布局。
 */

export type Endian = 'big' | 'little';

interface BaseField {
  name: string;
  label?: string; // 展示名
}

/** 无符号/有符号整数,支持 8/16/24/32/48/64 位、大小端、缩放系数、偏移、枚举 */
export interface UIntField extends BaseField {
  kind: 'uint' | 'int';
  bits: 8 | 16 | 24 | 32 | 48 | 64;
  endian?: Endian;            // 默认 big
  scale?: number;             // 工程值 = 原始值 * scale + add
  add?: number;
  unit?: string;
  enum?: Record<string, string>; // 原始值 -> 含义
}

/** BCD 码:每个字节两个十进制数字 */
export interface BcdField extends BaseField {
  kind: 'bcd';
  bytes: number;
  scale?: number;
  add?: number;
  unit?: string;
}

/** 原始字节 / 字符串。定长(length)或从前面某个字段取长度(lengthFrom) */
export interface BytesField extends BaseField {
  kind: 'bytes';
  length?: number;
  lengthFrom?: string;        // 引用同级已解码字段名
  encoding?: 'hex' | 'ascii' | 'utf8'; // 默认 hex
}

/** 位域:把 1~8 个字节当作一个整数,按位切分子字段 */
export interface BitsField extends BaseField {
  kind: 'bits';
  bytes: number;
  endian?: Endian;            // 多字节时的字节序,默认 big
  bitOrder?: 'lsb' | 'msb';   // 子字段从低位开始排(lsb,默认) 还是从高位开始排(msb)
  fields: { name: string; bits: number; label?: string; enum?: Record<string, string> }[];
}

/** 数组:定长(count)或从前面某个字段取个数(countFrom) */
export interface ArrayField extends BaseField {
  kind: 'array';
  count?: number;
  countFrom?: string;
  element: FieldDef;
}

/** 嵌套结构 */
export interface GroupField extends BaseField {
  kind: 'group';
  fields: FieldDef[];
}

/**
 * TLV:type(typeBytes 字节) + length(lengthBytes 字节) + value。
 * types 把 type 值映射到一组嵌套字段;未注册的 type 按原始字节展示。
 * 支持嵌套:value 里的字段可以再次是 tlv。
 */
export interface TlvField extends BaseField {
  kind: 'tlv';
  typeBytes: number;
  lengthBytes: number;
  endian?: Endian;            // type/length 多字节时的字节序,默认 big
  types: Record<string, { name: string; fields: FieldDef[] }>;
  maxItems?: number;          // 上限保护,默认 1024
}

/** 保留/填充字节 */
export interface PadField extends BaseField {
  kind: 'pad';
  bytes: number;
}

/** 剩余全部字节(到校验字段之前) */
export interface RestField extends BaseField {
  kind: 'rest';
  encoding?: 'hex' | 'ascii' | 'utf8';
}

export type FieldDef =
  | UIntField
  | BcdField
  | BytesField
  | BitsField
  | ArrayField
  | GroupField
  | TlvField
  | PadField
  | RestField;

export type ChecksumAlgorithm =
  | 'crc16-modbus'
  | 'crc16-ccitt-false'
  | 'crc16-x25'
  | 'crc16-xmodem'
  | 'crc32-ieee'
  | 'sum8'
  | 'sum16'
  | 'xor8';

export interface ChecksumDef {
  algorithm: ChecksumAlgorithm;
  endian?: Endian;      // 校验值在报文中的字节序;缺省按算法惯例(modbus 小端,其余大端)
  startOffset?: number; // 校验范围起点,默认 0;终点固定为校验值之前
}

/** 分包重组描述:字段路径指向帧内的会话号/序号/总数/分片负载 */
export interface FragmentDef {
  session: string;          // 会话 id 字段路径
  seq: string;              // 分片序号字段路径
  total: string;            // 分片总数字段路径
  payload: string;          // 分片负载字段路径
  seqBase?: number;         // 序号起始值,默认 0
  innerProtocolId?: string; // 拼回完整报文后用哪个协议解码
}

export interface ProtocolVersion {
  version: string;
  /** 自动版本匹配:解码出的字段满足全部条件时认为报文属于该版本 */
  match?: { path: string; equals: unknown }[];
  fields: FieldDef[];
  checksum?: ChecksumDef;
  fragment?: FragmentDef;
}

export interface ProtocolDef {
  id: string;
  name: string;
  description?: string;
  versions: ProtocolVersion[];
}

/** 解码树节点:携带字节区间,供十六进制视图与字段树双向高亮 */
export interface DecodeNode {
  name: string;
  path: string;
  kind: string;
  offset: number;      // 起始字节
  length: number;      // 字节长度
  bitOffset?: number;  // 位域子字段:在起始字节内的起始位
  bitLength?: number;
  value?: unknown;
  display?: string;
  unit?: string;
  error?: string;
  children?: DecodeNode[];
}

export interface ChecksumResult {
  ok: boolean;
  algorithm: string;
  expected: number;   // 报文里携带的
  actual: number;     // 实际算出来的
}

export interface DecodeResult {
  ok: boolean;
  protocolId: string;
  version: string;
  root: DecodeNode;
  /** 扁平化的叶子值:路径 -> 工程值(含枚举原始值) */
  values: Record<string, unknown>;
  checksum?: ChecksumResult;
  errors: string[];
}

export function checksumSize(algorithm: ChecksumAlgorithm): number {
  switch (algorithm) {
    case 'sum8':
    case 'xor8':
      return 1;
    case 'sum16':
    case 'crc16-modbus':
    case 'crc16-ccitt-false':
    case 'crc16-x25':
    case 'crc16-xmodem':
      return 2;
    case 'crc32-ieee':
      return 4;
  }
}

export function checksumDefaultEndian(algorithm: ChecksumAlgorithm): Endian {
  return algorithm === 'crc16-modbus' ? 'little' : 'big';
}
