---
date: 2026-11-01
title: Surface failed website understanding and let it be retried
---

- 起因：2026-11-01 一个真实租户的官网理解因模型网关 429 突发失败后，档案停在 `DRAFT`，接口与 GainOS 界面都无法区分「排队中」和「已失败」，也没有重试入口；原创建工作流的 3 次快速重试在约 3 秒内耗尽。
- 改动：
  - `GET /companies`（列表/详情）返回 `understandingFailedAt` / `understandingLastError`，失败可见；
  - 新增 `POST /companies/:companyId/understanding/retry`：只允许对「最近一次理解失败、仍为 DRAFT」的档案重试，必须带**新的** workspace Execution Budget Grant（quote operation `POST /companies/:companyId/understanding/retry`，purpose `understanding.run`、subject 为 company），成功后重新入队 `understandingWorkflow`；
  - understanding 工作流的模型活动重试改为 5 次、5s 起指数退避（最长 60s），对 429 突发提供约 75 秒覆盖。
- 测试：company 服务重试守卫与事件载荷单测；quote/scope/envelope 三处契约用例补 retry operation；`gctl check` 全绿。
- 未做：跨模型/渠道 fallback（仍需单独立项）；GainOS 侧重试入口在 gain-saas 仓单独 PR。
