---
date: 2026-11-27
pr:
title: 新增 Google Maps Places API 公司发现源（google_places）与 §3.2.3 合规治理
---

- 起因：光伏安装商、EPC 与电气分销商在本地商业地图覆盖度高，但既有 `google_places.search` 仅作为 `public_web` 的辅助召回使用，缺少独立可开关的公司发现源、多语种重点城市 × 类目规划、每日调用限额、合规矩阵与受治理公司血缘接入。
- 改动：新增受治理 ToolBroker 工具 `google_places.discover`（强制 `places.googleapis.com` `source_policy` + `sourceKey: 'google_places'` + 每日调用上限 `GOOGLE_PLACES_DAILY_CALL_LIMIT` + 仅保留 `placeId` 的持久回放）；新增独立 `GooglePlacesDiscoveryProvider` 与多语种「目标国重点城市 × 行业类目」网格规划器，遵循 Google Maps Terms §3.2.3 仅长期留存 `place_id` 且仅准入带自有企业官网的商家实体（Raw 记录 `retentionDays=1`，企业事实由下游 `website_profile` 抓官网确立）；接入 `provider.registry`（`data_provider.google_places` 默认 `DISABLED`）、`plan-query-sources`、血缘契约、Raw/Canonical 校验、技术预算包络与数据库迁移 `20261127180000_google_places_discovery_provider`。
- 测试：新增并更新 `daily-call-quota.spec.ts`、`google-places.provider.spec.ts`、`search-provider-tools.spec.ts`、`source-tools-wire-observation.spec.ts`、`catalog-result-projections.spec.ts`、`provider.registry.spec.ts`、`plan-query-sources.spec.ts`、`execution-envelope.spec.ts`、`workspace-technical-budget-envelope.spec.ts`、`workspace-technical-budget-quote.controller.spec.ts`、`canonical-company-attributes.spec.ts`，运行定向 vitest、API build、执行权威策略检查、文档漂移与治理检查、文件体量与模块边界检查及 gitleaks。
- 未做：尚未在现网环境配置 `GOOGLE_MAPS_API_KEY` 实测调用 Google Places API，尚未开启 `data_provider.google_places` 或签署 `source_compliance_matrix.approved_at`，也未触发镜像发布或合并 PR。
