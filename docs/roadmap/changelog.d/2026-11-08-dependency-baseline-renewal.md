---
date: 2026-11-08
title: Renew the production dependency audit baseline to 2027-01-15
---

- 起因：生产漏洞基线 `docs/security/production-dependency-audit-baseline.json` 于 2026-11-14 到期；到期后依赖输入变更的 PR 与 main 的 freshness canary 都会失败，卡住 M0/M1/M2 在飞列车。
- 改动：按 `docs/backend/dependency-refresh.md` §4 的到期续期路径，把 `governance.valid_until` 延到 `2027-01-15T00:00:00.000Z`，并把 `source.base_commit` / `bootstrap.base_commit` 重绑到当前 main（`bf0a7f8d`）、`captured_at` 更新为本次审计时间；锁文件未变（digest 与 2026-11-04 绑定一致）。同步更新 `scripts/supply-chain-gates.spec.mjs` 的基线提交与验证时钟，并冻结旧/新绑定的 freshness 回执到 `docs/evidence/security/20261108-baseline-renewal.json`。
- 测试：`pnpm audit --prod --registry=https://registry.npmjs.org` 零 advisory；`node scripts/supply-chain-audit.mjs verify` = `PASS_CLEAR`；`baseline-freshness` 旧/新绑定均 `FRESH`；`pnpm governance:verify`、`node --test scripts/supply-chain-gates.spec.mjs`、`pnpm docs:verify` 通过。
- 未做：未升级任何依赖、未改 `pnpm-lock.yaml`；下次月度依赖刷新仍会在新窗口内重新审计并续期。
