---
date: 2026-10-27
pr:
title: Judge duplicate advisories by GHSA, package and affected range
---

- 起因：`2026-10-27` 的依赖刷新 PR #679 上，非必需的 `production dependency delta · canary` 报 `AUDIT_SNAPSHOT_INCONCLUSIVE` / `[AUDIT_COMPARISON_INVALID] trusted PR base audit is incomplete or malformed`，但候选审计为 0 条。根因是受信 base 的锁文件里 `GHSA-xjj6-f33q-929c`、`GHSA-4qv8-2p9j-2685`、`GHSA-f72v-6w45-q472` 各自同时覆盖 undici 7.x 与 8.x 两条版本线，pnpm audit 因此输出两条同 GHSA 同包的记录，而校验器的 `advisoryIdentity` 只取 `ghsa_id|package`，把这两条合法记录判成 `AUDIT_ADVISORY_DUPLICATE`，使 base 审计被判“畸形”。任何改依赖输入的 PR 在 base 带这类多版本线 advisory 时都无法通过该检查。
- 改动：新增 `advisoryLineIdentity`（`GHSA + 包 + vulnerable_versions`），只用于两处重复判定——`normalizePnpmAudit` 的 `AUDIT_ADVISORY_DUPLICATE` 与 baseline 校验的 `BASELINE_ADVISORY_DUPLICATE`；与 baseline 的 ratchet 匹配、finding exposure 归属仍沿用不带区间的 `advisoryIdentity`，语义身份不变。`docs/security/README.md` 的 ratchet 说明补了这条口径。
- 测试：`scripts/supply-chain-gates.spec.mjs` 新增用例覆盖三件事——同一 GHSA 覆盖 undici 7/8 两条线时不再判重复、同一 GHSA 同区间的真重复仍会报 `AUDIT_ADVISORY_DUPLICATE`、以及受信 base 带双线 advisory 时 delta 从 `AUDIT_SNAPSHOT_INCONCLUSIVE` 回到 `COMPARABLE_AUDIT_PASS`。该 spec 28/28 通过，`pnpm governance:verify` 全绿。
- 未做：没有改动 `advisoryIdentity` 本身，因此 baseline 匹配与 exposure 归属的行为保持不变；`evaluateProductionAudit` 的 `expectedBootstrapBase` 精确集校验仍按 GHSA+包 折叠（bootstrap 只在新基线首次引入时使用，当前无调用方遇到多版本线基线）。
