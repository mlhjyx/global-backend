# Trusted Approval Readback Local Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build local schemas, safe parsers, pure validators, bounded GitHub API adapters, an offline attestation verifier seam, and static impact evidence for Product/Privacy approval receipts without any external mutation or ADR acceptance.

**Architecture:** Evidence collection, decision validation, merge-authorization grant validation, append-only grant consumption, state reduction, receipt rendering, and attestation verification are separate. GitHub, the durable nonce ledger, and `gh` are injected adapters; unit tests use bounded fixtures and never call the live network or real process. Receipt core digest, final raw bytes, and external raw-byte digest are distinct interfaces so no receipt self-hashes recursively. A merge-authorization grant is immutable; a separate consumption record is committed through compare-and-swap before a receipt may claim consumption. The foundation can emit only synthetic or locally verified objects and cannot claim an actual human approval, external independence, ADR acceptance, Release, or Pilot.

**Tech Stack:** Node.js 22 standard library; JSON Schema 2020-12 with root-declared `ajv@8.20.0` and `ajv-formats@3.0.1`; Node test runner; GitHub REST fixture objects; injected GitHub CLI adapter seam; optional authorized `gh@2.89.0` toolchain; ContractGraph.

**Spec:** `docs/governance/trusted-approval-readback-spec.md`

## Global Constraints

- Implement from current `main` after this plan is accepted, not from the intentional Program C RED branch.
- Use `/global/backend/.codex/worktrees/trusted-approval-readback-foundation` and branch `codex/trusted-approval-readback-foundation`.
- No push, PR, merge, GitHub mutation, ruleset mutation, external repository creation, App installation, credential change, deploy, Runtime, Release, Provider, model, email, or paid action.
- Privileged-path code uses Node standard library and never executes PR-controlled dependencies.
- Strict JSON rejects duplicate keys, fatal UTF-8 errors, symlinks, non-regular files, files over 1 MiB, unknown fields, and non-canonical timestamps.
- Networked GitHub evidence is admitted only from `https://api.github.com`; redirects and every other origin fail before credentials can be forwarded.
- Trusted policy supplies exact allowlists for repository files, required check contexts, workflow IDs/paths, signer workflow IDs/paths, and Actions App IDs. An observed value outside those lists is HOLD.
- Receipt core digest is embedded in the closed receipt envelope. The SHA-256 of final raw receipt bytes is external metadata carried by the evidence manifest and attestation subject; it is never a recursive field inside the bytes it hashes.
- Merge authorization uses separate closed grant and consumption objects. The original grant is immutable, nonce reuse is decided from an append-only durable ledger with compare-and-swap, and a receipt cannot infer consumption from a merge event or mutate `AUTHORIZED` into `CONSUMED` in place.
- Canonical implementation codes are `APPROVAL_RULESET_DRIFT` and `APPROVAL_TOCTOU_DETECTED`, matching the specification's required stop-code list. Prose aliases `RULESET_DECLARATION_LIVE_DRIFT` and `READBACK_TOCTOU_DETECTED` are not emitted or accepted by schemas/tests/consumers.
- Machine approval actors, including the distinct `OWN-SECURITY` role, remain `UNASSIGNED` until explicit, separately verified assignments exist.
- Same-repository output can be `TRUSTED_BASE_VERIFIED` only, never `INDEPENDENT_EXTERNAL_VERIFIED`.
- `EXTERNAL_UNVERIFIED/NONE/NONE` remains the only Release Bundle provenance accepted without a verified receipt context.
- Every changed executable file requires at least 80% statements and branches.
- Local unit tests use an injected command runner. A real offline verification remains `NOT_RUN / APPROVAL_ATTESTATION_TOOLCHAIN_UNAVAILABLE` while the installed `gh 2.46.0` lacks `gh attestation`; tests may not translate injected PASS into real toolchain PASS.
- Implementer and independent reviewer must be different agents.

---

### Task 1: Closed authority and receipt schemas

**Files:**

- Create: `docs/governance/approval-authorities.schema.json`
- Create: `docs/governance/approval-authorities.json`
- Create: `docs/governance/trusted-approval-readback.schema.json`
- Create: `docs/governance/trusted-approval-evidence-manifest.schema.json`
- Create: `docs/governance/trusted-approval-revocation.schema.json`
- Create: `docs/governance/trusted-approval-supersession.schema.json`
- Create: `docs/governance/program-c-merge-authorization-grant.schema.json`
- Create: `docs/governance/program-c-merge-authorization-consumption.schema.json`
- Create: `scripts/governance-approval-schema-validator.mjs`
- Create: `scripts/governance-approval-schemas.spec.mjs`
- Modify: `docs/governance/README.md`
- Modify: `docs/evidence/site-builder/copy-runtime-eligibility.json`
- Modify: `docs/implementation-records/copy-fixed-source-impact-governance.md`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Produces: `approval-authorities/v1`, `product-privacy-approval-readback-receipt/v1`, `trusted-approval-evidence-manifest/v1`, `trusted-approval-revocation/v1`, `trusted-approval-supersession/v1`, `program-c-merge-authorization-grant/v1`, `program-c-merge-authorization-consumption/v1`.
- `approval-authorities/v1` has the exact initial role set `OWN-PRODUCT`, `OWN-DATA-PRIVACY`, `OWN-QA-EVIDENCE`, `OWN-SECURITY`, `LEGAL-REVIEW`, and `MERGE-AUTHORIZER`; missing, extra, aliased, or reordered roles fail closed.
- Produces:
  ```ts
  validateApprovalAuthorities(value: unknown): SchemaValidationResult
  validateApprovalReceipt(value: unknown): SchemaValidationResult
  validateApprovalEvidenceManifest(value: unknown): SchemaValidationResult
  validateApprovalRevocation(value: unknown): SchemaValidationResult
  validateApprovalSupersession(value: unknown): SchemaValidationResult
  validateProgramCMergeAuthorizationGrant(value: unknown): SchemaValidationResult
  validateProgramCMergeAuthorizationConsumption(value: unknown): SchemaValidationResult
  ```
