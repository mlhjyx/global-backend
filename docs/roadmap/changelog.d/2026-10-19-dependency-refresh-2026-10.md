---
date: 2026-10-19
title: Renew the production dependency audit baseline before it expires on 2026-10-24
---

- 起因：生产依赖漏洞基线 2026-10-24T13:59:34Z 到期。到期后所有 PR 的 `production dependency delta · canary` 和 main 的 freshness canary 都会失败，续期 PR 自己也不例外（它读的是受信 base 上已过期的基线），所以必须在到期前合入。
- 改动：
  - 锁文件自 10-10 月度刷新（#624）以来没有变动，按 [依赖刷新 runbook](../../backend/dependency-refresh.md) §4 只做到期续期：基线改绑到当时的 main 提交 `6f95c44e`，`valid_until` 延至 2026-11-02T11:27:18Z。
  - `scripts/supply-chain-gates.spec.mjs` 同步钉住的基线提交与 `REPOSITORY_BASELINE_NOW`。
  - 新增 [冻结证据](../../evidence/security/20261019-baseline-renewal.json)，[安全门](../../security/README.md) 与证据索引各加一条记录。
- 测试：官方 registry 生产审计零 advisory（831 个依赖），`supply-chain-audit.mjs verify` 为 `PASS_CLEAR`，新旧绑定下的 `baseline-freshness` 都是 `FRESH`；直接调用 `evaluateProductionAuditBaselineFreshness` 投影，旧基线自 10-24T13:59:34Z 起 `BASELINE_EXPIRED`，新基线到 11-02 前保持 `FRESH`；含开发依赖的全量审计只有 main 上已开的两条开发告警（Dependabot #80、#118），没有新增；`supply-chain-gates.spec.mjs` 27/27 通过。
- 未做：不升级任何依赖，11 月的月度批量刷新另行立项，须在 11-02 前合入或再续期一次。`baseline-freshness` 命令行的 `--observed-at` 只写进回执、不参与有效期判断，这次没有改。
