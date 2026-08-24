# Execution Budget Authority Task 6 cutover record

> Document ID: `DOC-IMPL-EXECUTION-BUDGET-AUTHORITY-TASK6-001`
>
> Lifecycle: `PRE_CUTOVER_IMPLEMENTATION`
>
> Source plan: [Execution Authority Cutover and Verification](../superpowers/plans/2026-08-21-execution-authority-cutover-verification.md#task-6-atomic-databaseproduct-cutover-and-legacy-removal)
>
> Approved design: [Execution Budget Authority and Artifact Replay](../architecture/execution-budget-authority-artifact-replay-design.md)
>
> Base: `a88f748e88239a42a8840d7740db12738458e1fc`
> RED checkpoint: `20b8edccc69526d2e2b691c91877b48615ad9e83`

This record indexes local deterministic evidence. It is not RuntimeEvidence, a
Release Bundle, retained migration evidence, deployment authorization, dispatch
authorization, or a Pilot/GA claim.

## Guarantees

| Guarantee | Deterministic evidence | Result |
| --- | --- | --- |
| Product code has one authority-only `BudgetStore.open` and no caller cap/environment amount path | `pnpm --filter @global/api test -- src/tools/execution-authority-cutover.spec.ts` | PASS, 3 tests |
| Fresh migration installs final authority-only microusd functions and removes/revokes predecessor entrypoints | `node --test packages/db/test/execution-budget-authority-cutover.spec.mjs` | PASS |
| Nonempty upgrade preserves closed historical unbound account facts but prevents reopening/reserve | same disposable PostgreSQL test | PASS |
| An active unauthorized account aborts the explicit migration transaction without partial function replacement | same disposable PostgreSQL test | PASS |
| Twenty concurrent reserves preserve `reserved_microusd + charged_microusd <= authorized_cap_microusd` | same disposable PostgreSQL test | PASS |
| Same-operation reserve/settle concurrency uses one account advisory-lock order; Task 5 direct v4 lifecycle is revoked from PUBLIC/app/platform and final recovery uses v5 | same disposable PostgreSQL test | PASS |
| Typed projections return ledger-authored receipts and authority-bound Domain ACK identity | API receipt/ACK focused tests plus full API suite | PASS |
| Artifact persistence has ledger receipt/expected-facts/ACK/Task 5 subject primitives, but the four first-wave producers lack a truthful subject at their current call boundaries | artifact focused tests plus execution-authority policy | `SUBJECT_BINDING_HOLD` |
| ToolBroker and Router have no product `BudgetLedger`/in-memory fallback; the four artifact schemas are denied before `execute()` and cannot fall back to inline projection settlement | execution-authority policy plus focused/full API tests | PASS |
| Google Patents BigQuery execution has a non-overridable `214748364800` byte hard cap | adapter tests and execution-authority policy | PASS |
| Copy fixed source is not silently rebased after shared-source drift | `node scripts/copy-fixed-source-impact.mjs` | `STALE_HOLD`, `NOT_AUTHORIZED`, Pilot blocked |

The PostgreSQL test creates a unique `pgvector/pgvector:pg16` container with
`--network none`, tmpfs storage and no published port. It applies migrations to
fresh, upgrade and rollback databases and removes the exact container in its
test teardown. It does not use or retain the development database.

## TDD evidence

The RED checkpoint executed both targets before the cutover implementation:

- API: 3 of 3 Task 6 tests failed on the intended legacy API, cap, fake-fallback
  and `NOT_WIRED` conditions.
- PostgreSQL: all three subtests failed on the intended missing final functions
  and missing cutover migration after the complete predecessor migration set
  had applied successfully.

The GREEN candidate reran the same targets without changing the guarantees.
The full API coverage run passed 5,684 tests in 376 files; 39 tests remained
skipped. Twenty-nine of those skips are the legacy backlog execution suites,
which are explicitly parked pending a signed platform-to-workspace authority
binding and are not claimed as current capability evidence. Prisma
validation/generation, Contracts build/Spectral,
API build/lint, governance, docs and ContractGraph remain separate gates and are
reported from their own command output.

Global coverage is 80.12% statements, 74.01% branches, 82.12% functions and
82.81% lines. Task6 changed-line coverage is 87.70% statements (107/122) and
86.15% branches (56/65), measured from the RED checkpoint. The changed Worker
composition and Temporal Workflow lines are explicitly classified as static
contracts and verified by `platform-schedule-authority-cutover.spec.ts` and
`backlog.budget-wiring.spec.ts`; missing coverage entries for any other changed
source remain a hard failure.

## Rollback contract

N-1 is deliberately not schema-compatible with this cutover: the caller-cap
open overload is dropped, predecessor app execution privileges are revoked, and
the final unversioned lifecycle uses microusd return fields. Rollback is
therefore **pause new work and forward-fix**. Do not roll the database backward
or run an N-1 Worker/API against the cutover schema. The negative migration test
only proves transaction rollback when preflight rejects an active unauthorized
account before the cutover is committed.

## External and retained-runtime dependencies

- `EXTERNAL_OWNED`: SaaS workspace Grant issuer and reviewed JWKS trust root.
- `EXTERNAL_OWNED`: signed platform authority command producer and transport
  that invokes `PlatformExecutionBudgetAuthorityIngestionService.ingest`.
- `HOLD`: backlog and external-intent legacy schedules no longer auto-open
  Backend-authored accounts. Backlog's seven activities unconditionally return
  `EXECUTION_BUDGET_PLATFORM_AUTHORITY_REQUIRED` before owner/tenant reads,
  scoring, provider wires or watermarks; the workflow rethrows only that exact
  new failure token without changing predecessor failure-history replay.
  Until their signed schedule authority and platform-to-workspace subject
  mapping are delivered, they remain non-consuming.
- `SUBJECT_BINDING_HOLD`: every first-wave Artifact strategy is classified
  `PERSONAL_DATA`, while Task 5 correctly requires a workspace-scoped
  `company`/`contact` UUID. Platform `sanctions.download` has no workspace
  subject, and discovery `http.get`/Crawl4AI may run before a canonical company
  UUID exists. Until an approved ownership contract supplies those identities
  without weakening privacy classification, ToolBroker releases the untouched
  reservation and denies these schemas before `execute()`; inline settlement
  and physical fallback are forbidden.
- `UNVERIFIED`: retained PostgreSQL migration, exact OCI publication,
  API/Worker/Relay same-digest deployment, service restart and live readback.
- `NOT_AUTHORIZED`: provider/model dispatch, evaluation, deployment, push, PR,
  merge and release. No such action was performed by Task 6.
- `STALE_HOLD`: Copy fixed-source eligibility remains blocked after shared
  schema/runtime changes; no frozen receipt or historical evidence was edited.

The next authorized phase must independently provide current-head CI/review,
external Control Plane conformance, retained migration/deployment readback and
fresh RuntimeEvidence. Local source and disposable infrastructure evidence
cannot promote the capability.