- `trusted-approval-evidence-manifest/v1` requires a closed `files` list plus:
  ```ts
  receipt_core_sha256: `sha256:${string}`;
  receipt_raw_sha256: `sha256:${string}`;
  attestation_subject_sha256: `sha256:${string}`; // exact receipt_raw_sha256
  attestation_bundle: {
    path: `sha256-${string}.jsonl`; // string = receipt_raw_sha256 without prefix
    sha256: `sha256:${string}`;
  }
  trusted_root: {
    path: "trusted_root.jsonl";
    sha256: `sha256:${string}`;
    acquired_at: IsoInstant;
    gh_path: "/opt/global/toolchains/gh/2.89.0/bin/gh";
    gh_version: "2.89.0";
    tuf_source: "GH_ATTESTATION_TRUSTED_ROOT";
  }
  ```
- `trusted-approval-revocation/v1` requires receipt ID, receipt core/raw digests, authority revision/digest, bounded reason code, revoking role/actor ID, canonical effective time, and no free-text reason.
- `trusted-approval-supersession/v1` requires predecessor and successor receipt IDs/core/raw digests, authority revision/digest, canonical effective time, strict different identities, and an acyclic predecessor chain. Supersession never deletes or rewrites the predecessor.
- `program-c-merge-authorization-grant/v1` is an immutable, closed grant. It binds grant ID, repository identity, decision/policy revision, exact stage (`PROPOSAL_MERGE` or `ACCEPTANCE_MERGE`), PR/base/head, decision raw/semantic digests, allowed merge method, `MERGE-AUTHORIZER` numeric actor and authority revision/digest, canonical authorization/expiry instants, and one opaque bounded `single_use_nonce`. It contains no mutable consumption fields and no status transition.
- `program-c-merge-authorization-consumption/v1` is a separate append-only fact. It binds consumption ID, original grant ID/raw digest, `single_use_nonce`, repository/decision/policy/stage, PR and authorized head, observed result commit/method, canonical consumed-at time, nonce-ledger key and reserved revision, independent verifier repository/path/SHA/run/attempt/identity, current-main ref/SHA/readback time, and pre/post readback digests. Its raw digest is computed outside its bytes and bound by the receipt/evidence manifest. It cannot rewrite, replace, or embed a modified grant.
- Consumes: no runtime or external state.

- [ ] **Step 1: Write RED schema tests**

Require all schema files and mutation-test missing repository identity, login-only actors, an `UNASSIGNED` role carrying actor IDs, missing `OWN-SECURITY` or `MERGE-AUTHORIZER`, duplicate roles, receipt reuse across roles, wrong ADR/revision/head, non-canonical time, uppercase digest, unknown fields, a trusted-base receipt claiming external independence, revocation without the original receipt/core digest, supersession cycles, wrong predecessor receipt, stale authority revision, and a revoked receipt reused by a later acceptance. For merge authorization, reject the singular `program-c-merge-authorization/v1` schema/file/validator and every compatibility alias, a mutable single-object authorization/consumption shape, missing or duplicated nonce, mismatched nonce or nonce-ledger key, stage/ADR/PR/head reuse, expiry, authority mismatch, consumption without the original grant digest, missing/negative/fractional/unsafe reserved ledger revision, missing current-main or pre/post readback identity, a consumption that changes grant bytes, and any attempt to represent consumption by changing a grant status field.

Run:

```bash
node --test scripts/governance-approval-schemas.spec.mjs
```

Expected: FAIL because the schemas and registry are absent.

- [ ] **Step 2: Commit RED**

```bash
git add scripts/governance-approval-schemas.spec.mjs
git commit -m "test: specify trusted approval receipt schemas"
```

- [ ] **Step 3: Implement the schemas and honest initial registry**

Install only the exact cached dependencies from the root workspace:

```bash
pnpm add -Dw --offline ajv@8.20.0 ajv-formats@3.0.1
```

`scripts/governance-approval-schema-validator.mjs` imports `ajv/dist/2020.js` and `ajv-formats`, compiles every schema once, refuses unknown formats, and returns frozen issue objects that contain only schema path, instance path, and stable code. No test or executable may rely on Ajv being transitively hoisted from `@global/contracts`.

Because root `package.json` and `pnpm-lock.yaml` are active Copy fixed-source inputs, regenerate and read back the fail-closed eligibility receipt before claiming governance GREEN:

```bash
node scripts/copy-fixed-source-impact.mjs --write-eligibility
node scripts/copy-fixed-source-impact.mjs
```

Update `docs/implementation-records/copy-fixed-source-impact-governance.md` with the generated current source fingerprint and the exact SHA-256 of `docs/evidence/site-builder/copy-runtime-eligibility.json`. Keep `dispatch_authorization=NOT_AUTHORIZED`, `pilot_eligibility=BLOCKED`, the exact reviewed stale scope, and the required follow-up unchanged; do not edit the active Copy binding.

The initial registry is exact and intentionally unassigned:

```json
{
  "schema_version": "approval-authorities/v1",
  "repository": { "id": 1291151138, "full_name": "mlhjyx/global-backend" },
  "revision": "approval-authorities/initial-unassigned",
  "actor_policy": "DISTINCT_ACTORS_REQUIRED",
  "roles": [
    { "role": "OWN-PRODUCT", "status": "UNASSIGNED" },
    { "role": "OWN-DATA-PRIVACY", "status": "UNASSIGNED" },
    { "role": "OWN-QA-EVIDENCE", "status": "UNASSIGNED" },
    { "role": "OWN-SECURITY", "status": "UNASSIGNED" },
    { "role": "LEGAL-REVIEW", "status": "UNASSIGNED" },
    { "role": "MERGE-AUTHORIZER", "status": "UNASSIGNED" }
  ]
}
```

This does not overwrite the human-readable Product assignment. It records that no trusted GitHub numeric actor mapping has been admitted.

- [ ] **Step 4: Run GREEN**

```bash
node --test scripts/governance-approval-schemas.spec.mjs
node --test --experimental-test-coverage scripts/governance-approval-schemas.spec.mjs
pnpm docs:verify
pnpm governance:verify
pnpm exec eslint --no-ignore scripts/governance-approval-schema-validator.mjs scripts/governance-approval-schemas.spec.mjs
git diff --check
```

Expected: PASS without creating any trusted receipt or changing Program C holds; schema validator statements and branches are both at least 80%.

- [ ] **Step 5: Commit GREEN**

