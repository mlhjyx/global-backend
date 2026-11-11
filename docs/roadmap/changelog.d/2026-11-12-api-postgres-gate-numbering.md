---
date: 2026-11-12
title: Renumber the API Postgres coverage gate to G15 and register it
---

- 起因：K-2 的 API Postgres 套件覆盖门在 #1023 中编号为 G10，但 `docs/backend/ci-gates.md` 已把 G10–G12 预留给前端预算门；同一编号两个含义，且新门没有按「每道门上线同一天更新登记簿」的规则登记。
- 改动：
  - 把脚本、CI 步骤、基线与 schema 版本从 G10 重命名为 G15：`scripts/governance-api-postgres-coverage.mjs`、`docs/governance/ci-baselines/g15-api-postgres-suites.json`、`docs/governance/ci-baselines/g15-api-postgres-suites/v1`。
  - 在 `docs/backend/ci-gates.md` 登记 G15 的位置、阻断条件、基线与 owner，并注明它只锁定「套件必须在 CI 或被登记豁免」这一分类事实，不执行 `packages/db` 的 manual 组。
- 测试：`node scripts/governance-api-postgres-coverage.mjs verify`；`pnpm docs:verify`；CI 必需检查。
- 未做：不改变 19 个 manual 套件的执行现状（仍属 G5 后续项）；不占用 G10–G12 的前端预算编号。
