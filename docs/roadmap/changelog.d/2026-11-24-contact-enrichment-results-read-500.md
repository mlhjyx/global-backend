---
date: 2026-11-24
pr:
title: Read settled enrichment results whose receipts omit the charged amount
---

- 起因：真实窗口 C1 上，已结算 Hunter finder 步骤的结果读取 500（`EnrichmentSafetyError INVALID_PLAN`）：`metadataMoney()` 要求 `receipt.usage.chargedMicrousd === step.budget_charged_microusd`，而 artifact-ref 的 `estimated_upper_bound` 用法只有 `upperBoundMicrousd`，charged 只记录在账本步骤上。
- 改动：SETTLED 步骤的 usage 缺 `chargedMicrousd` 时，改为用账本 charged 字段按 `estimated_upper_bound` 与 upperBound/quote 校验（账本 charged 必须等于 quote）；仍拒绝 charged > quote、upperBound ≠ quote、非 `estimated_upper_bound` 却缺 charged、以及 usage.charged 与账本不一致。未放宽金额一致性不变量，未改 OAS、provider env 或结算路径。
- 测试：单测覆盖 finder artifact-ref 结算、typed-projection verifier 结算、RELEASED/未开票步骤、负控（charged>quote、upperBound≠quote、usage.charged 不符、缺 receipt 的保守路径）；真实 PostgreSQL 用已结算 finder 账本行经 `EnrichmentExecutionQueryRepository` 读取后断言 charge；回退修复时单测与 PG 用例均转红。
- 未做：未部署、未改 OAS/env；真实窗口的 GET 200 复验在发布后执行。
