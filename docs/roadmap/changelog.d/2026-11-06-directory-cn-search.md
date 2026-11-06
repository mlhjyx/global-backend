---
date: 2026-11-06
title: Directory discovery searches Chinese markets in Chinese
---

- 起因：真实 ICP（东莞盛源鑫/真空吸塑，中文市场）两轮对比 run 中 directory 结构化源 10 条查询零产出。复现确认：`buildDirectorySearches` 用无语言参数的 `searchableTerms` 把中文行业/关键词整段剥掉，检索串退化为 `manufacturing members directory 中国`；SearXNG 实测返回无关页面（含成人站点）。名录识别 `LISTING_HINT` 也不含中文名录/黄页词。
- 改动：`buildDirectorySearches` 按 `searchLanguageFor(query)` 选词与意图词族——zh 市场保留中文主题词与中文地区词（珠三角等），意图词改用中文名录词（企业名录/会员企业名单/参展商名单/供应商目录）；其它市场维持旧行为。`searxng.search` 的 `language` 从硬编码 `en` 改为目标市场语言。名录识别抽成可测的 `isDirectoryListingShaped`，正则补中文名录词（名录/黄页/企业库/企业大全/参展商/会员企业/供应商目录）。
- 测试：`directory.provider.spec` 新增中文市场检索串、纯中文关键词、中文名录识别三组用例；既有非中文市场的期望不变。
- 未做：未动 NOISE_DOMAINS（无关/垃圾站点仍由列表抽取 LLM 判 `is_directory` 丢弃）；directory 产地内条目字段（展位/国家/website）仍属爬虫 v1。
