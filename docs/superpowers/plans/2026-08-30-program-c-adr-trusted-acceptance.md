# Program C ADR-027 / ADR-026 Trusted Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the user's exact documentary Product decisions for Program C Suppression and Retention into independently verified, exact-head Product/Privacy/Legal/CODEOWNER/QA/Security/machine evidence, immutable stage-specific merge grants, append-only merge consumptions, attested receipts, and two-stage ADR acceptance without closing implementation, admission-runtime, replay, closure, Release, or Pilot gates by implication.

**Architecture:** Each decision uses deterministic proposed-sidecar bytes, a Proposal PR that keeps its decision HOLD open, independent exact-head readback, separate immutable Proposal/Acceptance merge grants, an external durable nonce/CAS ledger, append-only result consumptions, a post-merge receipt, an Acceptance-time live-revalidation receipt, and a second Acceptance PR. ADR-027 is accepted first; only then may its selected machine contract merge/read back, and only then may ADR-026 proceed. Same-repository receipts are canary-only and never authorize ADR acceptance. Current-root governance becomes fully GREEN by asserting honest HOLD state; RED exists only transiently inside a TDD commit.

**Tech Stack:** Node.js 22, JSON Schema 2020-12, Program C governance tests, deterministic Markdown renderer, approval-authorities registry, closed Legal/merge-authorization contracts, trusted readback receipts, GitHub Pull Request Reviews, artifact attestations, ADR registry, ContractGraph, current-main readback.

**Spec:** `docs/governance/trusted-approval-readback-spec.md`

## Global Constraints

### Exact authority and future execution identity

```text
planning authority main/origin-main = f1915d2ef22bba4ae26fc456531ed3a9405f0413
readiness/spec source head           = 24c95ee713580d363bfe3a3ab4d332c8f93cba67
planning worktree                    = /global/backend/.codex/worktrees/program-c-handoff-capability
planning branch                      = codex/program-c-handoff-capability
future execution worktree            = /global/backend/.codex/worktrees/program-c-adr-trusted-acceptance
future execution branch              = codex/program-c-adr-trusted-acceptance
```

The future execution base cannot honestly be pinned to the planning base: the
local foundation, independent hosted verifier, authority assignments, ruleset
parity, and fixed-source preflight must first merge. Until those prerequisites
exist, execution is `APPROVAL_EXECUTION_BASE_NOT_PINNED / HOLD`; do not write a
guessed SHA into this plan. At execution time Task P0 resolves exactly one
40-character current `origin/main`, proves root `main` is clean/equal, creates
the fixed worktree/branch from that SHA, and records the SHA in the first local
commit evidence. A moving `main`, an existing conflicting branch/worktree, or
unresolved writer ownership stops the plan.

### Exact Product facts

The user has documentary approved these exact Product values; Privacy and Legal
remain pending and these values are not effective policy:

```text
ADR-027 selected strategy                       = WORKSPACE_COMPLIANCE_HOLD
ADR-026 CANDIDATE full snapshot                 = 180 days
ADR-026 CLOSED non-PII history                  = 730 days
ADR-026 CLOSED contact references               = 30 days
ADR-026 contact tombstone                       = earliest(closed+30 days,
                                                        candidate_created+180 days,
                                                        valid_until+30 days)
ADR-026 null valid_until fallback               = candidate_created+30 days
ADR-026 receipt/dedupe deletion                 = later(terminal+730 days,
                                                        source_non_replayable+90 days)
ADR-026 Legal hold review interval              <= 90 days
ADR-026 Workspace read-only closure grace       = 30 days
ADR-026 encrypted export artifact TTL           = 24 hours
ADR-026 quarantine raw payload persisted        = false
ADR-026 quarantine raw payload retention        = 0 days
ADR-026 quarantine metadata retention           = 90 days
ADR-026 admission default                       = DISABLED
ADR-026 existing Workspace automatic enablement = false
ADR-026 historical full replay                  = false
```

- Consume merged/current-main local foundation and independently governed hosted verifier work; do not bootstrap trust inside a decision PR.
- `TRUSTED_BASE_VERIFIED` is canary-only. Task 0A and every ADR acceptance require `INDEPENDENT_EXTERNAL_VERIFIED`.
- `OWN-DATA-PRIVACY`, `OWN-QA-EVIDENCE`, and `OWN-SECURITY` remain unassigned until explicit identity decisions are separately admitted.
- Legal authority remains `UNASSIGNED` and Legal remains `PENDING`; ADR-026 cannot receive final Privacy approval while either is unresolved. ADR-027 is not blocked by ADR-026 Legal pending.
- Product and Privacy default to distinct actors. A dual-role exception requires a separate explicit policy and third human actor; this plan does not enable it.
- `MERGE-AUTHORIZER` remains `UNASSIGNED` until an explicit identity decision is separately admitted; no other role or repository power implies it.
- Evidence slots for Product, Privacy, Legal, CODEOWNER, QA, Security, machine checks, Proposal grant, Proposal consumption, Acceptance grant, Acceptance consumption, and Release authorization remain distinct.
- Every proposal, receipt, merge, acceptance, and current-main transition is a separate gate.
- No task authorizes push, PR, review submission, merge, ruleset mutation, repository/App creation, deploy, migration, GrowthOS consumer, Runtime, Release, UAT, Pilot, GA, Provider, model, email, or paid action.
- No decision PR may modify verifier code, authority policy, trusted workflow, or live ruleset declaration.
- No acceptance PR may modify approved decision bytes.
- `ACCEPTED` does not imply G1/G2/G3 PASS or implementation.
- Approval-control-plane failures use only canonical `APPROVAL_*` error codes; Program C `HOLD_*` values are policy-state identifiers, not thrown errors.
- No committed current-root test may remain intentionally RED. TDD RED is committed only on an isolated feature branch and the task's final commit must restore the complete governance suite to GREEN while asserting the honest HOLD state.
- ADR-027 Acceptance closes only `HOLD_SUPPRESSION_DECISION`; its machine-contract PR closes `HOLD_SUPPRESSION_MACHINE_CONTRACT` only after merge/current-main readback.
- ADR-026 Acceptance closes only `HOLD_PROGRAM_C_RETENTION_POLICY` and documentary `HOLD_CAPABILITY_ADMISSION_POLICY`. It keeps `HOLD_CAPABILITY_ADMISSION_RUNTIME`, `HOLD_SOURCE_REPLAY_HORIZON`, `HOLD_WORKSPACE_CLOSURE_CONTRACT`, `HOLD_OWNER_UNASSIGNED`, Builder, remote CI, Runtime, Release, UAT, Pilot, and GA open.

### Planning-snapshot verification fact

At planning worktree head `24c95ee713580d363bfe3a3ab4d332c8f93cba67`,
the read-only `pnpm docs:verify` reproduction is HOLD for exactly three observed
causes:

```text
COPY_FIXED_SOURCE_FINGERPRINT_MISMATCH
ADR-027 current test asserts missing sidecar as failure
ADR-026 current test asserts missing sidecar as failure
```

The current recomputed Copy fingerprint is
`7220dd4b8b095c9a2fa42a8213f691ea66dfc0b6006f5d4622af567048ca75b0`;
the controlled receipt still contains
`a96ca4bdb384046a16362c7f736a24b4d4137ed6ff469d72877f47fba3c4ed0b`.
The drift set remains the 11 paths already declared by the receipt. This plan
does not rewrite that receipt. Task P0 routes Copy remediation to an independent
lane; Task 0D converts the two missing-sidecar failures into PASS assertions of
the honest HOLD. `node scripts/verify-docs.mjs` independently passes with zero
errors; the unrelated existing table warning remains outside this plan.

