---
date: 2026-11-08
title: Collect unresolved tool-budget operations in an independent sweep
---

- 起因：审计 F1——超时 RESERVED 清收挂在 raw-retention sweep 上，workspace 枚举只看 raw 记录是否到期，真实孤儿全部漏收；B2 起 settle 双败留下 RESULT_UNKNOWN，无人清收。
- 改动：
  - 新迁移 `20261108150000_tool_budget_unresolved_collector`：`tool_budget_operation` 增 `unresolved_since`（触发器在进入 RESERVED/RESULT_UNKNOWN 时刷新，D13 再预留因此重新计时）+ 部分索引；`list_workspaces_with_unresolved_tool_budget_v1`（游标分页、只收租户 UUID 作用域、app_user 守卫）；`reconcile_stale_tool_budget_operations_v2`（释放 RESERVED，按 unresolved_since、只碰 microusd 行、先账户 advisory 后行锁）；`settle_unknown_tool_budget_operations_v1`（RESULT_UNKNOWN 按预留额保守结清，账户 reserved→charged 同步）。
  - 新 sweep `toolBudgetReconciliationWorkflow`（每小时、30 分钟时限、游标翻页 ≤4 页）：两个 SINK 独立 try（释放失败不连带跳过结清）、回执严格校验、部分失败 console 告警、全部失败 nonRetryable。
  - raw-retention 用新 patch `budget-operation-reconcile-moved-v1` 停止调度预算清收（旧历史重放不变）；其 `maxBudgetReconcileBatches` 输入保留（旧历史重放需要）。
- 测试：一次性 PostgreSQL 实测（unresolved_since 触发、游标、microusd 过滤、SETTLED 金额、账户余额、守卫）；workflow 6 例 + 活动 5 例 + 迁移静态契约 6 例；既有 raw-retention 重放用例更新。
- 未做：cent 单位的遗留未结行与平台作用域（非租户 UUID）孤儿不在本清收路径内（迁移注释已登记，随 B10 三账对齐处理）。
