# Execution Authority Clock and Readiness Correction Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Authority foundation's cross-layer NumericDate boundary drift and background readiness rejection hole before any ToolRegistry, RouterModelGateway, ToolBroker, settlement, or product authorization integration.

**Architecture:** JWT NumericDate is an integer-second contract. The verifier already compares it to `floor(now / 1000)`; the PostgreSQL authority helper must normalize the supplied verification time to the same whole-second clock before applying the shared 60-second tolerance. Runtime readiness keeps its cached fail-closed snapshot, but all fire-and-forget bootstrap/interval refreshes explicitly consume rejected promises so a dependency failure cannot become an unhandled process-level rejection.

**Tech Stack:** TypeScript, NestJS, Vitest fake timers, Prisma, PostgreSQL 16, PL/pgSQL, JOSE NumericDate, existing Authority real-PG test harness.

**Spec:** `docs/architecture/execution-budget-authority-artifact-replay-design.md`

## Global Constraints

- This is a correction gate for the existing additive Authority foundation; it does not make product authority mandatory, enable spending, or change Worker/API admission.
- The time contract is exactly: `iat` and `nbf` are accepted through `verification_second + 60`; `exp` is accepted through `verification_second - 60`; `iat`/`nbf` beyond tolerance are invalid; `exp` beyond tolerance is expired.
- NumericDate is whole seconds in verifier, repository, database ingest/open and freshness. No caller controls a database verification clock in product APIs.
- Platform freshness has a closed state vocabulary including `invalid`; its public code is fixed and purpose-derived, never data-derived.
- Background refresh consumes rejected promises with a bounded catch; it retains the last snapshot and never writes raw dependency errors to health responses.
- Amend only the unretained `20260821090000_execution_budget_authority` migration. Do not edit older migrations or retained databases.
- Authority-bound accounts remain non-spendable until the separate microusd lifecycle cutover. No external signer/JWKS, provider/model call, deployment, retained migration, push, PR, merge or restart occurs in this plan.
- Active Copy binding remains unchanged. Regenerate the existing exact Authority STALE successor eligibility only if the current bound-file fingerprint changes; it remains `STALE_HOLD / NOT_AUTHORIZED / BLOCKED`.

---

### Task 1: Reproduce and unify NumericDate clock semantics

**Files:**

- Modify: `packages/db/prisma/migrations/20260821090000_execution_budget_authority/migration.sql`
- Modify: `packages/db/test/execution-budget-authority.rls.spec.mjs`
- Modify: `apps/api/src/execution-budget/execution-budget-grant.verifier.spec.ts`
- Modify: `apps/api/src/runtime/managed-dependency-readiness.ts`
- Modify: `apps/api/src/runtime/managed-dependency-readiness.spec.ts`

**Interfaces:**

- Consumes: verifier's 60-second NumericDate behavior and `execution_budget_authority_time_state`.
- Produces: one integer-second cross-layer time matrix and a closed `invalid` platform freshness state.

- [ ] **Step 1: Write failing cross-layer tests**

Create deterministic tests for `-61`, `-60`, `0`, `+60`, `+61` offsets using a JavaScript `now` with a nonzero millisecond fraction and an explicit PostgreSQL `p_verification_time` with the same fraction. Assert verifier, workspace ingest, platform ingest, authorized open and platform freshness agree. Assert platform freshness maps SQL `invalid` to the fixed purpose-specific `*_INVALID` code instead of generic unavailable.

- [ ] **Step 2: Run RED**

Run the verifier/readiness focused tests and the real PostgreSQL Authority suite. Expected failures: `exp=-60` is verifier-accepted but database-expired; `invalid` is rejected by the TypeScript readiness state parser.

- [ ] **Step 3: Implement the one root-cause fix**

Inside `execution_budget_authority_time_state`, derive the comparison clock with PostgreSQL `date_trunc('second', p_verification_time)` before all three tolerance comparisons. Preserve storage timestamps unchanged. Add `'invalid'` to `PlatformAuthorityReadinessState`, the closed state set and the purpose-code mapping.

- [ ] **Step 4: Run GREEN**

Run the same cross-layer boundary matrix against a fresh disposable PostgreSQL 16 database. Expected: all five offsets agree at verifier/ingest/open/freshness boundaries; no product authority path is enabled.

- [ ] **Step 5: Commit**