---

### Task P0: Exact base, single-writer, and Copy fixed-source preflight

**Files:**

- Read only: `docs/evidence/site-builder/copy-runtime-eligibility.json`
- Read only: `docs/implementation-records/copy-fixed-source-impact-governance.md`
- Read only: `scripts/copy-fixed-source-impact.mjs`
- Read only: `scripts/copy-fixed-source-impact.spec.mjs`

**Interfaces:**

- Produces one exact execution base/worktree/branch and a PASS preflight.
- Does not repair Copy fixed-source files in the Program C branch.

- [ ] **Step 1: Prove root main and writer ownership**

Run from `/global/backend`:

```bash
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
pnpm worktree:inventory
```

Require root `main` clean, `HEAD == origin/main`, no existing
`codex/program-c-adr-trusted-acceptance` branch/worktree, and no writer owning
the future plan files. Otherwise stop with
`APPROVAL_EXECUTION_BASE_NOT_PINNED` or `APPROVAL_WRITER_COLLISION`.

- [ ] **Step 2: Create the exact execution worktree**

Run only after Step 1 PASS:

```bash
program_c_base_sha=$(git rev-parse origin/main)
test "$(printf '%s' "$program_c_base_sha" | wc -c)" -eq 40
git worktree add -b codex/program-c-adr-trusted-acceptance /global/backend/.codex/worktrees/program-c-adr-trusted-acceptance "$program_c_base_sha"
git -C /global/backend/.codex/worktrees/program-c-adr-trusted-acceptance rev-parse HEAD
```

The last output must equal `program_c_base_sha`. All remaining local commands
run only in that worktree.

- [ ] **Step 3: Run the independent Copy fixed-source preflight**

```bash
node --test scripts/copy-fixed-source-impact.spec.mjs
node scripts/copy-fixed-source-impact.mjs
```

Require the script exit code 0 and its JSON `result` to be the current accepted
non-dispatch status. This is a source-safety preflight, not model/dispatch
authorization. If it fails, stop this plan and remediate Copy fixed-source in a
separate worktree/branch/PR; do not modify Copy eligibility, fingerprints,
implementation records, or Copy scripts in the Program C branch.

---

### Task 0A: Common authority, independent trust root, and ruleset gate

**Files:**

- Read only: `docs/governance/approval-authorities.json`
- Create: `scripts/governance-program-c-decision-preconditions.mjs`
- Create: `scripts/governance-program-c-decision-preconditions.spec.mjs`
- Create: `scripts/fixtures/program-c-decisions/common-preconditions.valid.json`

**Interfaces:**

- Produces `verifyProgramCCommonPreconditions(input): immutable ValidationResult`.
- Consumes current-main authority, closed exact-head Security evidence, independent verifier receipt, live ruleset readback, and exact execution base; it does not create any identity or external fact.
- Does not consume ADR-026 Legal input and therefore does not block ADR-027 on Legal pending.

- [ ] **Step 1: Write RED common-precondition tests**

Require:

```text
OWN-PRODUCT numeric GitHub actor mapping = current-main admitted
OWN-DATA-PRIVACY numeric actor mapping   = current-main admitted and distinct
OWN-QA-EVIDENCE numeric actor mapping    = current-main admitted
OWN-SECURITY numeric actor mapping       = current-main admitted
MERGE-AUTHORIZER numeric actor mapping   = current-main admitted
Security evidence                        = separate closed APPROVED Review on the exact PR/head/decision digest
actor policy                             = DISTINCT_ACTORS_REQUIRED
independent verifier trust               = INDEPENDENT_EXTERNAL_VERIFIED
real offline attestation toolchain        = PASS, not injected or NOT_RUN
same-repository trust                    = insufficient
live ruleset parity                      = PASS by API readback
live ruleset bypass_actors               = [] exactly
exact execution base                     = current origin/main
verifier allowed subject paths           = exact manifest plus matching proposed-sidecar
ADR-026 Legal input                      = not evaluated by Task 0A
```

Mutation-test unassigned/stale/revoked actors, missing/inferred
`OWN-SECURITY` or `MERGE-AUTHORIZER`, Product=Privacy actor reuse,
same-repository receipt, signer mismatch, ruleset drift, any non-empty or
unreadable `bypass_actors`, base drift,
`APPROVAL_ATTESTATION_TOOLCHAIN_UNAVAILABLE`, and an ADR-027 candidate with
Legal `PENDING`. The last candidate must pass the Legal-independent portion of
Task 0A.

The Security record is closed and exact-head: repository/decision/policy
revision, PR/base/head, decision raw/semantic digests, review ID/state/commit/
timestamp, canonical command digest, and the current-main-admitted
`OWN-SECURITY` numeric actor/node ID/login/authority revision are required.
Execute mutations for missing evidence, wrong actor/authority revision,
PR/base/head/digest drift, non-`APPROVED`/dismissed/superseded review, wrong or
duplicate review ID, non-canonical timestamp, free-form body persistence, PR
author/bot substitution, and reuse of Product/Privacy/CODEOWNER/QA/machine
evidence. Each mutation must fail `APPROVAL_SECURITY_REVIEW_REQUIRED` or the
more specific canonical `APPROVAL_*` code; a URL, check, CODEOWNER approval, or
repository permission cannot satisfy Security.

The live verifier policy must include all four Program C subject paths before
either ADR can proceed:

```text
docs/governance/decisions/ADR-026.proposal.json
docs/governance/decisions/ADR-026.proposed-sidecar.md
docs/governance/decisions/ADR-027.proposal.json
docs/governance/decisions/ADR-027.proposed-sidecar.md
```

A manifest-only hosted allowlist returns `APPROVAL_PROPOSED_SIDECAR_REQUIRED`;
it is not repaired inside a decision PR.

```bash
node --test scripts/governance-program-c-decision-preconditions.spec.mjs
```

Expected RED: missing module or current external facts return canonical
`APPROVAL_*` findings. Tests never call the network.

- [ ] **Step 2: Implement fail-closed validation**

Return frozen results, never raw external input. `TRUSTED_BASE_VERIFIED` returns
`APPROVAL_INDEPENDENCE_NOT_PROVEN`; missing roles return
`APPROVAL_OWNER_UNASSIGNED`; missing or stale exact-head Security evidence
returns `APPROVAL_SECURITY_REVIEW_REQUIRED`; Legal pending is not an ADR-027
error.

- [ ] **Step 3: Run local GREEN and commit**

```bash
node --test scripts/governance-program-c-decision-preconditions.spec.mjs
node --test --experimental-test-coverage scripts/governance-program-c-decision-preconditions.spec.mjs
pnpm exec eslint --no-ignore scripts/governance-program-c-decision-preconditions.mjs scripts/governance-program-c-decision-preconditions.spec.mjs
git diff --check
git add scripts/governance-program-c-decision-preconditions.mjs scripts/governance-program-c-decision-preconditions.spec.mjs scripts/fixtures/program-c-decisions/common-preconditions.valid.json
git commit -m "feat: enforce program c independent approval preconditions"
```

Require at least 80% statements and branches. Local fixture GREEN does not claim
the real external gate has passed. Before ADR-027 Proposal creation, run the
same validator on independently read-back current facts; any HOLD stops.

