# Trusted Approval Current-Head Review Round 3 Remediation Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Resolve the four current-head Hosted Review findings on PR #430 without weakening approval, provenance, release, or external-action gates, and produce a locally verified Round 3 candidate that stops before push.

**Architecture:** Preserve the current trusted-approval pipeline and make four bounded corrections: bind the canonical Markdown proposal sidecar by its raw UTF-8 bytes, require authority assignments to be current for each hosted review, make expiry equality fail consistently, and express ADR-027 Legal review as a conditional ContractGraph edge. The hosted collector remains evidence collection only; it must not convert local/synthetic evidence into admission, merge authorization, runtime evidence, or release authorization.

**Tech Stack:** Node.js ESM and `node:test`, JSON Schema, TypeScript/tsx, ContractGraph, GitHub REST readback fixtures, pnpm governance and documentation gates.

---

## 0. Execution contract

- **Card:** `APPROVAL-R3-001`
- **Program / Gate:** Trusted approval readback / G1–G3 local remediation
- **Owner:** Codex single writer in this worktree
- **Worktree:** `/global/backend/.codex/worktrees/trusted-approval-readback-integration`
- **Branch:** `codex/trusted-approval-readback-integration`
- **Exact base:** `8f5be1abd867ee74bb4af64c6bab2a6c1b169def`
- **Expected local head:** one or more conventional commits strictly descended from the exact base
- **External actions:** `NONE` — no push, PR comment, thread resolution, merge, deploy, paid call, provider call, credential change, or retained-runtime mutation
- **Authority boundary:** do not manufacture a current authority assignment, GitHub receipt, external provenance verification, merge authorization, RuntimeEvidence, Release Bundle, Pilot authorization, or GA authorization
- **Data boundary:** fixtures only; no real personal data, secrets, provider payloads, or raw authority exports
- **Non-goals:** Program A/B/C implementation, GrowthOS changes, provider execution, runtime recovery, Site Builder dispatch, release promotion, and PR merge
- **Stop conditions:** unexpected writer overlap; base/head drift; applied migration requirement; secret/PII exposure; a fix requiring product-policy weakening; external action; or a failing gate outside the owned diff that cannot be causally classified
- **Review:** implementation writer may not self-certify; require independent correctness and security/governance review before declaring the local candidate ready

## 1. Timebox and dependency order

| Task | Estimate | Depends on | Exit signal |
|---|---:|---|---|
| Task 1 — Proposal manifest schema and normative fixture | 2–3 h | exact base | schema and fixture RED/GREEN |
| Task 2 — Raw Markdown sidecar collector binding | 2–4 h | Task 1 | byte drift and newline drift fail closed |
| Task 3 — Hosted authority currentness | 1.5–2.5 h | Task 2 collector shape | invalid interval/scope/revocation/supersession fail closed |
| Task 4 — Expiry equality consistency | 0.5–1 h | none | equality emits consumption mismatch |
| Task 5 — Conditional Legal ContractGraph edge | 1–1.5 h | none | conditional edge present; ordinary ADR-027 remains Legal-optional |
| Task 6 — Integration, docs, evidence and independent review | 1–2 h | Tasks 1–5 | all local gates pass; external actions remain HOLD |

**Planning range:** 8–14 hours of effective local engineering time. A later, separately authorized push plus Hosted CI/review is expected to take 30–90 minutes per pass, but is outside this card.

## Task 1: Define the proposal manifest and trusted renderer policy contracts

**Files:**

- Create: `docs/governance/approval-proposal-manifest.schema.json`
- Modify: `scripts/governance-approval-schema-catalog.mjs`
- Modify: `scripts/governance-approval-schema-validator.mjs`
- Modify: `scripts/governance-approval-schemas.spec.mjs`
- Modify: `scripts/governance-github-readback-common.mjs`
- Modify: `scripts/fixtures/approval-readback/task5-github-readback-fixture.mjs`
- Test: `scripts/governance-github-readback.spec.mjs`
- Modify: `docs/governance/trusted-approval-readback-spec.md`

