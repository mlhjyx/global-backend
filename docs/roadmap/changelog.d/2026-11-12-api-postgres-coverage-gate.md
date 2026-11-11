---
date: 2026-11-12
title: Gate API Postgres suites on explicit CI coverage
---

- 起因：2026-11-12 审计 K-2 发现 `apps/api` 的 25 个 Postgres 套件里有 2 个只在本地手工运行（`contact-path-backfill`、`weekly-report`）：全量单测因缺数据库 URL 跳过它们，CI 也没有单独步骤；新增套件「忘了接 CI」不会让任何门变红。
- 改动：
  - 新增 G10 门 `scripts/governance-api-postgres-coverage.mjs`：每个 `apps/api/src/**/*.postgres.spec.ts` 必须在 `.github/workflows/ci.yml` 中被引用，或在 `docs/governance/ci-baselines/g10-api-postgres-suites.json` 登记 `reason` / `owner` / `expiresAt`；豁免过期或文件消失即失败；基线只许收紧。
  - 把两个手工套件并入已迁移 schema 的 Postgres 步骤，使用 CI service 数据库的 owner / app_user URL；两者都用随机 workspace id 并清理 fixture。
- 测试：`node scripts/governance-api-postgres-coverage.mjs verify`；两条套件在一次性 pgvector 容器上本地跑通；`gctl check` 与 CI 必需检查。
- 未做：未把 25 个套件统一改造成 manifest runner（K-3）；`weekly-report` 功能在 SaaS 侧已取消，引擎模块去留待 C-4 决定。