```bash
git add docs/governance/approval-authorities.schema.json docs/governance/approval-authorities.json docs/governance/trusted-approval-readback.schema.json docs/governance/trusted-approval-evidence-manifest.schema.json docs/governance/trusted-approval-revocation.schema.json docs/governance/trusted-approval-supersession.schema.json docs/governance/program-c-merge-authorization-grant.schema.json docs/governance/program-c-merge-authorization-consumption.schema.json scripts/governance-approval-schema-validator.mjs docs/governance/README.md docs/evidence/site-builder/copy-runtime-eligibility.json docs/implementation-records/copy-fixed-source-impact-governance.md package.json pnpm-lock.yaml
git commit -m "feat: define trusted approval receipt contracts"
```

---

### Task 2: Safe JSON and exact receipt bytes

**Files:**

- Create: `scripts/governance-approval-safe-json.mjs`
- Create: `scripts/governance-approval-safe-json.spec.mjs`

**Interfaces:**

- Produces:
  ```ts
  readApprovalJson(path, label): Promise<{ value: unknown; bytes: Buffer }>
  parseApprovalJson(text, label): unknown
  renderApprovalReceiptCore(core: ApprovalReceiptCore): Buffer
  buildApprovalReceiptArtifact(core: ApprovalReceiptCore): Readonly<{
    envelope: ApprovalReceiptEnvelope;
    bytes: Buffer;
    receiptCoreSha256: `sha256:${string}`;
    receiptRawSha256: `sha256:${string}`;
  }>
  sha256Prefixed(bytes): `sha256:${string}`
  ```

`ApprovalReceiptEnvelope` contains `schema_version`, the closed `core`, and `receipt_core_sha256`. It does not contain a whole-object or raw-file digest; `receiptRawSha256` is written as `receipt_raw_sha256` in `trusted-approval-evidence-manifest/v1` and becomes the attestation subject digest. `receipt_core_sha256` is the only core-digest property name in schema, renderer, fixtures, manifest bindings, tests, and consumers; every alternative core property name is rejected. This is the exact non-recursive interpretation of the specification's core/receipt raw-byte binding.

- [ ] **Step 1: Write RED parser and filesystem tests**

Cover duplicate/escaped duplicate keys, fatal UTF-8, Unicode whitespace, negative zero, non-finite values, symlink/FIFO/directory, 1 MiB boundary, file change during read, canonical ISO round-trip, schema-ordered core rendering, envelope core-digest drift, exact final-byte re-render, external raw-digest calculation, attempted self-referential raw hash fields, and one-byte digest drift.

Run:

```bash
node --test scripts/governance-approval-safe-json.spec.mjs
```

Expected: FAIL because the module is absent.

- [ ] **Step 2: Commit RED**

```bash
git add scripts/governance-approval-safe-json.spec.mjs
git commit -m "test: specify safe approval evidence parsing"
```

- [ ] **Step 3: Implement the standard-library parser and renderer**

Use `O_NOFOLLOW | O_NONBLOCK`, regular-file checks, 1,048,576-byte maximum, opened-handle before/after identity checks, and fatal UTF-8 decoding. Construct schema-ordered objects explicitly before `JSON.stringify(value, null, 2)` plus one newline; never depend on input object insertion order. Parsed receipts must re-render to exact input bytes, recompute the core digest, and compare the external manifest's raw SHA against the final bytes.

- [ ] **Step 4: Run GREEN and coverage**

```bash
node --test scripts/governance-approval-safe-json.spec.mjs
node --test --experimental-test-coverage scripts/governance-approval-safe-json.spec.mjs
pnpm exec eslint --no-ignore scripts/governance-approval-safe-json.mjs scripts/governance-approval-safe-json.spec.mjs
git diff --check
```

Expected: PASS with at least 80% statements and branches.

- [ ] **Step 5: Commit GREEN**

```bash
git add scripts/governance-approval-safe-json.mjs scripts/governance-approval-safe-json.spec.mjs
git commit -m "feat: add safe approval evidence parser"
```

---

### Task 3: Pure approval validator and receipt builder

**Files:**

- Create: `scripts/governance-approval-readback.mjs`
- Create: `scripts/governance-approval-readback.spec.mjs`
- Create: `scripts/fixtures/approval-readback/README.md`
- Create: bounded fixtures under `scripts/fixtures/approval-readback/`

**Interfaces:**

- Produces:
  ```ts
  parseApprovalReviewCommand(body): ParsedApprovalCommand
  validateApprovalReadback(candidate, authority, policy, now): ValidationResult
  validateMergeAuthorizationGrantForCandidate(grant, candidate, authority, now): ValidationResult
  buildApprovalReceiptCore(candidate, authority, verifier, mergeAuthorizationEvidence, now): ApprovalReceiptCore
  buildApprovalReceiptArtifact(core): ApprovalReceiptArtifact
  validateReceiptRevocation(revocation, receipt, authority, now): ValidationResult
  validateReceiptSupersession(supersession, receipts, authority, now): ValidationResult
  ```
- Consumes normalized data only; no filesystem, network, shell, or GitHub CLI.

- [ ] **Step 1: Write RED grammar and validation tests**

The only valid review body is one canonical line:

```text
APPROVE DECISION <ADR-ID> REV <POLICY-REVISION> ROLE <OWNER-ROLE> DIGEST sha256:<64-lowercase-hex>
```

Reject multiline bodies, Markdown, bidi, HTML, mentions, shell characters, unsupported roles, whitespace aliases, and wrong digest.

`OWN-SECURITY` uses the same canonical one-line grammar but produces its own closed exact-head Security evidence record. The record binds repository/decision/policy revision, PR/base/head, decision raw/semantic digests, review ID/state/commit/timestamp, canonical command digest, and the current-main-admitted `OWN-SECURITY` numeric actor/node ID/login/authority revision. It contains no free-form review body and cannot be synthesized from a URL, check run, CODEOWNER review, QA evidence, Product/Privacy review, repository power, or PR authorship.

