---
date: 2026-11-09
title: Hunter, Findymail and Prospeo finder adapters with registry gates
---

- 起因：P1-07——富集瀑布（P1-08）要先有付费 finder 适配器；计划 §2.3.3 定序 Hunter（pattern/accept_all 结构化信号）→ Findymail（pay-on-valid 主力）→ Prospeo（90 天免费重取）。
- 改动：
  - `enrichment/finders/email-enrichment-provider.ts`：统一接口（`findEmail → hit/miss/error`、`requestHash = sha256(contactId|provider|inputVersion)`、注入 fetch）与共享纯函数（输入版本哈希、返回值边界校验 `normalizeEnrichedEmail`——语法 + 域名一致，防供应商串号；人名归一 `personNameParts/namesMatch` 大小写/变音符/标点无关）。
  - `hunter.provider.ts`：`/v2/domain-search` 客户端，按 first/last name 归一匹配取 confidence 最高；`data.pattern`/`data.accept_all` 作为结构化信号透传（accept-all 地址由验证层裁决，不当 VALID）；miss 不计费（$0.0170/命中）。
  - `findymail.provider.ts`：`POST /api/search`（Bearer），容忍顶层/嵌套 `contact.email` 两种形状；显式无结果 0 成本（pay-on-valid，$0.0198/命中）。
  - `prospeo.provider.ts`：`POST /email-finder`（X-KEY），`NO_MATCH`/`INVALID_DATAPOINTS`=合法 miss（0 成本），`RATE_LIMITED`/`INTERNAL_ERROR` 可重试、`INSUFFICIENT_CREDITS`/坏 key 不可重试（供编排层熔断）；$0.0198/命中。
  - `finder-pool.ts`：只收凭据已配置的 finder，顺序即瀑布顺序；Apollo/PDL 属 P1-09 可选尾，未入池。
  - 登记面：`data_provider.hunter/findymail/prospeo` seed（**一律 DISABLED** = kill switch）+ `source_policy.api.hunter.io/api.findymail.com/api.prospeo.io`（APPROVED、personalData、purpose=discovery/enrichment）+ SourceClass 清单与治理 registry 条目（providers=29）与生成文档。
- 测试：4 套假 HTTP 契约测试（命中/无结果不计费/429 可重试/401 不可重试/域不一致 invalid_payload/畸形体/缺凭据不发请求/pool 顺序与域名），零真实出网；governance-verify providers=29 通过；api build 通过。
- 未做：富集瀑布编排与 attempt 账（P1-08）、Apollo/PDL 适配器（P1-09）、HTTP 端点与 run 接线（P1-10）；真实 key 到位后按供应商实际响应校准映射并跑 scorecard（§2.3.3.1）后才允许翻 ENABLED。
