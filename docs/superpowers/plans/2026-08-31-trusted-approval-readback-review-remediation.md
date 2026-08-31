# Trusted Approval Readback Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all nine technically validated PR #430 review findings without inventing trusted external evidence, weakening fail-closed gates, mutating the live GitHub ruleset, or granting merge/runtime authority.

**Architecture:** Preserve the existing local-foundation boundary while removing every path that can mint or resurrect trust from caller-owned facts. Separate subject identities (PR head versus trusted `pull_request_target` execution base), make lifecycle terminals immutable per policy revision, make authority and ruleset contracts closed and internally satisfiable, and reject malformed merge authorization before the first durable ledger operation. The hosted verifier, real receipt issuance, ruleset mutation, thread replies, PR update, merge, runtime and release remain separate future/external gates.

**Tech Stack:** Node.js ESM, `node:test`, JSON Schema 2020-12, Ajv strict validation, deterministic safe JSON/canonical SHA-256, GitHub REST response normalization, immutable event reduction, CAS ledger ports, repository-native ContractGraph.

**Spec:** `docs/governance/trusted-approval-readback-spec.md`

## Global Constraints

- Exact starting head is `4c8ecb4640fb7d07d0066d1418b46092ccf5267a`; any remote-main or PR-head movement invalidates the existing integration review but does not justify rewriting history.
- Use one local writer in `/global/backend/.codex/worktrees/trusted-approval-readback-integration`; reviewers remain read-only.
- Every behavioral change follows RED → GREEN → refactor and preserves at least 80% line, branch and function coverage for the approval scope.
- No production function may issue `TRUSTED_BASE_VERIFIED` from caller-owned plain objects or synthetic/HOLD attestation output.
- `REJECTED` and `REVOKED` are terminal for one bound policy revision; replacement starts a new immutable revision and history root.
- Authority currentness keeps actor node ID, canonical login, finite interval, exact scope, assignment evidence, revocation and supersession checks.
- GitHub collector changes remain read-only and fail closed; they do not mutate `protect-main`.
- `pull_request_target` execution SHA is not the PR head SHA. Bind the PR subject, check suite, run, workflow and event-time trusted base as distinct facts.
- Pagination uses a closed relation set of `next`, `last`, `prev`, `first`; only `next` is followed.
- All merge-grant identity numbers must be JavaScript safe positive integers before any ledger read or CAS.
- Schema files and `scripts/governance-approval-schema-catalog.mjs` byte-exact mirrors change together.
- Existing real/external states remain `UNASSIGNED`, `NONE`, `ABSENT`, `EXTERNAL_UNVERIFIED`, `HOLD`, `DISABLED` or `NOT_AUTHORIZED` as applicable.
- No push, PR edit/comment/thread resolution, merge, deploy, provider call, paid call, credential change or ruleset mutation is part of this local remediation.

---

### Task 1: Make rejection and revocation terminal per policy revision

**Files:**
- Modify: `scripts/governance-approval-state.mjs:389-401`
- Test: `scripts/governance-approval-state.spec.mjs`
- Test: `scripts/governance-approval-state-round5.spec.mjs`

**Interfaces:**
- Consumes: `appendApprovalDecisionEvent(state, append, policy, now)` and the existing capability-bound event history.
- Produces: `AUTHORITIES_ASSIGNED` is accepted only from `OWNER_ASSIGNMENT_REQUIRED`; `REJECTED` and `REVOKED` histories cannot be reopened.

- [ ] **Step 1: Write the failing terminality tests**

Add behavior tests that construct real admitted state histories through the existing helpers and assert:

```js
assert.throws(
  () => appendApprovalDecisionEvent(rejected, authoritiesAssignedAppend, policy, NOW),
  (error) => error.message === 'APPROVAL_STATE_TRANSITION_INVALID',
);
assert.equal(rejected.state, 'REJECTED');

assert.throws(
  () => appendApprovalDecisionEvent(revoked, authoritiesAssignedAppend, policy, NOW),
  (error) => error.message === 'APPROVAL_STATE_TRANSITION_INVALID',
);
assert.equal(revoked.state, 'REVOKED');
assert.equal(revoked.revocationStatus, 'REVOKED');
```

