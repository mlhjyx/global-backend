---
date: 2026-11-25
pr: 1103
title: 修复 model_web_search 可选查询词被 DB 拒收、crawl4ai 超时致预算卡死并补齐 directory 三级准入（Batch 1.5-B）
---

- 起因：现网意大利光伏实测 run `d7cb9523` 暴露出三个直接折损产出与稳定性的问题：`model_web_search` 已搜到并确认的 33 家意大利光伏分销商与 EPC 因 Postgres `raw_source_provider_payload_valid_v2_legacy` 误将可选字段 `searchQuery` 列为必填键而整批回滚；`crawl4ai.render` 在 45s 页面超时与并发排队下触发 75s `TimeoutError`，把 `tool_budget_operation` 卡在 `RESERVED` 导致重试报 `BUDGET_AUTHORITY_NOT_READY`（4/10 家深挖公司失败）；`directory` 源因缺少 `directory:public_b2b_listing` 三级兜底策略而在准入门全量返回 `SOURCE_POLICY_MISSING`。
- 改动：新增数据库迁移 `20261125110000_model_web_search_optional_query_and_directory_listing_policy`，将 `model_web_search` 的 `searchQuery` 移出必填键数组以与 TS normalizer 对齐，并在 `raw_source_policy_binding_v3` 与 TS `source-policy-scope.ts`/`raw-source-ingestion.ts`/`provider.registry.ts` 同步上线 `directory:public_b2b_listing` 三级准入（逐域策略含 `SUSPENDED` 优先 > 社媒/商业数据商/付费目录封闭黑名单拒收 > 公开 B2B 名录兜底）；将 `web-crawler.ts` 默认 `pageTimeoutMs` 从 45s 调为 25s，并在 `crawl4ai.render`/`crawl4ai.fetch` 工作区调用超时或返回空非 HTML 时按 `$0` 降级落盘（`CRAWL4AI_RENDER_DEGRADED_EMPTY_HTML`），同步让 `website-profile.provider.ts` 与 `public-web.provider.ts` 识别该占位 HTML 并安全降级。
- 测试：新增并跑通迁移一致性单测、三层名录准入单测、`model_web_search` 省略 `searchQuery` 入库单测、`crawl4ai.render`/`crawl4ai.fetch` 超时与空响应降级单测，以及构建、lint、复杂度预算、模块边界、unsafe raw SQL、governance 与 docs/gitleaks 门检。
- 未做：Prospeo 接入受控查邮安全通道需修改 `docs/governance/durable-result-strategies.json` 中 sha256 锁定的 `apps/api/src/tools/tool-broker.ts`（第 65 行 `SUBJECT_BOUND_ARTIFACT_HOLD_SCHEMAS`），留待用户明确授权解锁后在独立 PR（Batch 1.5-C）实施；`directory` 源在工作区发现阶段调用 `crawl4ai.fetch` 仍受 G3 `GENERIC_OPERATION_ARTIFACT_SUBJECT_BINDING_HOLD` 约束，公网名录抓取仍需走平台 `channel_catalog` 管道。
