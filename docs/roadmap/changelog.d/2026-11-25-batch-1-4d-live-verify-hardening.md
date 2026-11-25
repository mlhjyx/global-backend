---
date: 2026-11-25
pr: 1100
title: "fix(discovery): 修复 Batch 1.4 现网实跑暴露的 6 项发现与发信链路缺陷（Batch 1.4-D）"
---

- 起因：在正式生产环境对试点租户琏升科技执行完整找客（run `607b314d`）与出表验证时，暴露出 6 项硬缺陷：`model_web_search` 的 `serper/brave/exa` 执行器被 PostgreSQL 旧版入库函数全量拒收；决策人爬虫对非德语站点仍盲猜德语路径且用无头浏览器死等 404 导致单次找客耗时约 40 分钟（`duration_exceeded`），同时裸域 TLS 证书仅签发 `www.` 时未切换重试；规划器覆盖补齐对非英国 ICP 误注 `companies_house_registry`；4router 上游分组通道耗尽返回的 HTTP 403 未触发 D13 跨通道降级；意大利/德国等明确国别域名在公司 `country` 缺失时未按 ccTLD 补全导致 GDPR Art.14 漏排期；Battle CSV 转介信把中文 ICP 名称直接拼入意大利语模板。
- 改动：新增纯放宽迁移 `20261125070000_model_web_search_executors_widen` 对齐 `raw_source_provider_payload_valid_v2_legacy` 的 `searchExecutor` 白名单（与 TS 契约一致）；新增 `decision-maker-paths.ts` 按国别/ccTLD 选择多语种固定路径、对盲猜路径先走轻量 `http.get` 快退 404 或直抽富正文、并在裸域抓取失败时回退同注册域 `www.`；覆盖补齐仅在目标国为 GB 或未限定国家时注入 `companies_house_registry`；扩展 `ProviderHttpError` / `provider-wire-helpers` / `definite-model-failure` 识别 403 上游通道耗尽以触发跨通道降级（普通鉴权 403 维持 fail-closed）；新增 `domain-country.ts` 在 `public_web`/`model_web_search`/联系人入库/Step 0/Battle CSV 兜底明确 ccTLD 国别；`weekly-report.service` 改读卖家 `offering` 与 `companyProfile` 而非买家 `icp.name`，并在 `battle-csv-builder` 过滤非中文外语模板中的中文字符。
- 测试：全量通过新增与既有 vitest 单测（`domain-country`、`decision-maker.provider`、`plan-query-sources`、`raw-source-ingestion`、`provider-wire-helpers`、`model-fallback`、`battle-csv-builder`、`public-web-search-first`、`contact-persist`、`step0-pattern-inference`），API 构建、`lint`、`check-file-budgets`、`governance-module-boundaries`、`governance-unsafe-raw-sql`、`governance-verify`、`copy-fixed-source-impact`、`governance-document-drift`、`docs:verify` 与 `gitleaks` 全绿。
- 未做：Prospeo / Step 0 纳入 `ControlledEnrichmentProvider` 正式安全闸门、`directory` 静态白名单动态放开、以及专利源按工作区 LIA 拆分留在下一批次独立设计与评审；本 PR 合并后需经受保护 `runtime-image-publication` 人工审批发版并通过 `gctl switch-backend --with-migrations` 上线后做现网复测。
