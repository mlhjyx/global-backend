# Organization Identity Writer Ban-at-Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a branch-external root-only closed-command launcher and clean pre-execution bootstrap trust root, admit exact current main, add the sole reviewed C-TX compatibility migration, freeze a complete refreshed build/raw/migration writer baseline, and then replace the three `IdentityLink.create` callers in the machine-checked `3 → 2 → 1 → 0` sequence.

**Architecture:** Task 0L first creates, tests, and independently reviews a tracked stdlib-only closed-command launcher/controller. Task 0P then creates/reviews the immutable bootstrap contract and fresh-run engine; only afterward does Task 0L resume under separate authorization to materialize the exact accepted launcher/bootstrap bytes in the root-only branch-external directory. Task 0A consumes those reviewed trust roots to create the admission validator; Task 0B audits live main without fetch; Task 0F is the only fetch-only interstitial when the object is missing; Task 0C creates the exact two-parent refresh merge and one-parent admission child under separate authorization; Task 0M creates the sole additive compatibility migration under its own migration/disposable/review gates. Scanner derivation is fixed by Tasks 1–4 before Task 5 generates/reviews the final raw/build baseline; Task 6 wires governance; Tasks 7–8 review and accept B0. Hosted authority comes only from the protected-main/base-owned anchor workflow, never the ordinary PR workflow or PR-controlled launcher bytes.

**Tech Stack:** Node.js 22 ESM, TypeScript 5.9.3 compiler API, Prisma/@prisma/client 6.19.3, Vitest 4, Node test runner, Git object plumbing, JSON Schema-shaped closed records, pnpm 9.15.9, GitHub Actions, PostgreSQL 16 disposable verification, Docker/OCI artifact checks.

**Spec:** `docs/superpowers/specs/2026-09-01-organization-identity-writer-ban-at-source-design.md` at exact final confirmed commit `b060c5dd4afef9fe42dfe510b02f930f56cdf7fe`, SHA-256 `536e376a40d9ef4f49a65bc0224b74d58eb8a2d743fa766aa020397e67279dd4`.

## Global Constraints

- Exact final-spec confirmation authorizes only this plan drafting. It does not authorize bootstrap/validator/scanner/workflow/migration implementation, dependency installation/generation, fetch/ref update, local merge/commit, push, PR, GitHub merge/readback, controller/root actions, v3, database/container/runtime/provider/credential/deployment, cleanup, or Artifact C.
- After an independent review of this exact plan reaches zero Critical/Important, a future exact plan approval authorizes only Task 0L's tracked local launcher/controller design, non-authority development tests and review, plus Tasks 0P, 0A, and 0B local code/tests/documents/read-only audit. It does not authorize Task 0L root-directory/materialization writes, an authority-bearing bootstrap run before that separately authorized root materialization, pnpm authority installation outside reviewed hostile fixtures, fetch, local merge, Task 0M migration bytes, disposable PostgreSQL, scanner Tasks 1–8, or any remote action.
- Root materialization of the exact reviewed Task 0L launcher/controller/contract into `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher/` requires its own future exact authorization. The directory is `root:root` mode `0700`, executable launcher/wrapper bytes are `0500`, contract/materialization/review receipts are `0600`, and no approval of this plan or local Task 0L commit implies that root write.
- Task 0F requires a separate exact fetch-only authorization naming remote/ref/SHA and performs no merge. Task 0C requires a later, distinct authorization naming the reviewed PASS audit, branch preimage, admitted main, exact conflict set and resolution rules. Task 0M migration-file creation requires another exact authorization; its disposable PostgreSQL run requires a separate database/container authorization. Scanner Tasks 1–8 require a separate scanner implementation authorization after 0M reviews are accepted.
- Fetching an absent exact object/ref requires a separate authorization naming remote, ref, and SHA. Creating exact `B0_REFRESH_BASE_COMMIT` as the local two-parent refresh merge and exact `CURRENT_MAIN_ADMISSION_COMMIT` as its one-parent admission child requires another separate authorization naming the branch pre-refresh SHA, admitted live-main SHA, expected conflict paths, and closed resolution rules.
- Scanner/baseline Tasks 1–8 begin only after Task 0C produces the reviewed refresh/admission chain and Task 0M produces the reviewed `B0M_MIGRATION_COMMIT` plus authorized disposable PASS. Their execution HEAD descends from 0M, while product/raw/build baselines read `B0_REFRESH_BASE_COMMIT` and migration authority freezes the refresh directory plus the sole 0M delta. Push, PR create/update, GitHub merge/readback, hosted-run recovery, root receipt, v3 creation, and every later external action remain separate gates.
- A direct current-shell `node`, `pnpm`, `jq`, package-script, or unreviewed branch-local bootstrap invocation is diagnostic/non-authoritative only. Every admission, bootstrap, migration, scanner, baseline, stage, zero, acceptance, review, governance, anchor, and B1–B6 result used as authority must be dispatched by the root-only accepted launcher with a closed command ID, exact `BootstrapContract`, fresh validated `BootstrapRunReceipt`, and—at B1 or later—the accepted protected-main anchor. The launcher itself executes through `/usr/bin/env -i` and the receipt-selected pinned absolute Node path; it accepts no arbitrary command, argv tail, shell fragment, environment key, or executable path.
- Preserve exact Artifact A commit `2400bac28796bae44294114edc99eaccb1bd65b3`, the failed v1 branch `codex/pr407-organization-identity-caller-cutover@5adb69877501b240e89ae3d8617617d7bf81837f`, all applied migration bytes, all other worktrees, and all unique provenance.
- V2 work occurs only in `/global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v2` on `codex/pr407-organization-identity-caller-cutover-v2`; B1–B6 must not be implemented in that worktree or branch.
- V3 is exactly `/global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v3` on `codex/pr407-organization-identity-caller-cutover-v3`, created only from the exact live protected-main B0 merge commit after the external anchor exists.
- The refresh admits main-owned schema/migration bytes only through exact unchanged live-main Git blobs. Artifact B adds exactly one migration: `20260902090000_organization_identity_materialization_outcome_compat/migration.sql`. It is DDL-only, changes no Prisma schema/DML/function/trigger/ACL, and only expands the C-TX CHECK for `identity_v2` and `IDENTITY_CONFLICT`. B1–B6 add zero migrations; any second migration, existing-migration edit, `_prisma_migrations` manipulation, DML, or authority expansion is a design stop.
- No scan result authorizes SQL execution, migration application, a retained database change, runtime/deployment claims, provider dispatch, paid calls, or credential use.
- The scanner reads only admitted repository source/Git objects, the six Artifact A receipts, the accepted external anchor, and the exact `DEPENDENCY_DECLARATION_ROOT`/`TOOL_EXECUTION_ROOT` produced by the clean bootstrap. It never reads `.env`, credential values, customer data, prompts, payloads, arbitrary ignored caches, source maps, undeclared packages, runtime application code, or unrelated worktrees.
- Closed `IdentityLink` delegate reads are exactly `findUnique`, `findUniqueOrThrow`, `findFirst`, `findFirstOrThrow`, `findMany`, `count`, `aggregate`, and `groupBy`.
- Current known delegate writes are exactly `create`, `createMany`, `createManyAndReturn`, `update`, `updateMany`, `updateManyAndReturn`, `upsert`, `delete`, and `deleteMany`; every unknown callable method on a possible `IdentityLink` delegate is ambiguous and blocked.
- Raw methods are exactly `$executeRaw`, `$executeRawUnsafe`, `$queryRaw`, and `$queryRawUnsafe`; all refreshed direct capabilities, aliases, extracted/bound values, structural clients, SQL fragments, wrappers, dependency closures, and statically reachable ingress callers belong to the exact `B0_REFRESH_BASE_COMMIT` baseline. Artifact A remains the separate resolver/function/ACL authority subject.
- The caller contract remains `resolveOrganizationIdentityForRaw(tx, { workspaceId, rawRecordId }, lockReceipt?)`; a third argument is allowed only when it is the exact same-transaction, same-workspace `SuppressionThenIdentityLockReceipt`.
- The resolver outcomes remain the five-member union `bound | created | legacy_bound | suppressed | conflict`. `bound/created` allow caller-owned governed Canonical/Evidence contribution; `legacy_bound` is read-only reuse; `suppressed/conflict` contribute no Canonical or FieldEvidence bytes.
- In governed materialization, `conflict` maps to `NOT_CANONICALIZABLE` with the previously locked, amended-spec-derived fixed reason `IDENTITY_CONFLICT`; `identity_v2` remains a valid match rule. No alternate conflict reason is admitted by this plan.
- Task 0M must make those two values valid in the database CHECK before B4M may remove the last delegate writer. Application-source support cannot substitute for the accepted migration/catalog/disposable evidence.
- B0 stage verification expects all three exact `create` callsites. B2 removes the Temporal writer, B4 removes the TenantProjection writer, and B4M removes the governed materialization writer. Live zero remains an expected exit 1 diagnostic through B4 and becomes mandatory exit 0 at B4M.
- Project-total budgets are fixed at 2,000 source files, 200,000 symbol/call edges, 4,096 raw records, 8,192 wrapper-ingress records, 16,384 closure members, and 64,000,000 committed bytes. Per-file/per-resolution budgets are 20,000 AST nodes, depth 32, assignment fanout 32, alternatives 256, and 1,000,000 candidate bytes.
- B0 must measure the real `B0_REFRESH_BASE_COMMIT` graph. Artifact A counts are comparative evidence only. Every project-total hard limit must be at least twice the refreshed measurement, and the refreshed value must be at most 50% of the fixed limit. A violation requires a spec revision; no task may raise a limit locally.
- Normal exits 0/1 emit only the closed deterministic JSON schema on stdout and nothing on stderr. Exit 2 emits one closed integrity record on stdout and nothing on stderr; messages, causes, stacks, diagnostics, SQL, literals, absolute paths, credentials, and environment values are forbidden.
- The v2 acceptance commit is a one-parent child of the exact independently reviewed B0 implementation head, first-adds only `docs/governance/organization-identity-writer-acceptance.json`, and freezes the immutable bootstrap contract/schema/blob (not a run-specific receipt), launcher/materialization identities, refresh/admission subjects, full build/dependency/tool closure, exact 0M migration/reviews, scanner/baseline/raw-review measurements and stage machine. It cannot include or attest its own later scoped review.
- Immediately before B0 whole review, acceptance creation/review, and protected-main merge authorization, a fresh `ls-remote` readback must equal the exact live-main SHA admitted by `organization-identity-current-main-admission.json`. Drift before acceptance repeats Tasks 0B/0C, regenerates baselines, and obtains a new whole review; drift after acceptance abandons that acceptance and restarts the refresh/implementation/review/acceptance sequence.
- Main-drift recovery has one and only one start: preserve the abandoned lineage and create a new successor branch/worktree from the exact pre-scanner `CURRENT_MAIN_ADMISSION_COMMIT` whose tree lacks scanner helpers/manifests and 0M. Rerun 0B/0F/0C from that successor, rerun separately authorized 0M, then run Tasks 1–8 in initial-create mode. Even when the abandoned lineage already contains 0M or `B0_IMPLEMENTATION`, recovery never starts from either; the new lineage begins before 0M and recreates/reviews it. Only the admission JSON is an explicit initial `Create`/successor `Modify`; scanner/helpers/manifests/migration are absent in the recovery preimage. Generators write candidates below a fresh task root, compare exact predecessor/subject contracts, and atomically create only the enumerated outputs—no stale `wx` shortcut or arbitrary upsert.
- After the acceptance scoped review, v2 stops at `LOCAL_ACCEPTANCE_REVIEWED`. Push, exact PR create/update, merge, protected-main readback, GitHub protected variables, and root-only receipt creation each require a separate future authorization.
- The B0 GitHub merge must be a history-preserving merge commit whose actual pre-call PR head is the exact reviewed B0 acceptance head and whose actual base is the exact admitted live-main SHA. Auto-update, queue rebase, squash, rebase, force-push, force-update, and history rewriting are forbidden. Post-readback must prove exactly two ordered parents: admitted main first, reviewed PR head second.
- B1–B6 local runs require `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json` as an explicit CLI input. Hosted authority comes only from protected-main `push` at the exact B0 merge SHA and base-owned `pull_request_target` workflow bytes; ordinary `pull_request` governance remains non-authoritative CI. Missing/wrong workflow/event/run/ref/repository/accepted identities or any PR-controlled executable/input substitution is `INTEGRITY_ERROR`.
- Business data changes use immutable new objects. System boundaries are exact-key, prototype/proxy/accessor-safe, bounded, and fail closed.
- Every committed implementation unit—including Tasks 1–6 and 11–17—follows RED → minimal GREEN → refactor → commit → independent scoped review/fix loop. The next task is blocked until its exact subject/range review receipt has unique `critical=0`, `important=0`, `verdict=PASS`, matching digests and counterexample set. Tasks 7 and 18 remain additional whole-range reviews. Default governance tests remain green at each declared stage; intentional B1/B3 RED commits are local intermediate checkpoints and still require scoped review of the RED contract.
- Task execution order is `1 → 2/3 → 4 → 5 → 6`: Task 4 freezes every scanner/stage/derivation rule before Task 5 generates and independently reviews the raw/build/migration baseline. Any later change to scanner, source-view, closure, filesystem, redaction, stage, or derivation bytes invalidates Task 5 and requires complete baseline regeneration plus a new raw-disposition and scoped review before Task 6 or acceptance.

---

## Evidence Baseline and Current File Map

The final spec subject is committed v2 head `b060c5dd4afef9fe42dfe510b02f930f56cdf7fe`; this tracked plan is the only file this drafting task may change. Cached main `8f3f615e...`, its historical delta and Copy conflicts remain navigation evidence only—not execution constants. Task 0B repeats live protected-main, NUL path/status/copy/rename, no-write merge, owner, migration, build/raw/schema/governance/caller and conflict inspection. Execution begins only from a future reviewed/approved/clean plan commit.

### Existing files that may be modified or tested

| Responsibility                  | Current file(s)                                                                                                                                                                                                                                                                                                                                                                 | Planned use                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current-main admission inputs   | `.github/CODEOWNERS`, `scripts/copy-fixed-source-impact.mjs`, `scripts/copy-fixed-source-impact.spec.mjs`, `docs/evidence/site-builder/copy-runtime-eligibility.json`, `docs/implementation-records/copy-fixed-source-impact-governance.md`                                                                                                                                     | Resolve exact owners and classify/rebuild only the generated Copy evidence conflicts actually observed by the future no-write audit.              |
| Root scripts                    | `package.json`                                                                                                                                                                                                                                                                                                                                                                  | Add the three named identity-writer governance commands; keep pnpm and Node floors unchanged.                                                     |
| Governance runner               | `scripts/governance-verify.mjs`                                                                                                                                                                                                                                                                                                                                                 | Invoke current-stage verification in B0–B4M and mandatory zero in B5/B6 without printing scanner internals.                                       |
| Explicit governance test root   | `scripts/governance-contracts.spec.mjs`, `scripts/governance-path-contracts.spec.mjs`                                                                                                                                                                                                                                                                                           | Import the scanner suite and mutation-test removal of the import/wiring.                                                                          |
| Hosted governance               | `.github/workflows/governance.yml`, `.github/workflows/ci.yml`, `.github/required-contexts.json`, `.github/CODEOWNERS`                                                                                                                                                                                                                                                          | Keep ordinary PR CI non-authoritative; add a protected-main/base-owned anchor workflow and bind its exact blob/event/run permissions.             |
| Build/bootstrap admission       | `apps/api/tsconfig.json`, `apps/api/tsconfig.build.json`, `tsconfig.base.json`, `apps/api/nest-cli.json`, `apps/api/package.json`, `packages/db/package.json`, `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `Dockerfile`, `.dockerignore`, `runtime-entrypoint.mjs`, `scripts/verify-runtime-image.mjs`, `packages/code-intelligence/src/extractors/typescript.ts`  | Pin complete transitive build/config/package/declaration/tool roots; preserve and verify absence sentinels `.npmrc`, `.pnpmfile*`, `patches/`.    |
| Runtime exclusion               | `scripts/runtime-artifact-contract.spec.mjs`, `scripts/verify-runtime-artifact.mjs`, `scripts/generate-runtime-artifact-manifest.mjs`, `Dockerfile`                                                                                                                                                                                                                             | Extend tests to prove scanner/tests/manifests do not enter `apps/api/dist`, release manifests, or OCI. Product runtime copy rules stay unchanged. |
| Artifact A resolver             | `apps/api/src/discovery/organization-identity-resolver.ts`, `apps/api/src/discovery/organization-identity-lock.ts`, `apps/api/src/discovery/organization-identity-resolver.spec.ts`, `apps/api/src/discovery/organization-identity-lock.spec.ts`                                                                                                                                | Consume the current exact function and composite receipt; do not change Artifact A bytes during Artifact B.                                       |
| Temporal writer                 | `apps/api/src/temporal/discovery.activities.ts`, `apps/api/src/temporal/discovery.activities.spec.ts`, `apps/api/src/temporal/discovery-company-materialization.ts`, `apps/api/src/temporal/discovery-company-materialization.activities.contract.spec.ts`, `apps/api/src/temporal/discovery.workflow.ts`                                                                       | B1 RED and B2 cutover of `discovery.activities.ts:906`; keep workflow Activity name and `{companies,suppressed}` result stable.                   |
| Projection writer               | `apps/api/src/acquisition/tenant-projection.service.ts`, `apps/api/src/acquisition/tenant-projection.raw-bridge.spec.ts`, `apps/api/src/acquisition/tenant-projection.suppression.spec.ts`, `apps/api/scripts/project-source.mts`                                                                                                                                               | B3 RED and B4 cutover of `tenant-projection.service.ts:230`; preserve chunk refresh and script consumer.                                          |
| Governed materialization writer | `apps/api/src/temporal/discovery-company-materialization-canonical.ts`, `apps/api/src/temporal/discovery-company-materialization.ts`, `apps/api/src/discovery/discovery-company-materialization-ctx.ts`, related existing specs                                                                                                                                                 | B4M removes `discovery-company-materialization-canonical.ts:206` while preserving durable C-TX outcome/replay contracts.                          |
| Migration static authority      | `packages/db/prisma/migrations/20260830130300_discovery_company_materialization_schema/migration.sql`, `packages/db/prisma/migrations/20260830130400_discovery_company_materialization_functions/migration.sql`, `packages/db/prisma/migrations/20260830130600_organization_identity_link_materialization_compat/migration.sql`, existing Organization Identity migration tests | Pin exact CHECK/function/active-link preimage; create only the later 0M migration and dedicated tests.                                            |
| Disposable source path          | `apps/api/test/fixtures/organization-identity-resolver-app-writer.disposable.ts`, `packages/db/test/organization-identity-v2-resolver-command.disposable.spec.mjs`                                                                                                                                                                                                              | Reuse the app-user resolver pattern; create a separate Artifact B disposable test/fixture instead of changing Artifact A receipts.                |

### Files created before or during B0

| File                                                                                                              | Responsibility                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/governance-organization-identity-launcher.mjs`                                                           | Stdlib-only exact-key closed-command controller source; parses requests before dependency load and invokes only contract-bound command IDs through the accepted clean environment.                                               |
| `scripts/governance-organization-identity-launcher.spec.mjs`                                                      | Non-authority development fixtures for arbitrary-command/env/path rejection, exact executable-closure hashing, hostile preload markers, permissions and TOCTOU.                                                                  |
| `scripts/governance-organization-identity-bootstrap.mjs`                                                          | Stdlib-only accepted-subject/config/sentinel/declaration/tool/generated-output preflight, clean Prisma generation, dynamic TypeScript/scanner import and review-receipt validator.                                               |
| `scripts/governance-organization-identity-bootstrap.spec.mjs`                                                     | Hostile env/preload/pnpmfile/lifecycle/config/store/tool/symlink/TOCTOU marker tests proving no hostile body loads or executes.                                                                                                  |
| `docs/governance/organization-identity-bootstrap-contract.json`                                                   | Immutable accepted launcher/config/environment/tool/declaration/generation/normalization contract; run subjects, roots, inodes and timestamps are excluded.                                                                      |
| `scripts/governance-organization-identity-current-main-admission.mjs`                                             | Closed current-main schema, exact Git set/conflict/migration validator, deterministic metadata-only generator, and closed Copy command registry.                                                                                 |
| `scripts/governance-organization-identity-current-main-admission.spec.mjs`                                        | Pre-refresh exact-set, rename/case collision, conflict/generator provenance, migration disposition, and HOLD mutation tests.                                                                                                     |
| `docs/governance/organization-identity-current-main-admission.json`                                               | First-added or precisely refreshed only in `CURRENT_MAIN_ADMISSION_COMMIT`, the one-parent child of two-parent `B0_REFRESH_BASE_COMMIT`; binds admitted main, merge/parents, complete sets, deltas, and pre-merge review digest. |
| `scripts/governance-organization-identity-writers.mjs`                                                            | CLI, command routing, external-anchor admission, deterministic closed output.                                                                                                                                                    |
| `scripts/governance-organization-identity-writers-contracts.mjs`                                                  | Closed enums, schemas, canonical JSON, budgets, result normalization.                                                                                                                                                            |
| `scripts/governance-organization-identity-writers-files.mjs`                                                      | Git-object reader, build-surface pinning, lstat/realpath/symlink/TOCTOU protections.                                                                                                                                             |
| `scripts/governance-organization-identity-writers-typescript.mjs`                                                 | One-program/one-checker delegate, raw-capability, wrapper-ingress, and dependency-closure engine.                                                                                                                                |
| `scripts/governance-organization-identity-writers-baseline.mjs`                                                   | Refreshed build/raw/current-migration baseline generation plus separate Artifact A resolver/function/ACL/six-receipt verification.                                                                                               |
| `scripts/governance-organization-identity-writers.spec.mjs`                                                       | Literal scanner fixtures, mutation tests, hostile filesystem tests, manifest tests, bounds, redaction, stage, anchor, and runtime exclusion.                                                                                     |
| `docs/governance/organization-identity-writer-baseline.json`                                                      | Exact `B0_REFRESH_BASE_COMMIT` build/raw closure/wrapper ingress/delegate inventory, refreshed budget measurements, hashes, and dispositions.                                                                                    |
| `docs/governance/organization-identity-migration-authority.json`                                                  | Complete refreshed migration directory/checksums/last-change/current-main dispositions plus Artifact A resolver/function/ACL/table privilege authority.                                                                          |
| `docs/governance/organization-identity-artifact-a-acceptance.json`                                                | Durable, non-secret exact Artifact A head/range and six source-receipt identities.                                                                                                                                               |
| `docs/governance/organization-identity-writer-stage.json`                                                         | Closed stage plus scan-result observation digest only.                                                                                                                                                                           |
| `docs/governance/organization-identity-writer-acceptance.json`                                                    | Created later in the one-path `B0_ACCEPTANCE` commit; absent from every B0 implementation commit.                                                                                                                                |
| `packages/db/prisma/migrations/20260902090000_organization_identity_materialization_outcome_compat/migration.sql` | Sole Artifact B DDL-only migration expanding the exact C-TX CHECK for `identity_v2` and `IDENTITY_CONFLICT`.                                                                                                                     |
| `packages/db/test/organization-identity-materialization-outcome-compat.spec.mjs`                                  | Static exact source/catalog/timeout/name/no-DML/migration-order/provenance tests.                                                                                                                                                |
| `packages/db/test/organization-identity-materialization-outcome-compat.disposable.spec.mjs`                       | Separately authorized PostgreSQL 16 fresh/upgrade/lock/fault/catalog/Prisma-ledger/cleanup proof.                                                                                                                                |
| `.github/workflows/organization-identity-writer-anchor.yml`                                                       | Protected-main `push` initial anchor and base-owned `pull_request_target` B1–B6 verifier; never executes PR-controlled bytes.                                                                                                    |

The flat helper filenames intentionally match the terminal CODEOWNERS pattern `/scripts/governance-*.mjs`; no unowned helper directory is introduced.

The separately authorized branch-external materialization is not a repository-created file set. It contains exact reviewed copies at `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher/identity-writer-launch`, `identity-writer-launch.mjs`, `launcher-contract.json`, `launcher-materialization.json`, and `launcher-materialization-review.json` with the modes above. Repository plans/tests may name those future paths, but no tracked task silently creates or modifies them.