Build valid synthetic candidates for `DISTINCT_ACTORS_REQUIRED` and `DUAL_ROLE_WITH_INDEPENDENT_COAPPROVER`. Mutation-test owner/actor mismatch, bots, PR author, same actor without exception, missing third human, wrong review state/head, dismissal, later changes request, check ambiguity, ruleset drift or any non-empty bypass list, TOCTOU, digest drift, Legal pending, receipt replay, revoked receipt, supersession cycle, external-independence overclaim, and every non-canonical error-code alias. Security mutations cover unassigned/stale/revoked `OWN-SECURITY`, missing Security evidence, wrong PR/base/head/decision or command digest, wrong actor/review ID/state/commit/timestamp, dismissed or superseded review, free-form body persistence, and any Security slot reuse with Product, Privacy, CODEOWNER, QA, or machine checks. Merge-authorization mutations cover missing `MERGE-AUTHORIZER`, wrong grant stage/PR/base/head/decision digest/merge method/authority revision, expired or append-only-revoked grant, nonce or ledger-key mismatch, absent consumption, consumption not present in the durable ledger snapshot, and a receipt that embeds a mutated copy of the original grant.

Each required machine check is accepted only when the normalized candidate binds all of:

```text
GitHub App numeric ID and slug
check run ID and check suite ID
required context name
workflow numeric ID and exact allowlisted path
trusted-base workflow blob SHA
Actions run ID/attempt/event/head SHA/conclusion
reusable signer workflow numeric ID/path/SHA when present
```

Name-only or URL-only checks fail. The trusted policy carries exact allowlists for App IDs, check contexts, workflow IDs/paths, signer IDs/paths, and PR-readable file paths.

Check run and check suite IDs are dynamic observation evidence recorded in the receipt. They must prove association with the statically pinned Actions App, context, workflow numeric ID/path, trusted-base workflow blob SHA, run/event/head, and reusable signer identity. They are not members of a static `allowedCheckRunIds` or `allowedCheckSuiteIds` policy.

Run:

```bash
node --test scripts/governance-approval-readback.spec.mjs
```

Expected: FAIL because the validator is absent.

- [ ] **Step 2: Commit RED**

```bash
git add scripts/governance-approval-readback.spec.mjs scripts/fixtures/approval-readback
git commit -m "test: specify trusted approval readback validation"
```

- [ ] **Step 3: Implement pure validation and closed error codes**

Never include raw candidate input in errors. Freeze output. `buildApprovalReceiptCore` runs only after zero issues and receives a finite validity policy explicitly. For a Proposal or Acceptance merge receipt, it embeds the immutable grant ID/raw digest plus the separate consumption ID/raw digest and committed durable-ledger revision; it never embeds a grant whose bytes were rewritten to show consumption. `buildApprovalReceiptArtifact` uses the Task 2 renderer and returns both embedded core digest and external raw-byte SHA. Revocation and supersession validation never deletes prior receipts; it returns append-only state facts bound to the original receipt/core/raw digests.

- [ ] **Step 4: Run GREEN, coverage, and mutation completeness**

```bash
node --test scripts/governance-approval-readback.spec.mjs
node --test --experimental-test-coverage scripts/governance-approval-readback.spec.mjs
pnpm exec eslint --no-ignore scripts/governance-approval-readback.mjs scripts/governance-approval-readback.spec.mjs
git diff --check
```

Expected: PASS, all mutations executed exactly once, at least 80% statements and branches.

- [ ] **Step 5: Commit GREEN**

```bash
git add scripts/governance-approval-readback.mjs scripts/governance-approval-readback.spec.mjs
git commit -m "feat: validate trusted approval readback candidates"
```

---

### Task 4: Approval state reducer, durable merge nonce ledger, and status read model

**Files:**

- Create: `scripts/governance-approval-state.mjs`
- Create: `scripts/governance-approval-state.spec.mjs`
- Create: `scripts/governance-approval-status.mjs`
- Create: `scripts/governance-approval-status.spec.mjs`
- Create: bounded fixtures under `scripts/fixtures/approval-readback/merge-authorization/`

**Interfaces:**

- Produces:
  ```ts
  reduceApprovalDecisionState(
    events: readonly ApprovalStateEvent[],
    policy: ApprovalStatePolicy,
    now: Date,
  ): Readonly<ApprovalDecisionState>

  revalidateApprovalAtAcceptance(
    state: ApprovalDecisionState,
    evidence: AcceptanceReadbackEvidence,
    now: Date,
  ): Readonly<AcceptanceValidationResult>

  type DurableMergeAuthorizationNonceLedger = Readonly<{
    durabilityClass: "SHARED_DURABLE_CAS";
    read(key: Readonly<{
      repositoryId: number;
      singleUseNonce: string;
    }>): Promise<Readonly<MergeAuthorizationLedgerStream> | null>;
    compareAndSwap(input: Readonly<{
      expectedRevision: number;
      key: Readonly<{ repositoryId: number; singleUseNonce: string }>;
      event: MergeAuthorizationLedgerEvent;
    }>): Promise<
      | Readonly<{ outcome: "COMMITTED"; committedRevision: number }>
      | Readonly<{ outcome: "CONFLICT"; currentRevision: number }>
    >;
  }>

  reserveMergeAuthorizationNonce(
    grant: ProgramCMergeAuthorizationGrant,
    grantRawSha256: `sha256:${string}`,
    request: MergeRequestIdentity,
    expectedLedgerRevision: number,
    ledger: DurableMergeAuthorizationNonceLedger,
    now: Date,
  ): Promise<Readonly<{
    outcome: "RESERVED" | "IDEMPOTENT_EXISTING";
    reservation: MergeAuthorizationReservation;
    reservedLedgerRevision: number;
  }>>

  executeReservedMerge(
    reservation: MergeAuthorizationReservation,
    mergeRequester: MergeRequester,
    ledger: DurableMergeAuthorizationNonceLedger,
  ): Promise<Readonly<{
    outcome: "ACKNOWLEDGED" | "ACK_UNKNOWN" | "HOLD";
  }>>

  reconcileMergeAuthorizationReservation(
    reservation: MergeAuthorizationReservation,
    readback: CurrentMainMergeReadback,
    ledger: DurableMergeAuthorizationNonceLedger,
    now: Date,
  ): Promise<Readonly<{
    outcome: "CONSUMPTION_RECORDED" | "HOLD";
    consumption: ProgramCMergeAuthorizationConsumption | null;
    consumptionRawSha256: `sha256:${string}` | null;
    committedLedgerRevision: number;
  }>>

  renderApprovalStatusReadModel(
    state: ApprovalDecisionState,
  ): Readonly<ApprovalStatusReadModel>

  runApprovalStatusCli(
    argv: readonly string[],
    dependencies: ApprovalStatusDependencies,
  ): Promise<number>
  ```
