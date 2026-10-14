# Changelog 片段

> 生命周期：`GUIDE`
> 生命周期依据：changelog 的现行写法；2026-10-14 起取代「每个 PR 在 changelog.md 顶部插入小节」

每个 PR 不再直接改 [`../changelog.md`](../changelog.md)，而是在本目录放**一个片段文件**。所有 PR 都去改同一个文件的同一处，任何一个合入都会让其余在途 PR 冲突，只能并入 main 再跑一轮 CI；改成各写各的文件后就不会冲突。

## 什么时候必须写

PR 改了 `apps/`、`packages/`、`scripts/`、`infra/` 下任一路径时，必须新增（或修改）一个片段，或者直接改 `changelog.md`。governance 工作流（`governance · traceability · release`，必需检查）按 PR 的 diff（合并基点到 PR head）判断，缺了就失败。纯文档、`.github/` 等改动不强制，但写了也欢迎。

## 文件名与格式

文件名：`<YYYY-MM-DD>-<slug>.md`，日期与 frontmatter 的 `date` 一致，slug 只用小写字母、数字和连字符。

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
- 相对链接按**本目录**的位置写（例如 `../../evidence/x.md`），汇编时会自动改成从 `changelog.md` 出发的路径。

`pnpm docs:verify`（`gctl check` 也会跑）检查格式；本目录只允许本 README 和片段文件。

## 汇编

```bash
node scripts/changelog-assemble.mjs --dry-run   # 只列出将要写入的条目
node scripts/changelog-assemble.mjs             # 写入 changelog.md 并删除片段
```

由发版列车或任何人手动运行：从刚 fetch 的 `origin/main` 建分支，运行汇编，`pnpm docs:verify` 通过后作为 `docs(changelog): …` PR 提交，不由 bot 直接提交 main。条目按日期倒序插入；同一天的条目接在当天已有小节之后，按 PR 号升序。任何片段格式不合格时汇编器什么都不写。