---

### Task 0C: Closed decision, Legal, merge-authorization, state, and Ops contracts

**Files:**

- Read only: `docs/governance/approval-authorities.schema.json`
- Read only: `docs/governance/approval-authorities.json`
- Create: `docs/governance/program-c-legal-input.schema.json`
- Modify: `docs/governance/program-c-merge-authorization-grant.schema.json`
- Modify: `docs/governance/program-c-merge-authorization-consumption.schema.json`
- Create: `docs/governance/program-c-decision-proposal.schema.json`
- Modify: `docs/governance/trusted-approval-readback.schema.json`
- Modify: `docs/governance/trusted-approval-evidence-manifest.schema.json`
- Modify: `scripts/governance-approval-state.mjs`
- Modify: `scripts/governance-approval-state.spec.mjs`
- Modify: `scripts/governance-approval-status.mjs`
- Modify: `scripts/governance-approval-status.spec.mjs`
- Modify: `scripts/governance-approval-readback.mjs`
- Modify: `scripts/governance-approval-readback.spec.mjs`
- Modify: `scripts/governance-approval-schemas.spec.mjs`
- Modify: `scripts/governance-approval-test-entry.spec.mjs`
- Create: `scripts/governance-merge-authorization-ledger.mjs`
- Create: `scripts/governance-merge-authorization-ledger.spec.mjs`
- Create: bounded fixtures under `scripts/fixtures/program-c-decisions/merge-authorization/`
- Modify: `docs/governance/README.md`
- Modify: `package.json`

**Interfaces:**

- Consumes and verifies the local foundation's existing `OWN-SECURITY=UNASSIGNED`, `LEGAL-REVIEW=UNASSIGNED`, and `MERGE-AUTHORIZER=UNASSIGNED` entries; Task 0C neither creates nor adds any authority role and does not modify the authority registry.
- Produces closed `program-c-legal-input/v1` and decision-proposal schemas; validates and extends the local foundation-owned immutable `program-c-merge-authorization-grant/v1` and append-only `program-c-merge-authorization-consumption/v1` schemas only for the Program C state/readback/ledger bindings required here.
- Consumes the local foundation-owned exact validators `validateProgramCMergeAuthorizationGrant(value)` and `validateProgramCMergeAuthorizationConsumption(value)` and extends their Program C fixtures/consumer tests; it does not create a second validator owner. The deleted singular schema/type/function name has no alias.
- Produces a pure/injected durable-ledger adapter whose CAS uniqueness key is `repository_id + single_use_nonce`; stage remains a bound record field, so the nonce cannot be reused across Proposal, Acceptance, ADR, or PR. It never mutates grant bytes.
- Extends the merged local foundation's `renderApprovalStatusReadModel(state)` and existing JSON/text CLI with the Program C Legal/merge/evidence-slot fields.
- Consumes and mutation-tests the merged local foundation's non-recursive receipt contract: internal `receipt_id` plus `receipt_core_sha256`, with raw-file SHA-256 only in the evidence manifest; it does not create a second renderer or digest algorithm.
- Extends the one closed root `approval-readback:test` command in `package.json` and its byte-exact self-test so the new ledger spec cannot be omitted, reordered, duplicated, or replaced by a wildcard.

- [ ] **Step 1: Write RED schema/state/read-model tests**

Cover every normative transition and stop-code recovery row in the spec,
separate Product/Privacy/Legal/CODEOWNER/QA/Security/machine/Proposal-grant/
Proposal-consumption/Acceptance-grant/Acceptance-consumption/Release slots,
Legal scope/digest/expiry/stale/revocation, stage-specific immutable grants,
append-only consumptions, durable unique-nonce CAS, acceptance revalidation,
receipt core/raw digest separation, Chinese message keys, redaction, and absence
of `force accept`.

Security evidence tests require the local foundation-owned `OWN-SECURITY`
authority role, a separate closed exact-head `APPROVED` Review, and receipt/state
bindings for repository/decision/policy revision, PR/base/head, decision
raw/semantic digests, review ID/state/commit/timestamp, canonical command
digest, and admitted numeric actor/node/login/authority revision. Execute every
wrong/missing/stale/revoked actor, PR/head/digest, review state, timestamp,
free-form body, bot/PR-author substitution, duplicate evidence ID, and
Product/Privacy/CODEOWNER/QA/machine slot-reuse mutation; none may be replaced
by a URL or check result.

Every evidence-package fixture must include `trusted_root.jsonl`, its manifest
provenance/digest fields, `approval-receipt-raw.sha256`, and a Sigstore bundle
named `sha256-<receipt-raw-sha256-hex>.jsonl`. A bundle named from
`receipt_core_sha256`, missing trusted root, or unbound tool/root provenance is
rejected.

Grant/consumption/ledger tests require:

```text
grant contains no observed result commit, consumed_at, mutable status, verifier result, or ledger revision
consumption binds grant_id + grant_raw_sha256 + nonce + result commit + method + consumed_at + verifier + current-main readback
two concurrent reservations have exactly one CAS winner
identical retry returns the existing reservation/consumption
response loss before/after physical merge never causes a second merge request
ACK_UNKNOWN recovery uses PR/result/current-main readback only
process restart preserves reservation and nonce uniqueness
wrong request identity, stage, PR, head, method, result commit, grant digest, or ledger revision fails closed
replay after consumption, revocation, expiry, or failed reconciliation remains denied
original grant bytes and digest remain unchanged in every test
```

`scripts/governance-approval-test-entry.spec.mjs` changes in the RED checkpoint
to require this one exact closed root command and to reject omission,
reordering, duplicate entries, and wildcard expansion:

```json
{
  "approval-readback:test": "node --test scripts/governance-approval-schemas.spec.mjs scripts/governance-approval-safe-json.spec.mjs scripts/governance-approval-readback.spec.mjs scripts/governance-approval-state.spec.mjs scripts/governance-merge-authorization-ledger.spec.mjs scripts/governance-approval-status.spec.mjs scripts/governance-github-readback.spec.mjs scripts/governance-approval-attestation.spec.mjs scripts/governance-approval-test-entry.spec.mjs"
}
```

```bash
node --test scripts/governance-approval-schemas.spec.mjs scripts/governance-approval-readback.spec.mjs scripts/governance-approval-state.spec.mjs scripts/governance-approval-status.spec.mjs scripts/governance-merge-authorization-ledger.spec.mjs scripts/governance-approval-test-entry.spec.mjs
```

Expected RED: the local foundation-owned authority registry, grant/consumption
schemas, and validators already exist; only the Program C Legal/proposal,
state/readback/ledger extensions and their fixtures are absent, and the base
`approval-readback:test` command does not yet contain the new ledger spec.

- [ ] **Step 2: Implement the minimum closed contracts and pure state reducer**

The existing Security, Legal, and Merge-Authorizer authorities stay
`UNASSIGNED`. Do not
modify the authority registry or create
`ADR-026.legal-input.json`, actor IDs, reviews, merge grants, merge
consumptions, ledger evidence, receipt, or external evidence. Verify the local
foundation-owned authority and schema bytes before extending their Program C
consumers; use only `APPROVAL_*` error codes. The ledger module receives an
injected durable CAS adapter in tests and contains no same-process-only
uniqueness fallback.

Update `package.json` to the exact closed `approval-readback:test` bytes shown
in Step 1 and update only `scripts/governance-approval-test-entry.spec.mjs` as
the command self-test owner. Do not add a second script, alias, glob, generated
list, or alternate test entry.

