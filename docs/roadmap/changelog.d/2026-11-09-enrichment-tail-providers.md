---
date: 2026-11-09
title: Apollo and PDL finder adapters as an A-tier-only waterfall tail
---

- 起因：P1-09——计划 §2.3.3 的瀑布可选尾：Apollo（兜底 + 搜索面）与 PDL（高价值账户身份/字段补充）单价最高，只对 A 档公司（评分 ≥80）开启，不对全量路由。
- 改动：
  - `apollo.provider.ts`：`POST /api/v1/people/match`（x-api-key）；`email_status`（verified/guessed/unavailable/bounced）折算 providerConfidence 透传；`person` 缺失 = 合法 miss（不扣配额）；单名输入不花配额（本地直接 miss）；≈$0.025/命中（25000 微美元，credit 单价未公开待核）。
  - `pdl.provider.ts`：`GET /v5/person/enrich`（X-Api-Key），`required=emails` 计费口径——404 无记录与「有记录但无邮箱」都不扣；邮箱优先 `current_professional`；≈$0.28/record（280000 微美元）。官方域 `api.peopledatalabs.com`（计划里 `api.peerdatalab.com` 为笔误）。
  - `finder-pool.ts`：新增 `resolveConfiguredTailFinderProviders`（Apollo → PDL，只收已配置凭据者）；**尾部不进主池**——调用方只对 A 档公司把尾池拼到主池之后（P1-10 接线）。
  - 登记面：`data_provider.apollo/pdl` seed（DISABLED）+ `source_policy.api.apollo.io / api.peopledatalabs.com`（APPROVED、personalData、purpose=discovery/enrichment）+ SourceClass 清单与治理 registry 条目（providers=31）与生成文档。
- 测试：两套假 HTTP 契约测试（email_status 折算、无记录/无邮箱不计费、单名不花配额、required=emails 查询参数、429/401/域不一致/缺凭据）+ 尾池顺序与「尾部不进主池」断言；finder 全套 45 用例绿；governance-verify providers=31 通过。
- 未做：A 档路由的调用方接线（P1-10）。真实 key 与 scorecard 后翻 ENABLED 是用户决策。
