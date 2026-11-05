---
date: 2026-11-05
title: Execute platform channel crawls on the platform worker (P4-P4c)
---

- 起因：P4 最后一段——Grant 能签发（#64）、围栏能放行（P4-P4a）、API 能以 writer 身份发起（P4-P4b），但还没有工作流把一次抓取真正跑起来；`requestCrawl` 仍是占位 409。
- 改动：新增 `channelCrawlWorkflow`（platform-automation，`understanding` 队列）与三段活动：**admit**（平台 worker 内经 mTLS 取 Grant → 验签/`ingest_and_admit_platform_channel_crawl_run_v1` 开户 → 只读 attest）、**run**（未发布围栏指纹即拒；按 `CHANNEL_DAILY_PAGE_CAP` 减当日 `source_channel_run.pages_fetched` 的 UTC 日余量硬截断；逐页以 crawl 围栏绑定经 `crawl4ai.render` 出网）、**finalize**（`source_channel_run` 落账并推进 failure streak；取消/失败也先落账再结束，错误码有界）。`requestCrawl` 从 409 切到「启动 `channel-crawl-<crawlRunId>` 并返回已受理」，`PLATFORM_TEMPORAL_UNAVAILABLE` 时 503 fail-closed；`source_channel_run` 新增 `truncated` 列（前向迁移）并贯通视图。新增 mTLS 客户端 `PlatformCrawlGrantClient`（request 规范摘要与 gain-saas 共用向量 `87084437…`）。
- 测试：活动层 6 用例（准入装配/权威拒绝映射/日配额截断且逐页过围栏/配额耗尽零出网/未批准渠道拒绝/平台落账带截断标记）、工作流 3 用例（成功/失败有界码/取消先落账）、客户端配置与共享向量、`channel.service` 启动路径与 503 映射、truncated 迁移静态契约；共 5 文件 25 用例绿。
- 未做：抓取记录的物化（records 仅计数进 `source_channel_run`，物化到公司池沿用既有导入/深挖路径的后续决定）；M2 watches 刷新复用本 workfow 的接线；围栏指纹与开关仍由运营显式发布/开启（默认拒发）。