- Consumes Task 1 receipt/revocation/supersession/grant/consumption schemas and Task 3 pure validation results. GitHub merge, current-main readback, and the shared durable CAS ledger are injected ports. The local foundation defines and tests the port/orchestration contract but does not implement an infrastructure-specific ledger adapter. The module contains no filesystem, network, shell, registry, ADR mutation, or same-process uniqueness fallback.

- [ ] **Step 1: Write RED reducer/read-model tests**

Cover every specification state and transition:

```text
OWNER_ASSIGNMENT_REQUIRED → PROPOSED
PROPOSED → AWAITING_PRODUCT_REVIEW → AWAITING_PRIVACY_REVIEW
any new head → STALE_AFTER_PUSH
fresh verified receipt → VERIFIED
acceptance-time revalidation PASS → ACCEPTED
revocation → REVOKED
supersession → superseded receipt remains immutable and the successor becomes current
rejection → REJECTED
```

`revalidateApprovalAtAcceptance` must require fresh, acceptance-time readback of all of the following, rather than trusting the proposal-time receipt alone:

```text
current PR head/base and allowlisted acceptance diff
latest Product/Privacy/required QA/Security reviews and review command digests
current trusted-base authority bytes/revision/digest and effective intervals
current bounded Legal input status/scope/digest/validity
live ruleset normalized digest and bypass_actors = []
required machine checks with statically pinned App/context/workflow/base-blob/signer identity and dynamically observed check-run/check-suite/run/head association
receipt validity, non-revocation, and non-supersession
proposal result commit and approved subject bytes on current main
immutable stage-specific merge-authorization grant plus its separate consumption record
`repository_id + single_use_nonce` present exactly once in a shared durable CAS ledger at the receipt-bound reserved revision; stage is bound in the record but is not part of the uniqueness key
```

Mutation-test stale reviews, authority reassignment/revocation, expired Legal input, ruleset drift, non-empty bypass, acceptance diff outside the exact allowlist, changed sidecar bytes, receipt replay, revocation, supersession, and TOCTOU between pre/post readback.

The merge-consumption harness must execute, rather than merely list, all of these cases:

```text
reservation CAS key = repository_id + single_use_nonce; stage is bound data, never part of uniqueness
two concurrent distinct request IDs for one key → one RESERVED winner; loser gets APPROVAL_MERGE_AUTHORIZATION_NONCE_CAS_CONFLICT before any merge request
same grant and request ID retry → exact existing reservation/consumption, no second append and no second physical merge request
same nonce with different request/stage/ADR/PR/head/method/grant digest → replay/CAS failure
successful reservation → at most one injected physical merge request
response loss or timeout before/after provider ACK → MERGE_ACK_UNKNOWN; retry performs readback only and never a second merge request
ACK_UNKNOWN recovery → PR/result/method/current-main readback appends MERGE_RESULT_OBSERVED then CONSUMPTION_RECORDED or a bounded HOLD
current-main lag/wrong result/wrong method/stale head/base → HOLD without nonce release
GRANT_REVOKED before reservation → reservation denied; revocation after reservation → reconciliation HOLD and nonce remains reserved
process restart with ledger snapshot → reservation/consumption and nonce uniqueness survive
missing, process-memory-only, workflow-artifact-only, or non-CAS ledger → fail closed before merge request
every path → byte-for-byte original grant and grant digest remain unchanged
```

The status CLI tests require these exact supported commands:

```text
node scripts/governance-approval-status.mjs --decision ADR-027 --format json
node scripts/governance-approval-status.mjs --decision ADR-027 --format text
```

They reject unsupported decision IDs/formats, missing evidence, free-form review or Legal content, and every force-accept spelling.

Run:

```bash
node --test scripts/governance-approval-state.spec.mjs scripts/governance-approval-status.spec.mjs
```

Expected: FAIL because the reducer and read model are absent.

- [ ] **Step 2: Commit RED**

```bash
git add scripts/governance-approval-state.spec.mjs scripts/governance-approval-status.spec.mjs scripts/fixtures/approval-readback/merge-authorization
git commit -m "test: specify approval state reduction and acceptance readback"
```

- [ ] **Step 3: Implement the pure reducer, ledger state machine, and acceptance validator**

Use immutable inputs/outputs, exhaustive event switching, stable HOLD codes, and no default transition. `reserveMergeAuthorizationNonce` validates the immutable grant, derives the exact `repository_id + single_use_nonce` key, and CAS-appends `NONCE_RESERVED` with grant digest, stage, PR, exact head, method, reservation ID, request ID, and revision before any physical merge attempt. Only the fresh `RESERVED` winner may call `executeReservedMerge`, and it may call the injected merger at most once. A pre-existing reservation—including after crash, timeout, or response loss—can only enter reconciliation; it cannot make another physical request.

The append-only ledger event set is closed to `NONCE_RESERVED`, `GRANT_REVOKED`, `MERGE_ACK_UNKNOWN`, `MERGE_RESULT_OBSERVED`, `CONSUMPTION_RECORDED`, and bounded HOLD facts. `reconcileMergeAuthorizationReservation` uses PR/result/method/current-main readback to construct the separate consumption only after the exact result is reachable from current `main`. Identical request retries return the existing reservation/consumption; a different binding fails `APPROVAL_MERGE_AUTHORIZATION_NONCE_CAS_CONFLICT` or `APPROVAL_MERGE_AUTHORIZATION_REPLAYED`. No product path may substitute a process-memory map, test fake, workflow artifact URL, stage-qualified uniqueness key, or mutable grant status for the durable ledger.

`ACCEPTED` is unreachable unless the acceptance-time readback has zero issues and every required merge grant has an exact append-only consumption proven in the ledger snapshot. `renderApprovalStatusReadModel` exposes policy state, Legal state, evidence trust state, current receipt ID/core/raw digests, immutable grant ID/raw digest, consumption ID/raw digest, reserved ledger revision and current ledger state, revocation/supersession status, and blocking codes without exposing the nonce, free-form review, or Legal content.

- [ ] **Step 4: Run GREEN, coverage, and mutation completeness**

```bash
node --test scripts/governance-approval-state.spec.mjs scripts/governance-approval-status.spec.mjs
node --test --experimental-test-coverage scripts/governance-approval-state.spec.mjs scripts/governance-approval-status.spec.mjs
pnpm exec eslint --no-ignore scripts/governance-approval-state.mjs scripts/governance-approval-state.spec.mjs scripts/governance-approval-status.mjs scripts/governance-approval-status.spec.mjs
git diff --check
```

