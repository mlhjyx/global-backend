# Codex repository navigation and change workflow

> 文档 ID：`DOC-CODEX-NAV-001`
> 生命周期：`GUIDE`
> 当前事实来源：仓库内权威文档、当前源码与脚本；分支、PR、服务和部署状态必须在执行时重新核验。
> 适用范围：`/global/backend` 的 Codex 接手、审计、实现、评审与交接。

This guide defines how to find the current truth, claim an isolated change surface, and report evidence without turning derived indexes or historical notes into authority.

## 0. Continuous execution within the authorized task

For a clear implementation request, establish the affected surface and acceptance criteria, then complete the authorized local work. Inspect discoverable facts before asking for them. Ordinary technical choices, verified local test commands, and changes of skill or execution phase do not need another approval. A review-only request remains read-only.

Reuse explicit authorization only while the action, target, scope, access, cost/data limits, and any expiry remain unchanged. Silence is not approval. Formal architecture/security direction changes and explicitly requested spec-first work retain a written specification, independent review, and user confirmation before implementation planning; do not reopen an already approved specification without a material change.

Pause work that depends on missing information, conflicting ownership, or blocked permission; continue independent authorized work. Diagnose ordinary test/build failures locally. Stop repeating the same unsuccessful approach when it yields no new evidence. Resolve review findings against code, contracts, and tests at each round rather than waiting for a fixed round count; actual required defects cannot be parked into acceptance.

Optional tools may be unavailable: report their check as not run and use an authorized alternative. Project-required gates remain unresolved until their actual evidence is available. Reuse trustworthy checks for the same relevant source/diff, configuration, dependencies, environment, and verification scope. Re-run affected checks after relevant changes or new doubts, not merely because a message, reviewer, or timer changed.

Finish local preparation and validation before requesting a still-missing external authorization. Staging/commit, push/PR, merge, deployment, credentials, retained-state changes, and paid evaluations follow the separate boundaries below and in `AGENTS.md`; a generic skill must not add them as automatic closeout steps. Required acceptance work should continue within scope; subjective scores, learning-log timestamps, and arbitrary iteration counts do not define completion. Report local delivery and any external gate separately.

## 1. Authority order

Use the first applicable source in this order and resolve conflicts upward:

1. Current code, machine contracts, migrations, and tests at the exact commit/worktree: code-first [OpenAPI](../packages/contracts/openapi/openapi.json), contract schemas, and Prisma schema define executable interfaces and storage.
2. [Product scope](product-scope.md), [current status](status/current.md), [current architecture](architecture/current.md), [ADR registry](adr/registry.md), and [release plan](roadmap/release-plan.md) define product intent, accepted decisions, and the next gates. A code discrepancy is evidence of an implementation gap, not permission to change the approved product or security policy.
3. Live, read-only external evidence for drift-prone state such as Git branches, PR checks, development services, provider configuration, or deployed health.
4. Repository history and implementation records, which explain provenance but do not override current documents or code.
5. Long-term memory and historical task transcripts, which are navigation hints only.

`AGENTS.md` is the session entry point and routing index. Its dated historical detail does not override the current documents above. An accepted ADR is not proof of implementation; source is not proof of deployment; a passing static scan is not runtime evidence; an open or technically complete PR is not a merged PR.

## 2. Ownership before inspection becomes implementation

Before editing:

- identify the exact requested scope, base commit, branch, worktree and acceptance commands;
- run the read-only inventory and inspect its per-worktree upstream, `origin/main` relationship, dirty/untracked state, last commit and provenance fields;
- check that no other task owns the same files or responsibility;
- stop writes on overlapping ownership, an unexplained change to the intended write surface, a base mismatch, or reuse of unique commits whose owner is unknown; preserve unrelated dirty state and isolate the task rather than stopping independent read-only investigation;
- preserve `main`, other worktrees, historical branches, user deletions and untracked files.

One task has one writer and one isolated worktree. Read-only audits may inspect other refs, but they do not edit, rebase, clean, delete, or reuse another task's worktree. Branch, worktree and PR state are transient and must never be copied from an old status note without live verification.

## 3. Module map

