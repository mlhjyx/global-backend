# Trusted Approval Current-Head Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all five valid current-head review findings without inventing hosted trust, weakening the external HOLD, or allowing caller-owned objects to promote approval state or durable merge consumption.

**Architecture:** Keep structural validators pure and total, but separate structural consistency from trust admission. Canonically derive every in-process grant digest, require Legal clearance for every explicit dual-role exception, and keep both privileged public source boundaries unconditionally fail-closed after their specific diagnostics. The current source has no hosted admission boundary and no local admission capability, mint, or bridge. Synthetic positive states remain test-fixture-only and cannot enter product composition or release artifacts.

**Tech Stack:** Node.js ESM, `node:test`, repository approval governance scripts, JSON Schema, pure transition/reconciliation kernels, executable fixture/kernel import boundaries, ContractGraph, pnpm. No source-mode hosted admission capability exists.

**Spec:** `docs/governance/trusted-approval-readback-spec.md`

## Global Constraints

- Exact implementation base is `508ebcd2579426b76faab1bfdda4e6baf90e91f9`; stop if local or remote PR head moves before implementation begins.
- Use the existing isolated worktree and branch only after ownership is rechecked; do not modify `/global/backend` shared main.
- Every defect uses RED -> GREEN -> refactor, with the failing assertion observed before implementation and related coverage remaining at least 80%.
- Plain JSON, shape-valid digests, self-declared booleans, cloned objects, fixtures, and caller-provided verifier metadata never constitute independent trust.
- No test-only mint, `NODE_ENV` bypass, exported unsafe capability factory, or synthetic fallback may enter product/governance source.
- Current source does not implement the hosted issuer or hosted current-main admission boundary. Therefore ordinary source calls must HOLD rather than enter `VERIFIED` or append merge-result/consumption facts.
- Preserve `KNOWN_EXTERNAL_HOLD / TRUSTED_RUNTIME_ADMISSION`, `EXTERNAL_UNVERIFIED`, all roles `UNASSIGNED`, Copy `STALE_HOLD`, dispatch `NOT_AUTHORIZED`, and Pilot `BLOCKED`.
- This plan does not authorize push, PR mutation, thread reply/resolution, workflow rerun, merge, ruleset mutation, deployment, RuntimeEvidence, Release, provider/model/credential use, or paid execution.

---

## Finding Map

| Review thread | Severity | Disposition | Task |
| --- | --- | --- | --- |
| `3891508603` malformed verifier repository name escapes as `TypeError` | P2 / Medium | VALID | Task 1 |
| `3891508609` declared grant digest is not bound to the actual grant | P1 review label / Medium contract integrity | VALID | Task 2 |
| `3891508599` QA dual-role coapprover bypasses required Legal clearance | P1 / High | VALID | Task 3 |
| `3891508593` caller-owned current-main readback writes durable consumption | P1 / High | VALID | Task 4 |
| `3891508588` caller-owned summaries promote state to `VERIFIED` | P1 / High | VALID | Task 5 |

## File and Ownership Map

| File | Responsibility in this remediation |
| --- | --- |
| `scripts/governance-approval-merge-orchestration.mjs` | Total readback validation and privileged durable reconciliation guard |
| `scripts/governance-approval-current-main-readback.mjs` | Closed, total diagnostic validation of current-main readback values |
| `scripts/governance-approval-readback-common.mjs` | Shared bounded repository-name validator used by both readback paths |
| `scripts/governance-approval-merge-authorization.mjs` | Canonical grant digest derivation and downstream binding |
| `scripts/governance-approval-legal-policy.mjs` | One shared pure predicate for ordinary vs dual-role Legal requirements |
| `scripts/governance-approval-role-evidence.mjs` | Role-time Legal enforcement |
| `scripts/governance-approval-acceptance.mjs` | Acceptance-time Legal and digest revalidation |
| `scripts/governance-approval-state.mjs` | Privileged receipt transition guard and honest Legal projection |
| `scripts/governance-approval-state-kernel.mjs` | Side-effect-free transition plan over already-admitted closed events |
| `scripts/governance-approval-merge-reconciliation-kernel.mjs` | Side-effect-free result/consumption plan over diagnostic readback facts |
| `scripts/fixtures/approval-readback/synthetic-verified-state.mjs` | Explicit test-only downstream state fixture; never an admission mechanism |
| `scripts/fixtures/approval-readback/merge-authorization/task4-round4-state-fixture.mjs` | Existing shared state producer updated for closed actor-policy bindings and pure-kernel tests |
| `scripts/governance-approval-state-review.spec.mjs` | Reconciliation totality and unadmitted-readback RED tests |
| `scripts/governance-approval-readback.spec.mjs` | Grant digest and Legal policy RED tests |
| `scripts/governance-approval-readback-fix.spec.mjs` | Cross-consumer synchronized mutation regressions |
| `scripts/governance-approval-state.spec.mjs` | Public append attack and honest Legal-state regressions |
| `scripts/governance-approval-state-round4.spec.mjs` | Capability non-projection regression |
| `scripts/governance-approval-state-round5.spec.mjs` | Parent-history one-shot behavior after rejected privileged append |
| `scripts/governance-approval-test-entry.spec.mjs` | Canonical root membership plus executable whole-fixture/kernel import boundary |
| `docs/governance/trusted-approval-readback-spec.md` | Normative fail-closed source/admission boundary |

