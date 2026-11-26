---
date: 2026-11-26
pr:
title: feat(slimming): 新增 PLATFORM_AUTHORITY_MODE=internal_db 平台调度开关、解耦 new-api 读回探针并归组 openox-video-compat
---

- 起因：Wave 3 M10 收官批次（M10-PR3）——在保持现网 R4 默认兼容的前提下，提供轻量内部数据库 Kill Switch 以摆脱每周 7 天 `deployment-binding.json` 续期与 5 套 RSA 密钥强依赖；在未启用结算读回时避免预加载 `new-api-request-bound-settlement.ts`；将非主业务 `openox-video-compat` 容器改为按需 profile，释放常驻内存。
- 改动：
  - 新增 `PLATFORM_AUTHORITY_MODE=r4|internal_db`（默认 `r4` 零破坏）与前向增量迁移 `packages/db/prisma/migrations/20261126150000_platform_schedule_config/migration.sql`（`public.platform_schedule_config`，预置 4 个平台调度为 `enabled = false`，`app_user` 仅 `SELECT`、`execution_budget_platform_writer` / `platform_writer` 拥有 `SELECT/INSERT/UPDATE`），同步更新 Prisma 模型与 `app-user` / `platform-writer` / G5 目录清单。
  - 实现 `PlatformScheduleConfigService`、`InternalDbPlatformScheduleAdmission`、`InternalDbPlatformEgressFencePort` 与 `createInternalDbPlatformBudgetStore`，并接入 API 就绪检查、`PlatformCapabilityContributor`、`PlatformTechnicalQuoteAuthenticationReadinessContributor` 与 `platform-worker.ts`；新增受 `x-service-token` 保护的 `GET/PATCH /internal/platform-schedules` 内部接口及结构化操作审计日志。
  - 抽离 `apps/api/src/model-gateway/settlement-readback-contract.ts`，在 `settlementReadbackConfigured` 支持显式 `NEW_API_SETTLEMENT_READBACK_ENABLED=false` 开关，并在 `managed-dependency-readiness.ts`、`site-build-cost-reconciliation-resolver.ts`、`worker.ts` 与 `dev-fast-lane-worker.ts` 中改为仅在启用读回时惰性加载 `new-api-request-bound-settlement.ts`。
  - 在 `docker-compose.yml` 为 `openox-video-compat` 增加 `profiles: ["video-compat"]` 并补充操作手册 [platform-authority-internal-db-and-slimming.md](../../runbooks/platform-authority-internal-db-and-slimming.md)。
- 测试：
  - 仅单测通过：`m10-platform-authority-internal-db.spec.ts`、`m10-gateway-and-compose-slimming.spec.ts`、`platform-writer-table-privileges.spec.ts`、`controller-authz.spec.ts`、`platform-capability-composition.spec.ts`、`platform-authority-capability-regression.spec.ts`、`managed-dependency-readiness.spec.ts`、`new-api-settlement-readback-v1.spec.ts`、`budget-composition-integrity.spec.ts` 及 `@global/api` 全量构建/lint。
  - 已实测跑通（隔离一次性 PG16 容器 `mt-m10-pg-pr3`，测完清理）：全量迁移 + Prisma drift gate + G2 + G5 + `app-user-table-privileges.postgres.spec.ts` + `platform-schedule-config.postgres.spec.ts`（验证 `app_user` 只读、`platform_writer` 写与 Kill Switch 实时拦截）。
- 未做：本 PR 尚未部署到现网生产环境，生产切换 `PLATFORM_AUTHORITY_MODE=internal_db` 或停用 `openox-video-compat` 需待灰度验证与运维变更窗口执行。
