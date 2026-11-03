---
date: 2026-11-03
title: Recover people-page links from raw HTML when the crawler markdown drops them
---

- 起因：M5 评估里 5 家零产出公司的排查——真实 Impressum 都在首页**原始 HTML 的锚点**里（导航/JS 菜单），但 crawl4ai 的 markdown 输出没有带出这些链接；固定路径只覆盖 `/impressum` 等少数标准形态，非标准路径（`/ando-technik/impressum/`、`common/info/impressum.html`）从未被选中。另有一类裸域→www 站点，固定路径落在站点的坏跳转上（`www.x.deimpressum/`）。
- 改动：`decision-maker` 选页在 markdown 人物页链接不足 3 条时，改用 `http.get` 抓首页**原始 HTML** 补抽同站锚点（www 容忍、去 query/hash、相对链接解析、仅同站），并用响应 `finalUrl` 的主机重拼固定路径（裸域→www 场景）。
  - 审查补强：`contact.find_decision_makers` 白名单补回 `http.get`（11-01 被 social.fetch 替换后，回退会被 ToolBroker 拒绝并当 control 抛出——比修复前更糟，已实测）；锚点解析改为线性扫描并截断 1MB（回溯正则在 3MB 恶意/未闭合页面上是 O(n²)，实测 384KB≈66s）；`finalUrl` 主机加可注册域校验（过期/停放域名的跨站跳转不跟）；跨 markdown/finalUrl 的同一页按 www 不敏感去重，不占预抓名额。
- 测试：锚点抽取单测（相对链接、www、mailto/js、外站、去重、无引号 href、3MB 恶意串限时）与 provider 级回退用例（markdown 无链接 → `http.get` 补抽 → **非标准路径** `common/info/impressum.html` 被预抓且排在固定路径之前、固定路径使用重定向主机）；`contact.find_decision_makers` 允许工具集含 `http.get` 由 task-registry 规格锁定。
- 部署：无迁移；随下一班车上线。
- 未做：未接 sitemap 索引/压缩链路（本轮实测部分站点 sitemap 不含 Impressum 或为空索引，收益不足）；已入库的旧结果不回溯重算。
