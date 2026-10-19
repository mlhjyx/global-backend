---
date: 2026-10-15
pr:
title: Accept a direct changelog edit only from a branch cut before the fragment rule
---

- 起因：#658 的过渡放行写成了「直接改 `changelog.md` 也算满足」，并且对任何 PR 都放行、没有终点，只能等仓外指令改掉。修复增量复审回放了 main 最近 40 个合入：36 个只改 `changelog.md`，规则实际上只剩一条 warning。复审建议按分支切出的位置放行：不看时钟，不写死 SHA，结果可复现，过渡会自然结束。第一版只看合并基点，二轮复审发现旧分支一旦 merge 进 main，合并基点就变成带 README 的 main，放行随之丢失，报错还说它是规则合入后切出的；唯一在途的旧分支（草稿，与 main 冲突）合入前必须先并入 main，正好会踩到。
- 改动：
  - `scripts/governance-changelog-fragments.mjs`：新增 `branchPredatesFragmentRule`。它用 `rev-list --boundary base..head` 找出分支离开 base 的所有分叉点，只要有一个分叉点里没有片段 README，就算规则合入前切出的分支。merge 进 main 后原来的分叉点还在（不论 merge 时谁是第一个父提交），放行保留；rebase 会把分叉点挪到新 main，之后只能写片段。分叉点找不到（无关或浅历史）或目录树读不出时失败，不放行；读树改用 `ls-tree`，路径缺失与读取出错不再混为一谈。`fragmentRequirement` 新增 `changelogEditAccepted` 参数，默认不放行。`require` 只对旧分支放行直接改 `changelog.md`（附 warning）；之后切出或 rebase 过的分支这样做会失败，报错提示把条目挪进片段。
  - 片段 README 与 `CONTRIBUTING.md` 的「过渡」改为按分叉点，写明旧分支并入 main 要用 merge、不要 rebase；补一条：检查只管代码 PR 有没有片段，不禁止改 `changelog.md`。README 还补半句：`apps/`、`packages/` 下的 Markdown 也算代码路径（复审 N4）。
  - `docs/governance/docs-verification.md`：§2 的检查说明、§4 的例外行改为新的放行条件；关闭条件改成可执行的检查：`gh pr list --state open` 的每个 PR 运行 `require` 都不再打印 cut-before warning。
  - `docs/backend/ci-merge-automation.md`：汇编步骤加第 5 步，给出上述检查的命令；「冲突」改为旧 PR 用 merge 解冲突、不要 rebase；「回退」不再说片段检查本来就接受直接改 `changelog.md`（复审 N1）。
  - `.github/workflows/governance.yml`：`require` 一步的注释不再说改 changelog 总能满足。
- 测试：`node --test scripts/governance-changelog-fragments.spec.mjs` 40 项通过。先红后绿：
  - 旧分支 merge 进 main（分支在前、main 在前两种父提交顺序），`require` 退出码 0 且带 cut-before warning，修复前退出码 1；
  - 旧分支 rebase 到新 main 后，`require` 退出码 1，报错写明 rebase；
  - 分叉点找不到、基点不存在、分叉点目录树被删时 `branchPredatesFragmentRule` 抛错，修复前目录树读不出被当成旧分支放行；
  - `CONTRIBUTING.md` 与片段 README 的「过渡」、workflow 注释、§4 关闭条件的文字与实现一致；
  - 单测：同样的改动，放行模式通过，不放行模式与默认参数都失败。
  另在本仓真实历史上复现：唯一在途旧分支的 head 与 main 用 `merge-tree` 加 `commit-tree` 合成合并提交（不建引用），修复前 `require` 退出码 1，修复后 0。本 PR 自己在规则合入后切出，按新规则写了这个片段。
- 未做：
  - 叠在旧分支上切出的新分支同样有早于规则的分叉点，照样放行；它带着旧分支的 `changelog.md` 改动一起合入，按提交逐个归属改动得不偿失，登记为 §4 的风险。
  - 复审 N2（片段改名后 PR 号记到改名的 PR）、N3（新增根目录文件在 push 到 main 时的分类用例）只是 NIT，没有改。
  - 仓外 `/global/CLAUDE.md` §7 把新规则说成「直接改 changelog 会被拦下」，实际只拦没有片段的代码 PR；不在本仓，没有改。
