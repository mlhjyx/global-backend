---
date: 2026-11-11
title: Skip the contracts gate's build steps on docs-only pull requests
---

- 起因：纯文档 PR 的 `contracts · drift · lint · breaking` 仍执行完整 install、Prisma generate、contracts/API build 与 OpenAPI 导出（约 4–6 分钟），与 `build · typecheck · test` 已生效的 `run_code` 快通道不一致；#776 的 changelog 声称 contracts 已短路，但实现从未落地。
- 改动：`contracts` job 接入 `renderer-visual-scope.outputs.run_code`——代码步骤默认运行（`!= 'false'`），仅分类器显式判定纯文档时跳过，并新增「契约面未变化」证明步；job 增加 `needs` 与 fail-closed 首步，scope 失败时显式失败而非 skipped；`required-contexts.json` 为其登记与 build job 相同的 approved `${{ !cancelled() }}` 条件；`governance-ci-topology.spec.mjs` 锁定这些约束。
- 测试：`node --test scripts/governance-ci-topology.spec.mjs`；`node scripts/governance-verify.mjs verify`；`node scripts/verify-docs.mjs`。真实时长对比在本 PR 与后续纯文档 PR 的 checks 上观察。
- 未做：不改 build-test 的既有快通道；不引入 affected 依赖图、远程缓存或 merge queue。
