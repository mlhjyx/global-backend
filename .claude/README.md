# Repository-local Claude Code workspace

Start with [AGENTS.md](../AGENTS.md) and the [worktree runbook](../docs/backend/worktree-management.md).
On xin, create new task worktrees under `/global/.agy-worktrees/backend/` as required by the workspace.
The repository's `pnpm worktree:new` helper still targets `.claude/worktrees/`. Existing registrations there may belong to other sessions.

Keep machine-local state and credentials out of repository metadata. Read the [development operating model](../docs/ai-development/operating-model.md) for task ownership, integration and review.
