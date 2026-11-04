# Repository-local Claude Code workspace

`/global/backend` is the stable `main` checkout. New development worktrees created by `pnpm worktree:new` live under:

```text
/global/backend/.claude/worktrees/<topic>
```

The `worktrees/` and `audits/` subdirectories are local runtime state and are ignored by Git. This README is the tracked policy marker; the authoritative procedure is
[`docs/backend/worktree-management.md`](../docs/backend/worktree-management.md).

`/global/backend/.codex/worktrees/` remains only for worktrees created before the 2026-11-04 migration; do not create new ones there. Do not store credentials here, treat uncommitted files as backups, recursively delete this directory, or run `git clean -fdx` from `/global/backend`.