Per-task closed requests live only below `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/requests/`, a separate root-controller-owned `0700` directory. Each canonical request is create-exclusive `root:root` mode `0600`, content-addressed in the corresponding `BootstrapRunReceipt`, rejected if reused for a different subject/task/anchor, and removed only by separately authorized controller cleanup after its receipt is durable. It is an external run input, never a tracked artifact or PR-controlled file.

## Locked Machine Interfaces

### Clean-launch, bootstrap, and scoped-review contracts

```ts
type ScopedReviewReceipt = Readonly<{
  schemaVersion: "organization-identity-scoped-review/v1";
  subjectCommit: string;
  baseCommit: string;
  range: string;
  changedPathSetSha256: string;
  reportSha256: string;
  counterexampleSetSha256: string;
  reviewerClass:
    | "INDEPENDENT_BOOTSTRAP_REVIEW"
    | "INDEPENDENT_ADMISSION_REVIEW"
    | "INDEPENDENT_DB_REVIEW"
    | "INDEPENDENT_SECURITY_REVIEW"
    | "INDEPENDENT_CODE_REVIEW"
    | "INDEPENDENT_GOVERNANCE_REVIEW";
  fixRound: number;
  critical: 0;
  important: 0;
  verdict: "PASS";
}>;

type ClosedCommandId =
  | "BOOTSTRAP_AUTHORITY_RUN_V1"
  | "SCOPED_REVIEW_VERIFY_V1"
  | "CURRENT_MAIN_AUDIT_V1"
  | "CURRENT_MAIN_VALIDATE_V1"
  | "CURRENT_MAIN_GENERATE_V1"
  | "COPY_WRITE_ELIGIBILITY_V1"
  | "COPY_SYNC_CITATIONS_V1"
  | "GIT_FETCH_OBJECT_V1"
  | "GIT_REFRESH_MERGE_V1"
  | "GIT_ADMISSION_COMMIT_V1"
  | "GIT_ACCEPTANCE_COMMIT_V1"
  | "REFRESH_VERIFY_V1"
  | "MIGRATION_STATIC_VERIFY_V1"
  | "MIGRATION_DISPOSABLE_VERIFY_V1"
  | "PRISMA_GENERATE_V1"
  | "SCANNER_TEST_V1"
  | "SCANNER_BASELINE_V1"
  | "SCANNER_STAGE_V1"
  | "SCANNER_ZERO_V1"
  | "SCANNER_ACCEPTANCE_V1"
  | "GOVERNANCE_VERIFY_V1"
  | "DOCS_VERIFY_V1"
  | "API_VERIFY_V1"
  | "RUNTIME_ARTIFACT_VERIFY_V1"
  | "CONTRACT_GRAPH_VERIFY_V1"
  | "GITLEAKS_VERIFY_V1"
  | "GITHUB_PR_MERGE_V1"
  | "GITHUB_COMMIT_READBACK_V1"
  | "GIT_FETCH_MERGED_OBJECT_V1"
  | "ROOT_ANCHOR_WRITE_V1"
  | "V3_WORKTREE_CREATE_V1";

type ExecutableClosureEntry = Readonly<{
  role:
    | "ENV"
    | "NODE"
    | "GIT"
    | "COREPACK_SHIM"
    | "COREPACK_LIB_COREPACK_CJS"
    | "PNPM_SHIM"
    | "PNPM_ENTRYPOINT";
  executablePath: string;
  realpathSha256: string;
  sha256: string;
  size: number;
  mode: number;
}>;

type LauncherContract = Readonly<{
  schemaVersion: "organization-identity-launcher-contract/v1";
  rootDirectory: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher";
  approvedPlan: Readonly<{
    path: "docs/superpowers/plans/2026-09-01-organization-identity-writer-ban-at-source.md";
    commit: string;
    blobId: string;
    sha256: string;
  }>;
  approvedSpec: Readonly<{
    path: "docs/superpowers/specs/2026-09-01-organization-identity-writer-ban-at-source-design.md";
    commit: "b060c5dd4afef9fe42dfe510b02f930f56cdf7fe";
    blobId: string;
    sha256: "536e376a40d9ef4f49a65bc0224b74d58eb8a2d743fa766aa020397e67279dd4";
  }>;
  approvedLauncher: Readonly<{
    path: "scripts/governance-organization-identity-launcher.mjs";
    commit: string;
    blobId: string;
    sha256: string;
  }>;
  approvedBootstrap: Readonly<{
    path: "scripts/governance-organization-identity-bootstrap.mjs";
    commit: string;
    blobId: string;
    sha256: string;
  }>;
  executableClosure: readonly ExecutableClosureEntry[];
  commandIds: readonly ClosedCommandId[];
  commandRegistrySha256: string;
  exactEnvironmentSchemaSha256: string;
  bootstrapContractSchemaSha256: string;
  requestSchemaSha256: string;
}>;

type LauncherMaterializationReceipt = Readonly<{
  schemaVersion: "organization-identity-launcher-materialization/v1";
  launcherContractSha256: string;
  ownerUid: 0;
  ownerGid: 0;
  directoryMode: 0o700;
  files: readonly Readonly<{
    basename:
      | "identity-writer-launch"
      | "identity-writer-launch.mjs"
      | "identity-writer-bootstrap.mjs"
      | "launcher-contract.json";
    mode: 0o500 | 0o600;
    device: string;
    inode: string;
    realpathSha256: string;
    sha256: string;
    size: number;
  }>[];
  prePostToctouSha256: string;
  materializedAt: string;
  independentReviewReceiptSha256: string;
  result: "PASS";
}>;

type ClosedCommandRequest = Readonly<{
  schemaVersion: "organization-identity-closed-command-request/v1";
  commandId: ClosedCommandId;
  subjectCommit: string;
  bootstrapContractSha256: string;
  bootstrapRunReceiptSha256: string | null;
  anchorReceiptSha256: string | null;
  inputRecordSha256: string;
}>;

type ExternalLaunchReceipt = Readonly<{
  schemaVersion: "organization-identity-external-launch/v2";
  launcherContractSha256: string;
  launcherMaterializationReceiptSha256: string;
  controllerClass: "BRANCH_EXTERNAL_ROOT" | "PROTECTED_BASE_WORKFLOW";
  acceptedSubjectCommit: string;
  executableClosureSetSha256: string;
  environment: Readonly<{
    PATH: string;
    HOME: string;
    XDG_CONFIG_HOME: string;
    XDG_CACHE_HOME: string;
    COREPACK_HOME: string;
    PNPM_HOME: string;
    TMPDIR: string;
    NPM_CONFIG_USERCONFIG: "/dev/null";
    CI: "1";
    LANG: "C.UTF-8";
    LC_ALL: "C.UTF-8";
  }>;
  cleanEnvironmentNameSetSha256: string;
  preDependencyVerificationSha256: string;
  result: "PASS";
}>;

type ToolRootReceipt = Readonly<{
  logicalPackage: string;
  version: string;
  lockIntegrity: string;
  rootRealpathSha256: string;
  loadedFileCount: number;
  loadedFileSetSha256: string;
  contentSetSha256: string;
  prePostToctouSha256: string;
}>;

type BootstrapContract = Readonly<{
  schemaVersion: "organization-identity-bootstrap-contract/v1";
  launcherContractSha256: string;
  bootstrapSchemaSha256: string;
  acceptedConfigurationSetSha256: string;
  acceptedAbsenceSentinelSetSha256: string;
  effectivePnpmArgsSha256: string;
  ignoreScripts: true;
  ignorePnpmfile: true;
  allowedEnvironmentNames: readonly [
    "PATH",
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "COREPACK_HOME",
    "PNPM_HOME",
    "TMPDIR",
    "NPM_CONFIG_USERCONFIG",
    "CI",
    "LANG",
    "LC_ALL",
  ];
  allowedEnvironmentValueSchemaSha256: string;
  dependencyDeclarationContractSha256: string;
  toolExecutionContractSha256: string;
  generatedOutputDerivationSha256: string;
  normalization: Readonly<{
    allowedRunFields: readonly [
      "acceptedSubjectCommit",
      "taskRoot",
      "taskRootDevice",
      "taskRootInode",
      "startedAt",
      "finishedAt",
      "generatedOutputSetSha256",
      "prePostToctouSha256",
    ];
    invariantComparisonSha256: string;
  }>;
}>;

type BootstrapRunReceipt = Readonly<{
  schemaVersion: "organization-identity-bootstrap-run/v1";
  bootstrapContractSha256: string;
  launcherMaterializationReceiptSha256: string;
  externalLaunchReceiptSha256: string;
  acceptedSubjectCommit: string;
  taskRoot: string;
  taskRootDevice: string;
  taskRootInode: string;
  fixedRootSetSha256: string;
  postInstallBootstrapRehashSha256: string;
  dependencyDeclarationRoots: readonly ToolRootReceipt[];
  toolExecutionRoots: readonly ToolRootReceipt[];
  prismaSchemaSha256: string;
  generatedClientSetSha256: string;
  generatedDmmfSha256: string;
  generatedDelegateSetSha256: string;
  generatedOutputSetSha256: string;
  typescriptDynamicImportSha256: string;
  hostileMarkerSetSha256: string;
  hostileMarkerExecutionCount: 0;
  prePostToctouSha256: string;
  startedAt: string;
  finishedAt: string;
  result: "PASS";
}>;
```

The root-only wrapper accepts exactly one path to a `ClosedCommandRequest` below the controller-owned task root. It performs no shell evaluation and gives the request to the pinned absolute Node executable as `/usr/bin/env -i <exact-environment> <pinned-node> <root-launcher.mjs> --request <path>`. The stdlib launcher rejects unknown/extra JSON keys, arbitrary argv, free-form commands, unregistered environment names, non-owned/symlinked paths and receipt drift before any non-`node:` dependency load. It rehashes the approved plan/spec/launcher/bootstrap blobs, the materialization receipt and the complete executable closure; the latter includes both the Corepack/pnpm shims and the exact `lib/corepack.cjs`/pnpm entrypoint bytes. A current interactive shell, `jq`, repository package script or PR-controlled workflow byte is never part of an authority claim.

`SCOPED_REVIEW_VERIFY_V1` parses `ScopedReviewReceipt`, recomputes subject/range/path/report/counterexample digests, and rejects extra/missing keys, duplicate/conflicting severity fields, any nonzero Critical/Important, or a verdict other than PASS. For the launcher's own first review, the external reviewer also performs three separate exact assertions—`rg -qx 'Critical: 0'`, `rg -qx 'Important: 0'`, `rg -qx 'Verdict: PASS'`—and proves each label occurs exactly once before trusting the new verifier. Those direct assertions are bootstrap-of-trust checks only; every later machine review gate is dispatched as `SCOPED_REVIEW_VERIFY_V1`.

The immutable `BootstrapContract` contains only accepted configuration, command/derivation schemas, invariant tool/declaration requirements and the explicit run-field normalization rule. `BootstrapRunReceipt` contains the subject, fresh task root, inode/device/time/TOCTOU state and generated results for one run. B0 acceptance freezes the contract schema/blob/digest and launcher materialization identity, never one run receipt. Each B0 or B1–B6 authority call creates a fresh receipt, requires `receipt.bootstrapContractSha256` to equal the accepted contract, compares every non-allowlisted field exactly, and permits differences only in the eight enumerated `normalization.allowedRunFields`. For B0 the run subject equals the reviewed current implementation candidate; after protected-main merge every v3/B1–B6 run subject equals the current candidate descendant and the accepted protected-main contract is immutable. The source/PR head remains scanned data, not executable bootstrap configuration.

The authority pnpm invocation is exactly `install --frozen-lockfile --ignore-scripts --ignore-pnpmfile` with `ignorePnpmfile=true`, `NPM_CONFIG_USERCONFIG=/dev/null`, and fixed store/virtual-store/modules/cache/config roots under the fresh task root. Before pnpm, the root controller verifies accepted Git blobs and required absence for package/workspace/lock/bootstrap/test files, `.dockerignore`, `.npmrc`, every `.pnpmfile*`, `patches/`, hook/config-dependency inputs and all executable/config/storage selectors. After install it rehashes bootstrap inode/realpath/digest. Prisma generation precedes generated-output verification; TypeScript/scanner modules are loaded only by dynamic import after all preflight receipts pass.

Every later reference to an “authority run” means this exact outer form, with the request bytes written create-exclusively by the root/base controller and already bound to its declared command ID, subject, contract, fresh run receipt and optional anchor:

```bash
/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher/identity-writer-launch \
  --request /global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/requests/task-0a-current-main-validate.json
```

The displayed Task 0A request is the concrete form; every task below names its exact `ClosedCommandId` and canonical request filename/digest in that task's receipt. Direct `node`, `pnpm`, `git`, `gh`, `jq`, `rg` or `gitleaks` blocks document either a non-authority development diagnostic or the internal closed-command expansion that the root launcher must reproduce; none alone can satisfy the named gate.

### Current-main admission contracts and validator API

```ts
type AuditReviewReceipt = Readonly<{
  schemaVersion: "organization-identity-current-main-audit-review/v1";
  disposition: "PASS" | "FETCH_AUTH_REQUIRED";
  auditPacketSha256: string;
  branchPreRefreshCommit: string;
  advertisedLiveMainCommit: string;
  mergeBaseCommit: string | null;
  mainOnlyPathSetSha256: string | null;
  conflictSetSha256: string | null;
  migrationSetSha256: string | null;
  dispositionSetSha256: string | null;
  authorizationRequestSha256: string;
  fetchReceiptSha256: string | null;
  reportSha256: string;
  counterexampleSetSha256: string;
  reviewerClass: "INDEPENDENT_ADMISSION_AUDIT_REVIEW";
  critical: 0;
  important: 0;
  verdict: "PASS";
}>;

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
    auditPacketSha256: string;
    auditReviewReceiptSha256: string;
    reportSha256: string;
    verdict: "PASS";
  }>;
}>;
```

All objects are exact-key plain records. Git object IDs are 40 lowercase hex; SHA-256 values are 64 lowercase hex; paths are normalized POSIX repository-relative paths; classifications/evidence/records are nonempty where required, deterministically sorted, and duplicate-free. `baseBlobId` is null exactly for a main-added path, `mainBlobId` exactly for a main-deleted path, `branchBlobId` exactly when the path is mechanically absent from the branch preimage, and `resultBlobId` exactly when the merge result deletes the path. `generatedRebuild` is non-null exactly for `ADMIT_GENERATED_REBUILT`; every other disposition requires null. `refreshParents` is ordered `[branchPreRefreshCommit, liveMainCommit]`. `mainOnlyPathSetSha256` is the SHA-256 of the sorted exact main-only path bytes, each followed by one NUL byte. Rename/copy status, case collisions, missing/extra/out-of-range path records, a non-exact owner, a conflict/hunk mismatch, an incomplete refreshed migration directory, any record-level `HOLD`, or top-level `HOLD` makes admission fail.

`CurrentMainAdmission.refreshMergeCommit` is exactly `B0_REFRESH_BASE_COMMIT`, the normal two-parent merge. The JSON cannot contain its own future Git commit identity; its one-parent container commit is named `CURRENT_MAIN_ADMISSION_COMMIT` by Git after the JSON is committed. `CurrentMainAdmission.review` binds the exact immutable Task 0B audit packet, dedicated `AuditReviewReceipt`, review report and authorization-request digest. Immediately before starting the merge and again before admission generation, Task 0C recomputes the packet digest and every exact live-main/path/conflict/migration/disposition binding. The Task 0C post-refresh review covers the exact range through `CURRENT_MAIN_ADMISSION_COMMIT`, remains ignored external evidence, and is bound later by `B0_ACCEPTANCE` rather than self-written into the admission JSON.

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
  reviewedAuditPacketSha256,
  auditReviewReceiptSha256,
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
  dispositionReviewBinding: Readonly<{
    recordId: string;
    structuralHash: string;
    dispositionSha256: string;
  }>;
}>;

type WriterBaselineMeasurements = Readonly<{
  sourceFiles: number;
  astNodesMaximumPerFile: number;
  projectSymbolCallEdges: number;
  rawCapabilityRecords: number;
  wrapperIngressRecords: number;
  dependencyClosureMembers: number;
  maximumResolutionDepth: number;
  maximumAssignmentFanout: number;
  maximumResolutionAlternatives: number;
  maximumCandidateBytesPerRecord: number;
  projectCommittedBytes: number;
}>;

type RawDispositionReviewReceipt = Readonly<{
  schemaVersion: "organization-identity-raw-disposition-review/v1";
  sourceSubjectCommit: string;
  rawRecordCount: number;
  rawRecordSetSha256: string;
  dispositionSetSha256: string;
  dependencyClosureSetSha256: string;
  counterexampleSetSha256: string;
  reportSha256: string;
  reviewerClass: "INDEPENDENT_RAW_AUTHORITY_REVIEW";
  critical: 0;
  important: 0;
  verdict: "PASS";
}>;

type WriterBaseline = Readonly<{
  schemaVersion: "organization-identity-writer-baseline/v1";
  refreshBaseCommit: string;
  currentMainAdmissionCommit: string;
  admittedLiveMainCommit: string;
  currentMainAdmissionSha256: string;
  b0mMigrationCommit: string;
  b0mMigrationSha256: string;
  artifactACommit: "2400bac28796bae44294114edc99eaccb1bd65b3";
  launcherContractSha256: string;
  launcherMaterializationReceiptSha256: string;
  bootstrapContract: BootstrapContract;
  baselineBootstrapRunReceiptSha256: string;
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
    configClosureSha256: string;
    dependencyDeclarationRootSha256: string;
    toolExecutionRootSha256: string;
    controlledFiles: readonly Readonly<{
      path: string;
      gitBlobId: string;
      sha256: string;
    }>[];
  }>;
  measurements: WriterBaselineMeasurements;
  rawDispositionReview: RawDispositionReviewReceipt;
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
  b0m: Readonly<{
    commit: string;
    path: "packages/db/prisma/migrations/20260902090000_organization_identity_materialization_outcome_compat/migration.sql";
    migrationSqlSha256: string;
    temporaryConstraintName: "discovery_company_materialization_outcome_artifact_b_check";
    temporaryConstraintNameUtf8Bytes: 58;
    staticReviewReceiptSha256: string;
    databaseReviewReceiptSha256: string;
    securityReviewReceiptSha256: string;
    disposableReceiptSha256: string;
  }>;
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

The migration manifest proves the complete directory at `B0M_MIGRATION_COMMIT` equals the exact `B0_REFRESH_BASE_COMMIT` directory plus one and only one accepted 0M path. Every refreshed main-only migration has a current-main disposition; 0M has its exact definition/review/disposable receipt; Artifact A resolver/function/ACL arrays are independently re-derived. No retained database query supplies expected authority.

### Non-self-referential B0 acceptance schema

```ts
type B0Acceptance = Readonly<{
  schemaVersion: "organization-identity-writer-acceptance/v1";
  artifactACommit: "2400bac28796bae44294114edc99eaccb1bd65b3";
  refreshBaseCommit: string;
  admittedLiveMainCommit: string;
  refreshMergeCommit: string;
  currentMainAdmissionCommit: string;
  b0mMigrationCommit: string;
  refreshParents: readonly [string, string];
  bootstrap: Readonly<{
    launcherContractSha256: string;
    launcherMaterializationReceiptSha256: string;
    bootstrapContractSchemaSha256: string;
    bootstrapContractBlobId: string;
    bootstrapContractSha256: string;
    bootstrapBlobId: string;
    bootstrapSha256: string;
    bootstrapTestBlobId: string;
    bootstrapTestSha256: string;
    runReceiptSchemaSha256: string;
    implementationRunReceiptSha256: string;
    allowedRunFieldSetSha256: string;
  }>;
  b0m: MigrationAuthority["b0m"];
  protectedAnchorWorkflow: Readonly<{
    path: ".github/workflows/organization-identity-writer-anchor.yml";
    gitBlobId: string;
    sha256: string;
  }>;
  currentMainAdmission: Readonly<{
    gitBlobId: string;
    sha256: string;
    auditPacketSha256: string;
    auditReviewReceiptSha256: string;
    preMergeReviewSha256: string;
    postRefreshReviewSha256: string;
  }>;
  reviewedImplementationCommit: string;
  controlledParentBlobs: readonly Readonly<{
    path: string;
    gitBlobId: string;
    sha256: string;
  }>[];
  implementationReviews: readonly ScopedReviewReceipt[];
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
  launcherContractSha256: string;
  launcherMaterializationReceiptSha256: string;
  bootstrapContractSha256: string;
  bootstrapContractSchemaSha256: string;
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
  hostedAnchor: Readonly<{
    workflowPath: ".github/workflows/organization-identity-writer-anchor.yml";
    workflowBlobId: string;
    event: "push";
    ref: "refs/heads/main";
    runId: number;
    runAttempt: number;
    headSha: string;
    receiptSha256: string;
    conclusion: "success";
  }>;
  observedAt: string;
  predecessorReceiptSha256: string | null;
  receiptChainSha256: string;
  containsSecrets: false;
}>;
```

Local admission accepts this record only from the exact root-owned `0700` successor directory supplied with the closed command request. The ordered `mergeParents` must be `[admittedLiveMainSha, acceptedB0Sha]`; ancestry without ordered-parent equality is insufficient. Every local B1–B6 request binds a fresh `BootstrapRunReceipt` whose contract digest equals this anchor's accepted bootstrap contract. Hosted admission accepts only `GITHUB_ACTIONS=true`, an exact pull-request/base or protected-main push event read from `GITHUB_EVENT_PATH`, and controller-owned repository variables for the admitted main, accepted/review/launcher/bootstrap identities, ordered parents, and merge method. The base-owned workflow runs the accepted launcher/bootstrap bytes from protected main or an equivalent root controller; a PR cannot supply executable bootstrap/launcher bytes, controller values, package scripts, artifacts, job output, or command requests.

## Task Dependencies, Review Units, and Critical Path

| Task | Produces                                                                                                | Consumed by         | Dependency                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------- |
| 0L   | Reviewed tracked closed-command launcher; after 0P, separately authorized root-only materialization     | 0P, then 0A–18      | Exact approved plan; root phase separately requires 0P PASS and exact auth  |
| 0P   | Reviewed immutable bootstrap contract/fresh-run engine and hostile no-exec tests                        | 0L root phase/0A–18 | 0L tracked launcher scoped review PASS                                      |
| 0A   | Reviewed minimal current-main admission validator/contracts consuming launcher/bootstrap                | 0B/0F/0C and 1–8    | 0P PASS plus 0L root materialization/review PASS                            |
| 0B   | Reviewed no-fetch packet with `PASS`, `HOLD`, or `FETCH_AUTH_REQUIRED`                                  | 0F or 0C            | 0A scoped review PASS                                                       |
| 0F   | Exact fetch-only object receipt; no merge                                                               | 0B rerun only       | Independently reviewed `FETCH_AUTH_REQUIRED` plus exact fetch authorization |
| 0C   | Exact two-parent refresh merge, one-parent admission commit, post-refresh review                        | 0M and 1–9          | Full rerun of 0B yields PASS plus separate local-merge authorization        |
| 0M   | Sole compatibility migration, static/disposable receipts and independent DB/security reviews            | 1–8 and B4M         | 0C PASS plus migration-file and separate disposable authorizations          |
| 1    | Closed scanner contracts, CLI shell, refreshed build/bootstrap-surface RED                              | 2–6                 | Separate scanner auth; HEAD descends from accepted `B0M_MIGRATION_COMMIT`   |
| 2    | Delegate/capability-boundary engine                                                                     | 4–8 and every stage | 1                                                                           |
| 3    | Raw/wrapper/dependency-closure engine                                                                   | 4–8 and every stage | 1                                                                           |
| 4    | Final stage/derivation/resource/filesystem/redaction/anchor engine, reviewed before baseline generation | 5 and 6–8/B1–B6     | 2 and 3                                                                     |
| 5    | Reviewed refreshed build/raw/migration baselines plus Artifact A Identity authority/six-receipt intake  | 6–8                 | 4 final scanner/derivation review PASS                                      |
| 6    | Root package/governance/workflow/runtime-exclusion wiring                                               | 7 and 8             | 5                                                                           |
| 7    | Exact `B0_IMPLEMENTATION` review head and independent whole-review digest                               | 8                   | 1–6                                                                         |
| 8    | One-path accepted B0 commit and scoped acceptance review                                                | 9                   | 7                                                                           |
| 9    | Authorized protected-main merge identity and branch-external anchor                                     | 10                  | 8 plus separate external authorizations                                     |
| 10   | Exact v3 branch/worktree from protected-main merge                                                      | 11                  | 9 plus explicit local execution approval                                    |
| 11   | B1 Temporal five-outcome/replay RED                                                                     | 12                  | 10                                                                          |
| 12   | B2 Temporal resolver cutover, `3 → 2`                                                                   | 13                  | 11                                                                          |
| 13   | B3 projection five-outcome/chunk/replay RED                                                             | 14                  | 12                                                                          |
| 14   | B4 projection resolver cutover, `2 → 1`                                                                 | 15                  | 13                                                                          |
| 15   | B4M materialization resolver cutover, `1 → 0`                                                           | 16                  | 14                                                                          |
| 16   | B5 mandatory zero and downstream/governance promotion                                                   | 17                  | 15                                                                          |
| 17   | B6 mixed-fleet/replay/race/disposable proof                                                             | 18                  | 16 plus separate disposable-resource authorization                          |
| 18   | Independent whole Artifact B code/security/database review                                              | Handoff only        | 17                                                                          |