### Step 1: Write schema-only and policy-snapshot RED tests

- Require a proposal manifest with exactly these binding fields:

```json
{
  "schema_version": "approval-proposal-manifest/v1",
  "decision_id": "ADR-027",
  "policy_revision": "program-c/policy-r2",
  "decision_raw_sha256": "<sha256>",
  "decision_semantic_sha256": "<sha256>",
  "renderer_schema_version": "approval-sidecar-renderer/v1",
  "renderer_source_sha256": "<sha256>",
  "proposed_sidecar_path": "docs/governance/decisions/adr-027-r2.md",
  "proposed_sidecar_byte_length": 123,
  "proposed_sidecar_raw_sha256": "<sha256>"
}
```

- Preserve `decision_id`, `policy_revision`, and `decision_raw_sha256` as explicit required identity fields in addition to the manifest fields already listed in the written specification. Update the specification to state that each must equal the trusted request identity; do not loosen `program-c/policy-rN`.
- Reject unknown keys, missing renderer identity, non-canonical SHA-256 values, non-positive byte length, an absolute path, path traversal, and a non-Markdown sidecar path.
- Add a test proving the schema catalog and synthetic schema inspector know `approval-proposal-manifest/v1`.
- Extend the trusted hosted-readback policy with an exact closed tuple:

```js
proposalRenderer: {
  schemaVersion: 'approval-sidecar-renderer/v1',
  sourceSha256: 'sha256:<64 lowercase hex>',
}
```

- Require both tuple fields, reject unknown/partial fields, and prove `snapshotGitHubReadbackInputs()` copies and deep-freezes them before the first remote read.
- Update only the fixture policy tuple in this task. Keep the active JSON sidecar fixture unchanged until Task 2 so Task 1 has an independently green boundary.

Run:

```bash
node --test scripts/governance-approval-schemas.spec.mjs scripts/governance-github-readback.spec.mjs
```

Expected: FAIL because the manifest schema/catalog and trusted renderer policy tuple are absent.

### Step 2: Implement the minimal schema and catalog registration

- Export a dedicated `validateApprovalProposalManifest(value)` from the approval schema validator.
- Keep the schema fail-closed with `additionalProperties: false`.
- Reuse existing canonical instant/hash/path formats where available instead of creating a second validator dialect.
- Add `proposalRenderer` to the exact policy key set, validation and immutable snapshot path.
- Keep renderer identity policy-controlled; a PR-head manifest declaration alone is never treated as verified renderer identity.
- Do not change the active proposal sidecar bytes or collector reader in this task.

Run the same focused tests and confirm GREEN.

### Step 3: Refactor and commit

```bash
git diff --check
git diff -- docs/governance/approval-proposal-manifest.schema.json docs/governance/trusted-approval-readback-spec.md scripts/governance-approval-schema-catalog.mjs scripts/governance-approval-schema-validator.mjs scripts/governance-approval-schemas.spec.mjs scripts/governance-github-readback-common.mjs scripts/fixtures/approval-readback/task5-github-readback-fixture.mjs scripts/governance-github-readback.spec.mjs
git add docs/governance/approval-proposal-manifest.schema.json docs/governance/trusted-approval-readback-spec.md scripts/governance-approval-schema-catalog.mjs scripts/governance-approval-schema-validator.mjs scripts/governance-approval-schemas.spec.mjs scripts/governance-github-readback-common.mjs scripts/fixtures/approval-readback/task5-github-readback-fixture.mjs scripts/governance-github-readback.spec.mjs
git commit -m "fix: define approval proposal manifest contract"
```

## Task 2: Bind the hosted proposal subject to the raw UTF-8 Markdown sidecar

**Files:**

