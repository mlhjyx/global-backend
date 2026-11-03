---
date: 2026-11-04
title: Move the default worktree convention from .codex/worktrees to .claude/worktrees
---

- 起因：Codex 已不再作为开发代理，`worktree:new` 仍默认在 `.codex/worktrees` 建 `codex/<topic>`，命名与实际开发主体不符。
- 改动：
  - `pnpm worktree:new` 改为在 `.claude/worktrees/<topic>` 创建 `claude/<topic>`，脚本更名 `scripts/create-worktree.mjs`；
  - `.gitignore` 新增 `/.claude/worktrees/`、`/.claude/audits/`，`.codex` 两项保留给迁移前现场；
  - 策略标记 `.codex/README.md` 移至 `.claude/README.md`；
  - AGENTS.md、README.md、CONTRIBUTING.md、导航指南、worktree runbook 与相关操作文档同步新默认；
  - code-intelligence 扫描排除新增 `.claude`。
- 测试：`node --test scripts/governance-main-worktree-sync*.spec.mjs`；`pnpm worktree:new <topic> --dry-run`；`gctl check`。
- 未做：迁移前已在 `.codex/worktrees/` 的在飞 worktree 不搬动，按清理门逐个退役；`docs/CODEX-NAVIGATION-GUIDE.md` 文件名与历史计划/记录/归档中的旧路径不改写。
