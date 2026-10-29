---
date: 2026-10-29
pr: 694
title: Stop re-acking crawl receipts in understanding offerings persistence
---

- 起因：公司理解的模型抽取全部成功、`persistClaims` 已落库，但工作流在 `persistOfferings` 抛 `ExecutionControlError`，公司状态回到 DRAFT。根因是 `persistClaims` 已用 `crawl4ai.fetch` + domainAckKey `...:crawl` 确认每页爬取回执，`persistOfferings` 又用同一回执、同一 key 再确认一次：第二次得到 `REPLAYED`，而 offering 抽取回执是 `APPLIED`，`applyDomainAckConsumerTransactions` 检测到混合状态并抛 `DOMAIN_ACK_MIXED_REPLAY_STATE`。
- 改动：`persistOfferings` 不再重复确认爬取回执；爬取回执只在 `persistClaims` 确认一次，offering 自己的抽取回执仍按 `...:offerings` 确认。没有改动 workflow 命令序列、预算账本或 schema。
- 测试：本地引擎镜像构建成功，镜像 `org.opencontainers.image.revision` 与源提交一致；本地镜像部署被引擎 runtime-image verifier 和 GrowthOS platform authority 拒绝（未登记镜像），不是代码失败。正式镜像发布后需用一条全新公司档案重跑理解，确认状态到 REVIEW。
- 未做：未在本机完成运行态验证；未迁移 GrowthOS 的平台 Grant/platform-worker trust root。
- 部署：合并后由 `.github/workflows/publish-runtime-image.yml` 发布镜像，再用 `gctl switch-backend <digest>` 切换并完成 GrowthOS 侧登记。