Critical path is `0L tracked RED/GREEN/commit/review → 0P bootstrap RED/GREEN/commit/review → separate root-materialization auth → 0L root materialization/review → 0A → 0B → [object missing: reviewed FETCH_AUTH_REQUIRED → exact fetch auth → 0F → full 0B rerun] → 0B PASS → separate local-merge auth → 0C → separate 0M migration-file auth → 0M static review → separate disposable auth → 0M disposable/DB/security reviews → separate scanner auth → 1 → 2/3 → 4 → 5 → 6 → live-main recheck → 7 → 8 → remote gates 9 → post-merge readback/fetch gates → 10 → 11–18`. Task 0B may parallelize only read-only classification after `ls-remote`; 0F never merges. Tasks 1–6 execute as descendants of `B0M_MIGRATION_COMMIT`, while product build/raw baselines read `B0_REFRESH_BASE_COMMIT` and migration authority reads the accepted refresh directory plus exact 0M delta. No scanner/derivation byte may change after Task 5's raw review without full Task 5 regeneration/review. Every committed unit ends at a scoped review/fix-loop barrier.

## V2 Delivery: Current-Main Refresh, B0 Implementation, and Local Acceptance

### Task 0L: Closed-Command Launcher, Independent Review, and Separately Authorized Root Materialization

**Files:**

- Create: `scripts/governance-organization-identity-launcher.mjs`
- Create: `scripts/governance-organization-identity-launcher.spec.mjs`
- Create local review: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-0l-launcher-review.md`
- Create local review receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-0l-launcher-review.json`
- Create only after separate root-write authorization: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher/identity-writer-launch`
- Create only after separate root-write authorization and Task 0P PASS: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher/identity-writer-launch.mjs`
- Create only after separate root-write authorization and Task 0P PASS: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher/identity-writer-bootstrap.mjs`
- Create only after separate root-write authorization and Task 0P PASS: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher/launcher-contract.json`
- Create only after separate root-write authorization: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher/launcher-materialization.json`
- Create only after separate root-write authorization: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher/launcher-materialization-review.json`
- Test: `scripts/governance-organization-identity-launcher.spec.mjs`
- Read-only: exact approved plan/spec Git blobs; `/usr/bin/env`; pinned absolute Node/Git/Corepack/pnpm executable closure; after Task 0P, exact reviewed bootstrap source/test/contract identities.

**Interfaces:**

- Consumes: exact approved plan commit/blob/SHA; final spec commit/blob/SHA; the `ClosedCommandId`, `ClosedCommandRequest`, `LauncherContract`, `LauncherMaterializationReceipt`, `BootstrapContract`, and `BootstrapRunReceipt` schemas. Its second phase additionally consumes final reviewed Task 0P bootstrap commit/report/receipt and a separate exact root-materialization authorization naming all source/target digests and modes.
- Produces: `parseClosedCommandRequest(bytes)`, `verifyLauncherContract(contract, observed)`, `verifyExecutableClosure(entries)`, `dispatchClosedCommand(request, verifiedContext)`, a reviewed tracked launcher commit, and—only after the later root authorization—a root-owned exact launcher/bootstrap/contract materialization plus independent read-only receipt review. It never accepts arbitrary command strings or package executables.

**Commit message:** `feat: add closed identity governance launcher`

- [ ] **Step 1: Verify the future approved/committed local execution state and create the ignored review parent**

Run only after this exact plan is independently approved and committed. Use `mkdir -p .superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source`, create `.superpowers/sdd/.gitignore` with exact content `*` by `apply_patch` if absent, verify `git check-ignore`, and require a clean tracked/untracked worktree. This local phase is authorized by exact plan approval; no root path may exist or be written yet.

- [ ] **Step 2: Write exact parser/closure/permission RED tests**

Test every exact schema key and enum plus mutations for an extra argv, arbitrary command, shell metacharacter, unknown environment name, inherited `NODE_OPTIONS`/`NODE_PATH`, accessor/proxy JSON surrogate, relative/out-of-root request, symlink, wrong owner/mode, inode replacement and malformed canonical bytes. Assert complete executable closure equality, including separate entries for `COREPACK_SHIM`, `COREPACK_LIB_COREPACK_CJS`, `PNPM_SHIM`, and `PNPM_ENTRYPOINT`.

```js
test("rejects an executable-looking value outside the closed registry", async () => {
  const result = await fixture.launch({
    commandId: "node scripts/governance-verify.mjs",
  });
  assert.deepEqual(result, {
    status: "INTEGRITY_ERROR",
    code: "CLOSED_COMMAND_ID_INVALID",
  });
  assert.equal(fixture.dependencyLoadCount, 0);
  assert.equal(fixture.hostileMarkerExecutionCount, 0);
});
```

- [ ] **Step 3: Run the non-authority development RED**

```bash
node --test scripts/governance-organization-identity-launcher.spec.mjs
```

Expected: FAIL because the launcher module does not exist. This direct local Node run is development evidence only and cannot satisfy an authority gate.

- [ ] **Step 4: Implement the stdlib-only exact parser and predependency verifier**

Use only `node:` built-ins with no static/imported package dependency. Parse canonical JSON into a null-prototype plain record; reject extra/missing keys, accessors/proxies exposed by test adapters, non-NFC strings and non-absolute controller paths. Before dispatch, lstat/open/fstat/realpath/hash the approved plan/spec/launcher/bootstrap bytes, root materialization receipt, request, environment schema and every executable-closure entry; repeat the inode/device/digest readback immediately before dependency loading.

- [ ] **Step 5: Implement the closed dispatcher and reviewed wrapper content contract**

`dispatchClosedCommand` uses an exhaustive `switch` over the literal `ClosedCommandId` union and constructs each complete argv internally. The root wrapper content is fixed and reviewed: it accepts exactly `--request ABSOLUTE_REQUEST_PATH`, rejects every other argc/flag, and `exec`s `/usr/bin/env -i` with only the contract's eleven environment names, `NPM_CONFIG_USERCONFIG=/dev/null`, the contract-selected absolute Node, the root `identity-writer-launch.mjs`, and that request. It performs no `eval`, command substitution, PATH lookup, JSON parsing, `jq`, sourcing or package load.

- [ ] **Step 6: Run local GREEN, mutation tests, and diff check**

```bash
node --test scripts/governance-organization-identity-launcher.spec.mjs
git diff --check -- \
  scripts/governance-organization-identity-launcher.mjs \
  scripts/governance-organization-identity-launcher.spec.mjs
```

Expected: PASS with zero dependency loads/hostile executions for every rejected request. These remain non-authority development tests because root materialization does not yet exist.

- [ ] **Step 7: Commit and independently review the tracked launcher unit**

```bash
git add scripts/governance-organization-identity-launcher.mjs \
  scripts/governance-organization-identity-launcher.spec.mjs
git commit -m "feat: add closed identity governance launcher"
LAUNCHER_SOURCE_COMMIT="$(git rev-parse HEAD)"
```

The independent reviewer fixes the two-file path set, plan/spec/launcher blob identities, command registry, executable closure, exact wrapper content, permission matrix, redaction and hostile counterexamples. Before the new review verifier is trusted, require unique exact `Critical: 0`, `Important: 0`, `Verdict: PASS` lines using separate `rg -qx` commands and record their report/path/counterexample digests in the local Task 0L receipt. Findings produce a forward Task 0L-only fix commit and complete rerun/re-review; no amend.

- [ ] **Step 8: Complete Task 0P, then stop for separate exact root-materialization authorization**

Task 0P now creates/reviews the immutable `BootstrapContract` and bootstrap runner. Return to this step only after its exact final commit/report/receipt exist. Produce a read-only materialization packet containing exact launcher/bootstrap/plan/spec blobs, absolute source/targets, owner/modes, environment, Node/Git/Corepack/pnpm closure (including `lib/corepack.cjs`), contract digest and expected receipt bytes. STOP and request authorization that names this packet digest. Plan approval, launcher review and Task 0P review do not imply this root write.

- [ ] **Step 9: Materialize only the exact authorized bytes and modes**

After that authorization, a root controller—not the feature shell—creates only the exact directory and six enumerated files. It uses create-exclusive temporary files inside the exact parent, verifies source Git blobs and SHA-256 before and after copy, `fsync`s file/directory state, atomically renames, then enforces `root:root`, directory `0700`, executable wrapper/launcher/bootstrap `0500`, and JSON receipts `0600`. Existing unexpected paths, links, devices, inode changes, broader modes or digest mismatches are `ROOT_LAUNCHER_MATERIALIZATION_HOLD`; never overwrite or recursively clean.

- [ ] **Step 10: Independently read back materialization and issue the root receipt**

An independent root-capable reviewer opens every file without following symlinks, verifies owner/mode/device/inode/realpath/size/digest, recompares all approved Git blobs and executable closure entries, executes hostile closed-request counterexamples through the wrapper, and verifies no package dependency loaded before acceptance. It writes exact-key `LauncherMaterializationReceipt` and scoped receipt at mode `0600`; unique exact zero-Critical/zero-Important/PASS assertions are required. Findings abandon the materialization, preserve evidence, and require a new exact authorization before replacement; Task 0A remains blocked.

- [ ] **Step 11: Freeze the launcher trust-root inputs**

Record `LAUNCHER_CONTRACT_SHA256`, `LAUNCHER_MATERIALIZATION_RECEIPT_SHA256`, pinned Node absolute path/digest, wrapper/launcher/bootstrap digests, Corepack shim plus `lib/corepack.cjs`, pnpm shim/entrypoint, and root review digest. From this point, every authority-bearing step uses the root wrapper with a canonical `ClosedCommandRequest`; a direct `node`/`pnpm` command shown later is explicitly diagnostic unless immediately labeled as a root-launcher closed-command expansion.

### Task 0P: Clean Pre-Execution Bootstrap, Review Contracts, and Independent Review

**Files:**

- Create: `scripts/governance-organization-identity-bootstrap.mjs`
- Create: `scripts/governance-organization-identity-bootstrap.spec.mjs`
- Create: `docs/governance/organization-identity-bootstrap-contract.json`
- Create local review parent/exclusion: `.superpowers/sdd/.gitignore`
- Create local review narrative: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-0p-bootstrap-review.md`
- Create local review receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-0p-bootstrap-review.json`
- Test: `scripts/governance-organization-identity-bootstrap.spec.mjs`
- Read-only: final spec/reviews; `package.json`, `apps/api/package.json`, `packages/db/package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.base.json`, API tsconfigs/Nest config, `.dockerignore`, `.gitignore`, Docker/runtime inputs, current absence of `.npmrc`, `.pnpmfile*`, and `patches/`.

**Interfaces:**

- Consumes: exact final spec commit/hash, reviewed Task 0L tracked launcher/review, pinned Node/Git/Corepack/pnpm/Prisma/TypeScript identities, accepted Git package/config/sentinel subjects, and the clean-launch/bootstrap/review schemas above.
- Produces: stdlib-only bootstrap CLI; exact immutable `docs/governance/organization-identity-bootstrap-contract.json`; `validateExternalLaunchReceipt`; `validateBootstrapContract`; `validateBootstrapRunReceipt`; `compareRunToAcceptedContract`; `materializeAcceptedInstallInputs`; `verifyBootstrapPreimage`; `verifyDependencyAndToolRoots`; `runAcceptedPrismaGenerate`; `loadAcceptedScanner`; `verify-review`; hostile no-exec marker fixtures; independently reviewed `BOOTSTRAP_CONTRACT_COMMIT`. Actual authority begins only after Task 0L's separately authorized root materialization of these reviewed bytes.

**Commit message:** `feat: add clean identity governance bootstrap`

- [ ] **Step 1: Verify the future approved/committed execution state**

```bash
cd /global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v2
test "$(git branch --show-current)" = codex/pr407-organization-identity-caller-cutover-v2
git merge-base --is-ancestor b060c5dd4afef9fe42dfe510b02f930f56cdf7fe HEAD
test "$(git show b060c5dd4afef9fe42dfe510b02f930f56cdf7fe:docs/superpowers/specs/2026-09-01-organization-identity-writer-ban-at-source-design.md | sha256sum | cut -d' ' -f1)" = 536e376a40d9ef4f49a65bc0224b74d58eb8a2d743fa766aa020397e67279dd4
git ls-files --error-unmatch docs/superpowers/plans/2026-09-01-organization-identity-writer-ban-at-source.md
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

Expected: PASS only after final plan review, exact user plan approval and plan commit. Final-spec confirmation alone does not open this step.

- [ ] **Step 2: Create the bounded local SDD review workspace before any review write**

```bash
SDD_PARENT=.superpowers/sdd
SDD_TASK="$SDD_PARENT/2026-09-01-organization-identity-writer-ban-at-source"
mkdir -p "$SDD_TASK"
```

Use `apply_patch` to create `.superpowers/sdd/.gitignore` with exactly `*`, then run `git check-ignore -v "$SDD_TASK/task-0p-bootstrap-review.md"`. Never stage this local review tree.

- [ ] **Step 3: Write clean-launch and exact-config RED fixtures**

Test exact-key `ExternalLaunchReceipt`, immutable `BootstrapContract`, per-run `BootstrapRunReceipt`, `ToolRootReceipt` and `ScopedReviewReceipt`; exact normalization that permits only the eight enumerated run fields to vary; accepted Git blob/absence verification for package/workspace/lock/bootstrap/test/`.dockerignore`/`.npmrc`/every `.pnpmfile*`/patch/config-dependency/hook input; immutable fresh materialization; fixed root containment; and rejection before a package manager or Node dependency module starts.

- [ ] **Step 4: Write hostile no-execution RED fixtures**

Create marker-bearing fake local/global pnpmfiles, lifecycle scripts, config dependencies, patches, redirected store/cache/config, `NODE_OPTIONS --require/--import`, custom loaders, `NODE_PATH`, changed bootstrap/compiler/generator/engine bytes and symlinks. Instrument module/tool loaders and require marker execution/load counts to remain zero, not merely a later nonzero exit.

- [ ] **Step 5: Run RED**

```bash
node --test scripts/governance-organization-identity-bootstrap.spec.mjs
```

Expected: FAIL because the bootstrap module, immutable contract and run-receipt validators do not exist. This direct Node run is non-authority development evidence.

- [ ] **Step 6: Implement accepted-subject pre-pnpm verification and immutable materialization**

Use only `node:` built-ins. Verify accepted Git blobs/required absence, `/usr/bin/env`, Node, Git, the Corepack shim and `lib/corepack.cjs`, the pnpm shim/entrypoint and bootstrap identities before constructing a fresh task root. Materialize only accepted package/workspace/lock/bootstrap/config inputs; mutable PR/current-tree bytes remain scanner data and never become installer configuration. Generate the canonical `BootstrapContract` from invariant inputs only; reject subject/time/root/generated-output fields in that contract.

- [ ] **Step 7: Implement the exact clean pnpm command and fixed roots**

The bootstrap returns a data-only closed argv/environment record; it never accepts argv from its caller. `BOOTSTRAP_AUTHORITY_RUN_V1` expands internally to the receipt-selected pnpm entrypoint with `install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --config.ignore-pnpmfile=true`, `NPM_CONFIG_USERCONFIG=/dev/null`, and fixed store/virtual-store/modules/cache/config/task-home roots. Disable local/global/config-dependency hook selectors. The Task 0P fixtures execute this expansion only inside hostile temporary roots and label it non-authority; after Task 0L root materialization, the exact same expansion can make an authority claim. Missing pinned Corepack shim/`lib/corepack.cjs`/pnpm entrypoint/cache results in `TOOL_BOOTSTRAP_UNAVAILABLE/HOLD`; never relax a flag or execute postinstall.

- [ ] **Step 8: Implement post-install rehash, Prisma generation and dynamic imports**

After install, reverify bootstrap inode/device/realpath/digest. The stdlib bootstrap rehashes complete accepted config/sentinel/tool/declaration inputs, then expands exact `pnpm --filter @global/db generate` under the same clean environment, verifies generated schema/client/DMMF/delegate digests and TOCTOU state, and only then dynamically imports accepted TypeScript/compiler/scanner modules. It emits a fresh `BootstrapRunReceipt` whose contract digest is invariant and whose subject/root/inode/time/generated/TOCTOU fields are the only normalized per-run values. Static top-level `import "typescript"` is forbidden in bootstrap/CLI authority entrypoints.

- [ ] **Step 9: Implement closed review-receipt verification**

`verify-review` rejects missing/extra keys, conflicting/duplicate severity/verdict fields, subject/range/path/report/counterexample digest drift, `critical != 0`, `important != 0`, or `verdict != PASS`. It emits only closed codes/metadata.

- [ ] **Step 10: Run GREEN and hostile marker proof**

```bash
node --test scripts/governance-organization-identity-bootstrap.spec.mjs
git diff --check -- \
  scripts/governance-organization-identity-bootstrap.mjs \
  scripts/governance-organization-identity-bootstrap.spec.mjs \
  docs/governance/organization-identity-bootstrap-contract.json
```

Expected: PASS; every hostile loaded/executed marker count is exactly zero, contract bytes are deterministic across distinct task roots/times/subjects, only allowed run fields differ, and no untrusted value/path/body is printed. This direct run remains development evidence until 0L root materialization.

- [ ] **Step 11: Commit the bounded bootstrap unit**

```bash
git add scripts/governance-organization-identity-bootstrap.mjs \
  scripts/governance-organization-identity-bootstrap.spec.mjs \
  docs/governance/organization-identity-bootstrap-contract.json
git commit -m "feat: add clean identity governance bootstrap"
BOOTSTRAP_CONTRACT_COMMIT="$(git rev-parse HEAD)"
```

- [ ] **Step 12: Run the independent scoped review and fix loop**

The reviewer fixes `BOOTSTRAP_CONTRACT_COMMIT`, its parent/range/path set and final spec hash; adds hostile pre-pnpm, TOCTOU, pnpm-hook, tool-byte, generated-output, dynamic-import and review-receipt counterexamples; and writes the narrative plus `ScopedReviewReceipt`. Because this is the verifier's first subject, require all three independent assertions and unique labels:

```bash
REPORT="$SDD_TASK/task-0p-bootstrap-review.md"
RECEIPT="$SDD_TASK/task-0p-bootstrap-review.json"
test "$(rg -c '^Critical:' "$REPORT")" -eq 1
test "$(rg -c '^Important:' "$REPORT")" -eq 1
test "$(rg -c '^Verdict:' "$REPORT")" -eq 1
rg -qx 'Critical: 0' "$REPORT"
rg -qx 'Important: 0' "$REPORT"
rg -qx 'Verdict: PASS' "$REPORT"
node scripts/governance-organization-identity-bootstrap.mjs verify-review \
  --report "$REPORT" --receipt "$RECEIPT" \
  --subject "$BOOTSTRAP_CONTRACT_COMMIT"
```

The direct verifier invocation here is an independently checked bootstrap-of-trust diagnostic, not an authority claim; the three exact `rg` assertions remain the review authority. If review finds anything, fix only Task 0P files, commit `fix: address Task 0P scoped review`, rerun all Task 0P tests, update the exact subject/range and repeat independent review until PASS. Then return to Task 0L Steps 8–11 for separately authorized root materialization and its independent review. Task 0A is blocked on both final reviewed Task 0P and root materialization PASS.

### Task 0A: Minimal Current-Main Admission Validator, Generator, and Independent Review

**Files:**

- Create: `scripts/governance-organization-identity-current-main-admission.mjs`
- Create: `scripts/governance-organization-identity-current-main-admission.spec.mjs`
- Create local review output: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-admission-validator-review.md`
- Create local review receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-admission-validator-review.json`
- Test: `scripts/governance-organization-identity-current-main-admission.spec.mjs`
- Read-only: `.github/CODEOWNERS`, `scripts/copy-fixed-source-impact.mjs`, `scripts/copy-fixed-source-impact.spec.mjs`, `packages/db/prisma/migrations`, amended spec and amendment zero review.

**Interfaces:**

- Consumes: exact final spec commit/SHA-256; reviewed Task 0L launcher/root materialization and Task 0P bootstrap contract/review; fresh `BootstrapRunReceipt`; complete `CurrentMainAdmission`/`AuditReviewReceipt` contracts and command registry; local fixture Git repositories only.
- Produces: root-launcher-invoked `collectCurrentMainAuditFacts`, `validateCurrentMainAdmission`, `generateCurrentMainAdmission`, the two closed Copy command IDs, exact schema validation, one reviewed validator commit and closed scoped-review receipt. It does not produce the live admission JSON.

**Commit message:** `feat: validate organization identity current-main admission`

- [ ] **Step 1: Verify the execution state enabled by future exact plan approval**

Run only after this plan is independently reviewed, explicitly approved, and committed:

```bash
cd /global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v2
test "$(git branch --show-current)" = codex/pr407-organization-identity-caller-cutover-v2
git merge-base --is-ancestor b060c5dd4afef9fe42dfe510b02f930f56cdf7fe HEAD
test "$(git show b060c5dd4afef9fe42dfe510b02f930f56cdf7fe:docs/superpowers/specs/2026-09-01-organization-identity-writer-ban-at-source-design.md | sha256sum | cut -d' ' -f1)" = 536e376a40d9ef4f49a65bc0224b74d58eb8a2d743fa766aa020397e67279dd4
git ls-files --error-unmatch docs/superpowers/plans/2026-09-01-organization-identity-writer-ban-at-source.md
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

Expected: PASS only in the future committed execution state. The current drafting state intentionally fails the tracked-plan/clean checks and is not an implementation state.

- [ ] **Step 2: Verify the reviewed bootstrap and existing local review sink**

Run `git check-ignore -v .superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-admission-validator-review.md` as a diagnostic. Then dispatch canonical request `task-0a-bootstrap-review-verify.json` with `SCOPED_REVIEW_VERIFY_V1`, exact launcher/materialization/contract digests and a fresh Task 0A `BootstrapRunReceipt`. Task 0A cannot substitute a direct Node/package-script path for this authority check.

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

The reviewer fixes the exact validator commit, final spec hash, and changed two-file set; adds counterexamples for omitted NUL paths, rename/copy/case collision, generated citation drift, conflict hunk undercount, migration omission, owner ambiguity, free-form command injection, Artifact A byte drift, bootstrap bypass and redaction; then writes the exact narrative and `ScopedReviewReceipt` or returns to the fix loop.

- [ ] **Step 14: Freeze the review digest and stop before fetch/merge/scanner work**

