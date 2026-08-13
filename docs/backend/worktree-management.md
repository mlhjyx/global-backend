# Worktree 管理 runbook

> 适用于 Ubuntu 当前开发环境。目标是让 `main`、正式施工、历史取证与工具临时状态在路径和生命周期上相互隔离。

## 1. 固定布局与不变量

```text
/global/backend/                                  # 只承载 main
/global/backend/.codex/worktrees/<topic>/         # 新正式开发 worktree
/global/backend/.codex/audits/                    # 本机只读审计产物，可选
/global/wt/<topic>/                               # legacy，只审计，不再新建
/root/.codex/worktrees/...                        # Codex App 管理，不作为正式持久施工目标
```

- 正式分支统一命名 `codex/<topic>`，每个逻辑改动一个短生命周期分支和 PR。
- 新 worktree 必须从刚 fetch 的 `origin/main` 创建，不以可能落后的本地 `main` 为基线。
- `.codex/worktrees/` 与 `.codex/audits/` 只保存本机运行态，不提交、不存密钥，也不承担备份职责。
- `/global/backend` 不做功能修改；其现有未跟踪文件不得因创建或迁移 worktree 被覆盖。
- 不手工移动 Git worktree。合法移动只能使用 `git worktree move`；合法删除只能在清理门满足后使用 `git worktree remove`。

## 2. 创建新 worktree

优先使用仓库助手：

```bash
cd /global/backend
pnpm worktree:new r4-b-min
```

助手固定执行以下护栏：

1. topic 只允许小写字母、数字和连字符；
2. 定位唯一的 `main` worktree，验证 `.codex/worktrees/` 已被父仓库忽略；
3. `git fetch origin --prune` 后解析 `origin/main`；
4. 目标目录、`codex/<topic>` 本地/远端分支或 worktree 登记已存在时 fail-closed，不复用、不覆盖；
5. 使用参数数组调用 Git，不拼 shell 命令，不使用 `--force`；
6. 创建后验证分支、HEAD 基线和 clean status。

可先做不创建分支/worktree 的预检（仍会 fetch 并更新远端跟踪引用）：

```bash
pnpm worktree:new r4-b-min --dry-run
```

### 2.1 规划、审计与实施的新鲜度门

每次开始规划、只读审计或实施前，都执行：

```bash
git fetch origin --prune
git rev-list --count HEAD..origin/main
```

输出必须为 `0`，才能把该 worktree 当作当前事实基线。若有 origin-only 提交，停止以该路径输出当前结论；从刚 fetch 的 `origin/main` 新建正式 worktree，或先受控同步后重做核验。这个门检查的是远端是否领先，不以本分支自己的功能提交为“已同步”证据。

### 2.2 根 `main` 受控跟随

`worktree:new` 保证新施工分支从刚 fetch 的 `origin/main` 创建，但它不会推进 `/global/backend` 的本地 `main`。远端 PR 合入后，用下列独立入口收口本地跟随：

```bash
cd /global/backend
node scripts/governance-main-worktree-sync.mjs status  # 只读；不 fetch，origin/main 标记为本地 cached ref
node scripts/governance-main-worktree-sync.mjs apply   # fetch origin --prune，解析 origin/main 为精确 commit，过门后只执行 merge --ff-only <commit>
```

同步脚本的 `apply` 不要求根目录必须整体 clean：本地现场若与 `HEAD..<fetch 后解析出的 origin/main commit>` 的入站路径完全无交集，Git 对同一对 commit 干跑也证明可快进，则可以在不动这些文件的情况下跟随。工具在快进前后逐字节比较完整 status，确保 tracked deletion、untracked/ignored 文件和其他本地状态未被改写。

同步脚本 `apply` 的调用目录也受机器门约束：只有当前目录的 realpath 等于 `/global/backend` 才能进入 fetch；从功能 worktree、临时 checkout 或其他路径调用会在任何 Git 命令前返回 `WRONG_CLI_CWD_HOLD`。Git 子进程同时清除调用环境继承的 `GIT_*` 仓库、worktree、index、对象库、配置与 transport 覆盖，只保留脚本设置的非交互提示门，避免外部环境把固定 root 重定向到另一现场。