---

### Task 1: Make malformed current-main readback a total, bounded HOLD

**Files:**
- Modify: `scripts/governance-approval-merge-orchestration.mjs:339-377`
- Modify: `scripts/governance-approval-current-main-readback.mjs:22-36`
- Modify: `scripts/governance-approval-readback-common.mjs`
- Test: `scripts/governance-approval-state-review.spec.mjs`

**Interfaces:**
- Consumes: caller-provided JSON-shaped `independentVerifier.repository`.
- Produces: a stable `APPROVAL_INDEPENDENCE_NOT_PROVEN` HOLD and no `MERGE_RESULT_OBSERVED` or `CONSUMPTION_RECORDED` event for malformed verifier identity.

- [ ] **Step 1: Add the RED malformed-type matrix**

Add a table-driven test that mutates an otherwise valid readback:

```js
for (const fullName of [42, null, {}, [], '', 'x'.repeat(257), 'not-a-repository-name']) {
  const changed = structuredClone(readback);
  changed.independentVerifier.repository.full_name = fullName;
  const result = await reconcileMergeAuthorizationReservation(
    reservation.reservation,
    changed,
    ledger,
    NOW,
  );
  assert.equal(result.outcome, 'HOLD');
  assert.equal(result.blockingCode, 'APPROVAL_INDEPENDENCE_NOT_PROVEN');
  const stream = await ledger.read(reservation.reservation.key);
  assert.equal(stream.events.some(({ type }) => type === 'MERGE_RESULT_OBSERVED'), false);
  assert.equal(stream.events.some(({ type }) => type === 'CONSUMPTION_RECORDED'), false);
}
```

- [ ] **Step 2: Run the exact RED test**

Run:

```bash
node --test --test-name-pattern='malformed verifier repository' scripts/governance-approval-state-review.spec.mjs
```

Expected: FAIL because `Buffer.byteLength()` throws a native `TypeError` for at least `42`.

- [ ] **Step 3: Validate type and repository syntax before byte measurement**

Export one shared pure helper from `governance-approval-readback-common.mjs` and use it in both validators:

```js
export const verifierRepositoryNameValid = (value) => (
  typeof value === 'string'
  && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
  && Buffer.byteLength(value, 'utf8') <= 256
);
```

In `readbackCode()`, return `APPROVAL_INDEPENDENCE_NOT_PROVEN` before any byte measurement when it fails. Do not add a broad catch that converts internal programming errors into input errors.

- [ ] **Step 4: Run targeted GREEN tests**

```bash
node --test scripts/governance-approval-state-review.spec.mjs
node --test scripts/governance-approval-state.spec.mjs
```

Expected: PASS; malformed values never throw or append result/consumption facts.

- [ ] **Step 5: Commit the isolated fix**

```bash
git add scripts/governance-approval-merge-orchestration.mjs scripts/governance-approval-current-main-readback.mjs scripts/governance-approval-readback-common.mjs scripts/governance-approval-state-review.spec.mjs
git commit -m "fix(governance): bound malformed merge readback"
```

---

### Task 2: Bind merge evidence to the canonical grant digest

**Files:**
- Modify: `scripts/governance-approval-merge-authorization.mjs:1-210`
- Modify: `scripts/governance-approval-readback.spec.mjs`
- Modify: `scripts/governance-approval-readback-fix.spec.mjs`
- Modify: `docs/governance/trusted-approval-readback-spec.md:477-521`
- Test: `scripts/governance-approval-readback.spec.mjs`
- Test: `scripts/governance-approval-readback-fix.spec.mjs`

**Interfaces:**
- Consumes: schema-valid grant object and declared `grant_raw_sha256`.
- Produces: one derived `expectedGrantRawSha256 = canonicalApprovalDigest(grant)` used by revocation, consumption, ledger, and receipt-reference admission.

- [ ] **Step 1: Replace arbitrary happy-path digest constants with a derived digest**

