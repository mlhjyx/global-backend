---
date: 2026-11-27
pr:
title: 修复流式 L1 抓取权限拦截并提高 L1/L2 寻源上限
---

- 起因：现网流式寻源 run `4288c24e` 召回 228 家入池进入 L1 后，`raw-http-extractor` 以 `discovery.classify_trade_role` 契约调用 `http.get` 抓取 `robots.txt` 与官网 HTML，但该契约 `allowedTools` 遗漏 `http.get`，导致全部流式 L1 活动报 `ToolPolicyDenied`；同时流式寻源默认每轮 L1 上限仅 200 家、L2 联系人深挖 Top-K 仅 20 家，限制了召回后的判分与联系人产出。
- 改动：为 `discovery.classify_trade_role` 的 `allowedTools` 补齐 `http.get` 并同步更新契约快照哈希；`MAX_STREAMING_L1_COMPANIES` 从 200 提到 500；relay 仅在启动 `discoveryStreamingWorkflow` 时显式写入 `streamingL1Concurrency=8`、`streamingTopKCap=50`、`streamingL2Concurrency=4`（支持 env 覆盖并夹取到录制上界），不影响旧 `discoveryWorkflow` 参数契约与在飞 run 重放。
- 测试：`task-registry.spec.ts`、`raw-http-extractor.spec.ts`、`outbox-routing.spec.ts`、`outbox-dev-fast-lane.spec.ts`、`discovery.streaming.workflow.spec.ts`、`pnpm --filter @global/api build` 与全部推送前治理门禁。
- 未做：未调整 workflow 总时限与上游模型限流配额；并发提高后若上游 429 增多，再按通道配额微调。
