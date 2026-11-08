---
date: 2026-11-09
title: P3 J01 — judgment failure taxonomy v1 (failure-codes)
---

- 起因：ch04 §4.3.5 失败分类学（D4-6）。「45% 失败」无法按 stage×cause 归因，`COMPANY_PIPELINE_FAILED` 聚合码不可拆分，重试策略只能按消息猜。
- 改动：新增 `apps/api/src/discovery/judgment/failure-codes.ts`——8 个 stage、26 个版本化 cause、5 种 outcome 的闭集，每个 cause 带 `retryable` 与默认处置（retry/failover/degraded/failed/skipped）；14 个 `GATE_*` reason 闭集；未知 cause 查表 fail-closed（抛 `UNKNOWN_FAILURE_CODE`），只有显式 `normalizeFailureCode` 才落到 `UNKNOWN_UPSTREAM`；版本常量 `failure-codes/v1`，改表须升版本并同步 J02/J22 清单。
- 测试：`failure-codes.spec.ts` 6 例——映射 100% 合法、码集合快照、重试语义（429/5xx/超时/租约/事务可重试；预算/鉴权/证据类不可重试）、未知码 fail-closed、gate 码闭集唯一且与失败码不重叠。
- 未做：J02 管线失败归因接线、Temporal `nonRetryableErrorTypes` 清单、J22 值班 runbook（下一批）。
