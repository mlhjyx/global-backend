---
date: 2026-11-11
title: 公司站点绑定 www 容错——修复 www.<domain> 证据导致整条查询提交失败（迁移 20261110180000）
---

- 起因：run 103a4b1d（第六班车）里 model_web_search 落地 1 条真实记录（3SUN），提交时 DB writer 以 `RAW_SOURCE_WRITER_POLICY_BINDING_INVALID` 拒绝：company-site 分支的 ACCEPTED 检查比较「源主机 ≠ 记录域名」，而证据 URL 是 `www.3sun.com`、记录域名是 `3sun.com`（站策略比较早已 strip 一层 www，此处遗漏）。
- 改动：迁移 `20261110180000_company_site_policy_www_tolerant` — `raw_source_policy_binding_v3` 的 company-site ACCEPTED 比较改为 `regexp_replace(p_source_host,'^www\.','')` 与记录域名对比；其余逐字保留。
- 测试：真库事务内（BEGIN→应用→断言→ROLLBACK）——`www.3sun.com`→`source_policy`、裸域→`source_policy`、异域→仍 `RAW_SOURCE_WRITER_POLICY_BINDING_INVALID`。
- 未做：不改应用层（#1016 已含子域匹配）；registry_frame 白名单缺口仍在。
