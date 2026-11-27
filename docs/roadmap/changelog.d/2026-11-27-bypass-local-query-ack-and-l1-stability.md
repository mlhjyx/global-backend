---
date: 2026-11-27
pr:
title: 修复 bypass 模式本地源回执报错、L1 信号约束与 http.get 并发限流
---

- 起因：现网 14:06 寻源 run `39460c75` 在 `bypass` 模式下命中本地源 `channel_catalog` 后，`executeQuery` 把其自造的 `local_query` 回执传入旧版 `applyDomainAckConsumerTransactions`，触发 `ExecutionControlError: DOMAIN_ACK_CONSUMER_BINDING_MISSING` 中断（`registry_frame` 同理）；同时 13:54 run `601983b1` 在 L1/L2 现网日志中暴露两处隐患：流式 L1 写 `company_signal` 使用 `hiring_page`/`job_posting` 违反库约束 `company_signal_signal_kind_check`（仅允许 `rss_item`/`page_change`），且 `http.get` 全局并发 4（单租户 40% 份额仅 1）在 L1=8 / L2=4 下频繁触发 `RATE_LIMIT_ACQUIRE_TIMEOUT`。
- 改动：在 `discovery-query-governed-execution.ts` 抽离 `legacyDiscoveryQueryAcknowledgements`，`bypass` 模式下返回空回执数组（与 `ToolBroker` 的 bypass 行为一致，同时减少 `executeQuery` 圈复杂度与行数）；将 `discovery.streaming.activities.ts` 写入 `company_signal` 的 `signalKind` 统一修正为合法值 `page_change`；将 `source-tools.ts` 中 `http.get` 的全局限流池提升至 `rps: 20, concurrency: 25`（单租户份额 8 rps / 10 并发，保持单域名 500ms 抓取间隔不变）。
- 测试：新增 `discovery-query-governed-execution.bypass.spec.ts`、强化 `discovery.streaming.activities.spec.ts` 对 `signalKind='page_change'` 断言，跑通 `pnpm --filter @global/api build` 与全部推送前治理门禁。
- 未做：未修改 `company_signal` 数据库 `CHECK` 约束枚举，也未放宽单域名 `perDomainCrawlDelayMs: 500` 礼貌间隔。
