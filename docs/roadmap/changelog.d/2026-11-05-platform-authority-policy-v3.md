---
date: 2026-11-05
title: Publish the reviewed-v3 platform-authority policy with a channel-crawl capability section (P4-P2)
---

- 起因：P4 第二段——`platform.channel_crawl` purpose 需要新版平台权威策略工件（实现记录 `docs/implementation-records/platform-channel-crawl-budget-authority.md` §3/§5-P2）。GrowthOS 已退役（2026-10-31 P8），新版工件按 backend-authored successor 发布：保留 reviewed-v2 的逐字节基线与 GrowthOS 溯源，新增独立评审记录（AGENTS §5 安全方向变更）。
- 改动：新增 `platform-authority-policy-matrix-v3.json`（reviewed-v3）与 `platform-authority-policy-provenance-v3.json`：**四个 schedule 行与 v2 逐字节相同**（provenance 钉住行集 sha256，spec 深比较兜底），仅新增 `channel_crawl` 小节（purpose / `platform-automation` / `DENIED` / 页数上限与 `CHANNEL_RUN_MAX_PAGES`、`CHANNEL_DAILY_PAGE_CAP` 机器绑定）；资产校验切到 v3（字节/sha/artifact_id/matrix_revision/前驱/评审块/channel_crawl 小节），`rows` 仍是四行 schedule 集合——readiness、能力签名（≤4）与技术报价的四行不变量全部未动；报价夹具在 v3 身份下确定性重算（policy_revision / quote_sha256 等派生值）。
- 测试：资产 spec（字节 15,996/sha、前驱行摘要、channel_crawl 与渠道常量绑定、四类漂移拒绝、provenance 深等、运行时不读 GrowthOS checkout）；platform-authority 全套 60 文件 / 1121 用例全绿；报价向量按 v3 重算后逐字节断言；独立 review 记录写入工件 `backend_review` 与 provenance `successor`。
- 未做：不动四个 schedule 信封与 readiness 四行不变量；gain-saas 签发端点（P4-P3）与抓取工作流接线/409 切换（P4-P4）随后；跨仓 GrowthOS 重物化校验仍只覆盖 v2 基线（`MANUAL_SPECS`，CI 不跑）。
