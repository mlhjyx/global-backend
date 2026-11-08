---
date: 2026-11-08
title: Add a stale-run watchdog and a total execution limit for discovery runs
---

- 起因：审计 F2/F12（P1）——discovery 默认路径没有 workflow 总时限、DB 侧没有 stale-run 收尾器：finalize 失败、取消竞态或 worker 排空后，run 会永久停在 RUNNING。活体证据：run `1541ffd9`（2026-11-07 19:12 UTC）在平台鉴权事件导致 worker 排空后取消请求永不生效，发车硬窗口被迫人工改库对账（归档 `_archive/backend-runtime-switch-99845741-xin-20261107/`）。
- 改动：
  - **总时限**：`DiscoveryRunRequested` 的启动参数显式带 `workflowExecutionTimeout=215m`（租约 180m + finalize 余量 10m + 缓冲，与 dev fast lane 对齐）；超时终止后 DB 行由看门狗收尸。
  - **看门狗**：新增 `staleRunSweepWorkflow`（客户侧 sweep 调度器，默认每 10 分钟）：经 SECURITY DEFINER 函数 `list_stale_discovery_runs_v1` 枚举「RUNNING 超过 215m」的 run，逐条 `finalizeStaleDiscoveryRun` 以写一次事务收尾为 FAILED（`stats.failure.stage='watchdog'`、`run_event` 留痕、`DiscoveryRunCompleted` 事件、fit 已判时照旧衔接 `QualifyRequested`）；单条失败不阻塞其余。
  - **finalize 加固（F12）**：看门狗复用 finalizeRun 的行锁+写一次语义——只允许 RUNNING→FAILED，重复/并发调用安全；原 workflow 之后若醒来尝试写其它终态会命中「已终结」冲突而非覆盖。
  - 迁移 `20261108130000_discovery_stale_run_watchdog`：新增 `list_stale_discovery_runs_v1`（app_user-only、参数范围校验、search_path 固定、只返回标识与时间）。
- 测试：workflow 4 例（逐条收尾/输入阈值/单条失败隔离/空集）；活动 3 例（函数映射、写一次事务的更新+事件+run_event、已终结 no-op）；relay 1 例（总时限参数）；调度器既有 spec 覆盖新条目。构建、lint、docs:verify、governance:verify 全绿。
- 未做：基于 Temporal describe 的提前收尸（closed execution 立即收，目前依赖 215m 阈值 + 执行时限保证）留作后续小步；僵尸 run 的 `DiscoveryRunCompleted.cost` 因预算账户键不可重建按 runId 兜底归属（通常为 0，真实花费仍在 usage_ledger），B10 三账对齐时统一。
- 部署：含迁移，需走硬窗口（`gctl switch-backend --with-migrations`）；看门狗调度由 sweep 调度器自动注册（`DISCOVERY_STALE_RUN_SWEEP_EVERY` 可调，默认 10m）。
