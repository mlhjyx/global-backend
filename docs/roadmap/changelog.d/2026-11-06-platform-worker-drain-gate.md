---
date: 2026-11-06
pr:
title: Keep a verified capability snapshot through blips and recover drained workers automatically
---

- 起因：2026-11-05 发车 #822 时，一次约 30 秒的 gain-saas 能力快照抖动让 platform-worker 按 fail-closed 立即排空；排空后的进程没有退出，容器存活但不再轮询约 1 小时（租约表：19:20:15 排空后 63 分钟无新实例注册），平台工作流停摆直到人工重启。
- 改动：
  - `platform-capability-cache.ts`：刷新失败不再清空最后一份已验证快照；`check()` 仍按签发方 `validUntil`（≤30s）截止。
  - `platform-capability-runtime.ts`：普通刷新失败不再丢弃缓存对象；失败后 2s 快速重试，成功后回到 10s 节奏（身份/pin/机器令牌失效仍立即清空）。
  - `worker-shutdown-policy.ts`（新）：`shutdownGraceTime` 30s / `shutdownForceTime` 60s / 关停清理 15s 强制退出兜底；两个 worker 的 `Worker.create` 与 finally 接入。
  - 客户 worker：启动门改为覆盖完整依赖检查（`requireReady:false`），与 platform-worker 一致——重启后在 STARTING 等待依赖恢复并自动重新准入，不再永久 hold。
  - `worker-dependency-admission.ts`：迁移修订不一致改为 `drainImmediately`（读失联仍走 3 连败容忍）；两个 worker 的稳态检查接入。
  - `worker-dependency-heartbeat.ts`：排空时输出一条结构化事件（role/taskQueue/code/连续失败数/时间）。
  - `gctl doctor`：新增「运行租约」检查（最新非 READY 或心跳 >120s 警告；24h 内 STOPPED/DRAINING 信息行）；RUNBOOK §14。
- 测试：capability cache/runtime、heartbeat、dependency-admission、shutdown-policy 单测；`gctl check`。
- 未做：传输层对 gain-saas 401/403（鉴权拒绝/绑定过期）的独立危险码分级（后续项）；发车后的 90s 受控演练（需发车授权）。
