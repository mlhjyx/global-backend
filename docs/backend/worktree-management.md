# Worktree 管理 runbook

> 生命周期：`GUIDE`
> 生命周期依据：worktree 布局与 governor 同步的现行规程

> 适用于 Ubuntu 当前开发环境。目标是让 `main`、正式施工、历史取证与工具临时状态在路径和生命周期上相互隔离。

## 1. 固定布局与不变量

| 位置 | 用途 |
| --- | --- |
| `/global/backend` | 根 main，仅跟随主线和用于现场审计 |
| `/global/.agy-worktrees/backend/<topic>` | xin 上的新任务隔离工作树 |
| `/global/backend/.claude/worktrees/`、`/global/backend/.codex/worktrees/` | 既有任务注册；保留 owner 与未交付工作 |
| `/global/wt/` | 历史现场，按 §3 审计 |

一个任务一个 writer、一个隔离工作树。选用已核验的精确 Git 提交；普通任务用远端 main，固定基线任务沿用其批准的提交。T3 的会话仓目录和共享规则链接须分别核对。已绑定的审计副本用于读取基线，正式写入使用本节认可的任务路径或工作区已明确批准的例外。

## 2. 创建新 worktree

在 xin 先核对注册和任务 owner，再核验远端 main 返回的完整 SHA。确保对象已存在于本地，目标目录和分支由本任务独占。以下为建树示例：

```bash
cd /global/backend
pnpm worktree:inventory
git ls-remote origin refs/heads/main
git cat-file -e '<verified-sha>^{commit}'
git worktree add -b docs/<topic> /global/.agy-worktrees/backend/<topic> <verified-sha>
git -C /global/.agy-worktrees/backend/<topic> status --short --branch
```

在新工作树复核 `HEAD`，按 [README](../../README.md#本地起步) 准备依赖和所需配置。仓内 `pnpm worktree:new` 固定使用 `.claude/worktrees/`，见 `scripts/create-worktree.mjs`；xin 上新任务使用上面的工作区路径。

### 2.1 规划、审计与实施的新鲜度门

需要确认远端 main 当前状态或创建默认基线的实施 worktree 时，在任务的只读网络范围内刷新引用：

```bash
git fetch origin
git rev-list --count HEAD..origin/main
```

输出为 `0` 才能称该 worktree 已包含所刷新远端 main 的全部提交；本分支自身的功能提交不证明同步。若有 origin-only 提交，先检查与任务相关的差异，不以旧基线冒充当前 main，也不自动替换已批准的固定基线。需要当前 main 施工时新建正式 worktree，根目录同步仍只走下节受控入口。

针对已指定 commit、历史 provenance 或现有文件的只读审计，不因进入新消息或流程阶段重复 fetch、创建 worktree；报告其精确基线及局限。未刷新时把 `origin/main` 标为本地 cached ref。相关权限或网络不可用时继续独立的本地调查，保留远端当前性缺口，不宣称完成依赖该缺口的验收。该规则不放宽重叠 writer、未知独有提交或现场保护门。

### 2.2 根 `main` 受控跟随

远端已经合入且本地同步获授权时，先确认只会快进且入站路径不覆盖本地文件。当前工作区允许的根同步命令为 `git pull --ff-only origin main`。遇到 ahead、分歧、未交付改动或路径冲突时保留现场。

```bash
cd /global/backend
node scripts/governance-main-worktree-sync.mjs status
```

`status` 为只读查询，使用本地已缓存的远端跟踪引用。脚本保留仓内可审计的 `apply` 实现，用于其获授权的运行场合；在 xin 以工作区根同步规则为准。PR/CI/审查的证据另行确认。

## 3. legacy `/global/wt` 迁移判定

迁移按单个 worktree 决策，禁止批量搬运。

| 状态                                     | 动作                                                  |
| ---------------------------------------- | ----------------------------------------------------- |
| 干净、未锁定、确认仍需继续开发           | 记录清单后使用 `git worktree move` 迁入新目录         |
| 已合并且无独有内容                       | 不迁移；满足清理门后删除                              |
| tracked 或 untracked 非空                | 原地冻结；先做精确 manifest、diff、hash 与归属审计    |
| detached、锁定、路径失联或工具任务仍活跃 | 不迁移；先核对任务、分支、reflog 与 worktree metadata |
| 含 submodule                             | `git worktree move` 不支持；停止并单独规划            |

干净且确认继续使用时，迁移命令形如：

```bash
git worktree move \
  /global/wt/<topic> \
  /global/.agy-worktrees/backend/<topic>
```

移动前后都要记录并比较：路径、分支、HEAD、`git status --short` 和 `git worktree list --porcelain`。迁移不授予删除分支、覆盖文件或清理旧现场的权限。

## 4. 删除与清理门

以下条件必须同时满足：

1. 对应 PR 已合并，目标提交已进入最新 `origin/main`；squash merge 场景须做内容/PR 对账，不能只依赖 ancestor 判断；
2. worktree tracked status 为零；
3. untracked 文件逐项确认已提交、迁移、归档或可丢弃；
4. 没有独有 commit、reflog、stash、Codex/Claude 任务补丁或附件证据待核；
5. 没有活跃工具任务持有该路径；
6. 该 worktree 属于本任务（本会话/本 writer）。「PR 合入即删」是工作区与 `CONTRIBUTING.md` 的常设规则，满足条件 1–5 即可删除，不需要逐次用户授权；其他会话或他人的 worktree 只由其 owner 处置，或由用户明确点名后清理。

未同时满足时只能保留或继续审计。禁止使用 `rm -rf`、`git worktree remove --force`、`git branch -D` 或把 `git worktree prune` 当作绕过审计的清理工具。

## 5. 异常恢复与取证

1. 冻结原路径，不继续写入，不先宣称内容丢失；
2. 记录 `git worktree list --porcelain`、分支、HEAD、status、tracked diff、untracked manifest、字节数与 SHA-256；
3. 核对 PR/远端、reflog/stash、Codex 任务 UI/rollout、附件与工具任务；
4. 从最后可信 commit 在 `/global/.agy-worktrees/backend/<topic>-recovery` 创建隔离候选；
5. 机械重放后做路径、hash、diff 三方对账；存在未解释反证时不得宣告恢复完成；
6. 先交付隔离候选及 manifest/hash/diff 对账和验证证据；只有对应动作已获明确授权时才 checkpoint commit、push 或开 PR，缺少这些未请求的动作不阻断本地恢复交付。合入仍须独立 PR、检查、review 与用户合并授权。

## 6. 父工作区危险命令

项目内 worktree 对父 `/global/backend` 是 ignored 子树。以下操作可能越过 Git 保护直接破坏多个施工目录，因此禁止：

```text
git clean -fdx
rm -rf /global/backend/.claude
rm -rf /global/backend/.codex
手工 mv/rm .claude/worktrees 或 .codex/worktrees 下的 worktree
```

如确需空间清理，先按第 4 节逐个解析精确目标，再使用 Git 原生 worktree 命令。
