# Execution Budget Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify, persist and consume externally signed workspace and platform execution authorities so Backend can no longer invent a product spending cap.

**Architecture:** A shared JOSE verifier produces an immutable verified claim object. Workspace requests atomically consume a short-lived grant with their business identity; platform commands upsert signed campaign authority through a transport-neutral ingestion service. PostgreSQL owns cap selection, authority validity, revocation, run count and account creation under row locks.

**Tech Stack:** NestJS, TypeScript, JOSE, AJV, Prisma, PostgreSQL 16, FORCE RLS, OpenAPI, JSON Schema, Vitest.

**Spec:** `docs/architecture/execution-budget-authority-artifact-replay-design.md`

## Global Constraints

- Use `X-Execution-Budget-Grant`; maximum compact JWS size is 16 KiB.
- Accepted algorithms are the configured subset of `RS256`, `ES256`, and `EdDSA`; reject `none`, all `HS*`, missing `kid`, and wrong `typ`.
- Audience is exactly `global-backend:execution-budget`; TTL is at most 300 seconds with at most 60 seconds clock tolerance.
- `cap_microusd`, `cap_per_run_microusd` and `campaign_cap_microusd` are positive canonical decimal strings within PostgreSQL BIGINT.
- Store only the token SHA-256 and verified claims; never store or log the compact JWS.
- Workspace and platform authority use the same verifier and database rules in every managed environment.
- Platform transport is external-owned; product readiness remains closed until a real configured consumer invokes the ingestion service and fresh authority rows exist.
- This plan is additive. Product traffic switches only in `2026-08-21-execution-authority-cutover-verification.md`.

---

## File Structure

**Create:**

- `apps/api/src/execution-budget/execution-budget-authority.types.ts` — canonical authority kinds, purposes, verified claims and stable errors.
- `apps/api/src/execution-budget/execution-budget-grant.verifier.ts` — shared compact JWS/JWKS verifier and readiness probe.
- `apps/api/src/execution-budget/execution-budget-authority.repository.ts` — transaction-scoped authority insert, replay and conflict logic.
- `apps/api/src/execution-budget/execution-budget-authority.service.ts` — workspace consumption and account binding application service.
- `apps/api/src/execution-budget/platform-authority-ingestion.service.ts` — transport-neutral signed platform command consumer.
- `apps/api/src/execution-budget/execution-budget.module.ts` — product DI composition; verifier only, never signer.
- `apps/api/src/execution-budget/*.spec.ts` — verifier, repository, service and ingestion tests.
- `packages/contracts/events/payloads/platform-execution-budget-authority-upserted.v1.schema.json` — external signed command schema.
- `packages/db/prisma/migrations/20260821090000_execution_budget_authority/migration.sql` — additive authority/revocation/account-binding schema and guarded functions.
- `packages/db/test/execution-budget-authority.rls.spec.mjs` — real PostgreSQL/RLS/concurrency test harness.

**Modify:**

- `packages/db/prisma/schema.prisma` — authority models, revocation relation and nullable additive account binding.
- `apps/api/src/tools/budget-store.ts` — authority-aware `open` signature and returned authorization.
- `apps/api/src/model-gateway/model-gateway.module.ts` — export authority module dependencies without a signer.
- `apps/api/src/runtime/managed-dependency-readiness.ts` — authority JWKS readiness contributor.
- `apps/api/src/health/runtime-readiness.service.ts` — expose workspace/platform authority readiness components.
- `apps/api/src/health/runtime-readiness.service.spec.ts` — fail-closed snapshot tests.
- `apps/api/.env.example` — exact verifier trust configuration; no amount configuration.
- `packages/contracts/src/index.ts` and Contracts tests — publish event constants/types.

## Locked Interfaces

```ts
export type ExecutionBudgetAuthorityKind = "WORKSPACE_GRANT" | "PLATFORM_GRANT";

export type ExecutionBudgetPurpose =
  | "icp.design"
  | "icp.query_plan"
  | "understanding.run"
  | "discovery.run"
  | "contact.verify"
  | "platform.acquisition"
  | "platform.intent_watch"
  | "platform.sanctions";

export interface VerifiedExecutionBudgetAuthority {
  schemaVersion: "execution-budget-grant/v1";
  authorityKind: ExecutionBudgetAuthorityKind;
  issuer: string;
  audience: "global-backend:execution-budget";
  jti: string;
  purpose: ExecutionBudgetPurpose;
  workspaceId: string | null;
  subjectType: string;
  subjectId: string;
  requestSha256: string | null;
  scheduleId: string | null;
  currency: "USD";
  unit: "microusd";
  capMicrousd: bigint | null;
  capPerRunMicrousd: bigint | null;
  campaignCapMicrousd: bigint | null;
  maxRuns: bigint | null;
  tokenSha256: string;
  issuedAt: Date;
  notBefore: Date;
  expiresAt: Date;
}

export interface BudgetAccountAuthorization {
  authorityId: string;
  authorizedCapMicrousd: bigint;
  generation: number;
}
```

