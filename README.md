# 物联网协议解码平台

面向私有二进制协议的**可配置**报文解码平台:协议用声明式 JSON 描述,新接厂家不需要写解析代码。浏览器里运行,核心引擎零依赖,浏览器 / Node 通用。

## 快速开始

```bash
npm install
npm run build     # 编译 TS -> dist/
npm run serve     # http://localhost:8080
npm run gen       # 生成测试数据:10 种协议 x 10000 条 -> data/
npm test          # 批量解码一致性比对 + 性能基准 + 正确性用例
```

## 功能

| 页签 | 说明 |
|---|---|
| 协议库 | 内置 11 个协议,支持导入/导出 JSON,用户协议存 localStorage |
| 协议编辑 | JSON 编辑 + 格式校验;**样本猜测**:粘贴未知协议样本,自动猜字段边界/校验算法 |
| 报文解析 | 单条解码,十六进制视图与字段树**双向悬停高亮**,校验结果徽标 |
| 批量解码 | 粘贴/上传批量报文,统计成功率与耗时,失败列表,导出 JSON/CSV;分片协议自动重组并报告丢包 |
| 字段统计 | 对批量结果按字段聚合:最值/均值/唯一值/高频取值 |

## 协议描述能力(src/core/types.ts)

- **字段类型**:`uint`/`int`(8~64 位)、`bcd`、`bytes`(定长 / `lengthFrom` 变长)、`bits`(位域,LSB/MSB 两种排布)、`array`(定长 / `countFrom` 计数前缀)、`group`(嵌套结构)、`tlv`(可无限嵌套)、`pad`、`rest`
- **按字段配置**:大小端、BCD、有符号、缩放系数 `scale`+`add`、单位、枚举映射
- **校验**:CRC16(Modbus / CCITT-FALSE / X25 / XModem)、CRC32-IEEE、sum8 / sum16、xor8;可配字节序与校验范围起点;校验失败在结果和 UI 里标出
- **分包重组**:`fragment` 声明会话/序号/总数/负载字段,`Reassembler` 按序号拼回完整报文,序号跳变即时告警,收尾报告缺失序号
- **多版本**:`versions[]` + `match` 条件自动匹配版本解码,老报文按旧版解;也可显式指定版本

## 协议描述示例

```json
{
  "id": "modbus-meter",
  "name": "Modbus 电表",
  "versions": [{
    "version": "1",
    "fields": [
      { "kind": "bytes", "name": "header", "length": 2 },
      { "kind": "uint", "name": "addr", "bits": 8 },
      { "kind": "uint", "name": "regCount", "bits": 8 },
      { "kind": "array", "name": "regs", "countFrom": "regCount",
        "element": { "kind": "uint", "name": "reg", "bits": 16, "scale": 0.1, "unit": "kWh" } }
    ],
    "checksum": { "algorithm": "crc16-modbus" }
  }]
}
```

## 测试与性能

`npm run gen && npm test`:

- 10 种协议(覆盖定长/变长/TLV 嵌套/位域/数组/BCD/有符号/大小端混排/8 种校验/分包/多版本)各 10000 条,编码器生成报文 + 期望解码结果,批量解码**逐字段完全一致**
- 每种协议 10000 条解码耗时 **35~102ms**(要求 1 秒内)
- 附加用例:篡改报文 100% 被校验标出、分片丢包 100% 报告缺失序号、多版本报文 100% 自动匹配到正确版本

## 目录结构

```
src/core/      解码引擎:decoder / encoder / crc / fragment / guess / stats / registry / types
src/protocols/ 内置协议库(声明式 JSON 定义)
src/gen/       测试数据生成器(固定种子,结果可复现)
src/test/      一致性 + 性能 + 正确性测试
src/ui/        浏览器界面(原生 TS,无框架)
server.mjs     开发用静态服务器
smoke.html     浏览器端冒烟测试(访问 /smoke.html)
```
