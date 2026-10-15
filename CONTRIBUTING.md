# 贡献指南（团队协作流程）

> 面向团队成员与 Claude Code 开发会话；Codex 只在 Claude Code 指派下执行边界明确的任务。权威简版另见 [AGENTS.md](AGENTS.md) §5（所有权、worktree 与外部动作）与 §9（文档与交付）。

## 分支

- **不在 `main` 上直接提交**。`main` 受保护，只经 PR 合入。
- 当前开发主体为 Claude Code（2026-09-21 起接替 Codex），分支可使用 `claude/<topic>` 或 `codex/<topic>`，从最新 `main` 切出；改动类型用 Conventional Commit 的 `feat` / `fix` / `docs` 等表达。
- `/global/backend` 只承载 `main`。正式施工遵循「一个任务一个 writer 一个 worktree」；Claude Code 可使用 `/global/backend/.claude/worktrees/<topic>` 与 `claude/<topic>`，也可使用 `pnpm worktree:new <topic>` 从最新 `origin/main` 创建 `.codex/worktrees/<topic>` 与 `codex/<topic>`；两种约定都合法。禁止在 `/tmp`、`/private/tmp`、`/root/.codex/worktrees` 或 legacy `/global/wt` 新建正式施工目录。完整创建、迁移、恢复与清理规则见 [worktree 管理 runbook](docs/backend/worktree-management.md)。
- 远端 PR 合入后，本地根 `main` 的跟随使用 `node scripts/governance-main-worktree-sync.mjs status` / `node scripts/governance-main-worktree-sync.mjs apply`。`apply` 只允许 fetch 后把 `origin/main` 解析成精确 commit，再对该 commit 纯 fast-forward，且必须证明远端入站路径不触碰本地 tracked、untracked 或 ignored 现场；任何 ahead/diverged、路径冲突、ref 新鲜度变化或事后状态变化都 fail-closed。它不 stash/reset/clean，不处理 PR、push、merge 授权或分支清理。
- **新鲜度门**：规划、只读审计和实施开始前先执行 `git fetch origin --prune` 与 `git rev-list --count HEAD..origin/main`。若结果非 `0`，该 worktree 已落后，不能据此给出“当前事实”结论；必须从刚 fetch 的 `origin/main` 新建正式 worktree，或先完成受控同步后再继续。功能分支上的已提交工作不免除此门。
- 已有 `/global/wt/*` 不批量迁移：干净且确认仍需开发的才可用 `git worktree move` 迁入；脏、锁定、失联或承载 provenance 的现场原地冻结并先审计。工具管理且仍被活跃任务持有的 worktree 不得手工移动。
- **PR 合入即删 worktree**：PR 合入后依次删除该任务的 worktree（`git worktree remove`）与本地分支，再在 `/global/backend` 用 `node scripts/governance-main-worktree-sync.mjs apply` 跟随 `main`。删除前确认目标提交已进入 `main`（本仓 squash 合并，要与已合并 PR 交叉核对，不能只看 `rev-list`）、工作区干净、未跟踪文件已逐项归属；有未推送提交或无法归属的文件时先推送或归档，不得强删。常驻的 `local-development` worktree 不在此列。
- 项目内 worktree 位于父 `main` 工作区的 ignored 子树；禁止在 `/global/backend` 运行 `git clean -fdx`、递归删除 `.codex/` 或绕过 `git worktree move/remove` 手工搬删目录。

## 异常恢复审计（先取证，后重做）

出现重启、目录消失、客户端中断或“修改似乎丢失”时，**不得先断言未提交内容不可恢复，也不得立即人工重写**。固定按下列顺序审计：

