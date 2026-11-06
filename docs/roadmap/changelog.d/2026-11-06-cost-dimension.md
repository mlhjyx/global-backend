---
date: 2026-11-06
title: Settle discovery run cost into events and bind discovery-stage artifacts to the seller profile
---

- 起因：`$15/30 天`花费上限因 `cost_ledger` 恒 0 实际未生效（1b 花费维度补口，设计 2026-11-06-cost-dimension-settlement）；同批真实 ICP 对比跑还暴露 discovery 阶段抓取被 G3 主体绑定闸门拒绝（directory 的 10 条查询因全部抓取被拒而零产出）。
- 改动：
  - `ai-trace.sink` 为 `usage_ledger` 补成本基准：provider 上报优先，否则按 `LLM_CENTS_PER_MTOK` 的 token 上界折算（`meta.costSource` 标注；`centsFromTokens` 抽到共享模块，与预算 settle 同口径）；已结算（非 `RELEASED_*`）的失败调用同样落成本行（`meta.status='ERROR'`），失败花费不再对上隐形。
  - 网关所有 trace 记录点透传 `ctx.runId`，sink 写入 `usage_ledger.meta.runId`；discovery finalize 按 `meta.runId` 汇总本 run 成本进事件载荷（`cost` + `costBasis=usage_ledger-runid/v1`），替代初版时间窗聚合（并发 run 双计 / 事务 now() 漏计，均为自审确认缺陷）。
  - discovery 阶段 ExecutionContext 绑定卖家 `company_profile` 作为 `artifactSubject`（`ArtifactSubjectRef` 明确允许该主体），修复 directory 等发现源抓取被主体绑定闸门拒绝、结构化源零产出的问题。
- 测试：token 折算单测、sink 成本基准（provider 优先/折算/标注/失败调用/释放不记）、finalize 载荷按 runId 归属断言（含 SQL 过滤条件）、发现阶段主体透传断言；目标套件与全量零容器单测通过。
- 未做：gain-saas 消费端成本落账与 `cost_ledger (workspace_id, source_event_id)` 唯一约束随另一 PR 提交（D-b/D-c/D-d 的 SaaS 半）；精确价目表列为后续项。发现阶段主体绑定的合规姿态（company_profile 非 DSR 主体）见 PR 讨论。