Also assert the rejected append does not consume the original parent capability and does not clear retained receipt, grant, evidence or acceptance provenance.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test scripts/governance-approval-state.spec.mjs scripts/governance-approval-state-round5.spec.mjs
```

Expected: the new tests fail because `AUTHORITIES_ASSIGNED` currently accepts `REJECTED` and `REVOKED` and returns `PROPOSED`.

- [ ] **Step 3: Implement the minimal terminality rule**

Change the transition guard to accept only:

```js
state.state === 'OWNER_ASSIGNMENT_REQUIRED'
```

Do not add a same-history replacement event. A replacement revision uses `initializeApprovalDecisionState(newPolicy, now)`.

- [ ] **Step 4: Verify GREEN and refactor**

Re-run the two focused test files and confirm all existing anti-sibling/capability tests remain green.

- [ ] **Step 5: Commit locally**

```bash
git add scripts/governance-approval-state.mjs scripts/governance-approval-state.spec.mjs scripts/governance-approval-state-round5.spec.mjs
git commit -m "fix(governance): keep rejected approvals terminal"
```

### Task 2: Restrict accepted-policy revocation authority

**Files:**
- Modify: `docs/governance/trusted-approval-revocation.schema.json`
- Modify: `scripts/governance-approval-schema-catalog.mjs`
- Modify: `scripts/governance-approval-receipt-lifecycle.mjs`
- Modify: `scripts/governance-approval-state-revocation.mjs`
- Test: `scripts/governance-approval-schemas.spec.mjs`
- Test: `scripts/governance-approval-readback-fix.spec.mjs`
- Test: `scripts/governance-approval-state.spec.mjs`

**Interfaces:**
- Consumes: policy-revocation input and current authority registry/readback.
- Produces: only `OWN-PRODUCT`, `OWN-DATA-PRIVACY`, or `LEGAL-REVIEW` can revoke an accepted policy.

- [ ] **Step 1: Write the failing role-boundary tests**

For `OWN-QA-EVIDENCE`, `OWN-SECURITY`, and `MERGE-AUTHORIZER`, assert both schema rejection and state-transition rejection from a real `ACCEPTED` state. Keep positive tests for Product, Privacy and Legal.

```js
for (const role of ['OWN-QA-EVIDENCE', 'OWN-SECURITY', 'MERGE-AUTHORIZER']) {
  const value = validRevocation();
  value.revoking_role = role;
  assert.equal(validateTrustedApprovalRevocation(value).valid, false);
}
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test scripts/governance-approval-schemas.spec.mjs scripts/governance-approval-readback-fix.spec.mjs scripts/governance-approval-state.spec.mjs
```

Expected: non-policy roles are currently accepted.

- [ ] **Step 3: Close schema and runtime allowlists**

Use the exact allowlist:

```js
['OWN-PRODUCT', 'OWN-DATA-PRIVACY', 'LEGAL-REVIEW']
```

Update the JSON Schema and its exact catalog mirror in the same edit. Keep any future Security incident stop out of this policy-revocation object.

- [ ] **Step 4: Verify GREEN**

Re-run the three focused files and `node --test scripts/governance-approval-test-entry.spec.mjs`.

- [ ] **Step 5: Commit locally**

```bash
git add docs/governance/trusted-approval-revocation.schema.json scripts/governance-approval-schema-catalog.mjs scripts/governance-approval-receipt-lifecycle.mjs scripts/governance-approval-state-revocation.mjs scripts/governance-approval-schemas.spec.mjs scripts/governance-approval-readback-fix.spec.mjs scripts/governance-approval-state.spec.mjs
git commit -m "fix(governance): restrict policy revocation authority"
```

### Task 3: Remove caller-owned trusted receipt issuance

**Files:**
- Modify: `scripts/governance-approval-readback.mjs`
- Modify: `scripts/governance-approval-readback.spec.mjs`
- Modify: `scripts/governance-approval-readback-fix.spec.mjs`
- Modify: `scripts/governance-approval-attestation.spec.mjs`
- Modify: `scripts/fixtures/approval-readback/README.md`

**Interfaces:**
- Consumes: local candidate validation and synthetic attestation result.
- Produces: local validation remains available, but no public local path can mint a `TRUSTED_BASE_VERIFIED` core. Future issuance must consume a module-private capability from a real hosted verifier/admission adapter.

- [ ] **Step 1: Write the failing forged-verifier test**

Using the existing valid candidate fixture and a deep-cloned matching verifier, assert that no trust-bearing receipt can be issued:

```js
const value = candidate();
assert.equal(validateApprovalReadback(value, authority(), value.policy, NOW).valid, true);
assert.throws(
  () => buildApprovalReceiptCore(value, authority(), structuredClone(value.verifier), null, NOW),
  (error) => error.message === 'APPROVAL_INDEPENDENCE_NOT_PROVEN',
);
```

Add a companion assertion that the current `verifyApprovalAttestation` result remains `trustEligible: false` and cannot be supplied as an issuance capability.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test scripts/governance-approval-readback.spec.mjs scripts/governance-approval-readback-fix.spec.mjs scripts/governance-approval-attestation.spec.mjs
```

