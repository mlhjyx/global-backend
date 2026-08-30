# Trusted Approval Readback Hosted Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bootstrap trusted hosted approval readback, attested receipts, canary evidence, independent verifier placement, and live ruleset parity without allowing the bootstrap workflow or its introducing PR to self-verify.

**Architecture:** A same-repository trusted-base workflow is introduced first as a non-required canary and may emit only `TRUSTED_BASE_VERIFIED`. Its only privileged pre-merge trigger is `pull_request_target`; review submission, review comments, callers, and manual/dispatch events cannot start an OIDC/attestation-capable run. Operational recovery may only re-run an existing trusted workflow run and re-query current reviews. After the canary is merged and observed, an independently governed reusable workflow can become the signer for `INDEPENDENT_EXTERNAL_VERIFIED`, but only through a separately authorized repository-specific implementation plan. Live ruleset changes occur only after workflow identity, exact machine/file allowlists, reviewer availability, and `bypass_actors=[]` are proven, and a second PR enables consumers with mandatory acceptance-time revalidation.

**Tech Stack:** GitHub Actions, GitHub REST API, `actions/attest`, `actions/upload-artifact`, Sigstore bundles, GitHub CLI offline verification, repository rulesets.

**Spec:** `docs/governance/trusted-approval-readback-spec.md`

## Global Constraints

- This plan consumes a merged and independently reviewed local foundation from `2026-08-30-trusted-approval-readback-local-foundation.md`.
- External actions are split into explicit gates. No push, PR, workflow run, repository creation, App installation, ruleset update, credential change, or merge is authorized by the plan itself.
- The introducing PR cannot be verified by the workflow it introduces.
- No privileged workflow may checkout, fetch, download-and-execute, install, build, or run PR head/merge content.
- PR files are read only as bounded bytes through the GitHub API and validated by trusted base code.
- Trusted policy contains exact allowlists for PR-readable file paths, required/canary context names, GitHub Actions App IDs, workflow numeric IDs/paths, trusted-base workflow blob SHAs, run events, and independently reusable signer workflow IDs/paths. Check run and check suite IDs are dynamic per-receipt observations whose association with those static identities is revalidated; they are never static allowlist entries. No observed path or workflow outside the static allowlists is admitted.
- Same-repository canary output is `TRUSTED_BASE_VERIFIED`, not external independence.
- `INDEPENDENT_EXTERNAL_VERIFIED` requires a separately governed signer trust root.
- Every action uses a 40-character official commit and is registered in `.github/required-contexts.json`.
- Existing official action pins must not move backward or revert to tags. The canary adds only `actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4.2.2` and `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2` to the already reviewed checkout/setup-node pins.
- Workflow artifacts are transport only; receipt bytes and Sigstore attestations carry provenance.
- An evidence package is incomplete without the exact trusted-root bytes and SHA-256, `acquired_at`, exact `gh 2.89.0` identity, and TUF/Sigstore source provenance. Artifact URLs are never evidence.
- Product, Privacy, Legal, QA, merge, Release, Pilot, and GA remain separate gates.
- Live production parity is exact: two approving reviews, CODEOWNER review, last-push approval, stale-review dismissal, thread resolution, strict required contexts, deletion/non-fast-forward protection, and `bypass_actors=[]`. Any non-empty bypass list keeps consumers disabled; this plan defines no bypass mode.

---

### Task 1: Same-repository trusted-base workflow contract RED

**Files:**

- Create: `scripts/governance-approval-workflow-contract.spec.mjs`
- Modify: `scripts/governance-ci-topology.spec.mjs`
- Modify: `scripts/supply-chain-gates.spec.mjs`

**Interfaces:**

- Produces machine requirements for `.github/workflows/trusted-approval-readback.yml` and `.github/workflows/governance-merge-readback.yml`.
- Consumes local foundation scripts only.

- [ ] **Step 1: Write RED workflow tests**

Require:

```text
trusted default-branch workflow code
exact base SHA checkout
persist-credentials:false
no PR head/merge checkout
no gh pr checkout
no PR ref git fetch
no PR artifact execution
no PR package install/build/script execution
GitHub-hosted runner
minimal permissions
receipt only after pure validator PASS
actions/attest exact pin
actions/upload-artifact exact pin
exact non-required context names:
  trusted approval readback · canary
  governance merge readback · canary
privileged pre-merge trigger set is exactly pull_request_target
no pull_request, pull_request_review, pull_request_review_comment, workflow_dispatch, repository_dispatch, or caller-supplied workflow_call
either same-repository bootstrap workflow with id-token:write, attestations:write, or actions/attest rejects those forbidden triggers even if another safe trigger is also present
review recovery only through re-run of the same existing trusted run; the re-run accepts no caller input and re-queries current reviews
exact workflow/file/App/check allowlists
static machine policy pins Actions App, context, workflow ID/path, trusted-base blob SHA, and reusable signer only
receipt dynamically records check-run/check-suite/run IDs and verifies their association with the pinned static identities
acceptance result requires fresh review/authority/Legal/ruleset/diff revalidation
live bypass_actors must be []
every pre-existing workflow_action_pin remains byte-identical; missing, downgraded, reordered, tag-based, or substituted pins fail
no ADR/HOLD/Release mutation
```

Run:

```bash
node --test scripts/governance-approval-workflow-contract.spec.mjs scripts/governance-ci-topology.spec.mjs scripts/supply-chain-gates.spec.mjs
```

Expected: FAIL because both workflows are absent.

- [ ] **Step 2: Commit RED**

```bash
git add scripts/governance-approval-workflow-contract.spec.mjs scripts/governance-ci-topology.spec.mjs scripts/supply-chain-gates.spec.mjs
git commit -m "test: specify trusted approval workflow bootstrap"
```

---

### Task 2: Add non-required same-repository canary workflows

**Files:**

- Create: `.github/workflows/trusted-approval-readback.yml`
- Create: `.github/workflows/governance-merge-readback.yml`
- Modify: `.github/required-contexts.json`
- Modify: `scripts/governance-ci-contracts.mjs`
- Modify: `scripts/governance-contracts.spec.mjs`

**Interfaces:**

- Produces `TRUSTED_BASE_VERIFIED` receipt artifacts and post-merge receipts.
- Consumes the local foundation scripts from trusted base only.

- [ ] **Step 1: Implement the pre-merge canary workflow**

Exact job/context name:

```text
trusted approval readback · canary
```

Triggers:

```yaml
pull_request_target:
  types:
    [
      opened,
      edited,
      synchronize,
      reopened,
      ready_for_review,
      converted_to_draft,
    ]
```

There is no `pull_request`, `pull_request_review`, `pull_request_review_comment`, `workflow_dispatch`, `repository_dispatch`, `issue_comment`, or `workflow_call` entry. The workflow-contract test must reject any occurrence of those triggers in a workflow that has `id-token: write`, `attestations: write`, or invokes `actions/attest`, including a `workflow_call` whose caller supplies PR/ref/path/digest inputs. A failed, interrupted, or review-stale observation may be recovered only by re-running that same existing trusted `pull_request_target` run through the GitHub Actions rerun control after separate authorization; the rerun reuses the immutable original event association, accepts no input, and re-queries all current reviews.

Permissions:

```yaml
contents: read
pull-requests: read
checks: read
actions: read
id-token: write
attestations: write
```

Steps use these pins:

```text
actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7
actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4.2.2
actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
```

The workflow checks out only `pull_request.base.sha`, reads only exact-policy-allowlisted proposal paths through the API, and never executes head content. Static policy pins the Actions App, context, workflow numeric ID/path, trusted-base workflow blob SHA, and reusable signer identity. Each receipt dynamically records check-run/check-suite/run IDs and proves their API association with that pinned tuple; a prior receipt's dynamic IDs are not a policy allowlist. The canary emits only synthetic evidence labeled `TRUSTED_BASE_VERIFIED / NOT_INDEPENDENT`. It never renders the policy workflow state `VERIFIED` or `ACCEPTED`, never satisfies an ADR/Release consumer, and never emits `INDEPENDENT_EXTERNAL_VERIFIED`. Fresh pre/post PR head, authority, Legal, live ruleset with `bypass_actors=[]`, machine-check, and acceptance-diff readback are still required to make the canary observation internally consistent.

- [ ] **Step 2: Implement the post-merge workflow**

Trigger:

```yaml
pull_request_target:
  types: [closed]
```

Exact job/context name:

```text
governance merge readback · canary
```

It requires `merged=true`, base `main`, resolves the exact PR/merge identity through the API, proves the result commit is on main, re-reads the exact allowlisted approved bytes, and emits `POST_MERGE` receipt evidence. It has no manual/dispatch trigger and never changes ADR registry or source.

