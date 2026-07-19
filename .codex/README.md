# Repository-local Codex workspace

`/global/backend` is the stable `main` checkout. New Codex development worktrees live under:

```text
/global/backend/.codex/worktrees/<topic>
```

The `worktrees/` and `audits/` subdirectories are local runtime state and are ignored by Git. This README is the tracked policy marker; the authoritative procedure is
[`docs/backend/worktree-management.md`](../docs/backend/worktree-management.md).

Do not store credentials here, treat uncommitted files as backups, recursively delete this directory, or run `git clean -fdx` from `/global/backend`.
