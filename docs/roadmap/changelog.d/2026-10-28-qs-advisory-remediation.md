---
date: 2026-10-28
title: Pin qs to the patched 6.16.1 release and rebind the production audit baseline
---

- 起因：10-27 基线重绑之后，GitHub 又发布了 GHSA-6pq8-jhm2-2vcw（`qs.stringify` 对带不可调用 `toString` 的数组元素抛未捕获 TypeError，moderate，影响 `>=6.7.0 <=6.16.0`）。锁文件仍带着 express 与 webpack `url` 垫片引入的 `qs@6.16.0`，main 的 `production advisory baseline freshness · canary` 因此变 `BASELINE_STALE`（run 40675525935，subject `a30ac929`）。
- 改动：
  - 根 `pnpm.overrides` 新增 `qs@>=6.7.0 <6.16.1 → 6.16.1`，锁文件里 qs 收敛为单一版本 6.16.1（同时带入 pnpm 对平台包 `libc` 元数据的规范化）。
  - `SECURITY_FLOORS` 的 qs 下限升到 6.16.1，`qs@6.16.0` 登记为漏洞前任。
  - 基线重绑到修复提交 `6510fb5f`（锁文件摘要随之更新），`valid_until` 维持 2026-11-10；`scripts/supply-chain-gates.spec.mjs` 的钉值同步；新增冻结回执 `docs/evidence/security/20261028-qs-advisory-remediation.json`（修复前 CI 上的 `BASELINE_STALE`/1 条 → 修复后 `FRESH`/0 条）。
- 测试：`node scripts/supply-chain-audit.mjs verify` 为 `PASS_CLEAR`（零 advisory）；`baseline-freshness` 在旧绑定下 `BASELINE_SOURCE_LOCK_MISMATCH`、新绑定下 `FRESH`；`scripts/supply-chain-gates.spec.mjs` 28/28、`scripts/dependency-security-remediation.spec.mjs` 9/9；`supply-chain-source-policy validate-sources` 为 `DEPENDENCY_SOURCES_TRUSTED`。
- 未做：未升级全量依赖（月度批量刷新仍按 11 月节奏）；开发依赖侧既有的 4 条 advisory（faker、vitest mocker ×2、deepmerge）不在生产基线口径内，本次未动。
