---
date: 2026-11-25
pr: 1104
title: 修复 registry_frame 与 channel_catalog 空结果本地查询回执误落辅助区导致 DOMAIN_ACK_CONSUMER_BINDING_MISSING
---

- 起因：现网验收 run `51625d1b` 在执行 `registry_frame` 查询意大利光伏（0 条本地命中）时抛出 `ExecutionControlError: DOMAIN_ACK_CONSUMER_BINDING_MISSING` 导致整轮失败。根因是 `buildRegistryQueryLineage` 与 `buildChannelCatalogQueryLineage` 在 `recordCount === 0` 时把 `attemptReceipts` 写死为空数组 `[]`，却仍通过 `ctx.onDurableReceipt` 上报了 `registry.query`/`channel_catalog.query` 回执，导致 `buildGovernedDiscoveryQueryExecutionPlan` 把该回执归类到 `auxiliaryReceipts` 并在产品辅助绑定表中查不到消费绑定。
- 改动：在 `apps/api/src/registry/local-query-receipt.ts` 的 `buildRegistryQueryLineage` 与 `apps/api/src/discovery/channel-catalog-receipt.ts` 的 `buildChannelCatalogQueryLineage` 中，当 `recordCount === 0` 时与 `buildDiscoveryCompanyResultLineage` 保持同口径，将回执记入 `attemptReceipts`，使其正确纳入公司血缘 `companyOperationIds` 并命中 `DISCOVERY_GOVERNED_COMPANY_ACK_BINDINGS`。
- 测试：更新 `local-query-receipt.spec.ts`、`registry-frame.provider.spec.ts` 与 `channel-catalog.provider.spec.ts`，补齐 0 条命中场景经过 `buildGovernedDiscoveryQueryExecutionPlan` 的端到端回归测试（验证 `auxiliaryReceipts` 为空且 `attempts` 含该本地查询回执），并通过全量构建与治理门检。
- 未做：无新增架构或数据库迁移变更。