- [ ] **Step 3: Extend the machine policy with a closed non-required canary surface**

Add this exact top-level field to `.github/required-contexts.json` and teach `validateRequiredContexts()` to reject unknown/duplicate canary names, missing workflows, wrong events, `required:true`, name collisions with `required_contexts`, workflow/job-name drift, and any canary inserted into live required contexts:

```json
{
  "canary_contexts": [
    {
      "name": "trusted approval readback · canary",
      "workflow": ".github/workflows/trusted-approval-readback.yml",
      "events": ["pull_request_target"],
      "required": false
    },
    {
      "name": "governance merge readback · canary",
      "workflow": ".github/workflows/governance-merge-readback.yml",
      "events": ["pull_request_target"],
      "required": false
    }
  ]
}
```

Add a closed `trusted_approval_readback_policy` with these initial exact path/name allowlists. Numeric workflow/App identities and trusted-base workflow blob SHAs remain `UNOBSERVED` in the non-required canary policy and cannot satisfy a consumer until Task 3 live readback and Task 6 second-PR admission bind the observed static IDs. Dynamic check-run/check-suite/run IDs remain receipt evidence and are never copied into this policy:

```json
{
  "allowed_pr_subject_paths": [
    "docs/governance/decisions/TRUSTED-APPROVAL-CANARY.proposal.json",
    "docs/governance/decisions/ADR-026.proposal.json",
    "docs/governance/decisions/ADR-026.proposed-sidecar.md",
    "docs/governance/decisions/ADR-027.proposal.json",
    "docs/governance/decisions/ADR-027.proposed-sidecar.md"
  ],
  "allowed_check_contexts": [
    "renderer visual scope",
    "build · typecheck · test",
    "contracts · drift · lint · breaking",
    "gitleaks 密钥扫描",
    "governance · traceability · release"
  ],
  "allowed_workflow_paths": [
    ".github/workflows/ci.yml",
    ".github/workflows/security.yml",
    ".github/workflows/governance.yml",
    ".github/workflows/trusted-approval-readback.yml",
    ".github/workflows/governance-merge-readback.yml"
  ],
  "numeric_identity_state": "UNOBSERVED"
}
```

Reject directory prefixes, glob/wildcard paths, case aliases, URL-encoded aliases, path traversal, and a PR that changes any trusted allowlist/policy/workflow while asking that changed value to approve itself.

Register the four existing checkout/setup-node pins plus the exact attest/upload pins for both workflows as used; do not change or remove any existing workflow pin. Add exact canary workflow/file/Actions-App/check-context/workflow-ID-and-path/trusted-base-blob/reusable-signer allowlists to the same closed policy and mutation-test every missing, extra, reordered, aliased, or head-controlled entry. Reject `allowed_check_run_ids`, `allowed_check_suite_ids`, and any equivalent static run/suite identity field.

- [ ] **Step 4: Run workflow GREEN locally**

```bash
node --test scripts/governance-approval-workflow-contract.spec.mjs scripts/governance-ci-topology.spec.mjs scripts/supply-chain-gates.spec.mjs
node --test --experimental-test-coverage --test-coverage-include=scripts/governance-ci-contracts.mjs scripts/governance-approval-workflow-contract.spec.mjs scripts/governance-contracts.spec.mjs scripts/governance-ci-topology.spec.mjs
pnpm governance:verify
pnpm docs:verify
git diff --check
```

Expected: PASS; both exact contexts are present only in `canary_contexts`, have `required:false`, and are absent from `required_contexts` and the live required-status-check list; changed `governance-ci-contracts.mjs` statements and branches are both at least 80%.

- [ ] **Step 5: Independent workflow security review and commit**

Review pwn-request paths, permissions, action pins, shell injection, artifact use, OIDC, and no false trust status. Commit after 0 Critical/High/Medium:

```bash
git add .github/workflows/trusted-approval-readback.yml .github/workflows/governance-merge-readback.yml .github/required-contexts.json scripts/governance-approval-workflow-contract.spec.mjs scripts/governance-ci-contracts.mjs scripts/governance-contracts.spec.mjs scripts/governance-ci-topology.spec.mjs scripts/supply-chain-gates.spec.mjs
git commit -m "feat: add trusted approval readback canary workflows"
```

External action reached: stop before push or PR creation.

---

### Task 3: Hosted canary run card

