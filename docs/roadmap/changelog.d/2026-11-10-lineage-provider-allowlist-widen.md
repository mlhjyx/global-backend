---
date: 2026-11-10
title: 查询血缘 SQL 白名单再扩——registry_frame 与 model_web_search
---

- 起因：`append_discovery_query_lineage_v1` 的 providers 白名单与 attempt 三元组仍是硬编码（上次扩于 20261108160000）。2026-11-10 真实 run 实测：registry_frame（A 方案，数据源 ENABLED + `REGISTRY_FRAME_PROVIDER=on`）在 append 阶段被 `DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID` 拒绝，整个 run FAILED；WEB-1 的 model_web_search 同样不在白名单内。
- 改动：新迁移 `20261110050000_discovery_query_lineage_provider_allowlist_widen`（纯 `CREATE OR REPLACE FUNCTION append_discovery_query_lineage_v1`，无表结构变更）：
  - providers 白名单增 `model_web_search`（限 public_intelligence）与 `registry_frame`（限 company_registry）；
  - attempt 三元组增 `discovery.web_search_candidates / ModelWebSearchDiscoveryProvider / discovery-web-search-candidates/v1` 与 `registry.query / RegistryFrameDiscoveryProvider / registry-query/v1`，与 code 侧 `PROVIDER_CONTRACT`/`DISCOVERY_GOVERNED_COMPANY_ACK_BINDINGS` 一致。
  - v1 合同哈希、命令/回执字段与其余校验不变（纯 widen；历史回执不含新源，重放语义不变）。
- 测试：迁移在本机库事务内解析/创建后 ROLLBACK（语法与依赖通过）；发车后真实 run 复验。
- 未做：raw source writer 的 provider CASE 白名单（`write_raw_source_record_v2_legacy`）未扩——治理管线走 Prisma DML 不经过该函数，registry_frame 实测止于血缘 append 而非 raw 写入；如未来有路径使用该 SQL writer 需同步扩。