Import `canonicalApprovalDigest` from `governance-approval-ledger-stream.mjs` and construct fixtures as:

```js
const grantRawSha256 = canonicalApprovalDigest(grant);
evidence.grant_raw_sha256 = grantRawSha256;
evidence.consumption.grant_raw_sha256 = grantRawSha256;
evidence.ledger_snapshot.reservations[0].grant_raw_sha256 = grantRawSha256;
```

- [ ] **Step 2: Add the RED synchronized-declaration mutation**

```js
const changed = structuredClone(validEvidence);
const originalDigest = changed.grant_raw_sha256;
changed.grant.single_use_nonce = 'nonce-program-c-remediation-0002';
changed.grant.allowed_merge_method = 'MERGE';
changed.consumption.single_use_nonce = changed.grant.single_use_nonce;
changed.consumption.nonce_ledger_key = `program-c-merge:${changed.grant.single_use_nonce}`;
changed.consumption.observed_merge_method = changed.grant.allowed_merge_method;
changed.consumption_raw_sha256 = canonicalApprovalDigest(changed.consumption);
changed.ledger_snapshot.reservations[0].key = changed.consumption.nonce_ledger_key;
changed.ledger_snapshot.reservations[0].single_use_nonce = changed.grant.single_use_nonce;
assert.equal(changed.grant_raw_sha256, originalDigest);
assert.notEqual(changed.grant_raw_sha256, canonicalApprovalDigest(changed.grant));
assert.deepEqual(validateMergeAuthorizationEvidence(changed, candidate, authority, NOW), {
  valid: false,
  issues: [{ stable_code: 'APPROVAL_MERGE_AUTHORIZATION_GRANT_DIGEST_MISMATCH' }],
});
```

- [ ] **Step 3: Run the RED tests**

```bash
node --test --test-name-pattern='canonical grant digest|synchronized grant mutation' scripts/governance-approval-readback.spec.mjs scripts/governance-approval-readback-fix.spec.mjs
```

Expected: FAIL because the current validator accepts a digest-shaped value unrelated to the grant.

- [ ] **Step 4: Derive once and use the derived value everywhere**

After schema validation:

```js
const expectedGrantRawSha256 = canonicalApprovalDigest(grant);
if (
  !isDigest(evidence.grant_raw_sha256)
  || evidence.grant_raw_sha256 !== expectedGrantRawSha256
) {
  codes.push('APPROVAL_MERGE_AUTHORIZATION_GRANT_DIGEST_MISMATCH');
}
```

Pass `expectedGrantRawSha256`, not the caller declaration, to `validateGrantRevocations()` and `validateLedger()`. Require consumption to reference the derived value before `mergeReceiptReference()` is eligible.

In the same task, make the v1 byte contract exactly match `canonicalApprovalDigest()`:

```text
program-c-merge-authorization-grant/v1 normative digest bytes:
- recursively sort every object key with the repository lexicographic comparator;
- preserve array order;
- serialize JSON primitives with JSON.stringify semantics;
- emit no whitespace and no trailing newline;
- hash the resulting UTF-8 bytes with SHA-256.
```

`grant_raw_sha256` is the SHA-256 of those normative canonical bytes. Do not call this schema-order rendering. It is not evidence that an independently governed service observed an external file; external raw-artifact provenance remains a separate hosted-admission HOLD.

- [ ] **Step 5: Run targeted and root GREEN suites**

```bash
node --test scripts/governance-approval-readback.spec.mjs scripts/governance-approval-readback-fix.spec.mjs
pnpm approval-readback:test
```

Expected: PASS; arbitrary and stale digests fail even when all declarations are synchronized.

- [ ] **Step 6: Commit the digest fix**

```bash
git add scripts/governance-approval-merge-authorization.mjs scripts/governance-approval-readback.spec.mjs scripts/governance-approval-readback-fix.spec.mjs docs/governance/trusted-approval-readback-spec.md
git commit -m "fix(governance): bind merge grant evidence digest"
```

---

### Task 3: Require current Legal clearance for every dual-role exception

**Files:**
- Create: `scripts/governance-approval-legal-policy.mjs`
- Modify: `scripts/governance-approval-role-evidence.mjs:123-262`
- Modify: `scripts/governance-approval-acceptance.mjs:146-170`
- Modify: `scripts/governance-approval-state.mjs:76-90,416-440`
- Modify: `scripts/fixtures/approval-readback/merge-authorization/task4-round4-state-fixture.mjs`
- Modify: `scripts/governance-approval-readback.spec.mjs`
- Modify: `scripts/governance-approval-state.spec.mjs`
- Test: `scripts/governance-approval-readback.spec.mjs`
- Test: `scripts/governance-approval-state.spec.mjs`