```bash
VALIDATOR_REVIEW=.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-admission-validator-review.md
VALIDATOR_RECEIPT=.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-admission-validator-review.json
test -s "$VALIDATOR_REVIEW"
test "$(rg -c '^Critical:' "$VALIDATOR_REVIEW")" -eq 1
test "$(rg -c '^Important:' "$VALIDATOR_REVIEW")" -eq 1
test "$(rg -c '^Verdict:' "$VALIDATOR_REVIEW")" -eq 1
rg -qx 'Critical: 0' "$VALIDATOR_REVIEW"
rg -qx 'Important: 0' "$VALIDATOR_REVIEW"
rg -qx 'Verdict: PASS' "$VALIDATOR_REVIEW"
node scripts/governance-organization-identity-bootstrap.mjs verify-review \
  --report "$VALIDATOR_REVIEW" --receipt "$VALIDATOR_RECEIPT" \
  --subject "$(git rev-parse HEAD)"
git check-ignore -v "$VALIDATOR_REVIEW"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

The direct commands above are diagnostics. Authority requires canonical `task-0a-validator-review-verify.json` dispatched as `SCOPED_REVIEW_VERIFY_V1`, binding the same report/receipt/subject plus the current `BootstrapRunReceipt`. Expected: validator scoped review PASS with exact subject/range/digests. If it fails, fix Task 0A files, commit `fix: address Task 0A scoped review`, rerun RED/GREEN and repeat review. No fetch, ref update, merge, admission JSON, migration or scanner exists.

### Task 0B: Read-Only Live-Main Audit and Reviewed Authorization Packet

**Files:**

- Create local audit output: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-read-only-audit.json`
- Create local audit narrative: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-read-only-audit.md`
- Create local independent review: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-read-only-audit-review.md`
- Create local dedicated audit review receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-read-only-audit-review.json`
- Modify: none
- Test: `scripts/governance-organization-identity-current-main-admission.spec.mjs`
- Read-only: live `origin` main advertisement; cached refs/objects; exact branch; `.github/CODEOWNERS`; complete main-only path/migration sets; build/raw/schema/governance/runtime/caller/consumer/Identity authority source; no-write merge facts.

**Interfaces:**

- Consumes: exact reviewed Task 0A validator commit/report/receipt; accepted launcher/bootstrap contract; fresh Task 0B run receipt; branch pre-refresh SHA; live `ls-remote` SHA; locally available Git objects only.
- Produces: reviewed metadata-only audit packet with `PASS | HOLD | FETCH_AUTH_REQUIRED`, exact live-main/branch/merge-base/ranges/set digests/classifications/conflicts/owners/migrations/deltas, exact expected conflict paths/hunks/resolution rules, distinct fetch/local-merge authorization requests, and dedicated `AuditReviewReceipt` binding the packet/set/authorization digests. It writes no Git object/ref or tracked file.

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

Use the reviewed validator to collect `git diff --name-status -z --find-renames=100% --find-copies=100% --find-copies-harder` and `git diff --name-only -z --find-renames=100% --find-copies=100% --find-copies-harder` for `mergeBaseCommit..liveMainCommit`. The pinned 100% thresholds plus harder copy search make rename/copy classification deterministic. Reject every `R`/`C` status and case collision; hash sorted path-plus-NUL bytes; require count/digest/set agreement across both Git views.

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

The displayed direct Node command is the diagnostic expansion. Authority dispatches canonical request `task-0b-current-main-audit.json` as `CURRENT_MAIN_AUDIT_V1` with the fresh Task 0B run receipt. Render the companion narrative from that JSON only; it may include paths/enums/digests/counts but no diff hunk/source/SQL/secret text.

- [ ] **Step 10: Independently review and machine-gate the audit packet**

The reviewer recomputes live/cached/object/ancestry/path/conflict/owner/migration facts, challenges every `ADMIT_*` disposition, and verifies the packet is `PASS`, `FETCH_AUTH_REQUIRED`, or an honest `HOLD`. The dedicated `AuditReviewReceipt` binds `auditPacketSha256`, branch preimage, advertised live main, merge base, exact path/conflict/migration/disposition set digests, authorization-request digest, optional fetch-receipt digest, report/counterexample digests and zero findings. Null set digests are permitted only for `FETCH_AUTH_REQUIRED` before the object exists. Run unique exact severity/verdict assertions and authority request `task-0b-audit-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1`; a `FETCH_AUTH_REQUIRED` packet can have a PASS review without pretending the full audit passed.

```bash
AUDIT_REVIEW=.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-read-only-audit-review.md
AUDIT_REVIEW_RECEIPT=.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-read-only-audit-review.json
test "$(rg -c '^Critical:' "$AUDIT_REVIEW")" -eq 1
test "$(rg -c '^Important:' "$AUDIT_REVIEW")" -eq 1
test "$(rg -c '^Verdict:' "$AUDIT_REVIEW")" -eq 1
rg -qx 'Critical: 0' "$AUDIT_REVIEW"
rg -qx 'Important: 0' "$AUDIT_REVIEW"
rg -qx 'Verdict: PASS' "$AUDIT_REVIEW"
node scripts/governance-organization-identity-bootstrap.mjs verify-review \
  --report "$AUDIT_REVIEW" --receipt "$AUDIT_REVIEW_RECEIPT" \
  --subject "$BRANCH_PRE_REFRESH_COMMIT"
```

The direct verifier line is diagnostic only. The root-launcher receipt is the gate, and its output digest must equal the dedicated `AuditReviewReceipt` before routing status.

- [ ] **Step 11: Route by the closed audit status**

If status is `FETCH_AUTH_REQUIRED`, proceed only to Task 0F after its separate exact fetch authorization. Task 0F must return to the beginning of Task 0B; this packet cannot authorize merge. If status is `HOLD`, stop for the stated design/ownership fact. Only a fresh complete Task 0B packet with status `PASS` plus exact matching `AuditReviewReceipt` may support a distinct authorization request for Task 0C's normal two-parent merge, exact reviewed resolutions, admission child and post-refresh verification/review.

### Task 0F: Fetch-Only Interstitial and Mandatory Full Audit Return

**Files:**

- Create local fetch receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-fetch-only-receipt.json`
- Create local review narrative: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-fetch-only-review.md`
- Create local review receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-fetch-only-review.json`
- Modify: none
- Test: exact Git object presence and unchanged branch/ref/worktree facts.

**Interfaces:**

- Consumes: independently reviewed Task 0B packet with status exactly `FETCH_AUTH_REQUIRED`; exact fetch authorization naming `origin`, `refs/heads/main`, and advertised 40-hex SHA.
- Produces: exact object available locally, metadata-only fetch receipt and independent review; no branch/tracking ref update, merge, admission or merge authorization. Its sole successor is a complete Task 0B rerun.

**Commit message:** none; fetch-only evidence never moves the branch.

- [ ] **Step 1: Reproduce the object-absence RED and verify review/auth subjects**

```bash
git cat-file -e "$LIVE_MAIN_COMMIT^{commit}"
```

Expected: RED with missing object. Verify Task 0B packet status is exactly `FETCH_AUTH_REQUIRED`, its review receipt PASSes, advertised remote/ref/SHA match the exact fetch authorization, and current branch/status/cached tracking refs still match the packet.

- [ ] **Step 2: Verify pinned-Git capabilities and perform only the exact authorized fetch**

The accepted Git executable/version/closure must prove support for `--no-auto-maintenance` and `--no-write-commit-graph` from its exact help/behavior fixture. Missing either option is `FETCH_CLIENT_CAPABILITY_HOLD`; do not substitute another Git or relax the flags.

```bash
git fetch --no-tags --no-write-fetch-head --no-auto-maintenance \
  --no-write-commit-graph origin "$LIVE_MAIN_COMMIT"
```

The displayed Git command is the closed expansion. Authority dispatches canonical request `task-0f-fetch-object.json` as `GIT_FETCH_OBJECT_V1` with the reviewed `FETCH_AUTH_REQUIRED` packet/receipt and exact authorization. No refspec, tracking-ref update, merge, checkout, reset, rebase, commit, auto-maintenance, commit-graph write or additional object request is authorized.

- [ ] **Step 3: Verify object identity and absence of merge/ref effects**

```bash
test "$(git cat-file -t "$LIVE_MAIN_COMMIT")" = commit
test "$(git rev-parse HEAD)" = "$BRANCH_PRE_REFRESH_COMMIT"
test "$(git rev-parse refs/remotes/origin/main)" = "$CACHED_MAIN_COMMIT"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

Write a closed receipt containing remote/ref/SHA, before/after branch/cached-ref identities, object type, authorization digest, zero merge/ref changes and no source bytes.

- [ ] **Step 4: Independently review the fetch-only receipt**

Use unique exact severity/verdict assertions plus canonical request `task-0f-fetch-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1`. The direct command below is diagnostic only. A finding repeats only Task 0F under a new exact authorization if network action must recur; it never upgrades the old Task 0B packet.

```bash
node scripts/governance-organization-identity-bootstrap.mjs verify-review \
  --report .superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-fetch-only-review.md \
  --receipt .superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-fetch-only-review.json \
  --subject "$BRANCH_PRE_REFRESH_COMMIT"
```

- [ ] **Step 5: Return to Task 0B from Step 1**

Repeat every live-protection, cached/object, ancestry, `--find-renames=100% --find-copies=100% --find-copies-harder`, no-write merge, owner, migration, build/raw/schema/caller, packet and independent-review step. The new dedicated `AuditReviewReceipt.fetchReceiptSha256` must equal Task 0F's reviewed receipt digest. Only the resulting new Task 0B `PASS` packet/receipt can be used to request Task 0C authorization.

### Task 0C: Separately Authorized Two-Parent Refresh Merge, Admission Commit, and Refresh Review

**Files:**

- Create on the first refresh, or Modify on a pre-acceptance refresh repeat: `docs/governance/organization-identity-current-main-admission.json`
- Create local independent review: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-refresh-review.md`
- Create local review receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-refresh-review.json`
- Modify through exact Git merge only: the complete machine-recorded main-only/result path set from Task 0B
- Modify if and only if present in the reviewed conflict set: `docs/evidence/site-builder/copy-runtime-eligibility.json`
- Modify if and only if present in the reviewed conflict set: `docs/implementation-records/copy-fixed-source-impact-governance.md`
- Test: admission validator/spec; exact merge parent/path/conflict facts; complete migration/static/API/build/raw/schema/governance/docs/Gitleaks/ContractGraph packet.

**Interfaces:**

- Consumes: reviewed root launcher/materialization and Task 0P bootstrap contract; fresh Task 0C run receipt; final Task 0B packet with status exactly PASS and exact `AuditReviewReceipt`; already-local exact live-main object; separately authorized local merge/admission commits; closed Copy command IDs.
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

- [ ] **Step 2: Verify exact local-merge authorization, 0B PASS and live main**

Require a fresh complete Task 0B PASS packet plus dedicated `AuditReviewReceipt` and the distinct local merge/admission authorization. Re-run `git ls-remote --refs origin refs/heads/main`; it must equal Task 0B's admitted SHA. Immediately before the merge request, `CURRENT_MAIN_VALIDATE_V1` recomputes the canonical audit-packet SHA and exact branch/live-main/path/conflict/migration/disposition/authorization-request digests and requires equality with the receipt. The authorization itself names both packet and receipt SHA-256. Any drift returns to Task 0B and invalidates the merge authorization request; there is no mutable ignored-packet gap.

- [ ] **Step 3: Prove the object is already local and perform no fetch**

```bash
git cat-file -e "$LIVE_MAIN_COMMIT^{commit}"
test "$(jq -er '.status' .superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-read-only-audit.json)" = PASS
```

Expected: PASS. If absent, return to the reviewed `FETCH_AUTH_REQUIRED → 0F → full 0B rerun` cycle. Task 0C contains no fetch path.

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

The direct Git line is the closed expansion. Authority dispatches `task-0c-refresh-merge.json` as `GIT_REFRESH_MERGE_V1`; the launcher rechecks the packet/receipt digests in the same process immediately before Git. Do not use rebase, squash, force, auto-stash, or blanket `ours/theirs`. Compare actual conflicts/hunk counts/blob triplets to the reviewed Task 0B packet before editing any conflict. Unexpected facts stop the merge; preserve diagnostics and use only the explicitly authorized abort/recovery boundary.

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

If the reviewed disposition is `ADMIT_GENERATED_MAIN_BYTES`, validate those bytes and retain them. If it is `ADMIT_GENERATED_REBUILT`, the root launcher dispatches `COPY_WRITE_ELIGIBILITY_V1` and `COPY_SYNC_CITATIONS_V1` in that exact order. `SYNC_HUMAN_CITATIONS` always reads back the eligibility output/digest even when citation sync is the only conflict disposition. The block below is diagnostic pseudocode for that closed expansion; current-shell `jq`/Node cannot authorize the resolution:

```bash
if jq -e '.conflicts | any(.resolutionSource == "COPY_FIXED_SOURCE_WRITE_ELIGIBILITY_V1")' "$AUDIT" >/dev/null; then
  node scripts/copy-fixed-source-impact.mjs --write-eligibility
fi
if jq -e '.conflicts | any(.resolutionSource == "COPY_FIXED_SOURCE_SYNC_HUMAN_CITATIONS_V1")' "$AUDIT" >/dev/null; then
  node scripts/governance-organization-identity-current-main-admission.mjs \
    verify-copy-eligibility-input \
    --audit "$AUDIT" \
    --eligibility docs/evidence/site-builder/copy-runtime-eligibility.json
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

Authority dispatches canonical request `task-0c-refresh-merge-commit.json` as `GIT_REFRESH_MERGE_V1`; it permits exactly the fixed commit message and verifies the staged result set before writing the commit. The direct Git lines below are diagnostic readback.

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

Immediately rehash the audit packet and dedicated audit receipt. Authority dispatches `task-0c-admission-generate.json` as `CURRENT_MAIN_GENERATE_V1`, then `task-0c-admission-validate.json` as `CURRENT_MAIN_VALIDATE_V1`. The generator embeds `auditPacketSha256`, `auditReviewReceiptSha256` and report digest; it cannot bind a changed ignored packet.

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

Authority dispatches `task-0c-admission-commit.json` as `GIT_ADMISSION_COMMIT_V1`; it accepts only first-add or exact successor modification of the one admission path and the fixed message. The direct Git block is diagnostic parent/path readback.

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

Create fresh canonical requests for `CURRENT_MAIN_VALIDATE_V1`, `REFRESH_VERIFY_V1`, `PRISMA_GENERATE_V1`, `API_VERIFY_V1`, `GOVERNANCE_VERIFY_V1`, `DOCS_VERIFY_V1`, `GITLEAKS_VERIFY_V1`, and `CONTRACT_GRAPH_VERIFY_V1`, all binding `CURRENT_MAIN_ADMISSION_COMMIT`, the same `BootstrapContract`, a fresh Task 0C `BootstrapRunReceipt`, audit receipt and refresh pair. The command block below lists their closed internal expansions and diagnostic status checks; direct execution is not authority.

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

The reviewer fixes and recomputes the exact range `B0_REFRESH_BASE_COMMIT..CURRENT_MAIN_ADMISSION_COMMIT`, proves `REFRESH_MERGE_COMMIT == B0_REFRESH_BASE_COMMIT`, verifies the admission child has one parent and only the exact admission JSON delta, recomputes ordered merge parents, path/result blobs, all three Copy resolution branches, complete admission sets, every migration/Artifact A disposition, build/raw/schema/caller deltas, bootstrap receipts, Gitleaks, governance/docs, API/build/tests, and exact ContractGraph. The post-refresh review digest is local ignored evidence and is not written back into the admission JSON; later B0 acceptance binds it separately.

- [ ] **Step 13: Freeze the reviewed refresh/admission chain and open the scanner gate**

```bash
REFRESH_REVIEW=.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-refresh-review.md
REFRESH_RECEIPT=.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-refresh-review.json
test -s "$REFRESH_REVIEW"
test "$(rg -c '^Critical:' "$REFRESH_REVIEW")" -eq 1
test "$(rg -c '^Important:' "$REFRESH_REVIEW")" -eq 1
test "$(rg -c '^Verdict:' "$REFRESH_REVIEW")" -eq 1
rg -qx 'Critical: 0' "$REFRESH_REVIEW"
rg -qx 'Important: 0' "$REFRESH_REVIEW"
rg -qx 'Verdict: PASS' "$REFRESH_REVIEW"
node scripts/governance-organization-identity-bootstrap.mjs verify-review \
  --report "$REFRESH_REVIEW" --receipt "$REFRESH_RECEIPT" \
  --subject "$CURRENT_MAIN_ADMISSION_COMMIT"
test "$(git rev-parse HEAD)" = "$CURRENT_MAIN_ADMISSION_COMMIT"
test "$(git rev-parse "$CURRENT_MAIN_ADMISSION_COMMIT^")" = "$B0_REFRESH_BASE_COMMIT"
test "$REFRESH_MERGE_COMMIT" = "$B0_REFRESH_BASE_COMMIT"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

The direct review command is diagnostic; authority dispatches `task-0c-refresh-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1`. Expected: reviewed two-commit refresh/admission chain fixed. A finding in the merge result, either ordered parent, admission JSON/shape, or their review never produces a fix commit atop `CURRENT_MAIN_ADMISSION_COMMIT`: preserve and abandon both commits, return to the exact `BRANCH_PRE_REFRESH_COMMIT`, rerun full Task 0B for a fresh PASS packet/`AuditReviewReceipt`, obtain a new exact local-merge authorization, and recreate a new two-parent refresh merge plus one-parent admission child; then review the new exact pair. No amend, revert-as-substitute or forward admission fix is allowed. Task 0M—not Task 1—is the only successor. No push/PR/remote merge/root/v3 action is implied.

### Task 0M: Sole C-TX Compatibility Migration, Static/Disposable Proof, and DB/Security Reviews

**Files:**

- Create: `packages/db/prisma/migrations/20260902090000_organization_identity_materialization_outcome_compat/migration.sql`
- Create: `packages/db/test/organization-identity-materialization-outcome-compat.spec.mjs`
- Create: `packages/db/test/organization-identity-materialization-outcome-compat.disposable.spec.mjs`
- Create local static/code review: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-0m-static-review.md`
- Create local DB review: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-0m-database-review.md`
- Create local security review: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-0m-security-review.md`
- Create local scoped receipts: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-0m-static-review.json`, `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-0m-database-review.json`, `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-0m-security-review.json`
- Create local disposable receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-0m-disposable-receipt.json`
- Test read-only preimage: exact `20260830130300`, `20260830130400`, `20260830130600` migration bytes and refreshed migration directory.
- Test: both new 0M test files plus existing migration/static suites.

**Interfaces:**

- Consumes: reviewed `B0_REFRESH_BASE_COMMIT`/`CURRENT_MAIN_ADMISSION_COMMIT`, final Task 0C review, root launcher/materialization, immutable Task 0P bootstrap contract and fresh Task 0M run receipts, exact source digests `f5692086…`, `b7706a19…`, `0695319e…`, old CHECK segment `b25fb488…`, expanded segment `128db73c…`, and separate migration-file/disposable authorizations.
- Produces: sole DDL-only migration; exact `MaterializationOutcomeCompatCatalogReceipt`; `B0M_MIGRATION_COMMIT`; static/code, DB and security scoped-review receipts; authorized PostgreSQL 16 disposable receipt; zero Prisma schema/DML/retained application.

**Commit message:** `fix: admit organization identity outcomes in materialization`

- [ ] **Step 1: Obtain and verify the separate migration-file authorization**

The authorization names the exact migration path/timestamp, allowed two-literal CHECK expansion, static/disposable test paths and no-DB boundary. It does not authorize disposable PostgreSQL, retained application, deployment, `migrate resolve`, scanner work or another migration.

- [ ] **Step 2: Verify name/timestamp/preimage absence under the clean bootstrap**

Dispatch `task-0m-preimage-verify.json` as `MIGRATION_STATIC_VERIFY_V1`. Require current-main admission to prove `20260902090000_organization_identity_materialization_outcome_compat` absent and strictly later than the exact refreshed maximum. Verify `packages/db/prisma/schema.prisma` and all existing migration blobs clean. A drifted name/maximum/preimage stops for spec amendment rather than renaming.

- [ ] **Step 3: Write the static RED contract**

Tests fix the exact source/catalog/function/trigger/ACL digests, old and expanded CHECK segment digests, one transaction, first executable timeout ordering, exact temporary name and UTF-8 byte count, `NOT VALID → VALIDATE → DROP old RESTRICT → RENAME`, no DML/schema/function/trigger/ACL/ledger manipulation, and exact migration-directory delta of one.

```js
test("temporary constraint is exactly 58 UTF-8 bytes", () => {
  assert.equal(
    Buffer.byteLength(
      "discovery_company_materialization_outcome_artifact_b_check",
      "utf8",
    ),
    58,
  );
});
```

- [ ] **Step 4: Run RED**

```bash
node --test packages/db/test/organization-identity-materialization-outcome-compat.spec.mjs
```

Expected: diagnostic RED because the migration and static authority implementation do not exist. The review receipt records this expected direct-development failure; it is not an authority PASS.

- [ ] **Step 5: Implement the exact single-transaction migration**

The static test extracts the accepted old balanced CHECK segment and constructs the only allowed expanded segment mechanically before any migration implementation:

```js
const expanded = oldSegment
  .replace(
    "match_rule IN ('domain_exact','identifier_exact','name_country')",
    "match_rule IN ('domain_exact','identifier_exact','name_country','identity_v2')",
  )
  .replace(
    "'MISSING_NAME','NON_PRODUCT_PROVENANCE','COMPANY_IDENTITY_INVALID'",
    "'MISSING_NAME','NON_PRODUCT_PROVENANCE','COMPANY_IDENTITY_INVALID','IDENTITY_CONFLICT'",
  );
assert.equal(sha256(oldSegment), OLD_CHECK_SHA256);
assert.equal(sha256(expanded), EXPANDED_CHECK_SHA256);
```

The migration then places that complete expanded segment after the exact preflight and executes the fixed `ADD ... NOT VALID`, `VALIDATE`, `DROP ... RESTRICT`, `RENAME`, `COMMIT` order. The preflight source explicitly parses `current_setting('lock_timeout')` and `current_setting('statement_timeout')`, enforces `0 < lock <= 5000`, `0 < statement <= 60000`, `lock < statement`, verifies `SHOW max_identifier_length >= 63`, closed catalog/dependency/function/trigger/ACL preimage and temporary-name absence before the first table/catalog lock. Static tests reject any omitted clause or third predicate change.

- [ ] **Step 6: Implement the closed catalog/dependency/function/trigger receipt tests**

Bind schema/table/owner/relkind/partition/inheritance, old/temp/final constraint names and flags, normalized PostgreSQL 16 `pg_get_constraintdef` digest, exact sorted `pg_depend` records, validator trigger/function owners/security/volatility/search-path/ACL/definitions, one final name/zero temp names, and row count/size as non-authority observations. Any drift raises one fixed no-echo error before DDL.

- [ ] **Step 7: Implement static fault-transform and Prisma-ledger test code**

The disposable test derives test-only direct-`psql` transforms from exact reviewed migration bytes after four closed markers: add, validate, old drop and before rename. It separately defines successful Prisma fresh/full-chain, exact refreshed upgrade, checksum/finished ledger row and second-deploy scenarios. Direct fault transforms never call Prisma and prove `_prisma_migrations` unchanged; successful Prisma deploy proves ledger correctness. Failed retained deploy recovery remains `HOLD / NOT_VERIFIED` and no test calls `migrate resolve`.

- [ ] **Step 8: Run static GREEN and prove zero forbidden deltas**

```bash
node --test \
  packages/db/test/organization-identity-materialization-outcome-compat.spec.mjs \
  packages/db/test/organization-identity-v2-resolver-command.spec.mjs \
  packages/db/test/pinned-prisma-migration-stage.spec.mjs
git diff --exit-code -- packages/db/prisma/schema.prisma
```

The direct block is diagnostic. Authority dispatches `task-0m-static-verify.json` as `MIGRATION_STATIC_VERIFY_V1` with a fresh run receipt. Expected: PASS; migration directory delta is exactly the one 0M path, production SQL has no DML or Prisma-ledger manipulation.

- [ ] **Step 9: Commit migration plus static/disposable test code**

```bash
git add \
  packages/db/prisma/migrations/20260902090000_organization_identity_materialization_outcome_compat/migration.sql \
  packages/db/test/organization-identity-materialization-outcome-compat.spec.mjs \
  packages/db/test/organization-identity-materialization-outcome-compat.disposable.spec.mjs
git commit -m "fix: admit organization identity outcomes in materialization"
B0M_MIGRATION_COMMIT="$(git rev-parse HEAD)"
```

- [ ] **Step 10: Run independent static/code review and fix loop**

Review exact migration/test range, predicate delta, 58-byte name, timeout and retained `ACCESS EXCLUSIVE` lock chronology, no-DML/schema/authority scope and test separation. Machine-gate its narrative/receipt with canonical request `task-0m-static-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1`. Findings produce a forward fix commit limited to 0M files, full static rerun and new review subject; never amend an already reviewed migration commit.

- [ ] **Step 11: Request the separate disposable PostgreSQL authorization**

Present exact B0M subject, PostgreSQL 16 image digest, loopback/no-egress topology, unique resource labels, migration list, time/space caps, synthetic IDs/data, direct-psql fault transforms, Prisma commands and exact cleanup. Without authorization, 0M remains HOLD and Task 1 cannot start.

- [ ] **Step 12: Run authorized disposable fresh/upgrade/lock/fault/ledger proof**