Expected: PASS, all state/mutation cases executed exactly once, and at least 80% statements and branches.

- [ ] **Step 5: Commit GREEN**

```bash
git add scripts/governance-approval-state.mjs scripts/governance-approval-state.spec.mjs scripts/governance-approval-status.mjs scripts/governance-approval-status.spec.mjs scripts/fixtures/approval-readback/merge-authorization
git commit -m "feat: reduce approval and merge authorization state"
```

---

### Task 5: Bounded GitHub evidence adapter

**Files:**

- Create: `scripts/governance-github-readback.mjs`
- Create: `scripts/governance-github-readback.spec.mjs`

**Interfaces:**

- Produces:
  ```ts
  createGitHubReadbackClient({
    fetch,
    token,
    apiVersion: "2026-03-10",
  }): Client

  collectGitHubApprovalEvidence(
    client,
    request,
    limits,
    trustedPolicy: Readonly<{
      repositoryId: 1291151138;
      allowedRepoPaths: readonly string[];
      allowedCheckContexts: readonly string[];
      allowedActionsAppIds: readonly number[];
      allowedWorkflowIds: readonly number[];
      allowedWorkflowPaths: readonly string[];
      allowedReusableSignerWorkflowIds: readonly number[];
      allowedReusableSignerWorkflowPaths: readonly string[];
    }>,
  ): Promise<NormalizedCandidate>
  ```
- Consumes an injected Fetch-compatible function; tests make no live request.
- Static policy never contains check-run or check-suite IDs. Those IDs are collected per run as dynamic receipt evidence and must be associated through API readback with the pinned App/context/workflow/base-blob/reusable-signer tuple.

- [ ] **Step 1: Write RED adapter tests**

Use minimized GitHub fixtures for repository, PR, complete Product/Privacy/QA/Security review pagination, check runs, check suites, Actions workflows/runs, reusable signer workflows, ruleset, commit-associated PR, Git trees, and Blob reads. Reject 3xx/403/404/409/429/5xx, timeout, pagination loops, over-limit pages/items, oversized responses, malformed Link headers, duplicate checks, head drift, and free-text persistence. Security review normalization must bind the admitted `OWN-SECURITY` numeric actor and exact current head; reject dismissed/superseded/wrong-head evidence and cross-slot review-ID reuse.

Security mutations must prove:

```text
base origin is exactly https://api.github.com
redirect mode is manual and every 3xx is rejected
Authorization is added only after exact-origin comparison
no token is forwarded to redirect Location or another origin
repo path is exact-policy allowlisted before any request
Git tree entry type = blob and mode = 100644
mode 100755 executable, 120000 symlink, 160000 submodule/gitlink, tree, and absent entry are rejected
Git LFS pointer prefixes are rejected before content parsing
blob SHA/path/head pre-read and post-read identities are equal
machine checks dynamically record App ID/slug and check run/suite IDs, then prove their association with the statically pinned context, workflow ID/path, trusted-base workflow blob SHA, run ID/attempt/event/head/conclusion, and reusable signer workflow identity
static policy attempts to pin or allowlist check run IDs or check suite IDs fail
name-only, details-URL-only, workflow-path-only, and App-slug-only claims fail
```

Run:

```bash
node --test scripts/governance-github-readback.spec.mjs
```

Expected: FAIL because the adapter is absent.

- [ ] **Step 2: Commit RED**

```bash
git add scripts/governance-github-readback.spec.mjs
git commit -m "test: specify bounded GitHub approval readback"
```

- [ ] **Step 3: Implement the adapter**

Hard-code `https://api.github.com` as the only origin; there is no caller-supplied `baseUrl`. Use GitHub API version `2026-03-10`, fixed Accept headers, `redirect: "manual"`, `AbortSignal.timeout`, maximum 100 pages, maximum 10,000 normalized items, and explicit response byte limits. Build each request from allowlisted path segments, compare URL origin before adding the Authorization header, reject every redirect, and never reissue a credentialed request to another origin. Persist only allowlisted identities and the digest of the parsed review command.

Read proposal files through the Git Tree + Blob APIs, prove exact `100644 blob` mode and SHA at the requested head, reject symlink/submodule/LFS/executable objects, then apply the 1 MiB/fatal UTF-8/strict JSON boundary. Never checkout, fetch, download-and-execute, or import PR-controlled content.

- [ ] **Step 4: Run GREEN and coverage**

```bash
node --test scripts/governance-github-readback.spec.mjs
node --test --experimental-test-coverage scripts/governance-github-readback.spec.mjs
pnpm exec eslint --no-ignore scripts/governance-github-readback.mjs scripts/governance-github-readback.spec.mjs
git diff --check
```

Expected: PASS, no live requests, at least 80% statements and branches.

- [ ] **Step 5: Commit GREEN**

```bash
git add scripts/governance-github-readback.mjs scripts/governance-github-readback.spec.mjs
git commit -m "feat: add bounded GitHub approval readback adapter"
```

---

### Task 6: Offline attestation verification seam and exact toolchain gate

**Files:**

- Create: `scripts/governance-approval-attestation.mjs`
- Create: `scripts/governance-approval-attestation.spec.mjs`
- Create: `scripts/governance-approval-test-entry.spec.mjs`
- Modify: `package.json`

**Interfaces:**

- Produces:

  ```ts
  inspectApprovalAttestationToolchain(input: {
    ghPath: string;
    versionOutput: string;
    attestationHelpExitCode: number;
  }): Readonly<{
    status: "AVAILABLE" | "HOLD";
    version: "2.89.0" | null;
    code: "PASS" | "APPROVAL_ATTESTATION_TOOLCHAIN_UNAVAILABLE" | "APPROVAL_ATTESTATION_TOOLCHAIN_VERSION_MISMATCH";
  }>

  verifyApprovalAttestation(input, commandRunner): Promise<VerifiedAttestation>
  ```

- [ ] **Step 1: Write RED command-contract tests**

Require an `execFile` command equivalent to:

```text
gh attestation verify <receipt>
--bundle <bundle>
--custom-trusted-root <trusted-root>
--repo <repo>
--signer-workflow <workflow>
--signer-digest <workflow-sha>
--source-ref refs/heads/main
--source-digest <source-sha>
--deny-self-hosted-runners
--format json
```