- [ ] **Step 3: Run GREEN, ContractGraph, and commit**

```bash
pnpm approval-readback:test
node --test --experimental-test-coverage scripts/governance-approval-readback.spec.mjs scripts/governance-approval-state.spec.mjs scripts/governance-approval-status.spec.mjs scripts/governance-merge-authorization-ledger.spec.mjs
pnpm exec eslint --no-ignore scripts/governance-merge-authorization-ledger.mjs scripts/governance-merge-authorization-ledger.spec.mjs
pnpm governance:verify
pnpm docs:verify
pnpm code-intelligence:scan
pnpm --filter @global/code-intelligence exec tsx src/cli.ts status --repo ../..
pnpm --filter @global/code-intelligence exec tsx src/cli.ts impact package.json docs/governance/program-c-legal-input.schema.json docs/governance/program-c-merge-authorization-grant.schema.json docs/governance/program-c-merge-authorization-consumption.schema.json docs/governance/program-c-decision-proposal.schema.json docs/governance/trusted-approval-readback.schema.json docs/governance/trusted-approval-evidence-manifest.schema.json docs/governance/README.md scripts/governance-approval-schemas.spec.mjs scripts/governance-approval-readback.mjs scripts/governance-approval-readback.spec.mjs scripts/governance-approval-state.mjs scripts/governance-approval-state.spec.mjs scripts/governance-approval-status.mjs scripts/governance-approval-status.spec.mjs scripts/governance-approval-test-entry.spec.mjs scripts/governance-merge-authorization-ledger.mjs scripts/governance-merge-authorization-ledger.spec.mjs scripts/fixtures/program-c-decisions/merge-authorization --repo ../..
git diff --check
git add package.json docs/governance/program-c-legal-input.schema.json docs/governance/program-c-merge-authorization-grant.schema.json docs/governance/program-c-merge-authorization-consumption.schema.json docs/governance/program-c-decision-proposal.schema.json docs/governance/trusted-approval-readback.schema.json docs/governance/trusted-approval-evidence-manifest.schema.json docs/governance/README.md scripts/governance-approval-schemas.spec.mjs scripts/governance-approval-readback.mjs scripts/governance-approval-readback.spec.mjs scripts/governance-approval-state.mjs scripts/governance-approval-state.spec.mjs scripts/governance-approval-status.mjs scripts/governance-approval-status.spec.mjs scripts/governance-approval-test-entry.spec.mjs scripts/governance-merge-authorization-ledger.mjs scripts/governance-merge-authorization-ledger.spec.mjs scripts/fixtures/program-c-decisions/merge-authorization
git commit -m "feat: define program c approval state contracts"
```

Require graph status exact-head clean with zero errors and at least 80%
statements/branches for changed executable files.

---

### Task 0D: Normalize current-root Program C governance to GREEN-with-HOLD

**Files:**

- Modify: `scripts/governance-contracts.spec.mjs`
- Modify: `docs/governance/conflict-register.md`
- Modify: `docs/status/current.md`
- Modify: `docs/superpowers/plans/2026-08-30-program-c-handoff-capability-readiness.md`

**Interfaces:**

- Replaces intentional current-root RED with PASS assertions that the decision/policy/contract/admission HOLDs are present and Program C is disabled.
- Splits suppression decision from machine contract, and admission policy from runtime/replay/closure/owner.
- Makes the older readiness plan `SUPERSEDED_FOR_ADR_ACCEPTANCE` for ADR/HOLD/resume ownership while preserving its independent deletion-schema repair steps.

- [ ] **Step 1: Add the exact successor banner and route old Task 4/4B/5**

Add this status immediately under the older readiness plan title:

```text
Status: SUPERSEDED_FOR_ADR_ACCEPTANCE
Successor: docs/superpowers/plans/2026-08-30-program-c-adr-trusted-acceptance.md
```

The banner and task-local successor notes must encode all of these ownership
rules without deleting historical text:

```text
old Task 4 Steps 1-3 deletion schema/producer parity = ACTIVE_IN_READINESS_PLAN
old Task 4 ADR-027 decision/approval/HOLD closure     = SUPERSEDED → successor Tasks 1-3
old Task 4B suppression machine-contract lane         = SUPERSEDED → successor Task 4
old Task 5 ADR-026 Legal/proposal/approval/HOLD close  = SUPERSEDED → successor Tasks 0B, 5, 6
old Task 5/6 resume language                           = SUPERSEDED → successor Task 7 current-main/G1 readback
```

Preserve the deletion payload field/schema requirements, tests, commands,
security review, and its independent commit. The old plan may no longer create
or accept ADR-026/027, close any successor-owned HOLD, authorize merge/Release,
or resume Program C Task 6. Governance tests must reject a missing banner,
wrong successor, deletion-step deletion, two active ADR writers, old-plan HOLD
closure, or old-plan resume language that bypasses successor Task 7.

- [ ] **Step 2: Write the expected HOLD assertions**

Require these independent status identifiers:

```text
HOLD_SUPPRESSION_DECISION
HOLD_SUPPRESSION_MACHINE_CONTRACT
HOLD_PROGRAM_C_RETENTION_POLICY
HOLD_CAPABILITY_ADMISSION_POLICY
HOLD_CAPABILITY_ADMISSION_RUNTIME
HOLD_SOURCE_REPLAY_HORIZON
HOLD_WORKSPACE_CLOSURE_CONTRACT
HOLD_OWNER_UNASSIGNED
```

Remove the obsolete combined hold names atomically from the Program C current
card/tests. Missing ADR-026/027 or receipts must make the test PASS only when the
corresponding honest HOLD remains open; they must never leave the suite RED.

- [ ] **Step 3: Run complete governance GREEN**

```bash
node --test scripts/governance-contracts.spec.mjs
pnpm governance:verify
pnpm docs:verify
pnpm code-intelligence:scan
pnpm --filter @global/code-intelligence exec tsx src/cli.ts status --repo ../..
pnpm --filter @global/code-intelligence exec tsx src/cli.ts impact scripts/governance-contracts.spec.mjs docs/governance/conflict-register.md docs/status/current.md docs/superpowers/plans/2026-08-30-program-c-handoff-capability-readiness.md --repo ../..
git diff --check
```

Expected: all PASS; `G1=AMBER`, Program C `DISABLED`, no ADR, implementation,
Runtime, Release, UAT, Pilot, or GA promotion.

- [ ] **Step 4: Commit normalized status and successor route**

```bash
git add scripts/governance-contracts.spec.mjs docs/governance/conflict-register.md docs/status/current.md docs/superpowers/plans/2026-08-30-program-c-handoff-capability-readiness.md
git commit -m "test: assert program c governance holds"
```

---

### Task 1: ADR-027 deterministic Proposal subject

**Files:**

- Create: `docs/governance/decisions/ADR-027.proposal.json`
- Create: `docs/governance/decisions/ADR-027.proposed-sidecar.md`
- Create: `scripts/governance-program-c-decision-subject.mjs`
- Create: `scripts/governance-program-c-decision-subject.spec.mjs`
- Modify: `scripts/governance-contracts.spec.mjs`
- Create: `scripts/fixtures/program-c-decisions/adr-027-proposal.valid.json`
- Create: `scripts/fixtures/program-c-decisions/adr-027-proposed-sidecar.expected.md`

**Interfaces:**

