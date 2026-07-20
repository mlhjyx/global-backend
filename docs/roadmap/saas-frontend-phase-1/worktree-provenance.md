# Phase 1 分支与 worktree provenance

> 文档 ID：AUD-FE-P1-006
> 状态：`COMPLETE_FOR_GATE_1`
> 核验时间：2026-07-20
> 目的：防止把历史现场、未合并分支或脏工作区误写成 main 的 as-built

## 1. 当前唯一审计基线

- 主工作区：`/global/backend`
- 分支：`main`
- HEAD 与 `origin/main`：`c3f0cca80e228f08f35c89776f759748dac78ce2`
- 本阶段施工区：`/global/backend/.codex/worktrees/saas-frontend-doc-plan`
- 本阶段分支：`codex/saas-frontend-doc-plan`

所有实现状态均先以该 main 提交为准。开放/未合并分支只能证明“存在候选实现或历史 provenance”，不能证明 main 已实现，也不能由本审计决定合并。

## 2. 与 SaaS 前端文档直接相关的非 main 现场

| 现场 | 相对 main | 工作区状态 | 能证明什么 | 不能证明什么/处置 |
|---|---:|---|---|---|
| `codex/r1-min-release` / `.codex/worktrees/r1-min-release` | main 后 0、前 29 commits；HEAD `79ea622d…` | 干净 | R1-min 的生产 Release/跨节点恢复等正在独立施工，候选代码量显著 | 未推导为 main；Gate 1 只记录，不评审、合并、推送或宣布完成 |
| `codex/template-distillation` / `.codex/worktrees/template-distillation` | main 后 3、前 6；HEAD `5bb4fab0…` | 干净 | 有从模板研究形成的组件/页面候选；远端分支存在 | 未确认适用范围、许可、质量或是否应合并；不能当现役 renderer 真值 |
| `codex/r4-a2-claim-evidence` / `/global/wt/r4-a2-claim-evidence` | main 后 8、前 79；HEAD `e577325e…` | 大量已修改文件 | 保留 R4-A2 与后续试验 provenance | main 已通过其他提交落入 R4-A2 能力；该现场仍脏，禁止清理、移动或用 ancestor 关系断言内容归属 |
| `codex/r1-min` | main 后 2、前 0 | 旧基线 | 是 M1-d 合并前的启动点 | 已落后，不代表当前 R1-min 实现 |
| `codex/r1-min-boundary` / `codex/r1-min-di0-boundary-correction` | 各自保留 1 个独有 docs commit | 历史边界修正文脉 | 解释 R1-min 与 DI-0 ownership 如何被校正 | main 已经由 #155/#156 收口；旧分支不再替代当前文档 |

## 3. 全局 worktree 风险

本次 `git worktree list --porcelain` 共登记 **41** 个 worktree：项目内 Codex 工作区、legacy `/global/wt/*`、工具托管 detached 工作区以及 4 个已失联且 locked 的旧 Mac Claude 路径。该数字用于暴露并发与 provenance 风险，不代表有 41 项待合并工作。

当前远端 `origin/main` 未合并分支至少包括：

- `origin/codex/r4-a2-claim-evidence`
- `origin/codex/template-distillation`

`codex/r1-min-release` 当前是本地分支/工作树，没有可用的同名远端引用。此前若仅凭命名或旧状态把它写成 remote 分支，会形成新的事实漂移。

## 4. 主工作区用户现场

主工作区包含用户自己的未跟踪/删除状态，包括 `.playwright-cli/`、`docs/agile-iteration-flowchart.html`、`template/` 和删除中的 `docs/templates/前端技术方案模板.md`。本阶段只读审计这些输入，所有新文档均写入隔离 worktree；不恢复、覆盖、移动、清理或提交用户现场。

## 5. Gate 1 后仍需单独处理的事项

1. 由对应施工任务提交 R1-min 的测试、review、PR 与合并证据；本计划不得替它宣布状态。
2. 对 `template-distillation` 做内容等价、来源许可、组件契约和质量评审后再决定采用/拆分/放弃。
3. 对 R4-A2 legacy 脏 worktree 先做独有提交、diff、未跟踪文件和任务日志审计；任何清理都需要单独授权。
4. 历史 Mac locked worktree 只作 provenance，不在本阶段迁移或删除。

结论：历史现场已经被隔离登记；本阶段所有 `AS_BUILT` 判断都回到 main 代码、机器契约和测试，不再用“某分支里有”替代“main 已有”。
