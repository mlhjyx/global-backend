# Execution Budget Authority and Artifact Replay Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Backend-authored generic execution caps with externally signed authority and make every managed Model/Tool result recoverable without a second physical call.

**Architecture:** This is an umbrella plan for five independently reviewable, additive subprojects followed by one atomic product cutover. Workspace requests consume short-lived signed grants; platform schedules consume signed campaign authorities; small outputs use closed typed projections; large outputs use content-addressed object artifacts; domain writes append an exact ACK in the same transaction.

**Tech Stack:** NestJS, TypeScript, Temporal, Prisma, PostgreSQL 16 with FORCE RLS and SECURITY DEFINER functions, JOSE/JWKS, AJV, S3-compatible object storage, OpenAPI, JSON Schema, Vitest, Docker/OCI.

**Spec:** `docs/architecture/execution-budget-authority-artifact-replay-design.md`

## Global Constraints

- Development, pilot, and production run the same business implementation, verifier, database guard, result strategy, ACK semantics, readiness and immutable OCI artifact.
- Environment differences are limited to issuer/JWKS trust roots, secret references, endpoints, data, authorized amounts, resource sizes, observability and deployment topology.
- No authority means zero budget account, zero operation row, zero Temporal workflow and zero Provider wire.
- Backend never chooses a hidden total product budget; only an externally verified authority supplies the cap.
- No valid output or unknown physical-call/object ACK keeps the full reservation and never causes a second physical call.
- Valid output with temporarily unknown exact cost settles at the reservation upper bound and remains replayable.
- Product code and OCI artifacts must not contain fake authority signers, Stub/Fake/Sandbox providers, fixture bodies or test artifact stores.
- Original compact JWS, prompts, raw model responses, Authorization headers, credentials and unrestricted provider bodies never enter logs, traces, PostgreSQL result JSON or Outbox payloads.
- All new tables are additive, append-only where specified, protected by FORCE RLS or a narrower fixed-role platform policy, and tested against real PostgreSQL.
- Changed statements and branches must both be at least 80%; unit tests alone do not satisfy the acceptance gate.
- The SaaS Control Plane issuer and platform-command producer are `EXTERNAL_OWNED`; this repository must remain not ready until their configured trust and fresh authorities exist.
- Do not update `docs/architecture/current.md` or claim `AS_BUILT` until the exact clean commit, migration, OCI image, runtime readback and required integration evidence all pass.

---

## Program Decomposition

| Order | Plan                                                     | Independently testable outcome                                                                                                              | Depends on                                     |
| ----- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1     | `2026-08-21-execution-budget-authority.md`               | Signed workspace/platform authority can be verified, persisted and consumed by additive DB functions without product cutover                | Approved design                                |
| 2     | `2026-08-21-typed-projection-registry.md`                | Every first-wave small Model/Tool output has a closed, bounded projector/restorer and registry declaration                                  | Plan 1 types only; can run additively          |
| 3     | `2026-08-21-generic-operation-artifacts.md`              | Large Tool results are streamed to immutable content-addressed storage and restored across workers                                          | Plan 1 DB scope; Plan 2 strategy registry      |
| 4     | `2026-08-21-generic-operation-domain-ack.md`             | Result state, domain transaction and append-only ACK survive retry without a second wire                                                    | Plans 1-3                                      |
| 5     | `2026-08-21-execution-authority-cutover-verification.md` | All product entrypoints require authority; old cap/self-open paths are removed; readiness, governance, OCI, CI and rollout gates are closed | Plans 1-4 and external Control Plane readiness |

## Locked Interfaces Across Subplans

Executors must use these names consistently. A change to one of these signatures requires updating all five plans and re-reviewing the approved design before implementation proceeds.

```ts
export type ExecutionBudgetAuthorityKind = "WORKSPACE_GRANT" | "PLATFORM_GRANT";

export interface ExecutionBudgetBinding {
  authorityId: string;
  scopeKey: string;
  accountKey: string;
  purpose: ExecutionBudgetPurpose;
  subjectType: string;
  subjectId: string;
}

export type DurableResultStrategy =
  | Readonly<{ kind: "typed_projection"; schema: string }>
  | Readonly<{
      kind: "artifact_reference";
      schema: string;
      maxBytes: number;
      mediaTypes: readonly string[];
      privacyClass: ArtifactPrivacyClass;
      ttlSeconds: number;
    }>
  | Readonly<{ kind: "no_physical_call" }>;

export type ToolBudgetOperationStatus =
  "RESERVED" | "RESULT_UNKNOWN" | "SETTLED" | "RELEASED";
```

`BudgetStore.open` changes exactly once, during the additive authority task, to:

```ts
open(input: {
  authorityId: string;
  scopeKey: string;
  accountKey: string;
  replayScope?: boolean;
}): Promise<BudgetAccountAuthorization>;
```

No implementation may retain a public `capCents`, `capMicrousd`, `RUN_BUDGET_CENTS` or `SWEEP_BUDGET_CENTS` argument as an alternate authorization path after the cutover task.

## External Control Plane Delivery Contract

The external repository must provide both capabilities before Plan 5 can switch product traffic:

1. Issue `execution-budget-grant/v1` compact JWS values for workspace mutations and publish a JWKS document at the configured trust root.
2. Produce signed `PlatformExecutionBudgetAuthorityUpserted/v1` commands with stable `schedule_id`, validity, run cap, campaign cap and maximum runs.