- Produces `renderProgramCDecisionSubject(input): Buffer` and a `PROPOSED_NOT_ACCEPTED` manifest bound to exact proposed-sidecar raw bytes and semantic digest.
- Consumes Task 0A actual independent-precondition PASS and Task 0D GREEN-with-HOLD baseline.

- [ ] **Step 1: Write RED proposal tests**

The manifest must bind:

```text
decision_id = ADR-027
policy_revision = program-c-suppression-workspace-hold-v1
selected_strategy = WORKSPACE_COMPLIANCE_HOLD
status = PROPOSED_NOT_ACCEPTED
trust = EXTERNAL_UNVERIFIED
renderer_schema_version = program-c-decision-subject/v1
proposed_sidecar_path = docs/governance/decisions/ADR-027.proposed-sidecar.md
proposed_sidecar_byte_length = exact integer
proposed_sidecar_raw_sha256 = sha256:<64 lowercase hex>
decision_semantic_sha256 = sha256:<64 lowercase hex>
HOLD_SUPPRESSION_DECISION = open
HOLD_SUPPRESSION_MACHINE_CONTRACT = open
G1 = AMBER
Program C = DISABLED
```

The sidecar must encode `WORKSPACE_COMPLIANCE_HOLD`, the two unselected
alternatives, apply/request/deny/identity-correction behavior, PII prohibition,
Workspace isolation, monotonic policy revision, replay/gap/CAS behavior, and
release-request-not-release. Mutation-test one-byte Markdown drift, semantic
drift, renderer-source drift, wrong path/length/digest, unknown fields, and
closing either HOLD.

Run:

```bash
node --test scripts/governance-program-c-decision-subject.spec.mjs
node --test --test-name-pattern='Program C suppression propagation' scripts/governance-contracts.spec.mjs
```

Expected RED: renderer/proposal files are absent. The existing governance suite
continues PASS by asserting the honest HOLD state.

- [ ] **Step 2: Commit RED**

```bash
git add scripts/governance-program-c-decision-subject.spec.mjs scripts/governance-contracts.spec.mjs scripts/fixtures/program-c-decisions/adr-027-proposal.valid.json scripts/fixtures/program-c-decisions/adr-027-proposed-sidecar.expected.md
git commit -m "test: specify adr 027 trusted proposal"
```

- [ ] **Step 3: Render the complete proposed-sidecar and manifest**

Render canonical UTF-8/LF/one-terminal-newline bytes. Compute raw and semantic
digests from the rendered Buffer. Do not create
`docs/adr/027-program-c-suppression-propagation.md`, add registry `ACCEPTED`, or
close either suppression HOLD.

- [ ] **Step 4: Run local proposal GREEN**

```bash
node --test --test-name-pattern='Program C suppression propagation' scripts/governance-contracts.spec.mjs
node --test scripts/governance-program-c-decision-subject.spec.mjs
node --test --experimental-test-coverage --test-coverage-include=scripts/governance-program-c-decision-subject.mjs scripts/governance-program-c-decision-subject.spec.mjs
pnpm governance:verify
pnpm docs:verify
pnpm code-intelligence:scan
pnpm --filter @global/code-intelligence exec tsx src/cli.ts status --repo ../..
pnpm --filter @global/code-intelligence exec tsx src/cli.ts impact docs/governance/decisions/ADR-027.proposal.json docs/governance/decisions/ADR-027.proposed-sidecar.md scripts/governance-program-c-decision-subject.mjs scripts/governance-contracts.spec.mjs --repo ../..
git diff --check
```

Expected: all PASS; proposal is `PROPOSED_NOT_ACCEPTED`, both HOLDs remain open,
the renderer has at least 80% statements and branches, and graph is exact-head
clean with zero errors.

- [ ] **Step 5: Independent local code/security review and commit**

This local review is not Product/Privacy/CODEOWNER/QA approval. After 0
Critical/High/Medium:

```bash
git add docs/governance/decisions/ADR-027.proposal.json docs/governance/decisions/ADR-027.proposed-sidecar.md scripts/governance-program-c-decision-subject.mjs scripts/governance-program-c-decision-subject.spec.mjs scripts/governance-contracts.spec.mjs scripts/fixtures/program-c-decisions/adr-027-proposal.valid.json scripts/fixtures/program-c-decisions/adr-027-proposed-sidecar.expected.md
git commit -m "docs: propose adr 027 workspace compliance hold"
```

Stop before push or PR.

---

### Task 2: ADR-027 Proposal PR, independent evidence, and post-merge receipt

**External actions:** push, create Proposal PR, submit human reviews, merge, run hosted verifier.

- [ ] **Step 1: Stop for exact push/PR authorization**

The authorization names `mlhjyx/global-backend`, branch
`codex/program-c-adr-trusted-acceptance`, exact 40-character head, PR title/body,
reviewers, no-merge boundary, and rollback. The plan itself grants none of
these actions.

- [ ] **Step 2: Populate independent exact-head evidence slots**

Product and Privacy each submit their own closed one-line GitHub Review command
emitted by the status CLI for the exact current digest; Product and Privacy use
distinct numeric actors. CODEOWNER, QA, Security, and machine checks populate
separate evidence slots. ADR-026 Legal remains out of scope for ADR-027. Release
authorization remains `NOT_AUTHORIZED`. Any push invalidates affected reviews,
receipts, and every unconsumed merge grant; an already appended consumption
remains immutable historical evidence and cannot authorize the new head.

- [ ] **Step 3: Independent verifier emits PRE_MERGE evidence**

Only the independently governed verifier may emit
`INDEPENDENT_EXTERNAL_VERIFIED`. A same-repository receipt returns
`APPROVAL_INDEPENDENCE_NOT_PROVEN`. The receipt binds proposed-sidecar bytes,
all distinct evidence slots, current authority/ruleset, and release
`NOT_AUTHORIZED`. `VERIFIED` still does not authorize merge.

- [ ] **Step 4: Stop for an immutable Proposal-stage merge grant**

Only an admitted `MERGE-AUTHORIZER` can issue a grant for this exact Proposal
PR/head after the user's separate external authorization. The verifier validates
a `program-c-merge-authorization-grant/v1` with stage `PROPOSAL_MERGE`, finite
validity, immutable bytes, and single-use nonce, then CAS-reserves that nonce in
the external durable ledger before at most one physical merge request. The
grant cannot be mutated or reused for Acceptance or Release. The decision and
machine-contract HOLDs remain open after merge.

- [ ] **Step 5: Append Proposal consumption and generate POST_MERGE receipt**

The independent post-merge workflow resolves the merged PR associated with the
main commit, proves result commit/method/current-main against the immutable
Proposal grant, appends `program-c-merge-authorization-consumption/v1`, proves
approved proposed-sidecar bytes in main, attests the receipt core/raw file, and
exports the evidence package. Response loss reconciles through the durable
nonce ledger and readback; it never triggers a second physical merge. No grant
or registry mutation occurs.

---

### Task 3: ADR-027 Acceptance PR

**Files:**

- Create: `docs/adr/027-program-c-suppression-propagation.md`
- Modify: `docs/adr/registry.md`
- Modify: `docs/governance/conflict-register.md`
- Modify: `scripts/governance-contracts.spec.mjs`
- Add independently verified Proposal/post-merge/Acceptance-revalidation evidence under `docs/evidence/governance-readback/adr-027/`

**Interfaces:**

- Produces accepted policy truth only.
- Consumes exact proposed-sidecar bytes, independent Proposal/post-merge receipts, and a fresh Acceptance-time live-revalidation receipt.

