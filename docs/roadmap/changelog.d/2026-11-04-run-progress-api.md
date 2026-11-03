---
date: 2026-11-04
pr:
title: Expose incremental run progress (events by seq, per-company job queue, run taskRef)
---

- 起因：Run 2.0 的深挖是逐家推进的长过程，界面要能按 seq 增量看到进度、逐家状态与失败码（设计 §6.3/§12：3 秒轮询、事件可重放）。
- 改动：
  - `GET /discovery-runs/:runId/events?after=<seq>`：append-only 进度事件增量拉取（返回 nextAfter，断点续拉/重放）。
  - `GET /discovery-runs/:runId/jobs`：公司级队列（stage/粗判/精判/失败码/耗时，含公司名与域名，游标分页）。
  - `GET /discovery-runs/:runId` 增 `taskRef`/`phases`/`mode`；接口门户补两条操作说明。
- 测试：事件增量/空闲轮询/未知 run/队列分页四条单测；OpenAPI 重生成（87 paths）；docs:verify、governance:verify。
- 未做：事件 90 天保留期清理（M0⑥）；首页角度聚合事件（按 seq 全量可重放已满足）。
