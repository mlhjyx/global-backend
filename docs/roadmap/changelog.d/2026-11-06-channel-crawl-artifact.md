---
date: 2026-11-06
title: Admit platform channel-crawl fetches transiently and record crawl_run_id
---

- 起因：2026-11-06 发车后的 ProPak Asia preview 验收发现渠道抓取从未真正出网——ToolBroker 的 G3 主体绑定闸门拒绝 `crawl4ai.render`（渠道抓取没有也不应有公司/联系主体，此前每轮 failures=1 未被察觉）；同时 `source_channel_run.crawl_run_id` 从未写入，迁移为 finalize 准备的重试幂等唯一列一直为 NULL。
- 改动：
  - 新增关闭集合的瞬态结果作用域 `platform_channel_crawl`：工具声明（`crawl4ai.render`）+ 调用方声明 + ToolBroker 校验（必须 platform 工作空间、非 paid、已声明），放行时原始 HTML 解析后丢弃、不落 PERSONAL_DATA artifact，按普通成本路径结算；tenant/未声明工具/未知作用域一律 `TRANSIENT_RESULT_SCOPE_DENIED` 失败关闭，已结算的瞬态操作重放按 remnant 失败而不重发出网。
  - `finalizeChannelCrawl` 传递 `crawlRunId`；`recordChannelRunInTransaction` 按 `crawl_run_id` 唯一键幂等收敛（重试更新同一行、不重复推进 failureStreak），无 `crawlRunId` 的旧调用方路径不变。
  - ToolBroker 属受保护组合：已按治理要求审查 authority/budget/receipt/egress 绕过面并重钉 sha256（`docs/governance/durable-result-strategies.json`）。
- 测试：broker 瞬态作用域矩阵（放行/tenant 拒绝/未声明工具/未知作用域/replay remnant）、渠道抓取活动 context 与 finalize payload、记录器幂等收敛；目标套件 79/79、全量零容器单测通过（仅一个已知负载假红单独复跑通过）。
- 未做：`sanctions-download/v1` 的平台作用域 hold 维持现状（需单独立项）；无 schema 迁移；不改收据、Grant/R4 链与 egress fence。
