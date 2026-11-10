---
date: 2026-11-10
title: Source compliance matrix, governed OpenCorporates source and de/fr/it/es industry role terms (acquisition vNext W4)
---

- 起因：获客挖掘 vNext（`docs/superpowers/plans/2026-11-10-deep-acquisition-vnext.md` §3 W4）要求原始源下沉前先过合规矩阵，并把 OpenCorporates 作为 P0 第一源接入受治理发现管线；查询计划的本地语言词表同时补齐德/法/意/西的行业角色词。
- 改动：
  - 新平台表 `source_compliance_matrix`（迁移 `20261110080000_source_compliance_matrix`）：许可分类/robots/ToS/个人数据分级/保留期/责任人；初始行覆盖 openstreetmap、wikidata、ted、openfda、companies_house、inpi_rne、gleif、google_patents 与新源 opencorporates（approved_at 留空＝商用订阅签署前不得上线）。app_user 只读。
  - 工具 broker 源合规闸门：声明 `compliance.sourceKey` 的新源工具在 `SOURCE_COMPLIANCE_GATE=enforce` 时要求矩阵已批准行（未登记/未批准=fail-closed）；默认 off 行为不变，未声明 sourceKey 的旧源只走既有 source_policy。
  - 新受治理工具 `opencorporates.search`（`opencorporates-search/v1` typed projection，provider `opencorporates`，company_registry 类，完整血缘回执 producer=opencorporates.search）；`OPENCORPORATES_PROVIDER` 默认 off、`data_provider.opencorporates` 默认 DISABLED、缺 `OPENCORPORATES_API_TOKEN` 时 fail-safe 有效空。
  - 发现治理 SQL（`append_discovery_query_lineage_v1`）白名单与 attempt 三元组扩入 opencorporates（纯 widen，合同哈希不变）。
  - `search-localization` 的 de/fr/it/es 分销商角色词各加一组行业词（Fachhandel/Importeur、importateur/négociant、importatore/commerciante、importador/comerciante 等），既有前三项顺序不变。
  - 注册面同步：task/execution-authority 计数（23 tools / 49 callsites）、durable-result-strategies、domain-ack 两处绑定、receipt facts、provider registry/source classes/plan-query-sources、技术报价包络（适配器 9→10 并登记 opencorporates 搜索出网上界）。
- 测试：新增适配器/工具/provider/迁移/合规闸门单测与投影边界样例；`execution-authority-policy.spec`、provider registry、plan-query、durable-results 计数按真值更新；`gctl check` 全绿（CI 为准）。
- 未做：OpenCorporates 商用订阅与真实 key 未配置，真实限流/配额实测留待部署后验收；Companies House / INSEE SIRENE / 展会原始目录等其余 P0 源与本地语言真实 run 留待后续切片。
