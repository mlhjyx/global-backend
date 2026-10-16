---
date: 2026-10-15
pr:
title: Accept a direct changelog edit only from a branch cut before the fragment rule
---

- 起因：#658 的过渡放行写成了「直接改 `changelog.md` 也算满足」，并且对任何 PR 都放行、没有终点，只能等仓外指令改掉。修复增量复审回放了 main 最近 40 个合入：36 个只改 `changelog.md`，规则实际上只剩一条 warning。复审建议按合并基点放行：不看时钟，不写死 SHA，结果可复现，过渡会自然结束。
- 改动：
  - `scripts/governance-changelog-fragments.mjs`：新增 `branchPredatesFragmentRule`。它计算 PR 的合并基点，看基点里有没有片段 README。`fragmentRequirement` 新增 `changelogEditAccepted` 参数，默认不放行。`require` 只对规则合入前切出的分支放行直接改 `changelog.md`（附 warning）；之后切出的分支这样做会失败，报错提示把条目挪进片段。合并基点算不出时失败，不放行。
  - 片段 README 的「过渡」改为按合并基点；同时补半句：`apps/`、`packages/` 下的 Markdown 也算代码路径（复审 N4）。
  - `docs/governance/docs-verification.md`：§3 的检查说明、§4 的例外行改为新的放行条件和关闭条件。
  - `docs/backend/ci-merge-automation.md`：「回退」不再说片段检查本来就接受直接改 `changelog.md`（复审 N1）。
- 测试：`node --test scripts/governance-changelog-fragments.spec.mjs` 36 项通过，改动前 3 项红：
  - 单测：同样的改动，放行模式通过，不放行模式失败；
  - 规则合入后切出的分支直接改 `changelog.md`，`require` 退出码 1，报「cut after the fragment rule」；
  - 新增夹具：基点里没有 README 的分支直接改 `changelog.md`、main 随后合入规则，`require` 退出码 0，带「cut before the fragment rule」warning。
  本 PR 自己在规则合入后切出，按新规则写了这个片段。
- 未做：复审 N2（片段改名后 PR 号记到改名的 PR）、N3（新增根目录文件在 push 到 main 时的分类用例）只是 NIT，没有改。
