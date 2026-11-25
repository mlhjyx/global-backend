---
date: 2026-11-25
pr: 1099
title: Buying-committee live wiring, Step 0 zero-cost pattern inference, Prospeo pacing/corporate-group domains, GDPR Art.14/D3 wiring, and formal battle-csv API
---

- 起因：决策委员会排序、Step 0 零成本邮箱模式推断、Prospeo QPS 限速与集团域名容错、`other` 邮箱 fail-closed、GDPR Art.14 排期、D3 政策接线及 19 列作战清表尚未真正接入在线 API 与富集瀑布。
- 改动：将 `buying-committee.ts` 接入 `social-presence.provider.ts` 与 `enrich-company-contacts.ts`；在付费 finder 前新增 `step0-pattern-inference.ts` 零 finder 成本模式反推并支持同批次内公司样本传递；为 `ProspeoProvider` 增加 QPS 限速、429 有界退避与集团域名校验；修复 `enrich-contact-email.ts` 对 `other` 邮箱的 fail-closed 合法依据门并将 `scheduleArticle14NoticeInTransaction` 接入 `contact-persist.ts` 与 `enrich-contact-email.ts`；将 `evaluateMultiChannelOutreachPolicy` 与 Catch-All 领英优先路由接入 `ContactEligibilityService`；正式开放 `GET /api/v1/reports/battle-csv` 并同步 OpenAPI 契约与 G16 边界基线。
- 测试：运行 `buying-committee`、`prospeo.provider`、`email-enrichment-provider`、`step0-pattern-inference`、`enrich-contact-email`、`enrich-company-contacts`、`contact-persist`、`social-presence.provider`、`contact-eligibility.service`、`contact-eligibility-openapi`、`report.controller`、`battle-csv-builder`、`weekly-report.service` 与全量构建/Lint/OpenAPI 导出/治理检查全部通过。
- 未做：SaaS BFF 路由透传与 OpenAPI 客户端生成由紧随其后的 `gain-saas` PR 完成。
