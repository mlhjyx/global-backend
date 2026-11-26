---
date: 2026-11-26
pr:
title: "chore(governance): 撤除冻结建站线的 Copy fixed-source 强制指纹门禁"
---

- 起因：Site Builder Copy 线已冻结且持续处于 `STALE_HOLD / NOT_AUTHORIZED / BLOCKED`，但 `scripts/copy-fixed-source-impact.mjs` 仍强绑定 `packages/db/prisma/schema.prisma`、`package.json`、`pnpm-lock.yaml` 等 14 个共享文件，导致每次正常的数据库迁移或依赖更新都触发 `COPY_FIXED_SOURCE_FINGERPRINT_MISMATCH` 并被迫手动重签冻结快照哈希（S0-Backend 减负项）。
- 改动：
  1. 删除 `scripts/copy-fixed-source-impact.mjs`、`scripts/copy-fixed-source-impact.spec.mjs`、`scripts/copy-fixed-source-impact-resign.mjs` 与 `scripts/copy-fixed-source-impact-resign.spec.mjs`。
  2. 从 `.github/workflows/ci.yml`（`build-test-core`）移除 `Evaluate Copy fixed-source impact` 与 `Copy Sonnet recovery fixed-source rebuild（顺序隔离）` 步骤，并同步移除 `.github/CODEOWNERS` 与 `.github/required-contexts.json` 中对应的 3 条 Copy 门禁保护规则。
  3. 同步更新 `scripts/governance-contracts.spec.mjs`、`scripts/governance-path-contracts.spec.mjs`、`scripts/governance-ci-topology.spec.mjs` 与 `scripts/governance-document-drift.spec.mjs`，新增断言确认强制指纹门禁已从 CI 与规则中撤除且不再阻塞共享 schema/依赖演进。
  4. 将 `docs/implementation-records/copy-fixed-source-impact-governance.md` 生命周期标记为 `RETIRED` 归档（保留外链与历史静态回执 `docs/evidence/site-builder/copy-runtime-eligibility.json` 不删），并更新 `docs/backend/dependency-refresh.md` 移除失效的重签步骤。
- 测试：已本地跑通 `pnpm governance:verify`、`node --test scripts/governance-document-drift.spec.mjs scripts/governance-ci-topology.spec.mjs scripts/governance-path-contracts.spec.mjs`、`node scripts/governance-changelog-fragments.mjs require --base origin/main --head HEAD`、`pnpm docs:verify` 与 `gitleaks`（0 泄漏）。
- 未做：未改动 `apps/api/src/site-builder/` 业务源码与历史证据 JSON（结构解绑留给后续 S3），未改动 `durable-result-strategies.json` 锁定的 4 个核心文件（留给后续 M10-PR1），也未触碰 `icp/` 或 `rejudge`。
