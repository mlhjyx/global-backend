---
date: 2026-10-28
pr: 683
title: Drain the worker only after three consecutive dependency failures
---

- 起因：2026-10-27 17:06Z 一次结算回读探针的 2 秒超时（负载下的瞬时抖动，事后同一探针稳定返回 200/10ms）让 worker 永久停止 Temporal 轮询——`startWorkerDependencyHeartbeat` 对**任何一次**非 ok 都立即 drain。恢复只能重启容器，而重启杀掉在飞活动后，重试撞上「已预留、已消费、无持久结果」的预算操作键（`BudgetOperationReplayError`，控制错误），把验收 run `659f2320` 整条判 FAILED。
- 改动：心跳改为**连续 3 次（约 30 秒）失败才 drain**，任一次恢复即清零；启动阶段同样最多试 3 次（间隔 1 秒），全失败才拒绝 admission，瞬时抖动不再拒绝启动。结算回读探针的 `maximumProbeDurationMs` 2 秒 → 5 秒（仍在 10 秒心跳间隔内）。未在探针内部再加一次重试：心跳本身就是带间隔的重试，内部重试只会把最坏耗时翻倍。
- 测试：`worker-dependency-heartbeat.spec.ts` 重写为 5 个用例——单次抖动不 drain、连续三次才 drain、恢复后计数清零、启动期瞬时失败仍准入、启动期连续三次失败才拒绝准入、抛异常按失败计数；`managed-dependency-readiness.spec.ts` 36 例与两个 worker 装配 spec 全绿。
- 未做：预算操作的重放语义（D13，PR #597 挂起中）本次不涉及；drain 后自动恢复（不重启容器）不在本改动范围。
