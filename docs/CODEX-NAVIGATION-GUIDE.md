# Codex repository navigation and change workflow

> 文档 ID：`DOC-CODEX-NAV-001`
> 生命周期：`GUIDE`
> 当前事实来源：仓库内权威文档、当前源码与脚本；分支、PR、服务和部署状态必须在执行时重新核验。
> 适用范围：`/global/backend` 的 Codex 接手、审计、实现、评审与交接。

This guide defines how to find the current truth, claim an isolated change surface, and report evidence without turning derived indexes or historical notes into authority.

## 1. Authority order

Use the first applicable source in this order and resolve conflicts upward:

1. Repository decisions and contracts:
   - [product scope](product-scope.md) for product and repository boundaries;
   - [current status](status/current.md) and [release plan](roadmap/release-plan.md) for the active phase and next gates;
   - [current architecture](architecture/current.md) for as-built structure;
   - [ADR registry](adr/registry.md) for accepted load-bearing decisions;
   - code-first [OpenAPI](../packages/contracts/openapi/openapi.json), contract schemas, Prisma schema and migrations for executable interfaces and storage.
2. Current source and tests at the exact commit and worktree under review.
3. Live, read-only external evidence for drift-prone state such as Git branches, PR checks, development services, provider configuration, or deployed health.
4. Repository history and implementation records, which explain provenance but do not override current documents or code.
5. Long-term memory and historical task transcripts, which are navigation hints only.

`AGENTS.md` is the session entry point and routing index. Its dated historical detail does not override the current documents above. An accepted ADR is not proof of implementation; source is not proof of deployment; a passing static scan is not runtime evidence; an open or technically complete PR is not a merged PR.

## 2. Ownership before inspection becomes implementation

Before editing:

- identify the exact requested scope, base commit, branch, worktree and acceptance commands;
- run the read-only inventory and inspect its per-worktree upstream, `origin/main` relationship, dirty/untracked state, last commit and provenance fields;
- check that no other task owns the same files or responsibility;
- stop on overlapping ownership, an unexpected dirty worktree, a base mismatch, or unique commits whose owner is unknown;
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
pnpm code-intelligence:scan
pnpm --filter @global/code-intelligence exec tsx src/cli.ts status --repo ../..
```

The `status` subcommand is implemented by `packages/code-intelligence/src/cli.ts`; the root package has scan/check aliases but no status alias, so the exact filtered `tsx` command above is intentional. The status must name the current branch, commit and worktree and report no freshness error. If it names another worktree or is stale, rebuild before relying on it. Query the smallest stable symbol, then inspect returned source:

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
pnpm code-intelligence:scan
pnpm --filter @global/code-intelligence exec tsx src/cli.ts impact <changed-path...> --repo ../..
```

Rebuilding ContractGraph after edits is required before an impact claim. A dirty scan accurately records the working tree but does not replace review of `git diff`.

### 5.4 Handoff and external gates

Report the base, branch, worktree, commits, changed files, RED/GREEN evidence, verification results, risks and remaining gaps. Staging, committing, pushing, opening a PR, changing rulesets and merging are distinct actions; take only those explicitly authorized.

This workflow intentionally has no cleanup command. The inventory script has no network or deletion path and sets `GIT_OPTIONAL_LOCKS=0`. Its runtime guard permits only local read-only forms of `git worktree list`, `for-each-ref`, `rev-parse`, `show`, `merge-base`, `rev-list` and `status`; it rejects fetch, push, prune, remove, clean, reset and every unlisted argument shape. Worktree or branch removal requires a separate read-only audit of unique commits and ownership, confirmation that the work is integrated or intentionally abandoned, and explicit authorization.

## 6. Project-local agent capabilities

At the time of this guide, the only repository-installed skill under `.agents/skills/` is `code-intelligence`. Names such as `tdd-workflow`, `security-review` and `verification-loop` may appear in an injected ECC capability description, but their project-local `SKILL.md` files are absent. Follow the repository's TDD, security and verification requirements directly; do not fabricate files or claim those skills ran. Installing or restructuring agent skills is a separate governed change.
