# status/current —— 当前真值与待拍板（活文档）

> 2026-07-10 立；**2026-07-16 truth-sync 更新，审计基线（合并前）为 `main@a306ffa`（#124）**。这是当前状态权威；历史见 [../roadmap/changelog.md](../roadmap/changelog.md)。
> 下方「真实具备/缺口/偏差/待拍板」四节是**获客侧快照，冻结于 2026-07-13 获客暂停时点**。测试数量随提交变化，不在活状态文档固化；是否通过以当前分支实际命令和 CI 结果为准。

## 🟢 当前主线：独立站建设（Site Builder）

获客侧 **2026-07-13 起暂停**（用户指示，明确通知才恢复）。当前唯一开发主线 = 为出海企业一键生成 / 精装修独立站。

- **M0 as-built**：注册引导、`Site`/`SiteVersion`/`BuildRun`、素材上传与 KB、Demo v0 Temporal 工作流、Astro 渲染器（当前注册 10 型组件）、7 个有界 AI Task 路由，以及 **DQ-1 SiteSpec 共享契约（#117）**。`@global/contracts` 的 `SITE_SPEC_VERSION=1.0.0` 是生产/消费两端唯一类型源；运行时 Zod 与 1.1.0 目标字段尚未落地。
- **已合并（当前 main）**：#121 已把 intake **行为**改为无条件建站/触发 demo；#123 已修 ADR-017 禁虚构身份；#124 已完成 businessEmail 不进 KB/Prompt、LLM 真取消超时、异步失败保留站点并支持原地重试。
- **R0 尚未整体闭环**：#121 明确保留旧 DTO/OpenAPI。当前 intake 仍缺 `Idempotency-Key`、响应没有 `buildId`、仍暴露 `mode`，Swagger 仍描述“有站诊断”分叉。必须以 [07 目标契约](../site-builder/07-api-contract-draft.md) 做 **R0 contract closeout**，完成后才能把 R0 标为完成。
- **DOC-12 状态**：#119/#120 已把主要内容分发进 00–14 并登记 ADR-013~019；v3.1/v3.2 已降为 dated proposal。此前把“内容分发”写成“全项目真值已收口”过早；2026-07-16 truth-sync 已纠正权威层与接入文档，未把旧 Word/研究稿升级为权威。
- **当前关键路径**：R0 contract closeout → **R1-safety**（临时/构建清理、renderer 子进程 env allowlist）→ **R2-A 拆分交付**（Asset / KB / Profile / integration gate）→ **MF-0-thin** → **M1-c 纯 Sharp**。R1-min 其余原子预览与 unknown component fail-closed 可并行；R2-A 不得做成 schema/API/Outbox/Temporal/迁移一体的 mega PR。
- **已拍板、尚按消费者推进**：26 型封闭组件库（ADR-015）· 模型档四态路由（ADR-016）· MF-0 薄媒体地基（ADR-018）· Readdy 净室参考（ADR-019）· 不可变 Release（ADR-013）。ACCEPTED 不等于已实现。
- **协同事实源**：[00-decisions-and-coordination.md](../site-builder/00-decisions-and-coordination.md)。承重决策只认 [ADR 注册表](../adr/registry.md)，施工序看 [09](../site-builder/09-m1-implementation-design.md)。

---

## 真实具备（获客快照·冻结 2026-07-13；9 组，均有当时的真实数据验证记录）

企业理解（Claim/Evidence/冲突/人审）· ICP（规则/回测/查询计划/CPV/FDA 映射）· 发现（public_web/wikidata/OSM/名录/展会/TED/openFDA）· 富集（GLEIF/Wikidata/数字足迹/结构化收割）· 采集监控（4 表+增量 diff）· 买家信号（**一等 Signal**：`source_signal` 平台表两层模型 + `signal_ingest` ingest-once 账本（指纹×6h 窗跨 workspace 只拉一次）+ 状态机（EXPIRED/REVOKED 剔除、撤即脱敏）+ 可复算投影（recompute 同过滤面）；web_watch/TED 招标/510k 清关/决策人/smtp_self）· 资格（六维评分 + **demand_proof 观测维**（需求证据类事件驱动，不进总分待乘法门 backtest）/Reachability 硬门/四队列/人工裁决）· **事件交付**（LeadQualified 快照 v1 契约（demand_proof 已填真值，rule=additive-6dim-v2）/`outbox_delivery` 账本/`GET /events` 拉取+ACK/可选 HMAC webhook）· 平台地基（JWKS 座/RLS/Outbox/Temporal 4 Schedule/模型网关/API 门户 + **统一信封契约**：code-first openapi.json 单一真值、CI 契约三道门 + **ToolBroker 唯一执行闸门**：13 个 L0 工具收编全部主链出网、source_policy fail-closed 分层、预算 reserve-then-settle 真拦截、ExecutionContext 贯穿真租户归账）。

## as-built 缺口（8 项，已核验；#1–#5 已修，#7 大部完成；剩 #6/#7 follow-up/#8）