1. 冻结仍存在的正式 worktree，记录 `cwd`、分支、`HEAD`、`git status` 与 worktree 清单，不在原现场继续覆盖写入。
2. 核对 Git 层：本地/远端分支与 PR、commit、reflog、stash、未跟踪文件和失联 worktree 登记。
3. 核对 Codex 持久层：任务 UI 的“已编辑文件”、本地 `/root/.codex/sessions/**/rollout-*.jsonl` 中成功的 `patch_apply_end`、任务附件与子任务记录。**UI 仍能展示 diff 就说明必须继续追查其持久来源**。
4. 核对文件系统与服务层：原目录是否真的消失、是否只是未挂载/路径变化/权限问题；临时目录只作现场来源，不再作为恢复目标。
5. 从最后可信 commit 在 `/global/backend/.claude/worktrees/<topic>-recovery` 或 `/global/backend/.codex/worktrees/<topic>-recovery` 建隔离快照，按原时间顺序重放可证明的变更；先验证事件数和补丁数，再与正式分支逐文件三方比较。原现场无论位于 legacy `/global/wt` 还是工具目录都保持只读。
6. 只有在“原始变更全部可追踪、后来正确修订未被覆盖、diff/check/build/test 通过”后才宣告恢复完成；恢复前的人工重写只能作为候选稿，不能冒充原始内容。

恢复后立即 checkpoint commit + push；临时恢复 worktree 即使计划删除，也必须等 PR 合并、分支清理与独有文件审计完成后再做。

## 提交信息（Conventional Commits）

`type(scope): 摘要` —— `feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `perf`。
正文说清「为什么 + 如何验证」。

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
- **5 项必需检查在当前 head 全绿**才可合（`main` 的 ruleset 要求）：
  - `build · typecheck · test`（`.github/workflows/ci.yml`）
  - `contracts · drift · lint · breaking`（`.github/workflows/ci.yml`）
  - `governance · traceability · release`（`.github/workflows/governance.yml`）
  - `gitleaks 密钥扫描`（`.github/workflows/security.yml`）
  - `renderer visual scope`（`.github/workflows/ci.yml`）
  `github-advanced-security`（Copilot Autofix）不是必需检查。推送前本地先跑 `gctl check`（docs/governance、prisma generate、contracts、lint、build、零容器单测）。
- **代码审查**：按 `DEC-AIDEV-004`，由开发代理对每个 PR 做独立审查（`/code-review` 或逐文件审查），发现的问题先修复重验；处置每条意见后在该线程回复并 resolve。
- CI 的单测零容器（无网络）；另有一步在一次性 PostgreSQL 上跑登记的真库用例。需要真源或付费调用的验证走本地 `verify-*` 脚本，不进 CI。

## PR 粒度与风险分级

一个**逻辑改动 = 一个 PR**，不碎片化；琐碎改动搭车不单开。合并授权统一按 `DEC-AIDEV-004`（产品负责人 2026-09-21 的常设授权，见 [conflict register §11](docs/governance/conflict-register.md#11-aidev-gate-1-已批准决策)），不再逐 PR 请用户确认；风险级别只决定验证与复核深度：

| 级别 | 例子                                        | 处理                                                                                    |
| ---- | ------------------------------------------- | --------------------------------------------------------------------------------------- |
| 琐碎 | 错别字、注释、单行配置、文档措辞            | **不单独发 PR**——搭下一个功能 PR，或攒成一个滚动 `chore:` PR；仍须 CI/审查绿 + `DEC-AIDEV-004` 合并门 |
| 小改 | 一个 bug 修复、小功能、一份文档             | 独立 PR（一个逻辑单元一起，别拆）；CI/审查绿 + `DEC-AIDEV-004` 合并门                                 |
| 实质 | schema/RLS/鉴权/迁移/对外抓取/大量删除/合规 | 独立 PR + **开发代理专项复核**，合并授权按 `DEC-AIDEV-004`                                 |

三条硬规矩：① 一逻辑改动一 PR（不碎）；② 琐碎搭车不单开；③ 合并遵循 `DEC-AIDEV-004`：开发代理独立审查通过、必需检查全绿并满足该决定其余门后可 squash 合并；不含 ruleset/仓库设置/权限变更、部署发布与付费调用，风险类另加专项复核。协同热点文件与合并顺序见 [docs/site-builder/00-decisions-and-coordination.md](docs/site-builder/00-decisions-and-coordination.md)。

## 合规红线（涉数据源/联系人）

数据分级 🟢公司事实(可商用) / 🟡职能邮箱(ePrivacy) / 🔴人名·联系人(默认隔离 + LIA)。
抓取守 robots/ToS；「法定公开 ≠ 可自由再分发」。详见 [buyer-intelligence-v3.md](docs/research/buyer-intelligence-v3.md)。