**Interfaces:**
- Consumes: decision ADR plus actor policy.
- Produces: `approvalLegalEvidenceRequired({ decisionAdr, actorPolicy })` and `approvalVerifiedLegalState(...)`, shared by role, acceptance, and state projection.

- [ ] **Step 1: Add the shared pure-policy contract and RED matrix**

Create the pure interface:

```js
const DUAL_ROLE = 'DUAL_ROLE_WITH_INDEPENDENT_COAPPROVER';

export const approvalLegalEvidenceRequired = ({ decisionAdr, actorPolicy }) => (
  decisionAdr === 'ADR-026' || actorPolicy === DUAL_ROLE
);

export const approvalVerifiedLegalState = (input) => (
  approvalLegalEvidenceRequired(input) ? 'NO_BLOCKER_RECORDED' : 'PENDING'
);
```

Add explicit cases:

```text
ordinary ADR-027 + Legal PENDING = PASS
ADR-027 dual-role + QA coapprover + Legal PENDING = FAIL
ADR-027 dual-role + QA coapprover + current Legal NO_BLOCKER = PASS
ADR-027 dual-role + Legal coapprover + Legal PENDING = FAIL
ADR-026 + Legal PENDING = FAIL
```

- [ ] **Step 2: Run the RED role and acceptance tests**

```bash
node --test --test-name-pattern='dual-role.*Legal|ordinary ADR-027' scripts/governance-approval-readback.spec.mjs scripts/governance-approval-state.spec.mjs
```

Expected: FAIL on the QA coapprover + Legal PENDING case.

- [ ] **Step 3: Replace both duplicated predicates**

Call the shared helper from `validateRoleEvidence()` and acceptance revalidation. The condition must not inspect `coapprover_role` when deciding whether Legal evidence is required. Continue to validate coapprover identity separately.

- [ ] **Step 4: Make state projection honest**

Add the closed `actorPolicy` and `dualRoleExceptionSha256` fields to the bound state policy snapshot. Validate `actorPolicy` as one of:

```js
new Set(['DISTINCT_ACTORS_REQUIRED', 'DUAL_ROLE_WITH_INDEPENDENT_COAPPROVER']);
```

For `DISTINCT_ACTORS_REQUIRED`, require `dualRoleExceptionSha256 === null`. For dual-role policy, require:

```js
dualRoleExceptionSha256 === canonicalApprovalDigest(candidate.policy.dual_role_exception)
```

Update every closed policy producer, including `task4-round4-state-fixture.mjs`, and add one-byte actor-policy/exception-digest drift tests.

At Acceptance, bind camelCase state facts back to the exact Task-3 policy:

```js
state.policySnapshot.actorPolicy === evidence.task3.candidate.policy.actor_policy
state.policySnapshot.dualRoleExceptionSha256 === (
  evidence.task3.candidate.policy.actor_policy === 'DUAL_ROLE_WITH_INDEPENDENT_COAPPROVER'
    ? canonicalApprovalDigest(evidence.task3.candidate.policy.dual_role_exception)
    : null
)
```

Reject a DUAL_ROLE state combined with DISTINCT_ACTORS Task-3 evidence, and the reverse, before Legal-state projection.

When a privileged verified receipt is replayed, derive `legalState` with `approvalVerifiedLegalState({ decisionAdr: state.decisionId, actorPolicy: policy.actorPolicy })`. Ordinary ADR-027 remains `PENDING`; ADR-026 and explicit dual-role become `NO_BLOCKER_RECORDED` only after their verified evidence path.

- [ ] **Step 5: Run all Legal and state GREEN tests**

```bash
node --test scripts/governance-approval-readback.spec.mjs scripts/governance-approval-state.spec.mjs
pnpm approval-readback:test
```

Expected: PASS without reintroducing a Legal requirement for ordinary ADR-027.

- [ ] **Step 6: Commit the Legal contract fix**

```bash
git add scripts/governance-approval-legal-policy.mjs scripts/governance-approval-role-evidence.mjs scripts/governance-approval-acceptance.mjs scripts/governance-approval-state.mjs scripts/fixtures/approval-readback/merge-authorization/task4-round4-state-fixture.mjs scripts/governance-approval-readback.spec.mjs scripts/governance-approval-state.spec.mjs
git commit -m "fix(governance): enforce legal clearance for dual role"
```

---

### Task 4: Extract testable pure kernels before closing public admission