- Modify: `scripts/governance-github-readback-git.mjs`
- Modify: `scripts/governance-github-readback.mjs`
- Modify: `scripts/governance-github-readback.spec.mjs`
- Modify: `scripts/governance-github-readback-evidence.spec.mjs`
- Modify: `scripts/governance-github-readback-round1.spec.mjs`
- Modify: `scripts/fixtures/approval-readback/task5-github-readback-fixture.mjs`

### Step 1: Add byte-level negative tests

Add table-driven tests showing that collection fails for:

- one changed UTF-8 byte;
- one inserted space;
- CRLF instead of LF;
- no terminal newline;
- two terminal newlines;
- manifest byte-length mismatch;
- manifest raw-digest mismatch;
- renderer schema/source mismatch;
- manifest decision ID drift;
- manifest policy revision drift;
- manifest decision raw digest drift;
- manifest decision semantic digest drift;
- manifest sidecar path drift from the request allowlist;
- invalid UTF-8;
- Git LFS pointer or oversized blob.

Also retain a positive case for a canonical Markdown buffer. In this task, replace the active fixture `.sidecar.json` with a `.md` path and exact raw bytes, update the Round 1 JSON-extra-key test so it mutates the manifest only, and calculate manifest byte length/raw digest from the exact `Buffer` served by the mock GitHub blob response.

Run:

```bash
node --test scripts/governance-github-readback.spec.mjs scripts/governance-github-readback-evidence.spec.mjs scripts/governance-github-readback-round1.spec.mjs
```

Expected: FAIL because `readJsonFile()` attempts to parse the Markdown sidecar as JSON and no raw-byte binding exists.

### Step 2: Implement a raw UTF-8 blob reader

Introduce an internal reader with this bounded result:

```js
{
  path,
  commit_sha,
  blob_sha,
  mode,
  size_bytes,
  raw_sha256,
  text
}
```

The reader must:

- reuse the existing base64, blob-size and LFS defenses;
- reject invalid UTF-8 rather than replacement-decoding it;
- require LF-only text and exactly one terminal newline;
- return exact byte length and SHA-256;
- never persist or emit `text` in the final evidence object.

### Step 3: Replace the JSON sidecar assertion

Change `assertProposalSubject()` so it:

1. validates the proposal manifest with `approval-proposal-manifest/v1`;
2. requires `manifest.decision_id === request.decisionId`;
3. requires `manifest.policy_revision === request.policyRevision`;
4. requires `manifest.decision_raw_sha256 === request.expectedDecisionRawSha256`;
5. requires `manifest.decision_semantic_sha256 === request.expectedDecisionSemanticSha256`;
6. requires `manifest.proposed_sidecar_path === request.proposalSidecarPath` before reading the allowlisted sidecar path;
7. requires the manifest renderer schema/source tuple to equal `policy.proposalRenderer` exactly;
8. reads the verified request/manifest Markdown path as raw UTF-8 bytes;
9. compares `proposed_sidecar_byte_length` to the blob byte length;
10. compares `proposed_sidecar_raw_sha256` to the raw blob digest;
11. emits only path, Git/blob identity, byte length, raw digest, semantic digest and trusted renderer identity — never raw Markdown.

Pass the already snapshotted trusted `policy` into proposal verification; do not read a new mutable policy source after remote reads begin. Preserve the original request-to-manifest identity checks while adding raw-byte binding.

The collector must remain `HOLD_LOCAL_CONTEXT_REQUIRED` until all other required local/admission evidence is present.

Run the focused tests and confirm GREEN.

### Step 4: Refactor and commit

```bash
git diff --check
git add scripts/governance-github-readback-git.mjs scripts/governance-github-readback.mjs scripts/governance-github-readback.spec.mjs scripts/governance-github-readback-evidence.spec.mjs scripts/governance-github-readback-round1.spec.mjs scripts/fixtures/approval-readback/task5-github-readback-fixture.mjs
git commit -m "fix: bind approval sidecar raw bytes"
```

## Task 3: Require hosted authority assignments to be current for each review