- [ ] **Step 1: Write RED acceptance tests**

Require `INDEPENDENT_EXTERNAL_VERIFIED`, receipt core/raw digests, attestations,
trusted-root provenance and a raw-receipt-SHA-named bundle,
exact proposed-sidecar bytes/digests, distinct Product/Privacy/CODEOWNER/QA/
Security/machine evidence slots, immutable Proposal grant and append-only
Proposal consumption, proposal
result commit on main, acceptance allowlist, current authority/ruleset, Release
`NOT_AUTHORIZED`, and no decision-byte change. Reject same-repo receipts and
missing/expired Acceptance revalidation.

- [ ] **Step 2: Implement the acceptance-only delta**

Use the deterministic accept command to copy exact proposed-sidecar bytes to the
ADR path; do not manually re-render. Registry becomes `ACCEPTED` only for the
decision. Close `HOLD_SUPPRESSION_DECISION`; keep
`HOLD_SUPPRESSION_MACHINE_CONTRACT` and every implementation/runtime/release
hold open. G1 remains AMBER.

- [ ] **Step 3: Run governance GREEN**

```bash
node --test --test-name-pattern='Program C suppression propagation' scripts/governance-contracts.spec.mjs
pnpm governance:verify
pnpm docs:verify
pnpm code-intelligence:scan
pnpm --filter @global/code-intelligence exec tsx src/cli.ts status --repo ../..
pnpm --filter @global/code-intelligence exec tsx src/cli.ts impact docs/adr/027-program-c-suppression-propagation.md docs/adr/registry.md docs/governance/conflict-register.md scripts/governance-contracts.spec.mjs docs/evidence/governance-readback/adr-027 --repo ../..
git diff --check
```

Expected: all governance/docs tests PASS while ADR-026 remains an honestly
asserted HOLD rather than a deliberately failing current-root test; the
Acceptance delta has exact-head ContractGraph status with zero errors and
complete impact coverage for every changed path.

- [ ] **Step 4: Generate Acceptance-time live-revalidation receipt**

The independent verifier must re-read the live Acceptance head, proposal/post-
merge receipts, authorities, ruleset, every evidence slot, exact sidecar bytes,
allowed-file delta, open contract/runtime/release HOLDs, and Release
`NOT_AUTHORIZED`. Any drift returns canonical `APPROVAL_*` and requires the
spec-defined recovery.

- [ ] **Step 5: Stop for a separate immutable Acceptance merge grant**

The user may externally authorize only the exact Acceptance PR/head after
revalidation; the admitted `MERGE-AUTHORIZER` then issues the immutable grant.
Validate a distinct `program-c-merge-authorization-grant/v1` with stage
`ACCEPTANCE_MERGE`, and CAS-reserve its nonce before one physical merge request;
Proposal grant or consumption reuse is
`APPROVAL_MERGE_AUTHORIZATION_STAGE_MISMATCH`.

Before requesting external authorization, commit the local Acceptance
candidate after independent code/security review:

```bash
git add docs/adr/027-program-c-suppression-propagation.md docs/adr/registry.md docs/governance/conflict-register.md scripts/governance-contracts.spec.mjs docs/evidence/governance-readback/adr-027
git commit -m "docs: accept adr 027 suppression policy"
```

- [ ] **Step 6: Merge/read back only after external authorization**

After the merge attempt, independent current-main readback proves the result
against the Acceptance grant, appends the separate Acceptance consumption, and
proves registry, ADR bytes, receipts, attestations, open/closed HOLDs, and
proposal identity. The grant remains byte-identical. Only then is ADR-027
`ACCEPTED`. No step authorizes Release.

---

### Task 4: Selected Suppression machine-contract lane

**Plan output:** `docs/superpowers/plans/2026-08-30-program-c-suppression-workspace-hold-contract.md`

- [ ] **Step 1: Write the exact separate machine-contract plan**

Use worktree `/global/backend/.codex/worktrees/program-c-suppression-workspace-hold-contract`, branch `codex/program-c-suppression-workspace-hold-contract`, and a base resolved from current clean `origin/main` only after ADR-027 current-main Acceptance readback. The approved output is `SuppressionPolicyRevisionChanged/v1`, PII-free, Workspace-bound, monotonic, replay-safe, gap fail-closed, and release-request-not-release. The task creates schemas/fixtures/contract tests only, not producer, migration, or GrowthOS consumer.

- [ ] **Step 2: Execute that plan in a separate worktree and PR**

Require separate Product/Privacy/CODEOWNER/QA/Security/machine evidence, Hosted
CI, exact user-authorized merge, and current-main readback. Only the verified
machine-contract result closes `HOLD_SUPPRESSION_MACHINE_CONTRACT`. It does not
close runtime, replay, closure, owner, admission, Release, or later gates.

Run before returning to ADR-026:

```bash
pnpm governance:verify
pnpm docs:verify
pnpm code-intelligence:scan
pnpm --filter @global/code-intelligence exec tsx src/cli.ts status --repo ../..
git diff --check
```

---

### Task 0B: ADR-026-only Legal authority and Legal input gate

**Files:**

- Modify only after an explicit separately authorized assignment: `docs/governance/approval-authorities.json`
- Create only after a real bounded Legal review: `docs/governance/decisions/ADR-026.legal-input.json`
- Modify: `scripts/governance-program-c-decision-preconditions.mjs`
- Modify: `scripts/governance-program-c-decision-preconditions.spec.mjs`
- Create: `scripts/fixtures/program-c-decisions/adr-026-legal-input.valid.json`

**Interfaces:**

- Produces `verifyAdr026LegalPreconditions(input): immutable ValidationResult`.
- Consumes the closed schema from Task 0C and real current-main Legal authority/readback.
- Is invoked only before ADR-026 final Privacy review; it is not a prerequisite for ADR-027.

- [ ] **Step 1: Write RED Legal authority/input tests**

Require `LEGAL-REVIEW` numeric actor mapping admitted in a separate current-main
authority revision, exact ADR-026 policy revision/raw/semantic digests, all
applicable scopes, `NO_BLOCKER_RECORDED`, exact reviewed head, finite
`valid_until`, active revocation status, and independent readback. Mutation-test
unassigned/inferred actor, Product/Privacy/QA/CODEOWNER substitution, wrong
scope/digest/head, expiry, supersession, revocation, free-form case text, PII,
and unknown fields.

```bash
node --test --test-name-pattern='ADR-026 Legal preconditions' scripts/governance-program-c-decision-preconditions.spec.mjs
```

Expected at the currently documented state: fixture tests can be GREEN, but the
actual-state projection returns `APPROVAL_LEGAL_AUTHORITY_UNASSIGNED` and
`APPROVAL_LEGAL_INPUT_REQUIRED`. The test process itself exits PASS because it
asserts those HOLD findings.

- [ ] **Step 2: Stop for real authority and Legal decisions**

Do not populate actor IDs, logins, node IDs, review IDs, scope, status,
timestamps, expiry, evidence, or revocation by inference. A separate user
decision, authority-assignment PR, actual Legal review, and independent
readback must occur before an actual-state PASS. The plan does not provide
legal advice.

- [ ] **Step 3: Implement the validator, run GREEN-with-current-HOLD, and commit**