The verifier and Control Plane conformance vectors use this exact purpose/subject matrix:

```text
understanding.run  + company       + request:<request_sha256>  for POST /companies
icp.design         + company       + route companyId
icp.query_plan     + icp           + route icpId
discovery.run      + discovery_run + request:<request_sha256>  for query-plan execution
discovery.run      + company       + route canonical-company id for contact discovery/email guessing
contact.verify     + contact_point + route pointId
```

`request:<request_sha256>` reuses the endpoint's existing normalized request digest and lets the Control Plane sign before Backend allocates a Company or DiscoveryRun UUID. It is not a second canonicalization algorithm.

### Task 1: Canonical claim and error types

**Files:**

- Create: `apps/api/src/execution-budget/execution-budget-authority.types.ts`
- Test: `apps/api/src/execution-budget/execution-budget-authority.types.spec.ts`

**Interfaces:**

- Consumes: no new internal interface.
- Produces: `VerifiedExecutionBudgetAuthority`, `ExecutionBudgetPurpose`, `ExecutionBudgetGrantError`, `assertCanonicalMicrousd`, `assertAuthorityPurposeShape`.

- [ ] **Step 1: Write the failing type/validation tests**

```ts
it.each(["0", "-1", "1.0", "01", "9223372036854775808"])(
  "rejects non-canonical microusd %s",
  (value) => {
    expect(() => assertCanonicalMicrousd(value)).toThrow(
      "EXECUTION_BUDGET_GRANT_INVALID",
    );
  },
);

it("rejects workspace claims without workspace, request hash and subject binding", () => {
  expect(() =>
    assertAuthorityPurposeShape({
      authorityKind: "WORKSPACE_GRANT",
      purpose: "icp.design",
      workspaceId: null,
      requestSha256: null,
      subjectType: "company",
      subjectId: "company-1",
      scheduleId: null,
      capMicrousd: 1n,
      capPerRunMicrousd: null,
      campaignCapMicrousd: null,
      maxRuns: null,
    }),
  ).toThrow("EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH");
});
```

- [ ] **Step 2: Run the focused test and record RED**

Run: `pnpm --filter @global/api test -- src/execution-budget/execution-budget-authority.types.spec.ts`

Expected: FAIL because the new module and exported validators do not exist.

- [ ] **Step 3: Implement exact errors and closed purpose-shape validation**

```ts
export type ExecutionBudgetGrantErrorCode =
  | "EXECUTION_BUDGET_GRANT_REQUIRED"
  | "EXECUTION_BUDGET_GRANT_INVALID"
  | "EXECUTION_BUDGET_GRANT_EXPIRED"
  | "EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH"
  | "EXECUTION_BUDGET_GRANT_REUSED"
  | "EXECUTION_BUDGET_AUTHORITY_REVOKED"
  | "EXECUTION_BUDGET_AUTHORITY_EXHAUSTED"
  | "EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE";

export function assertCanonicalMicrousd(value: unknown): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new ExecutionBudgetGrantError("EXECUTION_BUDGET_GRANT_INVALID");
  }
  const parsed = BigInt(value);
  if (parsed > 9_223_372_036_854_775_807n) {
    throw new ExecutionBudgetGrantError("EXECUTION_BUDGET_GRANT_INVALID");
  }
  return parsed;
}
```

