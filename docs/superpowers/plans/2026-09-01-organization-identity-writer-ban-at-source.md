# Organization Identity Writer Ban-at-Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admit an exact independently reviewed current-main refresh into v2, build and anchor the Artifact B writer-admission baseline from that refreshed subject while preserving Artifact A Identity authority, then start a fresh v3 and replace the three exact `IdentityLink.create` callers in the machine-checked `3 → 2 → 1 → 0` sequence.

**Architecture:** A minimal closed current-main admission validator is reviewed before any fetch or local merge; a separate no-fetch audit fixes the live-main subject and conflict packet; only separately authorized fetch and local merge actions may create the exact normal two-parent `B0_REFRESH_BASE_COMMIT`. A one-parent child named `CURRENT_MAIN_ADMISSION_COMMIT` then first-adds or precisely updates only the validated current-main admission JSON; Tasks 1–6 continue from that child while product build/raw/current-migration baselines always read the merge tree at `B0_REFRESH_BASE_COMMIT`. B0 separately pins Artifact A resolver/function/ACL/six-receipt authority and creates a one-path acceptance anchor. B1–B6 run only from the later history-preserving protected-main merge commit and require an external protected-main anchor.

**Tech Stack:** Node.js 22 ESM, TypeScript 5.9.3 compiler API, Prisma/@prisma/client 6.19.3, Vitest 4, Node test runner, Git object plumbing, JSON Schema-shaped closed records, pnpm 9.15.9, GitHub Actions, PostgreSQL 16 disposable verification, Docker/OCI artifact checks.

**Spec:** `docs/superpowers/specs/2026-09-01-organization-identity-writer-ban-at-source-design.md` at exact amended and reconfirmed commit `96edb38efe14e386547de5792a6ff1e73fe7c311`, SHA-256 `624ac71c78f97b3e2ac6a13689f8f3a1033b8111751e509683a795a084f75ed0`.

## Global Constraints

- Exact amended-spec reconfirmation authorizes only this plan drafting. It does not authorize plan implementation, the pre-refresh validator, fetch, ref update, local merge/commit, scanner work, push, PR, GitHub merge, protected-main readback, root receipt, v3, database/container action, runtime, provider, credential, deployment, paid call, PR #407 closure, or worktree deletion.
- After an independent review of this exact plan reports zero Critical and zero Important findings, a future exact plan approval authorizes only Task 0A and the local/read-only pre-refresh work explicitly listed in Task 0B. It does not authorize fetch or creation of a local merge commit.
- Fetching an absent exact object/ref requires a separate authorization naming remote, ref, and SHA. Creating exact `B0_REFRESH_BASE_COMMIT` as the local two-parent refresh merge and exact `CURRENT_MAIN_ADMISSION_COMMIT` as its one-parent admission child requires another separate authorization naming the branch pre-refresh SHA, admitted live-main SHA, expected conflict paths, and closed resolution rules.
- Scanner/baseline Tasks 1–8 begin only after Task 0C produces both the exact independently reviewed two-parent `B0_REFRESH_BASE_COMMIT` and its one-parent `CURRENT_MAIN_ADMISSION_COMMIT`; their execution HEAD descends from the admission child, while every product/raw/build/current-migration comparison reads the refresh merge tree. Push, PR create/update, GitHub merge execution, protected-main readback, controller input, root-only receipt, v3 creation, and disposable PostgreSQL are each separately authorized later gates.
- Preserve exact Artifact A commit `2400bac28796bae44294114edc99eaccb1bd65b3`, the failed v1 branch `codex/pr407-organization-identity-caller-cutover@5adb69877501b240e89ae3d8617617d7bf81837f`, all applied migration bytes, all other worktrees, and all unique provenance.
- V2 work occurs only in `/global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v2` on `codex/pr407-organization-identity-caller-cutover-v2`; B1–B6 must not be implemented in that worktree or branch.
- V3 is exactly `/global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v3` on `codex/pr407-organization-identity-caller-cutover-v3`, created only from the exact live protected-main B0 merge commit after the external anchor exists.
- The refresh may admit main-owned schema/migration bytes only through exact unchanged live-main Git blobs and explicit current-main dispositions. Artifact B itself adds or edits no Prisma migration, never edits `_prisma_migrations`, and treats any Identity authority migration need as `MIGRATION_AUTHORITY_DRIFT` and a design stop.
- No scan result authorizes SQL execution, migration application, a retained database change, runtime/deployment claims, provider dispatch, paid calls, or credential use.
- The scanner reads only admitted repository source, exact Git objects, the six explicitly named B0 source receipts during pre-acceptance intake, and the exact external anchor supplied for B1–B6. It never reads `.env`, secret stores, customer data, prompts, payloads, ignored caches, or unrelated worktrees.
- Closed `IdentityLink` delegate reads are exactly `findUnique`, `findUniqueOrThrow`, `findFirst`, `findFirstOrThrow`, `findMany`, `count`, `aggregate`, and `groupBy`.
- Current known delegate writes are exactly `create`, `createMany`, `createManyAndReturn`, `update`, `updateMany`, `updateManyAndReturn`, `upsert`, `delete`, and `deleteMany`; every unknown callable method on a possible `IdentityLink` delegate is ambiguous and blocked.
- Raw methods are exactly `$executeRaw`, `$executeRawUnsafe`, `$queryRaw`, and `$queryRawUnsafe`; all refreshed direct capabilities, aliases, extracted/bound values, structural clients, SQL fragments, wrappers, dependency closures, and statically reachable ingress callers belong to the exact `B0_REFRESH_BASE_COMMIT` baseline. Artifact A remains the separate resolver/function/ACL authority subject.
- The caller contract remains `resolveOrganizationIdentityForRaw(tx, { workspaceId, rawRecordId }, lockReceipt?)`; a third argument is allowed only when it is the exact same-transaction, same-workspace `SuppressionThenIdentityLockReceipt`.
- The resolver outcomes remain the five-member union `bound | created | legacy_bound | suppressed | conflict`. `bound/created` allow caller-owned governed Canonical/Evidence contribution; `legacy_bound` is read-only reuse; `suppressed/conflict` contribute no Canonical or FieldEvidence bytes.
- In governed materialization, `conflict` maps to `NOT_CANONICALIZABLE` with the previously locked, amended-spec-derived fixed reason `IDENTITY_CONFLICT`; `identity_v2` remains a valid match rule. No alternate conflict reason is admitted by this plan.
- B0 stage verification expects all three exact `create` callsites. B2 removes the Temporal writer, B4 removes the TenantProjection writer, and B4M removes the governed materialization writer. Live zero remains an expected exit 1 diagnostic through B4 and becomes mandatory exit 0 at B4M.
- Project-total budgets are fixed at 2,000 source files, 200,000 symbol/call edges, 4,096 raw records, 8,192 wrapper-ingress records, 16,384 closure members, and 64,000,000 committed bytes. Per-file/per-resolution budgets are 20,000 AST nodes, depth 32, assignment fanout 32, alternatives 256, and 1,000,000 candidate bytes.
- B0 must measure the real `B0_REFRESH_BASE_COMMIT` graph. Artifact A counts are comparative evidence only. Every project-total hard limit must be at least twice the refreshed measurement, and the refreshed value must be at most 50% of the fixed limit. A violation requires a spec revision; no task may raise a limit locally.
- Normal exits 0/1 emit only the closed deterministic JSON schema on stdout and nothing on stderr. Exit 2 emits one closed integrity record on stdout and nothing on stderr; messages, causes, stacks, diagnostics, SQL, literals, absolute paths, credentials, and environment values are forbidden.
- The v2 acceptance commit is a one-parent child of the exact independently reviewed B0 implementation head, first-adds only `docs/governance/organization-identity-writer-acceptance.json`, and cannot include or attest its own later scoped review.
- Immediately before B0 whole review, acceptance creation/review, and protected-main merge authorization, a fresh `ls-remote` readback must equal the exact live-main SHA admitted by `organization-identity-current-main-admission.json`. Drift before acceptance repeats Tasks 0B/0C, regenerates baselines, and obtains a new whole review; drift after acceptance abandons that acceptance and restarts the refresh/implementation/review/acceptance sequence.
- After the acceptance scoped review, v2 stops at `LOCAL_ACCEPTANCE_REVIEWED`. Push, exact PR create/update, merge, protected-main readback, GitHub protected variables, and root-only receipt creation each require a separate future authorization.
- The B0 GitHub merge must be a history-preserving merge commit whose actual pre-call PR head is the exact reviewed B0 acceptance head and whose actual base is the exact admitted live-main SHA. Auto-update, queue rebase, squash, rebase, force-push, force-update, and history rewriting are forbidden. Post-readback must prove exactly two ordered parents: admitted main first, reviewed PR head second.
- B1–B6 local runs require `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json` as an explicit CLI input. Hosted runs require protected GitHub event/base identity plus controller-owned accepted-B0 and acceptance-review identities; missing or PR-controlled substitutions are `INTEGRITY_ERROR`.
- Business data changes use immutable new objects. System boundaries are exact-key, prototype/proxy/accessor-safe, bounded, and fail closed.
- Each implementation task follows RED → minimal GREEN → refactor, runs focused tests, and commits only the named task surface. Default governance tests remain green at every declared stage; the intentional B1/B3 product RED checkpoints are local intermediate commits, not mergeable heads.

---

## Evidence Baseline and Current File Map

The amended spec subject is the committed v2 head `96edb38efe14e386547de5792a6ff1e73fe7c311`; this plan is the only untracked path while drafting. The amendment review observed live/cached main at `8f3f615ea9d0494a55f67075c7eee0bb126b3386`, but that SHA, its 35-commit/111-path delta, two migrations, and three Copy conflict hunks are historical drafting evidence only—not future execution constants. Task 0B must repeat live `ls-remote`, local-object, NUL-delimited path-set, no-write merge, owner, migration, build/raw/schema/governance/caller, and conflict inspection. Implementation preflights may require zero untracked files only after this exact plan has been reviewed, approved, committed, and the execution worktree is otherwise clean.

### Existing files that may be modified or tested

| Responsibility                  | Current file(s)                                                                                                                                                                                                                                                                                                                                                | Planned use                                                                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current-main admission inputs   | `.github/CODEOWNERS`, `scripts/copy-fixed-source-impact.mjs`, `scripts/copy-fixed-source-impact.spec.mjs`, `docs/evidence/site-builder/copy-runtime-eligibility.json`, `docs/implementation-records/copy-fixed-source-impact-governance.md`                                                                                                                    | Resolve exact owners and classify/rebuild only the generated Copy evidence conflicts actually observed by the future no-write audit.               |
| Root scripts                    | `package.json`                                                                                                                                                                                                                                                                                                                                                 | Add the three named identity-writer governance commands; keep pnpm and Node floors unchanged.                                                      |
| Governance runner               | `scripts/governance-verify.mjs`                                                                                                                                                                                                                                                                                                                                | Invoke current-stage verification in B0–B4M and mandatory zero in B5/B6 without printing scanner internals.                                        |
| Explicit governance test root   | `scripts/governance-contracts.spec.mjs`, `scripts/governance-path-contracts.spec.mjs`                                                                                                                                                                                                                                                                          | Import the scanner suite and mutation-test removal of the import/wiring.                                                                           |
| Hosted governance               | `.github/workflows/governance.yml`, `.github/workflows/ci.yml`                                                                                                                                                                                                                                                                                                 | Supply protected hosted anchor inputs and prove the existing required context reaches `governance:verify`; do not add a bypass job.                |
| Build admission                 | `apps/api/tsconfig.json`, `apps/api/tsconfig.build.json`, `apps/api/package.json`, `pnpm-lock.yaml`, `Dockerfile`, `runtime-entrypoint.mjs`, `scripts/verify-runtime-image.mjs`, `packages/code-intelligence/src/extractors/typescript.ts`                                                                                                                     | Read and pin; only workflow/governance wiring changes are planned. Build inputs themselves remain unchanged unless the design stops for re-review. |
| Runtime exclusion               | `scripts/runtime-artifact-contract.spec.mjs`, `scripts/verify-runtime-artifact.mjs`, `scripts/generate-runtime-artifact-manifest.mjs`, `Dockerfile`                                                                                                                                                                                                            | Extend tests to prove scanner/tests/manifests do not enter `apps/api/dist`, release manifests, or OCI. Product runtime copy rules stay unchanged.  |
| Artifact A resolver             | `apps/api/src/discovery/organization-identity-resolver.ts`, `apps/api/src/discovery/organization-identity-lock.ts`, `apps/api/src/discovery/organization-identity-resolver.spec.ts`, `apps/api/src/discovery/organization-identity-lock.spec.ts`                                                                                                               | Consume the current exact function and composite receipt; do not change Artifact A bytes during Artifact B.                                        |
| Temporal writer                 | `apps/api/src/temporal/discovery.activities.ts`, `apps/api/src/temporal/discovery.activities.spec.ts`, `apps/api/src/temporal/discovery-company-materialization.ts`, `apps/api/src/temporal/discovery-company-materialization.activities.contract.spec.ts`, `apps/api/src/temporal/discovery.workflow.ts`                                                      | B1 RED and B2 cutover of `discovery.activities.ts:906`; keep workflow Activity name and `{companies,suppressed}` result stable.                    |
| Projection writer               | `apps/api/src/acquisition/tenant-projection.service.ts`, `apps/api/src/acquisition/tenant-projection.raw-bridge.spec.ts`, `apps/api/src/acquisition/tenant-projection.suppression.spec.ts`, `apps/api/scripts/project-source.mts`                                                                                                                              | B3 RED and B4 cutover of `tenant-projection.service.ts:230`; preserve chunk refresh and script consumer.                                           |
| Governed materialization writer | `apps/api/src/temporal/discovery-company-materialization-canonical.ts`, `apps/api/src/temporal/discovery-company-materialization.ts`, `apps/api/src/discovery/discovery-company-materialization-ctx.ts`, related existing specs                                                                                                                                | B4M removes `discovery-company-materialization-canonical.ts:206` while preserving durable C-TX outcome/replay contracts.                           |
| Migration static authority      | `packages/db/test/organization-identity-v2-resolver-command.spec.mjs`, `packages/db/test/pinned-prisma-migration-stage.spec.mjs`, `apps/api/src/discovery/organization-identity-resolver-migration.spec.ts`, `apps/api/src/discovery/organization-identity-migration-inventory.ts`, `apps/api/src/discovery/organization-identity-migration-inventory.spec.ts` | Read/execute as prerequisites; no migration file is modified.                                                                                      |
| Disposable source path          | `apps/api/test/fixtures/organization-identity-resolver-app-writer.disposable.ts`, `packages/db/test/organization-identity-v2-resolver-command.disposable.spec.mjs`                                                                                                                                                                                             | Reuse the app-user resolver pattern; create a separate Artifact B disposable test/fixture instead of changing Artifact A receipts.                 |

### Files created before or during B0

| File                                                                       | Responsibility                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/governance-organization-identity-current-main-admission.mjs`      | Closed current-main schema, exact Git set/conflict/migration validator, deterministic metadata-only generator, and closed Copy command registry.                                                                                 |
| `scripts/governance-organization-identity-current-main-admission.spec.mjs` | Pre-refresh exact-set, rename/case collision, conflict/generator provenance, migration disposition, and HOLD mutation tests.                                                                                                     |
| `docs/governance/organization-identity-current-main-admission.json`        | First-added or precisely refreshed only in `CURRENT_MAIN_ADMISSION_COMMIT`, the one-parent child of two-parent `B0_REFRESH_BASE_COMMIT`; binds admitted main, merge/parents, complete sets, deltas, and pre-merge review digest. |
| `scripts/governance-organization-identity-writers.mjs`                     | CLI, command routing, external-anchor admission, deterministic closed output.                                                                                                                                                    |
| `scripts/governance-organization-identity-writers-contracts.mjs`           | Closed enums, schemas, canonical JSON, budgets, result normalization.                                                                                                                                                            |
| `scripts/governance-organization-identity-writers-files.mjs`               | Git-object reader, build-surface pinning, lstat/realpath/symlink/TOCTOU protections.                                                                                                                                             |
| `scripts/governance-organization-identity-writers-typescript.mjs`          | One-program/one-checker delegate, raw-capability, wrapper-ingress, and dependency-closure engine.                                                                                                                                |
| `scripts/governance-organization-identity-writers-baseline.mjs`            | Refreshed build/raw/current-migration baseline generation plus separate Artifact A resolver/function/ACL/six-receipt verification.                                                                                               |
| `scripts/governance-organization-identity-writers.spec.mjs`                | Literal scanner fixtures, mutation tests, hostile filesystem tests, manifest tests, bounds, redaction, stage, anchor, and runtime exclusion.                                                                                     |
| `docs/governance/organization-identity-writer-baseline.json`               | Exact `B0_REFRESH_BASE_COMMIT` build/raw closure/wrapper ingress/delegate inventory, refreshed budget measurements, hashes, and dispositions.                                                                                    |
| `docs/governance/organization-identity-migration-authority.json`           | Complete refreshed migration directory/checksums/last-change/current-main dispositions plus Artifact A resolver/function/ACL/table privilege authority.                                                                          |
| `docs/governance/organization-identity-artifact-a-acceptance.json`         | Durable, non-secret exact Artifact A head/range and six source-receipt identities.                                                                                                                                               |
| `docs/governance/organization-identity-writer-stage.json`                  | Closed stage plus scan-result observation digest only.                                                                                                                                                                           |
| `docs/governance/organization-identity-writer-acceptance.json`             | Created later in the one-path `B0_ACCEPTANCE` commit; absent from every B0 implementation commit.                                                                                                                                |

The flat helper filenames intentionally match the terminal CODEOWNERS pattern `/scripts/governance-*.mjs`; no unowned helper directory is introduced.

## Locked Machine Interfaces

### Current-main admission contracts and validator API

```ts
type CurrentMainPathClassification =
  | "BUILD"
  | "RAW_CAPABILITY"
  | "PRISMA_SCHEMA"
  | "MIGRATION"
  | "GOVERNANCE"
  | "RUNTIME_ARTIFACT"
  | "IDENTITY_CALLER"
  | "IDENTITY_AUTHORITY"
  | "GENERATED_EVIDENCE"
  | "OTHER";

type CurrentMainPathDisposition =
  | "ADMIT_IDENTITY_AUTHORITY_UNCHANGED"
  | "ADMIT_IDENTITY_IRRELEVANT"
  | "ADMIT_GENERATED_MAIN_BYTES"
  | "ADMIT_GENERATED_REBUILT"
  | "HOLD";

type CurrentMainMigrationDisposition =
  "IDENTITY_AUTHORITY_UNCHANGED" | "IDENTITY_IRRELEVANT" | "HOLD";

type CurrentMainConflictResolutionSource =
  | "LIVE_MAIN_GIT_BLOB"
  | "COPY_FIXED_SOURCE_WRITE_ELIGIBILITY_V1"
  | "COPY_FIXED_SOURCE_SYNC_HUMAN_CITATIONS_V1";

type CurrentMainGeneratorCommandId =
  | "COPY_FIXED_SOURCE_WRITE_ELIGIBILITY_V1"
  | "COPY_FIXED_SOURCE_SYNC_HUMAN_CITATIONS_V1";

type CurrentMainOwner = Readonly<{
  source: "CODEOWNERS";
  codeownersBlobId: string;
  matchedRule: string;
  principals: readonly string[];
  resolution: "EXACT" | "UNRESOLVED";
}>;

type CurrentMainGeneratedRebuild = Readonly<{
  generatorSourceCommit: string;
  commandId: CurrentMainGeneratorCommandId;
  inputSha256: string;
  outputBlobId: string;
  outputSha256: string;
  generatedJsonSchemaSha256: string;
  generatedJsonReadbackSha256: string;
  humanCitationReadbackSha256: string;
}>;

type CurrentMainPathAdmission = Readonly<{
  path: string;
  changeKind: "ADD" | "MODIFY" | "DELETE";
  baseBlobId: string | null;
  branchBlobId: string | null;
  mainBlobId: string | null;
  resultBlobId: string | null;
  classifications: readonly CurrentMainPathClassification[];
  owner: CurrentMainOwner;
  evidenceSha256: readonly string[];
  disposition: CurrentMainPathDisposition;
  generatedRebuild: CurrentMainGeneratedRebuild | null;
}>;

type CurrentMainConflictAdmission = Readonly<{
  path: string;
  hunkCount: number;
  baseBlobId: string | null;
  branchBlobId: string | null;
  mainBlobId: string | null;
  resultBlobId: string;
  resolutionSource: CurrentMainConflictResolutionSource;
}>;

type CurrentMainMigrationAdmission = Readonly<{
  name: string;
  path: string;
  resultBlobId: string;
  migrationSqlSha256: string;
  lastChangeCommit: string;
  mainOnly: boolean;
  artifactARelationship:
    | "EXACT_ARTIFACT_A_BLOB"
    | "POST_ARTIFACT_A_MAIN_ONLY"
    | "PREEXISTING_NON_IDENTITY";
  disposition: CurrentMainMigrationDisposition;
}>;

type CurrentMainAdmission = Readonly<{
  schemaVersion: "organization-identity-current-main-admission/v1";
  status: "ADMITTED" | "HOLD";
  artifactACommit: "2400bac28796bae44294114edc99eaccb1bd65b3";
  branchPreRefreshCommit: string;
  liveMainCommit: string;
  mergeBaseCommit: string;
  refreshMergeCommit: string;
  refreshParents: readonly [string, string];
  mainOnlyRange: string;
  mainOnlyPathCount: number;
  mainOnlyPathSetSha256: string;
  paths: readonly CurrentMainPathAdmission[];
  conflicts: readonly CurrentMainConflictAdmission[];
  migrations: readonly CurrentMainMigrationAdmission[];
  rawDeltaSha256: string;
  buildDeltaSha256: string;
  schemaDeltaSha256: string;
  callerDeltaSha256: string;
  review: Readonly<{
    reportSha256: string;
    verdict: "PASS";
  }>;
}>;
```

All objects are exact-key plain records. Git object IDs are 40 lowercase hex; SHA-256 values are 64 lowercase hex; paths are normalized POSIX repository-relative paths; classifications/evidence/records are nonempty where required, deterministically sorted, and duplicate-free. `baseBlobId` is null exactly for a main-added path, `mainBlobId` exactly for a main-deleted path, `branchBlobId` exactly when the path is mechanically absent from the branch preimage, and `resultBlobId` exactly when the merge result deletes the path. `generatedRebuild` is non-null exactly for `ADMIT_GENERATED_REBUILT`; every other disposition requires null. `refreshParents` is ordered `[branchPreRefreshCommit, liveMainCommit]`. `mainOnlyPathSetSha256` is the SHA-256 of the sorted exact main-only path bytes, each followed by one NUL byte. Rename/copy status, case collisions, missing/extra/out-of-range path records, a non-exact owner, a conflict/hunk mismatch, an incomplete refreshed migration directory, any record-level `HOLD`, or top-level `HOLD` makes admission fail.

`CurrentMainAdmission.refreshMergeCommit` is exactly `B0_REFRESH_BASE_COMMIT`, the normal two-parent merge. The JSON cannot contain its own future Git commit identity; its one-parent container commit is named `CURRENT_MAIN_ADMISSION_COMMIT` by Git after the JSON is committed. `CurrentMainAdmission.review` binds the Task 0B pre-merge audited packet/review only. The Task 0C post-refresh review covers the exact range through `CURRENT_MAIN_ADMISSION_COMMIT`, remains ignored external evidence, and is bound later by `B0_ACCEPTANCE` rather than self-written into the admission JSON.

```js
// scripts/governance-organization-identity-current-main-admission.mjs
export const CURRENT_MAIN_GENERATOR_COMMANDS = Object.freeze({
  COPY_FIXED_SOURCE_WRITE_ELIGIBILITY_V1: Object.freeze([
    "node",
    "scripts/copy-fixed-source-impact.mjs",
    "--write-eligibility",
  ]),
  COPY_FIXED_SOURCE_SYNC_HUMAN_CITATIONS_V1: Object.freeze([
    "node",
    "scripts/governance-organization-identity-current-main-admission.mjs",
    "sync-copy-citations",
    "--eligibility",
    "docs/evidence/site-builder/copy-runtime-eligibility.json",
    "--citations",
    "docs/implementation-records/copy-fixed-source-impact-governance.md",
  ]),
});