```bash
node --test scripts/governance-program-c-decision-preconditions.spec.mjs
node --test --experimental-test-coverage --test-coverage-include=scripts/governance-program-c-decision-preconditions.mjs scripts/governance-program-c-decision-preconditions.spec.mjs
pnpm governance:verify
pnpm docs:verify
git diff --check
git add scripts/governance-program-c-decision-preconditions.mjs scripts/governance-program-c-decision-preconditions.spec.mjs scripts/fixtures/program-c-decisions/adr-026-legal-input.valid.json
git commit -m "feat: verify adr 026 legal preconditions"
```

The modified precondition executable must retain at least 80% statements and
branches after the Legal authority/input paths are added.

Fixture tests PASS while the actual-state projection honestly returns HOLD.
Only a real current-main `NO_BLOCKER_RECORDED` input can later satisfy ADR-026.
Commit the real Legal input in its own separately authorized evidence-bearing
PR, never in an identity-assignment PR or decision PR. After that PR merges,
independent readback must make the actual-state projection PASS before Task 5.

---

### Task 5: ADR-026 deterministic Proposal subject

**Files:**

- Create: `docs/governance/decisions/ADR-026.proposal.json`
- Create: `docs/governance/decisions/ADR-026.proposed-sidecar.md`
- Modify: `scripts/governance-program-c-decision-subject.mjs`
- Modify: `scripts/governance-program-c-decision-subject.spec.mjs`
- Modify: `scripts/governance-contracts.spec.mjs`
- Create: `scripts/fixtures/program-c-decisions/adr-026-proposal.valid.json`
- Create: `scripts/fixtures/program-c-decisions/adr-026-proposed-sidecar.expected.md`

**Interfaces:**

- Produces exact proposed-sidecar bytes and a `PROPOSED_NOT_ACCEPTED` Retention/Admission subject.
- Consumes accepted/current-main ADR-027, merged/current-main Suppression machine contract, Task 0A, Task 0B Legal PASS, and independent verifier trust.

- [ ] **Step 1: Write RED proposal tests**

Bind the Product-approved recommendation:

```text
CANDIDATE full snapshot = 180 days
CLOSED non-PII history = 730 days
CLOSED contact refs = 30 days
contact tombstone = earliest(closed+30 days, candidate_created+180 days, valid_until+30 days)
null valid_until fallback = candidate_created+30 days
receipt delete = later(terminal+730, source-non-replayable+90)
Legal hold review <= 90 days
Workspace grace = 30 days
encrypted export artifact TTL = 24 hours
quarantine raw payload persisted = false
quarantine raw payload retention = 0 days
quarantine metadata retention = 90 days
admission = DISABLED by default
existing Workspace auto-enable = NO
historical full replay = NO
```

The proposal records `HOLD_SOURCE_REPLAY_HORIZON` and
`HOLD_WORKSPACE_CLOSURE_CONTRACT` independently. If either contract is absent,
receipt deletion cannot execute and admission remains disabled; ADR-026 policy
acceptance may not pretend those machine/runtime prerequisites exist. Privacy
and Legal approve only the stated policy and fail-closed unresolved behavior,
not a nonexistent replay or closure implementation.

- [ ] **Step 2: Commit RED**

```bash
git add scripts/governance-program-c-decision-subject.spec.mjs scripts/governance-contracts.spec.mjs scripts/fixtures/program-c-decisions/adr-026-proposal.valid.json scripts/fixtures/program-c-decisions/adr-026-proposed-sidecar.expected.md
git commit -m "test: specify adr 026 trusted proposal"
```

- [ ] **Step 3: Render the proposed-sidecar and manifest after Task 0A/0B PASS**

Bind renderer version/source digest, raw path/length/SHA-256, semantic SHA-256,
all exact Product values, Privacy/Legal evidence requirements, distinct evidence
slots, and every open replay/closure/runtime/owner/Release HOLD. Keep final
ADR-026 sidecar absent, registry without `ACCEPTED`, all ADR-026 policy/admission
HOLDs open, and Program C disabled.

- [ ] **Step 4: Run full local GREEN, ContractGraph, and commit**

```bash
node --test scripts/governance-program-c-decision-subject.spec.mjs
node --test --experimental-test-coverage --test-coverage-include=scripts/governance-program-c-decision-subject.mjs scripts/governance-program-c-decision-subject.spec.mjs
node --test --test-name-pattern='Program C retention and admission' scripts/governance-contracts.spec.mjs
pnpm governance:verify
pnpm docs:verify
pnpm code-intelligence:scan
pnpm --filter @global/code-intelligence exec tsx src/cli.ts status --repo ../..
pnpm --filter @global/code-intelligence exec tsx src/cli.ts impact docs/governance/decisions/ADR-026.proposal.json docs/governance/decisions/ADR-026.proposed-sidecar.md scripts/governance-program-c-decision-subject.mjs scripts/governance-contracts.spec.mjs --repo ../..
git diff --check
```

Expected: all PASS; ADR-026 remains `PROPOSED_NOT_ACCEPTED`, Program C remains
disabled, every unresolved HOLD is asserted, and the modified renderer retains
at least 80% statements and branches. After an independent local
code/security review with 0 Critical/High/Medium:

```bash
git add docs/governance/decisions/ADR-026.proposal.json docs/governance/decisions/ADR-026.proposed-sidecar.md scripts/governance-program-c-decision-subject.mjs scripts/governance-program-c-decision-subject.spec.mjs scripts/governance-contracts.spec.mjs scripts/fixtures/program-c-decisions/adr-026-proposal.valid.json scripts/fixtures/program-c-decisions/adr-026-proposed-sidecar.expected.md
git commit -m "docs: propose adr 026 retention and admission policy"
```

Stop before push/PR. Local review is not Product/Privacy/Legal/CODEOWNER/QA
approval.

---

### Task 6: ADR-026 Proposal and Acceptance PRs

**Files for the Acceptance PR:**

- Create: `docs/adr/026-program-c-handoff-retention-and-admission.md`
- Modify: `docs/adr/registry.md`
- Modify: `docs/governance/conflict-register.md`
- Modify: `scripts/governance-contracts.spec.mjs`
- Add independent evidence under `docs/evidence/governance-readback/adr-026/`

- [ ] **Step 1: Stop for exact ADR-026 Proposal push/PR authorization**

The authorization binds repository, branch, exact head, PR title/body,
reviewers, no-merge boundary, and rollback. No action in this plan grants it.

- [ ] **Step 2: Collect exact-head role-specific evidence in this order**

```text
Proposal PR
→ exact-head Product review
→ current exact-digest Legal NO_BLOCKER input from admitted Legal authority
→ exact-head Privacy review
→ distinct CODEOWNER review
→ distinct QA evidence review
→ distinct Security review
→ exact-head machine checks
→ independent PRE_MERGE receipt
→ immutable PROPOSAL_MERGE grant from admitted MERGE-AUTHORIZER
→ durable nonce CAS reservation
→ proposal merge
→ append-only Proposal consumption after result/current-main readback
→ independent attested POST_MERGE receipt bound to grant + consumption
→ Acceptance PR
→ exact proposed-sidecar byte copy and acceptance allowlist
→ independent ACCEPTANCE_REVALIDATION receipt
→ immutable ACCEPTANCE_MERGE grant from admitted MERGE-AUTHORIZER
→ durable nonce CAS reservation
→ acceptance merge
→ append-only Acceptance consumption after independent current-main readback
```

Any push or authority/Legal/ruleset/verifier/receipt drift follows the spec
transition matrix and invalidates the affected evidence. Same-repository
receipts fail with `APPROVAL_INDEPENDENCE_NOT_PROVEN`.

