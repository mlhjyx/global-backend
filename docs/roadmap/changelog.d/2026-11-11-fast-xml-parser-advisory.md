---
date: 2026-11-11
title: Remediate GHSA-474x-hrwr-fgx4 by raising fast-xml-parser to 5.12.0 and rebinding the production baseline
---

- 起因：main 的 Supply Chain Canary 报新生产 advisory `GHSA-474x-hrwr-fgx4`（fast-xml-parser ≤5.11.2，Quadratic CPU consumption scanning unterminated stop-node tags，severity low，修复版 5.12.0）。`apps/api` 直接依赖 `^5.11.2`，`@stoplight` 传递边也解析到 5.11.2。
- 改动：`apps/api/package.json` 升至 `^5.12.0`，锁文件两条边均解析 5.12.0；同 PR 重签 Copy fixed-source 回执（HASH_ONLY，资格未变）；按 dependency-refresh §4 把漏洞基线重绑到锁文件提交 `6457ba67`（`source/bootstap.base_commit`、`source.lockfile_digest`、`captured_at`），更新 `supply-chain-gates.spec.mjs` 的钉住值（`REPOSITORY_BASELINE_NOW`、`expectedBootstrapBase`、锁摘要）；安全下限 `fast-xml-parser` 5.11.0 → 5.12.0 并把 `5.11.2` 登记进 `VULNERABLE_PREDECESSORS`；冻结回执 `docs/evidence/security/20261111-fast-xml-parser-baseline-rebind.json`（旧绑定 `BASELINE_SOURCE_LOCK_MISMATCH` → 新绑定 `FRESH`，0 advisories）。
- 测试：官方 registry 生产审计 0 advisory；`baseline-freshness` 新绑定 `FRESH`；源策略 `DEPENDENCY_SOURCES_TRUSTED`；`governance:verify`、API build/单测与 `gctl check` 全绿；`valid_until`（2027-01-15）不变。
- 未做：未做批量依赖刷新；未改其他包版本。
