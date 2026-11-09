---
date: 2026-11-09
title: Register registry_frame as a discovery provider (routing surface only; execution awaits the local_query lineage design)
---

- 起因：ch03 T3-09——把本地注册库 frame 枚举（`registry_entity` 平台表 + `registry/query.ts` 契约）注册进 discovery 的 provider/路由面。执行面撞上 2026-11-08 收紧的 governed-lineage 契约：零出网本地查询无物理调用可出 durable 回执，按现行契约无法通过物化准入，需要单独的架构批准。
- 改动：
  - `apps/api/src/discovery/providers/registry-frame.provider.ts`：`registry_frame` 适配器（`company_registry` 类），把计划 filters 白名单映射到本地查询并返回 `ProviderCompanyRecord`（成本恒 0）；**刻意不声明 `companyResultLineage`**，因此被路由闸门恒排除（计划期计 `SOURCE_LINEAGE_UNAVAILABLE`）——这是预期行为，由单测钉死。
  - 注册与路由面：`provider-source-classes.json` 增 `registry_frame → company_registry`；`provider.registry.ts` 注册适配器 + seed `data_provider`（`registry_frame`，DISABLED，成本 0，第二道 kill switch）；`plan-query-sources.ts` 路由优先级 5（零出网第一优先）与 planner guide 条目；`MAX_COMPANY_DISCOVERY_ADAPTERS` 7→8（技术报价上界随注册面同步，既有 envelope 断言更新）。
  - 治理登记：`docs/governance/provider-registry.json` 新增条目（PARTIAL、default DISABLED、`governed_lineage_pending_local_query` gate）并重生成 `docs/backend/provider-registry.md`。
  - 书面设计（待产品负责人拍板，未施工）：`docs/superpowers/plans/2026-11-09-registry-frame-local-lineage.md`——local_query 血缘变体（`registry.query` producer、resultDigest 定义、回放/审计语义、增量改动清单、风险与回退）。
- 测试：新增适配器 spec（无库诚实空、filters 映射、成本 0、非法 filters fail-safe）与注册/路由断言（注册但不可路由、seed DISABLED、计划期 `SOURCE_LINEAGE_UNAVAILABLE` 钉死、cheap-first 裁剪时 registry_frame 副本优先于 wikidata）；技术报价 envelope spec 按适配器 8 更新（fit 判定上界 11,550→13,200 家/run、requiredCap 559,798→625,798 cents）。`pnpm governance:verify` 通过（23 providers）。
- 未做：执行面接线（等 local_query 设计获批）；ICP 行业词→NACE 前缀映射（T3-05）；本波不碰 Copy 绑定文件、无迁移、未发车。