Expected: the forged matching verifier currently produces `TRUSTED_BASE_VERIFIED`.

- [ ] **Step 3: Implement fail-closed local issuance**

Keep `validateApprovalReadback` as a local contract validator. Make the current exported local builder reject with `APPROVAL_INDEPENDENCE_NOT_PROVEN` unless it receives a module-private capability that no current local/HOLD path can mint. Do not add a public factory that brands caller-owned plain objects. Schema/render tests may validate hand-built fixture envelopes via the raw deterministic renderer; they must not claim issuance provenance.

- [ ] **Step 4: Verify GREEN and fixture honesty**

Re-run the focused files. Confirm no test describes a synthetic fixture as externally verified or trust-eligible.

- [ ] **Step 5: Commit locally**

```bash
git add scripts/governance-approval-readback.mjs scripts/governance-approval-readback.spec.mjs scripts/governance-approval-readback-fix.spec.mjs scripts/governance-approval-attestation.spec.mjs scripts/fixtures/approval-readback/README.md
git commit -m "fix(governance): block synthetic trusted receipt issuance"
```

### Task 4: Make assigned authority schema satisfiable and closed

**Files:**
- Modify: `docs/governance/approval-authorities.schema.json`
- Modify: `scripts/governance-approval-schema-catalog.mjs`
- Modify: `scripts/governance-approval-schemas.spec.mjs`
- Modify: `scripts/governance-approval-schemas.spec.mjs` assigned-authority fixture builder; no separate assigned-authority JSON fixture exists at the exact starting head.

**Interfaces:**
- Consumes: `authorityIsCurrent(authority, scope, instant)`.
- Produces: a closed `ASSIGNED` schema whose valid instances can satisfy currentness; `UNASSIGNED` rejects assignment-only fields.

- [ ] **Step 1: Write the failing schema/runtime intersection tests**

Add one complete assigned authority literal containing:

```js
{
  role: 'OWN-PRODUCT',
  status: 'ASSIGNED',
  actor_id: 101,
  actor_node_id: 'MDQ6VXNlcjEwMQ==',
  actor_login: 'product-owner',
  effective_from: '2026-08-30T00:00:00.000Z',
  effective_until: '2026-09-30T00:00:00.000Z',
  scope: {
    repository_id: 1291151138,
    decision_adr: 'ADR-027',
    policy_revision: 'program-c/policy-r1',
    purpose: 'PRODUCT_REVIEW'
  },
  assignment_evidence: {
    kind: 'GITHUB_REPOSITORY_ROLE_ASSIGNMENT',
    evidence_id: 'authority-assignment-product-0001',
    observed_at: '2026-08-30T00:00:00.000Z'
  },
  revocation_status: 'ACTIVE',
  superseded_by: null
}
```

Assert schema validity and `authorityIsCurrent(...) === true`; assert actor-id-only assignment is invalid and each missing safety field is invalid.

- [ ] **Step 2: Verify RED**

Run `node --test scripts/governance-approval-schemas.spec.mjs` and confirm the full shape is rejected as additional properties while the actor-id-only shape is accepted.

- [ ] **Step 3: Implement the closed discriminated schema**

Extend only the `ASSIGNED` branch with all currentness and evidence fields. Keep `additionalProperties: false`; keep `UNASSIGNED` free of assignment fields. Update the schema catalog mirror.

- [ ] **Step 4: Verify GREEN**

Run schema, readback and identity-review tests; verify canonical authority digest tests are updated rather than bypassed.

- [ ] **Step 5: Commit locally**