**Files:**

- Create after an authorized run: `docs/evidence/governance-readback/canary/sha256-<receipt-raw-sha256-without-prefix>/approval-receipt.json`
- Create after an authorized run: `docs/evidence/governance-readback/canary/sha256-<receipt-raw-sha256-without-prefix>/approval-receipt-core.sha256`
- Create after an authorized run: `docs/evidence/governance-readback/canary/sha256-<receipt-raw-sha256-without-prefix>/approval-receipt-raw.sha256`
- Create after an authorized run: `docs/evidence/governance-readback/canary/sha256-<receipt-raw-sha256-without-prefix>/sha256-<receipt-raw-sha256-without-prefix>.jsonl`
- Create after an authorized run: `docs/evidence/governance-readback/canary/sha256-<receipt-raw-sha256-without-prefix>/trusted_root.jsonl`
- Create after an authorized run: `docs/evidence/governance-readback/canary/sha256-<receipt-raw-sha256-without-prefix>/verification-command.json`
- Create after an authorized run: `docs/evidence/governance-readback/canary/sha256-<receipt-raw-sha256-without-prefix>/evidence-manifest.json`

**Interfaces:**

- Produces hosted observation only; does not create Product/Privacy approval.

- [ ] **Step 1: Stop for exact external authorization**

The run card must name:

```text
repository and exact commit
workflow path and expected signer digest
canary PR number/head
synthetic decision ID
synthetic subject path = docs/governance/decisions/TRUSTED-APPROVAL-CANARY.proposal.json
synthetic subject bytes/digest and exact canary head containing only the allowlisted fixture delta
GitHub token permission readback
cost = zero
data = synthetic / no PII
artifact retention = 90 days
exact gh path/version = /opt/global/toolchains/gh/2.89.0/bin/gh / 2.89.0
trusted root acquisition = gh 2.89.0 attestation trusted-root
trusted root source = Sigstore/GitHub TUF metadata read through exact gh command
monitoring and cleanup
```

- [ ] **Step 2: After authorization, run the non-required canary**

Verify:

```text
workflow uses main/base code
PR head is never executed
only the original pull_request_target event or separately authorized rerun of that exact existing trusted run
check association and stable context name
API pagination and ruleset fields readable
receipt artifact uploaded
attestation created
exact `sha256-<receipt-raw-sha256-without-prefix>.jsonl` Sigstore bundle downloaded
fixed `trusted_root.jsonl` acquired with exact gh 2.89.0
trusted root SHA-256/acquired_at/gh version/TUF source provenance recorded
online and offline verification pass
signer/source/runner constraints match
```

- [ ] **Step 3: Record evidence and independent readback**

The canary remains `TRUSTED_BASE_VERIFIED / NOT_INDEPENDENT`. A separate reviewer reads back workflow run, receipt core/raw digests, attestation identity, exact bundle SHA, trusted-root bytes/SHA/acquisition time, `gh 2.89.0` executable identity, TUF/Sigstore source provenance, and local offline verification.

The committed `evidence-manifest.json` is strict `trusted-approval-evidence-manifest/v1` and must bind every package path and SHA-256, `receipt_core_sha256`, `receipt_raw_sha256`, an attestation subject digest exactly equal to `receipt_raw_sha256`, signer identity, trusted-root SHA/acquired-at, exact gh version/path/binary digest, verification command arguments, run ID/attempt/event, and trust class. The evidence-package directory and exact `sha256-<receipt-raw-sha256-without-prefix>.jsonl` Sigstore bundle are derived from `receipt_raw_sha256`; `receipt_core_sha256`, receipt ID, run ID, caller text, and a `core_digest` alias are rejected as bundle/package identity. The trusted-root and verification-command filenames remain exact `trusted_root.jsonl` and `verification-command.json`, with their bytes and provenance bound by the manifest. Missing trusted root or toolchain provenance is `APPROVAL_EVIDENCE_BUNDLE_REQUIRED`; an artifact URL cannot substitute.

---

### Task 4: Independent verifier trust root

**External target:** recommended repository `mlhjyx/global-governance-verifier`.

**Interfaces:**

- Produces an independently governed reusable signer workflow.
- Consumes only bounded subject-repository metadata and decision bytes.

- [ ] **Step 1: Stop for organization and administrator decision**

User must decide:

```text
repository owner
at least one administrator distinct from the subject repository writer
GitHub App installation and read-only subject-repo permissions
Product/Privacy actor policy
evidence retention
incident/revocation owner
```

No repository or App may be created by inference.

- [ ] **Step 2: STOP and write a repository-specific implementation plan only after authorization**

This Task intentionally does not implement the independent repository and cannot be marked complete from this Backend plan. After the user authorizes the repository owner, distinct administrators, GitHub App, permissions, retention, revocation owner, credential boundary, and shared durable storage boundary, create a new plan in that repository. The new plan must name its exact initial commit/base, worktree/branch, CODEOWNERS/ruleset, workflow files, reusable `workflow_call` inputs/outputs, App installation authentication adapter, bounded subject-repository API allowlist, receipt/predicate schemas, exact action pins, TDD RED/GREEN commands, statements/branches coverage ≥80%, commit scopes, cross-repository canary, offline verification, rollback, and external stop gates. It must also implement the local foundation's `DurableMergeAuthorizationNonceLedger` against shared durable storage with atomic compare-and-swap; test concurrent consumers, stale expected revisions, crash/restart, commit-before-response loss, byte-identical idempotent recovery, and different-payload replay rejection. Workflow artifacts, job outputs, process memory, caches, and mutable grant status are forbidden ledger backends.

Until that separately reviewed plan is executed, merged, and observed:

```text
independent signer repository       = NOT_CREATED / EXTERNAL_ACTION_REQUIRED
independent reusable workflow       = NOT_IMPLEMENTED
independent GitHub App              = NOT_INSTALLED
cross-repository canary             = NOT_RUN
INDEPENDENT_EXTERNAL_VERIFIED       = FORBIDDEN
Release external provenance         = EXTERNAL_UNVERIFIED
```

Only the future repository-specific lane may emit `INDEPENDENT_EXTERNAL_VERIFIED`; this Task is a deliberate STOP/HANDOFF, not an executable implementation placeholder.

---

### Task 5: Live ruleset parity external action

**Live target:** ruleset `protect-main`, ID `18617745`.

**Interfaces:**

- Produces platform enforcement; repository files remain documentary until API readback.

- [ ] **Step 1: Resolve reviewer viability before mutation**

Do not enable CODEOWNER review while `.github/CODEOWNERS` has only the PR author as a viable reviewer. A second qualified reviewer and machine authority mapping must exist first.

- [ ] **Step 2: Prepare exact desired ruleset**

Default production recommendation:

```text
required approving reviews       = 2
require CODEOWNER review          = true
dismiss stale reviews on push     = true
require last-push approval        = true
require thread resolution         = true
strict required checks            = true
force push                        = false
deletion                          = false
bypass_actors                     = []
```

No `RepositoryRole`, Team, App, User, deploy key, pull-request-only, or always bypass is admitted by this plan. Any future bypass request is a separate governance decision/schema/plan, and consumers remain disabled unless a later approved policy explicitly replaces this empty-list contract.

If the user selects the 30-day dual-role exception, the ruleset still needs at least two distinct human actors through the required third Legal/QA coapprover.

- [ ] **Step 3: Stop for exact ruleset mutation authorization**

Approval must identify ruleset ID, before digest, desired after digest, actor, rollback JSON, and readback command.

- [ ] **Step 4: Apply and read back after authorization**

Read back the complete live ruleset, two approving reviews, CODEOWNER review, last-push approval, stale-review dismissal, thread resolution, strict required contexts, deletion/non-fast-forward protection, `bypass_actors=[]`, required contexts, and a canary rule-suite evaluation. Repository declarations are updated only after live readback succeeds and must match those exact values; any omitted/extra bypass actor or weaker review field is `APPROVAL_RULESET_DRIFT`.

---

### Task 6: Enable fail-closed consumers in a second PR

**Files:**

