# B4 落地设计 · RESERVED/RESULT_UNKNOWN 清收器归位（2026-11-08）

> 生命周期：`APPROVED`
> 生命周期依据：交接总纲 WP B4（产品负责人 2026-11-08 批准 Phase 1 顺序）与协调计划 §0.7-H 审计 F1（清收器挂错 sweep、workspace 枚举错误）+ B2 留下的「B4 前 RESULT_UNKNOWN 无人清收」窗口。

## 1. 问题

- `#801` 的超时 RESERVED 清收挂在 **raw-retention sweep** 上：workspace 枚举只看 `raw_source_record` 是否当下到期（`list_due_raw_retention_workspaces_v1`），且 retention 批次不完整会先抛错跳过清收——**真实库里所有存量孤儿都落在枚举之外**，一条也没被释放。
- B2 起 settle 双败会把行先标 `RESULT_UNKNOWN`；现有清收函数只处理 `RESERVED`，`RESULT_UNKNOWN` 行在当前窗口内无人清收（文档已标注）。
- 阈值 24h 过长（最长活动 30 分钟 × 2 次尝试 + 余量，2 小时已足够）。

## 2. 设计

1. **独立枚举（SECURITY DEFINER）** `list_workspaces_with_unresolved_tool_budget_v1(p_older_than_hours, p_limit)`：直接按 `tool_budget_operation`（status IN ('RESERVED','RESULT_UNKNOWN') AND created_at < now() - interval）枚举 scope_key（即 workspace），与 raw_source_record 无关；app_user-only 守卫、search_path `pg_catalog, public, pg_temp`、参数范围校验。
2. **RESULT_UNKNOWN 保守结清（新函数）** `settle_unknown_tool_budget_operations_v1(p_workspace_id, p_older_than_hours, p_limit)`：把超过阈值的 `RESULT_UNKNOWN` 行**按预留额保守结清**（observed=charged=reserved_microusd，status→'SETTLED'，settled_at=clock_timestamp），同步 `tool_budget_account.reserved_microusd`/`charged_microusd`；同样 workspace 守卫 + SKIP LOCKED + 逐账号 advisory lock（与 settle/release 同锁序）。
3. **独立 sweep** `toolBudgetReconciliationWorkflow`（客户侧 sweep 调度器，默认每 1 小时、执行时限 30 分钟、批 50）：枚举 → 逐 workspace：
   - `reconcileStaleToolBudgetOperations`（既有活动，阈值改为 **2h**，继续释放「预留后未出网」）；
   - 新增活动 `settleUnknownToolBudgetOperations`（新函数封装）。
   单条失败不阻塞其余；全部失败以 nonRetryable 暴露（同 B3 口径）。
4. **从 raw-retention 摘除**：`raw-retention.workflow.ts` 的清收步骤用新 patch `budget-operation-reconcile-moved-v1` 守卫移除——新历史不调度 `reconcileStaleToolBudgetOperations`；旧历史（无 patch 标记）照旧重放（命令序列不变）。
5. **可观测**：run 级无 run 上下文——sweep 返回 `{workspaces, released, settledUnknown, failed}`；全部失败抛错；`gctl doctor` 不加新项（如需告警可在 B10 三账对齐时统一）。

## 3. 测试

- 迁移函数（一次性 PostgreSQL 实测）：枚举只返回含未结行的 workspace、阈值生效、参数/NULL 守卫、`settle_unknown` 行状态/账号余额变化、SKIP LOCKED 并发安全（顺序断言）。
- sweep workflow 单测：枚举→逐 workspace 两活动、失败隔离、全失败 nonRetryable。
- 活动单测（fake prisma）：两函数的 SQL 形态与返回映射。
- raw-retention replay：新 patch 后新历史不再调度 reconcile；**旧历史重放通过**（既有 replay spec 或新增）。
- 既有 raw-retention spec 更新（默认路径不再含 reconcile）。

## 4. 取舍

- RESERVED 阈值 24h→2h：更早释放「预留后未出网」，但若某活动仍在其重试预算内（最长约 65 分钟），释放后同 key 重试会走 RELEASED 再预留（迁移 20261015045032，attempt+1）——语义安全。
- RESULT_UNKNOWN 保守结清按预留额（上限）计费：宁可略高估不可漏记；精确工件回读路径（loadResultUnknownArtifact）仍保留给调用方在活动生命周期内自救。
- raw-retention 的公开行为变化（不再清收预算）：进 changelog；旧历史 replay 由 patch 保证。

## 5. 回退

纯代码 + 两条函数迁移；回退=revert（函数可保留，被删的 raw-retention 步骤由新 patch 守卫，回退后新历史走旧分支）。