Map required/invalid/expired to HTTP 402, scope mismatch to 403, reused to 409, and verifier unavailable to 503. Keep repository/domain errors transport-neutral; only the HTTP filter/decorator maps them to the response envelope.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm --filter @global/api test -- src/execution-budget/execution-budget-authority.types.spec.ts && pnpm --filter @global/api build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/execution-budget/execution-budget-authority.types.ts apps/api/src/execution-budget/execution-budget-authority.types.spec.ts
git commit -m "feat(budget): define execution authority claims"
```

### Task 2: Shared JOSE verifier and readiness probe

**Files:**

- Create: `apps/api/src/execution-budget/execution-budget-grant.verifier.ts`
- Test: `apps/api/src/execution-budget/execution-budget-grant.verifier.spec.ts`
- Modify: `apps/api/src/runtime/managed-dependency-readiness.ts`
- Modify: `apps/api/src/runtime/managed-dependency-readiness.spec.ts`
- Modify: `apps/api/.env.example`

**Interfaces:**

- Consumes: Task 1 claim/error types.
- Produces: `ExecutionBudgetGrantVerifier.verify(compactJws, expectedScope)`, `checkExecutionBudgetJwksReadiness(env)`.

- [ ] **Step 1: Write RED tests for algorithms, claims, redaction and readiness**

Create deterministic RS256, ES256 and EdDSA test key pairs. Assert valid tokens verify, while `none`, HS256, missing `kid`, wrong `typ`, wrong fixed audience, `aud` arrays, wrong issuer, TTL over 300 seconds, future `iat`, expired `exp`, workspace mismatch, purpose mismatch and request-hash mismatch are rejected. Capture logger/error/serialized verified object and assert none contain the compact token.

```ts
expect(
  await verifier.verify(token, {
    authorityKind: "WORKSPACE_GRANT",
    purpose: "icp.design",
    workspaceId: WORKSPACE_ID,
    subjectType: "company",
    subjectId: COMPANY_ID,
    requestSha256: REQUEST_HASH,
  }),
).toMatchObject({
  audience: "global-backend:execution-budget",
  tokenSha256: sha256(token),
});
expect(JSON.stringify(observedLogs)).not.toContain(token);
```

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @global/api test -- src/execution-budget/execution-budget-grant.verifier.spec.ts src/runtime/managed-dependency-readiness.spec.ts`

Expected: FAIL because the execution verifier/readiness contributor do not exist.

- [ ] **Step 3: Implement one verifier configuration contract**

Require exactly:

```text
EXECUTION_BUDGET_GRANT_JWKS_URI
EXECUTION_BUDGET_GRANT_ISSUER
EXECUTION_BUDGET_GRANT_AUDIENCE=global-backend:execution-budget
EXECUTION_BUDGET_GRANT_ALGORITHMS=RS256,ES256,EdDSA
```

Use `decodeProtectedHeader` before verification; reject token byte length over 16 KiB; intersect configured algorithms with the fixed set; enforce `typ=execution-budget-grant+jwt`; use `jwtVerify` with exact string audience and issuer; parse all claims into a fresh immutable object. Permit HTTP JWKS only for loopback development/test trust roots, using the existing environment-parity policy classification.

- [ ] **Step 4: Run GREEN and targeted security checks**

Run: `pnpm --filter @global/api test -- src/execution-budget/execution-budget-grant.verifier.spec.ts src/runtime/managed-dependency-readiness.spec.ts && pnpm --filter @global/api build`

Expected: PASS; invalid JWKS URL produces a stable readiness code without dispatching fetch or exposing the URL/token.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/execution-budget apps/api/src/runtime/managed-dependency-readiness.ts apps/api/src/runtime/managed-dependency-readiness.spec.ts apps/api/.env.example
git commit -m "feat(budget): verify signed execution grants"
```

### Task 3: Additive authority, revocation and account-binding schema

**Files:**

- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/20260821090000_execution_budget_authority/migration.sql`
- Create: `packages/db/test/execution-budget-authority.rls.spec.mjs`

**Interfaces:**

- Consumes: Task 1 field names and PostgreSQL BIGINT decimal boundary.
- Produces: `execution_budget_authority`, `execution_budget_authority_revocation`, nullable `tool_budget_account.authority_id`, `consume_workspace_execution_authority`, `ingest_platform_execution_authority`, and authority-aware additive `open_authorized_tool_budget_v1`.

- [ ] **Step 1: Write migration integrity and real PostgreSQL RED tests**

The test must create owner, `app_user`, and fixed platform-writer sessions, deploy all migrations, set workspace GUCs, and assert:

```js
await rejectsSql(
  appUserWsA,
  `UPDATE execution_budget_authority SET expires_at=now()`,
);
await rejectsSql(appUserWsA, `DELETE FROM execution_budget_authority`);
await rejectsSql(
  appUserWsB,
  `SELECT * FROM execution_budget_authority WHERE workspace_id='${WS_A}'`,
);
await rejectsSql(
  appUserWsA,
  `SELECT * FROM open_authorized_tool_budget_v1('${FOREIGN_AUTH}', 'key', true)`,
);
```

