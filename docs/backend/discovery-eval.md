# 客户发现真实数据评测报告

> 目的：验证「真实数据挖掘」管线（SearXNG + Crawl4AI + Gemini）的产出**真实**且**可评判**——不是 sandbox 假数据。
> 方法：真实跑一次发现 → 确定性硬校验 + 对抗性人工级核验（多代理实访官网，怀疑立场、防放水）。
> 日期：2026-07-06。样本：19 家真实发现的公司。ICP：TRUMPF（德国精密激光/钣金设备商）的目标客户。

## 1. 测试设置

- **查询计划**（英文）：`sheet metal fabrication / laser cutting / CNC bending`（DE）+ `metal machining / precision machining / welding`（DE），两类源 `public_intelligence` + `industry_data`。
- **管线**：SearXNG 元搜索出候选域名 → 噪声域名过滤 → robots.txt 闸门 → Crawl4AI 抓官网 → gemini-2.5-flash 判站 + 结构化抽取 → canonical 归一 + 身份解析 + 字段级 Evidence。
- **评委**：19 个独立代理，各用 WebFetch **实访官网**逐家核验；被指令「怀疑立场、尽力证伪、reasoning 必须引用官网实际内容」。另有确定性 DNS + HTTP 存活校验作为不依赖 LLM 的底线。

## 2. 结果指标

| 维度 | 结果 | 说明 |
|---|---|---|
| DNS + HTTP 存活（确定性） | **19/19** | 全部域名可解析、官网 2xx/3xx 存活 |
| 官网可访问且真实运营（LLM 实访） | **19/19 (100%)** | 无停靠页/空壳/AI 模板站 |
| 是真实制造企业 | **19/19 (100%)** | 无目录/百科/新闻/中介误纳为"公司" |
| 属性有官网依据 | **19/19 (100%)** | 抽取的行业/产品均可在官网核对，**无幻觉** |
| ICP 匹配 = match | **13/19 (68%)** | 真正是 TRUMPF 目标客户 |
| ICP 匹配 = weak | 2/19 (11%) | Norck（采购中介平台）、Petersen（纯磨削，无激光钣金） |
| ICP 匹配 = mismatch | **4/19 (21%)** | 见下 |

## 3. 逐家核验

| 公司 | 域名 | 官网活 | 真实制造商 | 属性有据 | ICP | 置信 |
|---|---|:-:|:-:|:-:|---|:-:|
| Bart Manufacturing | bartmanufacturing.com | ✓ | ✓ | ✓ | match | 0.82 |
| BURGER GROUP | burger-group.com | ✓ | ✓ | ✓ | match | 0.90 |
| ERNST Umformtechnik | ernst.de | ✓ | ✓ | ✓ | match | 0.93 |
| IRION GmbH | irion.de | ✓ | ✓ | ✓ | match | 0.92 |
| Mayer Group | mayer.de | ✓ | ✓ | ✓ | match | 0.90 |
| Metall Advancement Group | mag-group.eu | ✓ | ✓ | ✓ | match | 0.82 |
| Metallbau Nick GmbH | nick-gmbh.de | ✓ | ✓ | ✓ | match | 0.95 |
| NEW STANDARD CORP | newstandard.com | ✓ | ✓ | ✓ | match | 0.86 |
| Oberg | oberg.com | ✓ | ✓ | ✓ | match | 0.82 |
| Pinnacle Precision | pinnaclemetal.com | ✓ | ✓ | ✓ | match | 0.88 |
| Schröder Group | schroedergroup.eu | ✓ | ✓ | ✓ | match | 0.95 |
| SPALECK | spaleck.eu | ✓ | ✓ | ✓ | match | 0.92 |
| TZR | tzrmetal.com | ✓ | ✓ | ✓ | match | 0.86 |
| Norck | norck.com | ✓ | ✓ | ✓ | **weak** | 0.78 |
| Petersen Precision | petersenprecision.com | ✓ | ✓ | ✓ | **weak** | 0.82 |
| Carolina CoverTech | carolinacovertech.com | ✓ | ✓ | ✓ | **mismatch** | 0.95 |
| Elcan Industries | elcanindustries.com | ✓ | ✓ | ✓ | **mismatch** | 0.95 |
| HSG Laser | hsglaser.com | ✓ | ✓ | ✓ | **mismatch** | 0.90 |
| Suzhou Gold Chain Trading | goldchain-trade.com | ✓ | ✓ | ✓ | **mismatch** | 0.88 |

## 4. 结论：真实性极强，相关性偏弱

**产出是真实数据**——三项真实性指标满分，19 家全部是真实运营的自有制造企业、属性全部可核对、零幻觉。挖掘/抽取环节质量很高。

**真正的失真在 ICP 匹配层**（约 1/3 线索作为 TRUMPF 客户不成立），三类根因：

1. **品类混淆**：靠"制造/welding/fabrication/laser"关键词召回，未区分**材质**（金属 vs 塑料/织物/粉体）。
   - Carolina CoverTech = 技术织物，其 "RF welding" 是射频热合塑料织物，同词异义陷阱。
   - Gold Chain = 塑料注塑；Elcan = 粉体筛分设备。
2. **竞品误纳**：HSG Laser 本身就是激光切割/折弯设备制造商，是 TRUMPF 的**直接竞争对手**，不是买家。管线缺"卖方 vs 同类设备制造商"的方向判别。
3. **商业模式/工艺子集**：Norck 是聚合数百家供应商的采购中介平台（非自有产线）；Petersen 是纯精密磨削（无激光钣金）。

## 5. 已采取的修复：ICP 资格门（Qualify Fit Gate）

按评测建议，在真实性层之后、评分之前插入结构化 **ICP 资格门**（AI 任务 `discovery.qualify_fit`，gemini-2.5-pro），把「召回」与「资格判定」分离，四个门：
- **材质门**：金属加工 vs 塑料/织物/粉体（处理 RF welding / toll processing 同词异义）。
- **角色门**：设备的下游买家 vs 同类设备制造商（竞品）。
- **工艺子集门**：命中 ICP 核心工艺（激光/钣金/折弯/焊接/成形）而非仅相邻工艺（纯机加/磨削）。
- **商业模式门**：自有产线 vs 采购中介平台。

输出 `match / weak / mismatch` 三态 + 绑定证据，写入 `canonical_company.fit_verdict`；`mismatch` 直接进 rejected 队列，`weak` 进 needs_review，供销售分层触达。**复测验证见 §6。**

## 6. 复测（资格门生效后）

见 `discovery-eval-round2.md`（对 6 家 weak/mismatch 重跑资格门，确认能被正确拦截）。

## 7. 仍存欠账

- **规范词表归一**：中文 ICP → 中文查询计划 → SearXNG 搜索质量差；本次评测用手工英文查询计划绕过。真源化前必须做 ICP 规则值 ↔ 搜索/属性词表的映射层。
- 属性归属（自产 vs 经销代理，如 Bart 把 Bosch Rexroth 混进 products）、字段缺失（country=null）、行业标签过粗——降低下游可用性，非真实性问题。
