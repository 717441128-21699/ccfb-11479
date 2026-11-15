/**
 * 声明式协议描述模型
 * 一份 JSON 即可完整描述一个协议: 定长 / 变长 / TLV / 位域 / 数组,
 * 大小端、BCD、有符号、缩放、枚举、CRC、分包重组、版本。
 */

export type Endian = 'le' | 'be';
export type BitOrder = 'msb' | 'lsb';
export type Signedness = 'unsigned' | 'signed';
export type StringEncoding = 'ascii' | 'utf8' | 'gbk' | 'hex';

export type FieldType =
  | 'uint' // 无符号整数 (size 1/2/4/8)
  | 'int' // 有符号整数 (size 1/2/4/8)
  | 'float' // IEEE754 浮点 (size 4/8)
  | 'bcd' // BCD 码, 每字节两位 0-9
  | 'bool' // 单字节 0/1
  | 'enum' // 整数 + 枚举映射
  | 'bits' // 位域容器, children 为 bit 定义
  | 'string' // 字符串
  | 'bytes' // 原始字节
  | 'array' // 数组 (定长 / 长度字段 / 终止符)
  | 'tlv' // TLV 嵌套块
  | 'struct' // 嵌套结构
  | 'crc'; // 校验字段

/** 位域中的单个 bit 段 */
export interface BitDef {
  name: string;
  /** 段宽(bit), 从容器起始按 bitOrder 排布 */
  bits: number;
  signed?: Signedness;
  scale?: number;
  offset?: number;
  mapping?: Record<string, string>;
  description?: string;
}

export interface FieldDef {
  name: string;
  type: FieldType;
  description?: string;

  /** 整数/float/bcd/bool/enum/crc 的字节宽度; bcd 也用它表示字节数 */
  size?: number;
  endian?: Endian;
  signed?: Signedness;

  /** bcd: 允许的半字节数(0 表示按 size*2 全解); 字符串/字节的长度 */
  length?: number;
  /** 长度引用其它字段名 (变长), 可带倍数, 如 { field: 'len', unit: 2 } */
  lengthOf?: { field: string; unit?: number; adjust?: number };
  /** 长度包含自身/头部的偏移修正 */
  lengthAdjust?: number;

  /** 数值缩放: 展示值 = 原始值 * scale + offset */
  scale?: number;
  offset?: number;
  units?: string;
  mapping?: Record<string, string>;

  /** string / bytes */
  encoding?: StringEncoding;
  /** 定长字符串去尾部填充 */
  trim?: boolean;

  /** bits 位域 */
  bitOrder?: BitOrder;
  children?: BitDef[];

  /** array */
  element?: FieldDef;
  /** 定长数组元素个数 */
  count?: number;
  countOf?: string; // 元素个数引用字段
  terminator?: number; // 终止字节 (含终止符本身)
  includeTerminator?: boolean;

  /** struct / tlv 的子字段 */
  fields?: FieldDef[];

  /** tlv 配置 */
  tlv?: TlvConfig;

  /** crc 配置 (type=crc) */
  crc?: CrcSpec;

  /** 条件存在: 表达式为真才解析, 如 "$type == 3" */
  when?: string;
}

export interface TlvConfig {
  tag: {
    size: number; // tag 字节数 1/2/4
    endian?: Endian;
  };
  length: {
    size: number; // length 字节数
    endian?: Endian;
    /** length 值的含义: value=仅 value 字节数(默认); remaining=含后续所有; total=含 tag+length 自身 */
    includes?: 'value' | 'remaining' | 'total';
  };
  /** tag -> 字段定义 (name/type/size...), 未知 tag 按 raw 处理 */
  tags?: TlvTagDef[];
  /** TLV 条目数字段名 (帧内前置字段); 不配置时解析到容器/帧尾 */
  countField?: string;
  /** 未知 tag 的处理: raw=按原始字节挂出(默认); skip=跳过; error=报错 */
  unknown?: 'raw' | 'skip' | 'error';
  /** 不按 length 截断, 一直解析到容器边界 (length 字段仅展示) */
  greedy?: boolean;
}

export interface TlvTagDef extends FieldDef {
  /** tag 的数值 (单值) 或多值 */
  tag: number | number[];
}

export type CrcAlgo = 'crc16-modbus' | 'crc16-ccitt' | 'crc32' | 'checksum8' | 'checksum16';

export interface CrcSpec {
  algo: CrcAlgo;
  /** 校验覆盖区间, 默认从帧头到本字段之前 */
  rangeStart?: number; // 绝对字节偏移
  rangeEnd?: number; // 绝对字节偏移(不含); 默认 = 字段起始
  endian?: Endian; // 多字节校验值的字节序
  /** checksum 系列: 初始值与取反 */
  init?: number;
  xorOut?: number;
}

/** 帧头/长度/魔数约束, 用于版本识别与基本合法性检查 */
export interface FrameSpec {
  magic?: number[]; // 固定帧头字节
  magicOffset?: number;
  lengthField?: string; // 引用某字段名作为整帧长度
  /** 长度字段含义修正: frameLen = lenField + adjust */
  lengthAdjust?: number;
  minSize?: number;
  maxSize?: number;
}

/** 分包重组配置 (数据上报型分片帧) */
export interface ReasmSpec {
  seqField: string; // 帧内序号字段
  totalField: string; // 总分片数字段
  groupKeyFields: string[]; // 同组判定字段 (如设备号/消息id)
  payloadField: string; // 分片净荷字段
  /** 承载重组后净荷的协议 id (可选, 重组后继续解码) */
  innerProtocol?: string;
}

export interface ProtocolDef {
  id: string;
  name: string;
  vendor?: string;
  version: string;
  /** 同 id 协议的版本继承基版本 (字段定义深合并) */
  basedOn?: string;
  endian: Endian;
  frame?: FrameSpec;
  fields: FieldDef[];
  reassembly?: ReasmSpec;
  description?: string;
}

/* ---------- 解码结果树 ---------- */

export interface DecodeNode {
  name: string;
  path: string; // 点分路径, 数组带 [i], TLV 带 tag
  type: FieldType | 'root' | 'tlv-item';
  start: number; // 起始字节偏移
  end: number; // 结束偏移(不含)
  /** 展示值(已缩放/解码) */
  value: unknown;
  /** 原始数值(缩放前), 便于统计与比对 */
  raw?: unknown;
  display?: string; // 完整展示文本 value(units) / enum 文本
  bits?: { name: string; bitStart: number; bitEnd: number; value: number; display: string }[];
  children?: DecodeNode[];
  warning?: string;
  error?: string;
  crcOk?: boolean;
}

export interface DecodeResult {
  ok: boolean;
  protocolId: string;
  version: string;
  root: DecodeNode;
  bytes: number; // 实际消费字节数
  warnings: string[];
  errors: string[];
  /** 扁平 path -> node, 供表达式与统计使用 */
  flat: Record<string, DecodeNode>;
  elapsedUs?: number;
}
