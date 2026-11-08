---
date: 2026-11-08
title: Widen the frozen v1 lineage provider allowlist for the lineage v3 sources
---

- 起因：lineage v3（#846）上线后首个真机 run（`f841d9f1`）在 append 阶段失败——`DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID`。v2 合同换哈希后仍把内容校验委托给 `append_discovery_query_lineage_v1`，而 v1 的**回执 providers 白名单**与**每条 attempt 的 producerId/consumer/resultSchema 三元组**硬编码了 public_web/directory/trade_fair 三个旧源；wikidata 等新源的回执一进 append 就被拒。
- 改动：新迁移 `20261108160000_discovery_query_lineage_provider_allowlist` 用 `CREATE OR REPLACE` 替换 `append_discovery_query_lineage_v1`，只扩两处白名单（四个新源及各自 source_class；producerId/consumer/resultSchema 与 `PROVIDER_CONTRACT`、`DISCOVERY_GOVERNED_COMPANY_ACK_BINDINGS` 一致），并按其创建时机要求以 `pg_temp` 收尾 search_path。v1 合同哈希（`eb5f6f09…`）、命令/回执字段与全部既有校验不变——历史 v1 回执里从不含新源，重放语义不变（纯 widen）。
- 测试：迁移内容断言进 `discovery-query-lineage.functions.migration.spec.ts`（CI 单元门）；一次性库全量迁移 + `app_user` 会话直接 append 一个 `providers=['wikidata']` 的零记录回执——修复前 `DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID`，修复后 `APPLIED`；同库 RLS 血缘规格 11/11 通过（public_web 不受影响）。
- 部署：本迁移需随下一次发车进入（当前运行镜像 `123e8d67` 的 readiness 要求库最新迁移 = 镜像 `migration_revision`，不能单独热更库）。发车前四源 `data_provider` 已回退 DISABLED，避免计划包含新源的 run 再撞同一失败；修复车后重做步2 的③④。
- 未做：不改引擎代码与合同（本缺陷纯在冻结 v1 的 SQL 白名单）；未新增跨源组合的 DB 级用例到 CI 的常驻 DB 规格（一次性库验证记录了 RED→GREEN，常驻 Guard 由迁移内容单测承担）。