```bash
git add packages/db/prisma/migrations/20260821090000_execution_budget_authority/migration.sql packages/db/test/execution-budget-authority.rls.spec.mjs apps/api/src/execution-budget/execution-budget-grant.verifier.spec.ts apps/api/src/runtime/managed-dependency-readiness.ts apps/api/src/runtime/managed-dependency-readiness.spec.ts
git commit -m "fix(budget): align authority numericdate clock"
```

### Task 2: Contain background readiness refresh rejection

**Files:**

- Modify: `apps/api/src/health/runtime-readiness.service.ts`
- Modify: `apps/api/src/health/runtime-readiness.service.spec.ts`

**Interfaces:**

- Consumes: current snapshot, `check()`, bootstrap interval and shutdown lifecycle.
- Produces: `refreshInBackground()` with explicit bounded rejection consumption.

- [ ] **Step 1: Write failing lifecycle test**

Use fake timers and an `unhandledRejection` listener. Make the background `check()` reject once, call `onApplicationBootstrap`, advance the immediate and interval work, and assert no unhandled rejection fires, no timer leaks after shutdown, and `current()` remains the previous fail-closed snapshot.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @global/api test -- src/health/runtime-readiness.service.spec.ts`

Expected: the current `void this.check()` path emits an unhandled rejection or fails the listener assertion.

- [ ] **Step 3: Implement one background wrapper**

```ts
private refreshInBackground(): void {
  void this.check().catch(() => undefined);
}
```

Use that method for both immediate bootstrap and interval callback. Do not make `/health/ready` invoke `check()`, and do not change hard/capability admission semantics.

- [ ] **Step 4: Run GREEN**

Run fake-timer lifecycle, health controller/OpenAPI and SiteBuild hard-only guard regressions. Expected: no unhandled rejection, current snapshot preserved, capability probes remain absent from request hard checks.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/health/runtime-readiness.service.ts apps/api/src/health/runtime-readiness.service.spec.ts
git commit -m "fix(runtime): contain readiness refresh rejection"
```

### Task 3: Revalidate Authority correction and record the HOLD boundary

**Files:**

- Modify: `docs/implementation-records/execution-budget-authority-contract.md`
- Modify: `docs/roadmap/changelog.md`
- Modify only if generated fingerprint changes: `docs/evidence/site-builder/copy-runtime-eligibility.json`, `scripts/copy-fixed-source-impact.mjs`, `scripts/copy-fixed-source-impact.spec.mjs`, `docs/implementation-records/copy-fixed-source-impact-governance.md`

**Interfaces:**

- Consumes: Tasks 1-2 exact commits and machine gates.
- Produces: an honest correction record; Authority remains additive/non-admitting and microusd lifecycle cutover remains blocked.

- [ ] **Step 1: Run full correction validation**

```bash
pnpm --filter @global/api test
pnpm --filter @global/api build
pnpm --filter @global/api lint
pnpm --filter @global/contracts build
pnpm --filter @global/contracts lint
DATABASE_URL=<non-secret-disposable-url> pnpm --filter @global/db exec prisma validate
DATABASE_URL=<non-secret-disposable-url> pnpm --filter @global/db generate
pnpm governance:verify
pnpm docs:verify
git diff --check
```

- [ ] **Step 2: Run fresh PostgreSQL evidence**

Deploy all migrations to a disposable PostgreSQL 16 instance, run the full `execution-budget-authority.rls.spec.mjs`, `prisma migrate status`, and fresh-versus-upgrade `migrate diff --exit-code`. Destroy the exact temporary container and anonymous volume; do not contact `global-postgres`.

- [ ] **Step 3: Refresh Copy successor only through its generator**

Run the existing Copy impact generator/readback. If fingerprint changes, derive a precise updated Authority successor path set and mutation tests. Preserve active binding and `STALE_HOLD / NOT_AUTHORIZED / BLOCKED`; do not hand-edit a CURRENT receipt.

- [ ] **Step 4: Rebuild ContractGraph and update records**

Run scan/status/impact at the exact clean commit. Record cross-layer clock matrix, background rejection containment, exact verification commands, retained-runtime exclusions, and unresolved writer-only microusd lifecycle cutover.

- [ ] **Step 5: Commit**

```bash
git add docs/implementation-records/execution-budget-authority-contract.md docs/roadmap/changelog.md docs/evidence/site-builder/copy-runtime-eligibility.json scripts/copy-fixed-source-impact.mjs scripts/copy-fixed-source-impact.spec.mjs docs/implementation-records/copy-fixed-source-impact-governance.md
git commit -m "docs: record authority correction gate"
```