| Surface                      | Primary location                                                                                     | What it owns                                                                            | Evidence to inspect                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| API composition              | `apps/api/src`                                                                                       | NestJS application wiring and bounded contexts                                          | module/controller/service source, tests, generated OpenAPI                                              |
| Identity boundary            | `apps/api/src/auth`, `apps/api/src/whoami`                                                           | JWKS verification and request identity consumption; no identity issuance                | guards, decorators, auth tests, OpenAPI security                                                        |
| Acquisition and discovery    | `apps/api/src/acquisition`, `apps/api/src/discovery`, `apps/api/src/adapters`                        | source acquisition, provider routing, raw observations, canonicalization and enrichment | provider registry, ToolBroker calls, Temporal activities, source-policy tests                           |
| Intent and signals           | `apps/api/src/intent`, `apps/api/src/signals`, `apps/api/src/sanctions`                              | governed signals, projections, scoring inputs and sanctions refresh                     | source-signal state, projection tests, retention and policy gates                                       |
| Qualification and handoff    | `apps/api/src/icp`, `apps/api/src/lead`, `apps/api/src/events`                                       | ICP, lead decisions and the handoff boundary                                            | decision services, event payload schemas, outbox rows                                                   |
| Storage-side compliance      | `apps/api/src/compliance`, `apps/api/src/claim`                                                      | data rights, suppression, deletion and evidence policies                                | services, Prisma constraints, Temporal deletion workflow                                                |
| Tool authorization           | `apps/api/src/tools`                                                                                 | allowed tools, source policy, budget and trace enforcement                              | tool registry, broker tests, execution context                                                          |
| Model execution              | `apps/api/src/model-runtime`, `apps/api/src/model-gateway`, `apps/api/src/ai-tasks`                  | versioned task/runtime contracts and the single model gateway boundary                  | runtime contracts, fake-gateway tests, settlement evidence; never infer live routing from aliases alone |
| Durable orchestration        | `apps/api/src/temporal`                                                                              | workflows, activities, schedules, retry and cancellation boundaries                     | workflow/activity tests, worker registration, runtime evidence when authorized                          |
| Event delivery               | `apps/api/src/relay`, `apps/api/src/events`                                                          | outbox routing, sink delivery, retry and ACK semantics                                  | event registry, delivery ledger, consumer schemas                                                       |
| Site Builder                 | `apps/api/src/site-builder`, `apps/site-renderer`                                                    | bounded Site Builder domain and deterministic renderer                                  | SiteSpec contracts, build tests, renderer fixtures and release evidence                                 |
| API and event contracts      | `packages/contracts`                                                                                 | code-first OpenAPI, shared types and event schemas                                      | generated artifacts and contract tests                                                                  |
| Data model                   | `packages/db/prisma`                                                                                 | Prisma schema, migrations and RLS-bearing database changes                              | schema, ordered migrations, generated client and database verifiers                                     |
| Code intelligence            | `packages/code-intelligence`                                                                         | derived ContractGraph and opt-in runtime metadata                                       | worktree-local manifest/status plus opened source locations                                             |
| Operations                   | `docker-compose.yml`, `infra`, `infra/systemd`                                                       | Ubuntu development services and unit definitions                                        | rendered config, service status and runbooks; development evidence is not production deployment         |
| Governance and product truth | `AGENTS.md`, `docs/status`, `docs/roadmap`, `docs/product-scope.md`, `docs/architecture`, `docs/adr` | boundaries, current state, sequence and decisions                                       | document metadata, links, current code and latest verification                                          |

Use `rg` or `rg --files` for initial navigation. Use ContractGraph for cross-module impact, then open every material source location it returns.

## 4. Evidence rules

Every material status or impact claim must identify:

- repository and exact worktree path;
- branch, full commit and whether the worktree was dirty;
- command or source location that produced the conclusion;
- evidence class: source, deterministic test, static graph, development runtime, external control plane, or historical provenance;
- limitations and unverified edges.

Use these labels consistently:

| Claim                        | Minimum evidence                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| Designed                     | accepted current document or ADR; explicitly not an implementation claim                                |
| Implemented                  | current source plus an executable producer-consumer path at the inspected commit                        |
| Deterministically verified   | named local test or verifier passing against that commit                                                |
| Development-runtime observed | fresh, read-only Ubuntu development evidence bound to the collector worktree and commit                 |
| Deployed                     | environment-specific release/deployment evidence; development Compose or systemd status is insufficient |
| External-owned               | required repository or control plane is outside this workspace and was not proven here                  |
| Unknown                      | evidence is absent, stale, partial, or cannot support the relationship                                  |

ContractGraph is derived and ignored. Run it in the exact worktree, treat edges as candidates, and confirm them in source and tests. Runtime capture is metadata-only and development-only unless separately authorized. An Outbox row proves an event type was written, not that a consumer ran; a registered Temporal Schedule proves configuration, not a successful recent execution.

Never persist or report secrets, bearer values, credentials, personal data, prompts, response bodies, customer payloads, or unrestricted Outbox content. Paid provider calls, credential changes, deployment, pushes, PR creation and merge are separate authorization gates. Never infer merge authorization from technical completion.

## 5. Exact worktree workflow

### 5.1 Inventory and create

From the canonical Ubuntu checkout:

