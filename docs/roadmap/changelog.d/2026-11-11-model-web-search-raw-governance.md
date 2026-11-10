---
date: 2026-11-11
title: model_web_search 纳入 Raw 治理闸门 + 落地阶段观测——修复该源"有候选零入库"
---

- 起因：run 7968cccd（2026-11-11）里 model_web_search 的 confirm 已产出 4 个真实候选（3SUN、FuturaSun、Sunerg Solar、New Time），其中 3 个域名在同窗口 deepseek.search 结果中按主机名可匹配，但入库 0 条且无任何日志。定位到两层缺口：① `model_web_search` **不在 Raw 治理白名单**（TS `GOVERNED_PROVIDERS`、normalizer `PROVIDER_KEYS`、DB `raw_source_provider_payload_valid_v2_legacy` / `types_valid` / `write_raw_source_record_v2_legacy` 绑定 CASE 全部缺它），与 W4 opencorporates 同型——记录即使产出也会被 `UNGOVERNED_PROVIDER_PAYLOAD` / `RAW_SOURCE_WRITER_PROVIDER_BINDING_INVALID` 拒收；② provider 落地循环无逐阶段观测，且证据 URL 未按 raw 契约过滤稳定 https（带 query/fragment 的搜索命中会破坏 provenance 校验）。
- 改动：
  - `raw-source-provider-schema.ts`：GOVERNED 增加 `model_web_search`；新增 `validModelWebSearchAttributes`（仅允许 `{discoveredBy, evidenceUrls(1–3 条稳定 https), searchExecutor(deepseek|searxng), searchQuery?}`；无 identifier）；license 允许缺省。
  - `raw-source-provider-normalizer.ts`：`PROVIDER_KEYS` 与 `normalizeAttributes` 增加同名分支（searchQuery 为 null 时省略）。
  - `model-web-search.provider.ts`：证据只在**稳定 https URL**中按主机名归属；新增 `[model_web_search] explore: hits=… candidates=…` 与 `landing: confirmed=… kept=… dropped={domain/blockedOrSeen/name/noEvidence}` 两行观测日志。
  - 迁移 `20261110160000_model_web_search_raw_source`：`types_valid` / `legacy` / writer 绑定三处对 `model_web_search` 纯 widen（source_class=public_intelligence），其余 provider 分支逐字保留。
- 测试：真库事务内（BEGIN→应用→断言→ROLLBACK）——合法记录 `valid=true`；executor 非白名单 / 带 identifier / 带 query 的证据 URL 均 `false`；TED 记录回归 `true`；未知 provider 仍 `false`。本地 spec：provider / ingestion / schema-probe / registry / activities / model-web-search 共 6 文件 474 用例全绿；G9 通过。
- 未做：registry_frame 的同类白名单缺口仍在（其 provider 目前不产记录）；真实 run 复验在下一班车。