**Files:**

- Modify: `scripts/governance-github-readback-git.mjs`
- Modify: `scripts/governance-github-readback-normalizers.mjs`
- Modify: `scripts/governance-github-readback.spec.mjs`
- Modify: `scripts/governance-github-readback-evidence.spec.mjs`
- Modify: `scripts/fixtures/approval-readback/task5-github-readback-fixture.mjs`

### Step 1: Add currentness RED tests

For each exact required role (`OWN-PRODUCT`, `OWN-DATA-PRIVACY`, `OWN-QA-EVIDENCE`, `OWN-SECURITY`), mutate one assignment at a time and require fail-closed behavior for:

- `effective_from` after the review `submitted_at` or request `observedAt`;
- `effective_until` equal to or before the review `submitted_at` or request `observedAt`;
- `assignment_evidence.observed_at` after the review `submitted_at` or request `observedAt`;
- `revocation_status != ACTIVE`;
- non-null `superseded_by`;
- repository mismatch;
- decision mismatch;
- policy revision mismatch;
- purpose mismatch;
- `assignment_evidence.observed_at` after either observation boundary (parameterized separately for the review and request cases).

Retain a positive case where all four assignments cover the exact review time and request observation time.

Run:

```bash
node --test scripts/governance-github-readback.spec.mjs scripts/governance-github-readback-evidence.spec.mjs
```

Expected: FAIL because actor IDs are currently selected without temporal, revocation, supersession, scope, or purpose predicates.

### Step 2: Implement role-scoped currentness

Add a pure predicate equivalent to:

```js
authorityEntryCurrentForReview({
  entry,
  role,
  repository,
  decisionId,
  policyRevision,
  reviewSubmittedAt,
  requestObservedAt,
})
```

It must require:

- the exact role-purpose mapping;
- exact repository/decision/policy scope;
- `entry.status === "ASSIGNED"`;
- `effective_from <= reviewSubmittedAt < effective_until`;
- `effective_from <= requestObservedAt < effective_until`;
- `assignment_evidence.observed_at <= reviewSubmittedAt`;
- `assignment_evidence.observed_at <= requestObservedAt`;
- `revocation_status === "ACTIVE"`;
- no supersession;
- canonical timestamps and causal observation ordering.

Use the predicate while normalizing/selecting each review, not only when initially reading the assignment file. Prefer adapting the existing shared `authorityIsCurrent()` semantics rather than creating a divergent interval definition. Return a stable collector failure code that identifies authority currentness without leaking raw authority content.

Run the focused tests and confirm GREEN.

### Step 3: Refactor and commit

```bash
git diff --check
git add scripts/governance-github-readback-git.mjs scripts/governance-github-readback-normalizers.mjs scripts/governance-github-readback.spec.mjs scripts/governance-github-readback-evidence.spec.mjs scripts/fixtures/approval-readback/task5-github-readback-fixture.mjs
git commit -m "fix: enforce hosted approval authority currentness"
```

## Task 4: Treat consumption at the exact expiry instant as invalid everywhere

**Files:**

- Modify: `scripts/governance-approval-merge-authorization.mjs`
- Modify: `scripts/governance-approval-schema-validator.mjs`
- Modify: `scripts/governance-approval-readback.spec.mjs`
- Modify: `scripts/governance-approval-schemas.spec.mjs`

### Step 1: Add exact-boundary RED tests

Create exact-boundary fixtures. Require:

- a merge-gate case where `consumed_at === expires_at` emits `APPROVAL_MERGE_AUTHORIZATION_CONSUMPTION_DIGEST_MISMATCH`;
- a synthetic-inspector case where `consumed_at === expires_at` has `synthetic_consistent === false` and `trust_eligible === false`;
- a separate synthetic-inspector case where `consumed_at < expires_at && now === expires_at` has `synthetic_consistent === false` and `trust_eligible === false`;
- `GRANT_STALE` may also be present, but it must not be the only reason.

