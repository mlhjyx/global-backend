---
date: 2026-11-09
title: Enrichment waterfall with attempt ledger, circuit breaker and budget port
---

- 起因：P1-08——finder 适配器（P1-07）只解决「怎么调一家」，富集瀑布要解决「按什么顺序买、什么时候停、不重复买、怎么熔断与计费」。
- 改动：
  - 迁移 `20261109180000_contact_enrichment_attempt` + `ContactEnrichmentAttempt` 模型：每次 finder 调用一行（hit/miss/error/skipped_* 都记、成本 micro-USD 照记）；唯一键 `(workspace, provider, request_hash)` 是幂等键；RLS 租户隔离（app_user SELECT/INSERT/UPDATE，email_state 回填用）。
  - `waterfall/enrichment-attempt.ts`：幂等写入（P2002 → SAVEPOINT 回滚 + 回读）与三层复用口径——同输入版本 hit 90 天 / miss-error 24h；同联系人同 provider 的最近 hit 90 天（「90 天内不重复购买」）。
  - `waterfall/circuit-breaker.ts`：15 分钟窗口错误率 >20%（≥5 样本）或连续 5 次失败 → OPEN 15 分钟；到期放 1 个探针（成功 CLOSED、失败重开）；状态存 `data_provider.config.circuit`，存储故障不阻断主链。
  - `waterfall/enrichment-budget.ts`：reserve/settle 端口 + CapBudget（默认 $0.15/联系人）+ CompositeBudget（run 与单联系人取最紧）；P1-10 以 ExecutionBudget Grant 注入同一端口。
  - `waterfall/enrich-contact-email.ts`：编排器——合规前置（contactMayUseExternalProcessing）→ 逐家 finder（data_provider/source_policy 门 + 熔断 + 本地复用 + 预算）→ 命中先验证（双正瀑布；抑制与 lawful-basis 验证门）→ 同事务写入（`upsertProviderEmailPoint` 新写入器 + 每步事件账 + 状态机回写 + attempt.emailState）。停止规则：每联系人 finder ≤3 家、验证 INVALID 继续下一家、UNKNOWN 落库即停并进 24h 重验队列；全部 miss → not_found。
  - `enrichment/provider-gates.ts`：data_provider + source_policy 前置门从再验证 sweep 抽出共用（finder 与验证器同口径）。
- 测试：39 条新单测（attempt 账 TTL/幂等、熔断开合与探针、预算 reserve/settle、编排器 13 个场景：命中双正、INVALID 续买、UNKNOWN 即停、≤3 家上限、预算/熔断/门禁/复用/抑制/无验证器）；enrichment 全套 180 用例绿；漂移门（一次性库重放）零未登记差异；build/docs:verify/governance-verify 通过。
- 未做：HTTP 端点与 run activity 接线（P1-10，含 execution-budget purpose `contact.enrich`）；Apollo/PDL（P1-09）；真实 key 与 scorecard 后翻 ENABLED 是用户决策。
