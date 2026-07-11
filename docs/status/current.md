# status/current —— 当前真值与待拍板（活文档）

> 2026-07-10。当前状态的唯一权威（历史见 [../roadmap/changelog.md](../roadmap/changelog.md)）。

## 真实具备（9 组，均真实数据实测；547 单测，40 REST paths）

企业理解（Claim/Evidence/冲突/人审）· ICP（规则/回测/查询计划/CPV/FDA 映射）· 发现（public_web/wikidata/OSM/名录/展会/TED/openFDA）· 富集（GLEIF/Wikidata/数字足迹/结构化收割）· 采集监控（4 表+增量 diff）· 买家信号（**一等 Signal**：`source_signal` 平台表两层模型 + `signal_ingest` ingest-once 账本（指纹×6h 窗跨 workspace 只拉一次）+ 状态机（EXPIRED/REVOKED 剔除、撤即脱敏）+ 可复算投影（recompute 同过滤面）；web_watch/TED 招标/510k 清关/决策人/smtp_self）· 资格（六维评分 + **demand_proof 观测维**（需求证据类事件驱动，不进总分待乘法门 backtest）/Reachability 硬门/四队列/人工裁决）· **事件交付**（LeadQualified 快照 v1 契约（demand_proof 已填真值，rule=additive-6dim-v2）/`outbox_delivery` 账本/`GET /events` 拉取+ACK/可选 HMAC webhook）· 平台地基（JWKS 座/RLS/Outbox/Temporal 4 Schedule/模型网关/API 门户 + **统一信封契约**：code-first openapi.json 单一真值、CI 契约三道门 + **ToolBroker 唯一执行闸门**：13 个 L0 工具收编全部主链出网、source_policy fail-closed 分层、预算 reserve-then-settle 真拦截、ExecutionContext 贯穿真租户归账）。

## as-built 缺口（8 项，已核验；#1 #2 #3 #4 #5 + 收口⑥ 存储合规已修——剩缺口#6/#8）

见 [../architecture/current.md](../architecture/current.md) §8。**#1 Fit 聚合根已修（PR #43，收口①完成）**；**#2 Broker 非唯一闸门已修（PR #51，收口②完成）**——13 个 L0 工具收编 22 处直连出网（发现/富集/intent/采集/理解五链全经 `broker.invoke`，例外四类登记），source_policy `required|advisory|none` 分层 fail-closed + 用途门按调用 purpose 判，预算真开账（run/sweep 开关账 + LLM 网关 reserve-then-settle 按 token 折算 + 截断显性化 run 转 PARTIAL），伪 workspace 清零、AI trace 真库实证写入成功；**#3 Outbox 假发布已修（PR #46，收口③完成）**——LeadQualified 现以快照 v1 契约经交付账本真实交付，未注册事件 parked 不再假发布；**#4 OpenAPI 双源已修（PR #48，收口④完成）**——统一信封定稿（`{data}`/`{data,page:{next_cursor,has_more}}`/`{error}`），旧 YAML 删除、契约唯一真值=code-first `openapi.json`，CI contracts job（drift+spectral+oasdiff breaking，label 放行）拦截破坏性变更；**#5 Intent 非一等事实已修（PR #56，收口⑤完成）**——`source_signal` 一等信号表（零个人数据、双时间轴、状态机+TTL）+ `signal_ingest` ingest-once 账本（同源同参同 6h 窗跨 workspace 只拉一次），TED/openFDA 投影反转为只读平台表、sweep 四段化，`attributes.intent` 降为可复算投影（recompute surfaces 同过滤面 + mergeIntent epoch 归一），快照 demand_proof 真值填充（v1 槽位零破坏，rule→additive-6dim-v2）。**收口⑤记档项**（不阻塞）：ingest PENDING 抢锁根治（TOCTOU 双拉窗口，ERROR 覆盖 OK 已修）· TED CPV 前缀列+GIN 下推（现扫描窗打满有显性告警）· 投影 maxCompanies 游标化（现 subjectsTruncated 可观测，与缺口#8 同类）· license 值 SPDX 统一（随收口⑥ 权利词表）· SUSPENDED=停采不停用两级撤停语义已文档化（存量处置=revokeByProvider）。**#6 收口⑥ 存储合规已修（PR-A #60 存储地基 + PR-B 删除编排）**——`DataRightsService` 7 动作确定性引擎 + jurisdiction_policy(含 PIPL) + policy_decision_log/lia_record/article14_notice + PII 列级加密 + DB 角色拆分（PR-A）；`deletionWorkflow`(GDPR Art.17 冻结→擦除→重评分→回执) + `deletion_request`(状态机 RLS) + `deletion_receipt`(append-only + FK RESTRICT 防级联删) + `POST/GET /deletion-requests` + 事务性 outbox 起编排 + DeletionCompleted 事件（PR-B）。真库 DSR 全链演练 31 断言全绿（contact/company 主体、幂等、无 PII 残留、并发去重、部分失败忠实回执、擦除完整性）。**商业试点前置=六项收口完成+封版定义满足**（见 [../roadmap/release-plan.md](../roadmap/release-plan.md)）；当前坦承：**六项工程收口已全部完成**，剩封版定义（真实企业样本 E2E/UAT + 输出被下一能力真实消费）+ 缺口#6/#8，方达可直接商业试点。

## 与 PRD v3.0 的登记偏差（8 条，不再静默）

new-api 替代 LiteLLM · 全 TS 无 Python worker · 不用 BullMQ · 自建 ai_trace 替代 Langfuse · OPA 未上（PolicyPort 过渡）· 免费源优先替代付费瀑布 · AiToEarn/触达不在本仓 · recommended 队列门（总分≥0.55 且 Reachability>0）为 PRD 缺位的实现口径。

## 待拍板（4 项）

1. **制裁名单筛查立项**——OFAC/EU 禁止交易名单；把名单公司推荐给客户=转嫁出口管制风险。数据源全免费、复用 name-match、一周量级。建议：立项，作 qualify 第五门（命中→隔离队列人工复核，不自动定罪）。
2. **DLP 提单前提核实**——「海关提单」免费方案的前提（DLP FOIA 数据集可再分发）疑似 2023-04 已被拒。需人工上 data-liberation-project.org 核实（10 分钟），结论记入本文件。R3 排期前完成。
3. **两份 v3.0 Word 最小整改**——修撞号/损坏标题/声明重复章节以 PRD 为准/裁决 M2 口径（QGO vs SAO）。1-2 天，建议 C+Claude 做、用户验收。与交付包「冻结 v3.0」不冲突（只修结构便于迁移引用）。
4. **首发 Job 二选一**——进口商/采购商发现 vs 经销商招募。现有数据源覆盖明显偏向前者（TED/openFDA/提单/web_watch 求供应商页）。建议：**首发「进口商/采购商发现」**，经销商招募 R3 用 Pack 加入。

**需 A/B 会签（用户方向已认）**：PDR-001 对象词典 / PDR-002 业务层级（GrowthInitiative）/ 三接缝契约 / 对象级 RACI。
