# 贡献指南（团队协作流程）

> 面向团队成员与 Claude Code 开发会话；Codex 只在 Claude Code 指派下执行边界明确的任务。权威简版另见 [AGENTS.md](AGENTS.md) §5（所有权、worktree 与外部动作）与 §9（文档与交付）。

## 分支

- **不在 `main` 上直接提交**。`main` 受保护，只经 PR 合入。
- 角色分工见 [AI 辅助开发运行模式](docs/ai-development/operating-model.md)。每项工作从核验过的基线创建独立分支，提交遵循 Conventional Commits。
- 在 xin 工作区，从 [worktree 手册](docs/backend/worktree-management.md) 创建 `/global/.agy-worktrees/backend/<topic>` 下的工作树。开工核对任务、基线和文件 owner。
- 根 `main` 的检查、快进同步和清理都按 [worktree 手册](docs/backend/worktree-management.md#22-根-main-受控跟随) 执行。
- 对依赖当前主线的工作，先核验远端 main 与本地基线；固定基线任务按批准的提交开展并记录日期与限制。
- 已有 `/global/wt/*` 不批量迁移：干净且确认仍需开发的才可用 `git worktree move` 迁入；脏、锁定、失联或承载 provenance 的现场原地冻结并先审计。工具管理且仍被活跃任务持有的 worktree 不得手工移动。
- **PR 合入即删 worktree**：PR 合入后依次删除该任务的 worktree（`git worktree remove`）与本地分支，再在 `/global/backend` 用 `node scripts/governance-main-worktree-sync.mjs apply` 跟随 `main`。删除前确认目标提交已进入 `main`（本仓 squash 合并，要与已合并 PR 交叉核对，不能只看 `rev-list`）、工作区干净、未跟踪文件已逐项归属；有未推送提交或无法归属的文件时先推送或归档，不得强删。常驻的 `local-development` worktree 不在此列。
- 项目内 worktree 位于父 `main` 工作区的 ignored 子树；禁止在 `/global/backend` 运行 `git clean -fdx`、递归删除 `.claude/` 或 `.codex/`，或绕过 `git worktree move/remove` 手工搬删目录。

## 异常恢复审计（先取证，后重做）

出现重启、目录消失、客户端中断或“修改似乎丢失”时，**不得先断言未提交内容不可恢复，也不得立即人工重写**。固定按下列顺序审计：

1. 冻结仍存在的正式 worktree，记录 `cwd`、分支、`HEAD`、`git status` 与 worktree 清单，不在原现场继续覆盖写入。
2. 核对 Git 层：本地/远端分支与 PR、commit、reflog、stash、未跟踪文件和失联 worktree 登记。
3. 核对 Codex 持久层：任务 UI 的“已编辑文件”、本地 `/root/.codex/sessions/**/rollout-*.jsonl` 中成功的 `patch_apply_end`、任务附件与子任务记录。**UI 仍能展示 diff 就说明必须继续追查其持久来源**。
4. 核对文件系统与服务层：原目录是否真的消失、是否只是未挂载/路径变化/权限问题；临时目录只作现场来源，不再作为恢复目标。
5. 从最后可信 commit 在 `/global/.agy-worktrees/backend/<topic>-recovery` 建隔离快照，按原时间顺序重放可证明的变更；先验证事件数和补丁数，再与正式分支逐文件三方比较。原现场无论位于 legacy `/global/wt` 还是工具目录都保持只读。
6. 只有在“原始变更全部可追踪、后来正确修订未被覆盖、diff/check/build/test 通过”后才宣告恢复完成；恢复前的人工重写只能作为候选稿，不能冒充原始内容。

恢复后立即 checkpoint commit + push；临时恢复 worktree 即使计划删除，也必须等 PR 合并、分支清理与独有文件审计完成后再做。

## 提交信息（Conventional Commits）

`type(scope): 摘要` —— `feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `perf`。
正文说清「为什么 + 如何验证」。

## Changelog 片段

- 改了 `apps/`、`packages/`、`scripts/`、`infra/` 任一路径，或根目录构建与运行时文件（`Dockerfile`、`runtime-entrypoint.mjs`、`package.json`、`pnpm-lock.yaml` 等，完整清单见片段 README）的 PR，必须在 `docs/roadmap/changelog.d/` 新增一个片段 `<YYYY-MM-DD>-<slug>.md`（或修改已有片段），不再直接改 `docs/roadmap/changelog.md`。governance 工作流按 PR diff 检查，缺片段即失败；纯文档 PR 不强制。slug 用分支 topic，避免与其他在途 PR 撞名。
- 过渡：只有在片段规则合入 main 之前切出的分支（它离开 main 的分叉点里还没有片段 README），改了代码却只改 `changelog.md`、不加片段才放行，附一条 warning，不必返工；之后切出的分支这样做会失败。旧分支并入 main 要用 merge（GitHub 网页的 Update branch 或解冲突、`git merge origin/main`），分叉点还在，放行保留；rebase 到新 main 后就按新分支处理，须把条目挪进片段。这些旧分支都合完后删除这条放行（见 `docs/governance/docs-verification.md` §4）。
- 检查只管代码 PR 有没有片段，不禁止改 `changelog.md`：纯文档 PR、已有片段又改了 `changelog.md` 的 PR 照样通过，但仍会和别人冲突，所以除汇编 PR 外都不要改它。
- 片段的 frontmatter 写 `date`、`pr`、`title`，正文依次写 `- 起因：` / `- 改动：` / `- 测试：` / `- 未做：`。`pr` 可以留空，汇编时从 squash 提交标题的 `(#N)` 取，不必为补 PR 号再推一次。格式与示例见 [片段目录 README](docs/roadmap/changelog.d/README.md)，`pnpm docs:verify` 校验。
- 汇编：每班发版列车的 PR 合完后，由当班负责合并的开发代理运行 `node scripts/changelog-assemble.mjs`（先 `--dry-run` 看结果），从最新 `origin/main` 建分支，把片段按日期倒序写进 changelog 并删除片段，作为 `docs(changelog)` PR 提交。步骤与回退见 [CI / 审查与合并流程](docs/backend/ci-merge-automation.md#changelog-片段的汇编)。
- 为什么：所有 PR 都改 changelog 同一处，任何一个合入都让其余在途 PR 冲突、被迫并入 main 再跑一轮 CI（ruleset 并不要求分支最新）。各写各的片段后不再冲突。

## 本地必绿（提 PR 前）

```bash
pnpm install
pnpm --filter @global/db generate          # schema 变更后
pnpm --filter @global/api build            # nest build = tsc 全量类型检查
pnpm --filter @global/api test             # vitest
```

**provider / 采集 / 富集类改动**：另需**真实数据实测**（无 sandbox，见 [AGENTS.md](AGENTS.md) §4）：

```bash
cd /global/backend/apps/api && node --import tsx scripts/verify-*.mts
```

## Pull Request

- `gh pr create --base main`，按 `.github/pull_request_template.md` 填（概述 / 改动分组 / 文档与阶段回写 / 测试 / 给产品负责人的说明 / 合规 / 待续）；「给产品负责人的说明」四行（得到什么 / 没改什么 / 风险与回退 / 建议）不经机器解析。
- **当前 head 的必需检查全部通过**才可合。核对[提交的上下文清单](.github/required-contexts.json)与目标分支生效规则。按改动范围走本地检查和 [CI 指南](docs/backend/ci-merge-automation.md)。
- **代码审查**：按 `DEC-AIDEV-004`，由开发代理对每个 PR 做独立审查（`/code-review` 或逐文件审查），发现的问题先修复重验；处置每条意见后在该线程回复并 resolve。
- CI 的单测零容器（无网络）；另有一步在一次性 PostgreSQL 上跑登记的真库用例。需要真源或付费调用的验证走本地 `verify-*` 脚本，不进 CI。

## PR 粒度与风险分级

一个**逻辑改动 = 一个 PR**，不碎片化；同主题 micro 改动攒批、不单开。合并授权统一按 `DEC-AIDEV-004`（产品负责人 2026-09-21 的常设授权，见 [conflict register §11](docs/governance/conflict-register.md#11-aidev-gate-1-已批准决策)），不再逐 PR 请用户确认。

变更分类只有一个口径：[development-process.md](docs/shared/development-process.md) §2B 的 **T0–T3**（T0 普通文档快通道 / T1 产品与规范 / T2 常规代码 / T3 高风险）。分类只决定验证与复核深度，不改变「必须走 PR」；风险级别的复核集合见 [ci-merge-automation.md](docs/backend/ci-merge-automation.md) §风险分级。

三条硬规矩：① 一逻辑改动一 PR（不碎）；② T0 文档改动攒批、搭车不单开；③ 合并遵循 `DEC-AIDEV-004`：开发代理独立审查通过、必需检查全绿并满足该决定其余门后可 squash 合并；不含 ruleset/仓库设置/权限变更、部署发布与付费调用，T3 另加专项复核。协同热点文件与合并顺序见 [docs/site-builder/00-decisions-and-coordination.md](docs/site-builder/00-decisions-and-coordination.md)。

## 合规红线（涉数据源/联系人）

数据分级 🟢公司事实(可商用) / 🟡职能邮箱(ePrivacy) / 🔴人名·联系人(默认隔离 + LIA)。
抓取守 robots/ToS；「法定公开 ≠ 可自由再分发」。详见 [buyer-intelligence-v3.md](docs/research/buyer-intelligence-v3.md)。
