---
date: 2026-11-04
pr: 794
title: Keep a busy event loop from draining the worker on live dependencies
---

- 起因：2026-11-04 影子验收 run `768638fc` 的抽取负载把 worker 事件循环压住，依赖心跳的模型网关探测（2 秒硬超时）连续 3 轮假阳性超时，worker 以 `MODEL_GATEWAY_UNAVAILABLE` 立即排空（lease `WORKER STOPPED`）；工作流下一个 workflow task 在 `understanding` 队列无人取，run 保持 RUNNING 无任何推进，直到人工重启容器。
- 改动：
  - `worker-dependency-heartbeat.ts`：探测前采样事件循环滞后，滞后 ≥1s 时跳过该轮（不计失败、不探测）；采样器可注入。
  - `managed-dependency-readiness.ts`：模型网关探测超时 2s→10s。
  - 测试：滞后跳轮与探测超时两个新用例；相关套件 140 passed。
- 测试：`vitest run` 两个 spec 45/45；`vitest related` 140 passed / 8 skipped；`nest build` 通过。
- 部署：需随下一班车发布新运行时镜像；现网已人工重启 worker 恢复。
- 未做：依赖真失联时的自动恢复（排空仍为 fail-closed，需重启容器）不变，另开工单讨论。
