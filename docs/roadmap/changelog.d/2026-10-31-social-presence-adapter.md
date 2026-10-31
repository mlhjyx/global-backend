---
date: 2026-10-31
title: Discover decision makers from indexed social profiles
---

- 起因：官网/注册处/展会之外还需要社媒与渠道。设计稿 §5.3b 的三层降级里，第一层是「搜索引擎已索引的公开片段」——零登录、零目标站抓取、零出口 IP 风险，先把它做成适配器（M2a）。
- 改动：
  - 新适配器 `social_presence`（`providers/social-presence.provider.ts`）：用 `searxng.search` 发定向 dork（`site:linkedin.com/in`、`site:xing.com/profile`，带公司名/域名与 ICP 目标角色），从结果标题解析「姓名 – 职务 – 公司 | 平台」；公司名不匹配的结果一律丢弃（防张冠李戴）；只保留个人主页路径（公司页排除）；同一 URL 去重。
  - 联系人记录标 `personalData: true`、`license: 'public-index'`、`sourcePage` 为索引里的公开 URL；邮箱/电话留待 M2b（档案副本/公开页直抓）补。
  - 注册表：适配器注册进 `contacts`（座席上限 5 → 6），`data_provider` seed 行 `social_presence` 默认 ENABLED（kill-switch 走本表 status）。
- 测试：新 spec 5 例——dork 构造（角色词/域名锚定/空名）、标题解析（LinkedIn/Xing/单词名拒绝）、结果过滤（公司页/陌生人/非社媒/去重）、broker 调用与单查询失败容错、无 broker fail-closed。
- 未做：档案副本（Wayback/Common Crawl）与公开页直抓（M2b）；theHarvester/social-analyzer/JobSpy 的 OSS 工具化；联系人阶段独立预算账户与 per-tenant LIA（设计稿 §5.3c/§5.3d，已拍板，M3）。
