# B3 落地设计 · stale-run 看门狗 + workflow 总时限 + finalize 加固（2026-11-08）

> 生命周期：`APPROVED`
> 生命周期依据：交接总纲 WP B3（产品负责人 2026-11-08 批准 Phase 1 顺序）与协调计划 §0.7-H 审计 F2/F12；活体证据：run `1541ffd9`（2026-11-07 19:12 UTC，平台鉴权事件致 worker 排空后取消请求永不生效、DB 永远 RUNNING，发车硬窗口被迫人工对账；归档 `_archive/backend-runtime-switch-99845741-xin-20261107/README.md`）。

## 1. 目标

1. **不允许再出现「DB 永远 RUNNING、需要人手改库才能发车」**：任何 `discovery_run` 处于 RUNNING 超过租约+余量（215 分钟）后，由周期看门狗自动收尾为 FAILED（`stats.failure.stage='watchdog'`），并保留 run_event 记录。
2. **workflow 总时限**：所有 discovery 启动路径显式设置 `workflowExecutionTimeout=215m`（租约 180m + finalize 余量 10m + 25m 缓冲），Temporal 超时终止后，DB 行由看门狗（或正常 finalize 先行）收尾；取消请求永不生效的僵尸实例因此不可能存活超过时限。
3. **finalize 单点加固（F12）**：看门狗复用 finalizeRun 的写一次事务语义（只允许 RUNNING→FAILED、幂等、并发安全），finalize 自身失败/未执行时始终有兜底路径。

## 2. 设计

- **常量**（新 `apps/api/src/temporal/discovery-run-lifecycle.ts`，非 workflow 文件，不参与重放契约）：
  - `DISCOVERY_RUN_EXECUTION_TIMEOUT = '215 minutes'`（relay 启动参数）；
  - `DISCOVERY_RUN_STALE_AFTER_MS = 215 * 60_000`（看门狗阈值；> 租约 180m + finalize 余量 10m，且 ≥ 执行时限，不会误杀合法 run——过租约后任何阶段都只允许收尾）。
- **看门狗**（新 `stale-run.workflow.ts` 的 `staleRunSweepWorkflow`，挂 customer sweeps 调度器，默认每 10 分钟、执行时限 5 分钟）：
  1. `listStaleDiscoveryRuns({ staleAfterMs })`：查询 `status='RUNNING' AND created_at < now() - staleAfterMs` 的 run（workspaceId/runId/planId/icpId/createdAt），每轮上限 50。
  2. 逐个 `finalizeStaleDiscoveryRun({ workspaceId, runId, planId, icpId })`：写一次事务——行锁后仅当仍 RUNNING 时更新 `status='FAILED'`、`stats.failure={stage:'watchdog', errorType:'DISCOVERY_RUN_STALE', control:false}`（合并既有 stats），`completed_at`；写 `run_event`（type=`run_finished`，payload 标注 watchdog）；同事务写 outbox `DiscoveryRunCompleted`（cost 按 usage_ledger 尽力归属，见 §4 取舍）与（fit 已判时）`QualifyRequested`（复用 finalizeRun 的评分衔接口径）；plan 保持 READY。
  3. 单个 run 收尾失败不阻塞其余（逐 run try，聚合失败数返回）。
- **relay**：`DiscoveryRunRequested` 启动参数加 `workflowExecutionTimeout: DISCOVERY_RUN_EXECUTION_TIMEOUT`（与 dev fast lane 的 215m 对齐）。
- **调度注册**：`understanding.constants.ts` 增 `DISCOVERY_STALE_RUN_SWEEP_WORKFLOW/_SCHEDULE_ID`；`sweep-scheduler.service.ts` 的 `CUSTOMER_SWEEPS` 与 `ensure-schedules.ts` 各注册一条（env `DISCOVERY_STALE_RUN_SWEEP_EVERY`，默认 `10m`）；`workflows.ts`/`customer-workflows.ts` 导出 workflow。

## 3. 测试

- workflow 单测（mock activities）：有 stale run → 逐条 finalize；无 → 不调度；单条失败 → 其余继续且结果计入 `failed`；阈值参数透传。
- activity 单测（fake prisma）：list 的 SQL 条件（status RUNNING + created_at 阈值 + limit）；finalize 的写一次语义（RUNNING→FAILED + 事件 + run_event；已 FAILED → no-op；已在跑并发 → 行锁后状态重查）。
- relay 单测：DiscoveryRunRequested 启动参数包含 `workflowExecutionTimeout: '215 minutes'`（managed 与 dev fast lane 两路径）。
- 调度表单测（若既有 spec 覆盖 `CUSTOMER_SWEEPS`，补一行断言）。
- 验收（对主会话/产品负责人）：修复镜像上线后，把一条 RUNNING run 的 created_at 回拨 >215m（或等真实僵尸出现）→ 下一个 10 分钟节拍内自动 FAILED（stats.failure.stage=watchdog），无需人工改库；发车窗口不再被 RUNNING 行卡住。

## 4. 取舍与已知风险

- **成本归属**：僵尸 run 的 finalize 无法重建执行预算账户键（binding 只在启动方内存里），`DiscoveryRunCompleted.cost` 会按 runId 兜底匹配（通常为 0）——该 run 的花费仍在 `usage_ledger` 里可查，SaaS `cost_ledger` 会少记这一条僵尸。B10（成本三账对齐）会统一口径。相比「永远 RUNNING」，接受该代价。
- **不探测 Temporal describe**：v1 只看 DB（阈值 ≥ 执行时限即等价「租约已过 + 无活动租约」）。执行时限保证新 run 不可能超时仍存活；旧在飞 run 由同一阈值兜底。基于 describe 的提前收尸（closed execution 立即收）留作后续小步（需要 worker 侧 Client 依赖）。
- **合法长 run**：过租约 180m 后所有阶段只允许收尾（discovery-run-lease.ts），215m 阈值不会误杀。
- 取消语义：看门狗写 FAILED 后，若原 workflow 之后醒来尝试 finalize CANCELLED/DONE，会命中「已终结」冲突而非覆盖——写一次语义保证终态不被改写。

## 5. 回退

纯代码 + 一条调度注册；回退=revert（未消费的 run 由既有路径处理；已被看门狗收尾的 FAILED 行为与手工对账一致）。
