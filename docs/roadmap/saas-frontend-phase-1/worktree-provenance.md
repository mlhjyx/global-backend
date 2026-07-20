# Phase 1 分支与 worktree provenance

> 文档 ID：AUD-FE-P1-006
> 状态：`COMPLETE_FOR_GATE_1`
> 核验时间：2026-07-20
> 目的：防止把历史现场、未合并分支或脏工作区误写成 main 的 as-built

## 1. 当前唯一审计基线

- 主工作区：`/global/backend`
- 分支：`main`
- 冻结审计基线/本地 `main`：`c3f0cca80e228f08f35c89776f759748dac78ce2`
- 实时 `origin/main`（最终核验时）：`676c6cdc175326927ec341a2d585168aa0a1a374`
- 本阶段施工区：`/global/backend/.codex/worktrees/saas-frontend-doc-plan`
- 本阶段分支：`codex/saas-frontend-doc-plan`

所有实现矩阵和本次测试数字均以冻结提交为准。开放/未合并分支只能证明“存在候选实现或历史 provenance”，不能证明 main 已实现，也不能由本审计决定合并。远端在审计期间发生的变化另列，避免偷偷换基线。

## 2. 与 SaaS 前端文档直接相关的非 main 现场

| 现场 | 相对冻结基线 | 工作区状态 | 能证明什么 | 不能证明什么/处置 |
|---|---:|---|---|---|
| `codex/r1-min-release` / `.codex/worktrees/r1-min-release` | 相对冻结基线后 0、前 29 commits；HEAD `79ea622d…` | 干净 | 冻结时 R1-min 在独立施工；其后 PR #157 已 squash merge 到实时 main | 不把分支 commit ancestry 当合并结论；新 main 需独立 delta 核验 |
| `codex/template-distillation` / `.codex/worktrees/template-distillation` | main 后 3、前 6；HEAD `5bb4fab0…` | 干净 | 有从模板研究形成的组件/页面候选；远端分支存在 | 未确认适用范围、许可、质量或是否应合并；不能当现役 renderer 真值 |
| `codex/r4-a2-claim-evidence` / `/global/wt/r4-a2-claim-evidence` | main 后 8、前 79；HEAD `e577325e…` | 大量已修改文件 | 保留 R4-A2 与后续试验 provenance | main 已通过其他提交落入 R4-A2 能力；该现场仍脏，禁止清理、移动或用 ancestor 关系断言内容归属 |
| `codex/r1-min` | main 后 2、前 0 | 旧基线 | 是 M1-d 合并前的启动点 | 已落后，不代表当前 R1-min 实现 |
| `codex/r1-min-boundary` / `codex/r1-min-di0-boundary-correction` | 各自保留 1 个独有 docs commit | 历史边界修正文脉 | 解释 R1-min 与 DI-0 ownership 如何被校正 | main 已经由 #155/#156 收口；旧分支不再替代当前文档 |

## 3. 全局 worktree 风险

本次 `git worktree list --porcelain` 共登记 **41** 个 worktree：项目内 Codex 工作区、legacy `/global/wt/*`、工具托管 detached 工作区以及 4 个已失联且 locked 的旧 Mac Claude 路径。该数字用于暴露并发与 provenance 风险，不代表有 41 项待合并工作。

相对实时 `origin/main` 仍非 ancestor 的远端 heads 包括：

- `origin/codex/r1-min-release`
- `origin/codex/r4-a2-claim-evidence`
- `origin/codex/template-distillation`

“非 ancestor”不等于“有待合并工作”：`codex/r1-min-release` 对应 PR #157 已 squash merge，分支保留只是 provenance。实时 `gh pr list --state open` 为 **0**；R4-A2 和 template-distillation 虽有远端 head，但没有开放 PR，是否保留/采用仍由各自任务裁决。

## 4. 审计后远端事件

2026-07-20 04:45:30 UTC，PR [#157](https://github.com/mlhjyx/global-backend/pull/157) `feat(site-builder): deliver R1-min immutable Releases` 合并为 `676c6cdc175326927ec341a2d585168aa0a1a374`；CI、contracts drift/lint/breaking 和 gitleaks 三组检查均成功。本报告只核验了 PR 元数据、merge commit、变更统计和检查状态，没有在冻结 worktree 上把新 main 与既有测试数字混跑。

## 5. 主工作区用户现场

主工作区包含用户自己的未跟踪/删除状态，包括 `.playwright-cli/`、`docs/agile-iteration-flowchart.html`、`template/` 和删除中的 `docs/templates/前端技术方案模板.md`。本阶段只读审计这些输入，所有新文档均写入隔离 worktree；不恢复、覆盖、移动、清理或提交用户现场。

## 6. Gate 1 后仍需单独处理的事项

1. #157 已完成合并；进入 Phase 2 前在最新 main 上对 Release/Preview/恢复/回收/unknown component 等受影响能力做 delta truth-sync，不复用冻结基线结论冒充新验证。
2. 对 `template-distillation` 做内容等价、来源许可、组件契约和质量评审后再决定采用/拆分/放弃。
3. 对 R4-A2 legacy 脏 worktree 先做独有提交、diff、未跟踪文件和任务日志审计；任何清理都需要单独授权。
4. 历史 Mac locked worktree 只作 provenance，不在本阶段迁移或删除。

结论：历史现场已经被隔离登记；本阶段所有 `AS_BUILT` 判断都回到 main 代码、机器契约和测试，不再用“某分支里有”替代“main 已有”。
