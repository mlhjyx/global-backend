# 贡献指南（团队协作流程）

> 面向团队成员与 Codex 会话。权威简版另见 [AGENTS.md §8](AGENTS.md)。

## 分支

- **不在 `main` 上直接提交**。`main` 受保护，只经 PR 合入。
- Codex 开发分支统一使用 `codex/<topic>`，从最新 `main` 切出；改动类型用 Conventional Commit 的 `feat` / `fix` / `docs` 等表达。
- `/global/backend` 只承载 `main`。正式 Codex worktree 统一放在 `/global/backend/.codex/worktrees/<topic>`，使用 `pnpm worktree:new <topic>` 从最新 `origin/main` 创建 `codex/<topic>`；禁止在 `/tmp`、`/private/tmp`、`/root/.codex/worktrees` 或 legacy `/global/wt` 新建正式施工目录。完整创建、迁移、恢复与清理规则见 [worktree 管理 runbook](docs/backend/worktree-management.md)。
- **新鲜度门**：规划、只读审计和实施开始前先执行 `git fetch origin --prune` 与 `git rev-list --count HEAD..origin/main`。若结果非 `0`，该 worktree 已落后，不能据此给出“当前事实”结论；必须从刚 fetch 的 `origin/main` 新建正式 worktree，或先完成受控同步后再继续。功能分支上的已提交工作不免除此门。
- 已有 `/global/wt/*` 不批量迁移：干净且确认仍需开发的才可用 `git worktree move` 迁入；脏、锁定、失联或承载 provenance 的现场原地冻结并先审计。工具管理且仍被活跃任务持有的 worktree 不得手工移动。
- worktree 合并后**不要求立即删除**；删除仅是可选的本地空间/目录清理。只有在 PR 已合并、目标提交已进入 `main`、工作区干净且未跟踪文件已逐项归属后才可删除；需要回查、继续维护或留作开发现场时可以保留，并定期审计即可。
- 项目内 worktree 位于父 `main` 工作区的 ignored 子树；禁止在 `/global/backend` 运行 `git clean -fdx`、递归删除 `.codex/` 或绕过 `git worktree move/remove` 手工搬删目录。

## 异常恢复审计（先取证，后重做）

出现重启、目录消失、客户端中断或“修改似乎丢失”时，**不得先断言未提交内容不可恢复，也不得立即人工重写**。固定按下列顺序审计：

1. 冻结仍存在的正式 worktree，记录 `cwd`、分支、`HEAD`、`git status` 与 worktree 清单，不在原现场继续覆盖写入。
2. 核对 Git 层：本地/远端分支与 PR、commit、reflog、stash、未跟踪文件和失联 worktree 登记。
3. 核对 Codex 持久层：任务 UI 的“已编辑文件”、本地 `/root/.codex/sessions/**/rollout-*.jsonl` 中成功的 `patch_apply_end`、任务附件与子任务记录。**UI 仍能展示 diff 就说明必须继续追查其持久来源**。
4. 核对文件系统与服务层：原目录是否真的消失、是否只是未挂载/路径变化/权限问题；临时目录只作现场来源，不再作为恢复目标。
5. 从最后可信 commit 在 `/global/backend/.codex/worktrees/<topic>-recovery` 建隔离快照，按原时间顺序重放可证明的变更；先验证事件数和补丁数，再与正式分支逐文件三方比较。原现场无论位于 legacy `/global/wt` 还是工具目录都保持只读。
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

**provider / 采集 / 富集类改动**：另需**真实数据实测**（无 sandbox，见 [AGENTS.md §5](AGENTS.md)）：

```bash
cd /global/backend/apps/api && node --import tsx scripts/verify-*.mts
```

## Pull Request

- `gh pr create --base main`，按 `.github/pull_request_template.md` 填（概述 / 改动分组 / 测试 / 合规 / 待续）。
- **CI 必须绿**才可合：
  - `CI`（`.github/workflows/ci.yml`）：install → prisma generate → build → test。
  - `Security`（`.github/workflows/security.yml`）：gitleaks 密钥扫描。
- **代码审查**：仓库启用了 Codex 自动审查（开 PR / 标 ready / 评论 `@codex review` 触发）。处置每条 inline 意见后在该线程回复并 resolve。
- CI 只跑**纯单测**（无 DB/网络）；需要 DB/真源的验证走本地 `verify-*` 脚本，不进 CI。

## PR 粒度与风险分级

一个**逻辑改动 = 一个 PR**，不碎片化；琐碎改动搭车不单开。所有 PR 都须用户明确确认，风险级别只决定验证与复核深度：

| 级别 | 例子 | 处理 |
|---|---|---|
| 琐碎 | 错别字、注释、单行配置、文档措辞 | **不单独发 PR**——搭下一个功能 PR，或攒成一个滚动 `chore:` PR；仍须 CI/审查绿 + 用户确认 |
| 小改 | 一个 bug 修复、小功能、一份文档 | 独立 PR（一个逻辑单元一起，别拆）；CI/审查绿 + 用户确认 |
| 实质 | schema/RLS/鉴权/迁移/对外抓取/大量删除/合规 | 独立 PR + **Codex 专项复核 + 用户明确确认**，不自动合并 |

三条硬规矩：① 一逻辑改动一 PR（不碎）；② 琐碎搭车不单开；③ Codex 不得自行合并，所有 PR 都须用户明确确认，风险类另加专项人审。协同热点文件与合并顺序见 [docs/site-builder/00-decisions-and-coordination.md](docs/site-builder/00-decisions-and-coordination.md)。

## 合规红线（涉数据源/联系人）

数据分级 🟢公司事实(可商用) / 🟡职能邮箱(ePrivacy) / 🔴人名·联系人(默认隔离 + LIA)。
抓取守 robots/ToS；「法定公开 ≠ 可自由再分发」。详见 [buyer-intelligence-v3.md](docs/research/buyer-intelligence-v3.md)。