```bash
git add docs/governance/approval-authorities.schema.json scripts/governance-approval-schema-catalog.mjs scripts/governance-approval-schemas.spec.mjs scripts/fixtures/approval-readback
git commit -m "fix(governance): close assigned authority contract"
```

### Task 5: Bind `pull_request_target` runs to their real execution identity

**Files:**
- Modify: `scripts/governance-github-readback.mjs:123-143`
- Modify: `scripts/governance-github-readback-normalizers.mjs:245-270`
- Modify: `scripts/governance-github-readback-common.mjs`
- Test: `scripts/governance-github-readback.spec.mjs`
- Test: `scripts/governance-github-readback-evidence.spec.mjs`
- Test: `scripts/governance-github-readback-round1.spec.mjs`

**Interfaces:**
- Consumes: PR head/base identities, check suite ID, Actions run event/workflow/app facts and trusted-base workflow blob.
- Produces: exact PR subject stays bound to PR head, while the `pull_request_target` run is associated through check suite/PR/workflow and bound to its event-time trusted base SHA.

- [ ] **Step 1: Write the failing platform-semantics test**

Set fixture identities so `PR_HEAD_SHA !== EVENT_BASE_SHA`. The matching run uses `head_sha: EVENT_BASE_SHA`, the exact check-suite association, `event: 'pull_request_target'`, the expected workflow and success conclusion. Assert normalization succeeds. Add negative variants for wrong check suite, wrong workflow, wrong event-time base and wrong PR association.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test scripts/governance-github-readback.spec.mjs scripts/governance-github-readback-evidence.spec.mjs scripts/governance-github-readback-round1.spec.mjs
```

Expected: the valid real-platform tuple fails because the collector filters and compares the run against the PR head SHA.

- [ ] **Step 3: Implement identity separation**

Remove `head_sha=request.expectedHeadSha` from the repository workflow-runs query. Associate a run with the already verified check suite and PR; preserve exact `event`, workflow ID/path, GitHub Actions App, attempt, conclusion and trusted-base workflow blob checks. Add an explicit event-time execution SHA field instead of reusing `expectedHeadSha`.

- [ ] **Step 4: Verify GREEN and no trust widening**

Run the three focused files. Confirm a random successful `pull_request_target` run cannot satisfy the tuple.

- [ ] **Step 5: Commit locally**

```bash
git add scripts/governance-github-readback.mjs scripts/governance-github-readback-normalizers.mjs scripts/governance-github-readback-common.mjs scripts/governance-github-readback.spec.mjs scripts/governance-github-readback-evidence.spec.mjs scripts/governance-github-readback-round1.spec.mjs
git commit -m "fix(governance): separate trusted run and pr head identity"
```

### Task 6: Accept standard GitHub backward pagination relations safely

**Files:**
- Modify: `scripts/governance-github-readback-rest.mjs:203-225`
- Test: `scripts/governance-github-readback-round2.spec.mjs`

**Interfaces:**
- Consumes: GitHub REST `Link` header.
- Produces: a closed parser for `next`, `last`, `prev`, `first`; only `next` drives pagination.

- [ ] **Step 1: Replace the incorrect tests with real behavior tests**

Use a later-page header containing `prev`, `next`, `last`, and `first`. Assert parsing succeeds and returns only the canonical next URL for traversal. Add duplicate relation, wrong page direction, cross-origin, fragment and unknown-relation failures.

- [ ] **Step 2: Verify RED**

Run `node --test scripts/governance-github-readback-round2.spec.mjs` and confirm standard `prev/first` currently produce `APPROVAL_GITHUB_PAGINATION_INVALID`.

- [ ] **Step 3: Implement the closed four-relation parser**

Accept exactly `next|last|prev|first`, validate each URL through the existing origin/path/query guards, prohibit duplicates, validate direction when present, and follow only `next`.

- [ ] **Step 4: Verify GREEN**

Re-run round2 and the main GitHub readback tests.

- [ ] **Step 5: Commit locally**

```bash
git add scripts/governance-github-readback-rest.mjs scripts/governance-github-readback-round2.spec.mjs
git commit -m "fix(governance): accept canonical github pagination links"
```

### Task 7: Make Legal evidence decision- and scope-aware

**Files:**
- Modify: `scripts/governance-approval-role-evidence.mjs:123-160,306-315`
- Test: `scripts/governance-approval-readback.spec.mjs`
- Test: `scripts/governance-approval-readback-fix.spec.mjs`

**Interfaces:**
- Consumes: exact decision ADR and separately approved policy scope.
- Produces: ADR-026 keeps the Legal gate; ADR-027 is not blocked by ADR-026 Legal PENDING unless a closed, exact policy-scope contract explicitly enables it.

- [ ] **Step 1: Write the failing decision-specific tests**

Assert ADR-027 with Legal `PENDING` and QA dual-role coapproval passes the Legal axis when all ADR-027-required evidence is valid. Assert ADR-026 with Legal `PENDING`, expired or revoked evidence still fails with `APPROVAL_LEGAL_INPUT_REQUIRED`.

- [ ] **Step 2: Verify RED**

Run the two focused test files and confirm ADR-027 currently fails because both the top-level and dual-role paths consume `legal_input` unconditionally.

- [ ] **Step 3: Implement one closed Legal requirement predicate**

Centralize the decision/scope rule and use it from both `validateRoleEvidence` and dual-role validation. Do not rewrite `PENDING` into `NO_BLOCKER_RECORDED`; simply do not consume the ADR-026 axis for current ADR-027 policy.

- [ ] **Step 4: Verify GREEN**

Re-run focused tests and all role-evidence mutations.

- [ ] **Step 5: Commit locally**

```bash
git add scripts/governance-approval-role-evidence.mjs scripts/governance-approval-readback.spec.mjs scripts/governance-approval-readback-fix.spec.mjs
git commit -m "fix(governance): scope legal approval by decision"
```

### Task 8: Normalize the complete live ruleset contract

**Files:**
- Modify: `scripts/governance-github-readback-normalizers.mjs:315-365`
- Modify: `scripts/governance-github-readback-common.mjs`
- Modify: `scripts/fixtures/approval-readback/task5-github-readback-fixture.mjs`
- Test: `scripts/governance-github-readback.spec.mjs`
- Test: `scripts/governance-github-readback-evidence.spec.mjs`
- Test: `scripts/governance-github-readback-round3.spec.mjs`

**Interfaces:**
- Consumes: live `protect-main` ruleset response and approved policy baseline.
- Produces: canonical digest and enforcement comparison covering status checks, pull-request parameters, deletion, non-fast-forward and bypass facts.

- [ ] **Step 1: Write failing drift tests**

Starting from a complete literal ruleset, independently remove or flip each of:

```text
required_approving_review_count
require_code_owner_review
dismiss_stale_reviews_on_push
require_last_push_approval
required_review_thread_resolution
deletion
non_fast_forward
```

Assert the normalized digest changes and enforcement mode returns the stable ruleset mismatch code. Keep review-slot validation separate from ruleset-enforcement validation.

- [ ] **Step 2: Verify RED**

Run the three focused files and confirm the current normalizer accepts a ruleset containing only `required_status_checks`.

- [ ] **Step 3: Implement closed ruleset facts**

Require exactly one `required_status_checks`, exactly one `pull_request`, one `deletion`, and one `non_fast_forward` rule. Normalize all documented pull-request parameters and include them in `normalized_sha256`. Compare against an explicit observed baseline/desired admission profile without mutating GitHub.

- [ ] **Step 4: Verify GREEN and live-fact honesty**

Re-run focused tests. The repository's current real values `required_approving_review_count=0`, `require_code_owner_review=false`, and `require_last_push_approval=false` must be represented honestly, not silently rewritten to future desired values.

- [ ] **Step 5: Commit locally**

```bash
git add scripts/governance-github-readback-normalizers.mjs scripts/governance-github-readback-common.mjs scripts/fixtures/approval-readback scripts/governance-github-readback.spec.mjs scripts/governance-github-readback-evidence.spec.mjs scripts/governance-github-readback-round3.spec.mjs
git commit -m "fix(governance): bind complete github ruleset facts"
```

### Task 9: Reject unsafe PR numbers before ledger access

**Files:**
- Modify: `docs/governance/program-c-merge-authorization-grant.schema.json`
- Modify: `docs/governance/program-c-merge-authorization-consumption.schema.json`
- Modify: `docs/governance/trusted-approval-readback.schema.json`
- Modify: `scripts/governance-approval-schema-catalog.mjs`
- Modify: `scripts/governance-approval-merge-orchestration.mjs:126-175`
- Test: `scripts/governance-approval-schemas.spec.mjs`
- Test: `scripts/governance-approval-state-review.spec.mjs`

**Interfaces:**
- Consumes: merge grant, merge request and CAS ledger port.
- Produces: unsafe PR numbers fail before `ledger.read` and `ledger.compareAndSwap`; `Number.MAX_SAFE_INTEGER` remains valid.

- [ ] **Step 1: Write the failing zero-side-effect tests**

```js
const unsafe = clone(validGrant);
unsafe.pr_number = Number.MAX_SAFE_INTEGER + 1;
assert.equal(validateProgramCMergeAuthorizationGrant(unsafe).valid, false);
await assert.rejects(
  reserveMergeAuthorizationNonce(unsafe, digest(unsafe), requestFor(unsafe), 0, recordingLedger, NOW),
  /APPROVAL_MERGE_AUTHORIZATION_GRANT_DIGEST_MISMATCH|APPROVAL_JSON_NUMBER/,
);
assert.equal(recordingLedger.readCalls, 0);
assert.equal(recordingLedger.casCalls, 0);
```

Add a `Number.MAX_SAFE_INTEGER` positive boundary.

- [ ] **Step 2: Verify RED**

Run the two focused test files and confirm schema accepts the unsafe number and the ledger records one `NONCE_RESERVED` before failing.

- [ ] **Step 3: Add schema and pre-I/O defense**

Set `maximum: 9007199254740991` on every PR-number contract and mirror. Add `Number.isSafeInteger` checks for both grant and request in `validateGrantAndRequest` before the first ledger call.

- [ ] **Step 4: Verify GREEN**

Re-run focused tests and the safe-JSON tests; assert zero ledger calls for all invalid identity inputs.

- [ ] **Step 5: Commit locally**

```bash
git add docs/governance/program-c-merge-authorization-grant.schema.json docs/governance/program-c-merge-authorization-consumption.schema.json docs/governance/trusted-approval-readback.schema.json scripts/governance-approval-schema-catalog.mjs scripts/governance-approval-merge-orchestration.mjs scripts/governance-approval-schemas.spec.mjs scripts/governance-approval-state-review.spec.mjs
git commit -m "fix(governance): reject unsafe merge pr identity before cas"
```

### Task 10: Full remediation verification and new exact candidate

**Files:**
- Modify: `docs/superpowers/plans/2026-08-31-trusted-approval-readback-review-remediation.md` only to check completed boxes and record exact command results.
- Modify: Copy derived evidence files only if the repository generator reports fingerprint drift; regenerate, never hand-edit authorization state.

**Interfaces:**
- Consumes: Tasks 1-9 local commits.
- Produces: one clean local candidate ready for independent review and a separate push/PR-update authorization decision.

- [ ] **Step 1: Run the complete approval scope**

```bash
pnpm approval-readback:test
node --test scripts/governance-github-readback-evidence.spec.mjs scripts/governance-github-readback-round1.spec.mjs scripts/governance-github-readback-round2.spec.mjs scripts/governance-github-readback-round3.spec.mjs
```

- [ ] **Step 2: Run coverage at unchanged thresholds**

Run the exact approval test list under Node coverage with 80% thresholds for lines, branches and functions. Do not exclude production source to pass.

- [ ] **Step 3: Run static and governance gates**

```bash
pnpm --filter @global/code-intelligence test
pnpm --filter @global/code-intelligence build
pnpm docs:verify
node --test scripts/copy-fixed-source-impact.spec.mjs
node scripts/copy-fixed-source-impact.mjs
git diff --check 4c8ecb4640fb7d07d0066d1418b46092ccf5267a..HEAD
```

- [ ] **Step 4: Rebuild exact ContractGraph**

```bash
pnpm code-intelligence:scan
pnpm --filter @global/code-intelligence exec tsx src/cli.ts status --repo ../..
```

Require exact new commit, `dirty=false`, no freshness findings and zero errors. Record `UNKNOWN` impact honestly.

- [ ] **Step 5: Independent reviews**

Assign one correctness/security reviewer and one integration-delta reviewer. Neither may edit. Require 0 Critical/High/Medium before any push decision.

- [ ] **Step 6: Stop at the external-action gate**

Prepare an exact run card containing old PR head, new local head, commits, changed paths, tests, review findings addressed, Copy state and rollback. Do not push, edit PR #430, reply to or resolve threads, merge or deploy without a new explicit authorization.

## Plan Self-Review

- Spec coverage: all nine validated findings map one-to-one to Tasks 1-9; Task 10 covers integration, evidence and authorization separation.
- Placeholder scan: no `TBD`, `TODO`, implicit “add tests”, or undefined external action remains.
- Type consistency: PR subject SHA, event-time trusted base SHA, check-suite identity, authority assignment, policy revision and PR-number identity remain separate across tasks.
- Gate consistency: local success cannot upgrade external verifier, receipt, RuntimeEvidence, Release, UAT, Pilot, GA, Copy dispatch or merge authorization.
- Execution choice: the user's continuing instruction selects inline, single-writer execution in this task; subagents are limited to read-only verification and later independent review.

## Local Execution Record

Exact pre-remediation PR head: `4c8ecb4640fb7d07d0066d1418b46092ccf5267a`.

Completed local commits:

1. `c19b5d18` — rejected/revoked policy revisions remain terminal.
2. `6b973999` — accepted-policy revocation is limited to Product/Privacy/Legal.
3. `91621fa6` — caller-owned verifier facts cannot issue trusted receipt cores.
4. `330d69ba` — assigned authority schema and runtime currentness share one closed contract.
5. `efa3096e` — `pull_request_target` execution identity is separated from PR head identity.
6. `344693fe` — standard GitHub `prev`/`first` pagination relations are validated safely.
7. `b73e93c7` — Legal evidence is decision/scope-aware.
8. `7065f2df` — complete live ruleset facts enter policy comparison and canonical digest.
9. `4062a8a2` — unsafe PR identity is rejected before ledger read/CAS.
10. `328fb26c` — machine-policy and acceptance consumers bind trusted run execution to PR base.
11. `adbcaf67` — ContractGraph approval schema digests match the forward schema revisions.
12. `262cb7be` — ADR-027 Acceptance/reducer/status preserve optional Legal `PENDING` and do not require Legal assignment.
13. `2f01df11` — ContractGraph accepts complete ASSIGNED/mixed registries and projects only redacted assignment state.

Fresh local verification on exact `adbcaf6734e805eff7b7a80645320db261c084f6` before this execution-record commit:

- Approval root plus extended GitHub suites: PASS.
- Node coverage: lines `97.53%`, branches `93.37%`, functions `98.01%`; unchanged 80% thresholds.
- Changed-file ESLint: PASS.
- Code Intelligence: `56/56` tests PASS; TypeScript build PASS.
- `pnpm docs:verify`: PASS; `0` errors and one pre-existing `TABLE_COLUMNS` warning at `docs/site-builder/12-site-builder-design-intelligence-and-cc-implementation-v3.2.md:1549`.
- Governance: `136/136` PASS.
- Copy fixed-source: `12/12` PASS; exact 11-path `STALE_HOLD / NOT_AUTHORIZED / BLOCKED` remains unchanged.
- ContractGraph: exact commit, clean, fresh, `11,476` nodes, `26,175` edges, `0` errors; business impact remains `UNKNOWN`.
- RuntimeEvidence, Release Bundle, actual trusted receipt, independent external verifier, UAT, Pilot and GA remain absent/HOLD and were not upgraded.

First independent integration-delta review returned `HOLD_EXACT_BASE` with two
Medium consumer gaps: ADR-027 Legal semantics had not reached Acceptance/state,
and ContractGraph rejected the new valid ASSIGNED registry. Commits `262cb7be`
and `2f01df11` close those findings with end-to-end and privacy-redaction tests.
The security review's assignment-provenance observation was subsequently
classified as `KNOWN_EXTERNAL_HOLD / TRUSTED_RUNTIME_ADMISSION`, not a current
source defect: the tracked registry remains all `UNASSIGNED`, no trusted
issuance capability can be minted locally, and the missing hosted provenance
must not be fabricated in this PR.

Pending before any external update:

- Independent security/correctness review of all nine remediations.
- Independent exact-base integration-delta review.
- A separate user authorization for push/PR update/thread replies. Merge and deploy remain separately unauthorized.