Reject missing CLI, current `gh 2.46.0` without the `attestation` command, every version except exact `2.89.0`, nonzero exit, malformed JSON, wrong subject/workflow/source, self-hosted evidence, multiple ambiguous attestations, byte drift, expired receipt, revoked receipt, superseded receipt, missing trusted-root bytes/digest/acquisition metadata, and a manifest whose recorded `gh` version differs from the executing toolchain.

The verifier rejects a Sigstore bundle whose filename is based on `receipt_core_sha256`, receipt ID, run ID, or caller text instead of exact `sha256-<receipt-raw-sha256-without-prefix>.jsonl`. It separately requires the fixed trusted-root filename `trusted_root.jsonl` and binds those bytes through the manifest SHA/acquisition/TUF/toolchain fields; a receipt-derived trusted-root alias is rejected. Core SHA remains an internal receipt check; raw SHA is the attested subject and bundle identity.

`scripts/governance-approval-test-entry.spec.mjs` requires this exact closed root script and fails on omission, reordering, duplicate entries, or wildcard expansion:

```json
{
  "approval-readback:test": "node --test scripts/governance-approval-schemas.spec.mjs scripts/governance-approval-safe-json.spec.mjs scripts/governance-approval-readback.spec.mjs scripts/governance-approval-state.spec.mjs scripts/governance-approval-status.spec.mjs scripts/governance-github-readback.spec.mjs scripts/governance-approval-attestation.spec.mjs scripts/governance-approval-test-entry.spec.mjs"
}
```

Run:

```bash
node --test scripts/governance-approval-attestation.spec.mjs scripts/governance-approval-test-entry.spec.mjs
```

Expected: FAIL because the seam is absent.

- [ ] **Step 2: Commit RED**

```bash
git add scripts/governance-approval-attestation.spec.mjs scripts/governance-approval-test-entry.spec.mjs
git commit -m "test: specify approval attestation verification"
```

- [ ] **Step 3: Implement fail-closed verification**

Use `execFile`, never a shell. Require the configured absolute `gh` path to report exact version `2.89.0` and expose the `attestation verify` command. Parse only `--format json`, independently compare the subject digest with receipt bytes, and treat predicate business content as untrusted. Add the exact `approval-readback:test` script above to `package.json`; do not use a glob.

- [ ] **Step 4: Run GREEN and all local approval tests**

```bash
pnpm approval-readback:test
node --test --experimental-test-coverage scripts/governance-approval-attestation.spec.mjs
pnpm exec eslint --no-ignore scripts/governance-approval-attestation.mjs scripts/governance-approval-attestation.spec.mjs
git diff --check
```

Expected: PASS with at least 80% statements and branches; unit tests execute no real external process. Report two independent results:

```text
Injected command-runner contract = PASS
Actual local gh 2.46.0         = NOT_RUN / APPROVAL_ATTESTATION_TOOLCHAIN_UNAVAILABLE
```

- [ ] **Step 5: Prepare the exact `gh 2.89.0` controlled-upgrade run card and stop**

The current host has `/usr/bin/gh` version `2.46.0` and no `attestation` subcommand. Do not replace it, write `/opt`, download an asset, or change PATH without separate system/external authorization. The authorization card must name these exact inputs and commands:

```text
target directory:
  /opt/global/toolchains/gh/2.89.0/bin/gh

checksums asset:
  https://github.com/cli/cli/releases/download/v2.89.0/gh_2.89.0_checksums.txt
  sha256:d4aa7eef1daeba32fa3821e9c98e30ca81814cc4e40a21967e49c556b2658217

linux amd64 asset:
  https://github.com/cli/cli/releases/download/v2.89.0/gh_2.89.0_linux_amd64.tar.gz
  sha256:d0422caade520530e76c1c558da47daebaa8e1203d6b7ff10ad7d6faba3490d8

precondition:
  uname -m = x86_64
  command -v curl tar sha256sum awk install mktemp = all present

post-readback:
  /opt/global/toolchains/gh/2.89.0/bin/gh --version
  /opt/global/toolchains/gh/2.89.0/bin/gh attestation verify --help

rollback:
  stop using the versioned absolute path and restore APPROVAL_GH_PATH=/usr/bin/gh;
  removal of the versioned directory is a separate explicit destructive action
```

Authorized installation command sequence:

```bash
APPROVAL_GH_TMP="$(mktemp -d)"
trap 'rm -rf -- "${APPROVAL_GH_TMP}"' EXIT
curl --proto '=https' --tlsv1.2 --location --fail --silent --show-error \
  --output "${APPROVAL_GH_TMP}/gh_2.89.0_checksums.txt" \
  https://github.com/cli/cli/releases/download/v2.89.0/gh_2.89.0_checksums.txt
curl --proto '=https' --tlsv1.2 --location --fail --silent --show-error \
  --output "${APPROVAL_GH_TMP}/gh_2.89.0_linux_amd64.tar.gz" \
  https://github.com/cli/cli/releases/download/v2.89.0/gh_2.89.0_linux_amd64.tar.gz
printf '%s  %s\n' \
  d4aa7eef1daeba32fa3821e9c98e30ca81814cc4e40a21967e49c556b2658217 \
  "${APPROVAL_GH_TMP}/gh_2.89.0_checksums.txt" | sha256sum --check --strict
printf '%s  %s\n' \
  d0422caade520530e76c1c558da47daebaa8e1203d6b7ff10ad7d6faba3490d8 \
  "${APPROVAL_GH_TMP}/gh_2.89.0_linux_amd64.tar.gz" | sha256sum --check --strict
test "$(uname -m)" = x86_64
tar --list --gzip \
  --file "${APPROVAL_GH_TMP}/gh_2.89.0_linux_amd64.tar.gz" > "${APPROVAL_GH_TMP}/archive.paths"
test -z "$(awk '$0 !~ /^gh_2[.]89[.]0_linux_amd64\// || $0 ~ /(^|\/)\.\.($|\/)/ || $0 ~ /^\// { print }' "${APPROVAL_GH_TMP}/archive.paths")"
test "$(tar --list --verbose --gzip --file "${APPROVAL_GH_TMP}/gh_2.89.0_linux_amd64.tar.gz" gh_2.89.0_linux_amd64/bin/gh | awk '{ print substr($1, 1, 1) }')" = -
tar --extract --gzip --no-same-owner --no-same-permissions \
  --file "${APPROVAL_GH_TMP}/gh_2.89.0_linux_amd64.tar.gz" \
  --directory "${APPROVAL_GH_TMP}" \
  gh_2.89.0_linux_amd64/bin/gh
test -f "${APPROVAL_GH_TMP}/gh_2.89.0_linux_amd64/bin/gh"
test ! -L "${APPROVAL_GH_TMP}/gh_2.89.0_linux_amd64/bin/gh"
install -d -o root -g root -m 0755 /opt/global/toolchains/gh/2.89.0/bin
install -o root -g root -m 0755 \
  "${APPROVAL_GH_TMP}/gh_2.89.0_linux_amd64/bin/gh" \
  /opt/global/toolchains/gh/2.89.0/bin/gh
/opt/global/toolchains/gh/2.89.0/bin/gh --version
/opt/global/toolchains/gh/2.89.0/bin/gh attestation verify --help
```