```bash
ORGANIZATION_IDENTITY_MATERIALIZATION_COMPAT_DISPOSABLE=1 \
  node --test packages/db/test/organization-identity-materialization-outcome-compat.disposable.spec.mjs
```

The direct block is diagnostic documentation. After the separate disposable authorization, authority dispatches `task-0m-disposable-verify.json` as `MIGRATION_DISPOSABLE_VERIFY_V1`, with the exact image/topology/resource/time cap and fresh run receipt. Require old values and new values only in correct outcome shapes; wrong combinations fail; connection A/B lock contention hits bounded timeout and complete rollback; AX lock is observed after ADD through validation; all direct fault transforms restore exact preimage and unchanged ledger; Prisma fresh/upgrade catalog match, checksum/finished row is exact, and second deploy reports no pending migrations. Cleanup proves only task-created resources are gone.

- [ ] **Step 13: Run independent DB and security reviews**

Each review fixes the final B0M subject, bootstrap contract/fresh-run receipt and disposable receipt, adds independent catalog/timeout/dependency/ledger/cross-shape counterexamples, and produces its own machine-gated `ScopedReviewReceipt`. Both must have unique exact zero-C/I/PASS fields and pass `SCOPED_REVIEW_VERIFY_V1`. Retained apply/timing/maintenance/recovery stays explicit HOLD.

- [ ] **Step 14: Freeze 0M and open the scanner gate**

Dispatch three canonical `SCOPED_REVIEW_VERIFY_V1` requests for static, DB and security receipts; rerun `MIGRATION_STATIC_VERIFY_V1`; recompute migration SHA/last-change; verify complete refreshed-directory-plus-one-delta inventory and clean status. The direct loop below is diagnostic only. Any review fix repeats static/disposable proof as affected. Only the final reviewed `B0M_MIGRATION_COMMIT` and receipts may be consumed by Task 1.

```bash
for kind in static database security; do
  node scripts/governance-organization-identity-bootstrap.mjs verify-review \
    --report ".superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-0m-$kind-review.md" \
    --receipt ".superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-0m-$kind-review.json" \
    --subject "$B0M_MIGRATION_COMMIT"
done
```

### Task 1: B0 Refreshed Preflight, Closed Scanner Contracts, and Build-Surface RED

**Files:**

- Create: `scripts/governance-organization-identity-writers-contracts.mjs`
- Create: `scripts/governance-organization-identity-writers-files.mjs`
- Create: `scripts/governance-organization-identity-writers.mjs`
- Create: `scripts/governance-organization-identity-writers.spec.mjs`
- Create local scoped review: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-1-scanner-contract-review.md`
- Create local review receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-1-scanner-contract-review.json`
- Test: `scripts/governance-organization-identity-writers.spec.mjs`
- Read-only: bootstrap/0M receipts; `docs/governance/organization-identity-current-main-admission.json`; final spec; `tsconfig.base.json`, API tsconfigs/Nest/package, root package/workspace/lock, `.dockerignore`, absence sentinels, Docker/runtime inputs, TypeScript/Prisma declaration/tool roots, native extractor.

**Interfaces:**

- Consumes: separately authorized scanner start at final reviewed `B0M_MIGRATION_COMMIT`; reviewed `CURRENT_MAIN_ADMISSION_COMMIT`/two-parent `B0_REFRESH_BASE_COMMIT`; accepted launcher/root materialization and immutable Task 0P `BootstrapContract`; fresh Task 1 `BootstrapRunReceipt`; 0M review/disposable receipts; final spec; Artifact A authority; complete build/dependency/tool closure.
- Produces: scanner contracts, source views, bootstrap-contract/fresh-run verification, `canonicalJson`, `verifyBuildSurface`, root-launcher-only authority CLI shell, and independently reviewed Task 1 commit.

**Commit message:** `test: define organization identity scanner contracts`

- [ ] **Step 1: Re-run the refreshed-base, admission, live-main, and ownership preflight**

The root controller dispatches canonical `task-1-preflight.json` as `CURRENT_MAIN_VALIDATE_V1` and binds the exact launcher/materialization/bootstrap contract, a fresh Task 1 run receipt and the listed Git subjects. The block below is diagnostic readback only:

```bash
cd /global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v2
pnpm --silent worktree:inventory | jq '.worktrees[] | select(.path == "/global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v2")'
test "$(git branch --show-current)" = "codex/pr407-organization-identity-caller-cutover-v2"
ADMISSION=docs/governance/organization-identity-current-main-admission.json
test "$(jq -er '.status' "$ADMISSION")" = ADMITTED
B0M_MIGRATION_COMMIT="$(git rev-parse HEAD)"
CURRENT_MAIN_ADMISSION_COMMIT="$(git log -1 --format=%H -- docs/governance/organization-identity-current-main-admission.json)"
B0_REFRESH_BASE_COMMIT="$(jq -er '.refreshMergeCommit' "$ADMISSION")"
REFRESH_MERGE_COMMIT="$B0_REFRESH_BASE_COMMIT"
BRANCH_PRE_REFRESH_COMMIT="$(jq -er '.branchPreRefreshCommit' "$ADMISSION")"
ADMITTED_LIVE_MAIN_COMMIT="$(jq -er '.liveMainCommit' "$ADMISSION")"
git merge-base --is-ancestor "$CURRENT_MAIN_ADMISSION_COMMIT" "$B0M_MIGRATION_COMMIT"
test "$(git rev-list --parents -n 1 "$CURRENT_MAIN_ADMISSION_COMMIT" | awk '{print NF}')" -eq 2
test "$(git rev-parse "$CURRENT_MAIN_ADMISSION_COMMIT^")" = "$B0_REFRESH_BASE_COMMIT"
test "$REFRESH_MERGE_COMMIT" = "$B0_REFRESH_BASE_COMMIT"
test "$(git rev-list --parents -n 1 "$B0_REFRESH_BASE_COMMIT" | awk '{print NF}')" -eq 3
test "$(git rev-parse "$B0_REFRESH_BASE_COMMIT^1")" = "$BRANCH_PRE_REFRESH_COMMIT"
test "$(git rev-parse "$B0_REFRESH_BASE_COMMIT^2")" = "$ADMITTED_LIVE_MAIN_COMMIT"
git merge-base --is-ancestor b060c5dd4afef9fe42dfe510b02f930f56cdf7fe "$B0_REFRESH_BASE_COMMIT"
git merge-base --is-ancestor 2400bac28796bae44294114edc99eaccb1bd65b3 "$B0_REFRESH_BASE_COMMIT"
test "$(git show b060c5dd4afef9fe42dfe510b02f930f56cdf7fe:docs/superpowers/specs/2026-09-01-organization-identity-writer-ban-at-source-design.md | sha256sum | cut -d' ' -f1)" = "536e376a40d9ef4f49a65bc0224b74d58eb8a2d743fa766aa020397e67279dd4"
git merge-base --is-ancestor \
  "$(git log -1 --format=%H -- packages/db/prisma/migrations/20260902090000_organization_identity_materialization_outcome_compat/migration.sql)" \
  "$B0M_MIGRATION_COMMIT"
test "$(git ls-remote --exit-code --refs origin refs/heads/main | cut -f1)" = "$ADMITTED_LIVE_MAIN_COMMIT"
node scripts/governance-organization-identity-current-main-admission.mjs validate --input "$ADMISSION"
git ls-files --error-unmatch docs/superpowers/plans/2026-09-01-organization-identity-writer-ban-at-source.md
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

Expected: execution HEAD is the final reviewed `B0M_MIGRATION_COMMIT`, which descends from one-parent `CURRENT_MAIN_ADMISSION_COMMIT`; its parent chain contains exact two-parent `B0_REFRESH_BASE_COMMIT`. Admission, final spec, Artifact A, live-main and 0M review/disposable gates all pass. Product build/raw reads remain fixed to refresh; migration authority adds exactly 0M.

- [ ] **Step 2: Materialize/install/generate only through the reviewed clean bootstrap**

Dispatch canonical `task-1-bootstrap-authority-run.json` as `BOOTSTRAP_AUTHORITY_RUN_V1`. The root wrapper—not the current shell—invokes `/usr/bin/env -i`; its environment includes exact `NPM_CONFIG_USERCONFIG=/dev/null`, and the Node executable is the pinned absolute path from `LauncherContract`/`LauncherMaterializationReceipt`, never a hard-coded `/usr/bin/node`. The request produces a fresh `BootstrapRunReceipt` for exact subject `B0M_MIGRATION_COMMIT`, then `task-1-prisma-generate.json` as `PRISMA_GENERATE_V1`. The internal expansion is:

```bash
/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher/identity-writer-launch \
  --request /global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/requests/task-1-bootstrap-authority-run.json
