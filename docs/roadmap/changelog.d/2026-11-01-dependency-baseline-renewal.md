---
date: 2026-11-01
title: Renew the production dependency audit baseline before it expires on 2026-11-10
---

- 起因：生产依赖漏洞基线 2026-11-10T05:13:39Z 到期。到期后改了依赖输入的 PR 的 `production dependency delta · canary` 和 main 的 freshness canary 都会失败（依赖输入未变的 PR 不读基线，照常通过），所以要在到期前续期。
- 改动：
  - 锁文件自 10-28 qs 重绑（#693）以来没有变动，按 [依赖刷新 runbook](../../backend/dependency-refresh.md) §4「到期续期」只换绑定、延有效期：基线改绑到当时的 main 提交 `9fa20859`，`valid_until` 由 2026-11-10T05:13:39Z 延至 2026-11-14T18:27:04Z，不升级任何依赖。
  - `scripts/supply-chain-gates.spec.mjs` 同步钉住的基线提交与 `REPOSITORY_BASELINE_NOW`。
  - 新增[冻结证据](../../evidence/security/20261101-baseline-renewal.json)，[安全门](../../security/README.md) 与证据索引各加一条记录。
- 测试：官方 registry 生产审计零 advisory（830 个依赖），`supply-chain-audit.mjs verify` 为 `PASS_CLEAR`，新旧绑定下的 `baseline-freshness` 都是 `FRESH`；直接调用 `evaluateProductionAuditBaselineFreshness` 投影：旧基线在 2026-11-10T05:13:38.999Z 还是 `FRESH`、05:13:39.000Z 起 `BASELINE_EXPIRED`，新基线到 2026-11-14T18:27:04Z 前保持 `FRESH`。含开发依赖的全量审计有 6 条 advisory（`@vitest/mocker` 两条、`glob`、`minimatch`、`deepmerge`、faker 5.5.3），全部在生产依赖图之外，没有生产侧新增；`supply-chain-gates.spec.mjs` 28/28 通过；`gctl check`（docs · governance、prisma generate、contracts build、lint、build · typecheck、零容器单测）通过，其中全量单测首轮唯一失败为已登记的 `git-reviewed-evidence-acceptance` 负载假红，单跑 19/19 通过后全量复跑通过。
- 未做：不升级任何依赖；含开发依赖的全量审计的 6 条 advisory 均在生产依赖图之外，留待单独的开发依赖 PR；11 月月度批量刷新另行立项，须在 2026-11-14 前合入或再续期一次。