When the test changes `grant.expires_at`, recompute and update `grant_raw_sha256`, `consumption.grant_raw_sha256`, and `ledger_snapshot.reservations[0].grant_raw_sha256` so the RED failure is caused by the expiry boundary, not an unrelated digest/ledger mismatch.

Run:

```bash
node --test scripts/governance-approval-readback.spec.mjs scripts/governance-approval-schemas.spec.mjs
```

Expected: FAIL because two paths currently use `consumed_at > expires_at`.

### Step 2: Implement the minimal boundary correction

- Change the real merge gate consumption comparison from `>` to `>=`.
- In the synthetic inspector, change both `consumption.consumed_at > grant.expires_at` and `value.now > grant.expires_at` to `>=`.
- Do not alter the valid interval elsewhere: valid authorization remains strictly before expiry.
- Keep stable failure codes and do not suppress simultaneous diagnostic reasons.

Run the focused tests and confirm GREEN.

### Step 3: Refactor and commit

```bash
git diff --check
git add scripts/governance-approval-merge-authorization.mjs scripts/governance-approval-schema-validator.mjs scripts/governance-approval-readback.spec.mjs scripts/governance-approval-schemas.spec.mjs
git commit -m "fix: reject approval consumption at expiry"
```

## Task 5: Represent ADR-027 Legal review as a conditional ContractGraph edge

**Files:**

- Modify: `packages/code-intelligence/src/extractors/governance.ts`
- Modify: `packages/code-intelligence/src/extractors/governance-approval-extractor.spec.ts`
- Test: `packages/code-intelligence/src/extractors/extractors.spec.ts`

### Step 1: Add the failing graph assertion

Require this static relationship:

```text
LEGAL-REVIEW --legal_input_for--> ADR-027
```

with attributes:

```ts
{
  relation: "legal_input_for",
  conditional: true,
  requiredWhen: "actor_policy=DUAL_ROLE_WITH_INDEPENDENT_COAPPROVER",
  evidenceClass: "STATIC_CONTRACT",
  hostedReadback: "EXTERNAL_UNOBSERVED",
  runtimeEvidence: false,
  acceptance: false
}
```

Also assert that ADR-026 retains its unconditional Legal edge without `conditional` or `requiredWhen`; that ADR-027 has exactly one Legal edge; and that no duplicate unconditional `LEGAL-REVIEW → ADR-027` edge exists.

Run:

```bash
pnpm --filter @global/code-intelligence exec tsx --test \
  src/extractors/governance-approval-extractor.spec.ts \
  src/extractors/extractors.spec.ts
```

Expected: FAIL because the current static mapping has no ADR-027 Legal edge and the helper cannot carry conditional attributes.

### Step 2: Implement conditional edge attributes

- Extend `addStaticApprovalEdge()` with optional immutable condition attributes. The helper, not the caller, must continue to fix `relation` and all `STATIC_APPROVAL_ATTRIBUTES`; callers cannot override `evidenceClass`, `hostedReadback`, `runtimeEvidence`, or `acceptance`.
- Add only the conditional ADR-027 relationship; do not change runtime policy or review admission semantics.
- Preserve graph identity determinism and existing ADR-026 edges.

Run the focused tests and confirm GREEN.

### Step 3: Refactor and commit

```bash
git diff --check
git add packages/code-intelligence/src/extractors/governance.ts packages/code-intelligence/src/extractors/governance-approval-extractor.spec.ts
git commit -m "fix: model conditional legal approval edge"
```

## Task 6: Run integration gates, document the local evidence, and obtain independent reviews

**Files:**

- Create: `.superpowers/sdd/2026-08-31-trusted-approval-round3-remediation/local-verification.md`
- Create: `.superpowers/sdd/2026-08-31-trusted-approval-round3-remediation/external-update-run-card.md`
- Modify only if current facts changed: `docs/status/current.md`
- Modify only if a durable architecture decision changed: `docs/adr/registry.md`
- Modify only if a tracked contract reference changed: `docs/governance/delivery-traceability.json`

