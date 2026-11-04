---
date: 2026-11-04
title: Add zh search localization and fail loudly on unbuildable searches
---

- 起因：产品负责人用中文 ICP（珠三角电子制造/吸塑包装）跑 discovery 得到 4 秒 PARTIAL、0 结果。根因：搜索本地化只支持 de/en/fr/it/es/nl/pl，中国回落 en；`searchableTerms` 剔除全部 CJK 词 → `buildSearchQueries` 返回空 → 一次检索都没发、10 条查询收据全 0、静默收场。
- 改动：
  - `SearchLanguage` 增加 `zh`；COUNTRIES 增加 CN（中国/china/cn/chn）；地区映射增加珠三角/长三角/京津冀/粤港澳/环渤海等中文区域；`ROLE_TERMS` 增加 zh（distributor 经销商/分销商/批发商/进口商，manufacturer 制造商/厂家/工厂）。
  - `searchableTerms` 接受语言参数：`zh` 保留 CJK、其余语言维持剔除（既有德语/英语检索串行为不变）；`buildSearchQueries` 先定语言再取词。
  - `discoverCompanies` 在无法构造任何检索串时抛 non-retryable `DISCOVERY_MARKET_UNSUPPORTED`（附可操作中文提示），不再静默返回 0 结果 PARTIAL。
- 测试：`search-localization.spec`（zh 解析、角色词、CJK 保留/剔除分流与既有 DACH 用例）、`public-web-search-first.spec`（中文经销商串、珠三角区域串、空检索显式失败、既有德语回归）；全量 `@global/api` 单测。
- 未做：马来语（ms）与「ICP 目标市场以卖方档案为权威」属独立任务；run 页「搜索企业」阶段 UI 映射与错误码前端文案在 gain-saas 侧另 PR；搜索本地化仍未覆盖韩/日。