```bash
cd /global/backend
pnpm --silent worktree:inventory

TASK_SLUG=short-lowercase-topic
pnpm worktree:new "$TASK_SLUG" --dry-run
pnpm worktree:new "$TASK_SLUG"
cd "/global/backend/.codex/worktrees/$TASK_SLUG"
```

`worktree:inventory` emits one deterministic `git-worktree-inventory/v1` JSON document. Every entry includes its upstream state; `ahead`, `behind`, relationship and merge base relative to the locally available `origin/main`; typed dirty/untracked and last-commit observations; and explicit `owner`, `activeTask` and `pullRequest` provenance. This repository currently has no local ownership registry, so those three provenance fields must remain structured `UNKNOWN` rather than being inferred from a branch name. Missing paths and local Git failures remain typed `UNAVAILABLE`; a configured upstream whose local ref has disappeared is `GONE`. These states are evidence for review, never permission to prune.

`worktree:new` fetches `origin`, requires exactly one `main` worktree, rejects existing paths or branches, creates `codex/<topic>` from the then-current `origin/main`, and verifies the new worktree is clean. When an approved task specifies a fixed base, create from that exact commit instead and verify it before any edit:

```bash
git rev-parse HEAD
git branch --show-current
git status --short --branch
test "$(git rev-parse HEAD)" = "<approved-full-commit>"
```

Do not silently move a fixed-base task to newer `main`.

### 5.2 Prepare worktree-local evidence

```bash
pnpm install --frozen-lockfile
pnpm --filter @global/code-intelligence exec tsx src/cli.ts status --repo ../..
```

Prepare missing dependencies only when the task needs them and the installation's side effects are authorized; do not reinstall a usable worktree for each phase. The `status` subcommand is implemented by `packages/code-intelligence/src/cli.ts`; the root package has scan/check aliases but no status alias, so the exact filtered `tsx` command above is intentional. The status must name the current branch, commit and worktree and report no freshness error. If absent, stale, or bound to another worktree, run `pnpm code-intelligence:scan` when local artifact generation is authorized, then verify status before relying on the graph. For a read-only task that cannot rebuild, inspect source directly and state the missing graph evidence; do not claim graph completeness. Query the smallest stable symbol, then inspect returned source:

```bash
pnpm --filter @global/code-intelligence exec tsx src/cli.ts query <symbol> --repo ../..
```

### 5.3 Implement with checkpoints

For behavior changes, establish a failing test first and save the failure output. Implement the smallest change, rerun the focused test, then run proportionate integration, lint, build and documentation checks. Keep RED and GREEN commits separate only when the task explicitly requests checkpoints; otherwise follow the task's commit authorization.

Before handoff:

```bash
git diff --check
git status --short --branch
pnpm --silent worktree:inventory
pnpm --filter @global/code-intelligence exec tsx src/cli.ts status --repo ../..
pnpm --filter @global/code-intelligence exec tsx src/cli.ts impact <changed-path...> --repo ../..
```

Before relying on `impact`, rebuild and recheck ContractGraph if the final edits made its status stale. Reuse a fresh graph bound to the same working tree; do not rebuild merely to enter handoff. A dirty scan accurately records the working tree but does not replace review of `git diff`. Runtime evidence has its own clean-collector and freshness requirements; never commit or capture live state merely to complete a read-only investigation.

### 5.4 Handoff and external gates

Report the base, branch, worktree, any authorized commits, changed files, RED/GREEN evidence, verification results, risks and remaining gaps. Staging, committing, pushing, opening a PR, changing rulesets and merging are distinct actions; take only those explicitly authorized. Honor valid authorization already supplied for the same scope without repeating the question. Unrequested staging, commit, PR, publication, or cleanup does not block handing off a verified local diff; it must not be reported as completed remotely.

This workflow intentionally has no cleanup command. The inventory script has no network or deletion path and sets `GIT_OPTIONAL_LOCKS=0`. Its runtime guard permits only local read-only forms of `git worktree list`, `for-each-ref`, `rev-parse`, `show`, `merge-base`, `rev-list` and `status`; it rejects fetch, push, prune, remove, clean, reset and every unlisted argument shape. Worktree or branch removal requires a separate read-only audit of unique commits and ownership, confirmation that the work is integrated or intentionally abandoned, and explicit authorization.

## 6. Project-local agent capabilities

At the time of this guide, the only repository-installed skill under `.agents/skills/` is `code-intelligence`. Names such as `tdd-workflow`, `security-review` and `verification-loop` may appear in an injected ECC capability description, but their project-local `SKILL.md` files are absent. Follow the repository's TDD, security and verification requirements directly; do not fabricate files or claim those skills ran. Installing or restructuring agent skills is a separate governed change.
