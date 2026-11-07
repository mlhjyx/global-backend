---
date: 2026-11-08
title: Classify deterministic ledger failures as non-retryable and mark unknown results
---

- 起因：审计 F5/F4（P1）——同一 operation_key 二次 reserve 必撞同一行（REPLAY），但该错误在活动边界仍可重试，Temporal 反复重试把整段活动从头再跑（2026-11-07 run 7662d391 空转约 95 分钟）；同时 settle 双败后行停在裸 RESERVED，一次 DB 抖动即可永久锁死 operation key。
- 改动：
  - 新增 `deterministic-ledger-failure.ts`（纯分类器）与活动边界拦截器：BudgetOperationReplayError / BudgetExceededError / BudgetAccountUnavailableError / BudgetUnsettledOperationsError / 投影拒绝错误 / ExecutionControlError 的确定性码 → nonRetryable（保留 type/code，`isExecutionControlError` 语义不变）；`*_UNAVAILABLE` 一律保持可重试。拦截器挂在 customer / platform / dev fast lane 三个 worker 上。
  - model 网关与 tool-broker 的 settle 双败路径：先尽力 `markResultUnknown`（兜底失败不掩盖主错误），再抛确定性 replay 错误；网关失败路径的 settle 补一次 ACK 丢失重试并记 ERROR trace（`budgetDisposition=RESERVED_SETTLE_FAILED`）。
  - 新增 `docs/backend/execution-budget-ledger-states.md`：RESERVED / RESULT_UNKNOWN / SETTLED（含无结果投影）/ RELEASED 四态的安全动作、清收者与可观测入口。
- 测试：分类矩阵（12 类确定性错误 → nonRetryable；6 类瞬时/普通错误不变）、cause 链包装、控制错误语义保持；拦截器 6 例；网关 settle 双败 3 例；broker settle 双败 2 例。四态矩阵沿用既有 store 测试（replay 重建、RELEASED 再预留、RESULT_UNKNOWN 读回）并在文档中逐态指到用例。
- 未做：B4 的独立清收器（孤儿 RESERVED 的阈值释放/保守结清）与 B3 的 stale-run 看门狗按 Phase 1 顺序另开 PR；本 PR 不含迁移与 schema 变更。
