---
date: 2026-11-25
pr: 1096
title: "fix(relay,compliance): Batch 1.3-B 修复 Outbox 队头阻塞/Webhook 安全与 GDPR Art.14/LIA 编排"
---

- 起因：`OutboxRelayService.tick()` 在连续 20 条 internal command 派发失败时会反复占据 `take: 20` 造成队列队头死锁；`pumpWebhookDeliveries` 未设置 `redirect: 'error'`、整批共用过期 `now` 时间戳且未取消释放响应体流；EU/UK 间接采集自然人数据缺少 `Article14Notice` 30 天排期/履行与 `LiaRecord` 查验编排服务。
- 改动：
  - 新增 `relay/outbox-retry-guard.ts` 并在 `OutboxRelayService` 接入有界指数退避 `OutboxDispatchBackoff`（5s→5min、上限 1000 条）以在失败冷却窗口内绕开毒事件防止队头饿死，同时提供可选多副本 PG 咨询锁 `tryWithOutboxAdvisoryLock`；
  - 硬化 `pumpWebhookDeliveries`：强制 `redirect: 'error'` 防 SSRF 重定向、逐条刷新签名与交付时间戳、每次请求释放 `res.body?.cancel?.()` 防止套接字泄漏；
  - 新增 `compliance/article14-lia.service.ts` 并注入 `ComplianceModule`：提供 EU/UK 自然人 30 天 `Article14Notice` 幂等排期与首联 `FULFILLED` 履行、按 `contact → company → workspace` 逐级检索有效 `LiaRecord`、以及 730 天 `canonical_contact` 留存到期扫描辅助；同时在 `jurisdiction-policy.seed.ts` 将 EU/UK `red` 的 `STORE`/`OUTREACH` 行标明 `article14Required: true`。
- 测试：新增并全量通过 `outbox-retry-guard.spec.ts`、`outbox-routing.spec.ts`、`outbox-dev-fast-lane.spec.ts`、`article14-lia.service.spec.ts`、`jurisdiction-policy.seed.spec.ts`、`data-rights.engine.spec.ts`；通过 `G9/G15/G16/G17`、`execution-authority-policy`、`nest build`、`eslint`、`docs:verify`、`benchmark:discovery` 与 `gitleaks`。
- 未做：`gain-saas` 侧外联 8 连环 Bug 与 Ring-1 P0 安全/事件/配额修复在 `gain-saas` 仓库独立推进。