The Backend work in Plan 1 produces the JSON Schema, JOSE verifier, ingestion application service and deterministic conformance vectors. The transport adapter that carries the signed platform command from the Control Plane is external-owned; Backend readiness stays closed until an actual adapter invokes `PlatformExecutionBudgetAuthorityIngestionService.ingest(compactJws)` and a fresh authority is visible in PostgreSQL. Tests may inject signed test keys through test-only dependency injection, but product composition never registers a signer.

## Program Checkpoints

## Spec Coverage Index

| Approved design section                                       | Implementation plan coverage                                      |
| ------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1-2 goals, invariants, non-goals                              | this program's Global Constraints and every subplan's constraints |
| 3 authority kinds, JWS, platform command, persistence, errors | authority Tasks 1-7; cutover Tasks 2-3 and 7                      |
| 4 mandatory result strategy                                   | typed-projection Tasks 1, 5-7; cutover Task 4                     |
| 5 closed typed projections                                    | typed-projection Tasks 1-4 and 6-7                                |
| 6 artifact manifest/write/read protocol                       | artifact Tasks 1-7                                                |
| 7 Domain ACK                                                  | domain-ACK Tasks 1, 3-6                                           |
| 8 operation status and settlement separation                  | domain-ACK Tasks 2 and 7; cutover Task 1                          |
| 9 readiness and governance                                    | authority Task 7; typed Task 7; artifact Task 7; cutover Task 8   |
| 10 additive migration and atomic switch                       | each schema subplan's migration task; cutover Task 6              |
| 11 authority/projection/artifact/ACK acceptance matrix        | focused tests in all subplans; cutover Tasks 8-9                  |
| 12 rollback and operations                                    | cutover Tasks 10-11                                               |
| 13 phased implementation order                                | Program Decomposition and Checkpoints A-E                         |

The approved invariant for generic valid-output/unknown-cost reconciliation is implemented in domain-ACK Task 7. The approved PERSONAL_DATA rights-handling requirement is implemented in cutover Task 5. Both are explicit because the existing generic ledger and artifact design had no reusable Site Builder table for those responsibilities.

### Checkpoint A: Additive authority foundation

- [ ] Plan 1 focused tests, real PostgreSQL/RLS tests, Contracts build, OpenAPI/event schema validation and security review pass.
- [ ] No product endpoint requires the new grant yet; existing traffic semantics are unchanged.
- [ ] Control Plane conformance vectors are delivered to the external owner.

### Checkpoint B: Durable result completeness

- [ ] Plans 2 and 3 prove every registered physical Model/Tool has exactly one strategy.
- [ ] Typed projections are closed and bounded; artifact tools pass real object-store corruption and multi-worker tests.
- [ ] No result strategy is selected by environment name.

### Checkpoint C: Domain durability

- [ ] Plan 4 proves crash-after-wire, crash-before-domain-write, ACK loss, exact replay and conflict behavior.
- [ ] `RESULT_UNKNOWN` and `SETTLED` are distinguished from cost-basis state.

### Checkpoint D: Atomic product switch

- [ ] External workspace issuer and platform-command producer pass the shared vectors.
- [ ] Plan 5 removes all Backend-authored cap/self-open paths in the same commit that makes authority mandatory.
- [ ] Development managed runtime uses the same grant/authority path with a development trust root and lower signed amounts.
- [ ] Full API, Worker, Temporal replay, Contracts, governance, docs, fresh ContractGraph, real PostgreSQL, real object storage and actual OCI checks pass.

### Checkpoint E: Git and runtime rollout

- [ ] Push the exact reviewed commit and update PR #413 only after all local gates are green.
- [ ] Resolve review threads only with links to exact tests and current source; do not resolve on plan intent.
- [ ] Merge only after current-head CI and independent correctness/security reviews pass.
- [ ] Run retained migration, drain-and-swap deployment, service restart and readback only after merge.
- [ ] Run a small real workspace Grant request only after deployment readiness proves the exact image/migration/issuer/task queue; record the authorized amount and settlement evidence.
- [ ] Generate RuntimeEvidence only from the retained environment; local or CI containers do not substitute for it.

## Execution Order and Commit Boundary

Implement plans in numeric order. Within each plan, execute tasks in order unless its dependency block explicitly permits parallel work in non-overlapping files. Use one writer for `packages/db/prisma/schema.prisma`, each migration file, `apps/api/src/temporal/worker.ts`, `apps/api/src/tools/tool-contract.ts`, `apps/api/src/tools/tool-broker.ts`, `apps/api/src/model-gateway/router-model-gateway.ts`, `apps/api/src/health/runtime-readiness.service.ts`, `packages/contracts/openapi/openapi.json`, and `.github/workflows/ci.yml`.

Every task ends with a Conventional Commit. Before each commit:

```bash
git diff --check
git status --short --branch
```

Before any push:

```bash
pnpm code-intelligence:scan
pnpm --filter @global/code-intelligence exec tsx src/cli.ts status --repo ../..
pnpm --filter @global/api build
pnpm --filter @global/api test
pnpm governance:verify
pnpm docs:verify
```

The execution worker must add the actual changed paths to the ContractGraph impact command; the static graph is an impact baseline, not runtime proof.