- [ ] **Step 3: Write RED Acceptance tests**

Require exact proposed-sidecar bytes, independent Proposal/post-merge receipts,
fresh Acceptance revalidation, distinct evidence slots, Legal scope/digest/
expiry/revocation, immutable Proposal grant and append-only consumption, a fresh
immutable Acceptance grant, durable nonce reservation, receipt core/raw digest
validation, trusted-root provenance, raw-receipt-SHA bundle naming, acceptance
allowlist, current authority/ruleset, and Release
`NOT_AUTHORIZED`. Reject every missing, reused, stale, same-repository,
wrong-stage, CAS-conflicted, ACK-unknown-without-reconciliation, mutated-grant,
or drifted input independently.

- [ ] **Step 4: Implement the Acceptance-only delta**

Use the deterministic accept command; never manually re-render the sidecar.
Registry becomes `ACCEPTED` only for ADR-026 policy. Close only
`HOLD_PROGRAM_C_RETENTION_POLICY` and
`HOLD_CAPABILITY_ADMISSION_POLICY`. Keep Program C subscription `DISABLED` and
keep runtime/replay/closure/owner/Builder/migration/remote-CI/Release/UAT/Pilot/
GA holds open.

- [ ] **Step 5: Run local GREEN and ContractGraph**

```bash
node --test --test-name-pattern='Program C retention and admission' scripts/governance-contracts.spec.mjs
node --test scripts/governance-program-c-decision-subject.spec.mjs scripts/governance-approval-readback.spec.mjs scripts/governance-approval-status.spec.mjs
pnpm governance:verify
pnpm docs:verify
pnpm code-intelligence:scan
pnpm --filter @global/code-intelligence exec tsx src/cli.ts status --repo ../..
pnpm --filter @global/code-intelligence exec tsx src/cli.ts impact docs/adr/026-program-c-handoff-retention-and-admission.md docs/adr/registry.md docs/governance/conflict-register.md scripts/governance-contracts.spec.mjs docs/evidence/governance-readback/adr-026 --repo ../..
git diff --check
```

Expected: all PASS, graph exact-head clean/zero errors, policy accepted only in
the candidate Acceptance tree, admission still disabled, no later gate inferred.

- [ ] **Step 6: Commit locally, then stop for external Acceptance gates**

```bash
git add docs/adr/026-program-c-handoff-retention-and-admission.md docs/adr/registry.md docs/governance/conflict-register.md scripts/governance-contracts.spec.mjs docs/evidence/governance-readback/adr-026
git commit -m "docs: accept adr 026 retention policy"
```

Then obtain independent Acceptance-time live revalidation, a separate exact-
head immutable Acceptance grant, durable nonce reservation, at most one
physical merge request, append-only consumption, and independent current-main
readback. The commit itself does not grant any external action or make the
policy effective.

---

### Task 7: Final Program C G1 readback

**Files:**

- Modify: `docs/status/current.md`
- Modify: `docs/governance/conflict-register.md`
- Modify: `scripts/governance-contracts.spec.mjs`

- [ ] **Step 1: Re-read current main and all receipt subjects**

Prove ADR-027, selected machine contract, ADR-026, owner registry, closed
exact-head Security evidence from the admitted `OWN-SECURITY`, Legal input,
MERGE-AUTHORIZER authority, immutable Proposal/Acceptance grants, durable nonce
ledger reservations, append-only Proposal/Acceptance consumptions,
proposal/post-merge/Acceptance-revalidation receipts, receipt core/raw digests,
attestations, live ruleset, and current-main bytes. Re-read all facts live at
acceptance time; historical receipt URLs or earlier CLI output are insufficient.

- [ ] **Step 2: Recompute G1 without promoting later gates**

G1 may pass only if every G1 contract condition is current. If owner, replay
horizon, Workspace closure, or other G1 contracts remain unresolved, G1 stays
AMBER with the exact HOLD; ADR acceptance cannot promote it. G2/G3/Runtime/
Release/UAT/Pilot remain unchanged.

Run:

```bash
node --test scripts/governance-contracts.spec.mjs scripts/governance-program-c-decision-preconditions.spec.mjs scripts/governance-program-c-decision-subject.spec.mjs scripts/governance-approval-readback.spec.mjs scripts/governance-merge-authorization-ledger.spec.mjs scripts/governance-approval-status.spec.mjs
pnpm governance:verify
pnpm docs:verify
pnpm code-intelligence:scan
pnpm --filter @global/code-intelligence exec tsx src/cli.ts status --repo ../..
pnpm --filter @global/code-intelligence exec tsx src/cli.ts impact docs/adr/026-program-c-handoff-retention-and-admission.md docs/adr/027-program-c-suppression-propagation.md docs/adr/registry.md docs/status/current.md docs/governance/conflict-register.md scripts/governance-contracts.spec.mjs --repo ../..
git diff --check
```

Require all tests PASS, ContractGraph exact-head clean with zero errors, and no
unexplained relationship. Static graph evidence is not Runtime/Release proof.

- [ ] **Step 3: Only then resume GrowthOS Task 6 admission plan**

Re-read Builder/patch ownership. Patch 0038 being free is not sufficient; Builder authority, remote CI, and clean source must be accepted.

- [ ] **Step 4: Commit only the evidence-derived current status**

```bash
git add docs/status/current.md docs/governance/conflict-register.md scripts/governance-contracts.spec.mjs
git commit -m "docs: record program c decision gate readback"
```

Stop before push/PR/merge. A later status PR requires its own external
authorization and current-main readback.

## Exit Criteria

```text
ADR-027 proposal/receipt/acceptance      = current-main verified
Suppression machine contract             = current-main verified
ADR-026 proposal/receipt/acceptance      = current-main verified
Product/Privacy/Legal roles              = trusted and current
CODEOWNER/QA/Security/machine slots      = separate and current
Proposal/Acceptance merge grants        = separate / immutable / current
Proposal/Acceptance consumptions        = append-only / ledger-bound / read back
Acceptance-time live revalidation        = current / independent
Live ruleset                             = parity PASS
Program C subscription                   = still DISABLED until admission gates
G1                                       = evaluated from current evidence
G2/G3/Runtime/Release/UAT/Pilot          = not inferred
Release authorization                    = NOT_AUTHORIZED by this plan
```

## Plan self-review and no-external-action closeout

Before any executor calls this plan complete, run:

```bash
plan_scan_pattern='T''BD|TO''DO|implement late''r|similar to Tas''k|if the verifier foundatio''n|intentional RE''D|quarantine raw = NEVE''R|HOLD_SUPPRESSION_PROPAGATION_CONTRAC''T|HOLD_CAPABILITY_ADMISSIO''N(?![_A-Z])|program-c-merge-authorization/v''1|program-c-merge-authorization[.]schema[.]jso''n|consumed_merge_commi''t|Proposal merge authorizatio''n|Acceptance merge authorizatio''n'
rg --pcre2 -n "$plan_scan_pattern" docs/superpowers/plans/2026-08-30-program-c-adr-trusted-acceptance.md
git diff --check
git status --short --branch
```

The `rg` command must return no matches. External actions remain `NONE` until a
later user authorization names the exact action, repository, PR/head, scope,
cost/data boundary, and rollback. This plan never assigns a real Privacy, Legal,
QA, CODEOWNER, Security, verifier administrator, merge authorizer, or Release
authorizer identity.