Add a 20-client same-JTI race: exactly one immutable authority row and one consumed identity may exist; mismatched token digest/request scope must return `EXECUTION_BUDGET_GRANT_REUSED` without additional rows.

- [ ] **Step 2: Run RED against a disposable PostgreSQL database**

Run the repository's existing CI PostgreSQL service command, then:

```bash
APP_DATABASE_URL="$TEST_APP_DATABASE_URL" DATABASE_URL="$TEST_OWNER_DATABASE_URL" \
  node --test packages/db/test/execution-budget-authority.rls.spec.mjs
```

Expected: FAIL because models, tables and functions are absent.

- [ ] **Step 3: Add schema and explicit-transaction migration**

Add Prisma enums/models using mapped snake-case names. The migration must start with `BEGIN;` and end with `COMMIT;`, use `SET LOCAL lock_timeout`, create constraints for the two authority shapes, enable and force RLS, revoke public DML/function execution, and grant only narrow function execution.

The account column is nullable in this additive task:

```prisma
authorityId            String?  @map("authority_id") @db.Uuid
authorizedCapMicrousd BigInt? @map("authorized_cap_microusd")
authority ExecutionBudgetAuthority? @relation(fields: [authorityId], references: [id], onDelete: NoAction)
```

`open_authorized_tool_budget_v1(p_scope_key, p_authority_id, p_account_key, p_replay_scope)` must lock the authority row, reject revoked/not-yet-valid/expired/exhausted/wrong-scope authority, derive the per-account cap from the authority, increment platform `runs_consumed` exactly once for a new account generation, and never accept a caller cap.

- [ ] **Step 4: Run migration, RLS and Prisma validation GREEN**

Run:

```bash
pnpm --filter @global/db exec prisma validate
pnpm --filter @global/db generate
APP_DATABASE_URL="$TEST_APP_DATABASE_URL" DATABASE_URL="$TEST_OWNER_DATABASE_URL" \
  node --test packages/db/test/execution-budget-authority.rls.spec.mjs
```

Expected: all assertions pass; direct app-role UPDATE/DELETE are denied; cross-workspace missing and foreign authorities are indistinguishable.

- [ ] **Step 5: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations/20260821*_execution_budget_authority/migration.sql packages/db/test/execution-budget-authority.rls.spec.mjs
git commit -m "feat(db): add execution budget authority"
```

### Task 4: Authority repository and authority-aware BudgetStore

**Files:**

- Create: `apps/api/src/execution-budget/execution-budget-authority.repository.ts`
- Test: `apps/api/src/execution-budget/execution-budget-authority.repository.spec.ts`
- Modify: `apps/api/src/tools/budget-store.ts`
- Modify: `apps/api/src/tools/budget-store.spec.ts`

**Interfaces:**

- Consumes: Task 3 functions.
- Produces: `ExecutionBudgetAuthorityRepository.consumeWorkspace`, `.ingestPlatform`, `.revoke`; authority-aware `BudgetStore.open`.

- [ ] **Step 1: Write RED repository and adapter tests**

Assert parameterized Prisma SQL, exact SQL marker-to-error mapping, token digest idempotency, and that `BudgetStore.open` sends no amount argument:

```ts
await store.open({
  authorityId: AUTHORITY_ID,
  scopeKey: WORKSPACE_ID,
  accountKey: "icp:design:req",
  replayScope: true,
});
expect(serializedQuery).not.toContain("capCents");
expect(serializedValues).toEqual(
  expect.arrayContaining([AUTHORITY_ID, WORKSPACE_ID, "icp:design:req", true]),
);
```

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @global/api test -- src/execution-budget/execution-budget-authority.repository.spec.ts src/tools/budget-store.spec.ts`

Expected: FAIL because the repository and new signature are absent.

- [ ] **Step 3: Implement repository and signature atomically**

Replace the public interface with:

```ts
open(input: {
  authorityId: string;
  scopeKey: string;
  accountKey: string;
  replayScope?: boolean;
}): Promise<BudgetAccountAuthorization>;
```

Keep the current legacy SQL function present for additive compatibility, but remove every new call to it. Map stable SQL markers to Task 1 errors and keep raw database messages out of HTTP/log responses.

- [ ] **Step 4: Run GREEN and build**