git diff --exit-code -- pnpm-lock.yaml packages/db/prisma/schema.prisma
```

Expected: exact pnpm `--ignore-scripts --ignore-pnpmfile` install with `NPM_CONFIG_USERCONFIG=/dev/null` and Prisma generation succeed inside fixed roots; bootstrap rehash/tool/declaration/generated-delegate receipts PASS; hostile markers remain zero; contract invariants match and only normalized fresh-run fields differ; lockfile/schema remain unchanged. The direct Git diff is a diagnostic whose result digest is also recorded by the launcher.

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

From exact `B0_REFRESH_BASE_COMMIT`, close the full config/build chain: both API tsconfigs, every `extends` target, `tsconfig.base.json`, `apps/api/nest-cli.json`, root/API/DB package files, workspace/lock, Dockerfile/`.dockerignore`, runtime scripts, absence sentinels/patch/hook/config paths and native extractor. Verify accepted bootstrap/declaration/tool/generated roots by exact logical package/version/realpath/file-set/content/TOCTOU digests before TypeScript dynamic import. Any missing/extra loaded declaration/tool byte is drift.

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

- [ ] **Step 10: Run Task 1 independent scoped review/fix loop**

Review complete build/bootstrap closure, launcher/materialization identities, immutable contract and fresh-run normalization, absence sentinels, clean install/generate order, source views, closed output and tests. Machine-gate the exact report/receipt with canonical `task-1-scanner-contract-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1`. Findings produce a Task 1-only fix commit, complete clean-bootstrap/test rerun and new review subject. Task 2 is blocked until PASS.

### Task 2: TypeScript Delegate and Capability-Boundary Engine

**Files:**

- Create: `scripts/governance-organization-identity-writers-typescript.mjs`
- Modify: `scripts/governance-organization-identity-writers.spec.mjs`
- Create local scoped review: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-2-delegate-review.md`
- Create local review receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-2-delegate-review.json`
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

Expected: diagnostic FAIL because `scanIdentityLinkDelegates` is absent; retain the expected RED receipt. It is not an authority PASS.

- [ ] **Step 4: Build one TypeScript Program and checker**

Use the exact parsed `apps/api/tsconfig.build.json`, the admitted `SourceView`, and installed dependency declarations. A custom `CompilerHost` reads repository source from the chosen current/Git view and dependency `.d.ts` from the pinned local package graph. Reject diagnostics instead of scanning a partial Program.

```js
export function createTypeScriptProject({
  typescript: ts,
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

`typescript` is the exact module dynamically imported and verified by Task 0P bootstrap; this module and the scanner CLI have no static top-level TypeScript import on an authority entry path.

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

Dispatch canonical `task-2-scanner-test.json` as `SCANNER_TEST_V1` with the immutable contract and a fresh Task 2 run receipt. The direct block is diagnostic expansion:

```bash
node --test --test-name-pattern='delegate|capability boundary|ManyAndReturn|generated parity|exact three' scripts/governance-organization-identity-writers.spec.mjs
git diff --check
git add scripts/governance-organization-identity-writers-typescript.mjs \
  scripts/governance-organization-identity-writers.spec.mjs
git commit -m "feat: detect identity delegate capability escapes"
```

- [ ] **Step 10: Run Task 2 independent scoped review/fix loop**

Review generated/native parity, all eight reads/nine writes, ManyAndReturn, dynamic models and every capability escape. Gate canonical `task-2-delegate-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1`. Findings create a Task 2-only fix commit, focused/full rerun and new review. Task 3/4 integration is blocked until PASS.

### Task 3: Raw Capability, Wrapper Ingress, and Full Dependency Closure Engine

**Files:**

- Modify: `scripts/governance-organization-identity-writers-typescript.mjs`
- Modify: `scripts/governance-organization-identity-writers-contracts.mjs`
- Modify: `scripts/governance-organization-identity-writers.spec.mjs`
- Create local scoped review: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-3-raw-closure-review.md`
- Create local review receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-3-raw-closure-review.json`
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

Expected: diagnostic FAIL because raw capability scanning and closure commitments are not implemented; retain the expected RED receipt. It is not an authority PASS.

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

Dispatch canonical `task-3-scanner-test.json` as `SCANNER_TEST_V1` with the immutable contract and a fresh Task 3 run receipt. The direct block is diagnostic expansion:

```bash
node --test --test-name-pattern='raw capability|wrapper ingress|dependency closure|interpolation|literal mention|budget|cycle' scripts/governance-organization-identity-writers.spec.mjs
git diff --check
git add scripts/governance-organization-identity-writers-contracts.mjs \
  scripts/governance-organization-identity-writers-typescript.mjs \
  scripts/governance-organization-identity-writers.spec.mjs
git commit -m "feat: freeze raw database capability closure"
```

- [ ] **Step 11: Run Task 3 independent scoped review/fix loop**

Review all raw forms, interpolation classifier, cross-file wrappers/ingress, full executable preimage, literal detector and non-resetting budgets/cycles. Gate canonical `task-3-raw-closure-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1`. Findings create Task 3-only fixes and complete reruns; Task 4 is blocked until PASS.

### Task 4: Stage Machine, Accepted-Blob Checks, Redaction, and Filesystem Hardening

**Files:**

- Modify: `scripts/governance-organization-identity-writers-contracts.mjs`
- Modify: `scripts/governance-organization-identity-writers-files.mjs`
- Modify: `scripts/governance-organization-identity-writers.mjs`
- Modify: `scripts/governance-organization-identity-writers.spec.mjs`
- Create local scoped review: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-4-stage-security-review.md`
- Create local review receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-4-stage-security-review.json`
- Test: `scripts/governance-organization-identity-writers.spec.mjs`

**Interfaces:**

- Consumes: exact two-parent `B0_REFRESH_BASE_COMMIT`, its one-parent `CURRENT_MAIN_ADMISSION_COMMIT`, Task 0B+0C review identities, Task 2/3 final inventories, separate Artifact A authority contracts, future B0 acceptance Git-object shape fixtures, immutable bootstrap contract/fresh Task 4 run receipt, and optional external-anchor fixtures. It consumes no generated B0 baseline or stage file.
- Produces: final scanner/stage/derivation blobs and `verifyStage`, `verifyZero`, `verifyAcceptanceShape`, `loadExternalAnchor`, mandatory current-main admission revalidation, exact `3 → 2 → 1 → 0` expected-set evaluation, stable exits 0/1/2. Task 5 is the first task that generates/reviews real baseline/stage records from these final blobs.

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

At B0 before Task 5 generation, first validate `organization-identity-current-main-admission.json`, exact refresh/admitted-main/ordered local-merge parents, and Task 0C review digest; use literal immutable fixtures for `B0_BASELINE` and exact-three writers rather than a generated baseline. Once Task 5 supplies a baseline, the same API compares it to a freshly derived exact inventory. Once an acceptance file exists, validate its one-parent/one-path first-add shape and resolve every controlled blob from its named implementation parent. At B1–B6, read the externally fixed acceptance object with `git show`, not working-tree bytes, and load the stage map only from that object.

- [ ] **Step 7: Implement current and Artifact A re-derivation**

Implement accepted-blob derivation for scanner/helper/test/build/migration/admission/native-extractor bytes and later baseline inputs, then scan current source and a virtual Program from exact `B0_REFRESH_BASE_COMMIT`; separately re-derive Artifact A resolver/function/ACL authority from `2400bac28796bae44294114edc99eaccb1bd65b3`. Before Task 5, tests use immutable negative/positive fixtures rather than generated records. Allow only expected writer removals; raw additions, removals outside accepted disposition, closure/ingress/hash drift, refreshed migration/admission drift, Artifact A authority drift, or controlled manifest edits are policy HOLD.

- [ ] **Step 8: Implement external-anchor admission**

Local stage >= B1 requires `--anchor-receipt` and checks exact `0700 root:root` parent/receipt ownership without printing stat paths. Hosted mode requires a validated GitHub event path and controller-owned variables; it verifies protected base/main SHA, `MERGE_COMMIT`, accepted/review identities, peeled parents, and ancestry. Any missing input is exit 2.

- [ ] **Step 9: Implement command semantics**

`stage` succeeds only when the current stage expected set and all immutable baselines match. `zero` returns exit 1 with remaining delegate findings through B4 and exit 0 with an empty finding set at B4M onward. `baseline --check-only` never writes. `acceptance --check` validates but never creates.

- [ ] **Step 10: Run GREEN, full scanner-derivation suite, and commit**

The direct block below is diagnostic. Authority dispatches canonical `task-4-scanner-test.json` as `SCANNER_TEST_V1` with the final Task 2/3 blobs, immutable bootstrap contract and fresh Task 4 run receipt. Pre-baseline `stage`/`zero` assertions use the immutable fixture adapter and may not read or create governance manifests.

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
  scripts/governance-organization-identity-writers.mjs \
  scripts/governance-organization-identity-writers.spec.mjs
git commit -m "feat: harden identity writer stage scanner"
```

- [ ] **Step 11: Run Task 4 independent scoped review/fix loop**

Review immutable expected sets, accepted-blob/refresh/0M/bootstrap bindings, external anchor inputs, redaction, budgets, symlink/TOCTOU, exit semantics and proof that no generated baseline was consumed. Gate canonical `task-4-stage-security-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1`; fix/retest/review until PASS before Task 5.

Expected: full derivation suite and fixture B0 stage PASS; fixture zero exits 1 because three exact writers remain. Capture stderr with an explicit shell redirection in the executor run and assert it is empty; delete only the executor-created temp directory after verification. The reviewed Task 4 commit is the final scanner/derivation blob set; any later edit to those bytes invalidates Task 5's eventual baseline/raw review.

### Task 5: Refreshed Raw/Build/Migration Baselines and Artifact A Identity Authority Intake

Enter this task only after Task 4's final derivation commit and scoped review PASS. The dependency table and receipts reject any Task 5 subject that does not contain those exact reviewed blobs.

**Files:**

- Create: `scripts/governance-organization-identity-writers-baseline.mjs`
- Create: `docs/governance/organization-identity-writer-baseline.json`
- Create: `docs/governance/organization-identity-migration-authority.json`
- Create: `docs/governance/organization-identity-artifact-a-acceptance.json`
- Create: `docs/governance/organization-identity-writer-stage.json`
- Create (ignored review input): `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b0-raw-capability-disposition-review.json`
- Create local scoped review: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-5-baseline-review.md`
- Create local review receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-5-baseline-review.json`
- Modify: `scripts/governance-organization-identity-writers.spec.mjs`
- Test: `scripts/governance-organization-identity-writers.spec.mjs`
- Test without modification: `docs/governance/organization-identity-current-main-admission.json`
- Test read-only: `packages/db/test/organization-identity-v2-resolver-command.spec.mjs`, `packages/db/test/pinned-prisma-migration-stage.spec.mjs`, `apps/api/src/discovery/organization-identity-resolver-migration.spec.ts`, `apps/api/src/discovery/organization-identity-migration-inventory.spec.ts`

**Interfaces:**

- Consumes: exact refresh/admission chain, accepted `B0M_MIGRATION_COMMIT`/migration SHA/static+DB+security+disposable receipts, immutable Task 0P bootstrap contract and fresh Task 5 run receipt, final reviewed Task 4 scanner/stage/derivation blobs, Task 2/3 refreshed inventory, and Artifact A resolver/function/ACL/six-receipt authority.
- Produces: exact `WriterBaselineMeasurements`, complete `RawDispositionReviewReceipt`, immutable build/raw baseline, complete refresh-directory-plus-0M migration authority, Artifact A acceptance, initial stage and scoped review receipt.

**Commit message:** `test: bind refreshed identity authority inputs`

- [ ] **Step 1: Add manifest-schema and drift RED cases**

Test exact keys, duplicate records, ordering, digest formats, absolute/parent paths, wrong refresh/admitted-main/merge/admission/review identity, current-main admission drift, refreshed migration addition/removal/checksum/last-change/disposition drift, wrong Artifact A commit, function owner/language/security/search-path/proconfig/ACL/definition drift, and `app_user`/PUBLIC table/column privilege drift.

- [ ] **Step 2: Run migration prerequisites before generation**

Dispatch canonical `task-5-migration-prerequisites.json` as `MIGRATION_STATIC_VERIFY_V1` plus `API_VERIFY_V1`, binding the final Task 4 derivation blobs and a fresh Task 5 run receipt. The block below is diagnostic expansion:

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

Dispatch canonical `task-5-artifact-a-receipts.json` as `SCANNER_BASELINE_V1` in receipt-only mode. It reads only the six exact allowlisted paths and hard-coded digests below; the direct `sha256sum` block is diagnostic readback:

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
  --b0m-migration-commit "$B0M_MIGRATION_COMMIT" \
  --current-main-admission docs/governance/organization-identity-current-main-admission.json \
  --artifact-a 2400bac28796bae44294114edc99eaccb1bd65b3 \
  --receipt-root /global/backend/.codex/worktrees/root-worktree-remote-closeout-plan \
  --disposition-receipt .superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b0-raw-capability-disposition-review.json \
  --check-only
```

Expected: diagnostic exit 2 with the closed `INTEGRITY_ERROR` record because the baseline generator/disposition receipt is absent; stderr is empty. The RED request is canonical `task-5-baseline-red.json` under `SCANNER_BASELINE_V1` and its expected non-PASS receipt is retained as TDD evidence, not authority acceptance.

- [ ] **Step 5: Implement refreshed migration derivation and separate Artifact A function/ACL verification**

Enumerate every migration directory at `B0_REFRESH_BASE_COMMIT`, then require exactly one accepted delta at `B0M_MIGRATION_COMMIT` with the fixed 0M path/SHA/definition/reviews/disposable receipt. Separately parse Artifact A resolver/catalog contracts and prove those authority bytes remain exact. Any second migration or 0M drift is HOLD.

The seven exact function identities are `organization_identity_acquire_advisory_until_v1(bigint,timestamp with time zone)`, `organization_identity_authority_from_raw_v1(text,jsonb)`, `organization_identity_blocker_from_raw_v1(jsonb)`, `organization_identity_canonical_suppression_value_v1(text,text)`, `organization_identity_plan_from_snapshot_v1(jsonb)`, `organization_identity_resolve_for_raw_worker_v1(text,text)`, and `resolve_organization_identity_for_raw_v1(text,text)`. The privilege baseline must also state that `app_user` has SELECT plus INSERT on exactly `id, workspace_id, canonical_type, canonical_id, raw_record_id, match_rule, confidence`, has no table-level INSERT and no UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER; `app_user` alone has EXECUTE on the public resolver; PUBLIC and `app_user` have no EXECUTE on private helpers; and PUBLIC has no relevant write authority.

- [ ] **Step 6: Generate a candidate raw inventory for independent classification**

Dispatch `task-5-raw-candidate.json` as `SCANNER_BASELINE_V1` against the real `B0_REFRESH_BASE_COMMIT` virtual Program and write a temporary closed candidate only below the fresh root-owned task root. The reviewer assigns one closed disposition to every refreshed record, rejects every dynamic/unresolved record, includes only record IDs/hashes/dispositions, and writes the exact ignored disposition receipt. The receipt contains no SQL/source text, absolute roots, or secrets.

- [ ] **Step 7: Independently review every raw capability and wrapper ingress**

The reviewer must verify every raw record/ingress, add independent counterexamples, and produce the exact `RawDispositionReviewReceipt` defined above. `rawRecordCount`, record/disposition/dependency/counterexample/report digests, reviewer class, zero C/I and PASS are all required; every baseline record's binding ID/hash/disposition digest must be present in that exact set. Arbitrary IDs, partial arrays, open Records or empty real receipts are invalid.

- [ ] **Step 8: Implement deterministic baseline generation**

Validate but never regenerate current-main admission. This task always runs in initial-create mode from the accepted pre-scanner successor: prove all four output paths absent, prove Task 4's final derivation commit/blobs and review receipt, generate candidates below the fresh bootstrap task root, verify deterministic complete bytes twice, then atomically create exactly those paths. Main drift abandons the lineage and restarts from the one allowed pre-scanner `CURRENT_MAIN_ADMISSION_COMMIT`; if abandoned 0M exists, it is not carried forward and must be recreated/reviewed. It never reuses stale outputs or performs an in-place arbitrary upsert. Bind refresh/admission/B0M/launcher/bootstrap-contract/fresh-run/Task4-review identities and exact raw record hashes.

- [ ] **Step 9: Measure and enforce headroom**

Record actual `B0_REFRESH_BASE_COMMIT` counts for source files, symbol/call edges, raw capabilities, wrapper ingresses, closure members, and committed bytes. Artifact A counts may appear only as comparative evidence. For every project-total refreshed measure assert `measured * 2 <= fixedLimit`; never round down or raise a limit.

- [ ] **Step 10: Generate the tracked B0 records**

Authority dispatches canonical `task-5-baseline-generate.json` as `SCANNER_BASELINE_V1`; the direct block documents its closed inputs:

```bash
node scripts/governance-organization-identity-writers.mjs baseline \
  --refresh-base "$B0_REFRESH_BASE_COMMIT" \
  --current-main-admission-commit "$CURRENT_MAIN_ADMISSION_COMMIT" \
  --b0m-migration-commit "$B0M_MIGRATION_COMMIT" \
  --current-main-admission docs/governance/organization-identity-current-main-admission.json \
  --artifact-a 2400bac28796bae44294114edc99eaccb1bd65b3 \
  --receipt-root /global/backend/.codex/worktrees/root-worktree-remote-closeout-plan \
  --disposition-receipt .superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b0-raw-capability-disposition-review.json \
  --output-directory docs/governance
```

Expected: exit 0 closed JSON; the baseline has exactly three delegate writers and no ambiguous/forbidden raw disposition; the stage is `B0_BASELINE`; the baseline records `BootstrapContract` and this run's receipt digest separately.

- [ ] **Step 11: Re-run generation in check-only mode and mutation tests**

Authority dispatches canonical `task-5-baseline-check.json` as `SCANNER_BASELINE_V1` in check-only mode and `task-5-scanner-test.json` as `SCANNER_TEST_V1`. The direct block is diagnostic expansion:

```bash
node scripts/governance-organization-identity-writers.mjs baseline \
  --refresh-base "$B0_REFRESH_BASE_COMMIT" \
  --current-main-admission-commit "$CURRENT_MAIN_ADMISSION_COMMIT" \
  --b0m-migration-commit "$B0M_MIGRATION_COMMIT" \
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

Do not add the ignored disposition review to Git; its digest and bounded identity are recorded in the baseline and later controlled by the implementation review/acceptance. After this commit, any scanner/derivation file edit—including Task 4-owned contracts/files/CLI/spec—invalidates this commit and raw review and requires complete Task 5 regeneration/re-review before Task 6.

- [ ] **Step 13: Run Task 5 independent scoped review/fix loop**

Review exact measurements, 50% headroom, raw receipt/set equality, build/bootstrap closure, refresh+0M migration inventory, Artifact A authority and exact Task 4 derivation blob set. Machine-gate canonical `task-5-baseline-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1`. Findings create a Task 5-only fix commit, regenerate all four candidates from the same subjects, rerun tests and repeat review. Task 6 is blocked until PASS.

### Task 6: Package, Governance, Hosted Anchor, and Runtime-Exclusion Wiring

**Files:**

- Modify: `package.json:17-54`
- Modify: `scripts/governance-verify.mjs:13-40,256-352`
- Modify: `scripts/governance-contracts.spec.mjs:1-12`
- Modify: `scripts/governance-path-contracts.spec.mjs:83-104`
- Modify: `.github/workflows/governance.yml:15-36`
- Modify: `.github/workflows/ci.yml:130-143,210-239,241-281`
- Modify: `.github/required-contexts.json`
- Modify: `.github/CODEOWNERS`
- Create: `.github/workflows/organization-identity-writer-anchor.yml`
- Create local scoped review: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-6-governance-anchor-review.md`
- Create local review receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-6-governance-anchor-review.json`
- Modify: `scripts/runtime-artifact-contract.spec.mjs:16-37,100-163,404-440`
- Test: `scripts/governance-organization-identity-writers.spec.mjs`
- Test: `scripts/governance-contracts.spec.mjs`
- Test: `scripts/governance-path-contracts.spec.mjs`
- Test: `scripts/runtime-artifact-contract.spec.mjs`
- Read-only assertion: `Dockerfile`, `runtime-entrypoint.mjs`, `scripts/verify-runtime-artifact.mjs`, `scripts/verify-runtime-image.mjs`, `scripts/generate-runtime-artifact-manifest.mjs`, `.github/CODEOWNERS`, `.github/required-contexts.json`

**Interfaces:**

- Consumes: accepted launcher/root materialization, immutable bootstrap contract/fresh Task 6 run receipt, admission/scanner/final Task 5 baseline, B0M authority and protected-main workflow contract.
- Produces: explicitly non-authority developer convenience aliases; root-launcher authority wiring; non-authoritative ordinary PR CI; accepted protected-main `push` initial anchor and base-owned `pull_request_target` verifier; minimal permissions; runtime exclusion proof.

**Commit message:** `ci: enforce identity writer governance boundary`

- [ ] **Step 1: Write package/governance wiring RED assertions**

Add exact assertions for:

```json
{
  "governance:identity-writers:test": "node scripts/governance-organization-identity-bootstrap.mjs package-alias test",
  "governance:identity-writers:stage": "node scripts/governance-organization-identity-bootstrap.mjs package-alias stage",
  "governance:identity-writers:zero": "node scripts/governance-organization-identity-bootstrap.mjs package-alias zero"
}
```

Package aliases are developer conveniences only and cannot issue authority receipts. They must resolve byte-for-byte to the accepted clean bootstrap diagnostic route. The ordinary `pull_request` Governance workflow remains CI evidence and is explicitly rejected as anchor authority. Tests require the new workflow's exact protected-main event/permissions/bootstrap/PR-as-data semantics.

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

Import the reviewed validator and scanner only after `BootstrapContract` equality and fresh `BootstrapRunReceipt` PASS. Validate admission, refresh/0M/Artifact A/launcher/bootstrap identities before stage. Local stages require the root anchor at B1+. Ordinary PR workflows can report CI but set authority class `NON_AUTHORITATIVE_PR_CI`; only the base-owned anchor workflow may supply hosted authority.

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

- [ ] **Step 6: Implement the protected-main/base-owned anchor workflow**

`.github/workflows/organization-identity-writer-anchor.yml` has only `push` on `main` and `pull_request_target`. On the exact B0 merge push, base-owned workflow bytes require `GITHUB_SHA` equal the independently read-back merge SHA and create the initial hosted receipt; a failed/cancelled run can recover only via separately authorized re-run of the same immutable run/SHA. On `pull_request_target`, checkout/execute only the protected-main accepted launcher/bootstrap/scanner/workflow blobs or invoke a provenance-equivalent root controller whose launcher/materialization/contract digests equal the protected anchor. Fetch the PR head SHA/tree only as a Git object into a fixed data root and prohibit executing any PR action/script/package/generated binary/workflow/config. Bind event/ref/repository/run/workflow blob/accepted B0/review/launcher/bootstrap/ordered parents. Moving-main dispatch, temporary refs/tags, naked-SHA workflow dispatch and any PR-provided launcher/request bytes are rejected.

Permissions are `contents: read` plus only the minimum checks/status write needed for the closed result; no secrets reach PR code. `required-contexts.json` keeps ordinary Governance CI separate from the new authority context. CODEOWNERS includes the anchor workflow and bootstrap.

- [ ] **Step 7: Extend runtime exclusion tests without widening runtime copies**

Keep `Dockerfile`, `runtime-entrypoint.mjs`, `verify-runtime-artifact.mjs`, `verify-runtime-image.mjs`, and the manifest generator unchanged unless a failing test proves an existing copy path includes governance. The GREEN implementation is the explicit negative test over compiled output, release manifest inventory, and OCI copy statements, not a new runtime filter that could hide a copied scanner.

- [ ] **Step 8: Run focused GREEN and root governance**

The direct block is a non-authority developer diagnostic. Authority dispatches `task-6-scanner-test.json` as `SCANNER_TEST_V1`, `task-6-stage.json` as `SCANNER_STAGE_V1`, `task-6-governance.json` as `GOVERNANCE_VERIFY_V1`, and `task-6-runtime-artifact.json` as `RUNTIME_ARTIFACT_VERIFY_V1`, all with the immutable contract and a fresh Task 6 run receipt.

Run:

```bash
pnpm governance:identity-writers:test
pnpm governance:identity-writers:stage
pnpm governance:test
node scripts/governance-verify.mjs verify
node --test scripts/runtime-artifact-contract.spec.mjs
```

Expected: PASS at `B0_BASELINE` through the clean bootstrap; ordinary PR workflow is explicitly non-authoritative; protected anchor workflow contract tests PASS but it is inert as authority until merged to protected main.

- [ ] **Step 9: Run build, full API tests, docs, and static migration gates**

Dispatch `task-6-prisma-generate.json` as `PRISMA_GENERATE_V1`, `task-6-api-verify.json` as `API_VERIFY_V1`, `task-6-docs-verify.json` as `DOCS_VERIFY_V1`, and `task-6-migration-static.json` as `MIGRATION_STATIC_VERIFY_V1`. The direct block is diagnostic expansion.

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
  .github/workflows/organization-identity-writer-anchor.yml \
  .github/required-contexts.json .github/CODEOWNERS \
  scripts/runtime-artifact-contract.spec.mjs
git commit -m "ci: enforce identity writer governance boundary"
```

- [ ] **Step 11: Run Task 6 independent scoped review/fix loop**

Review ordinary-PR non-authority, protected-main push/base-owned `pull_request_target` workflow bytes, protected-base/root-equivalent accepted launcher/bootstrap invocation, minimal permissions, PR-as-data rule, runtime exclusion and governance wiring. Gate canonical `task-6-governance-anchor-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1`; Task 7 is blocked until PASS.

### Task 7: B0 Implementation Whole Review and Exact Parent Freeze

**Files:**

- Create (ignored review output): `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b0-implementation-whole-review.md`
- Create local review receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b0-implementation-whole-review.json`
- Modify: none
- Test: all B0 files from Tasks 1–6; exact six source receipts; three current writer sources; resolver/lock; package/governance/workflows/runtime exclusion; migration static suites.

**Interfaces:**

- Consumes: clean B0 implementation descending from accepted B0M; every Task 1–6 scoped review receipt; launcher/materialization; immutable bootstrap contract plus fresh Task 7 run receipt; build/tool/raw/migration/Artifact A authority; and no writer acceptance JSON.
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

Expected: PASS. Drift before B0 whole review preserves the abandoned lineage and creates the exact recovery branch/worktree from the pre-scanner `CURRENT_MAIN_ADMISSION_COMMIT` whose tree lacks 0M/scanner/manifests. Rerun Tasks 0B/0F/0C, separately authorize and rerun 0M, then Tasks 1–6 in initial-create mode and obtain a new whole review. Never start from `B0M_MIGRATION_COMMIT`, a Task 1–6 commit, or `B0_IMPLEMENTATION`; do not review an unadmitted subject.

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

Dispatch canonical requests `task-7-scanner-test.json` (`SCANNER_TEST_V1`), `task-7-stage.json` (`SCANNER_STAGE_V1`), `task-7-current-main.json` (`CURRENT_MAIN_VALIDATE_V1`), `task-7-governance.json` (`GOVERNANCE_VERIFY_V1`), `task-7-runtime.json` (`RUNTIME_ARTIFACT_VERIFY_V1`), `task-7-migration.json` (`MIGRATION_STATIC_VERIFY_V1`), `task-7-prisma.json` (`PRISMA_GENERATE_V1`), `task-7-api.json` (`API_VERIFY_V1`) and `task-7-docs.json` (`DOCS_VERIFY_V1`) with the exact implementation subject and one fresh Task 7 run receipt. The block below is diagnostic expansion:

```bash
pnpm governance:identity-writers:test
pnpm governance:identity-writers:stage
pnpm governance:test
node scripts/governance-organization-identity-current-main-admission.mjs validate \
  --input docs/governance/organization-identity-current-main-admission.json
node scripts/governance-verify.mjs verify
node --test scripts/runtime-artifact-contract.spec.mjs
node --test \
  packages/db/test/organization-identity-materialization-outcome-compat.spec.mjs \
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

- [ ] **Step 7: Review security, privacy, runtime exclusion, and exact-one-migration scope**

The review must state whether the scanner can read outside accepted repository/declaration/tool roots, emit source/SQL/secret bytes, trust PR-controlled hosted inputs, change accepted migration bytes, enter API/Worker dist, or reach OCI/release manifests. It confirms the complete migration inventory equals refresh plus exact 0M and that B1–B6 can add none.

- [ ] **Step 8: Write the bounded independent review report**

The exact report must name the implementation SHA, two-parent `B0_REFRESH_BASE_COMMIT == REFRESH_MERGE_COMMIT`, one-parent `CURRENT_MAIN_ADMISSION_COMMIT`, admitted live-main/refresh parents, admission JSON and pre/post refresh review digests, amended spec SHA-256, commands/results, counterexamples, all reviewed manifests, six source receipt digests, limitations, and final finding counts. It must not claim runtime, database, deployment, remote merge, or final authority.

- [ ] **Step 9: Verify the review gate and digest without committing it**

Run:

```bash
REVIEW=.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b0-implementation-whole-review.md
REVIEW_RECEIPT=.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b0-implementation-whole-review.json
test -s "$REVIEW"
test "$(rg -c '^Critical:' "$REVIEW")" -eq 1
test "$(rg -c '^Important:' "$REVIEW")" -eq 1
test "$(rg -c '^Verdict:' "$REVIEW")" -eq 1
rg -qx 'Critical: 0' "$REVIEW"
rg -qx 'Important: 0' "$REVIEW"
rg -qx 'Verdict: PASS' "$REVIEW"
node scripts/governance-organization-identity-bootstrap.mjs verify-review \
  --report "$REVIEW" --receipt "$REVIEW_RECEIPT" \
  --subject "$B0_IMPLEMENTATION_SHA"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

The direct verifier is diagnostic. Authority dispatches `task-7-whole-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1`, binding launcher/materialization, immutable bootstrap contract, Task 7 run receipt, implementation subject, report/path/counterexample digests and unique zero-C/I/PASS fields. Expected GREEN: report exists with exact subject and zero C/I; tracked/untracked Git state stays clean because the review path is ignored.

**Commit:** none. The reviewed implementation head must not move after this review. Any code/test/manifest change invalidates the review and restarts Task 7.

### Task 8: `B0_ACCEPTANCE` One-Parent/One-Path First Add and Scoped Review

**Files:**

- Create: `docs/governance/organization-identity-writer-acceptance.json`
- Create (ignored post-commit review): `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b0-acceptance-scoped-review.md`
- Create local review receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b0-acceptance-scoped-review.json`
- Modify: none
- Test: `scripts/governance-organization-identity-writers.spec.mjs`, acceptance generator/checker, Git commit shape.

**Interfaces:**

- Consumes: exact reviewed `B0_IMPLEMENTATION_SHA`; exact two-parent `B0_REFRESH_BASE_COMMIT`; exact one-parent `CURRENT_MAIN_ADMISSION_COMMIT`; admitted live-main/ordered refresh parents/admission JSON; Task 0B/0C/7 review digests; parent-tree controlled blobs; launcher/materialization and immutable bootstrap contract/schema/blob plus a fresh Task 8 run receipt; separate Artifact A Git authority; B0 baseline stage identities.
- Produces: exact `B0_ACCEPTANCE_SHA`; one first-added tracked JSON blob binding all refresh/authority subjects; separate scoped-review digest not written back; terminal local state `LOCAL_ACCEPTANCE_REVIEWED` only while live main remains admitted.

**Commit message:** `chore: anchor organization identity writer baseline`

- [ ] **Step 1: Run the missing-acceptance RED**

Run:

```bash
node scripts/governance-organization-identity-writers.mjs acceptance --check
```

The direct command is diagnostic; canonical `task-8-acceptance-red.json` dispatches `SCANNER_ACCEPTANCE_V1` and must return the same expected RED. Expected: exit 1 with a closed policy result naming only the repository-relative acceptance path/kind; stderr empty. Exit 0 before first-add is forbidden.

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

Compare `B0_IMPLEMENTATION_SHA` and all refresh/admission/review identities to the full subject printed inside the review report. Mismatch or live-main drift before acceptance preserves the old lineage and creates the one allowed recovery successor from its pre-scanner `CURRENT_MAIN_ADMISSION_COMMIT`, never from `B0M_MIGRATION_COMMIT` or `B0_IMPLEMENTATION`. Rerun 0B/0F/0C, separately authorized 0M, Tasks 1–7 and whole review before a new acceptance.

- [ ] **Step 3: Generate only the acceptance JSON from parent-tree blobs**

Authority dispatches canonical `task-8-acceptance-generate.json` as `SCANNER_ACCEPTANCE_V1`; the direct block documents the closed inputs. The acceptance freezes the immutable bootstrap contract/schema/blob/digest and launcher/materialization identities, not an opaque per-run receipt. It records the Task 8 implementation run receipt separately as non-invariant evidence.

Run:

```bash
node scripts/governance-organization-identity-writers.mjs acceptance \
  --implementation-parent "$B0_IMPLEMENTATION_SHA" \
  --refresh-base "$(jq -er '.refreshBaseCommit' docs/governance/organization-identity-writer-baseline.json)" \
  --current-main-admission-commit "$(jq -er '.currentMainAdmissionCommit' docs/governance/organization-identity-writer-baseline.json)" \
  --b0m-migration-commit "$(jq -er '.b0mMigrationCommit' docs/governance/organization-identity-writer-baseline.json)" \
  --bootstrap-contract docs/governance/organization-identity-bootstrap-contract.json \
  --implementation-run-receipt "$TASK_8_BOOTSTRAP_RUN_RECEIPT" \
  --anchor-workflow .github/workflows/organization-identity-writer-anchor.yml \
  --current-main-admission docs/governance/organization-identity-current-main-admission.json \
  --current-main-refresh-review .superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-refresh-review.md \
  --artifact-a 2400bac28796bae44294114edc99eaccb1bd65b3 \
  --implementation-review "$REVIEW" \
  --output docs/governance/organization-identity-writer-acceptance.json
```

Expected: exit 0; exactly one untracked path exists. The generator gets refresh/admission, immutable bootstrap contract plus normalized run proof, complete config/declaration/tool roots, exact B0M migration/disposable/DB/security receipts, protected anchor workflow blob, scanner/raw-review/measurement/migration baselines, all Task 1–7 review receipts and stage machine from the implementation parent. No review self-attests.

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

Authority dispatches canonical `task-8-acceptance-commit.json` as `GIT_ACCEPTANCE_COMMIT_V1`. It verifies parent `B0_IMPLEMENTATION_SHA`, path absence in that parent, a one-path staged first-add and the fixed message before writing. The direct Git block is diagnostic shape readback.

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

Dispatch canonical `task-8-acceptance-check.json` as `SCANNER_ACCEPTANCE_V1`, `task-8-current-main.json` as `CURRENT_MAIN_VALIDATE_V1`, `task-8-scanner-test.json` as `SCANNER_TEST_V1`, `task-8-stage.json` as `SCANNER_STAGE_V1`, and `task-8-governance.json` as `GOVERNANCE_VERIFY_V1`, all against `B0_ACCEPTANCE_SHA` with a fresh run receipt. The direct block is diagnostic expansion.

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
ACCEPTANCE_RECEIPT=.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b0-acceptance-scoped-review.json
test -s "$ACCEPTANCE_REVIEW"
test "$(rg -c '^Critical:' "$ACCEPTANCE_REVIEW")" -eq 1
test "$(rg -c '^Important:' "$ACCEPTANCE_REVIEW")" -eq 1
test "$(rg -c '^Verdict:' "$ACCEPTANCE_REVIEW")" -eq 1
rg -qx 'Critical: 0' "$ACCEPTANCE_REVIEW"
rg -qx 'Important: 0' "$ACCEPTANCE_REVIEW"
rg -qx 'Verdict: PASS' "$ACCEPTANCE_REVIEW"
node scripts/governance-organization-identity-bootstrap.mjs verify-review \
  --report "$ACCEPTANCE_REVIEW" --receipt "$ACCEPTANCE_RECEIPT" \
  --subject "$B0_ACCEPTANCE_SHA"
test "$(git ls-remote --exit-code --refs origin refs/heads/main | cut -f1)" = "$ADMITTED_LIVE_MAIN_COMMIT"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

The direct verifier is diagnostic; authority dispatches `task-8-acceptance-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1`. Expected: `LOCAL_ACCEPTANCE_REVIEWED` only when live main is still the admitted SHA.

If live main advances after the acceptance commit, preserve the abandoned branch/head without amend/rebase/merge. Request exact authorization to create a successor v2 refresh worktree from the exact pre-scanner `CURRENT_MAIN_ADMISSION_COMMIT` recorded by the abandoned acceptance—not from its `B0_IMPLEMENTATION_SHA`. The deterministic branch/path suffix is the first 12 hex characters of the newly advertised main SHA. That starting tree must lack 0M, scanner/manifests and acceptance; rerun 0B/0F/0C, separately authorized 0M and Tasks 1–8 in initial-create mode.

If the scoped acceptance review itself finds a shape/content/binding defect while live main has not drifted, preserve the rejected acceptance commit and create a dedicated acceptance-repair branch/worktree from its exact parent `B0_IMPLEMENTATION_SHA`, where the acceptance path is absent. Apply any generator/implementation fix as a forward commit, rerun affected Tasks 1–6 plus the complete Task 7 whole review, then generate a new first-add acceptance and review it. Do not amend, revert-and-reuse, or add a fix commit atop the rejected one-path acceptance. Do not push/open/update a PR, merge, create the root receipt, or start B1 from either abandoned acceptance.

### Task 9: Protected-Main Anchor Run Card — Default HOLD, Do Not Execute Without Exact Authorizations

**Files:**

- Create only after separate root-receipt authorization: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json`
- Modify only after separate controller-variable authorization: GitHub repository/controller variables `ORGANIZATION_IDENTITY_B0_ADMITTED_MAIN_SHA`, `ORGANIZATION_IDENTITY_B0_REFRESH_BASE_SHA`, `ORGANIZATION_IDENTITY_CURRENT_MAIN_ADMISSION_COMMIT_SHA`, `ORGANIZATION_IDENTITY_B0_ACCEPTED_SHA`, `ORGANIZATION_IDENTITY_B0_ACCEPTANCE_REVIEW_SHA256`, `ORGANIZATION_IDENTITY_B0_MERGE_SHA`, `ORGANIZATION_IDENTITY_B0_FIRST_PARENT_SHA`, `ORGANIZATION_IDENTITY_B0_SECOND_PARENT_SHA`, `ORGANIZATION_IDENTITY_B0_MERGE_METHOD`, `ORGANIZATION_IDENTITY_LAUNCHER_CONTRACT_SHA256`, `ORGANIZATION_IDENTITY_LAUNCHER_MATERIALIZATION_SHA256`, `ORGANIZATION_IDENTITY_BOOTSTRAP_CONTRACT_SHA256`
- Modify: no repository file
- Test: local Git ancestry, live protected-main/PR/ruleset readback, root receipt ownership/mode/digest chain.

**Interfaces:**

- Consumes: exact admitted live-main SHA, two-parent refresh-base SHA, one-parent admission-commit SHA, admission/pre/post-review identities, exact reviewed v2 acceptance head, exact acceptance-review digest, accepted launcher/materialization/bootstrap-contract identities, fresh Task 9 run receipt, and separately authorized push/PR/merge/readback/controller/root actions.
- Produces: GitHub merge whose pre-call head/base and post-call ordered parents are exact, externally fixed admitted/accepted/review/launcher/bootstrap identities, root-only anchor binding both parents; no repository commit.

**Commit message:** none; this task produces external readback/receipt state only after its separate authorizations.

- [ ] **Step 1: Confirm the default RED/HOLD state**

Run only the local check:

```bash
ANCHOR=/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json
test -f "$ANCHOR"
```

Expected RED now: nonzero because no authorized future receipt exists. This is the correct HOLD state. Do not create it to make the check green.

- [ ] **Step 2: Re-read admitted live main and obtain separate exact authorization for the push**

Before any network mutation, read `refs/heads/main` with `git ls-remote` and require exact equality to `CurrentMainAdmission.liveMainCommit`. Drift after acceptance abandons the sequence and uses the sole pre-scanner `CURRENT_MAIN_ADMISSION_COMMIT` recovery start defined in Task 8; it reruns 0B/0F/0C, 0M and Tasks 1–8. When equal, present admitted main, refresh base/merge/parents, `B0_IMPLEMENTATION_SHA`, `B0_ACCEPTANCE_SHA`, branch name, acceptance-review SHA-256, launcher/bootstrap contract and clean status. Authorization for this step covers only:

```bash
git push -u origin codex/pr407-organization-identity-caller-cutover-v2
```

It does not authorize a PR, merge, variables, readback receipt, v3 worktree, or B1.

- [ ] **Step 3: Obtain separate exact authorization for PR create/update**

The PR base branch is protected `main`; actual base SHA must equal admitted `liveMainCommit`; head SHA must equal `B0_ACCEPTANCE_SHA`; the body states refresh/admission/bootstrap/0M identities, exactly one Artifact B migration, `B0_IMPLEMENTATION`, `B0_ACCEPTANCE`, review digests and `LOCAL_ACCEPTANCE_REVIEWED`. Query the created PR and stop if either SHA differs:

```bash
gh pr view codex/pr407-organization-identity-caller-cutover-v2 \
  --json number,baseRefName,baseRefOid,headRefName,headRefOid,state,url
```

- [ ] **Step 4: Read live rules/checks and request a separate merge authorization**

Read only the exact PR checks, required review, branch protection/ruleset, allowed merge methods, auto-update/merge-queue settings, conversation state and protected-main anchor workflow blob. The merge authorization must name PR number, exact head/base/method and disclose that merging triggers the base-owned protected-main `push` anchor workflow automatically. Auto-update/queue rebase is forbidden.

- [ ] **Step 5: Recheck exact head/base immediately before the authorized merge call**

Immediately before the network mutation, read the PR again and require actual `headRefOid=B0_ACCEPTANCE_SHA` and `baseRefOid=ADMITTED_LIVE_MAIN_COMMIT`; require approvals/checks still green and no auto-update/queue transition. A mismatch stops without merge and invalidates this acceptance sequence.

- [ ] **Step 6: Perform only the separately authorized expected-head merge call**

Authority dispatches canonical `task-9-github-pr-merge.json` as `GITHUB_PR_MERGE_V1` only after the separate merge authorization and immediate head/base readback. The launcher derives the repository/PR from the reviewed packet and uses the API's expected-head precondition; the direct block is diagnostic expansion:

```bash
REPOSITORY="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
MERGE_RESPONSE="$(gh api --method PUT "repos/$REPOSITORY/pulls/$PR_NUMBER/merge" \
  -f merge_method=merge -f sha="$B0_ACCEPTANCE_SHA")"
PROTECTED_MAIN_MERGE_SHA="$(jq -er '.sha' <<<"$MERGE_RESPONSE")"
```

The actual base equality was rechecked immediately before this call because this API has no independent expected-base parameter. Squash/rebase/force/update-branch/merge-queue calls are forbidden.

- [ ] **Step 7: Perform separately authorized GitHub commit/branch parent readback**

Dispatch canonical `task-9-github-commit-readback.json` as `GITHUB_COMMIT_READBACK_V1`. Do not consult local `origin/main`. Read the exact merge-response SHA and protected-main branch through GitHub API; the direct block is diagnostic expansion:

```bash
REMOTE_COMMIT="$(gh api "repos/$REPOSITORY/git/commits/$PROTECTED_MAIN_MERGE_SHA")"
REMOTE_MAIN="$(gh api "repos/$REPOSITORY/branches/main")"
test "$(jq -er '.sha' <<<"$REMOTE_COMMIT")" = "$PROTECTED_MAIN_MERGE_SHA"
test "$(jq -er '.commit.sha' <<<"$REMOTE_MAIN")" = "$PROTECTED_MAIN_MERGE_SHA"
test "$(jq '.parents | length' <<<"$REMOTE_COMMIT")" -eq 2
test "$(jq -er '.parents[0].sha' <<<"$REMOTE_COMMIT")" = "$ADMITTED_LIVE_MAIN_COMMIT"
test "$(jq -er '.parents[1].sha' <<<"$REMOTE_COMMIT")" = "$B0_ACCEPTANCE_SHA"
```

Expected: GitHub commit and protected-main APIs independently agree on response SHA and exact ordered parents. A mismatch produces no root/hosted anchor, fetch or v3.

- [ ] **Step 8: Verify the automatic protected-main push anchor run**

Read the workflow run created by the merge push and require exact workflow blob, event=`push`, ref=`refs/heads/main`, head SHA=`PROTECTED_MAIN_MERGE_SHA`, repository/run identity and PASS closed receipt. If failed/cancelled, request authorization only to re-run that same immutable run/SHA. Moving-main dispatch, temporary ref/tag or replacement run is forbidden.

- [ ] **Step 9: Obtain separate authorization and fetch only the exact merge object**

After remote readback PASS, verify the pinned Git supports `--no-auto-maintenance` and `--no-write-commit-graph`; missing support is HOLD. Request exact fetch authorization for `PROTECTED_MAIN_MERGE_SHA`, then dispatch canonical `task-9-fetch-merged-object.json` as `GIT_FETCH_MERGED_OBJECT_V1`. The direct block is diagnostic expansion:

```bash
git fetch --no-tags --no-write-fetch-head --no-auto-maintenance \
  --no-write-commit-graph origin "$PROTECTED_MAIN_MERGE_SHA"
test "$(git rev-parse "$PROTECTED_MAIN_MERGE_SHA^1")" = "$ADMITTED_LIVE_MAIN_COMMIT"
test "$(git rev-parse "$PROTECTED_MAIN_MERGE_SHA^2")" = "$B0_ACCEPTANCE_SHA"
git merge-base --is-ancestor "$B0_IMPLEMENTATION_SHA" "$PROTECTED_MAIN_MERGE_SHA"
```

This fetch does not update or treat `origin/main` as fresh authority.

- [ ] **Step 10: Obtain separate authorization for controller variables and root-only receipt**

Set all twelve controller-owned values only after authorization and only to live readback identities. Then, under another separate root-receipt authorization, dispatch `task-9-root-anchor-write.json` as `ROOT_ANCHOR_WRITE_V1` to create the successor directory/receipt atomically with owner `root:root`, directory/receipt access no broader than `0700/0600`, exact schema above, admitted main, `B0_REFRESH_BASE_COMMIT`, `CURRENT_MAIN_ADMISSION_COMMIT`, reviewed PR head, both ordered GitHub parents, launcher/materialization/bootstrap contract identities, canonical RFC3339 UTC time, predecessor digest when one exists, and a recomputed receipt-chain SHA-256. Do not place credentials or source/SQL bytes in it.

- [ ] **Step 11: Verify the external anchor from both local and hosted perspectives**

Dispatch canonical `task-9-anchor-stage.json` as `SCANNER_STAGE_V1`, binding the fresh Task 9 run receipt and root anchor. The direct block is diagnostic expansion:

```bash
node scripts/governance-organization-identity-writers.mjs stage \
  --anchor-receipt /global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json
```

Verify the initial protected-main push receipt and later base-owned `pull_request_target` contract. The ordinary PR Governance context is explicitly rejected as authority. A PR-supplied artifact/env/job-output/package/workflow substitute must fail.

- [ ] **Step 12: Record the task outcome without a repository commit**

**Commit:** none. The task outcome is either `PROTECTED_MAIN_ANCHORED` with exact live evidence or `HOLD` with the first failed gate. External waiting time is not estimated.

### Task 10: Create V3 From the Exact Protected-Main Merge Commit

**Files:**

- Create after Task 9 and explicit local execution approval: worktree `/global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v3`
- Create: branch `codex/pr407-organization-identity-caller-cutover-v3`
- Modify: no v2 file
- Test: worktree inventory, exact head/branch/status, anchor-aware stage/zero diagnostics.

**Interfaces:**

- Consumes: root-only anchor's exact `mergeCommitSha`, `acceptedB0Sha`, launcher/materialization/bootstrap-contract identities; locally available protected-main merge Git object; separate v3 creation authorization.
- Produces: clean v3 at the exact merge commit, a fresh v3 `BootstrapRunReceipt` whose subject is that merge, B0 stage passing with external anchor, live zero exit 1 with three writers.

**Commit message:** none; worktree creation is not a repository content commit.

- [ ] **Step 1: Run the expected absent-v3 RED**

```bash
test -d /global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v3
```

Expected RED before setup: nonzero. If the path or branch already exists, stop and audit ownership; do not reuse it.

- [ ] **Step 2: Read and validate the anchor without editing v2**

Authority dispatches `task-10-anchor-validate.json` as `SCANNER_STAGE_V1` in anchor-only mode. The direct `jq`/Git block is diagnostic readback and cannot select authority inputs.

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

After the separate local v3 authorization, dispatch canonical `task-10-v3-worktree-create.json` as `V3_WORKTREE_CREATE_V1`. The direct Git command is diagnostic expansion.

```bash
git -C /global/backend worktree add \
  -b codex/pr407-organization-identity-caller-cutover-v3 \
  /global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v3 \
  "$PROTECTED_MAIN_MERGE_SHA"
```

- [ ] **Step 5: Verify the fresh base and run the accepted clean bootstrap**

Dispatch canonical `task-10-bootstrap-authority-run.json` as `BOOTSTRAP_AUTHORITY_RUN_V1`. The accepted root wrapper supplies `/usr/bin/env -i`, exact `NPM_CONFIG_USERCONFIG=/dev/null`, and the absolute Node path from the accepted launcher receipt—not `/usr/bin/node`. It internally performs `pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --config.ignore-pnpmfile=true`, then dispatches `PRISMA_GENERATE_V1` and verifies generated outputs before scanner load. The block below is diagnostic state readback plus the one authority launcher call:

```bash
cd /global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v3
test "$(git branch --show-current)" = codex/pr407-organization-identity-caller-cutover-v3
test "$(git rev-parse HEAD)" = "$PROTECTED_MAIN_MERGE_SHA"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher/identity-writer-launch \
  --request /global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/requests/task-10-bootstrap-authority-run.json
git diff --exit-code -- pnpm-lock.yaml packages/db/prisma/schema.prisma
```

Expected: bootstrap proves exact `pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile`, `NPM_CONFIG_USERCONFIG=/dev/null`, fixed roots, post-install bootstrap rehash, `pnpm --filter @global/db generate`, generated Prisma declarations/DMMF/delegate surface and dynamic TypeScript import before scanner execution. Contract digest is identical to accepted B0; only the enumerated fresh-run fields differ.

- [ ] **Step 6: Run the anchor-aware base verification**

```bash
/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher/identity-writer-launch \
  --request /global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/requests/task-10-stage.json
/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher/identity-writer-launch \
  --request /global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/requests/task-10-zero.json
```

The requests use `SCANNER_STAGE_V1` and `SCANNER_ZERO_V1`, the fresh Task 10 run receipt and root anchor. Expected: stage exits 0 at `B0_BASELINE`; zero exits 1 with exactly the three accepted writer findings; stderr is empty.

**Commit:** none. Worktree creation is the setup boundary; Task 11 owns the first v3 commit.

## V3 Delivery: B1–B6 Caller Cutover

Every Task 11–18 authority gate first validates the protected anchor, exact accepted `BootstrapContract`, root launcher/materialization and a fresh `BootstrapRunReceipt` whose subject equals that task's candidate head. The direct pnpm/Node command blocks are diagnostic/TDD expansions. A GREEN/stage/zero/governance/review claim exists only when the named canonical root-launcher request for that task returns the closed receipt; intentional RED commands retain expected-failure receipts and are never promoted to PASS.

### Task 11: B1 Temporal Five-Outcome and Replay RED Without Writer-Count Change

**Files:**

- Create: `apps/api/src/temporal/organization-identity-caller-cutover.spec.ts`
- Modify: `docs/governance/organization-identity-writer-stage.json`
- Create local scoped review/receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-11-temporal-red-review.md`, `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-11-temporal-red-review.json`
- Test: `apps/api/src/temporal/organization-identity-caller-cutover.spec.ts`
- Test unchanged stage: `scripts/governance-organization-identity-writers.spec.mjs`
- Read-only: `apps/api/src/temporal/discovery.activities.ts:760-956,1617-1629`, `apps/api/src/temporal/discovery.workflow.ts:175`, resolver/lock source and tests.

**Interfaces:**

- Consumes: exact v3 anchored B0 base; `OrganizationIdentityResolutionReceipt`; current Activity input and result `{ companies: number; suppressed: number }`.
- Produces: failing product contract for `bound`, `created`, `legacy_bound`, `suppressed`, `conflict`, exact composite receipt reuse, and response-loss behavior; `B1_TEMPORAL_RED` stage with the same three writers.

**Commit message:** `test: specify temporal identity resolver cutover`

- [ ] **Step 1: Advance only the mutable stage record**

Dispatch `task-11-stage-generate.json` as `SCANNER_STAGE_V1` to generate `B1_TEMPORAL_RED` so the source-tree observation still names three exact writers. Do not edit expected sets, baseline, scanner, acceptance, build, raw, or migration manifests.

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

Expected: diagnostic FAIL because current Temporal code still calls `tx.identityLink.create` and does not call the resolver/composite lock. Canonical `task-11-api-red.json` under `API_VERIFY_V1` records this expected RED without claiming PASS.

- [ ] **Step 7: Prove B1 governance remains green with three writers**

Dispatch `task-11-stage.json` as `SCANNER_STAGE_V1` and `task-11-zero.json` as `SCANNER_ZERO_V1`; the direct block is diagnostic expansion.

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

- [ ] **Step 9: Run Task 11 independent scoped review/fix loop**

Review five-outcome/replay/lock/provenance RED contract and unchanged writer count. Gate `task-11-temporal-red-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1`; findings fix only Task 11 tests/stage and repeat RED/review. Task 12 is blocked until PASS.

### Task 12: B2 Temporal Resolver Cutover and Stage `3 → 2`

**Files:**

- Modify: `apps/api/src/temporal/discovery.activities.ts:1-210,760-956`
- Modify: `apps/api/src/temporal/discovery.activities.spec.ts:1062-1675`
- Modify: `apps/api/src/temporal/organization-identity-caller-cutover.spec.ts`
- Modify: `docs/governance/organization-identity-writer-stage.json`
- Create local scoped review/receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-12-temporal-cutover-review.md`, `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-12-temporal-cutover-review.json`
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

Expected: diagnostic FAIL on the resolver/composite-receipt/direct-writer assertions. Canonical `task-12-api-red.json` under `API_VERIFY_V1` records the expected RED. If it passes before source changes, stop and inspect branch ownership or test weakness.

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

Dispatch canonical `task-12-api-focused-green.json` as `API_VERIFY_V1`; the direct block is diagnostic expansion.

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

Dispatch `task-12-stage.json` as `SCANNER_STAGE_V1` and `task-12-zero.json` as `SCANNER_ZERO_V1`, each binding the anchor and fresh Task 12 run receipt. The direct block is diagnostic expansion.

Run:

```bash
ANCHOR=/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json
node scripts/governance-organization-identity-writers.mjs stage --anchor-receipt "$ANCHOR"
node scripts/governance-organization-identity-writers.mjs zero --anchor-receipt "$ANCHOR"
```

Expected: stage exit 0 with two expected writers; zero exit 1 with exactly those two; raw/build/migration baselines unchanged.

- [ ] **Step 10: Run proportional API/build checks and commit**

Dispatch canonical `task-12-api-full.json` as `API_VERIFY_V1`; the direct block is diagnostic expansion.

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

- [ ] **Step 11: Run Task 12 independent scoped review/fix loop**

Review resolver/lock receipt use, all outcomes, contribution ownership, replay/history compatibility and exact `3 → 2`. Gate `task-12-temporal-cutover-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1`; fix/retest/review until PASS before Task 13.

### Task 13: B3 TenantProjection Five-Outcome, Chunk, and Replay RED

**Files:**

- Create: `apps/api/src/acquisition/tenant-projection.organization-identity.spec.ts`
- Modify: `docs/governance/organization-identity-writer-stage.json`
- Create local scoped review/receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-13-projection-red-review.md`, `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-13-projection-red-review.json`
- Test: `apps/api/src/acquisition/tenant-projection.organization-identity.spec.ts`
- Read-only: `apps/api/src/acquisition/tenant-projection.service.ts`, its raw-bridge/suppression specs, `apps/api/scripts/project-source.mts`.

**Interfaces:**

- Consumes: `ProjectResult`, monitored-source Raw bridge, Artifact A resolver/lock contracts, B2 two-writer stage.
- Produces: B3 failing contract for five outcomes, exact chunk lock refresh, response-loss no-op, script-consumer compatibility; same two expected writers.

**Commit message:** `test: specify tenant projection identity cutover`

- [ ] **Step 1: Advance only the stage to `B3_PROJECTION_RED`**

Dispatch `task-13-stage-generate.json` as `SCANNER_STAGE_V1` against unchanged B2 source. Stage must still pass with TenantProjection and materialization writers.

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

Expected: diagnostic FAIL because current projection still calls `tx.identityLink.create` and does not use the resolver/composite receipt. Canonical `task-13-api-red.json` under `API_VERIFY_V1` records the expected RED.

- [ ] **Step 7: Verify the unchanged two-writer stage and commit RED**

Dispatch `task-13-stage.json` as `SCANNER_STAGE_V1`; the direct stage command is diagnostic expansion.

```bash
ANCHOR=/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json
node scripts/governance-organization-identity-writers.mjs stage --anchor-receipt "$ANCHOR"
git add apps/api/src/acquisition/tenant-projection.organization-identity.spec.ts \
  docs/governance/organization-identity-writer-stage.json
git commit -m "test: specify tenant projection identity cutover"
```

Expected: governance stage PASS with two writers; product RED remains intentional.

- [ ] **Step 8: Run Task 13 independent scoped review/fix loop**

Review five outcomes, Raw-before-resolver order, 101-row chunk lock refresh, replay stability and script result contract. Gate `task-13-projection-red-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1`; fix/retest/review until PASS before Task 14.

### Task 14: B4 TenantProjection Resolver Cutover and Stage `2 → 1`

**Files:**

- Modify: `apps/api/src/acquisition/tenant-projection.service.ts:1-280`
- Modify: `apps/api/src/acquisition/tenant-projection.organization-identity.spec.ts`
- Modify: `apps/api/src/acquisition/tenant-projection.raw-bridge.spec.ts`
- Modify: `apps/api/src/acquisition/tenant-projection.suppression.spec.ts`
- Modify: `docs/governance/organization-identity-writer-stage.json`
- Create local scoped review/receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-14-projection-cutover-review.md`, `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-14-projection-cutover-review.json`
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

Expected: diagnostic FAIL on resolver/composite-receipt/direct-writer assertions. Canonical `task-14-api-red.json` under `API_VERIFY_V1` records the expected RED. Passing before source changes is a stop condition.

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

Dispatch canonical `task-14-api-focused-green.json` as `API_VERIFY_V1`; the direct block is diagnostic expansion.

```bash
pnpm --filter @global/api exec vitest run \
  src/acquisition/tenant-projection.organization-identity.spec.ts \
  src/acquisition/tenant-projection.raw-bridge.spec.ts \
  src/acquisition/tenant-projection.suppression.spec.ts
```

Expected: PASS for five outcomes, 101-row chunk refresh, response loss, suppression, raw bridge, and script-compatible result.

- [ ] **Step 7: Generate and verify B4 stage**

Dispatch `task-14-stage.json` as `SCANNER_STAGE_V1` and `task-14-zero.json` as `SCANNER_ZERO_V1`; the direct block is diagnostic expansion.

```bash
ANCHOR=/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json
node scripts/governance-organization-identity-writers.mjs stage --anchor-receipt "$ANCHOR"
node scripts/governance-organization-identity-writers.mjs zero --anchor-receipt "$ANCHOR"
```

Expected after generating `B4_PROJECTION_CUTOVER`: stage exit 0 with only the materialization writer; zero exit 1 with exactly one finding.

- [ ] **Step 8: Run API checks and commit**

Dispatch canonical `task-14-api-full.json` as `API_VERIFY_V1`; the direct block is diagnostic expansion.

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

- [ ] **Step 9: Run Task 14 independent scoped review/fix loop**

Review composite receipt per chunk, governed Raw persistence, outcome writes, no contact writer and exact `2 → 1`. Gate `task-14-projection-cutover-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1`; fix/retest/review before Task 15.

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
- Create local scoped review/receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-15-materialization-cutover-review.md`, `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-15-materialization-cutover-review.json`
- Test: all listed materialization specs
- Test static DB contract: `apps/api/src/discovery/discovery-company-materialization-functions.inventory.spec.ts`

**Interfaces:**

- Consumes: accepted B0 migration authority containing exact 0M static/DB/security/disposable receipts; batch transaction/fence/suppression snapshot; composite lock receipt; resolver outcomes; expanded C-TX append contract.
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
- no migration/schema byte changes after the accepted 0M base.

- [ ] **Step 2: Run the intentional RED**

Run:

```bash
pnpm --filter @global/api exec vitest run \
  src/temporal/discovery-company-materialization-organization-identity.spec.ts \
  src/discovery/discovery-company-materialization-ctx.spec.ts
```

Expected: diagnostic FAIL on current `identityLink.create`, manual identity advisory lock, absent resolver call, and `identity_v2` rejection. Canonical `task-15-api-red.json` under `API_VERIFY_V1` records the expected RED.

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

- [ ] **Step 6: Consume accepted 0M and preserve C-TX outcome semantics**

Before source cutover, verify accepted B0 migration authority contains the exact 0M path/SHA/reviews/disposable receipt and that no later migration exists. Fresh `bound/created` may merge caller-owned Canonical fields and create exact FieldEvidence, then return `CREATED|UPDATED|LINKED`; replay/legacy return `REUSED`; conflict emits `companyParse: { status: "INVALID", reasonCode: "IDENTITY_CONFLICT" }`. Add `identity_v2` to the application match-rule set now that the accepted database CHECK permits exactly those new values.

- [ ] **Step 7: Update existing materialization tests without weakening fences/replay**

Keep admission, inspection, fence, batch order, suppression snapshot digest, response-loss readback, finalization, and workflow-no-patch tests. Replace direct writer expectations with resolver/link-readback expectations. Add a mutation that reintroduces `identityLink.create` and ensure scanner zero catches it.

- [ ] **Step 8: Run focused GREEN and static DB function tests**

Dispatch `task-15-api-focused-green.json` as `API_VERIFY_V1` and `task-15-migration-static.json` as `MIGRATION_STATIC_VERIFY_V1`; the direct block is diagnostic expansion.

```bash
pnpm --filter @global/api exec vitest run \
  src/temporal/discovery-company-materialization-organization-identity.spec.ts \
  src/temporal/discovery.activities.spec.ts \
  src/temporal/discovery-company-materialization.activities.contract.spec.ts \
  src/discovery/discovery-company-materialization-ctx.spec.ts \
  src/discovery/discovery-company-materialization-functions.inventory.spec.ts
node --test packages/db/test/organization-identity-materialization-outcome-compat.spec.mjs
```

Expected: PASS; B4M creates/edits no migration beyond the already accepted 0M base.

- [ ] **Step 9: Generate B4M stage and prove first live zero**

Dispatch `task-15-stage.json` as `SCANNER_STAGE_V1` and `task-15-zero.json` as `SCANNER_ZERO_V1`; both bind the protected anchor and fresh Task 15 run receipt. The direct block is diagnostic expansion.

```bash
ANCHOR=/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json
node scripts/governance-organization-identity-writers.mjs stage --anchor-receipt "$ANCHOR"
node scripts/governance-organization-identity-writers.mjs zero --anchor-receipt "$ANCHOR"
```

Expected after generating `B4M_MATERIALIZATION_CUTOVER`: both commands exit 0, delegate finding set is empty, raw closure/build/migration authority remain exact.

- [ ] **Step 10: Run API/static migration checks and commit**

Dispatch `task-15-api-full.json` as `API_VERIFY_V1` and `task-15-migration-full.json` as `MIGRATION_STATIC_VERIFY_V1`; the direct block is diagnostic expansion.

```bash
pnpm --filter @global/api lint
pnpm --filter @global/api build
pnpm --filter @global/api test
node --test \
  packages/db/test/organization-identity-materialization-outcome-compat.spec.mjs \
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

- [ ] **Step 11: Run Task 15 independent scoped review/fix loop**

Review accepted 0M dependency, `identity_v2`/`IDENTITY_CONFLICT` DB+application agreement, C-TX fences/replay/outcomes and exact `1 → 0`. Gate `task-15-materialization-cutover-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1`; fix/retest including 0M static tests and review before Task 16.

### Task 16: B5 Mandatory Zero, Downstream Consumers, and Governance Promotion

**Files:**

- Create: `apps/api/src/discovery/organization-identity-caller-cutover-downstream.spec.ts`
- Modify: `scripts/governance-verify.mjs:256-352`
- Modify: `scripts/governance-contracts.spec.mjs`
- Modify: `docs/governance/organization-identity-writer-stage.json`
- Create local scoped review/receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-16-zero-governance-review.md`, `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-16-zero-governance-review.json`
- Test: `scripts/governance-organization-identity-writers.spec.mjs`
- Test: `scripts/governance-contracts.spec.mjs`, `scripts/governance-path-contracts.spec.mjs`
- Test: `.github/workflows/governance.yml`, `.github/workflows/ci.yml`, `.github/workflows/organization-identity-writer-anchor.yml` through governance topology tests
- Test downstream: `apps/api/src/temporal/candidate-assessment.spec.ts`, `apps/api/src/discovery/company-enrichment-commit.spec.ts`, `apps/api/src/signals/intent-recompute.service.spec.ts`, `apps/api/src/intent/website-watch.service.spec.ts`, `apps/api/src/temporal/patents-cache.activities.spec.ts`, `apps/api/src/lead/lead.service.synthetic.spec.ts`

**Interfaces:**

- Consumes: first live zero at B4M, accepted scanner zero command, exact protected anchor, unchanged CanonicalCompany/FieldEvidence reader contracts.
- Produces: `B5_ZERO_GATE`; mandatory zero inside `governance:verify`; evidence that qualification, enrichment, signals, watch, patent, and lead readers still consume the same Canonical/Evidence state.

**Commit message:** `ci: require zero organization identity delegate writers`

- [ ] **Step 1: Write the governance-promotion RED**

Add a contract test that supplies `B5_ZERO_GATE` through the accepted bootstrap and requires zero, fails on one writer/exit 2 and cannot be downgraded. Mutate ordinary PR CI to prove its CI context fails when bypassed, and separately mutate the protected anchor workflow to prove base-owned event/workflow/PR-as-data authority cannot be replaced by ordinary PR execution.

- [ ] **Step 2: Write the downstream consumer RED/continuity spec**

Build one immutable CanonicalCompany plus Raw-backed FieldEvidence fixture shaped exactly as the caller contribution from `created/bound`. Feed it through qualification, enrichment commit readback, signal recompute, website-watch admission, patent-cache association, and lead serialization boundaries. Assert no consumer requires a direct IdentityLink write or a new resolver outcome field.

- [ ] **Step 3: Run the RED before promotion**

Run:

```bash
node --test --test-name-pattern='identity writer zero promotion' scripts/governance-contracts.spec.mjs
pnpm --filter @global/api exec vitest run \
  src/discovery/organization-identity-caller-cutover-downstream.spec.ts
```

Expected: diagnostic governance test FAIL because current B0 wiring still selects stage rather than mandatory zero at B5. Canonical `task-16-governance-red.json` under `GOVERNANCE_VERIFY_V1` records the expected RED. The downstream test may already pass; if it fails, fix only test harness assumptions or a proven caller-consumer regression, never broaden a consumer to legacy IdentityLink writes.

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

Dispatch `task-16-stage-generate.json` as `SCANNER_STAGE_V1` to generate `B5_ZERO_GATE` against the same zero source tree. The only governance manifest changed is the stage JSON; scanner, tests, baselines, acceptance, and derivation rules remain accepted-parent bytes.

- [ ] **Step 6: Run mandatory zero and governance GREEN locally**

Dispatch `task-16-scanner-test.json` as `SCANNER_TEST_V1`, `task-16-stage.json` as `SCANNER_STAGE_V1`, `task-16-zero.json` as `SCANNER_ZERO_V1`, and `task-16-governance.json` as `GOVERNANCE_VERIFY_V1`; the direct block is diagnostic expansion.

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

Dispatch canonical `task-16-downstream-api.json` as `API_VERIFY_V1`; the direct block is diagnostic expansion.

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

Dispatch `task-16-governance-topology.json` as `GOVERNANCE_VERIFY_V1` and `task-16-runtime-artifact.json` as `RUNTIME_ARTIFACT_VERIFY_V1`; the direct block is diagnostic expansion.

```bash
node --test \
  scripts/governance-contracts.spec.mjs \
  scripts/governance-path-contracts.spec.mjs \
  scripts/runtime-artifact-contract.spec.mjs
```

Expected: required Governance context still reaches mandatory zero; scanner/tests/manifests remain absent from compiled/release/OCI fixtures.

- [ ] **Step 9: Run full local non-runtime verification and commit**

Dispatch `task-16-prisma.json` as `PRISMA_GENERATE_V1`, `task-16-api-full.json` as `API_VERIFY_V1`, and `task-16-migration-static.json` as `MIGRATION_STATIC_VERIFY_V1`; the direct block is diagnostic expansion.

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

- [ ] **Step 10: Run Task 16 independent scoped review/fix loop**

Review mandatory zero non-downgrade, downstream continuity, base-owned anchor topology and runtime exclusion. Gate `task-16-zero-governance-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1`; fix/retest/review before Task 17.

### Task 17: B6 Mixed-Fleet, Old/New Replay, Races, and Disposable PostgreSQL Proof

**Files:**

- Create: `apps/api/src/discovery/organization-identity-artifact-b-mixed-fleet.spec.ts`
- Create: `apps/api/test/fixtures/organization-identity-artifact-b-writers.disposable.ts`
- Create: `packages/db/test/organization-identity-artifact-b-cutover.disposable.spec.mjs`
- Modify: `docs/governance/organization-identity-writer-stage.json`
- Create local scoped review/receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-17-mixed-fleet-review.md`, `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-17-mixed-fleet-review.json`
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

Expected: diagnostic FAIL until the harness is connected to all three cutover callers and old/new replay contracts. Canonical `task-17-api-red.json` under `API_VERIFY_V1` records the expected RED.

- [ ] **Step 5: Implement the minimal pure harness and reach GREEN**

Reuse actual caller functions and Artifact A resolver types with bounded fakes; do not add a product compatibility path. The only old writer exists inside the test harness/fixture and is excluded from product build/artifacts.

- [ ] **Step 6: Request explicit disposable PostgreSQL/container authorization**

Before running the enabled test, present exact image digest, loopback port policy, resource names/labels, migration list, data shape, time/resource caps, and cleanup commands. This authorization is separate from plan approval, code implementation, remote merge, retained database, deployment, and runtime authorization.

- [ ] **Step 7: Run the authorized disposable GREEN packet**

Only after authorization, dispatch canonical `task-17-disposable.json` as `MIGRATION_DISPOSABLE_VERIFY_V1` with exact image/topology/resources/caps and the fresh Task 17 run receipt. The direct block is diagnostic expansion:

```bash
ORGANIZATION_IDENTITY_B6_DISPOSABLE=1 \
  node --test packages/db/test/organization-identity-artifact-b-cutover.disposable.spec.mjs
```

Expected: all scenarios PASS; output contains no URLs, passwords, SQL bodies, customer data, or source text. The test's `after` cleanup confirms the unique container/network/volume no longer exist. If cleanup cannot be proven, report the exact resource IDs without deleting anything outside the receipt.

- [ ] **Step 8: Generate B6 stage and rerun zero/governance**

Dispatch `task-17-stage.json` as `SCANNER_STAGE_V1`, `task-17-zero.json` as `SCANNER_ZERO_V1`, and `task-17-governance.json` as `GOVERNANCE_VERIFY_V1`; the direct block is diagnostic expansion.

```bash
ANCHOR=/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json
node scripts/governance-organization-identity-writers.mjs stage --anchor-receipt "$ANCHOR"
node scripts/governance-organization-identity-writers.mjs zero --anchor-receipt "$ANCHOR"
node scripts/governance-verify.mjs verify --identity-writer-anchor-receipt "$ANCHOR"
```

Expected after generating `B6_CLOSEOUT`: all PASS with zero writers; exact raw/build/migration baselines unchanged.

- [ ] **Step 9: Run the complete final technical packet**

Dispatch `task-17-scanner-test.json` as `SCANNER_TEST_V1`, `task-17-governance-full.json` as `GOVERNANCE_VERIFY_V1`, `task-17-runtime.json` as `RUNTIME_ARTIFACT_VERIFY_V1`, `task-17-migration.json` as `MIGRATION_STATIC_VERIFY_V1`, `task-17-prisma.json` as `PRISMA_GENERATE_V1`, and `task-17-api-full.json` as `API_VERIFY_V1`; the direct block is diagnostic expansion.

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

- [ ] **Step 11: Run Task 17 independent scoped review/fix loop**

Review mixed fleet, old/new replay, suppression/conflict/races, accepted 0M catalog and disposable cleanup. Gate `task-17-mixed-fleet-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1`; any fix reruns affected disposable/static/full packets and repeats review. Task 18 is blocked until PASS.

### Task 18: Final Independent Artifact B Whole Review

**Files:**

- Create (ignored): `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b6-final-code-review.md`
- Create (ignored): `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b6-final-security-review.md`
- Create (ignored): `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b6-final-database-review.md`
- Create local review receipts: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b6-final-code-review.json`, `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b6-final-security-review.json`, `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b6-final-database-review.json`
- Modify: none
- Test: exact local/hosted protected-main anchor, accepted bootstrap/refresh/0M/B0 acceptance, all Task 11–17 review receipts, full v3 range, zero inventory, B1–B6 zero-additional-migration diff, runtime exclusion and disposable cleanup.

**Interfaces:**

- Consumes: clean exact B6 head, protected anchor, accepted launcher/materialization/immutable bootstrap contract, fresh Task 18 run receipt, and all preceding review/evidence identities.
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

Recompute refreshed directory plus exact 0M delta and separate Artifact A function/ACL authority; verify B1–B6 made zero additional migration/schema changes relative to accepted B0 inventory; inspect 0M and B6 disposable receipts; confirm retained failed-deploy recovery remains HOLD, successful rows immutable, ambient INSERT carried to Artifact C and no `_prisma_migrations` manipulation or `migrate resolve` execution.

- [ ] **Step 6: Run the final exact-head verification packet**

Repeat Task 17's full technical packet through the same root-launcher closed commands at the exact review head, plus separately authorized `MIGRATION_DISPOSABLE_VERIFY_V1` when its prior receipt is not exact-head reusable. Do not start a retained service or database.

- [ ] **Step 7: Write and verify the three reports**

Each narrative/receipt names exact subject/range/path/report/counterexample digests, launcher/bootstrap contract/fresh-run/refresh/0M/acceptance/anchor identities and limitations. Machine-gate each receipt separately through `SCOPED_REVIEW_VERIFY_V1`; a finding returns to the owning task, reruns affected proof and repeats all impacted reviews.

- [ ] **Step 8: Confirm the local terminal state and stop**

Run:

```bash
for kind in code security database; do
  REPORT=".superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b6-final-$kind-review.md"
  RECEIPT=".superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b6-final-$kind-review.json"
  test "$(rg -c '^Critical:' "$REPORT")" -eq 1
  test "$(rg -c '^Important:' "$REPORT")" -eq 1
  test "$(rg -c '^Verdict:' "$REPORT")" -eq 1
  rg -qx 'Critical: 0' "$REPORT"
  rg -qx 'Important: 0' "$REPORT"
  rg -qx 'Verdict: PASS' "$REPORT"
node scripts/governance-organization-identity-bootstrap.mjs verify-review \
    --report "$REPORT" --receipt "$RECEIPT" --subject "$B6_HEAD"
done
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

The direct verifier loop is diagnostic. Authority dispatches `task-18-code-review-verify.json`, `task-18-security-review-verify.json`, and `task-18-database-review-verify.json` as separate `SCOPED_REVIEW_VERIFY_V1` requests. Expected GREEN: clean exact B6 head and three zero-C/I reports. The correct conclusion is `CUTOVER_READY_FOR_CONTRACT` for the reviewed Artifact B implementation only. It is not final database authority, deployment, old-worker drain proof, retained migration approval, RuntimeEvidence, Release Bundle, PILOT, GA, Artifact C authorization, push, PR, merge, or worktree cleanup authorization.

**Commit:** none. Any later tracked change requires renewed scoped review.

## Stop Conditions

Stop at the first applicable condition and report the exact evidence boundary:

1. V2 does not descend from final spec `b060c5dd...`, the exact plan is not reviewed/approved/tracked for execution, v3 does not equal the anchored merge, a worktree is dirty, or ownership overlaps.
2. Task 0L tracked launcher review fails; the separately authorized root directory/materialization is absent, non-root, too broadly permissioned, symlinked, TOCTOU-changed, or differs from exact reviewed plan/spec/launcher/bootstrap/contract/tool bytes; the Corepack/pnpm closure omits a shim, `lib/corepack.cjs`, or pnpm entrypoint; a free-form command/env/path is accepted; or current shell/`jq`/PR bytes are used for authority.
3. Task 0P cannot verify accepted config/sentinels/bootstrap/tools before pnpm, cannot distinguish immutable `BootstrapContract` from fresh `BootstrapRunReceipt`, permits an unlisted run field to normalize, cannot use immutable materialization plus `--ignore-scripts --ignore-pnpmfile`/`NPM_CONFIG_USERCONFIG=/dev/null`/fixed roots, observes any hostile marker load/execute, cannot generate/verify Prisma before dynamic TypeScript import, or its scoped review is not PASS.
4. Task 0A validator review has any C/I, permits set/rename/copy/case/owner/conflict/migration/bootstrap drift, free-form command or HOLD to pass.
5. Task 0B missing object yields reviewed `FETCH_AUTH_REQUIRED`; only exact-authorized Task 0F may fetch, then full Task 0B reruns. A missing-object packet never supports merge authorization.
6. Task 0B live/cached/ancestry/path/status/conflict/owner/migration/build/raw/schema/governance/runtime/caller facts are incomplete; the exact harder-copy scan is missing; `AuditReviewReceipt` does not bind the packet/set/authorization digests; or its final packet/review is not PASS.
7. Task 0F's pinned Git lacks `--no-auto-maintenance`/`--no-write-commit-graph`, or its exact fetch writes a ref, `FETCH_HEAD`, maintenance state or commit graph.
8. Task 0C lacks separate merge authorization, its immediately rehashed audit packet/receipt differs, live main drifted, conflicts differ, Copy resolution source is not exactly MAIN_BYTES/WRITE_ELIGIBILITY/SYNC_HUMAN_CITATIONS with required input order, or any stale feature/blanket ours/theirs bytes are used.
9. Refresh/admission parent shapes or review fail, or Artifact A/admitted main ancestry fails. A Task 0C finding abandons/recreates the exact pair; it cannot be forward-fixed atop the admission child.
10. Task 0M path/name/timestamp/preimage drifts, migration file authorization/disposable authorization is absent, timeout/58-byte/CHECK/catalog/dependency/AX/fault/Prisma-ledger/static/DB/security receipt fails, retained recovery is misrepresented as verified, or any second migration/schema/DML/authority change appears.
11. Live main advances before acceptance: abandon the scanner lineage, start only from exact pre-scanner `CURRENT_MAIN_ADMISSION_COMMIT`, rerun 0B/0F/0C/0M and Tasks 1–8. Drift after acceptance abandons acceptance too; never start from 0M/implementation or regenerate existing outputs in place.
12. Any accepted config/build/package/`.dockerignore`/absence-sentinel/declaration/tool/generated-output/native-extractor fact drifts or clean bootstrap no longer reproduces the accepted contracts/receipts.
13. TypeScript cannot build one complete Program from accepted roots, a delegate/raw/wrapper origin is ambiguous, or any refreshed baseline surface lacks a closed disposition.
14. A refreshed project-total measurement exceeds 50% of its fixed limit or any required measurement/raw-review field is missing/extra.
15. Any admitted file/root is symlinked/nonregular/escaped/changed, a manifest path invalid, or redaction fails.
16. A raw capability, wrapper ingress/caller, dependency closure, literal mention, admission/bootstrap/0M or controlled blob drifts outside a closed stage removal.
17. Any scanner/derivation blob changes after Task 5 generation without full baseline/raw regeneration and review, or any refreshed/0M migration or Artifact A function/ACL/six-receipt record differs.
18. B0 implementation/acceptance parent shape, controlled parent blobs or review receipts fail. An acceptance review finding abandons that one-path child, repairs from its exact parent in a dedicated successor, reruns whole review, and creates a new first-add acceptance; no amend or forward fix atop the rejected child.
19. Any scoped review receipt for Tasks 1–6 or 11–17, whole review, acceptance review, 0M review or final review lacks exact unique zero-C/I/PASS fields, subject/range/path/report/counterexample digests, or an unresolved finding fix loop.
20. Immediately pre-call PR head/base is wrong, auto-update/queue rebase active, merge response SHA/GitHub commit+branch ordered-parent readback mismatch, or exact postmerge fetch authorization/local parent verification is absent.
21. Protected-main push initial anchor workflow or base-owned `pull_request_target` identity/receipt fails, ordinary PR CI is treated as authority, or PR-controlled executable/input is used.
22. Any push/PR/merge/readback/re-run/controller/root/v3/disposable action lacks its own authorization; root/local/hosted anchor is missing/mismatched.
23. The stage set is not exactly `3/3/2/2/1/0/0/0`, or zero does not become exit 0 at B4M.
24. A caller needs any migration beyond accepted 0M, generic legacy writer, identity-only lock, synthesized/cross-transaction/workspace receipt, second PrismaClient, provider/model call or new state.
25. Any outcome writes Canonical/Evidence on terminal outcomes, replay changes bytes, B4M lacks accepted 0M, or application/DB disagree on `identity_v2`/`IDENTITY_CONFLICT`.
26. Disposable topology/cleanup or final review/clean-head proof fails.

## Rollback and Cleanup

- Task 0L local launcher changes are ordinary reviewed source commits. Root materialization is create-only under its separate authorization; on mismatch, preserve the failed receipt/materialization evidence and stop. Do not overwrite, recursively delete, chmod-widen or replace it without a new exact root authorization.
- Task 0B is read-only except its local ignored packets; it has no ref/merge rollback. Delete no packet or provenance to disguise a HOLD.
- Task 0F fetches only the exact authorized object and changes no branch/tracking ref; a failed fetch remains a reviewed HOLD and never falls through to merge.
- During an authorized but uncommitted Task 0C merge, unexpected conflict/path facts stop before resolution. Use only the abort/recovery action expressly included in the local-merge authorization and return to the exact clean `branchPreRefreshCommit`; never reset hard, rebase, or use blanket ours/theirs.
- A Task 0C merge/admission review finding preserves and abandons both shape-sensitive commits, returns to exact `BRANCH_PRE_REFRESH_COMMIT`, reruns full 0B and obtains fresh local-merge authorization before recreating/reviewing both commits. No child fix commit repairs that pair.
- Main drift abandons the implementation lineage and restarts only from exact pre-scanner `CURRENT_MAIN_ADMISSION_COMMIT`, whose tree lacks 0M/scanner/manifests. It reruns refresh and separately authorized 0M, then creates scanner/baseline outputs anew. Never start a drift rebuild from 0M/implementation or in-place overwrite accepted candidates.
- After acceptance main drift, preserve the abandoned acceptance branch and create the exact SHA-suffixed successor worktree only after its own local authorization, starting from the same pre-scanner `CURRENT_MAIN_ADMISSION_COMMIT`. Rerun 0B/0F/0C/0M and Tasks 1–8 so the replacement acceptance remains a genuine first-add.
- For an acceptance scoped-review defect without main drift, preserve the rejected child and create a dedicated repair worktree from its exact `B0_IMPLEMENTATION` parent, where the acceptance path is absent. Make forward implementation fixes there, rerun Task 7, then first-add/review a new acceptance. Never fix atop or amend the rejected child.
- Before the B0 remote merge, rollback is preserving and abandoning the v2 branch/worktree after provenance capture. Do not reset Artifact A, admitted main, the failed v1 branch, or another writer's state.
- Never amend/rewrite `B0_IMPLEMENTATION` or `B0_ACCEPTANCE` after review. Drift after acceptance abandons that sequence and creates a new reviewed refresh/implementation/acceptance lineage; it does not replace history.
- After the protected-main merge, do not revert/delete the root-only anchor or controller identities to hide history. A correction is forward-only and separately reviewed.
- B1–B6 rollback before any future merge is v3 branch abandonment or forward revert commits under review. Do not resume implementation on v2.
- Artifact B has exactly one 0M forward migration. Before retained application there is only source/disposable rollback; once successfully applied, its migration row/bytes are immutable and semantic rollback is a later forward migration. Failed retained deploy recovery remains unverified; never improvise `migrate resolve` or edit ledger/migration bytes.
- The B6 disposable harness removes only its uniquely labeled container/network/volume and temp directory. It never deletes a retained/shared `global-*` resource. If cleanup fails, report exact created resource IDs and request direction.
- No worktree, branch, PR, remote ref, root receipt, review report, or evidence is deleted without a separate ownership/provenance audit and authorization.
- After future Artifact C, rollback floor is Artifact B; ambient IdentityLink INSERT is never restored. Artifact C is outside this plan.

## Estimated Active Time

External review queues, authorization waits, GitHub checks, merge queues, and human response time are not included.

| Phase                                           | P50 active | P90 active | Included work; external waiting excluded                                                           |
| ----------------------------------------------- | ---------: | ---------: | -------------------------------------------------------------------------------------------------- |
| Final-spec/plan amendment and review-fix intake |       10 h |       24 h | spec deltas, prior/final 1C/9I/4M and 1C/5I/2M dispositions, plan correction/review rounds         |
| 0L launcher/root trust materialization          |       16 h |       36 h | closed parser, wrapper/controller, executable closure, hostile tests, review/root readback fixes   |
| 0P bootstrap                                    |       12 h |       24 h | external receipt, immutable materialization, pnpm hooks, tool roots, hostile markers, review fixes |
| 0A/0B/0F/0C refresh                             |       20 h |       44 h | validator, audit, optional fetch cycle, Copy resolutions, refresh review fixes                     |
| 0M migration                                    |       20 h |       48 h | static migration, counterexample repair, authorized disposable, DB/security review fixes           |
| Tasks 1–6 B0 scanner/governance                 |       52 h |      110 h | build closure, compiler/raw engines, per-task reviews and fixes, protected workflow                |
| Tasks 7–10 acceptance/remote/v3                 |       14 h |       30 h | whole review, acceptance review, merge/readback/fetch run cards, v3 bootstrap                      |
| Tasks 11–17 caller cutover                      |       48 h |      100 h | TDD, per-task review/fix rounds, authorized disposable reruns                                      |
| Task 18 final whole reviews                     |       10 h |       24 h | independent code/security/DB counterexamples and repair reruns                                     |
| One main-drift full rebuild contingency         |       36 h |       80 h | successor, 0B/0F/0C/0M, regenerated baselines and reviews                                          |
| **Total active excluding external waits**       |  **238 h** |  **520 h** | Arithmetic sum; P90 includes one drift rebuild and two substantive counterexample/fix rounds       |

## Execution Completion Boundary

Execution is complete only when all 25 task gates (`0L`, `0P`, `0A`, `0B`, `0F`, `0C`, `0M`, and `1`–`18`) and scoped/whole reviews PASS at one clean B6 head; accepted launcher/root materialization, immutable bootstrap contract plus fresh-run receipts, refresh/admission, 0M migration/disposable, scanner/raw/build/tool roots, B0 acceptance, local/root/hosted anchors and stage zero all agree. Handoff lists every commit, ordered parent, workflow/run, receipt, migration/catalog, bootstrap/tool/raw measurement and review identity plus retained/deployment/Artifact C HOLDs.

This plan's completion/review authorizes no implementation. Future plan approval covers only Task 0L tracked local design/tests/review plus 0P/0A/0B; it does not authorize 0L root materialization. Root launcher materialization, Task 0F fetch, 0C merge/admission, 0M migration file, 0M disposable, Tasks 1–8 scanner, push, PR, GitHub merge/readback/re-run, postmerge fetch, controller/root anchor receipt, v3 and later disposable/runtime actions each retain separate exact gates.
