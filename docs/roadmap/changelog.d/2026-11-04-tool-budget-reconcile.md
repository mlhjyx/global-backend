---
date: 2026-11-04
title: Sweep stale RESERVED tool-budget operations in the raw-retention workflow
---

- 起因：巡检（2026-11-04）发现 `tool_budget_operation` 累计 298 条 RESERVED（最早 2026-10-09），没有对账/清收任务。超时未结算的预留是孤儿（活动崩溃/重启后再无人 settle/release）：既占住账户可用额度，又让同一 operation_key 的重试活动撞 `BudgetOperationReplayError`（近 7 天 6 个 run 因此失败，见 `discovery_run.stats.failure`）。
- 改动：
  - 新迁移 `20261104220000_tool_budget_operation_reconcile`：SECURITY DEFINER 函数 `reconcile_stale_tool_budget_operations_v1(workspace, olderThanHours, limit)`，按工作区把超时 RESERVED 释放（observed/charged=0、settled_at=now、账户 reserved_microusd 回补），与 `release_tool_budget_microusd_v1` 对 RESERVED 的释放语义一致；安全形状沿用 retention 模式（app_user + workspace 守卫 + 账户 advisory 锁 + FOR UPDATE SKIP LOCKED + pg_temp 末位 search_path）。
  - 该清理并入现有 raw-retention sweep（每工作区每轮最多 5 批 × 200 条），用 `budget-operation-reconcile-v1` patch 守卫——patch 前的旧历史重放不调度新活动。
- 测试：迁移静态契约 4 用例（事务边界/守卫/释放语义/仅 app_user 可执行）；raw-retention 工作流新增 2 用例（按工作区清收到无更多、patch 前不调度）；一次性库实测（模拟 app_user 会话：释放 1 条 200µUSD、账户 500→300、fresh RESERVED 与 SETTLED 不受影响、superuser 直调被 `TOOL_BUDGET_RECONCILE_DENIED` 拒绝）；`security-definer-search-path` 通过；全量 `@global/api` 单测。
- 未做：不处理「仍在生命周期内」的 RESERVED（阈值默认 24h，活动超时上限远小于它）；不做对账报表与告警（被清收的数量进 workflow 日志）；`BudgetOperationReplayError` 的调用侧语义维持 fail-closed 不变。
