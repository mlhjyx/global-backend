---
name: code-intelligence
description: Query the repository-native ContractGraph before cross-module impact analysis, then verify every material conclusion against current source, tests, and runtime evidence.
---

# Repository Code Intelligence

Use this skill when a task asks what code, API, workflow, event, data model, test,
deployment entry, Capability, or scenario a change can affect.

1. Run from the exact worktree that will be changed.
2. Run `pnpm code-intelligence:scan`.
3. Run `pnpm --filter @global/code-intelligence exec tsx src/cli.ts status --repo ../..`.
4. If status is stale or points to another worktree, stop and rebuild. Never use
   a main graph to answer a feature-branch question.
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
   `pnpm code-intelligence:runtime:status` first. If evidence is missing or
   stale, rebuild the exact ContractGraph, commit the worktree, then run
   `pnpm code-intelligence:runtime:capture` and
   `pnpm code-intelligence:runtime:diff`. Never use these commands for
   preproduction or production without separate approval.
10. Treat `PARTIAL` honestly: the current services do not expose a deployment
    commit and health endpoints do not echo a correlation ID. A Temporal recent
    Schedule action can prove its Schedule-to-Workflow edge; an Outbox row proves
    only that the event type occurred, not that a consumer ran.
11. Report missing external repositories as `EXTERNAL_OWNED`, unproven
    relationships as `UNKNOWN`, and static-only relationships as unobserved
    rather than disconnected.
12. Lead the final impact report with Capability, scenario, and user path; then
    list code, data, tests, risks, unknowns, and rollback.

The graph is derived, ignored by Git, and safe to delete. It cannot change
Registry/ADR truth, authorize frozen product work, prove deployment, or justify
skipping existing CI. Do not index `.env`, credentials, customer data, prompts,
or personal data. Do not bypass the artifact manifest if a derived JSON file
fails integrity validation.

Runtime evidence is also derived and metadata-only. Never persist response
bodies, Outbox payloads, prompts, secrets, credentials, emails, or personal
data. The collector commit identifies the tool that observed the environment;
it is not proof that the running binary came from that commit.

The fixed 30-question evaluation currently classifies CodeGraph as
`PILOT_ONLY`: responsibility-routed unified precision/recall, exact dynamic
edges, isolation, leakage, build, query, and speed gates pass, but CodeGraph
recall is only 89.5% on the questions where it is allowed to contribute. Raw
CodeGraph precision/recall remain visible and cannot be hidden by routing.
ContractGraph, current source, tests, and runtime evidence therefore remain the
default path.