Run: `pnpm --filter @global/api test -- src/execution-budget/execution-budget-authority.repository.spec.ts src/tools/budget-store.spec.ts && pnpm --filter @global/api build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/execution-budget/execution-budget-authority.repository.ts apps/api/src/execution-budget/execution-budget-authority.repository.spec.ts apps/api/src/tools/budget-store.ts apps/api/src/tools/budget-store.spec.ts
git commit -m "feat(budget): bind accounts to signed authority"
```

### Task 5: Workspace consumption application service

**Files:**

- Create: `apps/api/src/execution-budget/execution-budget-authority.service.ts`
- Test: `apps/api/src/execution-budget/execution-budget-authority.service.spec.ts`
- Create: `apps/api/src/execution-budget/execution-budget.module.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**

- Consumes: verifier, repository and authority-aware BudgetStore.
- Produces: `verifyWorkspaceGrant`, `consumeWorkspaceGrant`, `ExecutionBudgetBinding`.

- [ ] **Step 1: Write RED tests for zero-write verification failure and atomic consume**

```ts
await expect(
  service.consumeWorkspaceGrant({ compactJws: invalid, identity, scope }),
).rejects.toMatchObject({
  code: "EXECUTION_BUDGET_GRANT_INVALID",
});
expect(repository.consumeWorkspace).not.toHaveBeenCalled();

const binding = await service.consumeWorkspaceGrant({
  compactJws: valid,
  identity,
  scope,
});
expect(binding).toEqual({
  authorityId: AUTHORITY_ID,
  scopeKey: WORKSPACE_ID,
  accountKey: EXPECTED_ACCOUNT_KEY,
  purpose: "icp.design",
  subjectType: "company",
  subjectId: COMPANY_ID,
});
```

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @global/api test -- src/execution-budget/execution-budget-authority.service.spec.ts`

Expected: FAIL because the service/module do not exist.

- [ ] **Step 3: Implement immutable binding creation**

Hash the normalized business request with the existing endpoint-specific normalizer before calling the verifier. Do not create a second generic JSON canonicalizer. Produce `accountKey` from purpose, subject and request digest; never from raw headers or current time. Register verifier/repository/service in the product module; no signer, fixture key or fallback provider is registered.

- [ ] **Step 4: Run GREEN and module compilation**

Run: `pnpm --filter @global/api test -- src/execution-budget/execution-budget-authority.service.spec.ts && pnpm --filter @global/api build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/execution-budget apps/api/src/app.module.ts
git commit -m "feat(budget): consume workspace execution grants"
```

### Task 6: Platform signed command contract and ingestion

**Files:**

- Create: `packages/contracts/events/payloads/platform-execution-budget-authority-upserted.v1.schema.json`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/execution-budget.ts`
- Create: `apps/api/src/execution-budget/platform-authority-ingestion.service.ts`
- Test: `apps/api/src/execution-budget/platform-authority-ingestion.service.spec.ts`
- Modify: `apps/api/src/execution-budget/execution-budget.module.ts`

**Interfaces:**

- Consumes: shared verifier and repository.
- Produces: `PlatformExecutionBudgetAuthorityIngestionService.ingest(compactJws: string): Promise<{authorityId:string; replay:boolean}>` and machine schema for external producer conformance.

The current repository has only Backend-to-SaaS Outbox delivery; it has no SaaS-to-Backend command transport. Do not add this command to outbound `INTEGRATION_EVENTS`. This task creates the signed command schema and transport-neutral consumer. Runtime status remains `EXTERNAL_OWNED/PARTIAL` until the external transport invokes this service and the freshness probe observes its rows.

- [ ] **Step 1: Write RED schema and ingestion tests**

Validate exact fields, additionalProperties false, schedule/purpose binding, decimal strings, validity and signature. Assert an unsigned event payload or a signed token embedded in an unregistered wrapper is rejected. Assert the returned object never includes the token.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @global/contracts build && pnpm --filter @global/api test -- src/execution-budget/platform-authority-ingestion.service.spec.ts`

Expected: FAIL because the schema/type/service are absent.

- [ ] **Step 3: Implement transport-neutral ingestion**

```ts
@Injectable()
export class PlatformExecutionBudgetAuthorityIngestionService {
  async ingest(
    compactJws: string,
  ): Promise<{ authorityId: string; replay: boolean }> {
    const verified = await this.verifier.verifyPlatform(compactJws);
    return this.repository.ingestPlatform(verified);
  }
}
```

Do not add a local signer or an environment bootstrap that creates authority. Register only this consumer service. Add fixed cross-repository conformance fixtures containing public keys, claims and expected outcomes; never include a private production key.

