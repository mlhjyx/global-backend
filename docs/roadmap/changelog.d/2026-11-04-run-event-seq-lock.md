---
date: 2026-11-04
title: Serialize run-event seq allocation with a per-run advisory lock
---

- 起因：2026-11-04 快扫+深挖真实验收（run 11923f12）在 16 并发深挖下暴露：`appendRunEvent` 在调用方事务内对唯一冲突（P2002）重试取号，但 PostgreSQL 把唯一冲突后的整个事务标为 aborted，事务内重试只会得到 25P02，且同事务里的 company job 阶段更新全部回滚——一家公司卡死在 profiling，finalize 计 `remaining=1`，run 收敛为 PARTIAL。当日 worker 日志共 49 次 25P02。
- 改动：
  - `appendRunEvent` 改为先取 per-run 事务级 advisory lock（`pg_advisory_xact_lock(hashtextextended('run-event:<runId>'))`）再取号，从源头消除并发冲突；删除事务内 P2002 重试（冲突无法在已中毒事务内恢复，任何数据库错误直接上抛，由外层事务重试）。
  - 同步更新函数注释与单测：新增「锁先于取号」「唯一冲突不在事务内重试」两个用例；`discovery.run2.activities.spec` 的 fake tx 补 `$queryRaw` 桩。
- 测试：`pnpm --filter @global/api test run-events`（4 用例）+ 相关 run2 活动/工作流单测；发布侧需在下一班镜像中复测深挖并发（本轮验收在 deepseek-flash 临时档上观测到该缺陷）。
- 未做：不改 run_event 表结构与读路径；不引入按 run 的独立 sequence。