以下任一情况必须 HOLD，只报告不修复：

- `/global/backend` 不是唯一绑定 `refs/heads/main` 的 root worktree，或处于 detached/locked/prunable 状态；
- fetch 失败、`origin/main` 无法验证为 commit、本地 `main` ahead 或 diverged；
- 入站路径与本地 tracked、untracked 或 ignored 路径冲突，或 `git read-tree -n -u -m <local commit> <target commit>` 不通过；
- fast-forward 后 `HEAD != <target commit>`、当前 `origin/main != <target commit>`、ahead/behind 非 `0/0`，或本地 status 与操作前不同。

该命令不读取 GitHub PR 状态，不 push、rebase、stash、reset、clean、checkout 或删分支/worktree。远端 PR/CI/review/用户合并授权与本地 root fast-forward 是两个分离的责任门。

## 3. legacy `/global/wt` 迁移判定

迁移按单个 worktree 决策，禁止批量搬运。

| 状态                                     | 动作                                                  |
| ---------------------------------------- | ----------------------------------------------------- |
| 干净、未锁定、确认仍需继续开发           | 记录清单后使用 `git worktree move` 迁入新目录         |
| 已合并且无独有内容                       | 不迁移；满足清理门并取得用户授权后再删除              |
| tracked 或 untracked 非空                | 原地冻结；先做精确 manifest、diff、hash 与归属审计    |
| detached、锁定、路径失联或工具任务仍活跃 | 不迁移；先核对任务、分支、reflog 与 worktree metadata |
| 含 submodule                             | `git worktree move` 不支持；停止并单独规划            |

干净且确认继续使用时，迁移命令形如：

```bash
git worktree move \
  /global/wt/<topic> \
  /global/backend/.codex/worktrees/<topic>
```

移动前后都要记录并比较：路径、分支、HEAD、`git status --short` 和 `git worktree list --porcelain`。迁移不授予删除分支、覆盖文件或清理旧现场的权限。

## 4. 删除与清理门

以下条件必须同时满足：

1. 对应 PR 已合并，目标提交已进入最新 `origin/main`；squash merge 场景须做内容/PR 对账，不能只依赖 ancestor 判断；
2. worktree tracked status 为零；
3. untracked 文件逐项确认已提交、迁移、归档或可丢弃；
4. 没有独有 commit、reflog、stash、Codex/Claude 任务补丁或附件证据待核；
5. 没有活跃工具任务持有该路径；
6. 用户对本次精确目标明确授权。

未同时满足时只能保留或继续审计。禁止使用 `rm -rf`、`git worktree remove --force`、`git branch -D` 或把 `git worktree prune` 当作绕过审计的清理工具。

## 5. 异常恢复与取证

1. 冻结原路径，不继续写入，不先宣称内容丢失；
2. 记录 `git worktree list --porcelain`、分支、HEAD、status、tracked diff、untracked manifest、字节数与 SHA-256；
3. 核对 PR/远端、reflog/stash、Codex 任务 UI/rollout、附件与工具任务；
4. 从最后可信 commit 在 `.codex/worktrees/<topic>-recovery` 创建隔离候选；
5. 机械重放后做路径、hash、diff 三方对账；存在未解释反证时不得宣告恢复完成；
6. 恢复结果及时 checkpoint commit + push，但仍须经独立 PR 合入。

## 6. 父工作区危险命令

项目内 worktree 对父 `/global/backend` 是 ignored 子树。以下操作可能越过 Git 保护直接破坏多个施工目录，因此禁止：

```text
git clean -fdx
rm -rf /global/backend/.codex
手工 mv/rm .codex/worktrees 下的 worktree
```

如确需空间清理，先按第 4 节逐个解析精确目标，再使用 Git 原生 worktree 命令。
