# 可配置报文解码平台 (TLV Decoder)

面向多厂家物联网终端的**声明式二进制报文解码平台**，纯 TypeScript 实现，浏览器内运行。
接入新厂家时只需编写一份 JSON 协议描述，无需再写解析代码。

## 快速开始

```bash
npm install
npm run dev        # 启动开发服务器 (浏览器打开提示端口)
npm run selftest   # 10 万条报文全量自测 (正确性 + 性能)
npm run bench      # 独立性能基准
npm run smoke      # UI 引擎路径端到端烟雾测试
npm run build      # 类型检查 + 生产构建
```

## 能力与需求对照

| # | 需求 | 实现 |
|---|------|------|
| 1 | 定长/变长/TLV/位域/数组声明式描述 | `src/engine/types.ts` 统一 `FieldDef` 模型; 变长用 `lengthOf` 引用长度字段, TLV 用 `TlvConfig`, 位域用 `BitDef`, 数组支持定长/`countOf`/`terminator` |
| 2 | 大小端/BCD/有符号/缩放按字段配 | 每字段 `endian` 覆盖协议默认; `bcd`/`int`/`scale`/`offset`/`units`; 二补码负数、混合大小端均支持 |
| 3 | CRC16/CRC32/累加和可选 + 失败标红 | `crc.ts` 含 CRC16-Modbus、CRC16-CCITT、CRC32、checksum8/16 (查表加速); 失败节点 `crcOk=false`, 字段树与 hex 区双重标红 |
| 4 | 分包按序号拼回 + 丢包提示 | `reassembly.ts` 按 `groupKeyFields` 归组、seq 排序拼接, 缺片输出 `missing[]`, 支持内层协议继续解码与乱序投递 |
| 5 | 十六进制与字段树双向高亮 | `HexViewer` 点字节→`findNodeAtByte` 反查最小字段; 点字段树→字节区间高亮 |
| 6 | 未知样本自动猜字段边界 | `infer.ts` 逐偏移统计常量/可打印/枚举/单调性/高熵, 推断魔数/长度/序号/枚举/文本/校验, 带置信度与 FieldDef 草案 |
| 7 | 版本升级后老报文按旧版解 | `registry.ts` 的 `basedOn` 继承链 + 字段深合并; 同 id 多版本共存, 显式按版本取定义, 帧头识别返回全部版本候选 |

## 性能与正确性

- **十协议 × 各 10000 条 = 10 万条**报文, 每条带期望解码结果, 批量解码**逐字段零不一致**
- 纯解码吞吐 **~11.3 万帧/秒**, 单协议 1 万条平均 **88ms** (要求 <1000ms), 最慢的嵌套数组协议 194ms
- 编解码严格对称 (`encoder.ts` ↔ `decoder.ts`), 合成报文天然带 round-trip 期望值

## 十个内置协议

| ID | 特色覆盖 |
|----|---------|
| P1-METER | 大端 + BCD 表号 + CRC16-Modbus(LE) + 缩放 |
| P2-ENV | 小端 + 有符号 + 位域 + CRC16-CCITT |
| P3-GPS | 混合大小端 + float32 + LSB 位域 + CRC32 |
| P4-GW | 嵌套 struct + `when` 条件字段 + 累加和 |
| P5-ACL | 定长字符串 + `countOf` 数组 + 枚举 |
| P6-TLV | TLV 嵌套 + 未知 tag 容错 + 累加和16 |
| P7-VIB | 结构数组 + 终止符数组 + 嵌套 struct |
| P8-FRAG / P8-INNER | 分片重组 + 重组后内层继续解码 |
| P9-CTRL v1/v2 | 版本继承 (`basedOn`)、字段扩容、枚举扩展 |
| P10-WATER | GBK 字符串 + struct 内嵌 TLV + 位域 + CRC32-LE |

## 架构

```
src/
  engine/                 纯逻辑引擎 (无 DOM 依赖, 可独立用于 Node)
    types.ts              声明式协议模型 + 解码结果树类型
    reader.ts             字节游标 (大小端/有符号/BCD)
    crc.ts                校验算法 (查表)
    expr.ts               when 条件表达式求值器
    decoder.ts            核心解码器 → DecodeNode 树 (含字节区间)
    encoder.ts            对称编码器 (样本生成 / round-trip)
    registry.ts           协议库 + 版本继承 + 帧头识别
    reassembly.ts         分包重组
    infer.ts              未知样本字段边界推断
    compare.ts            解码结果与期望值深度比对
    protocols1/2.ts       十个协议的声明式定义
    generator.ts          确定性 PRNG 样本合成 (带期望结果)
  ui/                     React 视图层
    App.tsx               五个标签页外壳
    LibraryView           协议库 (增删改查/导入导出/持久化)
    EditorView            协议编辑 (结构化表单 + JSON 双模式 + 实时试解码)
    ParseView             报文解析 (双向高亮 / 推断 / 重组)
    BatchView             批量解码 (自动识别/计时/逐帧结果)
    StatsView             字段统计 (分布/min/max/均值/枚举/校验)
    HexViewer/FieldTree   双向高亮组件
scripts/
  selftest.ts             A 全量 round-trip / B 坏帧 / C 版本 / D 重组 / E 推断
  bench.ts                分协议性能基准
  smoke.ts                UI 引擎调用路径烟雾测试
```

## 协议描述示例 (TLV)

```json
{
  "name": "attrs",
  "type": "tlv",
  "tlv": {
    "tag": { "size": 1 },
    "length": { "size": 1 },
    "countField": "tlvCount",
    "unknown": "raw",
    "tags": [
      { "name": "temperature", "tag": 1, "type": "int", "size": 2, "scale": 0.1, "units": "℃" }
    ]
  }
}
```

协议库通过 `localStorage` 持久化, 支持整库 JSON 导入/导出与一键恢复内置。
