---
date: 2026-11-08
title: Add the campaign.plan execution-budget purpose to the engine database contract
---

- 起因：M2.1-1 只扩展了 TypeScript 的 `ExecutionBudgetPurpose`；引擎库的 `execution_budget_purpose` 仍是 Postgres ENUM，且 `execution_budget_authority_kind_shape_check` 与 `consume_workspace_execution_authority` 各自维护 purpose/`subject_type` 白名单。发车后的 --live 联调在消费 Grant 时以 `EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE` 失败（DB 侧拒收新 purpose），设计 §10「引擎无迁移」的判断与 as-built 不符。
- 改动：按 outreach.draft / platform.channel_crawl 的两段式先例补两条 forward-only 迁移：
  - `20261108163000_campaign_plan_purpose_enum`：`ALTER TYPE ... ADD VALUE IF NOT EXISTS 'campaign.plan' AFTER 'outreach.draft'`（单独事务，PostgreSQL 限制）；
  - `20261108163100_campaign_plan_purpose_use`：重建 kind-shape CHECK（逐字复制自 20261105001000，仅追加 `'campaign.plan'` 值与 `("purpose"='campaign.plan' AND "subject_type"='campaign')` 对）与 `consume_workspace_execution_authority`（逐字复制自 20261028183000，仅追加同一对）；无回填、不删表/列。
  另加文本级迁移 spec `campaign-plan-purpose.migration.spec.ts` 钉住两段式结构与关键不变式。
- 测试：在 5432 的临时库上按序重放全部 183 条基线迁移 + 本两条迁移，实调 `consume_workspace_execution_authority`：campaign.plan/campaign 成功入账；outreach.draft/lead 回归成功；campaign.plan/lead 被 `EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH` 拒绝。临时库已删除。
- 未做：不改 Prisma schema 的 `ExecutionBudgetPurpose` 枚举（先例：outreach.draft / platform.channel_crawl 也只在 DB 侧扩展，该表走原始 SQL 函数，不经 Prisma 枚举写入）。部署须随携带本迁移的镜像 `migrate deploy`（`MIGRATION_REVISION_MISMATCH` 门要求 DB 迁移集与镜像 revision 一致），单独手工灌迁移会让在跑镜像不就绪。