**Files:**
- Create: `scripts/governance-approval-state-kernel.mjs`
- Create: `scripts/governance-approval-merge-reconciliation-kernel.mjs`
- Modify: `scripts/governance-approval-test-entry.spec.mjs`
- Modify: `scripts/governance-approval-state.mjs`
- Modify: `scripts/governance-approval-merge-orchestration.mjs`
- Modify: `scripts/fixtures/approval-readback/merge-authorization/task4-round4-state-fixture.mjs`
- Modify: `scripts/governance-approval-state.spec.mjs`
- Modify: `scripts/governance-approval-state-review.spec.mjs`
- Modify: `scripts/governance-approval-state-round4.spec.mjs`
- Modify: `scripts/governance-approval-state-round5.spec.mjs`

**Interfaces:**
- Produces: `planApprovalStateTransition(input)` returning `approval-state-transition-plan/v1`, never a schema-compatible admitted state.
- Produces: `planMergeAuthorizationReconciliation(input)` returning `merge-authorization-reconciliation-plan/v1`, never writing a ledger.
- Preserves: public behavior and all tests before Tasks 5 and 6 add capability guards.

- [ ] **Step 1: Add RED import and output-shape boundaries**

Extend the already-canonical `governance-approval-test-entry.spec.mjs`; it must fail until both kernels exist and the import allowlist is enforced:

```js
assert.deepEqual(kernelImporters('governance-approval-state-kernel.mjs'), [
  'scripts/governance-approval-state.mjs',
  ...declaredTestImporters,
]);
assert.deepEqual(kernelImporters('governance-approval-merge-reconciliation-kernel.mjs'), [
  'scripts/governance-approval-merge-orchestration.mjs',
  ...declaredTestImporters,
]);
assert.notEqual(statePlan.schemaVersion, 'approval-decision-state/v1');
assert.equal(Object.hasOwn(statePlan, 'eventHistory'), false);
assert.equal(Object.hasOwn(reconciliationPlan, 'ledger'), false);
```

- [ ] **Step 2: Extract the state transition kernel without behavior change**

Move the event-to-projection switch into:

```js
export const planApprovalStateTransition = ({
  currentProjection,
  event,
  policySnapshot,
  observedAt,
}) => deepFreeze({
  schemaVersion: 'approval-state-transition-plan/v1',
  nextProjection,
});
```

The kernel receives only already-closed values and owns no `WeakMap`, history activation, public append, receipt capability, status renderer, file/network reader, or durable writer. `governance-approval-state.mjs` remains the only module that converts a plan into a state carrying a privately bound `eventHistory`.

- [ ] **Step 3: Extract the reconciliation kernel without behavior change**

Move readback comparison, result-event construction, and consumption construction into:

```js
export const planMergeAuthorizationReconciliation = ({
  reservation,
  readback,
  streamFacts,
  observedAt,
}) => deepFreeze({
  schemaVersion: 'merge-authorization-reconciliation-plan/v1',
  outcome,
  blockingCode,
  resultEvent,
  consumption,
  consumptionRawSha256,
});
```

The kernel takes no ledger port and cannot perform CAS. Only `governance-approval-merge-orchestration.mjs` may apply a plan to the durable ledger.

- [ ] **Step 4: Split tests into public-wrapper and pure-kernel suites**

Keep existing public positive behavior temporarily GREEN in this refactor commit. Add direct pure-kernel coverage for VERIFIED/ACCEPTED/REVOKED/supersession projections and result/consumption/idempotency planning. Modify `task4-round4-state-fixture.mjs` to export a clearly named synthetic kernel-input builder, not a private history or capability.

- [ ] **Step 5: Enforce whole-fixture and kernel import boundaries**

The scanner permits `scripts/fixtures/approval-readback/**` only from `*.spec.*` and declared test-support modules. It permits each kernel only from its owning wrapper plus those test surfaces. It scans `scripts/`, `apps/`, `packages/`, workflow/release inputs, and CLI entrypoints.

Keep `package.json` unchanged. `governance-approval-test-entry.spec.mjs` is already in the exact ordered `approval-readback:test` list, so the executable boundary cannot be omitted without changing the existing canonical root contract.

- [ ] **Step 6: Run behavior-preserving GREEN suites**

```bash
pnpm approval-readback:test
```

Expected: all pre-guard public behavior remains green; pure kernels and import boundaries are independently covered.

- [ ] **Step 7: Commit the refactor only**

```bash
git add scripts/governance-approval-state-kernel.mjs scripts/governance-approval-merge-reconciliation-kernel.mjs scripts/governance-approval-state.mjs scripts/governance-approval-merge-orchestration.mjs scripts/fixtures/approval-readback/merge-authorization/task4-round4-state-fixture.mjs scripts/governance-approval-state.spec.mjs scripts/governance-approval-state-review.spec.mjs scripts/governance-approval-state-round4.spec.mjs scripts/governance-approval-state-round5.spec.mjs scripts/governance-approval-test-entry.spec.mjs
git commit -m "refactor(governance): separate approval admission kernels"
```

