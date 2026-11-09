---
date: 2026-11-09
title: P3 J04 — judgment quality tables v1 (migration + Prisma datamodel + RLS)
---

- 起因：ch04 判定质量（§4.3.2.8 / §4.3.4.2 / §4.3.7.3 / §4.3.8.1 / §4.3.8.3）的六张表只存在于设计稿，硬门结果、判定记录、conformal 阈值与人工复核队列都没有落库结构；判定质量工作流（J05+）无法接线。
- 改动：
  - 迁移 `20261109130000_judgment_quality_v1`：新建 `hard_gate_result`、`gate_enrichment_task`、`judgment_record`、`conformal_threshold`、`judgment_review_task`、`judgment_golden_label` 六表，含设计稿的 CHECK 约束、replay/查询索引与 workspace RLS。
  - `packages/db/prisma/schema.prisma`：新增六个 model（`@@map` 到表名）；`judgment_record` 对 `discovery_run`/`canonical_company`/`icp_definition` 建关系（run 为单列 FK `ON DELETE SET NULL`，修正设计稿复合 FK 与 SET NULL 的不可实现组合；company/icp 单列 FK `ON DELETE CASCADE`），三个既有 model 补反向关系数组。
  - 权限按状态机语义：`judgment_record`/`hard_gate_result`/`judgment_golden_label` append-only（app_user 仅 SELECT,INSERT）；`gate_enrichment_task`/`judgment_review_task` 可状态转移（SELECT,INSERT,UPDATE）；`conformal_threshold` 全局表不开 RLS、app_user 仅 SELECT。`docs/governance/app-user-table-privileges.json` 同步。
  - 4 条 Prisma 不可建模索引（2 个 COALESCE 表达式唯一索引、2 个部分索引）由迁移 SQL 实现；实测 Prisma 6.1 的 migrate diff 忽略这两类索引，故不登记 drift-baseline（否则触发 ratchet 的 STALE 判定），行为记入迁移头注释。
- 测试：`app-user-table-privileges.postgres.spec.ts` 新增六表负向用例——append-only 表 UPDATE/DELETE 42501、状态机表 DELETE 42501、跨 workspace SELECT 0 行、允许的写入通过且回滚、`conformal_threshold` INSERT 42501；漂移门与迁移 repeat-deploy 幂等验证通过。
- 未做：判定工作流写入路径（gates.ts / judgment-record.ts）与复核 API（J05/J06 批次）。
