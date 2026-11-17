# Agent-team handoff controller (v0.1)

> Lifecycle: `APPROVED` implementation scope from
> `/home/xin/.claude/plans/global-team-handoff-controller-task-v0.1-2026-11-17.md`.
> Pure Python standard library; no service, timer, model call, MCP or `gh` usage.

## Purpose

Turn the team's approval → implementation → independent review → merge → next-task
relay into a recoverable, auditable state machine:

- one persistent state file (`snapshot.json`) with revisions and an action ledger;
- one deterministic ready action computed by a pure reducer (no free-text dispatch);
- a supervisor-only Stop guard that blocks ending a turn while a ready action, an
  unfinished claim or uncoordinated input exists;
- strict gates: engineering delivery, same-head `FINAL_COMMIT` independent technical
  PASS (reviewer ≠ writer, empty blockers) that explicitly accepts every engineering
  limitation (`engineering.limitations ⊆ technical.accepted_limitations`), frozen
  product applicability, and CI that
  mirrors the registration-frozen required-check list (fresh by the observed time, all
  SUCCESS, same head), then exactly one supervisor `MERGE_PR` action that must still
  be the reducer's current action at claim time (readback-first on uncertainty);
- a claim re-computes the unique ready action under the lock: stale CI, new heads,
  changed gates or expired leases can never execute an old permission; expired claims
  are normalized to UNKNOWN inside the same locked transaction (committed, then a
  recovery code without a lease is returned); unknown side effects resolve through
  bounded readback actions whose identity includes the full source action id and the
  source attempt (`resolution: DELIVERED|NOT_DELIVERED`), so every real attempt gets
  its own recoverable cycle while source retries stop at 3 and a failing readback
  stops at `BLOCKED_RECOVERY` without readback-of-readback recursion;
- WAITs carry a bounded `wait_generation`: each accepted WAIT event (and each fresh
  Stop after an acknowledged wait) opens exactly one new claimable reconcile action;
  duplicate events stay idempotent before the revision CAS, and reentry Stops reuse
  the recorded action;
- new-head events invalidate stale passes; duplicate events are idempotent;
- approved next tasks are dispatched without asking the user again; no next task
  means a real stop.

## Files

| File | Role |
| --- | --- |
| `state_machine.py` | schema validation, canonical hashing, atomic flock file transactions, pure reducer, ready-action computation, gates, claim/finish leases |
| `controller.py` | thin CLI, hook adapter (`Stop` / `PostToolUse` probe / optional `UserPromptSubmit`), one-time native-session binding, minimal settings merge installer |
| `schema-v1.json` | Desensitized Event/State/Receipt/Action contract (documentation; runtime validates with stdlib) |
| `fixtures/s1-handoff.example.json` | Synthetic S1 handoff replay (fictional ids/digests) reaching exactly one `MERGE_PR` |
| `test_state_machine.py`, `test_hooks.py`, `test_installation.py` | unittest suites using TemporaryDirectory / synthetic settings only |

## Run

```bash
python3 -I -B -m unittest discover -s scripts/agent-team -p 'test_*.py' -v
```

State lives outside Git at `/home/xin/.local/state/global-agent-team/` (0700;
`snapshot.json`/`state.lock` 0600). The pinned CLI entry is
`/usr/bin/python3 -I /global/local-config/bin/agent-team/<TOOL_COMMIT>/controller.py`.
Installed copies are made only from an already-reviewed Git commit by
`install-hooks`, and the active worktree is never used as the permanent hook path.

## Hook identity and installation (summary)

1. `prepare-bind` writes a one-time nonce and a harmless `printf 'GLOBAL-TEAM-BIND-…'`
   command, and appends a temporary `PostToolUse`/`Bash` probe entry to the local
   settings file (all other settings preserved).
2. The supervisor runs that exact command in their own session; only that real
   `PostToolUse` payload (matching session id, cwd and command digest) writes
   `binding-probe.json` with only `session_id`, `cwd`, `matched_at`.
3. `bind-commit --confirm-session-id … --challenge …` consumes the nonce, binds the
   native hook session id to the supervisor CCD id, removes the probe entry.
4. `install-hooks --tool-commit <40-hex> --source-dir <reviewed copy> --settings …`
   copies the reviewed files into the versioned install directory and appends exactly
   one owned `Stop` entry (exec-form args; timeout 5). Reinstalls are idempotent,
   concurrent settings edits are refused, uninstall removes only owned entries.

`Stop` behavior: non-supervisor sessions, subagents and other projects are untouched
no-ops. For the supervisor a persistent ready action, an unfinished claim or
uncoordinated input yields `{"decision":"block","reason":"GLOBAL_TEAM_ACTION_REQUIRED …"}`;
real waits, a paused state or no approved task allow stopping. Repeated no-progress
Stop rounds are bounded (3) and then marked `BLOCKED_GUARD`. Bad state is reported
once with a fixed diagnostic and never auto-initialized.

## Boundaries

- The controller never merges, never calls `gh`/MCP/models and never executes shell
  carried by events. It only emits a structured `MERGE_PR` permission for the
  supervisor, with argument templates fixed and head-pinned.
- Real PostgreSQL concurrency, live Stop delivery and host-level EOF rewake are
  separate acceptance domains; see the task sheet §8. A lethal host API error that
  fires no hook is not claimed to be auto-recovered here.
- This tool's first PR is merged through the existing review process; the controller
  does not certify its own rollout.