---

### Task 5: Prevent plain current-main readback from writing durable consumption

**Files:**
- Modify: `scripts/governance-approval-merge-orchestration.mjs`
- Modify: `scripts/governance-approval-state-review.spec.mjs`
- Modify: `scripts/governance-approval-state.spec.mjs`
- Test: `scripts/governance-approval-merge-reconciliation-kernel.mjs` through the existing root specs

**Interfaces:**
- Consumes: reservation, untrusted diagnostic readback, durable ledger, and time.
- Produces: public wrapper HOLD after diagnostic validation; pure kernel retains side-effect-free planning coverage and cannot write a ledger.

- [ ] **Step 1: Add the RED self-consistent synthetic-readback test**

```js
const fakeCapability = Object.freeze({ kind: 'caller-declared-admission' });
const result = await reconcileMergeAuthorizationReservation(
  fresh.reservation,
  structuredClone(readback),
  ledger,
  NOW,
  fakeCapability,
);
assert.equal(result.outcome, 'HOLD');
assert.equal(result.blockingCode, 'APPROVAL_CURRENT_MAIN_READBACK_REQUIRED');
const stream = await ledger.read(fresh.reservation.key);
assert.equal(stream.events.some(({ type }) => type === 'MERGE_RESULT_OBSERVED'), false);
assert.equal(stream.events.some(({ type }) => type === 'CONSUMPTION_RECORDED'), false);
```

Repeat with cloned and JSON-roundtripped fake capability.

- [ ] **Step 2: Run RED**

```bash
node --test --test-name-pattern='caller-owned current-main capability' scripts/governance-approval-state-review.spec.mjs scripts/governance-approval-state.spec.mjs
```

Expected: FAIL because the public wrapper currently applies the kernel plan to the ledger.

- [ ] **Step 3: Close public current-main admission in source**

Use this exact public wrapper order:

```text
read existing durable stream
→ run total diagnostic readback/kernel validation
→ malformed identity returns its specific APPROVAL_* HOLD
→ any other diagnostic failure returns its specific APPROVAL_* HOLD
→ structurally valid input returns APPROVAL_CURRENT_MAIN_READBACK_REQUIRED
→ public source does not apply result/consumption plans
```

Current source intentionally contains no local `WeakSet`, capability parameter,
mint, factory, test hook, environment/config switch, or fixture bridge. A
hosted issuer requires a separately governed change; absent that boundary,
fixtures and pure kernels cannot append `MERGE_RESULT_OBSERVED` or
`CONSUMPTION_RECORDED` through public reconciliation.

- [ ] **Step 4: Redirect positive semantic tests to the pure kernel**

Public wrapper cases now expect HOLD/no result/no consumption. Kernel cases continue to prove valid result/consumption planning, revocation, existing consumption, CAS-conflict inputs, and idempotency without a ledger side effect.

- [ ] **Step 5: Run GREEN**

```bash
node --test scripts/governance-approval-state-review.spec.mjs scripts/governance-approval-state.spec.mjs
pnpm approval-readback:test
```

- [ ] **Step 6: Commit**

```bash
git add scripts/governance-approval-merge-orchestration.mjs scripts/governance-approval-state-review.spec.mjs scripts/governance-approval-state.spec.mjs
git commit -m "fix(governance): require admitted current main readback"
```

---

### Task 6: Prevent plain receipt summaries from promoting approval state

**Files:**
- Modify: `scripts/governance-approval-state.mjs`
- Create: `scripts/fixtures/approval-readback/synthetic-verified-state.mjs`
- Modify: `scripts/fixtures/approval-readback/merge-authorization/task4-round4-state-fixture.mjs`
- Modify: `scripts/governance-approval-state.spec.mjs`
- Modify: `scripts/governance-approval-state-round4.spec.mjs`
- Modify: `scripts/governance-approval-state-round5.spec.mjs`

**Interfaces:**
- Consumes: public append and closed event.
- Produces: caller-owned receipt rejection with active parent preserved; pure kernel retains transition semantics without admission provenance.

- [ ] **Step 1: Add the RED public attack sequence**

Build `OWNER_ASSIGNMENT_REQUIRED -> PROPOSED -> AWAITING_PRODUCT_REVIEW -> AWAITING_PRIVACY_REVIEW` only through public APIs, then append a shape-valid caller-owned `RECEIPT_VERIFIED`. Expect `APPROVAL_INDEPENDENCE_NOT_PROVEN`, unchanged parent state, and a subsequent safe `HEAD_CHANGED` append to succeed from the same parent.