### Step 1: Run focused approval and ContractGraph suites

```bash
node --test scripts/governance-approval-schemas.spec.mjs scripts/governance-approval-readback.spec.mjs scripts/governance-github-readback.spec.mjs scripts/governance-github-readback-evidence.spec.mjs scripts/governance-github-readback-round1.spec.mjs
pnpm --filter @global/code-intelligence exec tsx --test \
  src/extractors/governance-approval-extractor.spec.ts \
  src/extractors/extractors.spec.ts
pnpm --filter @global/code-intelligence test
pnpm --filter @global/code-intelligence build
```

### Step 2: Run the complete local governance gates

```bash
pnpm governance:verify
pnpm docs:verify
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
node --test scripts/copy-fixed-source-impact.spec.mjs
node scripts/copy-fixed-source-impact.mjs
pnpm code-intelligence:scan
pnpm --filter @global/code-intelligence exec tsx src/cli.ts status --repo ../..
git diff --check
git status --short --branch
```

The commands above are current repository commands. If a command changes during implementation, inspect `package.json`, record the exact replacement, and do not silently omit the gate. The Copy gate must remain honestly `STALE_HOLD / NOT_AUTHORIZED / BLOCKED` unless its independent authority changes; Round 3 does not authorize Copy promotion.

### Step 3: Record evidence without upgrading external status

The local verification note must bind:

- exact base and local head;
- complete changed-file list;
- focused and full command results;
- coverage result;
- ContractGraph commit/tree identity and freshness;
- independent review identities and findings;
- unresolved Hosted Review thread IDs;
- external status as `NOT_PERFORMED`;
- merge, deploy, runtime, release, Pilot and GA status as `HOLD`.

The external update run card may prepare exact future commands, but every action must remain unchecked and require separate user authorization.

### Step 4: Independent review loop

Dispatch two read-only reviewers:

1. correctness/contracts reviewer — checks raw-byte semantics, temporal authority logic, expiry boundary, test quality and graph semantics;
2. security/governance reviewer — checks fail-closed behavior, secret/PII non-retention, external-action boundaries, evidence non-escalation and release-gate integrity.

Fix all Critical/High findings with new RED tests, rerun affected gates, and obtain reviewer readback. Medium/Low findings must be either fixed or explicitly assigned with rationale; they cannot be silently ignored.

### Step 5: Commit local evidence and stop

```bash
git diff --check
git add .superpowers/sdd/2026-08-31-trusted-approval-round3-remediation/local-verification.md .superpowers/sdd/2026-08-31-trusted-approval-round3-remediation/external-update-run-card.md
git commit -m "docs: record approval round 3 verification"
git status --short --branch
git log --oneline --decorate -8
```

**Mandatory stop:** do not push, comment, resolve review threads, merge, deploy, mutate runtime, or claim external verification. Report the exact local head and ask for the next bounded authorization only after all local gates and independent reviews are complete.

## 2. Local completion criteria

Round 3 is locally complete only when all of the following are true:

- the proposal sidecar is canonical Markdown and is bound by exact byte length plus raw SHA-256;
- any byte, whitespace, newline, encoding, renderer identity or manifest drift fails closed;
- each hosted reviewer is admitted only under a current, active, unsuperseded, exact-scope authority assignment covering the review timestamp;
- `consumed_at === expires_at` is rejected consistently;
- ContractGraph carries a conditional, not unconditional, Legal edge for ADR-027 dual-role policy;
- relevant coverage remains at least 80%;
- governance, docs and ContractGraph gates pass;
- two independent reviewers report no unresolved Critical/High finding;
- the worktree is clean and descended from `8f5be1a`;
- no external action was performed;
- all external/release/runtime/Pilot/GA gates remain honestly `HOLD` until separately proven and authorized.
