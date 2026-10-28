---
date: 2026-10-28
pr: 690
title: Run a plan's queries two at a time
---

- 起因：查询阶段是 run 里最耗时的一段（#43 的 10 条查询约 45 分钟、#41 的 21 条 55 分钟仍未跑完），workflow 里严格逐条 `await`，而每条查询是「SearXNG fan-out + 逐域名模型调用」，大部分时间在等网络。
- 改动：`discovery.workflow.ts` 的查询循环按批 2 条并发（`Promise.allSettled`），并用新 patch `DISCOVERY_QUERY_BATCH_PATCH` 守卫——旧历史重放仍走原逐条路径。计数与顺序不变：结果按计划顺序折叠进 totals；一条查询普通错误在 `DISCOVERY_QUERY_FAILURE_STOP_PATCH` 下仍停止 run（同批另一条已在飞，可能已花掉）；不可重放的交接语义改为「上一批全部丢源」才告诉下一批。
- 测试：`workspace-authority.workflow.spec.ts` + `discovery.rehearsal.spec.ts` 共 99 例全绿——新增「批内两条同时在飞」用例（第一条阻塞时第二条必须已发出）；四处不可重放交接用例按批语义更新（同批无交接、整批丢源才传递、批内混合不传递、控制错误时同批两家可能都已调用）。
- 未做：并发度写死 2；`executeQuery` 内部的模型/出网并发不变（已是 5 路抽取），峰值约 10 路模型调用，先观察上游错误率再评估 3。
