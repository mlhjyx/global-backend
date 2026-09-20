---
name: code-intelligence
description: Query the repository-native ContractGraph before cross-module impact analysis, then verify every material conclusion against current source, tests, and runtime evidence.
---

# Repository Code Intelligence

Use this skill when a task asks what code, API, workflow, event, data model, test,
deployment entry, Capability, or scenario a change can affect.

1. Run from the exact worktree under review or modification. A read-only question
   does not authorize edits, a commit, or new runtime capture.
2. Check existing evidence first with
   `pnpm --filter @global/code-intelligence exec tsx src/cli.ts status --repo ../..`.
3. Reuse a fresh graph bound to that branch, commit, and working-tree content.
   If missing, stale, or bound elsewhere, run `pnpm code-intelligence:scan` only
   when local artifact generation is within scope, then recheck status.
4. Never use stale evidence or a main graph to answer a feature-branch question.
   When a read-only scope or unavailable dependency prevents rebuilding, continue
   direct source/test inspection and identify the graph evidence as unavailable;
   do not claim graph coverage or completeness. Preserve required graph gates.
5. Query the smallest stable identifier or symbol with
   `pnpm --filter @global/code-intelligence exec tsx src/cli.ts query <term> --repo ../..`.
6. For changed files, run
   `pnpm --filter @global/code-intelligence exec tsx src/cli.ts impact <repo-relative-path...> --repo ../..`.
   The report is a bounded, high-precision static baseline, not runtime proof.
7. CodeGraph remains an opt-in secondary pilot. Only after
   `pnpm code-intelligence:codegraph:status-active` succeeds may you run
   `pnpm --filter @global/code-intelligence exec tsx src/cli.ts unified-impact <repo-relative-path...> --repo ../..`.
   Always display its evidence commit and logical worktree. Never run
   `codegraph install`, `codegraph upgrade`, its watcher, writable MCP tools, or
   any automatic agent/Hook/`AGENTS.md` configuration.
8. Open the returned source locations. Treat graph edges as candidates until
   current source or a deterministic completeness test confirms them.
9. For “does this really happen” on the Ubuntu development environment, run
   `pnpm code-intelligence:runtime:status` first. Missing or expired snapshots
   (24-hour limit) do not prove an edge absent. Report `UNKNOWN` and continue
   independent source analysis without presenting it as runtime proof.
   New `pnpm code-intelligence:runtime:capture` and
   `pnpm code-intelligence:runtime:diff` require the task's authorization for
   the actual environment/data access and generated artifacts, a fresh exact
   ContractGraph, and the collector's clean-worktree/identity checks. Do not
   auto-commit to satisfy those checks or weaken them. Preproduction/production
   capture always requires separate authorization.
10. Determine service identity and correlation support from current code and
    evidence rather than a historical capability statement in this skill.
    A Temporal recent Schedule action can prove its Schedule-to-Workflow edge;
    an Outbox row proves only that the event type occurred, not that a consumer ran.
11. Report missing external repositories as `EXTERNAL_OWNED`, unproven
    relationships as `UNKNOWN`, and static-only relationships as unobserved
    rather than disconnected.
12. Lead the final impact report with Capability, scenario, and user path; then
    list code, data, tests, risks, unknowns, and rollback.

The graph is derived and ignored by Git; regeneration or cleanup follows the
task's scope and ownership rules. It cannot change
Registry/ADR truth, authorize frozen product work, prove deployment, or justify
skipping existing CI. Do not index `.env`, credentials, customer data, prompts,
or personal data. Do not bypass the artifact manifest if a derived JSON file
fails integrity validation.

Runtime evidence is also derived and metadata-only. Never persist response
bodies, Outbox payloads, prompts, secrets, credentials, emails, or personal
data. Only explicitly allowlisted keys and machine-shaped values may be saved;
free-text Outbox correlation IDs are omitted. The collector commit identifies
the tool that observed the environment; it is not proof that the running binary
came from that commit. The three long-running systemd units require
`active/running`; `active/exited` is a failed health observation.

CodeGraph adoption and evaluation results are versioned evidence, not stable
skill instructions. See the repository's
[code-intelligence guide](../../../docs/ai-development/code-intelligence.md)
and current machine status; do not infer new activation or promotion from an
old score. ContractGraph, current source, tests, and authorized runtime evidence
remain the default path.