- [ ] **Step 2: Run RED**

```bash
node --test --test-name-pattern='caller-owned receipt capability|failed privileged append preserves parent' scripts/governance-approval-state.spec.mjs scripts/governance-approval-state-round5.spec.mjs
```

- [ ] **Step 3: Close public receipt admission in source**

After its existing append-shape and history diagnostics, public
`RECEIPT_VERIFIED` always returns `APPROVAL_INDEPENDENCE_NOT_PROVEN` before it
reaches the kernel. The rejected append preserves the active parent history;
there is no local `WeakSet`, capability parameter, mint, factory, test hook,
environment/config switch, or fixture bridge. A hosted issuer requires a
separately governed future boundary and is not represented by a local source
fallback.

- [ ] **Step 4: Keep synthetic state outside admission**

`buildSyntheticVerifiedApprovalStateForTests()` returns `{ synthetic: true, state }`. The state may be used only for pure acceptance/read-model tests and pure-kernel input. It has no private history binding and cannot be accepted by public append.

```js
const { state } = buildSyntheticVerifiedApprovalStateForTests();
for (const value of [state, JSON.parse(JSON.stringify(state))]) {
  assert.throws(
    () => appendApprovalDecisionEvent(value, append, policy, NOW, {}),
    /APPROVAL_STATE_APPEND_INVALID|APPROVAL_INDEPENDENCE_NOT_PROVEN/,
  );
}
```

- [ ] **Step 5: Redirect positive lifecycle tests to the pure kernel**

Kernel tests cover VERIFIED, ACCEPTED, REVOKED, superseded, Legal projection, and one-byte drift. Public-wrapper tests cover only actually admissible source states plus rejection of the privileged event.

- [ ] **Step 6: Run GREEN**

```bash
node --test scripts/governance-approval-state.spec.mjs scripts/governance-approval-state-round4.spec.mjs scripts/governance-approval-state-round5.spec.mjs
pnpm approval-readback:test
```

- [ ] **Step 7: Commit**

```bash
git add scripts/governance-approval-state.mjs scripts/fixtures/approval-readback/synthetic-verified-state.mjs scripts/fixtures/approval-readback/merge-authorization/task4-round4-state-fixture.mjs scripts/governance-approval-state.spec.mjs scripts/governance-approval-state-round4.spec.mjs scripts/governance-approval-state-round5.spec.mjs
git commit -m "fix(governance): require admitted receipt transition"
```

---

### Task 7: Close source-HOLD and documentation drift

**Files:**
- Modify: `docs/governance/trusted-approval-readback-spec.md`
- Modify: `docs/superpowers/plans/2026-08-31-trusted-approval-current-head-review-remediation.md`

**Interfaces:**
- Produces: one normative source-HOLD statement and exact fixture/kernel separation; no RuntimeEvidence or Release claim.

- [ ] **Step 1: Record the source-HOLD contract**

```text
Structural validation and pure-kernel planning are diagnostic only. Current
source has no hosted admission boundary. Until an independently governed hosted
boundary supplies a non-forgeable capability, public RECEIPT_VERIFIED append
returns APPROVAL_INDEPENDENCE_NOT_PROVEN and cannot enter VERIFIED; public
current-main reconciliation preserves its specific diagnostic APPROVAL_* HOLD
or returns APPROVAL_CURRENT_MAIN_READBACK_REQUIRED, and cannot append
MERGE_RESULT_OBSERVED / CONSUMPTION_RECORDED.
```

There is no local WeakSet/capability/mint parameter/factory/test/env/config/
fixture bridge. Pure kernel output is neither a state, receipt, admission,
ledger fact, nor external observation.

- [ ] **Step 2: Run root gates and unchanged Copy readback**

```bash
pnpm approval-readback:test
node --test scripts/copy-fixed-source-impact.spec.mjs
node scripts/copy-fixed-source-impact.mjs
pnpm docs:verify
pnpm governance:verify
```

`delivery-traceability.json` is not in this task because the current approval packet has no machine chain anchor there. If a verifier unexpectedly names it, stop and amend this plan instead of editing it ad hoc.

- [ ] **Step 3: Confirm Copy source identity did not move**

No task modifies any of the exact 11 Copy fixed-source paths, including `package.json`. The existing receipt must therefore read back unchanged as `STALE_HOLD / NOT_AUTHORIZED / BLOCKED`. If the fingerprint changes, stop as an unexpected scope expansion; do not write eligibility evidence.

- [ ] **Step 4: Commit the normative spec and plan**

