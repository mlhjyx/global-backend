---
date: 2026-10-14
pr:
title: Replace the single-file changelog with one fragment per PR, assembled later
---

- 起因：每个 PR 都在 `changelog.md` 的同一处插入小节（最早是顶部，后来是当天小节末尾），任何一个合入都会让其余在途 PR 文本冲突。
  - #596–#643 合入的 47 个 PR 里 45 个改了 `changelog.md`；47 个里有 24 个带着并入 main 的合并提交（共 32 个），每次并入都要再跑一轮完整 CI。派活方统计其中 22 次是这类冲突逼出来的，26 轮 merge-head CI 共 509 分钟（这两个数没有逐一复核）。
  - ruleset 的 strict 在 2026-09-21 已关闭，这些并入不是 GitHub 要求的，只是为了解冲突。写这条时仍有 8 个在途 PR（#597、#646–#652）改 `changelog.md`。
  - 被替换的设计：「单文件 changelog，每个 PR 直接插入小节」（Codex 时期沿用至今）。冲突是这个设计的结构性结果，与 PR 内容无关，在途 PR 越多越严重，所以整体替换，不再靠「插到当天末尾」之类的约定减轻。
- 改动：
  - **片段目录** `docs/roadmap/changelog.d/`：每个 PR 放一个 `<YYYY-MM-DD>-<slug>.md`，frontmatter 写 `date` / `pr` / `title`，正文依次写起因 / 改动 / 测试 / 未做。目录 README 写明格式、何时必需与汇编方法。`pr` 可以留空：汇编时从加入片段的 squash 提交标题里的 `(#N)` 取，不必为补 PR 号再推一次（本条目就留空）。
  - **校验** `scripts/governance-changelog-fragments.mjs`：文件名、frontmatter（只允许三个键、日期须为真实日期且与文件名一致、PR 号为正整数或空、标题不带 `#` 与 `(#N)`）、正文四项的顺序与内容、正文不得有一二级标题、目录里只能有 README 与片段。`pnpm docs:verify` 调用它（`scripts/verify-docs.mjs`），片段改由 frontmatter 承担元数据，免去 `docs/roadmap/` 的「生命周期」行要求。
  - **必需检查**：同一脚本的 `require` 子命令按 `git diff --name-status --no-renames <base>...<head>` 判断：改了 `apps/`、`packages/`、`scripts/`、`infra/` 任一路径时，必须新增或修改一个片段，或改 `changelog.md`；只删片段、只改 README 不算。`governance.yml` 的 checkout 改为 `fetch-depth: 0`，新增只在 `pull_request` 上运行的一步，传 `base.sha` 与 PR 的 `head.sha`，并用 `!cancelled()` 让它与 `governance:verify` 在同一轮里各自报错；算不出 diff 时失败而不是放行。
  - **汇编** `scripts/changelog-assemble.mjs`（`--dry-run` 只列不写）：按日期倒序插入，同一天的条目接在当天已有小节之后、按 PR 号升序；片段里按片段目录写的相对链接改写成从 `changelog.md` 出发的路径；写入后删除片段。任何片段不合格时什么都不写。由发版列车或任何人手动运行，结果作为 `docs(changelog)` PR 提交，不由 bot 直接提交 main。
  - 规则同步：`AGENTS.md` §9、`CONTRIBUTING.md` 新增「Changelog 片段」一节、PR 模板加一项勾选、`changelog.md` 开头加写法变更说明、`docs/backend/ci-merge-automation.md` 那句「changelog 冲突」加后继指针。本条目是第一个片段。
- 测试：
  - 先写 `scripts/governance-changelog-fragments.spec.mjs` 的 22 项用例，实现前因模块不存在整体失败；工作流与 `verify-docs` 接线的 2 项在改这两个文件之前单独失败过。实现后 22 项全部通过：
    - 解析：完整片段、`pr` 留空或缺省、带引号与含冒号的标题；22 种畸形输入各报自己的错误码；额外顶层条目、ASCII 冒号与代码块里的 `##` 不误报；
    - 必需判定：四个前缀各自触发；新增或修改片段、改 `changelog.md` 都算满足；只删片段、只改 README、纯文档与 `.github/` 改动的各自结论；
    - 汇编：跨日倒序、同日接在已有条目之后并按 PR 号升序、无 PR 号排最后；没有片段时输出与输入逐字节相同；早于所有条目的片段落在无日期的旧尾部之前；相对链接改写；
    - 临时 git 仓库里的两个命令：`require` 在 main 于分叉后前进时只看 PR 自己的改动，加片段前失败、加片段后通过，base 不存在时失败；汇编命令 `--dry-run` 不写文件，从 squash 提交补上 PR 号，取不到时不带号并提示，片段不合格时不动任何文件；
    - 本仓的片段合格；`governance.yml` 的步骤形状与 `verify-docs` 的接线。
  - 该 spec 由 `scripts/governance-contracts.spec.mjs` 引入，随 `governance:verify` 在 CI 的 governance 工作流与 `docs:verify` 中运行。
  - 对本仓真实 `changelog.md` 预演汇编（把本片段折进去再还原）：只在当天已有小节之后多出这一节，其余内容逐字节不变。
  - `gctl check`：docs/governance、prisma generate、contracts、lint、build 全绿；零容器单测见 PR。
- 未做：
  - 没有改 ruleset，strict 维持关闭。
  - 没有自动汇编：不加 bot、不加定时任务，片段会在目录里累积到有人运行汇编为止。
  - 在途 PR 照旧改 `changelog.md`，检查同样放行，不必返工；本 PR 合入后的新 PR 改用片段。
  - 不校验片段里的 `pr` 是否等于当前 PR 号。
  - 仓外的 `/global/CLAUDE.md` §7 与派活脚本里「在 changelog.md 当天小节末尾新增小节」的写法，要在本 PR 合入后改成写片段，不在本 PR 内。
