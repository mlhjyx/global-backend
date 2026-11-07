---
date: 2026-11-08
title: Governed company lineage for structured discovery sources (lineage v3)
---

- 起因：M0 步2 逐源启用（wikidata / openstreetmap / ted / openfda）被 2026-10-11 的血缘闸门结构性挡住——四个源都没有 `companyResultLineage`，`data_provider` 翻 ENABLED 也不进 planner、不路由（`SOURCE_LINEAGE_UNAVAILABLE`）。证据见 `docs/evidence/2026-11-08-m0-step2-source-enablement.md`；设计（产品负责人 2026-11-08 批准）见 `docs/superpowers/plans/2026-11-08-structured-source-lineage-contract.md`。
- 改动：
  - `company-discovery-lineage.ts`：`DiscoveryCompanyLineageProviderKey` 与回执合同新增四键，producerId 即 ToolBroker 工具 id（`wikidata.sparql`/`osm.overpass`/`ted.search`/`openfda.search`），resultSchema 与工具投影一致。
  - `discovery-query-governed-lineage.ts`：运行时 `PROVIDER_CONTRACT` 与 `LINEAGE_DESCRIPTOR.providerContracts` 同步新增四键；v2 合同哈希随描述变为 `7b29dc8f…`（v1 委托哈希 `eb5f6f09…` 与 raw-relation 哈希不变）。
  - 新迁移 `20261108120000_discovery_query_lineage_contract_v3`：`CREATE OR REPLACE` append/attest v2 与 `admit_discovery_company_materialization_v1`（新哈希）；两张表的合同 CHECK 同时接受新旧哈希（outcome/admission 行不可改写，历史行保留旧哈希）。
  - `domain-ack-consumer-bindings.ts`：`DISCOVERY_GOVERNED_COMPANY_ACK_BINDINGS` 新增四条（`RawSourceRecord` 聚合，consumer/resultSchema 与 PROVIDER_CONTRACT 一致）。
  - `discovery.activities.ts`：`DISCOVERY_DOMAIN_ACK_PRODUCERS` 补 `ted.search`（其余三个工具 id 原已在集合内）。
  - 四个 provider：声明 `companyResultLineage`，接线 `createDiscoveryCompanyReceiptCollector`（回执转发给活动层回调），成功路径以「单次结算回执覆盖全部记录索引」构造血缘；投影拒绝（`ToolDurableResultProjectionError`，已结算无回执）记 `failed` 观察使空血缘仍有效，其余未知失败保持血缘作废（fail-closed）。
- 测试：新增 `structured-lineage.provider.spec.ts`（四源回执覆盖、回执转发、投影拒绝空血缘、未知失败血缘作废）；更新 `provider.registry.spec.ts`（血缘声明与路由列表）、`discovery.activities.spec.ts`（结构化源进入受治理路由；未注册 source_hint 的 replay 跳过原因）、`discovery-query-lineage-execution-outcome.migration.spec.ts`（v3 迁移断言）与各夹具合同哈希。
- 未做：`openfda-search/v1` 投影 `maxItems: 12` 与 provider 取数口径（≥50 条）冲突是独立缺陷，openFDA 的第③④步启用需先修投影上界；OSM 上游 Overpass 三端点 2026-11-08 不可用，第②步需换窗口重测。两者见证据文档 §5。
- 部署：带迁移的切换走无 run 硬窗口（既有纪律）。上线后四个源仍需 ops 把 `data_provider.status` 翻 ENABLED 并做 dev mini-run 验收（本 PR 不改数据行）。