export async function collectCurrentMainAuditFacts({
  repoRoot,
  branchPreRefreshCommit,
  liveMainCommit,
}) {
  // Returns exact local-object facts only; never fetches, updates refs, or merges.
}

export function validateCurrentMainAdmission(document, facts) {
  // Returns { status: "PASS", admissionSha256 } or a closed HOLD/integrity result.
}

export async function generateCurrentMainAdmission({
  facts,
  pathDispositions,
  conflictDispositions,
  migrationDispositions,
  reviewedAuditReportSha256,
}) {
  // Produces the exact metadata-only CurrentMainAdmission record.
}
```

The validator never accepts a free-form shell command, prose disposition, omitted path, or reviewer assertion in place of computed set equality. The only executable generator command is the closed command ID above. Human Copy citations are read back and hashed against the generated JSON fields; they are not treated as generator output themselves.

### Scanner module API

```js
// scripts/governance-organization-identity-writers-contracts.mjs
export const ARTIFACT_A_COMMIT = "2400bac28796bae44294114edc99eaccb1bd65b3";
export const PRISMA_VERSION = "6.19.3";
export const TYPESCRIPT_VERSION = "5.9.3";
export const DELEGATE_READ_METHODS = Object.freeze([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);
export const DELEGATE_WRITE_METHODS = Object.freeze([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
]);
export const RAW_METHODS = Object.freeze([
  "$executeRaw",
  "$executeRawUnsafe",
  "$queryRaw",
  "$queryRawUnsafe",
]);
export const WRITER_STAGES = Object.freeze([
  "B0_BASELINE",
  "B1_TEMPORAL_RED",
  "B2_TEMPORAL_CUTOVER",
  "B3_PROJECTION_RED",
  "B4_PROJECTION_CUTOVER",
  "B4M_MATERIALIZATION_CUTOVER",
  "B5_ZERO_GATE",
  "B6_CLOSEOUT",
]);

// scripts/governance-organization-identity-writers-typescript.mjs
export async function scanTypeScriptProject(input) {
  // input: { repoRoot, sourceView, buildContract, budget }
  // result: { delegateFindings, rawCapabilities, wrapperIngresses,
  //           closureMembers, measurements, sourceFiles }
}

// scripts/governance-organization-identity-writers-baseline.mjs
export async function generateRefreshedBaselines(input) {
  // input: { repoRoot, refreshBaseCommit, currentMainAdmissionCommit,
  //          currentMainAdmission,
  //          artifactACommit, receiptRoot, dispositionReceipt }
  // result: { writerBaseline, migrationAuthority, artifactAAcceptance, stage }
}
export async function verifyAcceptedAuthority(input) {
  // input: { repoRoot, command, externalAnchor, currentStage }
  // result: { status, findings, observation }
}

// scripts/governance-organization-identity-writers.mjs
export async function runIdentityWriterGovernance({
  argv,
  cwd,
  stdout,
  stderr,
}) {
  // returns numeric exit code; writes exactly one canonical JSON document
}
```

### Closed output schema

```ts
type DelegateMethod =
  | "findUnique"
  | "findUniqueOrThrow"
  | "findFirst"
  | "findFirstOrThrow"
  | "findMany"
  | "count"
  | "aggregate"
  | "groupBy"
  | "create"
  | "createMany"
  | "createManyAndReturn"
  | "update"
  | "updateMany"
  | "updateManyAndReturn"
  | "upsert"
  | "delete"
  | "deleteMany";

type RawMethod =
  "$executeRaw" | "$executeRawUnsafe" | "$queryRaw" | "$queryRawUnsafe";

type FindingKind =
  | "PRISMA_IDENTITY_LINK_MUTATION"
  | "PRISMA_IDENTITY_LINK_MUTATION_AMBIGUOUS"
  | "RAW_LITERAL_IDENTITY_LINK_FORBIDDEN"
  | "RAW_CAPABILITY_BASELINE_DRIFT"
  | "RAW_STRUCTURE_AMBIGUOUS"
  | "BUILD_SURFACE_DRIFT"
  | "MIGRATION_AUTHORITY_DRIFT"
  | "SOURCE_TOCTOU"
  | "SCAN_BUDGET_EXHAUSTED"
  | "INTEGRITY_ERROR";

type Finding = Readonly<{
  path: string;
  line: number;
  column: number;
  kind: FindingKind;
  method?: DelegateMethod | RawMethod;
}>;

type ScanOutput = Readonly<{
  schemaVersion: "organization-identity-writer-scan/v1";
  command: "baseline" | "stage" | "zero" | "acceptance";
  stage: (typeof WRITER_STAGES)[number] | null;
  status: "PASS" | "HOLD" | "INTEGRITY_ERROR";
  counts: Readonly<{
    delegateWriters: number;
    rawCapabilities: number;
    wrapperIngresses: number;
    closureMembers: number;
  }>;
  findings: readonly Finding[];
  observationSha256: string | null;
  integrityCode: "INTEGRITY_ERROR" | null;
}>;
```

Normal findings sort by `path`, `line`, `column`, `kind`, and `method`. An exit-2 record sets `counts` to four zeros, `findings` to an empty array, `observationSha256` to `null`, and `integrityCode` to the literal `INTEGRITY_ERROR`; it does not serialize the caught value.

### Baseline and stage schemas

```ts
type StructuralClosureMember = Readonly<{
  path: string;
  gitBlobId: string;
  normalizedAstSha256: string;
  role:
    | "RAW_EXPRESSION"
    | "LITERAL"
    | "CONST"
    | "FINITE_MAP"
    | "HELPER_RETURN"
    | "SQL_FRAGMENT"
    | "STRUCTURAL_TYPE"
    | "WRAPPER_ARGUMENT"
    | "DERIVATION_RULE";
}>;

type RawCapabilityRecord = Readonly<{
  id: string;
  path: string;
  line: number;
  column: number;
  enclosingSymbol: string;
  capabilityKind: string;
  method: RawMethod;
  structuralHash: string;
  closure: readonly StructuralClosureMember[];
  ingressIds: readonly string[];
  disposition:
    | "PARAMETERIZED_STATIC_STRUCTURE"
    | "REVIEWED_UNSAFE_CONSTANT"
    | "GOVERNED_IDENTITY_RESOLVER"
    | "TYPE_ONLY_CAPABILITY"
    | "FORBIDDEN_DYNAMIC_STRUCTURE";
  dispositionReceiptId: string;
}>;

type WriterBaseline = Readonly<{
  schemaVersion: "organization-identity-writer-baseline/v1";
  refreshBaseCommit: string;
  currentMainAdmissionCommit: string;
  admittedLiveMainCommit: string;
  currentMainAdmissionSha256: string;
  artifactACommit: "2400bac28796bae44294114edc99eaccb1bd65b3";
  admissionRoot: Readonly<{
    path: "apps/api/src";
    classification: "CONSERVATIVE_ADMISSION_ROOT";
  }>;
  buildSurface: Readonly<{
    apiEntrypoint: "dist/main.js";
    workerEntrypoint: "dist/temporal/worker.js";
    sourceExtensions: readonly [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs"];
    prismaVersion: "6.19.3";
    typescriptVersion: "5.9.3";
    controlledFiles: readonly Readonly<{
      path: string;
      gitBlobId: string;
      sha256: string;
    }>[];
  }>;
  measuredBudgets: Readonly<Record<string, number>>;
  delegateWriters: readonly Readonly<{
    path: string;
    method: "create";
    count: 1;
    structuralCallsiteId: string;
  }>[];
  rawCapabilities: readonly RawCapabilityRecord[];
  wrapperIngresses: readonly Readonly<{
    id: string;
    path: string;
    enclosingSymbol: string;
    structuralHash: string;
    callerIds: readonly string[];
  }>[];
}>;

type WriterStage = Readonly<{
  schemaVersion: "organization-identity-writer-stage/v1";
  stage: (typeof WRITER_STAGES)[number];
  observation: Readonly<{
    schemaVersion: "organization-identity-writer-observation/v1";
    scanResultSha256: string;
    writerSourceTreeSha256: string;
  }>;
}>;
```

The mutable stage record contains no expected path, method, count, or structural identity. Those expected sets live only in the accepted B0 stage machine. The observation hashes current bytes without embedding the future Git commit, so the source and stage can be committed atomically without self-reference.

### Artifact A authority schemas

```ts
type ArtifactAAcceptance = Readonly<{
  schemaVersion: "organization-identity-artifact-a-acceptance/v1";
  artifactACommit: "2400bac28796bae44294114edc99eaccb1bd65b3";
  artifactARange: "c998ca7f07af0fc8f3a1687c140aa8105c9567a0..2400bac28796bae44294114edc99eaccb1bd65b3";
  resolverMigration: Readonly<{
    path: "packages/db/prisma/migrations/20260830090000_organization_identity_v2_resolver_command/migration.sql";
    sha256: "3cb5fe7ca22b3067b92d71ac25198c7ff14d08c08a0907343d84130bb0b7a882";
  }>;
  sourceReceipts: readonly Readonly<{
    evidenceClass: string;
    relativePath: string;
    sha256: string;
    verdictSelector: string;
  }>[];
  containsSecrets: false;
}>;

type MigrationAuthority = Readonly<{
  schemaVersion: "organization-identity-migration-authority/v1";
  refreshBaseCommit: string;
  currentMainAdmissionCommit: string;
  admittedLiveMainCommit: string;
  artifactACommit: "2400bac28796bae44294114edc99eaccb1bd65b3";
  migrations: readonly Readonly<{
    directory: string;
    migrationSqlSha256: string;
    lastChangeCommit: string;
    mainOnly: boolean;
    artifactARelationship:
      | "EXACT_ARTIFACT_A_BLOB"
      | "POST_ARTIFACT_A_MAIN_ONLY"
      | "PREEXISTING_NON_IDENTITY";
    currentMainDisposition:
      "IDENTITY_AUTHORITY_UNCHANGED" | "IDENTITY_IRRELEVANT" | "HOLD";
  }>[];
  resolver: Readonly<{
    migrationDirectory: "20260830090000_organization_identity_v2_resolver_command";
    acceptedSha256: "3cb5fe7ca22b3067b92d71ac25198c7ff14d08c08a0907343d84130bb0b7a882";
    rejectedOrSupersededSha256: readonly string[];
  }>;
  functions: readonly Readonly<{
    signature: string;
    owner: string;
    language: string;
    volatility: string;
    security: "INVOKER" | "DEFINER";
    searchPath: string;
    proconfig: readonly string[];
    acl: readonly string[];
    definitionSha256: string;
  }>[];
  identityLinkPrivileges: readonly Readonly<{
    grantee: "app_user" | "PUBLIC";
    scope: "TABLE" | "COLUMN";
    privilege: string;
    allowed: boolean;
  }>[];
  prerequisiteReceiptIds: readonly string[];
}>;
```

The migration manifest enumerates every directory below `packages/db/prisma/migrations` at exact `B0_REFRESH_BASE_COMMIT`, not only Organization Identity migrations. Every main-only migration has an explicit current-main disposition; the Artifact A resolver migration/function/ACL/privilege arrays are re-derived from `ARTIFACT_A_COMMIT` and checked byte-for-byte in the refreshed tree. B0 does not query a retained database.

### Non-self-referential B0 acceptance schema

```ts
type B0Acceptance = Readonly<{
  schemaVersion: "organization-identity-writer-acceptance/v1";
  artifactACommit: "2400bac28796bae44294114edc99eaccb1bd65b3";
  refreshBaseCommit: string;
  admittedLiveMainCommit: string;
  refreshMergeCommit: string;
  currentMainAdmissionCommit: string;
  refreshParents: readonly [string, string];
  currentMainAdmission: Readonly<{
    gitBlobId: string;
    sha256: string;
    preMergeReviewSha256: string;
    postRefreshReviewSha256: string;
  }>;
  reviewedImplementationCommit: string;
  controlledParentBlobs: readonly Readonly<{
    path: string;
    gitBlobId: string;
    sha256: string;
  }>[];
  implementationReviews: readonly Readonly<{
    reviewId: string;
    sha256: string;
    verdict: "ZERO_CRITICAL_ZERO_IMPORTANT";
  }>[];
  stageMachine: readonly Readonly<{
    stage: (typeof WRITER_STAGES)[number];
    expectedDelegateWriters: readonly Readonly<{
      path: string;
      method: "create";
      count: 1;
      structuralCallsiteId: string;
    }>[];
  }>[];
  allowedMutableStagePath: "docs/governance/organization-identity-writer-stage.json";
}>;
```

The acceptance generator requires `refreshBaseCommit === refreshMergeCommit`, proves that commit has ordered parents `[branchPreRefreshCommit, admittedLiveMainCommit]`, proves `currentMainAdmissionCommit` has exactly one parent equal to `refreshBaseCommit`, and proves `reviewedImplementationCommit` descends from `currentMainAdmissionCommit`. It resolves every controlled blob with `git show` using the reviewed implementation parent and each exact repository-relative controlled path. It never reads controlled blobs from the acceptance commit/current working tree and never writes the acceptance's own future SHA/blob/scoped-review digest into itself.

### External protected-main anchor schema

```ts
type ProtectedMainAnchor = Readonly<{
  schemaVersion: "organization-identity-protected-main-anchor/v1";
  protectedMainSha: string;
  mergeCommitSha: string;
  admittedLiveMainSha: string;
  refreshBaseCommitSha: string;
  currentMainAdmissionCommitSha: string;
  reviewedImplementationSha: string;
  acceptedB0Sha: string;
  acceptanceReviewSha256: string;
  pullRequest: Readonly<{
    number: number;
    headSha: string;
    baseSha: string;
    mergeMethod: "MERGE_COMMIT";
  }>;
  ancestry: Readonly<{
    mergeParents: readonly [string, string];
    firstParentEqualsAdmittedMain: true;
    secondParentEqualsReviewedPrHead: true;
    implementationIsAncestor: true;
    acceptanceIsAncestor: true;
  }>;
  observedAt: string;
  predecessorReceiptSha256: string | null;
  receiptChainSha256: string;
  containsSecrets: false;
}>;
```

Local admission accepts this record only from the exact root-owned `0700` successor directory supplied with `--anchor-receipt`. The ordered `mergeParents` must be `[admittedLiveMainSha, acceptedB0Sha]`; ancestry without ordered-parent equality is insufficient. Hosted admission accepts only `GITHUB_ACTIONS=true`, an exact pull-request/base or protected-main push event read from `GITHUB_EVENT_PATH`, and controller-owned repository variables for the admitted main, accepted/review identities, ordered parents, and merge method. A PR cannot supply those values through changed YAML, package scripts, artifacts, or job output.

## Task Dependencies, Review Units, and Critical Path

| Task | Produces                                                                                                       | Consumed by         | Dependency                                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------- |
| 0A   | Reviewed minimal current-main admission validator/contracts                                                    | 0B/0C and 1–8       | Exact approved plan and committed clean execution state                           |
| 0B   | Reviewed no-fetch live-main audit packet plus exact authorization requests                                     | 0C                  | 0A review PASS                                                                    |
| 0C   | Exact two-parent `B0_REFRESH_BASE_COMMIT`, one-parent `CURRENT_MAIN_ADMISSION_COMMIT`, and post-refresh review | 1–9                 | 0B PASS plus separate exact fetch/merge authorizations                            |
| 1    | Closed scanner contracts, CLI shell, refreshed build-surface preflight RED                                     | 2–6                 | Execution HEAD=`CURRENT_MAIN_ADMISSION_COMMIT`; baseline=`B0_REFRESH_BASE_COMMIT` |
| 2    | Delegate/capability-boundary engine                                                                            | 4–8 and every stage | 1                                                                                 |
| 3    | Raw/wrapper/dependency-closure engine                                                                          | 4–8 and every stage | 1                                                                                 |
| 4    | Reviewed refreshed build/raw/migration baselines plus Artifact A Identity authority/six-receipt intake         | 5–8                 | 2 and 3                                                                           |
| 5    | Stage machine, resource/filesystem/redaction/anchor enforcement                                                | 6–8 and B1–B6       | 4                                                                                 |
| 6    | Root package/governance/workflow/runtime-exclusion wiring                                                      | 7 and 8             | 5                                                                                 |
| 7    | Exact `B0_IMPLEMENTATION` review head and independent whole-review digest                                      | 8                   | 1–6                                                                               |
| 8    | One-path accepted B0 commit and scoped acceptance review                                                       | 9                   | 7                                                                                 |
| 9    | Authorized protected-main merge identity and branch-external anchor                                            | 10                  | 8 plus separate external authorizations                                           |
| 10   | Exact v3 branch/worktree from protected-main merge                                                             | 11                  | 9 plus explicit local execution approval                                          |
| 11   | B1 Temporal five-outcome/replay RED                                                                            | 12                  | 10                                                                                |
| 12   | B2 Temporal resolver cutover, `3 → 2`                                                                          | 13                  | 11                                                                                |
| 13   | B3 projection five-outcome/chunk/replay RED                                                                    | 14                  | 12                                                                                |
| 14   | B4 projection resolver cutover, `2 → 1`                                                                        | 15                  | 13                                                                                |
| 15   | B4M materialization resolver cutover, `1 → 0`                                                                  | 16                  | 14                                                                                |
| 16   | B5 mandatory zero and downstream/governance promotion                                                          | 17                  | 15                                                                                |
| 17   | B6 mixed-fleet/replay/race/disposable proof                                                                    | 18                  | 16 plus separate disposable-resource authorization                                |
| 18   | Independent whole Artifact B code/security/database review                                                     | Handoff only        | 17                                                                                |

Critical path is `0A → 0B → separate fetch/local-merge authorizations → 0C two-parent refresh merge → 0C one-parent admission child/review → 1 → 2/3 → 4 → 5 → 6 → live-main recheck → 7 → live-main recheck → 8 → live-main recheck and external gates 9 → 10 → 11 → 12 → 13 → 14 → 15 → 16 → 17 → 18`. Task 0B may parallelize only read-only local classification after live `ls-remote`; it never fetches or changes a ref. Tasks 1–6 execute as descendants of `CURRENT_MAIN_ADMISSION_COMMIT`, but their product graph/migration/build/raw subject remains the exact `B0_REFRESH_BASE_COMMIT` merge tree. Tasks 2 and 3 may have parallel read-only fixture enumeration, but their edits share the scanner contract and must be integrated by one writer. During Task 4, refreshed migration hashing, Artifact A six-receipt readback, and raw-disposition review may run as independent read-only preparation; only the v2 owner writes tracked manifests.

## V2 Delivery: Current-Main Refresh, B0 Implementation, and Local Acceptance

### Task 0A: Minimal Current-Main Admission Validator, Generator, and Independent Review

**Files:**

- Create: `scripts/governance-organization-identity-current-main-admission.mjs`
- Create: `scripts/governance-organization-identity-current-main-admission.spec.mjs`
- Create local review exclusion only: `.superpowers/sdd/.gitignore` with the single line `*`
- Create local review output: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-admission-validator-review.md`
- Test: `scripts/governance-organization-identity-current-main-admission.spec.mjs`
- Read-only: `.github/CODEOWNERS`, `scripts/copy-fixed-source-impact.mjs`, `scripts/copy-fixed-source-impact.spec.mjs`, `packages/db/prisma/migrations`, amended spec and amendment zero review.

**Interfaces:**

- Consumes: exact amended spec commit/SHA-256; the complete `CurrentMainAdmission` contracts and command registry above; local fixture Git repositories only.
- Produces: `collectCurrentMainAuditFacts`, `validateCurrentMainAdmission`, `generateCurrentMainAdmission`, the two closed Copy command IDs, exact schema validation, one reviewed validator commit, and a zero-C/I validator review digest. It does not produce the live admission JSON.

**Commit message:** `feat: validate organization identity current-main admission`

- [ ] **Step 1: Verify the execution state enabled by future exact plan approval**

Run only after this plan is independently reviewed, explicitly approved, and committed:

```bash
cd /global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v2
test "$(git branch --show-current)" = codex/pr407-organization-identity-caller-cutover-v2
git merge-base --is-ancestor 96edb38efe14e386547de5792a6ff1e73fe7c311 HEAD
test "$(git show 96edb38efe14e386547de5792a6ff1e73fe7c311:docs/superpowers/specs/2026-09-01-organization-identity-writer-ban-at-source-design.md | sha256sum | cut -d' ' -f1)" = 624ac71c78f97b3e2ac6a13689f8f3a1033b8111751e509683a795a084f75ed0
git ls-files --error-unmatch docs/superpowers/plans/2026-09-01-organization-identity-writer-ban-at-source.md
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

Expected: PASS only in the future committed execution state. The current drafting state intentionally fails the tracked-plan/clean checks and is not an implementation state.

- [ ] **Step 2: Create the local excluded review sink without a tracked change**

Use `apply_patch` to create `.superpowers/sdd/.gitignore` with exactly:

```gitignore
*
```

Run `git check-ignore -v .superpowers/sdd/current-main-admission-validator-review.md` and require this exact local rule. Never stage or commit the local exclusion/review tree.

- [ ] **Step 3: Write the closed-schema RED fixtures**

Test every exact top-level and nested key, status, enum, Git/SHA/path format, sorted/duplicate-free array, nullable blob rule, ordered refresh parent, exact owner record, and `review.verdict="PASS"`. Add mutations for missing/extra fields, accessors, proxy objects, absolute/parent paths, non-NFC/case collisions, invalid digests, unsorted records, and record/top-level `HOLD`.

- [ ] **Step 4: Write exact main-only set and no-write merge RED fixtures**

Create bounded temporary Git repositories and require the validator to compute the NUL-delimited `mergeBaseCommit..liveMainCommit` path set itself. Tests reject one missing/extra/duplicate path, rename/copy status, out-of-range path, result blob mismatch, conflict path mismatch, and conflict hunk mismatch.

```js
test("admission rejects a prose-complete packet missing one NUL-delimited path", async () => {
  const fixture = await currentMainFixture({ mainOnlyPaths: ["a.ts", "b.ts"] });
  const document = fixture.admission({ paths: [fixture.path("a.ts")] });
  const result = validateCurrentMainAdmission(document, fixture.facts);
  assert.deepEqual(result, {
    status: "HOLD",
    code: "CURRENT_MAIN_PATH_SET_MISMATCH",
  });
});
```

- [ ] **Step 5: Write owner, generator, migration, and authority RED fixtures**

Reject unresolved/non-exact CODEOWNERS, free-form commands, unregistered command IDs, generated-output/input/schema/citation digest drift, stale feature Copy bytes, an incomplete refreshed migration directory, any changed Artifact A Identity blob, a main-only migration without `IDENTITY_AUTHORITY_UNCHANGED | IDENTITY_IRRELEVANT | HOLD`, and any `HOLD` migration.

- [ ] **Step 6: Run the validator RED**

```bash
node --test scripts/governance-organization-identity-current-main-admission.spec.mjs
```

Expected: FAIL because the admission validator module and exports do not exist.

- [ ] **Step 7: Implement the minimal exact-key contracts and deterministic output**

Implement plain-record/proxy/accessor rejection, path/digest validation, deterministic sorting/canonical JSON, closed enums, exact owner records, and stable metadata-only errors. No caught message, stack, source hunk, SQL, absolute path, or environment value may enter output.

- [ ] **Step 8: Implement allowlisted read-only Git fact collection**

The collector may invoke only local read forms of `git rev-parse`, `merge-base`, `rev-list`, `diff --name-status -z`, `diff --name-only -z`, `ls-tree -rz`, `cat-file --batch`, `show`, and old-style three-input `merge-tree`. It rejects `fetch`, `pull`, `merge`, `rebase`, `checkout`, `restore`, `commit`, `update-ref`, and any unlisted argument shape.

- [ ] **Step 9: Implement exact Copy generator/citation contracts**

Register only the two command IDs above. `sync-copy-citations` reads the generated eligibility JSON, updates only the exact `Current source fingerprint` and `Eligibility receipt SHA-256` table values in `docs/implementation-records/copy-fixed-source-impact-governance.md`, rejects multiple/missing rows, and readbacks both JSON schema and human citations before returning digests. Merely choosing feature-side conflict bytes is never a valid disposition.

- [ ] **Step 10: Implement migration and Artifact A comparison**

Enumerate the complete result migration directory; join every entry to exact Artifact A and live-main Git objects; require an explicit closed relationship/disposition; and make any changed resolver migration/function/ACL source or unknown interaction `HOLD`.

- [ ] **Step 11: Run GREEN and mutation coverage**

```bash
node --test scripts/governance-organization-identity-current-main-admission.spec.mjs
git diff --check -- \
  scripts/governance-organization-identity-current-main-admission.mjs \
  scripts/governance-organization-identity-current-main-admission.spec.mjs
```

Expected: PASS for closed schema, exact set equality, conflicts, generator/citations, migrations, authority drift, redaction, and all HOLD cases.

- [ ] **Step 12: Commit only the reviewed validator unit**

```bash
git add scripts/governance-organization-identity-current-main-admission.mjs \
  scripts/governance-organization-identity-current-main-admission.spec.mjs
git commit -m "feat: validate organization identity current-main admission"
```

Do not stage `.superpowers/sdd/.gitignore`, review reports, an admission JSON, a fetched object, or a merge result.

- [ ] **Step 13: Conduct the independent validator review**

The reviewer fixes the exact validator commit, amended spec hash, and changed two-file set; adds counterexamples for omitted NUL paths, rename/case collision, generated citation drift, conflict hunk undercount, migration omission, owner ambiguity, free-form command injection, Artifact A byte drift, and redaction; then writes the exact report with `Critical: 0`, `Important: 0`, and `Verdict: PASS` or returns to Task 0A.

- [ ] **Step 14: Freeze the review digest and stop before fetch/merge/scanner work**

```bash
VALIDATOR_REVIEW=.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-admission-validator-review.md
test -s "$VALIDATOR_REVIEW"
sha256sum "$VALIDATOR_REVIEW"
git check-ignore -v "$VALIDATOR_REVIEW"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

Expected: validator review PASS; local review artifacts are ignored by the task-local `*` rule; no fetch, ref update, merge, admission JSON, or scanner exists.

### Task 0B: Read-Only Live-Main Audit and Reviewed Authorization Packet

**Files:**

- Create local audit output: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-read-only-audit.json`
- Create local audit narrative: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-read-only-audit.md`
- Create local independent review: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-read-only-audit-review.md`
- Modify: none
- Test: `scripts/governance-organization-identity-current-main-admission.spec.mjs`
- Read-only: live `origin` main advertisement; cached refs/objects; exact branch; `.github/CODEOWNERS`; complete main-only path/migration sets; build/raw/schema/governance/runtime/caller/consumer/Identity authority source; no-write merge facts.

**Interfaces:**

- Consumes: exact reviewed Task 0A validator commit/report; branch pre-refresh SHA; live `ls-remote` SHA; locally available Git objects only.
- Produces: reviewed metadata-only audit packet with `PASS | HOLD | FETCH_AUTH_REQUIRED`, exact live-main/branch/merge-base/ranges/set digests/classifications/conflicts/owners/migrations/deltas, exact expected conflict paths/hunks/resolution rules, and distinct fetch/local-merge authorization requests. It writes no Git object/ref or tracked file.

**Commit message:** none; the audit packet is local review evidence and must not move the branch.

- [ ] **Step 1: Run the missing-packet RED**

```bash
AUDIT=.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-read-only-audit.json
test -s "$AUDIT"
```

Expected: RED with nonzero status before the live audit.

- [ ] **Step 2: Read the exact live protected-main advertisement without fetch**

```bash
git ls-remote --exit-code --refs origin refs/heads/main
REPOSITORY="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
gh api "repos/$REPOSITORY/branches/main" --jq '{sha:.commit.sha,protected:.protected}'
```

Require exactly one `<40-lowercase-hex><TAB>refs/heads/main` record, exact equality with the branch API SHA, and `protected=true`; store only SHA/ref/protected boolean in the metadata packet. These read-only network calls do not authorize `git fetch`, ref update, or merge. Missing permission/protection evidence is `HOLD`, not an assumption.

- [ ] **Step 3: Record cached refs and object availability**

```bash
BRANCH_PRE_REFRESH_COMMIT="$(git rev-parse HEAD)"
CACHED_MAIN_COMMIT="$(git rev-parse refs/remotes/origin/main)"
git show-ref --verify refs/remotes/origin/main
git cat-file -e "$LIVE_MAIN_COMMIT^{commit}"
```

If the exact live object is absent, generate a closed `FETCH_AUTH_REQUIRED` packet naming `origin`, `refs/heads/main`, and exact SHA, obtain independent review, stop, and request separate fetch authorization. Do not approximate with cached main.

- [ ] **Step 4: Compute exact ancestry and ahead/behind facts**

```bash
MERGE_BASE_COMMIT="$(git merge-base "$BRANCH_PRE_REFRESH_COMMIT" "$LIVE_MAIN_COMMIT")"
git rev-list --left-right --count "$BRANCH_PRE_REFRESH_COMMIT...$LIVE_MAIN_COMMIT"
git rev-list --count "$MERGE_BASE_COMMIT..$LIVE_MAIN_COMMIT"
git rev-list --count "$MERGE_BASE_COMMIT..$BRANCH_PRE_REFRESH_COMMIT"
```

Bind all SHAs/counts in the packet. The drafting snapshot `8f3f615e...` is not substituted for a different live SHA.

- [ ] **Step 5: Compute the exact NUL-delimited main-only path set**

Use the reviewed validator to collect `git diff --name-status -z --find-renames` and `git diff --name-only -z` for `mergeBaseCommit..liveMainCommit`. Reject rename/copy records and case collisions; hash the sorted path-plus-NUL bytes; require count/digest/set agreement across both Git views.

- [ ] **Step 6: Run and classify the no-write three-way merge**

The validator invokes only:

```bash
git merge-tree "$MERGE_BASE_COMMIT" "$BRANCH_PRE_REFRESH_COMMIT" "$LIVE_MAIN_COMMIT"
```

It hashes result facts in memory, counts exact conflict markers/hunks, records base/branch/main blobs, and emits no source text. Any conflict outside the packet's exact path/hunk/resolution disposition is `HOLD`. The two Copy paths and three hunks observed during drafting are candidates only; the future audit may produce a different set.

- [ ] **Step 7: Classify every owner and authority-relevant path**

For every main-only path, resolve the exact CODEOWNERS rule/principals from the live/result view and assign one or more closed classifications. Explicitly inspect build inputs, raw-capability sources/wrappers, full Prisma schema/migrations, governance/runtime artifact rules, all three callers, resolver/lock, Temporal/materialization, and B1–B6 downstream consumers. An unresolved owner, new possible `IdentityLink` writer, changed Artifact A authority blob, or unclassified intersection is `HOLD`.

- [ ] **Step 8: Audit complete migrations and raw/build/schema/caller deltas**

Enumerate every refreshed migration candidate, compute blob/SHA/last-change/main-only/Artifact-A relationship, and assign only the closed migration dispositions. Compute typed `rawDeltaSha256`, `buildDeltaSha256`, `schemaDeltaSha256`, and `callerDeltaSha256`; do not treat a migration name as proof of irrelevance.

- [ ] **Step 9: Generate the metadata-only audit packet**

```bash
node scripts/governance-organization-identity-current-main-admission.mjs audit \
  --branch-pre-refresh "$BRANCH_PRE_REFRESH_COMMIT" \
  --live-main "$LIVE_MAIN_COMMIT" \
  --output .superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-read-only-audit.json
```

Render the companion narrative from that JSON only; it may include paths/enums/digests/counts but no diff hunk/source/SQL/secret text.

- [ ] **Step 10: Independently review the audit and authorization requests**

The reviewer recomputes live/cached/object/ancestry/path/conflict/owner/migration facts, challenges every `ADMIT_*` disposition, and verifies the packet is `PASS` or an honest typed stop. A PASS report fixes branch pre-refresh SHA, admitted live-main SHA, exact expected conflicts/hunks, Copy main/generator resolution rules, and review SHA-256.

- [ ] **Step 11: Stop and request the two distinct future authorizations**

If the live object is absent, first request only exact fetch authorization for `origin`, `refs/heads/main`, and the reviewed SHA. After the exact object is local and the reviewed audit is PASS, request a different authorization for: creating the normal two-parent local refresh merge; resolving only the exact reviewed conflicts under the closed rules; committing that merge; generating/committing the one-path admission JSON child; and running the post-refresh local verification/review. Neither request is inferred from amended-spec reconfirmation, plan approval, read-only audit, or validator review.

### Task 0C: Separately Authorized Fetch, Two-Parent Refresh Merge, Admission Commit, and Refresh Review

**Files:**

- Create on the first refresh, or Modify on a pre-acceptance refresh repeat: `docs/governance/organization-identity-current-main-admission.json`
- Create local independent review: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-refresh-review.md`
- Modify through exact Git merge only: the complete machine-recorded main-only/result path set from Task 0B
- Modify if and only if present in the reviewed conflict set: `docs/evidence/site-builder/copy-runtime-eligibility.json`
- Modify if and only if present in the reviewed conflict set: `docs/implementation-records/copy-fixed-source-impact-governance.md`
- Test: admission validator/spec; exact merge parent/path/conflict facts; complete migration/static/API/build/raw/schema/governance/docs/Gitleaks/ContractGraph packet.

**Interfaces:**

- Consumes: Task 0B reviewed packet and exact review digest; separately authorized fetch when required; separately authorized local merge/admission commits; closed Copy command IDs.
- Produces: exact normal two-parent `REFRESH_MERGE_COMMIT == B0_REFRESH_BASE_COMMIT`; validated one-parent admission child `CURRENT_MAIN_ADMISSION_COMMIT`; full post-refresh verification; and an independent review digest over the exact range through the admission child. Tasks 1–6 execute from the admission child but derive product/raw/build/current-migration facts only from the refresh merge tree.

**Commit message:** two separately authorized commits—merge commit `chore: merge admitted main for identity writer baseline`; admission child `chore: admit current main for identity writer baseline`.

- [ ] **Step 1: Run the pre-refresh RED**

```bash
if test -e docs/governance/organization-identity-current-main-admission.json; then
  node scripts/governance-organization-identity-current-main-admission.mjs validate \
    --input docs/governance/organization-identity-current-main-admission.json \
    --expected-live-main "$LIVE_MAIN_COMMIT"
else
  test -e docs/governance/organization-identity-current-main-admission.json
fi
git merge-base --is-ancestor "$LIVE_MAIN_COMMIT" HEAD
```

Expected: RED before authorized refresh because an initial admission JSON is absent, or a previous admission does not bind the newly audited live main, and the new live main is not yet a branch ancestor.

- [ ] **Step 2: Verify exact authorization evidence and re-read live main**

Require the fetch authorization only when needed and the separate local merge/admission authorization in all cases. Re-run `git ls-remote --refs origin refs/heads/main`; it must equal Task 0B's admitted SHA. Drift returns to Task 0B and invalidates the merge authorization request.

- [ ] **Step 3: Fetch only the exact authorized object when absent**

Only after exact fetch authorization:

```bash
git fetch --no-tags origin "$LIVE_MAIN_COMMIT"
git cat-file -e "$LIVE_MAIN_COMMIT^{commit}"
```

If the object was already local, skip the fetch; plan/merge authorization never justifies a redundant network/ref mutation.

- [ ] **Step 4: Reconfirm branch preimage, plan tracking, and clean execution state**

```bash
test "$(git rev-parse HEAD)" = "$BRANCH_PRE_REFRESH_COMMIT"
git ls-files --error-unmatch docs/superpowers/plans/2026-09-01-organization-identity-writer-ban-at-source.md
test -z "$(git status --porcelain=v1 --untracked-files=all)"
node --test scripts/governance-organization-identity-current-main-admission.spec.mjs
```

Expected: exact reviewed/authorized preimage and validator PASS. Task-local review files remain ignored and do not enter Git status.

- [ ] **Step 5: Start only the authorized normal merge**

```bash
git merge --no-ff --no-commit "$LIVE_MAIN_COMMIT"
```

Do not use rebase, squash, force, auto-stash, or blanket `ours/theirs`. Compare actual conflicts/hunk counts/blob triplets to the reviewed Task 0B packet before editing any conflict. Unexpected facts stop the merge; preserve diagnostics and use only the explicitly authorized abort/recovery boundary.

- [ ] **Step 6: Resolve generated Copy conflicts from main/generator provenance**

For exact reviewed Copy conflicts, derive only the reviewed subset and begin from admitted live-main blobs rather than feature bytes:

```bash
AUDIT=.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-read-only-audit.json
mapfile -t COPY_CONFLICT_PATHS < <(jq -r '.conflicts[].path | select(
  . == "docs/evidence/site-builder/copy-runtime-eligibility.json" or
  . == "docs/implementation-records/copy-fixed-source-impact-governance.md"
)' "$AUDIT")
if ((${#COPY_CONFLICT_PATHS[@]} > 0)); then
  git restore --source="$LIVE_MAIN_COMMIT" -- "${COPY_CONFLICT_PATHS[@]}"
fi
```

If the reviewed disposition is `ADMIT_GENERATED_MAIN_BYTES`, validate those bytes and retain them. If it is `ADMIT_GENERATED_REBUILT`, run the two closed commands in order:

```bash
if jq -e '.conflicts | any(.resolutionSource == "COPY_FIXED_SOURCE_WRITE_ELIGIBILITY_V1")' "$AUDIT" >/dev/null; then
  node scripts/copy-fixed-source-impact.mjs --write-eligibility
  node scripts/governance-organization-identity-current-main-admission.mjs \
    sync-copy-citations \
    --eligibility docs/evidence/site-builder/copy-runtime-eligibility.json \
    --citations docs/implementation-records/copy-fixed-source-impact-governance.md
fi
if ((${#COPY_CONFLICT_PATHS[@]} > 0)); then
  git add "${COPY_CONFLICT_PATHS[@]}"
  test -z "$(git ls-files -u -- "${COPY_CONFLICT_PATHS[@]}")"
fi
```

Require JSON schema/readback, human citation readback, input/output blobs/digests, and generator source commit. Any non-Copy or extra conflict remains HOLD.

- [ ] **Step 7: Verify the complete merge result before commit**

Use the validator to compare every result blob/path/owner/classification/conflict/migration against Task 0B facts; scan for conflict markers; run `git diff --check`; and prove no migration blob was edited relative to either admitted parent. No path outside the exact merge result set may be staged.

- [ ] **Step 8: Create the authorized two-parent refresh merge commit**

```bash
git commit -m "chore: merge admitted main for identity writer baseline"
B0_REFRESH_BASE_COMMIT="$(git rev-parse HEAD)"
REFRESH_MERGE_COMMIT="$B0_REFRESH_BASE_COMMIT"
test "$REFRESH_MERGE_COMMIT" = "$B0_REFRESH_BASE_COMMIT"
test "$(git rev-list --parents -n 1 "$B0_REFRESH_BASE_COMMIT" | awk '{print NF}')" -eq 3
test "$(git rev-parse "$B0_REFRESH_BASE_COMMIT^1")" = "$BRANCH_PRE_REFRESH_COMMIT"
test "$(git rev-parse "$B0_REFRESH_BASE_COMMIT^2")" = "$LIVE_MAIN_COMMIT"
```

Expected: `REFRESH_MERGE_COMMIT` and `B0_REFRESH_BASE_COMMIT` are the same exact commit with two ordered parents, feature preimage first and admitted live main second. No history rewriting follows.

- [ ] **Step 9: Generate and validate the closed admission JSON**

```bash
node scripts/governance-organization-identity-current-main-admission.mjs generate \
  --audit .superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-read-only-audit.json \
  --audit-review .superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-read-only-audit-review.md \
  --refresh-merge "$B0_REFRESH_BASE_COMMIT" \
  --output docs/governance/organization-identity-current-main-admission.json \
  --replace-exact-previous-admission-if-present
node scripts/governance-organization-identity-current-main-admission.mjs validate \
  --input docs/governance/organization-identity-current-main-admission.json
```

Expected: `status="ADMITTED"`, exact complete sets, ordered refresh parents, zero HOLD records, and only metadata/digests.

- [ ] **Step 10: Commit the admission JSON as `CURRENT_MAIN_ADMISSION_COMMIT`**

```bash
git add docs/governance/organization-identity-current-main-admission.json
ADMISSION_STATUS="$(git diff --cached --name-status)"
test "$ADMISSION_STATUS" = $'A\tdocs/governance/organization-identity-current-main-admission.json' \
  || test "$ADMISSION_STATUS" = $'M\tdocs/governance/organization-identity-current-main-admission.json'
git commit -m "chore: admit current main for identity writer baseline"
CURRENT_MAIN_ADMISSION_COMMIT="$(git rev-parse HEAD)"
test "$(git rev-list --parents -n 1 "$CURRENT_MAIN_ADMISSION_COMMIT" | awk '{print NF}')" -eq 2
test "$(git rev-parse "$CURRENT_MAIN_ADMISSION_COMMIT^")" = "$B0_REFRESH_BASE_COMMIT"
git merge-base --is-ancestor 2400bac28796bae44294114edc99eaccb1bd65b3 "$B0_REFRESH_BASE_COMMIT"
git merge-base --is-ancestor "$LIVE_MAIN_COMMIT" "$B0_REFRESH_BASE_COMMIT"
```

- [ ] **Step 11: Run focused and full post-refresh verification**

```bash
node --test scripts/governance-organization-identity-current-main-admission.spec.mjs
node scripts/governance-organization-identity-current-main-admission.mjs validate \
  --input docs/governance/organization-identity-current-main-admission.json
node scripts/governance-organization-identity-current-main-admission.mjs verify-refresh \
  --input docs/governance/organization-identity-current-main-admission.json \
  --require-class BUILD \
  --require-class RAW_CAPABILITY \
  --require-class PRISMA_SCHEMA \
  --require-class MIGRATION \
  --require-class GOVERNANCE \
  --require-class RUNTIME_ARTIFACT \
  --require-class IDENTITY_CALLER \
  --require-class IDENTITY_AUTHORITY
node --test scripts/copy-fixed-source-impact.spec.mjs
node scripts/copy-fixed-source-impact.mjs
node --test \
  packages/db/test/organization-identity-v2-resolver-command.spec.mjs \
  packages/db/test/pinned-prisma-migration-stage.spec.mjs
pnpm --filter @global/db generate
pnpm --filter @global/contracts build
pnpm --filter @global/api lint
pnpm --filter @global/api build
pnpm --filter @global/api test
if git cat-file -e "$BRANCH_PRE_REFRESH_COMMIT:scripts/governance-organization-identity-writers.mjs" 2>/dev/null; then
  REFRESH_CHECK_TMP="$(mktemp -d)"
  set +e
  pnpm governance:verify >"$REFRESH_CHECK_TMP/governance.log" 2>&1
  GOVERNANCE_STATUS="$?"
  pnpm docs:verify >"$REFRESH_CHECK_TMP/docs.log" 2>&1
  DOCS_STATUS="$?"
  set -e
  test "$GOVERNANCE_STATUS" -ne 0
  test "$DOCS_STATUS" -ne 0
  rg -n 'IDENTITY_WRITER_CURRENT_MAIN_ADMISSION_DRIFT' \
    "$REFRESH_CHECK_TMP/governance.log" "$REFRESH_CHECK_TMP/docs.log"
  rm "$REFRESH_CHECK_TMP/governance.log" "$REFRESH_CHECK_TMP/docs.log"
  rmdir "$REFRESH_CHECK_TMP"
else
  pnpm governance:verify
  pnpm docs:verify
fi
gitleaks detect --source . --config .gitleaks.toml --redact --no-banner
pnpm code-intelligence:scan
pnpm code-intelligence:check
pnpm --filter @global/code-intelligence exec tsx src/cli.ts status --repo ../..
```

Expected: commands execute at `CURRENT_MAIN_ADMISSION_COMMIT`, while every product/raw/build/current-migration derivation explicitly opens `B0_REFRESH_BASE_COMMIT`; core admission, Copy, migration, API/build, Gitleaks, and ContractGraph gates PASS for that exact pair. The delta verifier proves complete build/raw/schema/migration/governance/runtime/caller/authority classification without claiming the later full writer scanner. On an initial pre-scanner refresh, governance/docs must also PASS. On a pre-acceptance repeat after Tasks 1–6 already exist, governance/docs may fail only with the exact prior identity-baseline/admission drift that Tasks 1–6 are about to regenerate; require full governance/docs PASS in Task 7 before acceptance.

- [ ] **Step 12: Conduct the independent post-refresh review**

The reviewer fixes and recomputes the exact range `B0_REFRESH_BASE_COMMIT..CURRENT_MAIN_ADMISSION_COMMIT`, proves `REFRESH_MERGE_COMMIT == B0_REFRESH_BASE_COMMIT`, verifies the admission child has one parent and only the exact admission JSON delta, recomputes ordered merge parents, path/result blobs, Copy generator/citation provenance, complete admission sets, every migration/Artifact A disposition, build/raw/schema/caller deltas, Gitleaks, governance/docs, API/build/tests, and exact ContractGraph. The post-refresh review digest is local ignored evidence and is not written back into the admission JSON; later B0 acceptance binds it separately.

- [ ] **Step 13: Freeze the reviewed refresh/admission chain and open the scanner gate**

```bash
REFRESH_REVIEW=.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-refresh-review.md
test -s "$REFRESH_REVIEW"
rg -n '^Critical: 0$|^Important: 0$|^Verdict: PASS$' "$REFRESH_REVIEW"
sha256sum "$REFRESH_REVIEW"
test "$(git rev-parse HEAD)" = "$CURRENT_MAIN_ADMISSION_COMMIT"
test "$(git rev-parse "$CURRENT_MAIN_ADMISSION_COMMIT^")" = "$B0_REFRESH_BASE_COMMIT"
test "$REFRESH_MERGE_COMMIT" = "$B0_REFRESH_BASE_COMMIT"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

Expected: reviewed two-commit refresh/admission chain fixed; Task 1 begins at `CURRENT_MAIN_ADMISSION_COMMIT`, but scanner baselines read the exact `B0_REFRESH_BASE_COMMIT` merge tree. No push/PR/remote merge/root/v3 action is implied.

### Task 1: B0 Refreshed Preflight, Closed Scanner Contracts, and Build-Surface RED

**Files:**

- Create: `scripts/governance-organization-identity-writers-contracts.mjs`
- Create: `scripts/governance-organization-identity-writers-files.mjs`
- Create: `scripts/governance-organization-identity-writers.mjs`
- Create: `scripts/governance-organization-identity-writers.spec.mjs`
- Test: `scripts/governance-organization-identity-writers.spec.mjs`
- Read-only: `docs/governance/organization-identity-current-main-admission.json`, Task 0B/0C review reports, `AGENTS.md`, `docs/CODEX-NAVIGATION-GUIDE.md`, amended spec, `apps/api/tsconfig.json`, `apps/api/tsconfig.build.json`, `apps/api/package.json`, `pnpm-lock.yaml`, `Dockerfile`, `runtime-entrypoint.mjs`, `scripts/verify-runtime-image.mjs`, `packages/code-intelligence/src/extractors/typescript.ts`

**Interfaces:**

- Consumes: execution HEAD=`CURRENT_MAIN_ADMISSION_COMMIT`; its parent exact reviewed two-parent `B0_REFRESH_BASE_COMMIT`; validated current-main admission/ordered refresh parents/pre-merge and post-refresh review digests; amended spec commit/hash; Artifact A ancestor/Identity authority; refreshed build entrypoints `dist/main.js` and `dist/temporal/worker.js`; Prisma 6.19.3; TypeScript 5.9.3.
- Produces: all closed enums and budgets above; `canonicalJson(value): string`; `readAdmittedCurrentTree(input): Promise<SourceView>`; `readGitTree(input): Promise<SourceView>`; `verifyBuildSurface(input): Promise<BuildSurfaceReceipt>`; `runIdentityWriterGovernance(...)` command shell.

**Commit message:** `test: define organization identity scanner contracts`

- [ ] **Step 1: Re-run the refreshed-base, admission, live-main, and ownership preflight**

Run:

```bash
cd /global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v2
pnpm --silent worktree:inventory | jq '.worktrees[] | select(.path == "/global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v2")'
test "$(git branch --show-current)" = "codex/pr407-organization-identity-caller-cutover-v2"
ADMISSION=docs/governance/organization-identity-current-main-admission.json
test "$(jq -er '.status' "$ADMISSION")" = ADMITTED
CURRENT_MAIN_ADMISSION_COMMIT="$(git rev-parse HEAD)"
B0_REFRESH_BASE_COMMIT="$(jq -er '.refreshMergeCommit' "$ADMISSION")"
REFRESH_MERGE_COMMIT="$B0_REFRESH_BASE_COMMIT"
BRANCH_PRE_REFRESH_COMMIT="$(jq -er '.branchPreRefreshCommit' "$ADMISSION")"
ADMITTED_LIVE_MAIN_COMMIT="$(jq -er '.liveMainCommit' "$ADMISSION")"
test "$(git rev-list --parents -n 1 "$CURRENT_MAIN_ADMISSION_COMMIT" | awk '{print NF}')" -eq 2
test "$(git rev-parse "$CURRENT_MAIN_ADMISSION_COMMIT^")" = "$B0_REFRESH_BASE_COMMIT"
test "$REFRESH_MERGE_COMMIT" = "$B0_REFRESH_BASE_COMMIT"
test "$(git rev-list --parents -n 1 "$B0_REFRESH_BASE_COMMIT" | awk '{print NF}')" -eq 3
test "$(git rev-parse "$B0_REFRESH_BASE_COMMIT^1")" = "$BRANCH_PRE_REFRESH_COMMIT"
test "$(git rev-parse "$B0_REFRESH_BASE_COMMIT^2")" = "$ADMITTED_LIVE_MAIN_COMMIT"
git merge-base --is-ancestor 96edb38efe14e386547de5792a6ff1e73fe7c311 "$B0_REFRESH_BASE_COMMIT"
git merge-base --is-ancestor 2400bac28796bae44294114edc99eaccb1bd65b3 "$B0_REFRESH_BASE_COMMIT"
test "$(git show 96edb38efe14e386547de5792a6ff1e73fe7c311:docs/superpowers/specs/2026-09-01-organization-identity-writer-ban-at-source-design.md | sha256sum | cut -d' ' -f1)" = "624ac71c78f97b3e2ac6a13689f8f3a1033b8111751e509683a795a084f75ed0"
test "$(git ls-remote --exit-code --refs origin refs/heads/main | cut -f1)" = "$ADMITTED_LIVE_MAIN_COMMIT"
node scripts/governance-organization-identity-current-main-admission.mjs validate --input "$ADMISSION"
git ls-files --error-unmatch docs/superpowers/plans/2026-09-01-organization-identity-writer-ban-at-source.md
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

Expected: execution HEAD is the one-parent `CURRENT_MAIN_ADMISSION_COMMIT`; its parent is the exact normal two-parent `B0_REFRESH_BASE_COMMIT == REFRESH_MERGE_COMMIT`; ordered merge parents, admission PASS, amended spec/Artifact A ancestors, unchanged live main, tracked plan, and clean worktree all hold. Scanner code may now be committed as descendants of the admission child, but build/raw/current-migration reads remain fixed to the refresh merge tree.

- [ ] **Step 2: Install the exact dependency graph without changing the lockfile**

Run:

```bash
pnpm install --frozen-lockfile
pnpm list -r --depth 0 @prisma/client prisma typescript --json
git diff --exit-code -- pnpm-lock.yaml
```

Expected: resolved versions include Prisma/client `6.19.3` and TypeScript `5.9.3`; the lockfile is unchanged.

- [ ] **Step 3: Write the first closed-contract and build-drift tests**

Add literal tests that assert the exact method sets, stage enum, budgets, canonical ordering, POSIX relative path rules, and a mutation of each pinned build file. The first fixture must call the not-yet-created verifier:

```js
test("build admission rejects an API entrypoint drift before source findings", async () => {
  const fixture = await buildSurfaceFixture();
  await fixture.replace(
    "apps/api/package.json",
    JSON.stringify({
      name: "@global/api",
      scripts: {
        start: "node dist/not-main.js",
        worker: "node dist/temporal/worker.js",
      },
    }),
  );
  const result = await verifyBuildSurface({
    sourceView: fixture.sourceView,
    accepted: fixture.accepted,
  });
  assert.deepEqual(result.findings, [
    {
      path: "apps/api/package.json",
      line: 1,
      column: 1,
      kind: "BUILD_SURFACE_DRIFT",
    },
  ]);
});
```

- [ ] **Step 4: Run the RED and capture the expected missing export**

Run:

```bash
node --test scripts/governance-organization-identity-writers.spec.mjs
```

Expected: FAIL because `verifyBuildSurface` or its module does not exist; no product test is involved.

- [ ] **Step 5: Implement the minimal closed contracts and canonical serializer**

Implement constants exactly as defined in this plan and reject unknown keys, proxies, accessors, non-finite numbers, duplicate normalized paths, absolute paths, `..`, and non-NFC strings. The serializer sorts object keys and preserves array order:

Import the reviewed Task 0A current-main contracts/validator instead of copying its enums or implementing a second admission parser. Current-main admission must pass before `verifyBuildSurface` or TypeScript scanning is reachable.

```js
export function canonicalJson(value) {
  const normalized = normalizeClosedValue(value, { depth: 0, nodes: 0 });
  return `${JSON.stringify(normalized)}\n`;
}

export function assertRepoPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..") ||
    value.includes("\\") ||
    value.normalize("NFC") !== value
  ) {
    throw new IntegrityFailure();
  }
  return value;
}
```

`IntegrityFailure` has no input-derived message, no cause, and no serialized stack.

- [ ] **Step 6: Implement current-tree and Git-object source views**

`readAdmittedCurrentTree` must use `lstat` before and after reading, reject symlinks and non-regular files, check realpath containment, and compare device/inode/mode/size/digest for `SOURCE_TOCTOU`. `readGitTree` must use local `git ls-tree -rz` plus `git cat-file --batch`, reject symlink/submodule/tree modes in an admitted file set, and never check out the ref.

```js
export class SourceView {
  constructor({ ref, entries }) {
    this.ref = ref;
    this.entries = Object.freeze([...entries]);
    Object.freeze(this);
  }
  read(path) {
    return exactEntry(this.entries, assertRepoPath(path)).bytes;
  }
  blobId(path) {
    return exactEntry(this.entries, assertRepoPath(path)).gitBlobId;
  }
}
```

- [ ] **Step 7: Implement the minimal build-surface verifier**

Parse both tsconfigs from exact `B0_REFRESH_BASE_COMMIT` with TypeScript's config parser; prove `apps/api/src/**/*.ts` inclusion and the exact build exclusions; parse package entrypoints; hash all pinned refreshed files; parse the lockfile only for exact Prisma/TypeScript resolutions; compare the refreshed native extractor operation set with the closed delegate set. Any mismatch against the admitted refresh returns one `BUILD_SURFACE_DRIFT` before scanning source.

- [ ] **Step 8: Run GREEN and focused mutation cases**

Run:

```bash
node --test --test-name-pattern='closed contract|build admission|path|Git object' scripts/governance-organization-identity-writers.spec.mjs
git diff --check
```

Expected: PASS, including independent mutations for config, entrypoint, Docker copy, supported extension, generated-source exclusion, Prisma version, TypeScript version, and native extractor operations.

- [ ] **Step 9: Commit the reviewable preflight unit**

```bash
git add scripts/governance-organization-identity-writers-contracts.mjs \
  scripts/governance-organization-identity-writers-files.mjs \
  scripts/governance-organization-identity-writers.mjs \
  scripts/governance-organization-identity-writers.spec.mjs
git commit -m "test: define organization identity scanner contracts"
```

### Task 2: TypeScript Delegate and Capability-Boundary Engine

**Files:**

- Create: `scripts/governance-organization-identity-writers-typescript.mjs`
- Modify: `scripts/governance-organization-identity-writers.spec.mjs`
- Test: `scripts/governance-organization-identity-writers.spec.mjs`
- Read-only: `packages/code-intelligence/src/extractors/typescript.ts`, generated Prisma delegate types under the installed `@prisma/client`, the three writer sources.

**Interfaces:**

- Consumes: `SourceView`, build contract, closed delegate read/write sets, shared budget ledger.
- Produces: `createTypeScriptProject(input): ProjectContext`; `scanIdentityLinkDelegates(context): readonly DelegateFinding[]`; structural callsite identity `sha256(path + enclosingSymbol + normalizedExpression)`; exact-three `B0_REFRESH_BASE_COMMIT` inventory.

**Commit message:** `feat: detect identity delegate capability escapes`

- [ ] **Step 1: Add literal fixtures for every direct delegate method**

Create in-memory source views with all eight reads, all nine writes including `createManyAndReturn` and `updateManyAndReturn`, an unknown future method, literal/computed model keys, and line/column assertions. Expected writes are `PRISMA_IDENTITY_LINK_MUTATION`; unknowns are `PRISMA_IDENTITY_LINK_MUTATION_AMBIGUOUS`.

- [ ] **Step 2: Add boundary-escape fixtures**

Add same-file and cross-file cases for argument, parameter, return, export/import, object, array, map, class field, closure, extraction, destructuring, `.bind`, proxy-shaped type, extension client, `any`, `unknown`, unresolved generic, union, and `tx[model].create`. Every possible escaped `IdentityLink` capability must be ambiguous even when the downstream method text is a read.

- [ ] **Step 3: Run the delegate RED**

Run:

```bash
node --test --test-name-pattern='delegate|capability boundary|ManyAndReturn' scripts/governance-organization-identity-writers.spec.mjs
```

Expected: FAIL because `scanIdentityLinkDelegates` is absent.

- [ ] **Step 4: Build one TypeScript Program and checker**

Use the exact parsed `apps/api/tsconfig.build.json`, the admitted `SourceView`, and installed dependency declarations. A custom `CompilerHost` reads repository source from the chosen current/Git view and dependency `.d.ts` from the pinned local package graph. Reject diagnostics instead of scanning a partial Program.

```js
export function createTypeScriptProject({
  sourceView,
  buildContract,
  dependencyRoot,
  budget,
}) {
  const host = createPinnedCompilerHost({ sourceView, dependencyRoot, budget });
  const program = ts.createProgram({
    rootNames: buildContract.rootNames,
    options: buildContract.compilerOptions,
    host,
  });
  if (ts.getPreEmitDiagnostics(program).length !== 0)
    throw new IntegrityFailure();
  return Object.freeze({ program, checker: program.getTypeChecker(), budget });
}
```

- [ ] **Step 5: Implement proved Prisma and `IdentityLink` origins**

Trace the checker symbol/type back to pinned `PrismaClient` or `Prisma.TransactionClient`. Permit only a direct call whose model property is statically `identityLink` and whose method is one of the eight reads. Treat computed/dynamic model keys and structural clients that may contain the delegate as ambiguous.

- [ ] **Step 6: Implement the capability-boundary ban**

Use a worklist keyed by checker symbol plus operation. Before following an assignment, alias, parameter, return, container, property, or import edge, charge the shared ledger. A direct same-expression alias may resolve; every listed boundary produces an ambiguous finding rather than semantic propagation.

```js
function admitIdentityDelegateUse(node, context) {
  const origin = possibleIdentityLinkOrigin(node.expression, context);
  if (origin.kind === "NONE") return [];
  if (origin.crossedBoundary || origin.dynamic || !origin.method) {
    return [finding(node, "PRISMA_IDENTITY_LINK_MUTATION_AMBIGUOUS")];
  }
  return DELEGATE_READ_METHODS.includes(origin.method)
    ? []
    : [finding(node, "PRISMA_IDENTITY_LINK_MUTATION", origin.method)];
}
```

- [ ] **Step 7: Verify generated/native parity**

Enumerate callable generated `IdentityLinkDelegate` methods and compare them with the 17-method closed set; extract the repository-native Prisma operation constants and compare. A new, removed, or differently named method is `BUILD_SURFACE_DRIFT`, never implicitly read-only.

- [ ] **Step 8: Prove exact current writer inventory**

Run the focused scanner fixture against exact `B0_REFRESH_BASE_COMMIT` and assert exactly one `create` at each path:

```text
apps/api/src/temporal/discovery.activities.ts
apps/api/src/acquisition/tenant-projection.service.ts
apps/api/src/temporal/discovery-company-materialization-canonical.ts
```

Line/column must be positive, but structural identity excludes line/column.

- [ ] **Step 9: Run GREEN and commit**

```bash
node --test --test-name-pattern='delegate|capability boundary|ManyAndReturn|generated parity|exact three' scripts/governance-organization-identity-writers.spec.mjs
git diff --check
git add scripts/governance-organization-identity-writers-typescript.mjs \
  scripts/governance-organization-identity-writers.spec.mjs
git commit -m "feat: detect identity delegate capability escapes"
```

### Task 3: Raw Capability, Wrapper Ingress, and Full Dependency Closure Engine

**Files:**

- Modify: `scripts/governance-organization-identity-writers-typescript.mjs`
- Modify: `scripts/governance-organization-identity-writers-contracts.mjs`
- Modify: `scripts/governance-organization-identity-writers.spec.mjs`
- Test: `scripts/governance-organization-identity-writers.spec.mjs`

**Interfaces:**

- Consumes: one Program/checker created from exact `B0_REFRESH_BASE_COMMIT`, refreshed `SourceView`, shared ledger, `RAW_METHODS`.
- Produces: `scanRawCapabilities(context): RawInventory`; canonical `RawCapabilityRecord`, `WrapperIngressRecord`, and complete structural dependency-closure hashes used unchanged by the admitted refresh baseline and every stage.

**Commit message:** `feat: freeze raw database capability closure`

- [ ] **Step 1: Add all four raw-method shape fixtures**

For each raw method, test tag/call, extraction, destructuring, assignment, `.bind`, return, export/import, parameter, class field, object/array/map, conditional storage, structural/injected clients, and cross-file wrapper calls. Add a new caller to an unchanged wrapper and assert ingress drift.

- [ ] **Step 2: Add SQL-structure/interpolation fixtures**

Exercise direct tags and `Prisma.sql` with ordinary bound values; direct-tag `Prisma.raw`; nested `Prisma.join`; local/imported/helper-returned `Prisma.Sql`; `Sql|string`, `any`, `unknown`, dynamic raw methods, maps, unsafe finite constants, dynamic unsafe strings, concatenation, `format`, dynamic `EXECUTE`, `U&` identifiers, side-effecting function calls, quoted-case and Unicode-adjacent `identity_link` mentions.

- [ ] **Step 3: Add full-closure mutation fixtures**

Hold the outer call expression constant while mutating one referenced const, finite map value, helper return, imported type, wrapper argument, `Prisma.join` item, scanner rule, native extractor operation, or source-file blob. Each mutation must change the structural hash or produce ambiguity.

- [ ] **Step 4: Run the raw-closure RED**

Run:

```bash
node --test --test-name-pattern='raw capability|wrapper ingress|dependency closure|interpolation|literal mention' scripts/governance-organization-identity-writers.spec.mjs
```

Expected: FAIL because raw capability scanning and closure commitments are not implemented.

- [ ] **Step 5: Implement raw origin and wrapper discovery**

Resolve direct and possible Prisma origins with the checker. Register a capability record at every raw property/tag/call/extraction boundary. Build named wrapper edges across import/export aliases, direct arguments, parameters, returns, finite keys, and calls; an unresolved edge becomes `RAW_STRUCTURE_AMBIGUOUS`.

```js
export function scanRawCapabilities(context) {
  const capabilities = discoverRawCapabilityRoots(context);
  const wrappers = discoverRawWrappers(capabilities, context);
  const ingresses = closeWrapperIngresses(wrappers, context);
  return commitRawInventory({ capabilities, ingresses, context });
}
```

- [ ] **Step 6: Implement one interpolation classifier**

Classify `BOUND_VALUE` only when type and origin exclude `Prisma.Sql`, sql-template-tag `Sql`, `Prisma.raw`, `Prisma.join`, `Prisma.empty`, `any`, `unknown`, unresolved generics, structural unions, and unproved imported/helper SQL. Traverse finite `Prisma.Sql` and join items under the same ledger. Any `Prisma.raw` is ambiguous and drift regardless of a constant argument.

- [ ] **Step 7: Commit the full executable preimage**

Canonical closure ordering is `role`, `path`, `enclosing symbol`, Git blob ID, normalized AST digest, then ordered child IDs. Hash template/string bytes without printing them, const definitions, finite maps, helper returns, SQL fragments, types/unions, wrapper arguments/ingress, scanner/build/extractor/TypeScript/Prisma derivation blobs.

- [ ] **Step 8: Implement the secondary literal detector**

Run a bounded ASCII-case-insensitive substring check for `identity_link` across every statically available raw segment, string, finite SQL fragment, comment, quote, dollar body, cast, and procedural body. A hit is `RAW_LITERAL_IDENTITY_LINK_FORBIDDEN`; an absence never reclassifies dynamic structure as safe.

- [ ] **Step 9: Prove shared cycles and budgets**

Cycle keys are checker symbol plus operation. Charge candidate bytes/records before allocation. Tests recursively re-enter aliases/wrappers/classification and prove counters do not reset. Exact exhaustion returns `SCAN_BUDGET_EXHAUSTED` and exit 1.

- [ ] **Step 10: Run GREEN and commit**

```bash
node --test --test-name-pattern='raw capability|wrapper ingress|dependency closure|interpolation|literal mention|budget|cycle' scripts/governance-organization-identity-writers.spec.mjs
git diff --check
git add scripts/governance-organization-identity-writers-contracts.mjs \
  scripts/governance-organization-identity-writers-typescript.mjs \
  scripts/governance-organization-identity-writers.spec.mjs
git commit -m "feat: freeze raw database capability closure"
```

### Task 4: Refreshed Raw/Build/Migration Baselines and Artifact A Identity Authority Intake

**Files:**

- Create: `scripts/governance-organization-identity-writers-baseline.mjs`
- Create: `docs/governance/organization-identity-writer-baseline.json`
- Create: `docs/governance/organization-identity-migration-authority.json`
- Create: `docs/governance/organization-identity-artifact-a-acceptance.json`
- Create: `docs/governance/organization-identity-writer-stage.json`
- Create (ignored review input): `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b0-raw-capability-disposition-review.json`
- Modify: `scripts/governance-organization-identity-writers.spec.mjs`
- Test: `scripts/governance-organization-identity-writers.spec.mjs`
- Test without modification: `docs/governance/organization-identity-current-main-admission.json`
- Test read-only: `packages/db/test/organization-identity-v2-resolver-command.spec.mjs`, `packages/db/test/pinned-prisma-migration-stage.spec.mjs`, `apps/api/src/discovery/organization-identity-resolver-migration.spec.ts`, `apps/api/src/discovery/organization-identity-migration-inventory.spec.ts`

**Interfaces:**

- Consumes: exact two-parent `B0_REFRESH_BASE_COMMIT` as product baseline tree; execution lineage through one-parent `CURRENT_MAIN_ADMISSION_COMMIT`; validated admission JSON and Task 0B/0C review digests; Task 2/3 refreshed inventory; exact Artifact A Git tree only for resolver/function/ACL/six-receipt authority; independent refreshed raw disposition receipt.
- Produces: immutable refreshed writer/migration baselines, separate Artifact A authority acceptance, initial B0 stage receipt, `generateRefreshedBaselines`, `verifyMigrationAuthority`, and refreshed measured headroom.

**Commit message:** `test: bind refreshed identity authority inputs`

- [ ] **Step 1: Add manifest-schema and drift RED cases**

Test exact keys, duplicate records, ordering, digest formats, absolute/parent paths, wrong refresh/admitted-main/merge/admission/review identity, current-main admission drift, refreshed migration addition/removal/checksum/last-change/disposition drift, wrong Artifact A commit, function owner/language/security/search-path/proconfig/ACL/definition drift, and `app_user`/PUBLIC table/column privilege drift.

- [ ] **Step 2: Run migration prerequisites before generation**

Run:

```bash
node --test \
  packages/db/test/organization-identity-v2-resolver-command.spec.mjs \
  packages/db/test/pinned-prisma-migration-stage.spec.mjs
pnpm --filter @global/api exec vitest run \
  src/discovery/organization-identity-resolver-migration.spec.ts \
  src/discovery/organization-identity-migration-inventory.spec.ts
```

Expected: the Node prerequisite suite passes 15/15 and the focused Vitest suites pass. Any failure is `MIGRATION_AUTHORITY_DRIFT`; do not generate a baseline around it.

- [ ] **Step 3: Verify all six source receipts byte-for-byte**

Run:

```bash
RECEIPT_ROOT=/global/backend/.codex/worktrees/root-worktree-remote-closeout-plan
sha256sum \
  "$RECEIPT_ROOT/.superpowers/sdd/2026-08-30-organization-identity-command-expansion/task-A7-report.md" \
  "$RECEIPT_ROOT/.superpowers/sdd/2026-08-30-organization-identity-command-expansion/final-whole-branch-review.md" \
  "$RECEIPT_ROOT/.superpowers/sdd/2026-08-30-organization-identity-command-expansion/task-A7-independent-code-review.md" \
  "$RECEIPT_ROOT/.superpowers/sdd/2026-08-30-organization-identity-command-expansion/task-A7-independent-db-review.md" \
  "$RECEIPT_ROOT/.superpowers/sdd/2026-08-30-organization-identity-command-expansion/task-A7-independent-security-review.md" \
  "$RECEIPT_ROOT/.superpowers/sdd/2026-08-30-organization-identity-command-expansion/task-A7-task-review.md"
```

Expected, in order: `a7faa97e...`, `0263be60...`, `b473e15b...`, `9ee0be20...`, `3debad7d...`, and `7fbcbb05...` exactly as listed in the spec. The A7 chronology selector is only §11 `Final GREEN verification and receipt-bound cleanup`; its earlier top-level blocked history is not interpreted as the final gate.

The generator hard-codes and tests these exact receipt SHA-256 values rather than accepting caller-provided expected values:

```text
a7faa97ecca4bbc28f79cd4a8c77ff33eedcbc771273cea793bbfdd086b91cab
0263be60a8c66a13ec36bd8d4c541c53c0ef91d2ab5c77bd1a771295cee067b4
b473e15b84ef9d4db72de7b24f7844d905e913203043824d7741b663fbe269e0
9ee0be2034eaded1e532b6b7c7a2079c0917d2b684ea52a65111cb03945f0f13
3debad7dc240981e5cb25be983c53a6e02b2234d2b57e1bd5e780355734d9989
7fbcbb0582d344e4579b1887e5a16a2a49e7d1d3a0ab8e5eb4c791f74787426d
```

- [ ] **Step 4: Run the baseline RED**

Run:

```bash
node scripts/governance-organization-identity-writers.mjs baseline \
  --refresh-base "$B0_REFRESH_BASE_COMMIT" \
  --current-main-admission-commit "$CURRENT_MAIN_ADMISSION_COMMIT" \
  --current-main-admission docs/governance/organization-identity-current-main-admission.json \
  --artifact-a 2400bac28796bae44294114edc99eaccb1bd65b3 \
  --receipt-root /global/backend/.codex/worktrees/root-worktree-remote-closeout-plan \
  --disposition-receipt .superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b0-raw-capability-disposition-review.json \
  --check-only
```

Expected: exit 2 with the closed `INTEGRITY_ERROR` record because the baseline generator/disposition receipt is absent; stderr is empty.

- [ ] **Step 5: Implement refreshed migration derivation and separate Artifact A function/ACL verification**

Enumerate every migration directory at `B0_REFRESH_BASE_COMMIT` with `git ls-tree`, hash its `migration.sql`, find its last-change commit, and require exact equality with current-main admission migration records/dispositions. Separately parse the exact Artifact A resolver migration/catalog fixture contracts to produce the seven Organization Identity function records and explicit app_user/PUBLIC table/column privilege observations, then prove those authority bytes remain exact in the refreshed tree. Bind the rejected/superseded checksums named by Artifact A evidence. Do not connect to PostgreSQL.

The seven exact function identities are `organization_identity_acquire_advisory_until_v1(bigint,timestamp with time zone)`, `organization_identity_authority_from_raw_v1(text,jsonb)`, `organization_identity_blocker_from_raw_v1(jsonb)`, `organization_identity_canonical_suppression_value_v1(text,text)`, `organization_identity_plan_from_snapshot_v1(jsonb)`, `organization_identity_resolve_for_raw_worker_v1(text,text)`, and `resolve_organization_identity_for_raw_v1(text,text)`. The privilege baseline must also state that `app_user` has SELECT plus INSERT on exactly `id, workspace_id, canonical_type, canonical_id, raw_record_id, match_rule, confidence`, has no table-level INSERT and no UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER; `app_user` alone has EXECUTE on the public resolver; PUBLIC and `app_user` have no EXECUTE on private helpers; and PUBLIC has no relevant write authority.

- [ ] **Step 6: Generate a candidate raw inventory for independent classification**

Run the real `B0_REFRESH_BASE_COMMIT` virtual Program and write a temporary closed candidate to stdout redirected outside the repository only after the executor creates a task-specific `mktemp -d`. The reviewer assigns one closed disposition to every refreshed record, rejects every dynamic/unresolved record, includes only record IDs/hashes/dispositions, and writes the exact ignored disposition receipt. The receipt contains no SQL/source text, absolute roots, or secrets.

- [ ] **Step 7: Independently review every raw capability and wrapper ingress**

The reviewer must verify every current raw record and reachable ingress, add counterexamples not copied from the implementer fixtures, and sign the receipt with:

```json
{
  "schemaVersion": "organization-identity-raw-disposition-review/v1",
  "sourceSubject": "B0_REFRESH_BASE_COMMIT",
  "artifactACommit": "2400bac28796bae44294114edc99eaccb1bd65b3",
  "verdict": "ZERO_UNRESOLVED_SURFACES",
  "records": [],
  "counterexampleFixtureSha256": "0000000000000000000000000000000000000000000000000000000000000000"
}
```

The displayed empty `records` array is the schema minimum used by the parser unit fixture; the real receipt must contain exactly one entry for each generated capability/ingress ID and fails closed when empty against the real graph.

- [ ] **Step 8: Implement deterministic baseline generation**

Validate but never regenerate `organization-identity-current-main-admission.json`. Generate the four new tracked JSON files with `flag: "wx"`; existing outputs cause failure. The writer/migration baselines bind `refreshBaseCommit=B0_REFRESH_BASE_COMMIT`, `currentMainAdmissionCommit=CURRENT_MAIN_ADMISSION_COMMIT`, admitted main, admission JSON, and review identities, then join the refreshed scanner inventory to the disposition receipt by exact ID and structural hash. `FORBIDDEN_DYNAMIC_STRUCTURE`, an absent record, an extra review record, unresolved ingress, admission mismatch, or HOLD migration blocks generation.

- [ ] **Step 9: Measure and enforce headroom**

Record actual `B0_REFRESH_BASE_COMMIT` counts for source files, symbol/call edges, raw capabilities, wrapper ingresses, closure members, and committed bytes. Artifact A counts may appear only as comparative evidence. For every project-total refreshed measure assert `measured * 2 <= fixedLimit`; never round down or raise a limit.

- [ ] **Step 10: Generate the tracked B0 records**

Run:

```bash
node scripts/governance-organization-identity-writers.mjs baseline \
  --refresh-base "$B0_REFRESH_BASE_COMMIT" \
  --current-main-admission-commit "$CURRENT_MAIN_ADMISSION_COMMIT" \
  --current-main-admission docs/governance/organization-identity-current-main-admission.json \
  --artifact-a 2400bac28796bae44294114edc99eaccb1bd65b3 \
  --receipt-root /global/backend/.codex/worktrees/root-worktree-remote-closeout-plan \
  --disposition-receipt .superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b0-raw-capability-disposition-review.json \
  --output-directory docs/governance
```

Expected: exit 0 closed JSON; the baseline has exactly three delegate writers and no ambiguous/forbidden raw disposition; the stage is `B0_BASELINE`.

- [ ] **Step 11: Re-run generation in check-only mode and mutation tests**

Run:

```bash
node scripts/governance-organization-identity-writers.mjs baseline \
  --refresh-base "$B0_REFRESH_BASE_COMMIT" \
  --current-main-admission-commit "$CURRENT_MAIN_ADMISSION_COMMIT" \
  --current-main-admission docs/governance/organization-identity-current-main-admission.json \
  --artifact-a 2400bac28796bae44294114edc99eaccb1bd65b3 \
  --receipt-root /global/backend/.codex/worktrees/root-worktree-remote-closeout-plan \
  --disposition-receipt .superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b0-raw-capability-disposition-review.json \
  --check-only
node --test --test-name-pattern='baseline|migration authority|function|ACL|receipt|headroom' scripts/governance-organization-identity-writers.spec.mjs
```

Expected: both PASS; changing admission/review identity, refreshed migration directory/disposition/checksum, Artifact A receipt/function/ACL observation, refreshed raw closure, or manifest byte fails closed.

- [ ] **Step 12: Commit the refreshed baseline and separate Artifact A authority unit**

```bash
git add scripts/governance-organization-identity-writers-baseline.mjs \
  scripts/governance-organization-identity-writers.spec.mjs \
  docs/governance/organization-identity-writer-baseline.json \
  docs/governance/organization-identity-migration-authority.json \
  docs/governance/organization-identity-artifact-a-acceptance.json \
  docs/governance/organization-identity-writer-stage.json
git commit -m "test: bind refreshed identity authority inputs"
```

Do not add the ignored disposition review to Git; its digest and bounded identity are recorded in the baseline and later controlled by the implementation review/acceptance.

### Task 5: Stage Machine, Accepted-Blob Checks, Redaction, and Filesystem Hardening

**Files:**

- Modify: `scripts/governance-organization-identity-writers-contracts.mjs`
- Modify: `scripts/governance-organization-identity-writers-files.mjs`
- Modify: `scripts/governance-organization-identity-writers-baseline.mjs`
- Modify: `scripts/governance-organization-identity-writers.mjs`
- Modify: `scripts/governance-organization-identity-writers.spec.mjs`
- Test: `scripts/governance-organization-identity-writers.spec.mjs`

**Interfaces:**

- Consumes: exact two-parent `B0_REFRESH_BASE_COMMIT`, its one-parent `CURRENT_MAIN_ADMISSION_COMMIT`, Task 0B+0C review identities, refreshed B0 baselines, separate Artifact A authority, future B0 acceptance Git object, current stage, and optional external anchor.
- Produces: `verifyStage`, `verifyZero`, `verifyAcceptanceShape`, `loadExternalAnchor`, mandatory current-main admission revalidation, exact `3 → 2 → 1 → 0` expected-set evaluation, stable exits 0/1/2.

**Commit message:** `feat: harden identity writer stage scanner`

- [ ] **Step 1: Add all stage-matrix RED fixtures**

For every stage assert exact remaining set: three for B0/B1, Temporal removed for B2/B3, only materialization for B4, zero for B4M/B5/B6. Swap a path, method, count, or structural identity; add expected-set fields to the mutable stage; remove one baseline writer; regenerate a manifest; each must fail.

- [ ] **Step 2: Add acceptance-parent and external-anchor RED fixtures**

Use temporary Git repositories to prove: acceptance parent substitution, two parents, more than one changed path, non-first-add acceptance, controlled blob read from current tree, non-ancestor accepted SHA, squash/rebase-shaped history, wrong review digest, wrong merge method, missing local receipt, PR-controlled hosted values, and receipt-chain mismatch all return exit 2.

- [ ] **Step 3: Add filesystem/TOCTOU hostile fixtures**

Test internal/external symlink, broken symlink, FIFO/special file, realpath escape, unsupported extension, duplicate normalized path, case collision, pre-read replacement, post-read device/inode/mode/size/content change, absolute manifest paths, and parent segments.

- [ ] **Step 4: Add redaction fixtures for every exception family**

Inject filesystem, Git, TypeScript, resolver, budget, config, JSON, and unexpected exceptions containing credential-like values, SQL, absolute roots, stack/cause/message/diagnostics. Capture stdout/stderr and assert none of those bytes occur. Exit 2 must equal the canonical integrity record byte-for-byte.

- [ ] **Step 5: Run the stage/redaction RED**

Run:

```bash
node --test --test-name-pattern='stage machine|acceptance parent|external anchor|symlink|TOCTOU|redaction|integrity output' scripts/governance-organization-identity-writers.spec.mjs
```

Expected: FAIL because stage/anchor verification is incomplete.

- [ ] **Step 6: Implement immutable expected-set derivation**

At B0 before acceptance, first validate `organization-identity-current-main-admission.json`, exact refresh/admitted-main/ordered local-merge parents, and Task 0C review digest; then allow only `B0_BASELINE` and compare to the refreshed exact baseline. Once an acceptance file exists, validate its one-parent/one-path first-add shape and resolve every controlled blob from its named implementation parent. At B1–B6, read the externally fixed acceptance object with `git show`, not working-tree bytes, and load the stage map only from that object.

- [ ] **Step 7: Implement current and Artifact A re-derivation**

Every run verifies current scanner/helper/test/build/baseline/migration/admission/native-extractor blobs equal the accepted parent-tree blobs, then scans current source and a virtual Program from exact `B0_REFRESH_BASE_COMMIT`; separately re-derive Artifact A resolver/function/ACL authority from `2400bac28796bae44294114edc99eaccb1bd65b3`. Allow only expected writer removals; raw additions, removals outside accepted disposition, closure/ingress/hash drift, refreshed migration/admission drift, Artifact A authority drift, or controlled manifest edits are policy HOLD.

- [ ] **Step 8: Implement external-anchor admission**

Local stage >= B1 requires `--anchor-receipt` and checks exact `0700 root:root` parent/receipt ownership without printing stat paths. Hosted mode requires a validated GitHub event path and controller-owned variables; it verifies protected base/main SHA, `MERGE_COMMIT`, accepted/review identities, peeled parents, and ancestry. Any missing input is exit 2.

- [ ] **Step 9: Implement command semantics**

`stage` succeeds only when the current stage expected set and all immutable baselines match. `zero` returns exit 1 with remaining delegate findings through B4 and exit 0 with an empty finding set at B4M onward. `baseline --check-only` never writes. `acceptance --check` validates but never creates.

- [ ] **Step 10: Run GREEN, full scanner suite, and commit**

```bash
node --test scripts/governance-organization-identity-writers.spec.mjs
node scripts/governance-organization-identity-writers.mjs stage
test "$?" -eq 0
IDENTITY_WRITER_TMP="$(mktemp -d)"
set +e
node scripts/governance-organization-identity-writers.mjs zero \
  > "$IDENTITY_WRITER_TMP/stdout.json" 2> "$IDENTITY_WRITER_TMP/stderr.txt"
ZERO_STATUS="$?"
set -e
test "$ZERO_STATUS" -eq 1
test ! -s "$IDENTITY_WRITER_TMP/stderr.txt"
rm "$IDENTITY_WRITER_TMP/stdout.json" "$IDENTITY_WRITER_TMP/stderr.txt"
rmdir "$IDENTITY_WRITER_TMP"
git diff --check
git add scripts/governance-organization-identity-writers-contracts.mjs \
  scripts/governance-organization-identity-writers-files.mjs \
  scripts/governance-organization-identity-writers-baseline.mjs \
  scripts/governance-organization-identity-writers.mjs \
  scripts/governance-organization-identity-writers.spec.mjs
git commit -m "feat: harden identity writer stage scanner"
```

Expected: full scanner suite and B0 stage PASS; zero exits 1 because three exact writers remain. Capture stderr with an explicit shell redirection in the executor run and assert it is empty; delete only the executor-created temp directory after verification.

### Task 6: Package, Governance, Hosted Anchor, and Runtime-Exclusion Wiring

**Files:**

- Modify: `package.json:17-54`
- Modify: `scripts/governance-verify.mjs:13-40,256-352`
- Modify: `scripts/governance-contracts.spec.mjs:1-12`
- Modify: `scripts/governance-path-contracts.spec.mjs:83-104`
- Modify: `.github/workflows/governance.yml:15-36`
- Modify: `.github/workflows/ci.yml:130-143,210-239,241-281`
- Modify: `scripts/runtime-artifact-contract.spec.mjs:16-37,100-163,404-440`
- Test: `scripts/governance-organization-identity-writers.spec.mjs`
- Test: `scripts/governance-contracts.spec.mjs`
- Test: `scripts/governance-path-contracts.spec.mjs`
- Test: `scripts/runtime-artifact-contract.spec.mjs`
- Read-only assertion: `Dockerfile`, `runtime-entrypoint.mjs`, `scripts/verify-runtime-artifact.mjs`, `scripts/verify-runtime-image.mjs`, `scripts/generate-runtime-artifact-manifest.mjs`, `.github/CODEOWNERS`, `.github/required-contexts.json`

**Interfaces:**

- Consumes: Task 0A validator/contracts, validated tracked current-main admission, Task 5 `verifyAcceptedAuthority` and CLI, GitHub protected event/controller inputs.
- Produces: named root commands; mandatory current-main admission plus B0 current-stage governance subgates; B5-ready zero hook kept disabled until Task 16; hosted input mapping; runtime artifact exclusion proof.

**Commit message:** `ci: enforce identity writer governance boundary`

- [ ] **Step 1: Write package/governance wiring RED assertions**

Add exact assertions for:

```json
{
  "governance:identity-writers:test": "node --test scripts/governance-organization-identity-writers.spec.mjs",
  "governance:identity-writers:stage": "node scripts/governance-organization-identity-writers.mjs stage",
  "governance:identity-writers:zero": "node scripts/governance-organization-identity-writers.mjs zero"
}
```

The governance contracts root must import both the already-reviewed current-main admission spec and scanner spec. `verifyRepository()` must always validate the tracked admission before current-stage verification. It must not yet make zero a mandatory subgate at B0. Workflow tests must prove the required Governance context still calls `pnpm governance:verify` and hosted identities originate from GitHub context/controller variables.

- [ ] **Step 2: Add runtime exclusion RED fixtures**

Build a temporary `apps/api/dist` and runtime-image tree containing each scanner helper, scanner spec, and four governance manifests. Assert `assertRuntimeArtifactClean`, generated component manifests, and final image validation reject every injected path. Also assert the real Dockerfile copies only compiled API/contracts/renderer plus `runtime-entrypoint.mjs` and renamed `verify-runtime-image.mjs`, never `scripts/governance-*` or `docs/governance`.

- [ ] **Step 3: Run the wiring RED**

Run:

```bash
node --test \
  scripts/governance-organization-identity-writers.spec.mjs \
  scripts/governance-contracts.spec.mjs \
  scripts/governance-path-contracts.spec.mjs \
  scripts/runtime-artifact-contract.spec.mjs
```

Expected: FAIL on missing root commands/import/runner wiring and runtime identity-writer exclusions.

- [ ] **Step 4: Add the root commands and explicit test import**

Modify only the root script map and add both exact imports:

```js
import "./governance-organization-identity-current-main-admission.spec.mjs";
import "./governance-organization-identity-writers.spec.mjs";
```

to `scripts/governance-contracts.spec.mjs`. Extend the independently rooted path test so removing that import fails.

- [ ] **Step 5: Wire current-main admission and current-stage verification into the governance runner**

Import the reviewed non-printing current-main validator and `verifyOrganizationIdentityWriterRepository`. Validate the exact tracked admission, refresh/admitted-main/merge parents, and immutable review identities before invoking stage. Pass local CLI `--identity-writer-anchor-receipt` only to stages >=B1; in hosted mode construct the external input exclusively from validated GitHub event/controller values. Convert admission/scanner HOLD into bounded governance issue codes. Convert integrity failure into one `IDENTITY_WRITER_INTEGRITY_ERROR` without interpolating its cause.

```js
const identityWriters = await verifyOrganizationIdentityWriterRepository({
  root: ROOT,
  command: identityWriterZeroRequired ? "zero" : "stage",
  currentMainAdmission:
    "docs/governance/organization-identity-current-main-admission.json",
  externalAnchor: await identityWriterExternalInput(process.argv.slice(3)),
});
issues.push(...identityWriters.issues);
```

At B0, `identityWriterZeroRequired` is a literal `false`. Task 16 changes only this promotion decision and its tests after live zero is reached.

- [ ] **Step 6: Supply hosted inputs without PR ownership**

In both governance-bearing workflow paths, map protected GitHub base/main SHA from event context and accepted B0/review/merge identities from controller-owned repository variables. The scanner must reject absence at stages >=B1. B0 permits the variables to be absent because no protected-main anchor can exist before merge.

- [ ] **Step 7: Extend runtime exclusion tests without widening runtime copies**

Keep `Dockerfile`, `runtime-entrypoint.mjs`, `verify-runtime-artifact.mjs`, `verify-runtime-image.mjs`, and the manifest generator unchanged unless a failing test proves an existing copy path includes governance. The GREEN implementation is the explicit negative test over compiled output, release manifest inventory, and OCI copy statements, not a new runtime filter that could hide a copied scanner.

- [ ] **Step 8: Run focused GREEN and root governance**

Run:

```bash
pnpm governance:identity-writers:test
pnpm governance:identity-writers:stage
pnpm governance:test
node scripts/governance-verify.mjs verify
node --test scripts/runtime-artifact-contract.spec.mjs
```

Expected: PASS at `B0_BASELINE`; `governance:verify` remains green with exactly three expected writers and does not run zero as a success gate.

- [ ] **Step 9: Run build, full API tests, docs, and static migration gates**

Run:

```bash
pnpm --filter @global/db generate
pnpm --filter @global/contracts build
pnpm --filter @global/api lint
pnpm --filter @global/api build
pnpm --filter @global/api test
node --test \
  packages/db/test/organization-identity-v2-resolver-command.spec.mjs \
  packages/db/test/pinned-prisma-migration-stage.spec.mjs
pnpm docs:verify
git diff --check
```

Expected: all PASS. This is source/build/static evidence only; do not start services, Temporal, PostgreSQL, a container, or a provider.

- [ ] **Step 10: Commit the B0 integration unit**

```bash
git add package.json scripts/governance-verify.mjs \
  scripts/governance-contracts.spec.mjs scripts/governance-path-contracts.spec.mjs \
  .github/workflows/governance.yml .github/workflows/ci.yml \
  scripts/runtime-artifact-contract.spec.mjs
git commit -m "ci: enforce identity writer governance boundary"
```

### Task 7: B0 Implementation Whole Review and Exact Parent Freeze

**Files:**

- Create (ignored review output): `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b0-implementation-whole-review.md`
- Modify: none
- Test: all B0 files from Tasks 1–6; exact six source receipts; three current writer sources; resolver/lock; package/governance/workflows/runtime exclusion; migration static suites.

**Interfaces:**

- Consumes: clean exact B0 implementation head descending from `CURRENT_MAIN_ADMISSION_COMMIT`, whose parent is reviewed two-parent `B0_REFRESH_BASE_COMMIT`; validated admission JSON; Task 0B/0C review digests; refreshed baselines; separate Artifact A authority; and no writer acceptance JSON.
- Produces: immutable `B0_IMPLEMENTATION_SHA`; independent whole-review SHA-256 with `0 Critical / 0 Important`; bounded counterexample receipt; no tracked change.

**Commit message:** none; the review must not move the reviewed implementation head.

- [ ] **Step 1: Prove the acceptance path is still absent**

Run:

```bash
test ! -e docs/governance/organization-identity-writer-acceptance.json
git ls-files --error-unmatch docs/governance/organization-identity-writer-acceptance.json
```

Expected RED: the first command exits 0 and `git ls-files --error-unmatch` exits nonzero. If the path is already tracked or present, stop; the B0 implementation/acceptance split has been violated.

- [ ] **Step 2: Re-read live main before freezing the review subject**

```bash
ADMISSION=docs/governance/organization-identity-current-main-admission.json
ADMITTED_LIVE_MAIN_COMMIT="$(jq -er '.liveMainCommit' "$ADMISSION")"
test "$(git ls-remote --exit-code --refs origin refs/heads/main | cut -f1)" = "$ADMITTED_LIVE_MAIN_COMMIT"
node scripts/governance-organization-identity-current-main-admission.mjs validate --input "$ADMISSION"
```

Expected: PASS. Drift before B0 whole review returns to Tasks 0B/0C, regenerates Tasks 1–6 baselines/wiring, and requires a new whole review; do not review an unadmitted subject.

- [ ] **Step 3: Freeze the implementation subject**

Run:

```bash
test -z "$(git status --porcelain=v1 --untracked-files=all)"
B0_IMPLEMENTATION_SHA="$(git rev-parse HEAD)"
test "$(git cat-file -t "$B0_IMPLEMENTATION_SHA")" = commit
git show --stat --oneline "$B0_IMPLEMENTATION_SHA"
```

Expected: clean tracked/untracked state and one exact full SHA. The ignored `.superpowers` directory is examined separately and is not staged.

- [ ] **Step 4: Run the complete local B0 verification packet**

Run:

```bash
pnpm governance:identity-writers:test
pnpm governance:identity-writers:stage
pnpm governance:test
node scripts/governance-organization-identity-current-main-admission.mjs validate \
  --input docs/governance/organization-identity-current-main-admission.json
node scripts/governance-verify.mjs verify
node --test scripts/runtime-artifact-contract.spec.mjs
node --test \
  packages/db/test/organization-identity-v2-resolver-command.spec.mjs \
  packages/db/test/pinned-prisma-migration-stage.spec.mjs
pnpm --filter @global/db generate
pnpm --filter @global/contracts build
pnpm --filter @global/api lint
pnpm --filter @global/api build
pnpm --filter @global/api test
pnpm docs:verify
git diff --check
```

Expected: all PASS at the exact implementation SHA; live zero remains the expected diagnostic exit 1 and is not in the success packet.

- [ ] **Step 5: Independently challenge scanner completeness**

The reviewer adds new uncommitted temporary fixtures for: an escaped delegate through a structural union; a cross-file raw binder with a changed imported const only; a new caller entering an unchanged wrapper; a `Prisma.raw` direct tag; a generated delegate method absent from the native extractor; a symlink swap between pre/post stat; an exception containing a credential-like value; a migration directory addition; and a two-parent acceptance-shaped commit. Each must produce the spec-required closed failure and no leaked bytes.

- [ ] **Step 6: Review the complete refreshed baseline and separate Artifact A authority**

The reviewer compares product build/raw/wrapper/current-migration baselines to a fresh real `B0_REFRESH_BASE_COMMIT` derivation, recomputes current-main admission/merge/review identities, checks every refreshed raw disposition/ingress/closure, rereads separate Artifact A resolver/function/ACL and all six source receipts/verdict selectors, verifies refreshed measured headroom, and confirms the three exact writers. The review must explicitly state the 161 direct-call observation and Artifact A counts are comparative intake evidence, not refreshed expected totals.

- [ ] **Step 7: Review security, privacy, runtime exclusion, and no-migration scope**

The review must state whether the scanner can read outside admitted roots, emit source/SQL/secret bytes, accept PR-controlled hosted anchor values, change migration bytes, enter API/Worker dist, or reach OCI/release manifests. It must also confirm `resolveOrganizationIdentityForRaw` and `SuppressionThenIdentityLockReceipt` are unchanged from Artifact A.

- [ ] **Step 8: Write the bounded independent review report**

The exact report must name the implementation SHA, two-parent `B0_REFRESH_BASE_COMMIT == REFRESH_MERGE_COMMIT`, one-parent `CURRENT_MAIN_ADMISSION_COMMIT`, admitted live-main/refresh parents, admission JSON and pre/post refresh review digests, amended spec SHA-256, commands/results, counterexamples, all reviewed manifests, six source receipt digests, limitations, and final finding counts. It must not claim runtime, database, deployment, remote merge, or final authority.

- [ ] **Step 9: Verify the review gate and digest without committing it**

Run:

```bash
REVIEW=.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b0-implementation-whole-review.md
test -s "$REVIEW"
rg -n '^Critical: 0$|^Important: 0$|^Verdict: PASS$' "$REVIEW"
sha256sum "$REVIEW"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

Expected GREEN: report exists with exact subject and zero C/I; tracked/untracked Git state stays clean because the review path is ignored.

**Commit:** none. The reviewed implementation head must not move after this review. Any code/test/manifest change invalidates the review and restarts Task 7.

### Task 8: `B0_ACCEPTANCE` One-Parent/One-Path First Add and Scoped Review

**Files:**

- Create: `docs/governance/organization-identity-writer-acceptance.json`
- Create (ignored post-commit review): `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b0-acceptance-scoped-review.md`
- Modify: none
- Test: `scripts/governance-organization-identity-writers.spec.mjs`, acceptance generator/checker, Git commit shape.

**Interfaces:**

- Consumes: exact reviewed `B0_IMPLEMENTATION_SHA`; exact two-parent `B0_REFRESH_BASE_COMMIT`; exact one-parent `CURRENT_MAIN_ADMISSION_COMMIT`; admitted live-main/ordered refresh parents/admission JSON; Task 0B/0C/7 review digests; parent-tree controlled blobs; separate Artifact A Git authority; B0 baseline stage identities.
- Produces: exact `B0_ACCEPTANCE_SHA`; one first-added tracked JSON blob binding all refresh/authority subjects; separate scoped-review digest not written back; terminal local state `LOCAL_ACCEPTANCE_REVIEWED` only while live main remains admitted.

**Commit message:** `chore: anchor organization identity writer baseline`

- [ ] **Step 1: Run the missing-acceptance RED**

Run:

```bash
node scripts/governance-organization-identity-writers.mjs acceptance --check
```

Expected: exit 1 with a closed policy result naming only the repository-relative acceptance path/kind; stderr empty. Exit 0 before first-add is forbidden.

- [ ] **Step 2: Reconfirm live main and the exact reviewed parent have not moved**

Run:

```bash
B0_IMPLEMENTATION_SHA="$(git rev-parse HEAD)"
REVIEW=.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b0-implementation-whole-review.md
ADMISSION=docs/governance/organization-identity-current-main-admission.json
ADMITTED_LIVE_MAIN_COMMIT="$(jq -er '.liveMainCommit' "$ADMISSION")"
test "$(git ls-remote --exit-code --refs origin refs/heads/main | cut -f1)" = "$ADMITTED_LIVE_MAIN_COMMIT"
node scripts/governance-organization-identity-current-main-admission.mjs validate --input "$ADMISSION"
test -s "$REVIEW"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

Compare `B0_IMPLEMENTATION_SHA` and all refresh/admission/review identities to the full subject printed inside the review report. Mismatch or live-main drift before acceptance returns to Tasks 0B/0C, regenerates baselines, reruns Tasks 1–7, and obtains a new whole review.

- [ ] **Step 3: Generate only the acceptance JSON from parent-tree blobs**

Run:

```bash
node scripts/governance-organization-identity-writers.mjs acceptance \
  --implementation-parent "$B0_IMPLEMENTATION_SHA" \
  --refresh-base "$(jq -er '.refreshBaseCommit' docs/governance/organization-identity-writer-baseline.json)" \
  --current-main-admission-commit "$(jq -er '.currentMainAdmissionCommit' docs/governance/organization-identity-writer-baseline.json)" \
  --current-main-admission docs/governance/organization-identity-current-main-admission.json \
  --current-main-refresh-review .superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-refresh-review.md \
  --artifact-a 2400bac28796bae44294114edc99eaccb1bd65b3 \
  --implementation-review "$REVIEW" \
  --output docs/governance/organization-identity-writer-acceptance.json
```

Expected: exit 0; exactly one untracked path exists. The generator gets the exact two-parent refresh merge, one-parent admission child, admission blob, admitted main, refresh parents, scanner/helper/test, raw/build/migration baselines, native-extractor pin, pinned build inputs, pre/post refresh and implementation review digests, and immutable stage-machine identities from the exact implementation parent tree. The post-refresh review digest is bound here and was never self-written into the admission JSON.

- [ ] **Step 4: Validate non-self-reference and parent-tree identities before commit**

Run:

```bash
git status --short
test "$(git status --porcelain=v1 --untracked-files=all | wc -l)" -eq 1
git diff --no-index /dev/null docs/governance/organization-identity-writer-acceptance.json
node scripts/governance-organization-identity-writers.mjs acceptance \
  --check-working-file docs/governance/organization-identity-writer-acceptance.json \
  --implementation-parent "$B0_IMPLEMENTATION_SHA" \
  --current-main-admission-commit "$(jq -er '.currentMainAdmissionCommit' docs/governance/organization-identity-writer-baseline.json)" \
  --current-main-admission docs/governance/organization-identity-current-main-admission.json
```

Expected: only `?? docs/governance/organization-identity-writer-acceptance.json`; the JSON has no acceptance SHA/blob/review-of-itself field and every controlled value matches the implementation parent tree.

- [ ] **Step 5: Commit exactly the first-add acceptance path**

```bash
git add docs/governance/organization-identity-writer-acceptance.json
git diff --cached --name-status
git commit -m "chore: anchor organization identity writer baseline"
```

Expected: staged/committed name-status is exactly `A docs/governance/organization-identity-writer-acceptance.json`.

- [ ] **Step 6: Prove the exact one-parent/one-path commit shape**

Run:

```bash
B0_ACCEPTANCE_SHA="$(git rev-parse HEAD)"
test "$(git rev-parse "$B0_ACCEPTANCE_SHA^")" = "$B0_IMPLEMENTATION_SHA"
test "$(git rev-list --parents -n 1 "$B0_ACCEPTANCE_SHA" | awk '{print NF}')" -eq 2
test "$(git diff-tree --no-commit-id --name-status -r "$B0_ACCEPTANCE_SHA")" = $'A\tdocs/governance/organization-identity-writer-acceptance.json'
! git cat-file -e "$B0_IMPLEMENTATION_SHA:docs/governance/organization-identity-writer-acceptance.json"
git cat-file -e "$B0_ACCEPTANCE_SHA:docs/governance/organization-identity-writer-acceptance.json"
```

Expected: all assertions pass; the parent lacks the path and the child first-adds it.

- [ ] **Step 7: Run acceptance-aware B0 verification**

Run:

```bash
node scripts/governance-organization-identity-writers.mjs acceptance --check
node scripts/governance-organization-identity-current-main-admission.mjs validate \
  --input docs/governance/organization-identity-current-main-admission.json
pnpm governance:identity-writers:test
pnpm governance:identity-writers:stage
pnpm governance:test
node scripts/governance-verify.mjs verify
```

Expected: PASS at B0 without an external anchor; the scanner reads controlled blobs from the named parent, not current-tree replacements.

- [ ] **Step 8: Conduct an independent scoped acceptance review**

At the start of review, re-read live main and require the admitted SHA. The reviewer checks only the acceptance commit shape, parent linkage, first-add status, parent-tree blob recomputation, admitted live main, `refreshBaseCommit === refreshMergeCommit`, ordered refresh parents, one-parent `CURRENT_MAIN_ADMISSION_COMMIT`, current-main admission and pre/post refresh review digests, Artifact A identity, implementation-review digest, stage-machine sets, allowed mutable stage path, and absence of self-attestation. The report records exact `B0_ACCEPTANCE_SHA` and zero C/I; it makes no remote or runtime claim.

- [ ] **Step 9: Stop at the local terminal gate**

Run:

```bash
ACCEPTANCE_REVIEW=.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b0-acceptance-scoped-review.md
test -s "$ACCEPTANCE_REVIEW"
sha256sum "$ACCEPTANCE_REVIEW"
test "$(git ls-remote --exit-code --refs origin refs/heads/main | cut -f1)" = "$ADMITTED_LIVE_MAIN_COMMIT"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

Expected: `LOCAL_ACCEPTANCE_REVIEWED` only when live main is still the admitted SHA. If main advances after the acceptance commit, preserve the abandoned branch/head without amend/rebase/merge. Request exact authorization to create a successor v2 refresh worktree from the acceptance's parent `B0_IMPLEMENTATION_SHA`; derive its branch/path as `codex/pr407-organization-identity-caller-cutover-v2-refresh-${NEW_LIVE_MAIN_COMMIT:0:12}` and `/global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v2-refresh-${NEW_LIVE_MAIN_COMMIT:0:12}`. Only in that successor, where the acceptance path is absent at the starting parent, repeat Tasks 0B/0C and Tasks 1–8 so the new acceptance is again a true first-add. Do not push/open/update a PR, merge, create the root receipt, or start B1 from an abandoned acceptance.

### Task 9: Protected-Main Anchor Run Card — Default HOLD, Do Not Execute Without Exact Authorizations

**Files:**

- Create only after separate root-receipt authorization: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json`
- Modify only after separate controller-variable authorization: GitHub repository/controller variables `ORGANIZATION_IDENTITY_B0_ADMITTED_MAIN_SHA`, `ORGANIZATION_IDENTITY_B0_REFRESH_BASE_SHA`, `ORGANIZATION_IDENTITY_CURRENT_MAIN_ADMISSION_COMMIT_SHA`, `ORGANIZATION_IDENTITY_B0_ACCEPTED_SHA`, `ORGANIZATION_IDENTITY_B0_ACCEPTANCE_REVIEW_SHA256`, `ORGANIZATION_IDENTITY_B0_MERGE_SHA`, `ORGANIZATION_IDENTITY_B0_FIRST_PARENT_SHA`, `ORGANIZATION_IDENTITY_B0_SECOND_PARENT_SHA`, `ORGANIZATION_IDENTITY_B0_MERGE_METHOD`
- Modify: no repository file
- Test: local Git ancestry, live protected-main/PR/ruleset readback, root receipt ownership/mode/digest chain.

**Interfaces:**

- Consumes: exact admitted live-main SHA, two-parent refresh-base SHA, one-parent admission-commit SHA, admission/pre/post-review identities, exact reviewed v2 acceptance head, exact acceptance-review digest, and separately authorized push/PR/merge/readback/controller/root actions.
- Produces: GitHub merge whose pre-call head/base and post-call ordered parents are exact, externally fixed admitted/accepted/review identities, root-only anchor binding both parents; no repository commit.

**Commit message:** none; this task produces external readback/receipt state only after its separate authorizations.

- [ ] **Step 1: Confirm the default RED/HOLD state**

Run only the local check:

```bash
ANCHOR=/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json
test -f "$ANCHOR"
```

Expected RED now: nonzero because no authorized future receipt exists. This is the correct HOLD state. Do not create it to make the check green.

- [ ] **Step 2: Re-read admitted live main and obtain separate exact authorization for the push**

Before any network mutation, read `refs/heads/main` with `git ls-remote` and require exact equality to `CurrentMainAdmission.liveMainCommit`. Drift after acceptance abandons the sequence and returns to Tasks 0B/0C and 1–8. When equal, present admitted main, refresh base/merge/parents, `B0_IMPLEMENTATION_SHA`, `B0_ACCEPTANCE_SHA`, branch name, acceptance-review SHA-256, and clean status. Authorization for this step covers only:

```bash
git push -u origin codex/pr407-organization-identity-caller-cutover-v2
```

It does not authorize a PR, merge, variables, readback receipt, v3 worktree, or B1.

- [ ] **Step 3: Obtain separate exact authorization for PR create/update**

The PR base branch is protected `main`; actual base SHA must equal admitted `liveMainCommit`; head SHA must equal `B0_ACCEPTANCE_SHA`; the body states refresh/admission identities, `B0_IMPLEMENTATION`, `B0_ACCEPTANCE`, review digests, no Artifact B migration, and `LOCAL_ACCEPTANCE_REVIEWED`. Query the created PR and stop if either SHA differs:

```bash
gh pr view codex/pr407-organization-identity-caller-cutover-v2 \
  --json number,baseRefName,baseRefOid,headRefName,headRefOid,state,url
```

- [ ] **Step 4: Read live rules/checks and request a separate merge authorization**

Read only the exact PR checks, required review, branch protection/ruleset, allowed merge methods, auto-update/merge-queue settings, and conversation state. The merge authorization must name PR number, exact head=`B0_ACCEPTANCE_SHA`, exact base=`admitted liveMainCommit`, and method `MERGE_COMMIT`. Auto-update and merge-queue rebasing must be disabled/not used for this execution. If GitHub cannot preserve the reviewed head/base as a two-parent merge commit or any required check/review is absent, remain HOLD.

- [ ] **Step 5: Recheck exact head/base immediately before the authorized merge call**

Immediately before the network mutation, read the PR again and require actual `headRefOid=B0_ACCEPTANCE_SHA` and `baseRefOid=ADMITTED_LIVE_MAIN_COMMIT`; require approvals/checks still green and no auto-update/queue transition. A mismatch stops without merge and invalidates this acceptance sequence.

- [ ] **Step 6: Perform only the separately authorized expected-head merge call**

Derive the repository and PR number from the already reviewed PR, then use the API's expected head precondition:

```bash
REPOSITORY="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
gh api --method PUT "repos/$REPOSITORY/pulls/$PR_NUMBER/merge" \
  -f merge_method=merge \
  -f sha="$B0_ACCEPTANCE_SHA"
```

The actual base equality was rechecked immediately before this call because this API has no independent expected-base parameter. Squash/rebase/force/update-branch/merge-queue calls are forbidden.

- [ ] **Step 7: Prove exact ordered parents after separately authorized protected-main readback**

Derive exact values rather than substituting hand-written SHAs:

```bash
B0_ACCEPTANCE_SHA="$(git rev-parse codex/pr407-organization-identity-caller-cutover-v2)"
B0_IMPLEMENTATION_SHA="$(git rev-parse "$B0_ACCEPTANCE_SHA^")"
ADMITTED_LIVE_MAIN_COMMIT="$(jq -er '.liveMainCommit' docs/governance/organization-identity-current-main-admission.json)"
PROTECTED_MAIN_MERGE_SHA="$(git rev-parse origin/main)"
test "$(git rev-list --parents -n 1 "$PROTECTED_MAIN_MERGE_SHA" | awk '{print NF}')" -eq 3
test "$(git rev-parse "$PROTECTED_MAIN_MERGE_SHA^1")" = "$ADMITTED_LIVE_MAIN_COMMIT"
test "$(git rev-parse "$PROTECTED_MAIN_MERGE_SHA^2")" = "$B0_ACCEPTANCE_SHA"
git merge-base --is-ancestor "$B0_IMPLEMENTATION_SHA" "$PROTECTED_MAIN_MERGE_SHA"
git merge-base --is-ancestor "$B0_ACCEPTANCE_SHA" "$PROTECTED_MAIN_MERGE_SHA"
```

Expected: exactly two ordered parents—admitted main first, reviewed PR head containing B0 acceptance second—and both reviewed commits are ancestors. Ancestry alone is insufficient. Different parents produce no anchor/v3 and require a separately authorized forward corrective plan; never rewrite the remote result.

- [ ] **Step 8: Obtain separate authorization for controller variables and root-only receipt**

Set all nine controller-owned values only after authorization and only to live readback identities. Then create the successor directory/receipt atomically with owner `root:root`, directory/receipt access no broader than `0700/0600`, exact schema above, admitted main, `B0_REFRESH_BASE_COMMIT`, `CURRENT_MAIN_ADMISSION_COMMIT`, reviewed PR head, both ordered GitHub parents, canonical RFC3339 UTC time, predecessor digest when one exists, and a recomputed receipt-chain SHA-256. Do not place credentials or source/SQL bytes in it.

- [ ] **Step 9: Verify the external anchor from both local and hosted perspectives**

Run locally:

```bash
node scripts/governance-organization-identity-writers.mjs stage \
  --anchor-receipt /global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json
```

Run a separately authorized hosted readback through the existing Governance context and verify it used the protected GitHub event/base plus controller variables. A PR-supplied artifact/env/job-output substitute must fail.

- [ ] **Step 10: Record the task outcome without a repository commit**

**Commit:** none. The task outcome is either `PROTECTED_MAIN_ANCHORED` with exact live evidence or `HOLD` with the first failed gate. External waiting time is not estimated.

### Task 10: Create V3 From the Exact Protected-Main Merge Commit

**Files:**

- Create after Task 9 and explicit local execution approval: worktree `/global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v3`
- Create: branch `codex/pr407-organization-identity-caller-cutover-v3`
- Modify: no v2 file
- Test: worktree inventory, exact head/branch/status, anchor-aware stage/zero diagnostics.

**Interfaces:**

- Consumes: root-only anchor's exact `mergeCommitSha` and `acceptedB0Sha`; locally available protected-main merge Git object.
- Produces: clean v3 at the exact merge commit, B0 stage passing with external anchor, live zero exit 1 with three writers.

**Commit message:** none; worktree creation is not a repository content commit.

- [ ] **Step 1: Run the expected absent-v3 RED**

```bash
test -d /global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v3
```

Expected RED before setup: nonzero. If the path or branch already exists, stop and audit ownership; do not reuse it.

- [ ] **Step 2: Read and validate the anchor without editing v2**

```bash
ANCHOR=/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json
PROTECTED_MAIN_MERGE_SHA="$(jq -er '.mergeCommitSha' "$ANCHOR")"
ACCEPTED_B0_SHA="$(jq -er '.acceptedB0Sha' "$ANCHOR")"
ADMITTED_LIVE_MAIN_SHA="$(jq -er '.admittedLiveMainSha' "$ANCHOR")"
REFRESH_BASE_SHA="$(jq -er '.refreshBaseCommitSha' "$ANCHOR")"
CURRENT_MAIN_ADMISSION_COMMIT_SHA="$(jq -er '.currentMainAdmissionCommitSha' "$ANCHOR")"
test "$(git -C /global/backend rev-parse "$CURRENT_MAIN_ADMISSION_COMMIT_SHA^")" = "$REFRESH_BASE_SHA"
test "$(git -C /global/backend rev-list --parents -n 1 "$REFRESH_BASE_SHA" | awk '{print NF}')" -eq 3
test "$(jq -er '.ancestry.mergeParents[0]' "$ANCHOR")" = "$ADMITTED_LIVE_MAIN_SHA"
test "$(jq -er '.ancestry.mergeParents[1]' "$ANCHOR")" = "$ACCEPTED_B0_SHA"
git -C /global/backend cat-file -e "$PROTECTED_MAIN_MERGE_SHA^{commit}"
test "$(git -C /global/backend rev-parse "$PROTECTED_MAIN_MERGE_SHA^1")" = "$ADMITTED_LIVE_MAIN_SHA"
test "$(git -C /global/backend rev-parse "$PROTECTED_MAIN_MERGE_SHA^2")" = "$ACCEPTED_B0_SHA"
git -C /global/backend merge-base --is-ancestor "$ACCEPTED_B0_SHA" "$PROTECTED_MAIN_MERGE_SHA"
```

Expected: exact local commit exists, both ordered parents match the root receipt, and ancestry passes. Missing object or parent mismatch remains HOLD; do not fetch without separate network authorization.

- [ ] **Step 3: Re-run inventory and collision checks**

```bash
pnpm --dir /global/backend --silent worktree:inventory | jq '.worktrees[] | select(.path | contains("pr407-organization-identity-caller-cutover"))'
git -C /global/backend show-ref --verify --quiet refs/heads/codex/pr407-organization-identity-caller-cutover-v3
test ! -e /global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v3
```

Expected: v2 remains preserved; the v3 branch check exits nonzero and path-absence check exits 0.

- [ ] **Step 4: Create the exact branch/worktree**

```bash
git -C /global/backend worktree add \
  -b codex/pr407-organization-identity-caller-cutover-v3 \
  /global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v3 \
  "$PROTECTED_MAIN_MERGE_SHA"
```

- [ ] **Step 5: Verify the fresh base and install dependencies**

```bash
cd /global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v3
test "$(git branch --show-current)" = codex/pr407-organization-identity-caller-cutover-v3
test "$(git rev-parse HEAD)" = "$PROTECTED_MAIN_MERGE_SHA"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
pnpm install --frozen-lockfile
git diff --exit-code -- pnpm-lock.yaml
```

- [ ] **Step 6: Run the anchor-aware base verification**

```bash
node scripts/governance-organization-identity-writers.mjs stage --anchor-receipt "$ANCHOR"
node scripts/governance-organization-identity-writers.mjs zero --anchor-receipt "$ANCHOR"
```

Expected: stage exits 0 at `B0_BASELINE`; zero exits 1 with exactly the three accepted writer findings; stderr is empty.

**Commit:** none. Worktree creation is the setup boundary; Task 11 owns the first v3 commit.

## V3 Delivery: B1–B6 Caller Cutover

### Task 11: B1 Temporal Five-Outcome and Replay RED Without Writer-Count Change

**Files:**

- Create: `apps/api/src/temporal/organization-identity-caller-cutover.spec.ts`
- Modify: `docs/governance/organization-identity-writer-stage.json`
- Test: `apps/api/src/temporal/organization-identity-caller-cutover.spec.ts`
- Test unchanged stage: `scripts/governance-organization-identity-writers.spec.mjs`
- Read-only: `apps/api/src/temporal/discovery.activities.ts:760-956,1617-1629`, `apps/api/src/temporal/discovery.workflow.ts:175`, resolver/lock source and tests.

**Interfaces:**

- Consumes: exact v3 anchored B0 base; `OrganizationIdentityResolutionReceipt`; current Activity input and result `{ companies: number; suppressed: number }`.
- Produces: failing product contract for `bound`, `created`, `legacy_bound`, `suppressed`, `conflict`, exact composite receipt reuse, and response-loss behavior; `B1_TEMPORAL_RED` stage with the same three writers.

**Commit message:** `test: specify temporal identity resolver cutover`

- [ ] **Step 1: Advance only the mutable stage record**

Generate `B1_TEMPORAL_RED` using the accepted scanner's stage-receipt command so the source-tree observation still names three exact writers. Do not edit expected sets, baseline, scanner, acceptance, build, raw, or migration manifests.

- [ ] **Step 2: Write a focused resolver mock and transaction harness**

Mock only the Artifact A resolver/lock exports before importing `createDiscoveryActivities`. The fake transaction exposes Raw reads, Canonical/Evidence writes, and no successful `identityLink.create`. It records call order and immutable arguments.

```ts
const resolveOrganizationIdentityForRawMock = vi.fn();
const lockWorkspaceSuppressionThenIdentityMock = vi.fn(
  async (tx, workspaceId) =>
    Object.freeze({
      workspaceId,
      suppressionPolicyLock: Object.freeze({ workspaceId }),
    }),
);
```

The actual test uses the branded Artifact A receipt returned by the mocked module; it never forges the real symbol-bearing receipt in product code.

- [ ] **Step 3: Specify all five outcome effects**

Use a table with exact assertions:

| Receipt                       | Expected caller effect                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `created`                     | load returned Canonical, merge only owned fields, create exact Raw-backed FieldEvidence, `companies=1` |
| `bound` with `replayed=false` | load returned Canonical, merge owned fields, exact evidence, count only an actual contribution         |
| `bound` with `replayed=true`  | no Canonical/Evidence mutation; response-loss retry remains byte-stable                                |
| `legacy_bound`                | no IdentityLink/Canonical/Evidence mutation and no upgrade; result counts unchanged                    |
| `suppressed`                  | increment `suppressed`, write no contribution, continue next Raw                                       |
| `conflict`                    | write no contribution, do not throw the whole bounded batch, preserve result shape                     |

The five-member resolver union counts `bound` and `created` separately; the table includes the additional replay state of `bound`.

- [ ] **Step 4: Specify exact lock and provenance behavior**

Assert one `lockWorkspaceSuppressionThenIdentity(tx, workspaceId)` per workspace transaction, every resolver call receives that exact object as its third argument, and the resolver input is exactly `{workspaceId, rawRecordId}`. Assert no provider/model/network call and no second PrismaClient.

- [ ] **Step 5: Specify old Activity history compatibility**

Keep the Activity name and workflow call unchanged. Assert the returned object has exactly `companies` and `suppressed`; no new Workflow patch/command/result field is introduced. Existing governed C-TX run-receipt replay still returns the stored two-field summary unchanged.

- [ ] **Step 6: Run the intentional product RED**

Run:

```bash
pnpm --filter @global/api exec vitest run \
  src/temporal/organization-identity-caller-cutover.spec.ts
```

Expected: FAIL because current Temporal code still calls `tx.identityLink.create` and does not call the resolver/composite lock.

- [ ] **Step 7: Prove B1 governance remains green with three writers**

Run:

```bash
ANCHOR=/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json
node scripts/governance-organization-identity-writers.mjs stage --anchor-receipt "$ANCHOR"
node scripts/governance-organization-identity-writers.mjs zero --anchor-receipt "$ANCHOR"
```

Expected: stage exits 0 at `B1_TEMPORAL_RED`; zero exits 1 with three findings. This is the required RED checkpoint, not a mergeable head.

- [ ] **Step 8: Commit only RED plus stage**

```bash
git add apps/api/src/temporal/organization-identity-caller-cutover.spec.ts \
  docs/governance/organization-identity-writer-stage.json
git commit -m "test: specify temporal identity resolver cutover"
```

### Task 12: B2 Temporal Resolver Cutover and Stage `3 → 2`

**Files:**

- Modify: `apps/api/src/temporal/discovery.activities.ts:1-210,760-956`
- Modify: `apps/api/src/temporal/discovery.activities.spec.ts:1062-1675`
- Modify: `apps/api/src/temporal/organization-identity-caller-cutover.spec.ts`
- Modify: `docs/governance/organization-identity-writer-stage.json`
- Test: the two Temporal specs above
- Test: `apps/api/src/temporal/discovery-company-materialization.activities.contract.spec.ts`
- Test: `apps/api/src/temporal/workspace-authority.workflow.spec.ts`

**Interfaces:**

- Consumes: `lockWorkspaceSuppressionThenIdentity(tx, workspaceId): Promise<SuppressionThenIdentityLockReceipt>` and `resolveOrganizationIdentityForRaw(tx, input, receipt): Promise<OrganizationIdentityResolutionReceipt>`.
- Produces: Temporal legacy materializer with no `IdentityLink` mutation, exact same Activity name/result, returned-company contribution for fresh `bound/created`, zero contribution for replay/legacy/suppression/conflict; `B2_TEMPORAL_CUTOVER` with two writers.

**Commit message:** `feat: cut temporal identity writer over to resolver`

- [ ] **Step 1: Re-run the carried B1 product RED**

Run:

```bash
pnpm --filter @global/api exec vitest run \
  src/temporal/organization-identity-caller-cutover.spec.ts
```

Expected: FAIL on the resolver/composite-receipt/direct-writer assertions. If it passes before source changes, stop and inspect branch ownership or test weakness.

- [ ] **Step 2: Import only the Artifact A public contracts**

Add imports from `../discovery/organization-identity-lock` and `../discovery/organization-identity-resolver`. Remove `lockCompanyRawIdentity`, `isPrismaUniqueCollision`, and direct identity-link write logic only after focused tests identify them as unused; do not alter resolver/lock files.

- [ ] **Step 3: Acquire the exact composite receipt once per transaction**

Replace the suppression-only lock at the start of `canonicalizeLegacyDiscoveryRun` with:

```ts
const lockReceipt = await lockWorkspaceSuppressionThenIdentity(
  tx,
  args.workspaceId,
);
```

Pass `lockReceipt.suppressionPolicyLock` only to any remaining same-transaction suppression-aware Canonical helper. Never construct or cache a receipt outside the transaction.

- [ ] **Step 4: Replace the writer with the five-outcome branch**

For each governed consumable Raw:

```ts
const resolution = await resolveOrganizationIdentityForRaw(
  tx,
  { workspaceId: args.workspaceId, rawRecordId: raw.id },
  lockReceipt,
);
if (resolution.kind === "suppressed") {
  suppressed += 1;
  continue;
}
if (resolution.kind === "legacy_bound" || resolution.kind === "conflict") {
  continue;
}
if (resolution.kind === "bound" && resolution.replayed) {
  continue;
}
```

For fresh `bound/created`, load `canonicalCompany.findUnique({where:{id: resolution.companyId}})`, require the same workspace, merge only the current Raw-owned fields/attributes, and create the existing exact FieldEvidence set. Never call `identityLink.create/update/upsert/delete`.

- [ ] **Step 5: Preserve contribution counts and stable errors**

Count `companies` only when `created` or an actual caller-owned Canonical contribution changed stored state. A missing/mismatched returned company becomes the existing stable non-retryable identity/materialization conflict, without raw database text. `legacy_bound`, replayed `bound`, `suppressed`, and `conflict` cannot add evidence.

- [ ] **Step 6: Update existing focused tests rather than deleting coverage**

Replace mocks that asserted direct `identityLink.create` with resolver receipts; keep tests for Raw v2 filtering, suppression ordering, byte-stable response loss, stale-linked replay, sanitizer ownership, and governed C-TX replay. Add assertions that the direct delegate method is absent from the source.

- [ ] **Step 7: Run focused GREEN**

Run:

```bash
pnpm --filter @global/api exec vitest run \
  src/temporal/organization-identity-caller-cutover.spec.ts \
  src/temporal/discovery.activities.spec.ts \
  src/temporal/discovery-company-materialization.activities.contract.spec.ts \
  src/temporal/workspace-authority.workflow.spec.ts
```

Expected: PASS; historical Activity shape and governed materialization replay remain unchanged.

- [ ] **Step 8: Generate B2 stage atomically with the source**

Generate `B2_TEMPORAL_CUTOVER` observation from the changed writer source. The accepted expected set must now contain only TenantProjection and materialization.

- [ ] **Step 9: Verify stage `3 → 2`, raw freeze, and zero diagnostic**

Run:

```bash
ANCHOR=/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json
node scripts/governance-organization-identity-writers.mjs stage --anchor-receipt "$ANCHOR"
node scripts/governance-organization-identity-writers.mjs zero --anchor-receipt "$ANCHOR"
```

Expected: stage exit 0 with two expected writers; zero exit 1 with exactly those two; raw/build/migration baselines unchanged.

- [ ] **Step 10: Run proportional API/build checks and commit**

```bash
pnpm --filter @global/api lint
pnpm --filter @global/api build
pnpm --filter @global/api test
git diff --check
git add apps/api/src/temporal/discovery.activities.ts \
  apps/api/src/temporal/discovery.activities.spec.ts \
  apps/api/src/temporal/organization-identity-caller-cutover.spec.ts \
  docs/governance/organization-identity-writer-stage.json
git commit -m "feat: cut temporal identity writer over to resolver"
```

### Task 13: B3 TenantProjection Five-Outcome, Chunk, and Replay RED

**Files:**

- Create: `apps/api/src/acquisition/tenant-projection.organization-identity.spec.ts`
- Modify: `docs/governance/organization-identity-writer-stage.json`
- Test: `apps/api/src/acquisition/tenant-projection.organization-identity.spec.ts`
- Read-only: `apps/api/src/acquisition/tenant-projection.service.ts`, its raw-bridge/suppression specs, `apps/api/scripts/project-source.mts`.

**Interfaces:**

- Consumes: `ProjectResult`, monitored-source Raw bridge, Artifact A resolver/lock contracts, B2 two-writer stage.
- Produces: B3 failing contract for five outcomes, exact chunk lock refresh, response-loss no-op, script-consumer compatibility; same two expected writers.

**Commit message:** `test: specify tenant projection identity cutover`

- [ ] **Step 1: Advance only the stage to `B3_PROJECTION_RED`**

Generate a stage observation against unchanged B2 source. Stage must still pass with TenantProjection and materialization writers.

- [ ] **Step 2: Build the exact projection harness**

Use 101 source entities so two `CHUNK=100` transactions occur. Mock `persistMonitoredSourceRawBridge`, resolver receipts, returned Canonical rows, and evidence writes. Record each transaction's branded composite receipt and ensure receipts never cross chunks.

- [ ] **Step 3: Specify the five outcomes and Raw ordering**

The test requires the governed Raw bridge receipt to exist before resolver dispatch. `created/fresh bound` may merge the returned company and add exact evidence; replayed `bound`, `legacy_bound`, `suppressed`, and `conflict` add no Canonical/Evidence/IdentityLink. `suppressed` increments the existing counter; conflict preserves current `ProjectResult` shape without being mislabeled as suppression.

- [ ] **Step 4: Specify chunk suppression refresh and replay stability**

Assert exactly two composite lock receipts for 101 entities, one per transaction. A suppression committed between chunks must be observed by the second resolver. Replaying an already committed Raw returns `bound/replayed=true` or `legacy_bound` and preserves Canonical bytes, version, updatedAt, evidence count, and `projected` count.

- [ ] **Step 5: Specify the script consumer boundary**

Import `ProjectResult` and assert `apps/api/scripts/project-source.mts` still calls `projectSource(workspaceId, sourceId)` and can serialize the unchanged fields. No API/controller/module composition is added.

- [ ] **Step 6: Run the intentional RED**

Run:

```bash
pnpm --filter @global/api exec vitest run \
  src/acquisition/tenant-projection.organization-identity.spec.ts
```

Expected: FAIL because current projection still calls `tx.identityLink.create` and does not use the resolver/composite receipt.

- [ ] **Step 7: Verify the unchanged two-writer stage and commit RED**

```bash
ANCHOR=/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json
node scripts/governance-organization-identity-writers.mjs stage --anchor-receipt "$ANCHOR"
git add apps/api/src/acquisition/tenant-projection.organization-identity.spec.ts \
  docs/governance/organization-identity-writer-stage.json
git commit -m "test: specify tenant projection identity cutover"
```

Expected: governance stage PASS with two writers; product RED remains intentional.

### Task 14: B4 TenantProjection Resolver Cutover and Stage `2 → 1`

**Files:**

- Modify: `apps/api/src/acquisition/tenant-projection.service.ts:1-280`
- Modify: `apps/api/src/acquisition/tenant-projection.organization-identity.spec.ts`
- Modify: `apps/api/src/acquisition/tenant-projection.raw-bridge.spec.ts`
- Modify: `apps/api/src/acquisition/tenant-projection.suppression.spec.ts`
- Modify: `docs/governance/organization-identity-writer-stage.json`
- Test: all three TenantProjection specs
- Test read-only consumer: `apps/api/scripts/project-source.mts`

**Interfaces:**

- Consumes: monitored-source Raw receipt, exact per-chunk composite receipt, resolver outcome.
- Produces: projection source with no IdentityLink mutation; unchanged `ProjectResult`; one remaining materialization writer at `B4_PROJECTION_CUTOVER`.

**Commit message:** `feat: cut tenant projection identity writer over to resolver`

- [ ] **Step 1: Re-run the carried B3 product RED**

```bash
pnpm --filter @global/api exec vitest run \
  src/acquisition/tenant-projection.organization-identity.spec.ts
```

Expected: FAIL on resolver/composite-receipt/direct-writer assertions. Passing before source changes is a stop condition.

- [ ] **Step 2: Replace the chunk's suppression-only receipt with the composite receipt**

At the start of each `withWorkspace` chunk transaction call `lockWorkspaceSuppressionThenIdentity(tx, workspaceId)`. Remove precomputed identity target selection as write authority; the database resolver owns target/suppression/conflict decisions.

- [ ] **Step 3: Persist the governed Raw receipt before identity resolution**

Keep `prepareMonitoredSourceRawBridge` outside the identity command and call `persistMonitoredSourceRawBridge` inside the same workspace transaction. The resolver input is exactly the persisted `raw.id`. A suppressed/conflict outcome may leave the governed Raw fact but creates no Canonical/IdentityLink/FieldEvidence contribution.

- [ ] **Step 4: Implement exact outcome handling**

```ts
const resolution = await resolveOrganizationIdentityForRaw(
  tx,
  { workspaceId, rawRecordId: raw.id },
  lockReceipt,
);
if (resolution.kind === "suppressed") {
  suppressed += 1;
  continue;
}
if (resolution.kind === "legacy_bound" || resolution.kind === "conflict")
  continue;
if (resolution.kind === "bound" && resolution.replayed) continue;
```

For fresh `bound/created`, load the exact returned Canonical in workspace, merge only monitored-source-owned domain/country/attributes, count an actual change, and write the existing name/domain/country/attributes evidence set with the Raw/provider/license provenance. Do not create/update/delete any IdentityLink.

- [ ] **Step 5: Keep chunk and personal-contact boundaries**

Preserve `CHUNK=100`, platform reads outside tenant transactions, per-chunk fresh lock/resolution, personal contact withholding count, Raw v2 validation, and no contact writer. Do not product-compose this service.

- [ ] **Step 6: Run focused GREEN**

```bash
pnpm --filter @global/api exec vitest run \
  src/acquisition/tenant-projection.organization-identity.spec.ts \
  src/acquisition/tenant-projection.raw-bridge.spec.ts \
  src/acquisition/tenant-projection.suppression.spec.ts
```

Expected: PASS for five outcomes, 101-row chunk refresh, response loss, suppression, raw bridge, and script-compatible result.

- [ ] **Step 7: Generate and verify B4 stage**

```bash
ANCHOR=/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json
node scripts/governance-organization-identity-writers.mjs stage --anchor-receipt "$ANCHOR"
node scripts/governance-organization-identity-writers.mjs zero --anchor-receipt "$ANCHOR"
```

Expected after generating `B4_PROJECTION_CUTOVER`: stage exit 0 with only the materialization writer; zero exit 1 with exactly one finding.

- [ ] **Step 8: Run API checks and commit**

```bash
pnpm --filter @global/api lint
pnpm --filter @global/api build
pnpm --filter @global/api test
git diff --check
git add apps/api/src/acquisition/tenant-projection.service.ts \
  apps/api/src/acquisition/tenant-projection.organization-identity.spec.ts \
  apps/api/src/acquisition/tenant-projection.raw-bridge.spec.ts \
  apps/api/src/acquisition/tenant-projection.suppression.spec.ts \
  docs/governance/organization-identity-writer-stage.json
git commit -m "feat: cut tenant projection identity writer over to resolver"
```

### Task 15: B4M Governed Materialization Resolver Cutover and Stage `1 → 0`

**Files:**

- Create: `apps/api/src/temporal/discovery-company-materialization-organization-identity.spec.ts`
- Modify: `apps/api/src/temporal/discovery-company-materialization-canonical.ts:1-235`
- Modify: `apps/api/src/temporal/discovery-company-materialization.ts:1-612`
- Modify: `apps/api/src/discovery/discovery-company-materialization-ctx.ts:205-245`
- Modify: `apps/api/src/discovery/discovery-company-materialization-ctx.spec.ts`
- Modify: `apps/api/src/temporal/discovery.activities.spec.ts:1675-2225`
- Modify: `apps/api/src/temporal/discovery-company-materialization.activities.contract.spec.ts`
- Modify: `docs/governance/organization-identity-writer-stage.json`
- Test: all listed materialization specs
- Test static DB contract: `apps/api/src/discovery/discovery-company-materialization-functions.inventory.spec.ts`

**Interfaces:**

- Consumes: exact batch transaction/fence/suppression snapshot; composite lock receipt acquired before locked batch facts; resolver five-outcome union; existing C-TX append outcome contract.
- Produces: no direct IdentityLink mutation; B4M zero stage; `identity_v2` accepted as a C-TX match rule; conflict mapped to the previously locked fixed `NOT_CANONICALIZABLE/IDENTITY_CONFLICT`; legacy/readback remains write-free.

**Commit message:** `feat: cut materialization identity writer over to resolver`

- [ ] **Step 1: Write the B4M focused RED**

The new spec must assert:

- composite suppression→identity lock occurs before `lockDiscoveryCompanyMaterializationBatchFacts`;
- every eligible Raw resolver call receives the same exact receipt for that transaction;
- fresh `created/bound` produces an exact active-link readback, caller-owned Canonical/Evidence contribution, and existing `canonicalWrite` record;
- replayed `bound` reads existing link/evidence manifest and writes neither Canonical nor evidence;
- `legacy_bound` performs exact active legacy-link/evidence readback and maps to `CANONICALIZED/REUSED` with zero identity/canonical/evidence mutation;
- precomputed suppression maps to `SUPPRESSED`; an unexpected resolver `suppressed` without the matching nonempty suppression ID set is `INCOMPLETE_HOLD`;
- `conflict` maps to `NOT_CANONICALIZABLE` with the amended-spec-derived, previously locked reason `IDENTITY_CONFLICT` and zero contribution;
- `identity_v2` passes the application builder and exact DB link equality path;
- no migration/schema byte changes.

- [ ] **Step 2: Run the intentional RED**

Run:

```bash
pnpm --filter @global/api exec vitest run \
  src/temporal/discovery-company-materialization-organization-identity.spec.ts \
  src/discovery/discovery-company-materialization-ctx.spec.ts
```

Expected: FAIL on current `identityLink.create`, manual identity advisory lock, absent resolver call, and `identity_v2` rejection.

- [ ] **Step 3: Move composite lock acquisition before batch facts**

In the `BATCH` transaction, call `lockWorkspaceSuppressionThenIdentity(transaction, input.workspaceId)` before the database fact-lock function. Pass the branded receipt through `materializeLockedDiscoveryCompanyBatch` to each candidate. Remove manual `discovery-company-identity:*` advisory locks; do not introduce another lock key/order.

- [ ] **Step 4: Replace the direct materialization writer**

Change the candidate helper signature to:

```ts
export async function materializeDiscoveryCompanyCanonicalCandidate(
  transaction: Prisma.TransactionClient,
  workspaceId: string,
  candidate: Readonly<Record<string, unknown>>,
  lockReceipt: SuppressionThenIdentityLockReceipt,
  suppressionDecision?: PrecomputedCompanySuppressionDecision,
  reusableCanonical?: Readonly<{
    id: string;
    dedupeKey: string;
    name: string;
    domain: string | null;
    status: string;
  }>,
): Promise<Readonly<Record<string, unknown>>>;
```

For a new eligible candidate call the resolver with the exact Raw ID and receipt. Delete `transaction.identityLink.create` and its P2002 branch.

- [ ] **Step 5: Read back exact link/evidence metadata without writing**

For `bound/created/legacy_bound`, query at most two active company links for exact workspace/raw/company, validate resolver version/input hash/match rule/confidence against the resolver receipt, and reject zero/multiple/mismatched rows. Use the existing bounded `readEvidenceManifest` for replay/legacy. Do not use a partial `findFirst` result as authority without the exact validation.

- [ ] **Step 6: Preserve C-TX outcome semantics without a migration**

Fresh `bound/created` may merge caller-owned Canonical fields and create exact FieldEvidence, then return `mutationClass` `CREATED`, `UPDATED`, or `LINKED`. Replayed `bound` and `legacy_bound` return `REUSED`. Conflict returns `companyParse:{status:"INVALID",reasonCode:"IDENTITY_CONFLICT"}` with `canonicalWrite:null`; no other conflict reason is valid. Add `identity_v2` to the closed application match-rule set; the database append already verifies equality to the exact active IdentityLink row and its varchar column needs no migration.

- [ ] **Step 7: Update existing materialization tests without weakening fences/replay**

Keep admission, inspection, fence, batch order, suppression snapshot digest, response-loss readback, finalization, and workflow-no-patch tests. Replace direct writer expectations with resolver/link-readback expectations. Add a mutation that reintroduces `identityLink.create` and ensure scanner zero catches it.

- [ ] **Step 8: Run focused GREEN and static DB function tests**

```bash
pnpm --filter @global/api exec vitest run \
  src/temporal/discovery-company-materialization-organization-identity.spec.ts \
  src/temporal/discovery.activities.spec.ts \
  src/temporal/discovery-company-materialization.activities.contract.spec.ts \
  src/discovery/discovery-company-materialization-ctx.spec.ts \
  src/discovery/discovery-company-materialization-functions.inventory.spec.ts
```

Expected: PASS; no migration is created or edited.

- [ ] **Step 9: Generate B4M stage and prove first live zero**

```bash
ANCHOR=/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json
node scripts/governance-organization-identity-writers.mjs stage --anchor-receipt "$ANCHOR"
node scripts/governance-organization-identity-writers.mjs zero --anchor-receipt "$ANCHOR"
```

Expected after generating `B4M_MATERIALIZATION_CUTOVER`: both commands exit 0, delegate finding set is empty, raw closure/build/migration authority remain exact.

- [ ] **Step 10: Run API/static migration checks and commit**

```bash
pnpm --filter @global/api lint
pnpm --filter @global/api build
pnpm --filter @global/api test
node --test \
  packages/db/test/organization-identity-v2-resolver-command.spec.mjs \
  packages/db/test/pinned-prisma-migration-stage.spec.mjs
git diff --exit-code -- packages/db/prisma/schema.prisma packages/db/prisma/migrations
git diff --check
git add apps/api/src/temporal/discovery-company-materialization-organization-identity.spec.ts \
  apps/api/src/temporal/discovery-company-materialization-canonical.ts \
  apps/api/src/temporal/discovery-company-materialization.ts \
  apps/api/src/discovery/discovery-company-materialization-ctx.ts \
  apps/api/src/discovery/discovery-company-materialization-ctx.spec.ts \
  apps/api/src/temporal/discovery.activities.spec.ts \
  apps/api/src/temporal/discovery-company-materialization.activities.contract.spec.ts \
  docs/governance/organization-identity-writer-stage.json
git commit -m "feat: cut materialization identity writer over to resolver"
```

### Task 16: B5 Mandatory Zero, Downstream Consumers, and Governance Promotion

**Files:**

- Create: `apps/api/src/discovery/organization-identity-caller-cutover-downstream.spec.ts`
- Modify: `scripts/governance-verify.mjs:256-352`
- Modify: `scripts/governance-contracts.spec.mjs`
- Modify: `docs/governance/organization-identity-writer-stage.json`
- Test: `scripts/governance-organization-identity-writers.spec.mjs`
- Test: `scripts/governance-contracts.spec.mjs`, `scripts/governance-path-contracts.spec.mjs`
- Test: `.github/workflows/governance.yml`, `.github/workflows/ci.yml` through governance topology tests
- Test downstream: `apps/api/src/temporal/candidate-assessment.spec.ts`, `apps/api/src/discovery/company-enrichment-commit.spec.ts`, `apps/api/src/signals/intent-recompute.service.spec.ts`, `apps/api/src/intent/website-watch.service.spec.ts`, `apps/api/src/temporal/patents-cache.activities.spec.ts`, `apps/api/src/lead/lead.service.synthetic.spec.ts`

**Interfaces:**

- Consumes: first live zero at B4M, accepted scanner zero command, exact protected anchor, unchanged CanonicalCompany/FieldEvidence reader contracts.
- Produces: `B5_ZERO_GATE`; mandatory zero inside `governance:verify`; evidence that qualification, enrichment, signals, watch, patent, and lead readers still consume the same Canonical/Evidence state.

**Commit message:** `ci: require zero organization identity delegate writers`

- [ ] **Step 1: Write the governance-promotion RED**

Add a contract test that reads `scripts/governance-verify.mjs`, supplies stage `B5_ZERO_GATE`, and requires the runner to invoke command `zero`, fail on one synthetic writer, and fail on scanner exit 2. Also mutate `.github/workflows/governance.yml` to bypass `pnpm governance:verify` in-memory and assert the required-context topology rejects it.

- [ ] **Step 2: Write the downstream consumer RED/continuity spec**

Build one immutable CanonicalCompany plus Raw-backed FieldEvidence fixture shaped exactly as the caller contribution from `created/bound`. Feed it through qualification, enrichment commit readback, signal recompute, website-watch admission, patent-cache association, and lead serialization boundaries. Assert no consumer requires a direct IdentityLink write or a new resolver outcome field.

- [ ] **Step 3: Run the RED before promotion**

Run:

```bash
node --test --test-name-pattern='identity writer zero promotion' scripts/governance-contracts.spec.mjs
pnpm --filter @global/api exec vitest run \
  src/discovery/organization-identity-caller-cutover-downstream.spec.ts
```

Expected: governance test FAIL because current B0 wiring still selects stage rather than mandatory zero at B5. The downstream test may already pass; if it fails, fix only test harness assumptions or a proven caller-consumer regression, never broaden a consumer to legacy IdentityLink writes.

- [ ] **Step 4: Promote zero based on the closed stage**

In `verifyRepository()`, parse the exact stage through the accepted scanner contract. Select `zero` for `B5_ZERO_GATE` and `B6_CLOSEOUT`; select `stage` before B5. No CLI flag can downgrade the selected command.

```js
const identityWriterCommand = ["B5_ZERO_GATE", "B6_CLOSEOUT"].includes(
  identityWriterStage,
)
  ? "zero"
  : "stage";
```

One or more findings, scan budget exhaustion, drift, ambiguity, or integrity failure must fail governance.

- [ ] **Step 5: Generate the B5 stage receipt**

Generate `B5_ZERO_GATE` against the same zero source tree. The only governance manifest changed is the stage JSON; scanner, tests, baselines, acceptance, and derivation rules remain accepted-parent bytes.

- [ ] **Step 6: Run mandatory zero and governance GREEN locally**

Run:

```bash
ANCHOR=/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json
pnpm governance:identity-writers:test
node scripts/governance-organization-identity-writers.mjs stage --anchor-receipt "$ANCHOR"
node scripts/governance-organization-identity-writers.mjs zero --anchor-receipt "$ANCHOR"
node scripts/governance-verify.mjs verify \
  --identity-writer-anchor-receipt "$ANCHOR"
pnpm governance:test
```

Expected: all PASS; governance now fails if a fixture or working source reintroduces any possible IdentityLink mutation.

- [ ] **Step 7: Run the downstream continuity packet**

```bash
pnpm --filter @global/api exec vitest run \
  src/discovery/organization-identity-caller-cutover-downstream.spec.ts \
  src/temporal/candidate-assessment.spec.ts \
  src/discovery/company-enrichment-commit.spec.ts \
  src/signals/intent-recompute.service.spec.ts \
  src/intent/website-watch.service.spec.ts \
  src/temporal/patents-cache.activities.spec.ts \
  src/lead/lead.service.synthetic.spec.ts
```

Expected: PASS using the same CanonicalCompany/FieldEvidence state and no new product state.

- [ ] **Step 8: Run hosted-topology/runtime-exclusion tests**

```bash
node --test \
  scripts/governance-contracts.spec.mjs \
  scripts/governance-path-contracts.spec.mjs \
  scripts/runtime-artifact-contract.spec.mjs
```

Expected: required Governance context still reaches mandatory zero; scanner/tests/manifests remain absent from compiled/release/OCI fixtures.

- [ ] **Step 9: Run full local non-runtime verification and commit**

```bash
pnpm --filter @global/db generate
pnpm --filter @global/contracts build
pnpm --filter @global/api lint
pnpm --filter @global/api build
pnpm --filter @global/api test
node --test \
  packages/db/test/organization-identity-v2-resolver-command.spec.mjs \
  packages/db/test/pinned-prisma-migration-stage.spec.mjs
git diff --exit-code -- packages/db/prisma/schema.prisma packages/db/prisma/migrations
git diff --check
git add apps/api/src/discovery/organization-identity-caller-cutover-downstream.spec.ts \
  scripts/governance-verify.mjs scripts/governance-contracts.spec.mjs \
  docs/governance/organization-identity-writer-stage.json
git commit -m "ci: require zero organization identity delegate writers"
```

### Task 17: B6 Mixed-Fleet, Old/New Replay, Races, and Disposable PostgreSQL Proof

**Files:**

- Create: `apps/api/src/discovery/organization-identity-artifact-b-mixed-fleet.spec.ts`
- Create: `apps/api/test/fixtures/organization-identity-artifact-b-writers.disposable.ts`
- Create: `packages/db/test/organization-identity-artifact-b-cutover.disposable.spec.mjs`
- Modify: `docs/governance/organization-identity-writer-stage.json`
- Test: all three new files plus existing resolver/lock, three caller, materialization, migration, governance, and runtime-exclusion suites.
- Read-only: all Prisma migrations; Docker image digest used by the separately authorized disposable run.

**Interfaces:**

- Consumes: B5 zero implementation, Artifact A's still-present legacy INSERT compatibility, app-user resolver fixture pattern, explicit disposable-resource authorization.
- Produces: `B6_CLOSEOUT`; mixed old/new and replay/race evidence; disposable PostgreSQL receipt with cleanup; no retained database change and no Artifact C revoke.

**Commit message:** `test: verify mixed-fleet identity caller cutover`

- [ ] **Step 1: Write the pure mixed-fleet RED matrix**

Model exact D2/D3 behavior without starting Temporal or PostgreSQL:

- old Artifact-A-compatible caller can still insert the seven-column legacy company link while ambient INSERT remains;
- new caller uses only the resolver;
- a new caller seeing the old complete link receives `legacy_bound` and writes no identity/canonical/evidence contribution;
- `bound/created` response loss replays without duplicate contribution;
- suppression and conflict are terminal zero-contribution outcomes;
- old recorded Activity result `{companies,suppressed}` replays unchanged;
- new Activity attempt uses B2 code without a Workflow patch;
- materialization replay reads exact persisted C-TX outcome.

- [ ] **Step 2: Write the separately gated disposable test contract**

The Node test skips unless `ORGANIZATION_IDENTITY_B6_DISPOSABLE=1`. When enabled, it creates a uniquely named loopback-only PostgreSQL 16 container/network/volume with task labels, deploys the current unchanged migration chain, provisions app_user, runs the TypeScript fixture, records only machine-shaped IDs/counts/digests, and cleans only resources it created.

- [ ] **Step 3: Add exact disposable scenarios**

The fixture/test must cover:

1. fresh `created` and strong-root `bound` with exact Canonical/Evidence contribution;
2. complete old `identity-v1/legacy` link returns `legacy_bound` without row changes;
3. suppression committed before new resolution returns `suppressed` with no contribution;
4. exact disagreement returns `conflict` with no Canonical/Evidence contribution;
5. old direct writer and new resolver overlapping the same Raw/identity under two app-user connections converge to an allowed replay/conflict state, not duplicate ACTIVE links;
6. suppression-vs-resolver ordering in both A/B schedules has no `40P01` and no post-suppression contribution;
7. caller transaction rollback after resolver/contribution leaves no partial link/evidence;
8. full migration directory/function/ACL/table/column authority equals the accepted Artifact A manifest before and after.

- [ ] **Step 4: Run the pure RED**

```bash
pnpm --filter @global/api exec vitest run \
  src/discovery/organization-identity-artifact-b-mixed-fleet.spec.ts
```

Expected: FAIL until the harness is connected to all three cutover callers and old/new replay contracts.

- [ ] **Step 5: Implement the minimal pure harness and reach GREEN**

Reuse actual caller functions and Artifact A resolver types with bounded fakes; do not add a product compatibility path. The only old writer exists inside the test harness/fixture and is excluded from product build/artifacts.

- [ ] **Step 6: Request explicit disposable PostgreSQL/container authorization**

Before running the enabled test, present exact image digest, loopback port policy, resource names/labels, migration list, data shape, time/resource caps, and cleanup commands. This authorization is separate from plan approval, code implementation, remote merge, retained database, deployment, and runtime authorization.

- [ ] **Step 7: Run the authorized disposable GREEN packet**

Only after authorization:

```bash
ORGANIZATION_IDENTITY_B6_DISPOSABLE=1 \
  node --test packages/db/test/organization-identity-artifact-b-cutover.disposable.spec.mjs
```

Expected: all scenarios PASS; output contains no URLs, passwords, SQL bodies, customer data, or source text. The test's `after` cleanup confirms the unique container/network/volume no longer exist. If cleanup cannot be proven, report the exact resource IDs without deleting anything outside the receipt.

- [ ] **Step 8: Generate B6 stage and rerun zero/governance**

```bash
ANCHOR=/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json
node scripts/governance-organization-identity-writers.mjs stage --anchor-receipt "$ANCHOR"
node scripts/governance-organization-identity-writers.mjs zero --anchor-receipt "$ANCHOR"
node scripts/governance-verify.mjs verify --identity-writer-anchor-receipt "$ANCHOR"
```

Expected after generating `B6_CLOSEOUT`: all PASS with zero writers; exact raw/build/migration baselines unchanged.

- [ ] **Step 9: Run the complete final technical packet**

```bash
pnpm governance:identity-writers:test
pnpm governance:test
node --test scripts/runtime-artifact-contract.spec.mjs
node --test \
  packages/db/test/organization-identity-v2-resolver-command.spec.mjs \
  packages/db/test/pinned-prisma-migration-stage.spec.mjs
pnpm --filter @global/db generate
pnpm --filter @global/contracts build
pnpm --filter @global/api lint
pnpm --filter @global/api build
pnpm --filter @global/api test
git diff --exit-code -- packages/db/prisma/schema.prisma packages/db/prisma/migrations
git diff --check
```

Expected: all PASS; this remains local/static/disposable evidence, not deployment or final DB authority.

- [ ] **Step 10: Commit the B6 verification unit**

```bash
git add apps/api/src/discovery/organization-identity-artifact-b-mixed-fleet.spec.ts \
  apps/api/test/fixtures/organization-identity-artifact-b-writers.disposable.ts \
  packages/db/test/organization-identity-artifact-b-cutover.disposable.spec.mjs \
  docs/governance/organization-identity-writer-stage.json
git commit -m "test: verify mixed-fleet identity caller cutover"
```

### Task 18: Final Independent Artifact B Whole Review

**Files:**

- Create (ignored): `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b6-final-code-review.md`
- Create (ignored): `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b6-final-security-review.md`
- Create (ignored): `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b6-final-database-review.md`
- Modify: none
- Test: exact protected-main anchor, accepted B0 parent/acceptance, full v3 range, every B1–B6 command/test/receipt, zero inventory, no-migration diff, runtime exclusion, disposable cleanup receipt.

**Interfaces:**

- Consumes: clean exact B6 head and all preceding review/evidence identities.
- Produces: independent zero-C/I code/security/database verdicts and a bounded `CUTOVER_READY_FOR_CONTRACT` implementation conclusion; no tracked change, no remote action, no deployment claim.

**Commit message:** none; final independent reviews do not modify the reviewed head.

- [ ] **Step 1: Run the missing-review RED**

```bash
for review in \
  .superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b6-final-code-review.md \
  .superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b6-final-security-review.md \
  .superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b6-final-database-review.md; do
  test -s "$review"
done
```

Expected: RED with a nonzero status before review. Absence is a review gate, not permission to self-approve.

- [ ] **Step 2: Freeze exact review subjects**

Record full v3 head/range from the anchored merge, clean status, accepted B0/review/anchor identities, stage `B6_CLOSEOUT`, zero observation digest, and migration directory digest. Any worktree change after subject capture invalidates the reviews.

- [ ] **Step 3: Conduct independent code review**

Review all three caller diffs, exact five-outcome handling, same-transaction receipt use, response-loss/old-history behavior, Canonical/Evidence ownership, materialization mapping, downstream continuity, immutable objects, error handling, test strength, and absence of a generic legacy writer. Add counterexamples not present in implementer tests.

- [ ] **Step 4: Conduct independent security review**

Challenge delegate/raw escapes, accepted-parent replacement, external-anchor substitution, redaction, symlink/TOCTOU, resource exhaustion, cross-workspace/cross-transaction receipts, mixed-fleet races, suppression ordering, secret/source leakage, workflow/controller trust, runtime inclusion, and implicit external authorization. Reconfirm Artifact C remains required for final DB authority.

- [ ] **Step 5: Conduct independent database review**

Recompute the complete refreshed migration directory/dispositions and separate Artifact A function/ACL/table/column authority; verify B1–B6 made zero migration/schema changes relative to accepted `B0_REFRESH_BASE_COMMIT`; inspect disposable fresh/upgrade/replay/race receipts; confirm app_user ambient INSERT still exists only as the carried Artifact C `TRANSITION_HOLD`; confirm no `_prisma_migrations` edits or `prisma migrate resolve` path.

- [ ] **Step 6: Run the final exact-head verification packet**

Repeat Task 17's full technical packet at the exact review head, plus the authorized disposable packet when its prior receipt is not exact-head reusable. Do not start a retained service or database.

- [ ] **Step 7: Write and verify the three reports**

Each report names exact subject commits, spec/acceptance/anchor identities, commands, new counterexamples, findings by severity, limitations, and external gates. Require literal `Critical: 0`, `Important: 0`, and `Verdict: PASS`; otherwise return to the owning task and repeat the review.

- [ ] **Step 8: Confirm the local terminal state and stop**

Run:

```bash
sha256sum \
  .superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b6-final-code-review.md \
  .superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b6-final-security-review.md \
  .superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b6-final-database-review.md
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

Expected GREEN: clean exact B6 head and three zero-C/I reports. The correct conclusion is `CUTOVER_READY_FOR_CONTRACT` for the reviewed Artifact B implementation only. It is not final database authority, deployment, old-worker drain proof, retained migration approval, RuntimeEvidence, Release Bundle, PILOT, GA, Artifact C authorization, push, PR, merge, or worktree cleanup authorization.

**Commit:** none. Any later tracked change requires renewed scoped review.

## Stop Conditions

Stop at the first applicable condition and report the exact evidence boundary:

1. V2 does not descend from amended spec `96edb38e...`, the exact plan is not tracked/approved for execution, v3 does not equal the anchored merge, a worktree is unexpectedly dirty, or ownership overlaps.
2. Task 0A validator review has any Critical/Important finding or permits an extra/missing/renamed/case-colliding path, free-form command, unresolved owner, incomplete migration set, conflict mismatch, Artifact A drift, or any HOLD record to pass.
3. Live-main object is absent after Task 0B: stop with `FETCH_AUTH_REQUIRED` and request exact fetch authorization; do not fetch under plan/read-only/local-merge authority.
4. Task 0B live/cached/ancestry/path/conflict/owner/migration/build/raw/schema/governance/runtime/caller facts are incomplete, a new writer/Identity authority interaction appears, or the independent audit is not PASS.
5. Fetch/ref or local refresh merge/admission commit lacks its own exact authorization, live main changed since the reviewed packet, actual conflict paths/hunks differ, or any resolution would use stale feature/blanket ours/theirs bytes.
6. `B0_REFRESH_BASE_COMMIT` is not exactly the normal two-parent refresh merge with ordered parents `[branchPreRefreshCommit, admittedLiveMainCommit]`; `CURRENT_MAIN_ADMISSION_COMMIT` is not its exact one-parent child or changes more than the admission JSON path; admission validation/post-refresh review is not PASS; or Artifact A/admitted main is not an ancestor of the refresh merge.
7. Live main advances before B0 acceptance: repeat Tasks 0B/0C, regenerate Tasks 1–6, and repeat Task 7. Live main advances after acceptance: abandon that acceptance and repeat the refresh/implementation/review/acceptance sequence; never let GitHub add unadmitted main implicitly.
8. Any refreshed pinned build/config/entrypoint/Docker/extension/generated-source/Prisma/TypeScript/native-extractor fact drifts.
9. TypeScript cannot build one complete Program/checker from `B0_REFRESH_BASE_COMMIT`, a delegate/raw/wrapper origin is ambiguous, or any refreshed baseline surface lacks a closed disposition.
10. A refreshed project-total measured baseline exceeds 50% of its fixed limit; the only next action is spec revision.
11. Any admitted file is a symlink/non-regular/escaped/changed file, a manifest path is invalid, or output redaction cannot be proven.
12. A raw capability, wrapper ingress/caller, dependency closure, literal identity-link mention, current-main admission, or accepted controlled blob drifts outside a closed stage removal.
13. Any refreshed migration directory/checksum/last-change/disposition or Artifact A resolver/function/ACL/table/column/six-receipt record differs.
14. B0 implementation or acceptance review has any Critical/Important finding, the implementation parent moves, or acceptance is not exactly single-parent/one-path/first-add with controlled blobs from its reviewed parent.
15. Immediately pre-call PR head/base is not exact reviewed acceptance/admitted main, auto-update/queue rebase is active, or post-readback parents are not exactly `[admitted main, reviewed PR head]`; no anchor/v3 is created on mismatch.
16. Any push/PR/GitHub merge/readback/controller/root/v3/disposable action lacks its own exact authorization; protected-main ordered-parent readback or root receipt is missing/mismatched.
17. B1–B6 lacks explicit local anchor CLI input, hosted inputs are absent/PR-controlled, or v3 did not start from the exact protected-main merge.
18. The stage set is not exactly `3/3/2/2/1/0/0/0` for B0/B1/B2/B3/B4/B4M/B5/B6, or zero does not become exit 0 at B4M.
19. A caller needs a new Artifact B migration, generic legacy write command, identity-only lock, synthesized/cross-transaction/cross-workspace receipt, second PrismaClient, provider/model call, or new product state.
20. Any outcome writes Canonical/Evidence on `legacy_bound`, `suppressed`, or `conflict`; any replay changes bytes; materialization uses a conflict reason other than `IDENTITY_CONFLICT`, rejects valid `identity_v2`, or cannot express the outcome through the current contract without DB change.
21. Disposable PostgreSQL/container authorization, exact image/resources, loopback isolation, bounded data, or cleanup proof is absent.
22. Final reviews have any Critical/Important finding or the reviewed head changes.

## Rollback and Cleanup

- Task 0B is read-only except its local ignored packets; it has no ref/merge rollback. Delete no packet or provenance to disguise a HOLD.
- During an authorized but uncommitted Task 0C merge, unexpected conflict/path facts stop before resolution. Use only the abort/recovery action expressly included in the local-merge authorization and return to the exact clean `branchPreRefreshCommit`; never reset hard, rebase, or use blanket ours/theirs.
- After reviewed `B0_REFRESH_BASE_COMMIT`/`CURRENT_MAIN_ADMISSION_COMMIT` but before acceptance, main drift is handled by a new separately authorized forward two-parent refresh merge plus a new one-parent admission commit, regenerated baselines, and review. Do not rewrite the prior refresh/admission commits.
- After acceptance, preserve the abandoned acceptance branch and create the exact SHA-suffixed successor worktree only after its own local authorization, starting from the abandoned acceptance's `B0_IMPLEMENTATION` parent so `organization-identity-writer-acceptance.json` is absent and the replacement acceptance can remain a genuine first-add.
- Before the B0 remote merge, rollback is preserving and abandoning the v2 branch/worktree after provenance capture. Do not reset Artifact A, admitted main, the failed v1 branch, or another writer's state.
- Never amend/rewrite `B0_IMPLEMENTATION` or `B0_ACCEPTANCE` after review. Drift after acceptance abandons that sequence and creates a new reviewed refresh/implementation/acceptance lineage; it does not replace history.
- After the protected-main merge, do not revert/delete the root-only anchor or controller identities to hide history. A correction is forward-only and separately reviewed.
- B1–B6 rollback before any future merge is v3 branch abandonment or forward revert commits under review. Do not resume implementation on v2.
- Main-owned schema/migrations enter only as exact admitted Git blobs and are not applied by the refresh task. Artifact B has no new database migration/rollback. Never edit applied migration bytes or `_prisma_migrations`, and never use `prisma migrate resolve` to disguise drift.
- The B6 disposable harness removes only its uniquely labeled container/network/volume and temp directory. It never deletes a retained/shared `global-*` resource. If cleanup fails, report exact created resource IDs and request direction.
- No worktree, branch, PR, remote ref, root receipt, review report, or evidence is deleted without a separate ownership/provenance audit and authorization.
- After future Artifact C, rollback floor is Artifact B; ambient IdentityLink INSERT is never restored. Artifact C is outside this plan.

## Estimated Active Time

External review queues, authorization waits, GitHub checks, merge queues, and human response time are not included.

| Phase                 | Active engineering/review time | Main cost                                                                                               |
| --------------------- | -----------------------------: | ------------------------------------------------------------------------------------------------------- |
| Task 0A               |                      5–8 hours | Closed validator/generator contracts, exact-set/conflict/migration/HOLD tests, independent review       |
| Task 0B               |                      3–5 hours | No-fetch live audit, complete classifications, reviewed authorization packet                            |
| Task 0C               |                     8–14 hours | Authorized fetch/merge, Copy provenance, admission JSON, full verification and refresh review           |
| Intake and Task 1     |                      3–5 hours | Refreshed build/source-view contracts and hostile file fixtures                                         |
| Tasks 2–3             |                    12–18 hours | TypeScript delegate/raw/wrapper/closure completeness and adversarial fixtures                           |
| Tasks 4–6             |                    10–16 hours | Refreshed raw/build/migration classification plus Artifact A authority, redaction and governance wiring |
| Tasks 7–8             |                      5–8 hours | Whole review, counterexamples, parent/blob recomputation, one-path acceptance review                    |
| Task 9                |               2–4 hours active | Live readback/run-card execution after separate authorizations; waiting excluded                        |
| Task 10               |                      1–2 hours | Exact anchored v3 setup and preflight                                                                   |
| Tasks 11–12           |                     6–10 hours | Temporal RED/GREEN, replay, full existing test adaptation                                               |
| Tasks 13–14           |                     6–10 hours | Projection chunk/Raw ordering/five outcomes and existing test adaptation                                |
| Task 15               |                     8–12 hours | C-TX resolver integration, link/evidence readback, conflict/legacy mapping, zero                        |
| Task 16               |                      4–6 hours | Mandatory zero promotion and downstream continuity                                                      |
| Task 17               |                     8–12 hours | Mixed-fleet/race/disposable harness, authorized execution, cleanup evidence                             |
| Task 18               |                      5–8 hours | Independent code/security/database whole reviews                                                        |
| **Total active time** |               **86–138 hours** | Excludes all external waiting and authorization latency                                                 |

## Execution Completion Boundary

Execution is complete only when Task 18 is green at one clean exact B6 head, Tasks 0A/0B/0C and B0/final reviews are zero C/I, the accepted scanner reports `B6_CLOSEOUT` and live zero with the exact protected-main ordered-parent anchor, migration/schema bytes equal the admitted refresh merge tree, and disposable resources are proven cleaned. The handoff must list exact validator/audit identities, `REFRESH_MERGE_COMMIT == B0_REFRESH_BASE_COMMIT`, ordered refresh parents, `CURRENT_MAIN_ADMISSION_COMMIT`, admission blob/pre-merge/post-refresh review digests, admitted live main, v2 implementation/acceptance commits, acceptance-review digest, protected-main merge/ordered parents/root anchor identities, v3 commit range, per-stage writer counts, RED/GREEN commands, raw/build/migration/Artifact A authority digests, review digests, remaining Artifact C `TRANSITION_HOLD`, and every unverified external/runtime edge.

This plan's own completion and review still authorize no implementation. Obtain explicit user approval for this exact plan before Task 0A; that approval covers only Task 0A and Task 0B's local/read-only pre-refresh work. Obtain separate exact fetch authorization and separate exact local refresh merge/admission authorization before Task 0C. Tasks 1–8 open only after the independently reviewed refresh base; push, PR, GitHub merge, protected-main readback, controller/root receipt, v3, and disposable actions retain their additional action-specific approvals.