见 [../architecture/current.md](../architecture/current.md) §8。**#1 Fit 聚合根已修（PR #43，收口①完成）**；**#2 Broker 非唯一闸门已修（PR #51，收口②完成）**——13 个 L0 工具收编 22 处直连出网（发现/富集/intent/采集/理解五链全经 `broker.invoke`，例外四类登记），source_policy `required|advisory|none` 分层 fail-closed + 用途门按调用 purpose 判，预算真开账（run/sweep 开关账 + LLM 网关 reserve-then-settle 按 token 折算 + 截断显性化 run 转 PARTIAL），伪 workspace 清零、AI trace 真库实证写入成功；**#3 Outbox 假发布已修（PR #46，收口③完成）**——LeadQualified 现以快照 v1 契约经交付账本真实交付，未注册事件 parked 不再假发布；**#4 OpenAPI 双源已修（PR #48，收口④完成）**——统一信封定稿（`{data}`/`{data,page:{next_cursor,has_more}}`/`{error}`），旧 YAML 删除、契约唯一真值=code-first `openapi.json`，CI contracts job（drift+spectral+oasdiff breaking，label 放行）拦截破坏性变更；**#5 Intent 非一等事实已修（PR #56，收口⑤完成）**——`source_signal` 一等信号表（零个人数据、双时间轴、状态机+TTL）+ `signal_ingest` ingest-once 账本（同源同参同 6h 窗跨 workspace 只拉一次），TED/openFDA 投影反转为只读平台表、sweep 四段化，`attributes.intent` 降为可复算投影（recompute surfaces 同过滤面 + mergeIntent epoch 归一），快照 demand_proof 真值填充（v1 槽位零破坏，rule→additive-6dim-v2）。

**收口⑤记档项**（不阻塞）：ingest PENDING 抢锁根治（TOCTOU 双拉窗口，ERROR 覆盖 OK 已修）· TED CPV 前缀列+GIN 下推（现扫描窗打满有显性告警）· 投影 maxCompanies 游标化（现 subjectsTruncated 可观测，与缺口#8 同类）· license 值 SPDX 统一（随收口⑥ 权利词表）· SUSPENDED=停采不停用两级撤停语义已文档化（存量处置=revokeByProvider）。**#7 存储合规主体已修（收口⑥，PR-A #60 + 后续删除编排）**——`DataRightsService` 7 动作确定性引擎 + jurisdiction_policy(含 PIPL) + policy_decision_log/lia_record/article14_notice + PII 列级加密 + DB 角色拆分；`deletionWorkflow`(GDPR Art.17 冻结→擦除→重评分→回执) + `deletion_request`(状态机 RLS) + `deletion_receipt`(append-only + FK RESTRICT 防级联删) + `POST/GET /deletion-requests` + 事务性 outbox 起编排 + DeletionCompleted 事件。历史 DSR 全链演练记录保留在 changelog/PR；当前测试状态以实际 CI 为准。

仍需诚实登记：**#6** 身份图最小版（merge/split/回放）未落；**#7 follow-up** 的 consent/retention sweep/roles→scopes 仍待；**#8** 跨-sweep 游标公平性仍待。获客恢复商业试点前，还须满足 [release-plan](../roadmap/release-plan.md) 的真实企业 E2E/UAT 与“输出被下一能力真实消费”封版条件。

## 与 PRD v3.0 的登记偏差（8 条，不再静默）

new-api 替代 LiteLLM · 全 TS 无 Python worker · 不用 BullMQ · 自建 ai_trace 替代 Langfuse · OPA 未上（PolicyPort 过渡）· 免费源优先替代付费瀑布 · AiToEarn/触达不在本仓 · recommended 队列门（总分≥0.55 且 Reachability>0）为 PRD 缺位的实现口径。

## 待拍板（3 项 + 1 已落地）

1. ~~制裁名单筛查立项~~ **✅ 已落地（#104，2026-07-14）**——OFAC(SDN+Consolidated)/EU FSF 公司实体筛查作 qualify 第五门，命中→`sanctions_hold` + decide 硬拦，默认 DISABLED（翻 ENABLED 免 LIA=不物化 PII）。ADR-010 已更新记档。
2. **DLP 提单前提核实**——「海关提单」免费方案的前提（DLP FOIA 数据集可再分发）疑似 2023-04 已被拒。需人工上 data-liberation-project.org 核实（10 分钟），结论记入本文件。R3 排期前完成。
3. **两份 v3.0 Word 最小整改**——修撞号/损坏标题/声明重复章节以 PRD 为准/裁决 M2 口径（QGO vs SAO）。1-2 天，建议 C+Claude 做、用户验收。与交付包「冻结 v3.0」不冲突（只修结构便于迁移引用）。
4. **首发 Job 二选一**——进口商/采购商发现 vs 经销商招募。现有数据源覆盖明显偏向前者（TED/openFDA/提单/web_watch 求供应商页）。建议：**首发「进口商/采购商发现」**，经销商招募 R3 用 Pack 加入。

**需 A/B 会签（用户方向已认）**：PDR-001 对象词典 / PDR-002 业务层级（GrowthInitiative）/ 三接缝契约 / 对象级 RACI。