After authorization, download both assets to a `mktemp -d` directory without credentials, verify each exact SHA-256 before extraction, reject archive traversal/symlinks/unexpected entries, install only the single `bin/gh` as root-owned mode `0755` at the exact versioned path, and never overwrite `/usr/bin/gh` or create an unversioned symlink. Capture asset URLs/digests, installed-file digest, owner/mode, command outputs, timestamp, and rollback selection in a toolchain receipt. Until this readback exists, real offline verification remains NOT_RUN.

- [ ] **Step 6: Commit local seam GREEN without performing the upgrade**

```bash
git add scripts/governance-approval-attestation.mjs scripts/governance-approval-attestation.spec.mjs scripts/governance-approval-test-entry.spec.mjs package.json
git commit -m "feat: verify approval attestation bundles"
```

---

### Task 7: ContractGraph extraction and independent review

**Files:**

- Modify: `packages/code-intelligence/src/extractors/governance.ts`
- Modify: `packages/code-intelligence/src/extractors/extractors.spec.ts`
- Create: `docs/evidence/governance-readback/README.md`

**Interfaces:**

- Produces static relationships:
  ```text
  authority role → approves → decision subject
  subject → verified_by → receipt
  receipt → attested_by → verifier workflow
  receipt → authorizes_provenance_for → ADR/Release consumer
  ```
- Does not produce hosted or runtime evidence.

- [ ] **Step 1: Write RED extractor tests**

Require authority, subject, receipt schema, verifier, and attestation nodes. Hosted readback must remain `EXTERNAL_UNOBSERVED`.

Run:

```bash
pnpm --filter @global/code-intelligence test
```

Expected: focused assertions fail because relationships are absent.

- [ ] **Step 2: Commit RED**

```bash
git add packages/code-intelligence/src/extractors/extractors.spec.ts
git commit -m "test: specify trusted approval graph extraction"
```

- [ ] **Step 3: Implement minimal extraction and run GREEN**

```bash
pnpm --filter @global/code-intelligence test
pnpm --filter @global/code-intelligence exec tsx --test --experimental-test-coverage --test-coverage-include=src/extractors/governance.ts src/extractors/extractors.spec.ts
pnpm code-intelligence:scan
pnpm --filter @global/code-intelligence exec tsx src/cli.ts status --repo ../..
pnpm --filter @global/code-intelligence exec tsx src/cli.ts impact package.json pnpm-lock.yaml docs/governance/approval-authorities.schema.json docs/governance/approval-authorities.json docs/governance/trusted-approval-readback.schema.json docs/governance/trusted-approval-evidence-manifest.schema.json docs/governance/trusted-approval-revocation.schema.json docs/governance/trusted-approval-supersession.schema.json docs/governance/program-c-merge-authorization-grant.schema.json docs/governance/program-c-merge-authorization-consumption.schema.json docs/governance/README.md docs/evidence/site-builder/copy-runtime-eligibility.json docs/implementation-records/copy-fixed-source-impact-governance.md docs/evidence/governance-readback/README.md scripts/governance-approval-schema-validator.mjs scripts/governance-approval-schemas.spec.mjs scripts/governance-approval-safe-json.mjs scripts/governance-approval-safe-json.spec.mjs scripts/governance-approval-readback.mjs scripts/governance-approval-readback.spec.mjs scripts/governance-approval-state.mjs scripts/governance-approval-state.spec.mjs scripts/governance-approval-status.mjs scripts/governance-approval-status.spec.mjs scripts/governance-github-readback.mjs scripts/governance-github-readback.spec.mjs scripts/governance-approval-attestation.mjs scripts/governance-approval-attestation.spec.mjs scripts/governance-approval-test-entry.spec.mjs scripts/fixtures/approval-readback packages/code-intelligence/src/extractors/governance.ts packages/code-intelligence/src/extractors/extractors.spec.ts --repo ../..
git diff --check
```

Expected: PASS, exact-head graph clean with zero errors, hosted trust still unobserved, and changed `governance.ts` statements/branches both at least 80% in the focused extractor coverage output.

- [ ] **Step 4: Independent security review and final commit**

Review untrusted inputs, command boundaries, no-live-network tests, receipt replay, authority isolation, and false trust upgrades. After 0 Critical/High/Medium:

```bash
git add packages/code-intelligence/src/extractors/governance.ts packages/code-intelligence/src/extractors/extractors.spec.ts docs/evidence/governance-readback/README.md
git commit -m "feat: map trusted approval governance relationships"
```

## Exit Criteria

```text
Local schemas/parser/validator        = PASS
Approval state reducer/read model     = PASS
Merge grant/consumption schemas       = PASS; grant bytes immutable
Durable nonce-ledger CAS contract     = PASS; concurrent/lost-response/replay mutations executed
GitHub fixture adapter                = PASS
Injected offline attestation seam     = PASS
Actual local gh attestation verify    = NOT_RUN until exact 2.89.0 toolchain authorization/readback
Coverage                              >=80% statements/branches
ContractGraph                         = exact-head clean / 0 errors
Live network/write                    = NONE
Actual Product/Privacy/QA/Security/Legal/Merge-Authorizer actor assignments = UNASSIGNED / HOLD
Actual trusted receipt                = NONE
ADR-026/027                           = HOLD
Release/Pilot/GA                      = NOT AUTHORIZED
```
