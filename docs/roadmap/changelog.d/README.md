# Changelog 片段

> 生命周期：`GUIDE`
> 生命周期依据：changelog 的现行写法；2026-10-14 起取代「每个 PR 在 changelog.md 顶部插入小节」

每个 PR 不再直接改 [`../changelog.md`](../changelog.md)，而是在本目录放**一个片段文件**。所有 PR 都去改同一个文件的同一处，任何一个合入都会让其余在途 PR 冲突，只能并入 main 再跑一轮 CI；改成各写各的文件后就不会冲突。

## 什么时候必须写

PR 改了 `apps/`、`packages/`、`scripts/`、`infra/` 下任一路径，或根目录的构建与运行时文件（`Dockerfile`、`.dockerignore`、`runtime-entrypoint.mjs`、`docker-compose.yml`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`nx.json`、`eslint.config.mjs`，即脚本里的 `CODE_ROOT_FILES`）时，必须新增（或修改）一个片段。governance 工作流（`governance · traceability · release`，必需检查）按 PR 的 diff（合并基点到 PR head）判断，缺了就失败。纯文档、`.github/` 等改动不强制，但写了也欢迎。

- **过渡**：直接改 `changelog.md`、不加片段的 PR 检查照样放行（只出一条 warning），规则生效前开的 PR 不必返工；新 PR 一律写片段。放行不看 PR 何时开，所以照旧写法的新 PR 也会通过，直到仓外的 `/global/CLAUDE.md` §7 与派活脚本改成写片段、再删掉这条放行（登记在 [文档校验治理页](../../governance/docs-verification.md#4-当前显式例外) §4）。
- **Dependabot 安全更新 PR** 改到 `apps/` 或 `packages/` 下的 `package.json` 时同样会缺片段。开发代理给它补 Copy 重签的那次提交里一并加上片段。

## 文件名与格式

文件名：`<YYYY-MM-DD>-<slug>.md`，日期与 frontmatter 的 `date` 一致，slug 只用小写字母、数字和连字符。slug 用分支名里的 topic（`claude/changelog-fragments` → `2026-10-14-changelog-fragments.md`），这样两个在途 PR 不会撞名；万一同日同 slug 而前一个片段还没汇编，后合的那个会在 GitHub 上显示冲突，改个名重推即可。前一个片段已经汇编（文件已删）时不会冲突，同名片段照常加入，汇编取最近一次加入它的提交里的 PR 号。

```markdown
---
date: 2026-10-14
pr: 653
title: Replace the single-file changelog with one fragment per PR
---

- 起因：……
- 改动：
  - ……
- 测试：……
- 未做：……
```

- `date`：条目日期（一般是开 PR 当天）。
- `pr`：PR 号，可以先留空或不写。汇编时会从加入这个片段的 squash 提交标题（`… (#N)`）里取，所以**不需要为了补 PR 号再推一次**。
- `title`：英文一句话，不带 `#` 和 `(#N)`，汇编器会生成 `## <date> · <title> (#N)` 标题。
- 正文必须依次包含顶层条目 `- 起因：`、`- 改动：`、`- 测试：`、`- 未做：`，每项都要有内容（没有就写「无」）；中间可以加别的顶层条目（如 `- 部署：`）。正文里不要写一级、二级标题。
- 相对链接按**本目录**的位置写（例如 `../../evidence/x.md`），汇编时会自动改成从 `changelog.md` 出发的路径。只用行内链接 `[文字](目标)`（目标可以写成 `<带空格的路径>`，可带双引号或单引号标题）；引用式定义 `[r]: 目标` 与脚注定义 `[^1]: …` 既不被 `docs:verify` 检查、也不会被改写，校验会拒绝（`CHANGELOG_FRAGMENT_LINK`）。

`pnpm docs:verify`（`gctl check` 也会跑）检查格式；本目录只允许本 README 和片段文件。

## 汇编

```bash
node scripts/changelog-assemble.mjs --dry-run   # 只列出将要写入的条目
node scripts/changelog-assemble.mjs             # 写入 changelog.md 并删除片段
```

每班发版列车的 PR 合完后，由当班负责合并的开发代理运行：从刚 fetch 的 `origin/main` 建分支，运行汇编，`pnpm docs:verify` 通过后作为 `docs(changelog): …` PR 提交，不由 bot 直接提交 main。步骤、冲突处理与回退方法见 [CI / 审查与合并流程](../../backend/ci-merge-automation.md#changelog-片段的汇编)。条目按日期倒序插入；同一天的条目接在当天已有小节之后，按 PR 号升序。任何片段格式不合格时汇编器什么都不写。