```bash
git add docs/governance/trusted-approval-readback-spec.md docs/superpowers/plans/2026-08-31-trusted-approval-current-head-review-remediation.md
git commit -m "docs: record approval admission source holds"
```

---

### Task 8: Exact-candidate verification and independent review

**Files:**
- Verify: all files changed by Tasks 1-7
- Create locally ignored evidence packet: `.superpowers/sdd/2026-08-31-trusted-approval-current-head-review-remediation/`

**Interfaces:**
- Produces: exact-head local evidence and a separate external-update authorization card; no external write.

- [ ] **Step 1: Run canonical tests and exact coverage**

```bash
pnpm approval-readback:test
node --experimental-test-coverage \
  --test-coverage-include='scripts/governance-approval-*.mjs' \
  --test-coverage-include='scripts/governance-github-readback*.mjs' \
  --test-coverage-exclude='scripts/*.spec.mjs' \
  --test-coverage-exclude='scripts/fixtures/**' \
  --test-coverage-lines=80 \
  --test-coverage-branches=80 \
  --test-coverage-functions=80 \
  --test \
  scripts/governance-approval-schemas.spec.mjs \
  scripts/governance-approval-safe-json.spec.mjs \
  scripts/governance-approval-readback.spec.mjs \
  scripts/governance-approval-readback-fix.spec.mjs \
  scripts/governance-approval-identity-review.spec.mjs \
  scripts/governance-approval-state.spec.mjs \
  scripts/governance-approval-state-review.spec.mjs \
  scripts/governance-approval-state-round4.spec.mjs \
  scripts/governance-approval-state-round5.spec.mjs \
  scripts/governance-approval-status.spec.mjs \
  scripts/governance-github-readback.spec.mjs \
  scripts/governance-approval-attestation.spec.mjs \
  scripts/governance-approval-test-entry.spec.mjs
```

Expected: PASS with lines, branches, and functions each at least 80% and no production exclusion added to game the gate.

- [ ] **Step 2: Run structural and exact Copy readback gates**

```bash
pnpm docs:verify
pnpm governance:verify
node --test scripts/copy-fixed-source-impact.spec.mjs
node scripts/copy-fixed-source-impact.mjs
pnpm code-intelligence:scan
pnpm --filter @global/code-intelligence exec tsx src/cli.ts status --repo ../..
pnpm --filter @global/code-intelligence exec tsx src/cli.ts impact scripts/governance-approval-state.mjs scripts/governance-approval-state-kernel.mjs scripts/governance-approval-merge-orchestration.mjs scripts/governance-approval-merge-reconciliation-kernel.mjs scripts/governance-approval-role-evidence.mjs scripts/governance-approval-acceptance.mjs scripts/governance-approval-merge-authorization.mjs --repo ../..
```

Expected: zero docs/governance/graph error; Copy stays `STALE_HOLD / NOT_AUTHORIZED / BLOCKED`; static business impact may remain `UNKNOWN` and must be reported honestly.

- [ ] **Step 3: Obtain two independent exact-head reviews**

One reviewer replays all five counterexamples and verifies public HOLD plus pure-kernel side-effect freedom. A second security reviewer checks import boundaries, no mint/bypass, fixture non-admission, canonical grant binding, Legal cross-binding, and Copy evidence honesty.

- [ ] **Step 4: Build the exact external-update card and stop**

Record old remote head, new local head, exact path manifest/digest, tests, coverage, docs/governance, ContractGraph, Copy, independent reviews, and remaining external HOLDs. Stop for explicit user authorization before push. Thread replies/resolution and merge remain separate later authorizations.

---

## Self-Review

- Spec coverage: all five current-head review findings map to a GREEN task and a final independent review gate.
- Trust boundary: the plan deliberately provides no source mint for either privileged capability because the hosted independently governed boundary is absent.
- Testability: pure kernels return non-authoritative plans with no history binding or ledger port; public wrappers cannot create admitted state or durable side effects while hosted admission is absent.
- Fixture boundary: the whole `scripts/fixtures/approval-readback/**` root and both kernels have executable import allowlists, and serialized fixtures cannot regain provenance.
- Ordinary ADR-027 remains Legal-optional; only ADR-026 and explicit dual-role policy require current Legal clearance.
- Digest semantics: v1 grant raw digest uses the exact recursive lexicographic-key canonical JSON algorithm implemented by `canonicalApprovalDigest()`; independent observation of an external grant artifact remains a separate hosted-admission fact.
- Product boundary: no runtime, Provider, Site Builder, Buyer Intelligence, Opportunity, migration, deployment, or customer-billing code is touched.
- External boundary: no task infers push, thread, merge, RuntimeEvidence, Release, Pilot, or GA authorization.