- [ ] **Step 4: Run GREEN**

Run: `pnpm --filter @global/contracts build && pnpm --filter @global/contracts lint && pnpm --filter @global/api test -- src/execution-budget/platform-authority-ingestion.service.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/events/payloads/platform-execution-budget-authority-upserted.v1.schema.json packages/contracts/src/execution-budget.ts packages/contracts/src/index.ts apps/api/src/execution-budget
git commit -m "feat(contracts): add platform execution authority command"
```

### Task 7: Authority readiness and health contract

**Files:**

- Modify: `apps/api/src/runtime/managed-dependency-readiness.ts`
- Modify: `apps/api/src/health/runtime-readiness.service.ts`
- Modify: `apps/api/src/health/runtime-readiness.service.spec.ts`
- Modify: `apps/api/src/temporal/worker.ts`
- Test: `apps/api/src/temporal/worker-startup.spec.ts`

**Interfaces:**

- Consumes: verifier probe and repository freshness query.
- Produces: readiness components `execution_budget_jwks`, `workspace_budget_authority`, `platform_budget_authority`.

- [ ] **Step 1: Write RED readiness tests**

Assert initial snapshots are not ready, unavailable JWKS causes no network dispatch to unsafe URLs, workspace capability needs valid verifier config, and each platform schedule purpose needs a non-revoked unexpired authority. Assert Worker does not poll when any required scheduled purpose lacks authority.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @global/api test -- src/health/runtime-readiness.service.spec.ts src/temporal/worker-startup.spec.ts`

Expected: FAIL because the new components are absent.

- [ ] **Step 3: Implement cached fail-closed contributors**

Use the existing readiness contributor registry. Probes may read JWKS and PostgreSQL, but request guards consume only the cached snapshot. Do not query external systems on every HTTP request. Platform freshness must return a stable code naming the missing purpose, never authority claims or token digests.

- [ ] **Step 4: Run GREEN and OpenAPI health snapshot tests**

Run: `pnpm --filter @global/api test -- src/health/runtime-readiness.service.spec.ts src/health/health-openapi.spec.ts src/temporal/worker-startup.spec.ts && pnpm --filter @global/api build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/runtime/managed-dependency-readiness.ts apps/api/src/health apps/api/src/temporal/worker.ts apps/api/src/temporal/worker-startup.spec.ts
git commit -m "feat(runtime): gate work on execution authority"
```

### Task 8: Authority subproject verification and external handoff packet

**Files:**

- Create: `docs/implementation-records/execution-budget-authority-contract.md`
- Modify: `docs/roadmap/changelog.md`
- Do not modify: `docs/status/current.md`, `docs/architecture/current.md`.

**Interfaces:**

- Consumes: Tasks 1-7.
- Produces: exact conformance commands and external-owned dependency status; no runtime capability claim.

- [ ] **Step 1: Run changed-scope coverage**

Run focused Vitest with coverage for `apps/api/src/execution-budget/**`, authority portions of `budget-store.ts`, and readiness additions. Expected: statements >=80% and branches >=80% for the changed set.

- [ ] **Step 2: Run full additive verification**

```bash
pnpm --filter @global/db exec prisma validate
pnpm --filter @global/contracts build
pnpm --filter @global/contracts lint
pnpm --filter @global/api build
pnpm --filter @global/api test
pnpm governance:verify
pnpm docs:verify
git diff --check
```

Expected: PASS.

- [ ] **Step 3: Rebuild and query ContractGraph**

```bash
pnpm code-intelligence:scan
pnpm --filter @global/code-intelligence exec tsx src/cli.ts status --repo ../..
pnpm --filter @global/code-intelligence exec tsx src/cli.ts impact \
  packages/db/prisma/schema.prisma \
  apps/api/src/execution-budget/execution-budget.module.ts \
  apps/api/src/tools/budget-store.ts \
  apps/api/src/health/runtime-readiness.service.ts --repo ../..
```

Expected: graph binds the exact working commit/tree; report static affected capabilities without claiming runtime proof.

- [ ] **Step 4: Write the implementation record**

Record exact commit, migration name, public schema paths, commands/results, coverage, external producer/JWKS status as `EXTERNAL_OWNED`, and state that product cutover has not happened.

- [ ] **Step 5: Commit**

```bash
git add docs/implementation-records/execution-budget-authority-contract.md docs/roadmap/changelog.md
git commit -m "docs: record execution authority contract"
```