- Modify: `.github/required-contexts.json`
- Modify: `.github/CODEOWNERS`
- Modify: `scripts/governance-ci-contracts.mjs`
- Modify: `scripts/governance-delivery-contracts.mjs`
- Modify: `scripts/governance-contracts.spec.mjs`
- Modify: `scripts/governance-verify.mjs`
- Create: `scripts/governance-verify.spec.mjs`
- Modify: `docs/governance/release-bundle.schema.json`
- Modify: `docs/templates/release-bundle.template.json`
- Modify: `docs/governance/README.md`
- Modify: `docs/governance/docs-verification.md`
- Modify: `docs/evidence/governance-readback/README.md`
- Create: `scripts/fixtures/governance-approval-consumers/verified-independent-receipt.json`
- Create: `scripts/fixtures/governance-approval-consumers/revoked-receipt.json`
- Create: `scripts/fixtures/governance-approval-consumers/superseded-receipt.json`
- Create: `scripts/fixtures/governance-approval-consumers/merge-authorization-grant.json`
- Create: `scripts/fixtures/governance-approval-consumers/merge-authorization-consumption.json`
- Create: `scripts/fixtures/governance-approval-consumers/merge-authorization-nonce-ledger-snapshot.json`

**Interfaces:**

- Consumes canary evidence, independently verified signer identity, live ruleset parity, closed workflow/file/App/check-context allowlists, dynamic run/suite association evidence, receipt revocation/supersession state, `docs/governance/program-c-merge-authorization-grant.schema.json`, `docs/governance/program-c-merge-authorization-consumption.schema.json`, a shared durable nonce-ledger CAS snapshot, and Task 4 acceptance-time revalidation output.
- Produces a verified receipt context seam; raw bundle fields remain untrusted.

- [ ] **Step 1: Write RED verified-context tests**

Require documentary provenance to remain untrusted, forged receipts/URLs to fail, trusted-base receipts to be insufficient for external Release promotion, revoked/superseded/expired receipts to fail, and exact independently verified receipt context to pass only its intended ADR/Release lane.

The PASS fixture must bind current acceptance-time readback of exact reviews, trusted-base authority revision/effective interval, bounded Legal input, live ruleset normalized digest with `bypass_actors=[]`, allowlisted acceptance diff, proposal/main bytes, and every required machine check's statically pinned App/context/workflow ID/path/trusted-base blob SHA/reusable signer plus dynamically observed check-run/check-suite/run attempt/event/head. Mutate each field and each association independently; names, URLs, prior proposal-time receipts, raw bundle fields, or a static policy field that pins run/suite IDs cannot create trust.

For Proposal or Acceptance merge lanes, execute mutations for missing grant/consumption, mutable grant bytes, wrong grant/consumption schema path or version, absent `MERGE-AUTHORIZER`, expired grant, wrong stage/PR/head/result commit, reused nonce, stale expected ledger revision, two concurrent different consumptions, response loss after durable commit, and a consumption missing from the independently verified shared ledger snapshot. The exact same retry after response loss returns the existing consumption; any different binding fails `APPROVAL_MERGE_AUTHORIZATION_REPLAYED`.

- [ ] **Step 2: Run RED**

```bash
node --test --test-name-pattern='Release Bundle|trusted approval|external provenance|revocation|supersession|merge authorization|nonce ledger' scripts/governance-contracts.spec.mjs scripts/governance-verify.spec.mjs
```

Expected: FAIL because the consumer has no verified receipt context seam.

- [ ] **Step 3: Implement the context seam**

`validateReleaseBundle` receives an immutable map of already independently verified, acceptance-time-revalidated receipts. Bundle fields can reference a receipt but cannot create trust. Keep `EXTERNAL_UNVERIFIED/NONE/NONE` backward-compatible. A receipt is eligible only when its subject lane, implementation/source/merge/evidence identity, signer/workflow allowlist, validity, authority, Legal, ruleset, diff, revocation, and supersession state all match the current consumer request. A merge-stage receipt additionally requires a schema-valid immutable `program-c-merge-authorization-grant/v1`, a separate schema-valid append-only `program-c-merge-authorization-consumption/v1`, exact raw digests for both, and independent readback that the exact `repository_id + single_use_nonce` key occurs once at the receipt-bound reserved revision of the shared durable CAS ledger. The loader never changes the grant to `CONSUMED`; it derives consumption state from the separate record and ledger.

`scripts/governance-verify.spec.mjs` fixture-loads receipt/evidence packages and proves the repository loader rejects missing files, wrong raw/core/manifest/trusted-root/grant/consumption/ledger digests, unsafe paths, symlinks, duplicate receipt or consumption IDs, nonce reuse, stale ledger revision, revoked/superseded receipts, and bundle-to-receipt identity mismatch. Response-loss recovery must read the already committed exact consumption rather than append a second record.

Update the machine ruleset declaration to the already-read-back live values from Task 5:

```text
required_approving_reviews = 2
require_code_owner_review  = true
require_last_push_approval = true
dismiss_stale_reviews      = true
thread_resolution          = true
strict_required_contexts   = true
allow_force_push           = false
allow_deletion             = false
bypass_actors              = []
```

Add `/docs/evidence/governance-readback/` to both the CODEOWNERS terminal block and `codeowner_requirements.terminal_patterns`; preserve every existing terminal rule and action pin.

Replace `trusted_approval_readback_policy.numeric_identity_state=UNOBSERVED` with `OBSERVED_AND_PINNED` and the exact numeric GitHub Actions App IDs, check contexts, workflow IDs/paths, reusable signer workflow IDs/paths, and trusted-base blob SHAs from the independently read-back canary. Do not pin check-run, check-suite, or Actions run IDs in static policy. Each receipt records those dynamic IDs and the consumer verifies their API association with the pinned App/context/workflow/base-blob/signer tuple. A later static-identity or dynamic-association mismatch is HOLD; consumer code may not discover-and-trust a new static identity at runtime.

- [ ] **Step 4: Run GREEN and full governance**

```bash
node --test --test-name-pattern='Release Bundle|trusted approval|external provenance|revocation|supersession|merge authorization|nonce ledger' scripts/governance-contracts.spec.mjs scripts/governance-verify.spec.mjs
pnpm approval-readback:test
node --test --experimental-test-coverage --test-coverage-include=scripts/governance-delivery-contracts.mjs --test-coverage-include=scripts/governance-ci-contracts.mjs --test-coverage-include=scripts/governance-verify.mjs --test-name-pattern='Release Bundle|trusted approval|external provenance|revocation|supersession|merge authorization|nonce ledger' scripts/governance-contracts.spec.mjs scripts/governance-verify.spec.mjs
pnpm governance:verify
pnpm docs:verify
pnpm code-intelligence:scan
pnpm --filter @global/code-intelligence exec tsx src/cli.ts status --repo ../..
pnpm --filter @global/code-intelligence exec tsx src/cli.ts impact .github/workflows/trusted-approval-readback.yml .github/workflows/governance-merge-readback.yml .github/required-contexts.json .github/CODEOWNERS scripts/governance-approval-workflow-contract.spec.mjs scripts/governance-ci-topology.spec.mjs scripts/supply-chain-gates.spec.mjs scripts/governance-ci-contracts.mjs scripts/governance-delivery-contracts.mjs scripts/governance-contracts.spec.mjs scripts/governance-verify.mjs scripts/governance-verify.spec.mjs scripts/fixtures/governance-approval-consumers docs/governance/program-c-merge-authorization-grant.schema.json docs/governance/program-c-merge-authorization-consumption.schema.json docs/governance/release-bundle.schema.json docs/governance/README.md docs/governance/docs-verification.md docs/templates/release-bundle.template.json docs/evidence/governance-readback/README.md --repo ../..
git diff --check
```

Expected: PASS with no ADR, Release, Pilot, or GA promotion in fixtures; changed `governance-delivery-contracts.mjs`, `governance-ci-contracts.mjs`, and `governance-verify.mjs` each have at least 80% statements and branches in the relevant combined coverage output; ContractGraph is exact-head clean with zero errors and hosted trust remains externally observed only through verified receipt evidence.

- [ ] **Step 5: Independent review and commit**

Commit after 0 Critical/High/Medium:

```bash
git add .github/required-contexts.json .github/CODEOWNERS scripts/governance-ci-contracts.mjs scripts/governance-delivery-contracts.mjs scripts/governance-contracts.spec.mjs scripts/governance-verify.mjs scripts/governance-verify.spec.mjs scripts/fixtures/governance-approval-consumers docs/governance/release-bundle.schema.json docs/templates/release-bundle.template.json docs/governance/README.md docs/governance/docs-verification.md docs/evidence/governance-readback/README.md
git commit -m "feat: consume independently verified approval receipts"
```

Stop before push, PR, or merge.

## Exit Criteria

```text
Trusted-base workflow merged/observed = required before gate enablement
Independent signer observed           = required for external verification
Live ruleset parity                   = PASS by API readback
Live bypass_actors                    = []
Receipt online/offline verify         = PASS
Acceptance-time revalidation          = PASS
Revocation/supersession handling      = PASS
Consumer trust seam                   = PASS
ADR-026/027                           = still separate decision flow
Merge/Release/Pilot                   = separately authorized only
```
