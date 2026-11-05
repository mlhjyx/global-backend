---
date: 2026-11-05
pr: 814
title: Use a lazy Temporal connection so the writer identity can start workflows
---

- 起因：P4-P4c 的 `PlatformTemporalClient.connect` 用 `Connection.connect`，SDK 会先调 `GetSystemInfo` 做连通性预检；schedule-writer 身份在平台授权器只被允许 `StartWorkflowExecution`，预检被拒（`PLATFORM_TEMPORAL_READER_AUTH_DENIED`），`requestCrawl` 在真机里恒 503。现有单测直接覆盖私有 `connect`，碰不到真实 SDK 工厂选择（与 #812 同型：假对象单测掩盖真实路径；本次由真机验收链条抓出）。
- 改动：改用 `Connection.lazy`（无预检；失败由既有收敛与下次重连逻辑处理），并在代码旁注释钉住原因；新增 mock SDK 的回归守卫 `platform-temporal-lazy-connect.spec.ts`（断言走 `lazy`、绝不用 `connect`）。
- 测试：新 spec 红→绿；`gctl check --fast` 通过。真机验证随下一班镜像：writer token 连上平台 → `startWorkflow` 成功 → `source_channel_run` 落库。
- 未做：不改平台授权器（writer 的最小权限面保持 `StartWorkflowExecution`）；不升级 `@temporalio/client`。
