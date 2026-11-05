---
date: 2026-11-06
title: Decode HTML entities in channel extraction and make the crawl page timeout env-tunable
---

- 起因：ProPak 渠道选择器调整后发现两个小缺陷——`html-select` 不解码 HTML 实体（公司名落库为 `A&amp;D`）；crawl4ai 的单页导航超时硬编码 45s，对 1MB+ 慢站（实测 25–45s）贴边，preview 的成败取决于站点时延。
- 改动：`html-select.nodeText` 统一解码命名与数字实体（整棵子树收集后只解码一遍；未知实体原样保留、非法码点不转换）；`crawlHtml` 的 `page_timeout` 改读 `CRAWLER_PAGE_TIMEOUT_MS`（默认 45000，钳制 5s–70s——上限低于 `/crawl` 的 75s 客户端中止与 discovery 租约计量基准，超过只会先在客户端超时并把慢页计成失败）。
- 测试：实体解码单测（命名/十进制/十六进制/未知/非法）、超时解析单测（默认/覆盖/钳制/非法）。
- 未做：条目内字段选择器（展位/国家/website）需要爬虫 v1，另行设计；不改渠道抓取的行为契约。
