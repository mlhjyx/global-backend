# Organization Identity Writer Ban-at-Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a branch-external root-only closed-command launcher and clean pre-execution bootstrap trust root, admit exact current main, add the sole reviewed C-TX compatibility migration, freeze a complete refreshed build/raw/migration writer baseline, and then replace the three `IdentityLink.create` callers in the machine-checked `3 → 2 → 1 → 0` sequence.

**Architecture:** Task 0L first creates, tests, and independently reviews a tracked stdlib-only closed-command launcher/controller. Task 0P then creates/reviews the immutable bootstrap contract and fresh-run engine; only afterward does Task 0L resume under separate authorization to materialize the exact accepted launcher/bootstrap bytes in the root-only branch-external directory. Task 0A consumes those reviewed trust roots to create the admission validator; Task 0B audits live main without fetch; Task 0F is the only fetch-only interstitial when the object is missing; Task 0C creates the exact two-parent refresh merge and one-parent admission child under separate authorization; Task 0M creates the sole additive compatibility migration under its own migration/disposable/review gates. Scanner derivation is fixed by Tasks 1–4 before Task 5 generates/reviews the final raw/build baseline; Task 6 wires governance; Tasks 7–8 review and accept B0. Hosted authority comes only from the protected-main/base-owned anchor workflow, never the ordinary PR workflow or PR-controlled launcher bytes.

**Tech Stack:** Node.js 22 ESM, TypeScript 5.9.3 compiler API, Prisma/@prisma/client 6.19.3, Vitest 4, Node test runner, Git object plumbing, JSON Schema-shaped closed records, pnpm 9.15.9, GitHub Actions, PostgreSQL 16 disposable verification, Docker/OCI artifact checks.

**Spec:** `docs/superpowers/specs/2026-09-01-organization-identity-writer-ban-at-source-design.md` at exact final confirmed commit `b060c5dd4afef9fe42dfe510b02f930f56cdf7fe`, SHA-256 `536e376a40d9ef4f49a65bc0224b74d58eb8a2d743fa766aa020397e67279dd4`.

## Global Constraints

- Exact final-spec confirmation authorizes only this plan drafting. It does not authorize bootstrap/validator/scanner/workflow/migration implementation, dependency installation/generation, fetch/ref update, local merge/commit, push, PR, GitHub merge/readback, controller/root actions, v3, database/container/runtime/provider/credential/deployment, cleanup, or Artifact C.
- After an independent review of this exact plan reaches zero Critical/Important, a future exact plan approval authorizes only Task 0L's tracked local launcher/external-controller contract design, non-authority development tests and review, plus Tasks 0P, 0A, and 0B local code/tests/documents/read-only audit. It does not authorize any local launcher or GitHub/Gitleaks/disposable/protected-base controller materialization, credential-handle access, authority-bearing bootstrap, fetch, local merge, Task 0M migration bytes, disposable PostgreSQL, scanner Tasks 1–8, or remote mutation.
- Root materialization of the exact reviewed Task 0L local launcher/bootstrap/contract requires its own future exact authorization and covers one closed surface only: four launcher files below `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher/`; seven immutable regular files below `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root/`; runtime roots below `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime/`; and the separate request/output roots. Every created directory is `root:root` mode `0700`; copied executable binaries `env`/`node`/`git` are `0500`; copied JavaScript tool files `corepack.js`, `lib/corepack.cjs`, `bin/pnpm.cjs`, and `dist/pnpm.cjs` are regular files mode `0400`; launcher wrapper/launcher/bootstrap are `0500`; contract/readback/receipt/review files are `0600`; canonical request/output records stay `0600` inside `0700` roots. No approval of this plan or local Task 0L commit implies any root write.
- The GitHub, Gitleaks, disposable PostgreSQL, root-anchor and protected-base launcher controllers each require a distinct exact contract/materialization authorization and independent controller security review before their first use. GitHub credential handles, synthetic disposable credentials and hosted event/controller inputs are typed opaque handles/records; no credential value may enter a request, log, receipt or repository file. The root-anchor controller accepts no credential ingress at all.
- Task 0F requires a separate exact fetch-only authorization naming remote/ref/SHA and performs no merge. Task 0C requires a later, distinct authorization naming the reviewed PASS audit, branch preimage, admitted main, exact conflict set and resolution rules. Task 0M migration-file creation requires another exact authorization; its disposable PostgreSQL run requires a separate database/container authorization. Scanner Tasks 1–8 require a separate scanner implementation authorization after 0M reviews are accepted.
- Fetching an absent exact object/ref requires a separate authorization naming remote, ref, and SHA. Creating exact `B0_REFRESH_BASE_COMMIT` as the local two-parent refresh merge and exact `CURRENT_MAIN_ADMISSION_COMMIT` as its one-parent admission child requires another separate authorization naming the branch pre-refresh SHA, admitted live-main SHA, expected conflict paths, and closed resolution rules.
- Scanner/baseline Tasks 1–8 begin only after Task 0C produces the reviewed refresh/admission chain and Task 0M produces the reviewed `B0M_MIGRATION_COMMIT` plus authorized disposable PASS. Their execution HEAD descends from 0M, while product/raw/build baselines read `B0_REFRESH_BASE_COMMIT` and migration authority freezes the refresh directory plus the sole 0M delta. Push, PR create/update, GitHub merge/readback, hosted-run recovery, root receipt, v3 creation, and every later external action remain separate gates.
- A direct current-shell `node`, `pnpm`, `git`, `gh`, `gitleaks`, `docker`, `psql`, `jq`, package-script or unreviewed branch-local bootstrap invocation is diagnostic/non-authoritative only. Local bootstrap/scanner/test/static/migration-source authority uses only the root launcher and its exact local executable closure. Remote GitHub/fetch authority, Gitleaks, disposable PostgreSQL and root-anchor creation use only their matching branch-external controller receipts. Hosted B1–B6 authority uses only `ProtectedBaseLauncherReceipt`. Neither the local launcher nor the GitHub controller may write the anchor; they may only verify the completed root-anchor evidence as typed input data.
- Every local closed command creates exactly one fresh `BootstrapRunReceipt`; tasks with multiple commands create the same number of receipts and may bind them with one sorted `BootstrapRunReceiptSet`. One receipt may never authorize or attest two request IDs, modes or command IDs.
- Narrow trust-artifact style exceptions: only `scripts/governance-organization-identity-launcher.mjs` and `scripts/governance-organization-identity-bootstrap.mjs` may exceed the repository's ordinary 800-line ceiling, because both are self-contained `node:`-only files whose complete sources are independently hashed, reviewed for cohesion/function size and hostile coverage, and materialized inside the exact launcher-plus-tool-root trust set. The exception is path-specific and is not transferable to controller modules, tests, or later scanner code; an unreviewed helper split, package import, unrelated growth, or failure to review either full file invalidates that file's exception and is a plan stop.
- Task 0L has no accepted root/external compatibility assumption. Because no accepted root launcher, external controller or anchor materialization exists yet, the shared controller contract, controller materialization, controller review, GitHub request/receipt, root-anchor upstream and root-operation schemas may and must bump cleanly to `/v2` where that removes an ambiguous `/v1` shape. Future validators may read historical `/v1` review reports only as non-authority diagnostics; an authority receipt must validate the exact `/v2` schema named by the current reviewed controller contract.
- Every Task 0L file except `scripts/governance-organization-identity-launcher.mjs` must remain below 800 lines at commit time. Shared fixtures, launcher specs, root-anchor closure specs and root-anchor filesystem helpers are split before the next review if needed; exceeding the ceiling is a plan stop, not a reviewer preference.
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
- B1–B6 local runs require both `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json` and the external `root-anchor-operation-review.json` as explicit CLI inputs. `ANCHOR_ONLY` reopens the anchor and verifies the full root-anchor controller contract/materialization/review/request/write/readback/operation-review chain before accepting its SHA. Hosted authority requires protected-main `push` at the exact B0 merge SHA or base-owned `pull_request_target` plus exact `ProtectedBaseLauncherContract`/receipt/equivalence and GitHub-controller receipts; ordinary `pull_request` governance remains non-authoritative CI.
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

| File                                                                                                              | Responsibility                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/governance-organization-identity-launcher.mjs`                                                           | Stdlib-only exact-key closed-command controller source; parses requests before dependency load and invokes only contract-bound command IDs through the accepted clean environment.                                                      |
| `scripts/governance-organization-identity-launcher-request.spec.mjs`                                              | Closed request/parser/payload/input/output/path/replay hostile fixtures; created by splitting the old launcher spec before the next Task 0L review.                                                                                     |
| `scripts/governance-organization-identity-launcher-trust.spec.mjs`                                                | Launcher trust-root, executable closure, materialization readback and `VerifiedWorktreeReceiptV1` hostile fixtures; kept below 800 lines.                                                                                               |
| `scripts/governance-organization-identity-launcher-execution.spec.mjs`                                            | Local dispatcher, argv expansion, no external executable, no dependency preload and controller-owned execution-loop fixtures; kept below 800 lines.                                                                                     |
| `scripts/governance-organization-identity-test-fixtures.mjs`                                                      | Shared null-prototype canonical JSON, digest, temp-root, fake adapter and receipt builders used by all Task 0L specs; contains no authority logic or controller dispatch.                                                               |
| `scripts/governance-organization-identity-controller-contracts.mjs`                                               | Single stdlib-only exact-key GitHub/Gitleaks/disposable/protected-base/root-anchor contract, request, receipt, source-closure, upstream-closure and independent-review validator layer; contains no credential values or tool dispatch. |
| `scripts/governance-organization-identity-controller-contracts.spec.mjs`                                          | Mutation fixtures for omitted executables, open operations/payloads, credential values, event drift, request replay and cross-controller receipt substitution.                                                                          |
| `scripts/governance-organization-identity-github-controller.mjs`                                                  | Branch-external GitHub/remote-Git controller with the exact reviewed operation registry and opaque credential-handle ingestion.                                                                                                         |
| `scripts/governance-organization-identity-github-controller.spec.mjs`                                             | Closed push/PR create/update/readback/rules/checks/merge/parent/workflow/variable/fetch controller fixtures.                                                                                                                            |
| `scripts/governance-organization-identity-disposable-postgres-controller.mjs`                                     | Separately authorized Docker/psql/Prisma disposable controller enforcing loopback/no-egress/resources/caps/cleanup.                                                                                                                     |
| `scripts/governance-organization-identity-disposable-postgres-controller.spec.mjs`                                | Exact executable/process-tree, synthetic-credential-handle, topology, scenario and cleanup mutation fixtures.                                                                                                                           |
| `scripts/governance-organization-identity-gitleaks-controller.mjs`                                                | No-credential Gitleaks controller pinned to exact executable/config/source-tree/request/result schemas.                                                                                                                                 |
| `scripts/governance-organization-identity-gitleaks-controller.spec.mjs`                                           | Executable/config/source/redaction/result and no-credential-ingress mutation fixtures.                                                                                                                                                  |
| `scripts/governance-organization-identity-root-anchor-controller.mjs`                                             | No-credential branch-external anchor writer enforcing typed genesis input, canonical payload, create-exclusive write/fsync and non-self-hashing evidence; delegates all upstream-closure validation to shared contracts.                |
| `scripts/governance-organization-identity-root-anchor-filesystem.mjs`                                             | Optional root-anchor filesystem-only helper if removing duplicated validators does not bring the entry module below 800 lines; owns no schema decisions.                                                                                |
| `scripts/governance-organization-identity-root-anchor-closure.spec.mjs`                                           | Root-anchor upstream-closure, cross-record invariant, final controller digest and same-shape substitution hostile fixtures; kept below 800 lines.                                                                                       |
| `scripts/governance-organization-identity-root-anchor-filesystem.spec.mjs`                                        | Root-anchor path, no-follow, create-exclusive, fsync, inode/device/mode and TOCTOU hostile fixtures; kept below 800 lines.                                                                                                              |
| `scripts/governance-organization-identity-bootstrap.mjs`                                                          | Stdlib-only accepted-subject/config/sentinel/declaration/tool/generated-output preflight, clean Prisma generation, dynamic TypeScript/scanner import and review-receipt validator.                                                      |
| `scripts/governance-organization-identity-bootstrap.spec.mjs`                                                     | Hostile env/preload/pnpmfile/lifecycle/config/store/tool/symlink/TOCTOU marker tests proving no hostile body loads or executes.                                                                                                         |
| `scripts/governance-organization-identity-bootstrap-supplemental.spec.mjs`                                        | Bounded `<800` Task 0P supplemental hostile/coverage suite for bootstrap-only assertions already split out of the main bootstrap spec; it does not absorb launcher trust, canonical-output, or default-Git launcher coverage.           |
| `docs/governance/organization-identity-bootstrap-contract.json`                                                   | Immutable request/config-derivation/environment-schema/logical-tool/declaration/generation/comparator rules; subject config, roots, inodes, resolved paths and timestamps are excluded.                                                 |
| `scripts/governance-organization-identity-current-main-admission.mjs`                                             | Closed current-main schema, exact Git set/conflict/migration validator, deterministic metadata-only generator, and closed Copy command registry.                                                                                        |
| `scripts/governance-organization-identity-current-main-admission.spec.mjs`                                        | Pre-refresh exact-set, rename/case collision, conflict/generator provenance, migration disposition, and HOLD mutation tests.                                                                                                            |
| `docs/governance/organization-identity-current-main-admission.json`                                               | First-added or precisely refreshed only in `CURRENT_MAIN_ADMISSION_COMMIT`, the one-parent child of two-parent `B0_REFRESH_BASE_COMMIT`; binds admitted main, merge/parents, complete sets, deltas, and pre-merge review digest.        |
| `scripts/governance-organization-identity-writers.mjs`                                                            | CLI, command routing, external-anchor admission, deterministic closed output.                                                                                                                                                           |
| `scripts/governance-organization-identity-writers-contracts.mjs`                                                  | Closed enums, schemas, canonical JSON, budgets, result normalization.                                                                                                                                                                   |
| `scripts/governance-organization-identity-writers-files.mjs`                                                      | Git-object reader, build-surface pinning, lstat/realpath/symlink/TOCTOU protections.                                                                                                                                                    |
| `scripts/governance-organization-identity-writers-typescript.mjs`                                                 | One-program/one-checker delegate, raw-capability, wrapper-ingress, and dependency-closure engine.                                                                                                                                       |
| `scripts/governance-organization-identity-writers-baseline.mjs`                                                   | Refreshed build/raw/current-migration baseline generation plus separate Artifact A resolver/function/ACL/six-receipt verification.                                                                                                      |
| `scripts/governance-organization-identity-writers.spec.mjs`                                                       | Literal scanner fixtures, mutation tests, hostile filesystem tests, manifest tests, bounds, redaction, stage, anchor, and runtime exclusion.                                                                                            |
| `docs/governance/organization-identity-writer-baseline.json`                                                      | Exact `B0_REFRESH_BASE_COMMIT` build/raw closure/wrapper ingress/delegate inventory, refreshed budget measurements, hashes, and dispositions.                                                                                           |
| `docs/governance/organization-identity-migration-authority.json`                                                  | Complete refreshed migration directory/checksums/last-change/current-main dispositions plus Artifact A resolver/function/ACL/table privilege authority.                                                                                 |
| `docs/governance/organization-identity-artifact-a-acceptance.json`                                                | Durable, non-secret exact Artifact A head/range and six source-receipt identities.                                                                                                                                                      |
| `docs/governance/organization-identity-writer-stage.json`                                                         | Closed stage plus scan-result observation digest only.                                                                                                                                                                                  |
| `docs/governance/organization-identity-writer-acceptance.json`                                                    | Created later in the one-path `B0_ACCEPTANCE` commit; absent from every B0 implementation commit.                                                                                                                                       |
| `packages/db/prisma/migrations/20260902090000_organization_identity_materialization_outcome_compat/migration.sql` | Sole Artifact B DDL-only migration expanding the exact C-TX CHECK for `identity_v2` and `IDENTITY_CONFLICT`.                                                                                                                            |
| `packages/db/test/organization-identity-materialization-outcome-compat.spec.mjs`                                  | Static exact source/catalog/timeout/name/no-DML/migration-order/provenance tests.                                                                                                                                                       |
| `packages/db/test/organization-identity-materialization-outcome-compat.disposable.spec.mjs`                       | Separately authorized PostgreSQL 16 fresh/upgrade/lock/fault/catalog/Prisma-ledger/cleanup proof.                                                                                                                                       |
| `.github/workflows/organization-identity-writer-anchor.yml`                                                       | Protected-main `push` initial anchor and base-owned `pull_request_target` B1–B6 verifier; never executes PR-controlled bytes.                                                                                                           |
| `scripts/governance-organization-identity-protected-base-launcher.mjs`                                            | Hosted protected-base materialization/event/runner/tool/request verifier and local-to-hosted equivalence checker; never executes PR bytes.                                                                                              |
| `scripts/governance-organization-identity-protected-base-launcher.spec.mjs`                                       | Hosted path/uid/runner/event/controller-variable/TOCTOU/equivalence and PR-no-execution fixtures.                                                                                                                                       |

The flat helper filenames intentionally match the terminal CODEOWNERS pattern `/scripts/governance-*.mjs`; no unowned helper directory is introduced.

The separately authorized local launcher materialization is not a repository-created file set. Its launcher subtree contains four controlled files at `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher/identity-writer-launch`, `identity-writer-launch.mjs`, `identity-writer-bootstrap.mjs`, and `launcher-contract.json`. Its immutable tool-root subtree contains exactly seven controller-owned regular files: `tool-root/bin/env`, `tool-root/bin/node`, `tool-root/bin/git`, `tool-root/lib/corepack/dist/corepack.js`, `tool-root/lib/corepack/dist/lib/corepack.cjs`, `tool-root/lib/pnpm/9.15.9/bin/pnpm.cjs`, and `tool-root/lib/pnpm/9.15.9/dist/pnpm.cjs`. Its runtime subtree contains one `0700` parent plus the six exact wrapper environment roots `home`, `xdg-config`, `xdg-cache`, `corepack-home`, `pnpm-home`, and `tmp`. Authority now splits immutable pre-materialization plan data from post-write observations: the reviewed `LauncherContract/v3` defines only wrapper/launcher destination plan, contract self-path policy, fixed destination closure layout, exact path digests, modes, sizes and chronology, and explicitly excludes bootstrap identity so `launcherContractSha256` is the real SHA-256 of canonical `LauncherContract/v3` bytes rather than a projection digest. Exact bootstrap bytes live only in `LauncherMaterializationPacket/v4` and the later post-write readback/materialization/review chain, while device/inode observations appear only in `LauncherReadbackReport/v2` and `LauncherMaterializationReceipt/v3` after write/fsync/readback. Historical `LauncherContract/v2`, `LauncherMaterializationPacket/v2` and `/v3`, `LauncherReadbackReport/v1`, `LauncherMaterializationReceipt/v2`, and `LauncherMaterializationReviewReceipt/v2` remain `HISTORICAL/HOLD` diagnostics only and are not authority-compatible.

The GitHub, Gitleaks, disposable PostgreSQL and root-anchor controllers are separately materialized only under their own exact future authorizations beneath `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/{github,gitleaks,disposable-postgres,root-anchor}/`. Each directory has its own contract, executable/controller source, request/output roots, materialization receipt and review receipt; no controller shares an executable closure, environment, credential handle or authorization with the local launcher or another controller.

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
  | "CURRENT_MAIN_AUDIT_LOCAL_V1"
  | "CURRENT_MAIN_VALIDATE_V1"
  | "CURRENT_MAIN_GENERATE_V1"
  | "COPY_WRITE_ELIGIBILITY_V1"
  | "COPY_SYNC_CITATIONS_V1"
  | "GIT_REFRESH_START_V1"
  | "GIT_REFRESH_COMMIT_V1"
  | "GIT_ADMISSION_COMMIT_V1"
  | "GIT_ACCEPTANCE_COMMIT_V1"
  | "REFRESH_VERIFY_V1"
  | "MIGRATION_STATIC_VERIFY_V1"
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
  | "V3_WORKTREE_CREATE_V1";

type TaskId =
  | "0L"
  | "0P"
  | "0A"
  | "0B"
  | "0F"
  | "0C"
  | "0M"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "10"
  | "11"
  | "12"
  | "13"
  | "14"
  | "15"
  | "16"
  | "17"
  | "18";

type ExecutableClosureEntry = Readonly<{
  role:
    | "ENV"
    | "NODE"
    | "GIT"
    | "COREPACK_SHIM"
    | "COREPACK_LIB_COREPACK_CJS"
    | "PNPM_SHIM"
    | "PNPM_ENTRYPOINT";
  logicalIdentity: string;
  executablePath: string;
  realpathSha256: string;
  sha256: string;
  size: number;
  mode: number;
}>;

// `COREPACK_SHIM` and `PNPM_SHIM` remain the logical role names used by
// reviewed contracts and receipts. Under the separately authorized local root
// materialization they map to controller-owned regular-file copies inside
// `tool-root`, never live symlinks to `~/.fnm`, `/root/.cache`, or another
// mutable user path.

type RootControlledFile<Name extends string, Mode extends number> = Readonly<{
  basename: Name;
  mode: Mode;
  device: string;
  inode: string;
  realpathSha256: string;
  sha256: string;
  size: number;
}>;

type RootControlledDirectory<
  Name extends string,
  Mode extends number,
> = Readonly<{
  basename: Name;
  mode: Mode;
  device: string;
  inode: string;
  realpathSha256: string;
}>;

type ToolRootMaterializedFile<
  Role extends ExecutableClosureEntry["role"],
  RelativePath extends string,
  Mode extends number,
> = Readonly<{
  role: Role;
  relativePath: RelativePath;
  mode: Mode;
  device: string;
  inode: string;
  realpathSha256: string;
  sha256: string;
  size: number;
  sourceExecutablePath: string;
  sourceRealpathSha256: string;
  sourceSha256: string;
  sourceMode: number;
  sourcePathPolicy: "RESOLVED_REGULAR_FILE_COPY_ONLY";
  destinationPathKind: "REGULAR_FILE";
}>;

type RootControlledPlannedFile<
  Name extends string,
  RelativePath extends string,
  Mode extends number,
> = Readonly<{
  basename: Name;
  relativePath: RelativePath;
  mode: Mode;
  realpathPathSha256: string;
  sha256: string;
  size: number;
}>;

type RootControlledPlannedDirectory<
  Name extends string,
  AbsolutePath extends string,
  Mode extends number,
> = Readonly<{
  basename: Name;
  absolutePath: AbsolutePath;
  mode: Mode;
  realpathPathSha256: string;
}>;

type RootControlledSelfFilePlan<
  Name extends string,
  RelativePath extends string,
  Mode extends number,
> = Readonly<{
  basename: Name;
  relativePath: RelativePath;
  mode: Mode;
  realpathPathSha256: string;
  selfDigestExcluded: true;
}>;

type SourceToolClosureEntry<Role extends ExecutableClosureEntry["role"]> =
  Readonly<{
    role: Role;
    logicalIdentity: string;
    sourceExecutablePath: string;
    sourceExecutablePathSha256: string;
    sourceRealpathSha256: string;
    sourceSha256: string;
    sourceSize: number;
    sourceMode: number;
    sourcePathPolicy: "RESOLVED_REGULAR_FILE_ONLY";
  }>;

type MaterializedExecutableClosureEntry<
  Role extends ExecutableClosureEntry["role"],
  AbsolutePath extends string,
  Mode extends number,
> = Readonly<{
  role: Role;
  logicalIdentity: string;
  destinationExecutablePath: AbsolutePath;
  destinationExecutablePathSha256: string;
  mode: Mode;
  sha256: string;
  size: number;
  destinationRoot: "TOOL_ROOT";
  destinationPathKind: "REGULAR_FILE";
}>;

type ObservedMaterializedExecutableFile<
  Role extends ExecutableClosureEntry["role"],
  AbsolutePath extends string,
  Mode extends number,
> = MaterializedExecutableClosureEntry<Role, AbsolutePath, Mode> &
  Readonly<{
    device: string;
    inode: string;
    realpathSha256: string;
  }>;

type LauncherContract = Readonly<{
  schemaVersion: "organization-identity-launcher-contract/v3";
  rootDirectory: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher";
  requestRoot: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/requests";
  outputRoot: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/outputs";
  toolRoot: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root";
  runtimeRoot: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime";
  rootPolicy: Readonly<{
    ownerUid: 0;
    ownerGid: 0;
    launcherDirectoryMode: 0o700;
    requestRootMode: 0o700;
    outputRootMode: 0o700;
    runtimeRootMode: 0o700;
    requestRecordMode: 0o600;
    outputRecordMode: 0o600;
    createExclusive: true;
    rejectSymlink: true;
  }>;
  toolRootPolicy: Readonly<{
    ownerUid: 0;
    ownerGid: 0;
    directoryMode: 0o700;
    binaryMode: 0o500;
    javascriptMode: 0o400;
    createExclusive: true;
    rejectSymlink: true;
    rejectHardlink: true;
    copyResolvedRegularFilesOnly: true;
  }>;
  runtimeRootPolicy: Readonly<{
    ownerUid: 0;
    ownerGid: 0;
    directoryMode: 0o700;
    createExclusive: true;
    rejectSymlink: true;
    rejectHardlink: true;
  }>;
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
  launcherFilePlan: readonly [
    RootControlledPlannedFile<
      "identity-writer-launch",
      "identity-writer-launch",
      0o500
    >,
    RootControlledPlannedFile<
      "identity-writer-launch.mjs",
      "identity-writer-launch.mjs",
      0o500
    >,
  ];
  contractFilePlan: RootControlledSelfFilePlan<
    "launcher-contract.json",
    "launcher-contract.json",
    0o600
  >;
  materializedExecutableClosure: readonly [
    MaterializedExecutableClosureEntry<
      "ENV",
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root/bin/env",
      0o500
    >,
    MaterializedExecutableClosureEntry<
      "NODE",
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root/bin/node",
      0o500
    >,
    MaterializedExecutableClosureEntry<
      "GIT",
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root/bin/git",
      0o500
    >,
    MaterializedExecutableClosureEntry<
      "COREPACK_SHIM",
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root/lib/corepack/dist/corepack.js",
      0o400
    >,
    MaterializedExecutableClosureEntry<
      "COREPACK_LIB_COREPACK_CJS",
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root/lib/corepack/dist/lib/corepack.cjs",
      0o400
    >,
    MaterializedExecutableClosureEntry<
      "PNPM_SHIM",
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root/lib/pnpm/9.15.9/bin/pnpm.cjs",
      0o400
    >,
    MaterializedExecutableClosureEntry<
      "PNPM_ENTRYPOINT",
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root/lib/pnpm/9.15.9/dist/pnpm.cjs",
      0o400
    >,
  ];
  runtimeEnvironment: Readonly<{
    PATH: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root/bin";
    HOME: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime/home";
    XDG_CONFIG_HOME: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime/xdg-config";
    XDG_CACHE_HOME: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime/xdg-cache";
    COREPACK_HOME: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime/corepack-home";
    PNPM_HOME: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime/pnpm-home";
    TMPDIR: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime/tmp";
    NPM_CONFIG_USERCONFIG: "/dev/null";
    CI: "1";
    LANG: "C.UTF-8";
    LC_ALL: "C.UTF-8";
  }>;
  runtimeRootPlan: readonly [
    RootControlledPlannedDirectory<
      "runtime",
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime",
      0o700
    >,
    RootControlledPlannedDirectory<
      "home",
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime/home",
      0o700
    >,
    RootControlledPlannedDirectory<
      "xdg-config",
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime/xdg-config",
      0o700
    >,
    RootControlledPlannedDirectory<
      "xdg-cache",
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime/xdg-cache",
      0o700
    >,
    RootControlledPlannedDirectory<
      "corepack-home",
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime/corepack-home",
      0o700
    >,
    RootControlledPlannedDirectory<
      "pnpm-home",
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime/pnpm-home",
      0o700
    >,
    RootControlledPlannedDirectory<
      "tmp",
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime/tmp",
      0o700
    >,
  ];
  commandIds: readonly ClosedCommandId[];
  commandRegistrySha256: string;
  exactEnvironmentSchemaSha256: string;
  exactEnvironmentValueSetSha256: string;
  bootstrapContractSchemaSha256: string;
  requestUnionSchemaSha256: string;
  requestInputDerivationSha256: string;
  outputSchemaSetSha256: string;
}>;

type LauncherMaterializationPacket = Readonly<{
  schemaVersion: "organization-identity-launcher-materialization-packet/v4";
  subjectCommit: string;
  launcherContract: LauncherContract;
  launcherContractSha256: string;
  approvedArtifacts: Readonly<{
    planCommit: string;
    planBlobId: string;
    planSha256: string;
    planSize: number;
    specCommit: string;
    specBlobId: string;
    specSha256: string;
    specSize: number;
    launcherCommit: string;
    launcherBlobId: string;
    launcherSha256: string;
    launcherSize: number;
    bootstrapCommit: string;
    bootstrapBlobId: string;
    bootstrapSha256: string;
    bootstrapSize: number;
    bootstrapContractCommit: string;
    bootstrapContractBlobId: string;
    bootstrapContractSha256: string;
    bootstrapContractSize: number;
    generatorCommit: string;
    generatorBlobId: string;
    generatorSha256: string;
    generatorSize: number;
    generatorSpecCommit: string;
    generatorSpecBlobId: string;
    generatorSpecSha256: string;
    generatorSpecSize: number;
  }>;
  launcherFileCount: 4;
  toolRootFileCount: 7;
  runtimeRootCount: 7;
  requestRootCount: 1;
  outputRootCount: 1;
  launcherRoot: LauncherContract["rootDirectory"];
  toolRoot: LauncherContract["toolRoot"];
  runtimeRoot: LauncherContract["runtimeRoot"];
  requestRoot: LauncherContract["requestRoot"];
  outputRoot: LauncherContract["outputRoot"];
  sourceToolClosure: readonly [
    SourceToolClosureEntry<"ENV">,
    SourceToolClosureEntry<"NODE">,
    SourceToolClosureEntry<"GIT">,
    SourceToolClosureEntry<"COREPACK_SHIM">,
    SourceToolClosureEntry<"COREPACK_LIB_COREPACK_CJS">,
    SourceToolClosureEntry<"PNPM_SHIM">,
    SourceToolClosureEntry<"PNPM_ENTRYPOINT">,
  ];
  materializedExecutableClosure: LauncherContract["materializedExecutableClosure"];
  launcherFilePlan: LauncherContract["launcherFilePlan"];
  bootstrapFilePlan: RootControlledPlannedFile<
    "identity-writer-bootstrap.mjs",
    "identity-writer-bootstrap.mjs",
    0o500
  >;
  contractFilePlan: LauncherContract["contractFilePlan"] &
    Readonly<{
      sha256: string;
      size: number;
    }>;
  runtimeRootPlan: LauncherContract["runtimeRootPlan"];
  runtimeEnvironment: LauncherContract["runtimeEnvironment"];
  rootPreflight: Readonly<{
    launcherRootState: "ABSENT";
    toolRootState: "ABSENT";
    runtimeRootState: "ABSENT";
    requestRootState: "ABSENT";
    outputRootState: "ABSENT";
    ownerUid: 0;
    ownerGid: 0;
  }>;
  reviewIdentities: Readonly<{
    authorityModelPlanReviewSha256: string;
    task0LFinalCodeReviewSha256: string;
    task0PFinalReviewSha256: string;
  }>;
  chronology: readonly [
    "VERIFY_SOURCE_TOOL_CLOSURE",
    "COPY_AND_FSYNC_LAUNCHER_FILES",
    "COPY_AND_FSYNC_MATERIALIZED_EXECUTABLE_CLOSURE",
    "CREATE_AND_FSYNC_RUNTIME_ROOTS",
    "CREATE_AND_FSYNC_REQUEST_OUTPUT_ROOTS",
    "INDEPENDENT_READBACK",
    "MATERIALIZATION_RECEIPT",
    "MATERIALIZATION_REVIEW",
  ];
  symlinkPolicy: "NO_LIVE_SYMLINK_RUNTIME_DEPENDENCE";
  rollbackPolicy: "CREATE_ONLY_PRESERVE_EVIDENCE_AND_REAUTHORIZE";
  compatibilityStatus: "HISTORICAL_V2_V3_PACKET_MODELS_HOLD_NOT_AUTHORITY_COMPATIBLE";
  result: "AUTH_REQUIRED";
}>;

type LauncherMaterializationPacketReviewReceipt = Readonly<{
  schemaVersion: "organization-identity-launcher-materialization-packet-review/v1";
  launcherMaterializationPacketSha256: string;
  generatorCommit: string;
  generatorBlobId: string;
  generatorSha256: string;
  generatorSpecCommit: string;
  generatorSpecBlobId: string;
  generatorSpecSha256: string;
  reportSha256: string;
  counterexampleSetSha256: string;
  reviewerClass: "INDEPENDENT_ROOT_MATERIALIZATION_PACKET_REVIEW";
  critical: 0;
  important: 0;
  verdict: "PASS";
}>;

type LauncherReadbackReport = Readonly<{
  schemaVersion: "organization-identity-launcher-readback/v2";
  launcherContractSha256: string;
  launcherMaterializationPacketSha256: string;
  sourceToolClosureSha256: string;
  materializedExecutableClosureSha256: string;
  launcherFileObservationSetSha256: string;
  toolRootObservationSetSha256: string;
  runtimeRootObservationSetSha256: string;
  requestRootObservationSha256: string;
  outputRootObservationSha256: string;
  environmentValueSetSha256: string;
  hostileCounterexampleSetSha256: string;
  reviewerClass: "INDEPENDENT_ROOT_LAUNCHER_READBACK";
  observedAt: string;
}>;

type LauncherMaterializationReceipt = Readonly<{
  schemaVersion: "organization-identity-launcher-materialization/v3";
  launcherContractSha256: string;
  launcherMaterializationPacketSha256: string;
  authorizationReceiptSha256: string;
  sourceToolClosureSha256: string;
  materializedExecutableClosureSha256: string;
  ownerUid: 0;
  ownerGid: 0;
  directoryMode: 0o700;
  files: readonly [
    RootControlledFile<"identity-writer-launch", 0o500>,
    RootControlledFile<"identity-writer-launch.mjs", 0o500>,
    RootControlledFile<"identity-writer-bootstrap.mjs", 0o500>,
    RootControlledFile<"launcher-contract.json", 0o600>,
  ];
  toolRoot: RootControlledDirectory<"tool-root", 0o700>;
  toolRootFiles: readonly [
    ObservedMaterializedExecutableFile<
      "ENV",
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root/bin/env",
      0o500
    >,
    ObservedMaterializedExecutableFile<
      "NODE",
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root/bin/node",
      0o500
    >,
    ObservedMaterializedExecutableFile<
      "GIT",
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root/bin/git",
      0o500
    >,
    ObservedMaterializedExecutableFile<
      "COREPACK_SHIM",
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root/lib/corepack/dist/corepack.js",
      0o400
    >,
    ObservedMaterializedExecutableFile<
      "COREPACK_LIB_COREPACK_CJS",
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root/lib/corepack/dist/lib/corepack.cjs",
      0o400
    >,
    ObservedMaterializedExecutableFile<
      "PNPM_SHIM",
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root/lib/pnpm/9.15.9/bin/pnpm.cjs",
      0o400
    >,
    ObservedMaterializedExecutableFile<
      "PNPM_ENTRYPOINT",
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root/lib/pnpm/9.15.9/dist/pnpm.cjs",
      0o400
    >,
  ];
  runtimeRoots: readonly [
    RootControlledDirectory<"runtime", 0o700>,
    RootControlledDirectory<"home", 0o700>,
    RootControlledDirectory<"xdg-config", 0o700>,
    RootControlledDirectory<"xdg-cache", 0o700>,
    RootControlledDirectory<"corepack-home", 0o700>,
    RootControlledDirectory<"pnpm-home", 0o700>,
    RootControlledDirectory<"tmp", 0o700>,
  ];
  requestRoot: Readonly<{
    mode: 0o700;
    device: string;
    inode: string;
    realpathSha256: string;
  }>;
  outputRoot: Readonly<{
    mode: 0o700;
    device: string;
    inode: string;
    realpathSha256: string;
  }>;
  runtimeEnvironment: LauncherContract["runtimeEnvironment"];
  fourFileFsyncSha256: string;
  toolRootFsyncSha256: string;
  runtimeRootFsyncSha256: string;
  directoryFsyncSha256: string;
  readbackReportSha256: string;
  environmentValueSetSha256: string;
  prePostToctouSha256: string;
  materializedAt: string;
  result: "PASS";
}>;

type LauncherMaterializationReviewReceipt = Readonly<{
  schemaVersion: "organization-identity-launcher-materialization-review/v3";
  launcherContractSha256: string;
  launcherMaterializationPacketSha256: string;
  launcherMaterializationReceiptSha256: string;
  readbackReportSha256: string;
  reportSha256: string;
  counterexampleSetSha256: string;
  reviewerClass: "INDEPENDENT_ROOT_LAUNCHER_REVIEW";
  critical: 0;
  important: 0;
  verdict: "PASS";
}>;

type LauncherRootMaterializationRequest = Readonly<{
  schemaVersion: "organization-identity-root-materialization-request/v1";
  requestId: string;
  authorizationClass: "LOCAL_ROOT_MATERIALIZATION";
  subjectCommit: string;
  launcherMaterializationPacketPath: string;
  launcherMaterializationPacketSha256: string;
  launcherMaterializationPacketReviewReceiptPath: string;
  launcherMaterializationPacketReviewReceiptSha256: string;
  launcherContractSha256: string;
  sourceToolClosureSha256: string;
  materializedExecutableClosureSha256: string;
  launcherFileCount: 4;
  toolRootFileCount: 7;
  runtimeRootCount: 7;
  requestRootCount: 1;
  outputRootCount: 1;
  launcherRoot: LauncherContract["rootDirectory"];
  toolRoot: LauncherContract["toolRoot"];
  runtimeRoot: LauncherContract["runtimeRoot"];
  requestRoot: LauncherContract["requestRoot"];
  outputRoot: LauncherContract["outputRoot"];
  chronology: LauncherMaterializationPacket["chronology"];
  targetMustBeAbsent: true;
  containsCredentialValue: false;
  scopeSha256: string;
}>;

type VerifiedWorktreeReceiptV1 = Readonly<{
  schemaVersion: "organization-identity-verified-worktree/v1";
  repositoryRoot: string;
  worktreePath: string;
  gitDirRealpathSha256: string;
  commonDirRealpathSha256: string;
  branch: string;
  headCommit: string;
  subjectCommit: string;
  statusPorcelainSha256: string;
  worktreeListEntrySha256: string;
  expectedMode:
    | "CURRENT_MAIN_AUDIT_LOCAL"
    | "GIT_REFRESH_START"
    | "GIT_REFRESH_COMMIT"
    | "GIT_ADMISSION_COMMIT"
    | "GIT_ACCEPTANCE_COMMIT"
    | "V3_WORKTREE_CREATE";
  verifiedByExecutableClosureSha256: string;
  prePostToctouSha256: string;
  result: "PASS";
}>;

type RequestInputBinding = Readonly<{
  inputRecordPath: string;
  inputRecordUri: string;
  inputRecordSha256: string;
  payloadSchemaSha256: string;
  payloadSha256: string;
  outputRecordPath: string;
}>;

type ClosedCommandRequestBase<
  CommandId extends ClosedCommandId,
  Mode extends string,
  Parameters,
> = Readonly<{
  schemaVersion: "organization-identity-closed-command-request/v2";
  requestId: string;
  taskId: TaskId;
  commandId: CommandId;
  mode: Mode;
  subjectCommit: string;
  bootstrapContractSha256: string;
  launcherMaterializationReceiptSha256: string;
  launcherMaterializationReviewReceiptSha256: string;
  authorizationReceiptSha256: string | null;
  externalControllerReceiptSha256: string | null;
  anchorReceiptSha256: string | null;
  verifiedWorktreeReceiptSha256: string | null;
  input: RequestInputBinding;
  allowedArgvSha256: string;
  parameters: Parameters;
}>;

// Only Git-backed local request variants may set a non-null
// verifiedWorktreeReceiptSha256. Bootstrap, scanner, review, docs, API,
// runtime and governance requests must keep it null. The launcher rejects null
// for CURRENT_MAIN_AUDIT_LOCAL_V1, GIT_REFRESH_START_V1,
// GIT_REFRESH_COMMIT_V1, GIT_ADMISSION_COMMIT_V1,
// GIT_ACCEPTANCE_COMMIT_V1 and V3_WORKTREE_CREATE_V1. The receipt is derived
// by the launcher-controlled Git closure or by a validated root/hosted receipt
// digest explicitly named in the request; caller-provided worktree objects are
// never accepted.

type BootstrapAuthorityRequest = ClosedCommandRequestBase<
  "BOOTSTRAP_AUTHORITY_RUN_V1",
  "INSTALL_AND_PRISMA_GENERATE",
  Readonly<{
    frozenLockfile: true;
    ignoreScripts: true;
    ignorePnpmfile: true;
    npmUserConfig: "/dev/null";
  }>
>;

type ScopedReviewVerifyRequest = ClosedCommandRequestBase<
  "SCOPED_REVIEW_VERIFY_V1",
  "VERIFY",
  Readonly<{
    reportPath: string;
    reportSha256: string;
    receiptPath: string;
    receiptSha256: string;
    reviewedSubjectCommit: string;
  }>
>;

type CurrentMainAuditLocalRequest = ClosedCommandRequestBase<
  "CURRENT_MAIN_AUDIT_LOCAL_V1",
  "COLLECT_LOCAL_FACTS",
  Readonly<{
    branchPreRefreshCommit: string;
    advertisedLiveMainCommit: string;
    githubControllerReceiptSha256: string;
  }>
>;

type CurrentMainValidateRequest = ClosedCommandRequestBase<
  "CURRENT_MAIN_VALIDATE_V1",
  "VALIDATE",
  Readonly<{
    auditPacketSha256: string;
    auditReviewReceiptSha256: string;
    refreshMergeCommit: string | null;
    admissionPath: "docs/governance/organization-identity-current-main-admission.json";
  }>
>;

type CurrentMainGenerateRequest = ClosedCommandRequestBase<
  "CURRENT_MAIN_GENERATE_V1",
  "GENERATE",
  Readonly<{
    auditPacketSha256: string;
    auditReviewReceiptSha256: string;
    refreshMergeCommit: string;
    admissionPath: "docs/governance/organization-identity-current-main-admission.json";
  }>
>;

type CopyWriteEligibilityRequest = ClosedCommandRequestBase<
  "COPY_WRITE_ELIGIBILITY_V1",
  "WRITE_ELIGIBILITY",
  Readonly<{
    auditPacketSha256: string;
    eligibilityPath: "docs/evidence/site-builder/copy-runtime-eligibility.json";
  }>
>;

type CopySyncCitationsRequest = ClosedCommandRequestBase<
  "COPY_SYNC_CITATIONS_V1",
  "SYNC_CITATIONS",
  Readonly<{
    auditPacketSha256: string;
    eligibilityPath: "docs/evidence/site-builder/copy-runtime-eligibility.json";
    eligibilityInputSha256: string;
    citationPath: "docs/implementation-records/copy-fixed-source-impact-governance.md";
  }>
>;

type GitRefreshStartRequest = ClosedCommandRequestBase<
  "GIT_REFRESH_START_V1",
  "START_NO_COMMIT",
  Readonly<{
    expectedHead: string;
    otherParent: string;
    exactMergeResultPathSetSha256: string;
  }>
>;

type GitRefreshCommitRequest = ClosedCommandRequestBase<
  "GIT_REFRESH_COMMIT_V1",
  "COMMIT_REFRESH",
  Readonly<{
    expectedFirstParent: string;
    expectedSecondParent: string;
    stagedPathSetSha256: string;
    commitMessage: "chore: merge admitted main for identity writer baseline";
  }>
>;

type GitAdmissionCommitRequest = ClosedCommandRequestBase<
  "GIT_ADMISSION_COMMIT_V1",
  "COMMIT_ADMISSION",
  Readonly<{
    expectedParent: string;
    stagedPath: "docs/governance/organization-identity-current-main-admission.json";
    stagedStatus: "ADD" | "MODIFY";
    commitMessage: "chore: admit current main for identity writer baseline";
  }>
>;

type GitAcceptanceCommitRequest = ClosedCommandRequestBase<
  "GIT_ACCEPTANCE_COMMIT_V1",
  "COMMIT_ACCEPTANCE",
  Readonly<{
    expectedParent: string;
    stagedPath: "docs/governance/organization-identity-writer-acceptance.json";
    stagedStatus: "ADD";
    commitMessage: "chore: anchor organization identity writer baseline";
  }>
>;

type ScannerCommonParameters = Readonly<{
  baselineSubjectCommit: string;
  currentMainAdmissionCommit: string;
  b0mMigrationCommit: string;
}>;

type ScannerTestRequest = ClosedCommandRequestBase<
  "SCANNER_TEST_V1",
  "TEST",
  ScannerCommonParameters &
    Readonly<{
      suiteId:
        | "B0_SCANNER"
        | "DELEGATE_ENGINE"
        | "RAW_CLOSURE"
        | "STAGE_SECURITY"
        | "B0_BASELINE"
        | "B0_ACCEPTANCE"
        | "B1_TEMPORAL"
        | "B2_TEMPORAL"
        | "B3_PROJECTION"
        | "B4_PROJECTION"
        | "B4M_MATERIALIZATION"
        | "B5_ZERO"
        | "B6_CLOSEOUT";
    }>
>;

type ScannerBaselineRequest = ClosedCommandRequestBase<
  "SCANNER_BASELINE_V1",
  "RAW_RECEIPT_ONLY" | "RAW_CANDIDATE" | "BASELINE_GENERATE" | "BASELINE_CHECK",
  ScannerCommonParameters &
    Readonly<{
      artifactACommit: "2400bac28796bae44294114edc99eaccb1bd65b3";
      dispositionReceiptSha256: string | null;
      outputDirectory: "docs/governance" | null;
    }>
>;

type ScannerStageRequest = ClosedCommandRequestBase<
  "SCANNER_STAGE_V1",
  "STAGE_GENERATE" | "STAGE_CHECK" | "ANCHOR_ONLY",
  ScannerCommonParameters &
    Readonly<{
      stage:
        | "B0_BASELINE"
        | "B1_TEMPORAL_RED"
        | "B2_TEMPORAL_CUTOVER"
        | "B3_PROJECTION_RED"
        | "B4_PROJECTION_CUTOVER"
        | "B4M_MATERIALIZATION_CUTOVER"
        | "B5_ZERO_GATE"
        | "B6_CLOSEOUT";
    }>
>;

type ScannerZeroRequest = ClosedCommandRequestBase<
  "SCANNER_ZERO_V1",
  "ZERO_CHECK",
  ScannerCommonParameters & Readonly<{ expectedWriterCount: 3 | 2 | 1 | 0 }>
>;

type ScannerAcceptanceRequest = ClosedCommandRequestBase<
  "SCANNER_ACCEPTANCE_V1",
  "ACCEPTANCE_RED" | "ACCEPTANCE_GENERATE" | "ACCEPTANCE_CHECK",
  ScannerCommonParameters &
    Readonly<{
      implementationParent: string;
      implementationReviewSha256: string;
      acceptancePath: "docs/governance/organization-identity-writer-acceptance.json";
    }>
>;

type RefreshVerifyRequest = ClosedCommandRequestBase<
  "REFRESH_VERIFY_V1",
  "VERIFY",
  Readonly<{ suiteId: "REFRESH_FULL"; refreshMergeCommit: string }>
>;

type MigrationStaticVerifyRequest = ClosedCommandRequestBase<
  "MIGRATION_STATIC_VERIFY_V1",
  "VERIFY",
  Readonly<{ suiteId: "MIGRATION_0M_STATIC"; b0mMigrationCommit: string }>
>;

type PrismaGenerateRequest = ClosedCommandRequestBase<
  "PRISMA_GENERATE_V1",
  "VERIFY",
  Readonly<{
    suiteId: "PRISMA_GENERATE";
    schemaPath: "packages/db/prisma/schema.prisma";
  }>
>;

type GovernanceVerifyRequest = ClosedCommandRequestBase<
  "GOVERNANCE_VERIFY_V1",
  "VERIFY",
  Readonly<{ suiteId: "GOVERNANCE_B0" | "GOVERNANCE_ZERO" }>
>;

type DocsVerifyRequest = ClosedCommandRequestBase<
  "DOCS_VERIFY_V1",
  "VERIFY",
  Readonly<{ suiteId: "DOCS_FULL" }>
>;

type ApiVerifyRequest = ClosedCommandRequestBase<
  "API_VERIFY_V1",
  "VERIFY",
  Readonly<{
    suiteId:
      | "API_FULL"
      | "API_TEMPORAL"
      | "API_PROJECTION"
      | "API_MATERIALIZATION"
      | "API_DOWNSTREAM"
      | "API_MIXED_FLEET";
  }>
>;

type RuntimeArtifactVerifyRequest = ClosedCommandRequestBase<
  "RUNTIME_ARTIFACT_VERIFY_V1",
  "VERIFY",
  Readonly<{ suiteId: "RUNTIME_ARTIFACT" }>
>;

type ContractGraphVerifyRequest = ClosedCommandRequestBase<
  "CONTRACT_GRAPH_VERIFY_V1",
  "VERIFY",
  Readonly<{ suiteId: "CONTRACT_GRAPH" }>
>;
type V3WorktreeRequest = ClosedCommandRequestBase<
  "V3_WORKTREE_CREATE_V1",
  "CREATE",
  Readonly<{
    mergeCommit: string;
    branch: "codex/pr407-organization-identity-caller-cutover-v3";
    worktreePath: "/global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v3";
  }>
>;

type ClosedCommandRequest =
  | BootstrapAuthorityRequest
  | ScopedReviewVerifyRequest
  | CurrentMainAuditLocalRequest
  | CurrentMainValidateRequest
  | CurrentMainGenerateRequest
  | CopyWriteEligibilityRequest
  | CopySyncCitationsRequest
  | GitRefreshStartRequest
  | GitRefreshCommitRequest
  | GitAdmissionCommitRequest
  | GitAcceptanceCommitRequest
  | ScannerTestRequest
  | ScannerBaselineRequest
  | ScannerStageRequest
  | ScannerZeroRequest
  | ScannerAcceptanceRequest
  | RefreshVerifyRequest
  | MigrationStaticVerifyRequest
  | PrismaGenerateRequest
  | GovernanceVerifyRequest
  | DocsVerifyRequest
  | ApiVerifyRequest
  | RuntimeArtifactVerifyRequest
  | ContractGraphVerifyRequest
  | V3WorktreeRequest;

type ExternalLaunchReceipt = Readonly<{
  schemaVersion: "organization-identity-external-launch/v3";
  launcherContractSha256: string;
  launcherMaterializationReceiptSha256: string;
  launcherMaterializationReviewReceiptSha256: string;
  controllerClass: "BRANCH_EXTERNAL_ROOT";
  acceptedSubjectCommit: string;
  requestId: string;
  commandId: ClosedCommandId;
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
  environmentValueSetSha256: string;
  preDependencyVerificationSha256: string;
  result: "PASS";
}>;

type ToolLogicalExpectation = Readonly<{
  logicalPackage: string;
  version: string;
  allowedRoles: readonly string[];
  lockResolutionRuleSha256: string;
  loadedFileDerivationSha256: string;
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
  schemaVersion: "organization-identity-bootstrap-contract/v2";
  launcherContractSha256: string;
  bootstrapSchemaSha256: string;
  closedRequestSchemaSha256: string;
  effectivePnpmArgvRuleSha256: string;
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
  allowedEnvironmentValueRuleSha256: string;
  subjectConfigurationDerivationSha256: string;
  subjectAbsenceSentinelDerivationSha256: string;
  dependencyDeclarationRuleSha256: string;
  toolLogicalExpectations: readonly ToolLogicalExpectation[];
  toolExecutionRuleSha256: string;
  generatedOutputDerivationSha256: string;
  receiptExactKeySchemaSha256: string;
  receiptComparatorSha256: string;
  perRunVariableFieldPaths: readonly [
    "/requestId",
    "/taskId",
    "/commandId",
    "/mode",
    "/closedCommandRequestSha256",
    "/inputRecordPath",
    "/inputRecordUri",
    "/inputRecordSha256",
    "/payloadSchemaSha256",
    "/payloadSha256",
    "/outputRecordPath",
    "/outputRecordSha256",
    "/authorizationReceiptSha256",
    "/externalControllerReceiptSha256",
    "/anchorReceiptSha256",
    "/externalLaunchReceiptSha256",
    "/acceptedSubjectCommit",
    "/subjectConfigurationSetSha256",
    "/subjectAbsenceSentinelSetSha256",
    "/subjectGitClosureSha256",
    "/environmentValueSetSha256",
    "/taskRoot",
    "/taskRootDevice",
    "/taskRootInode",
    "/fixedRootSetSha256",
    "/postInstallBootstrapRehashSha256",
    "/dependencyDeclarationRoots/*/lockIntegrity",
    "/dependencyDeclarationRoots/*/rootRealpathSha256",
    "/dependencyDeclarationRoots/*/loadedFileCount",
    "/dependencyDeclarationRoots/*/loadedFileSetSha256",
    "/dependencyDeclarationRoots/*/contentSetSha256",
    "/dependencyDeclarationRoots/*/prePostToctouSha256",
    "/toolExecutionRoots/*/lockIntegrity",
    "/toolExecutionRoots/*/rootRealpathSha256",
    "/toolExecutionRoots/*/loadedFileCount",
    "/toolExecutionRoots/*/loadedFileSetSha256",
    "/toolExecutionRoots/*/contentSetSha256",
    "/toolExecutionRoots/*/prePostToctouSha256",
    "/prismaSchemaSha256",
    "/generatedClientSetSha256",
    "/generatedDmmfSha256",
    "/generatedDelegateSetSha256",
    "/generatedOutputSetSha256",
    "/typescriptDynamicImportSha256",
    "/hostileMarkerSetSha256",
    "/prePostToctouSha256",
    "/startedAt",
    "/finishedAt",
  ];
}>;

type BootstrapRunReceipt = Readonly<{
  schemaVersion: "organization-identity-bootstrap-run/v2";
  receiptCardinality: "ONE_COMMAND_ONE_RECEIPT";
  bootstrapContractSha256: string;
  launcherMaterializationReceiptSha256: string;
  launcherMaterializationReviewReceiptSha256: string;
  requestId: string;
  taskId: TaskId;
  commandId: ClosedCommandId;
  mode: string;
  closedCommandRequestSha256: string;
  inputRecordPath: string;
  inputRecordUri: string;
  inputRecordSha256: string;
  payloadSchemaSha256: string;
  payloadSha256: string;
  outputRecordPath: string;
  outputRecordSha256: string;
  authorizationReceiptSha256: string | null;
  externalControllerReceiptSha256: string | null;
  anchorReceiptSha256: string | null;
  externalLaunchReceiptSha256: string;
  acceptedSubjectCommit: string;
  subjectConfigurationSetSha256: string;
  subjectAbsenceSentinelSetSha256: string;
  subjectGitClosureSha256: string;
  environmentValueSetSha256: string;
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

type BootstrapRunReceiptSet = Readonly<{
  schemaVersion: "organization-identity-bootstrap-run-set/v1";
  taskId: TaskId;
  subjectCommit: string;
  receiptCount: number;
  receipts: readonly Readonly<{
    requestId: string;
    commandId: ClosedCommandId;
    requestSha256: string;
    receiptSha256: string;
  }>[];
  receiptSetSha256: string;
}>;
```

### Branch-external tool-specific controller contracts

The local root launcher never dispatches a credentialed/networked GitHub operation, Gitleaks, Docker, `psql`, a disposable database, a workflow rerun, controller-variable mutation, or a root-anchor write. It only validates the closed receipts from the independently authorized controllers below when a later local scanner/static command consumes them.

```ts
type ExternalControllerExecutableEntry = Readonly<{
  role:
    | "ENV"
    | "NODE"
    | "GIT"
    | "GH"
    | "GITLEAKS"
    | "DOCKER"
    | "PSQL"
    | "COREPACK_SHIM"
    | "COREPACK_LIB_COREPACK_CJS"
    | "PNPM_SHIM"
    | "PNPM_ENTRYPOINT"
    | "PRISMA_CLI";
  logicalIdentity: string;
  executablePath: string;
  realpathSha256: string;
  sha256: string;
  size: number;
}>;

type CredentialHandleBinding = Readonly<{
  provider: "ROOT_SECRET_STORE" | "GITHUB_ACTIONS_SECRET";
  handleSha256: string;
  scopeSha256: string;
  injectedByFileDescriptor: true;
  valuePersisted: false;
  valueEmitted: false;
}>;

type ControllerSourceClosureV1 = Readonly<{
  schemaVersion: "organization-identity-controller-source-closure/v1";
  controllerClass:
    | "GITHUB"
    | "DISPOSABLE_POSTGRES"
    | "GITLEAKS"
    | "ROOT_ANCHOR"
    | "PROTECTED_BASE_LAUNCHER";
  primarySourcePath: string;
  primarySourceBlobId: string;
  primarySourceSha256: string;
  sharedSourceEntries: readonly Readonly<{
    path: string;
    blobId: string;
    sha256: string;
  }>[];
  testSourceEntries: readonly Readonly<{
    path: string;
    blobId: string;
    sha256: string;
  }>[];
  sourceSetSha256: string;
}>;

type ExternalControllerMaterializationReceipt = Readonly<{
  schemaVersion: "organization-identity-external-controller-materialization/v2";
  controllerClass:
    "GITHUB" | "DISPOSABLE_POSTGRES" | "GITLEAKS" | "ROOT_ANCHOR";
  contractSha256: string;
  controllerSourceSha256: string;
  controllerSourceClosureSha256: string;
  rootDirectorySha256: string;
  requestRootSha256: string;
  outputRootSha256: string;
  ownerUid: 0;
  ownerGid: 0;
  directoryMode: 0o700;
  controllerMode: 0o500;
  recordMode: 0o600;
  executableClosureSetSha256: string;
  environmentSchemaSha256: string;
  prePostToctouSha256: string;
  result: "PASS";
}>;

type ControllerReviewReceipt = Readonly<{
  schemaVersion: "organization-identity-controller-review/v2";
  controllerClass:
    | "GITHUB"
    | "DISPOSABLE_POSTGRES"
    | "GITLEAKS"
    | "ROOT_ANCHOR"
    | "PROTECTED_BASE_LAUNCHER";
  contractSha256: string;
  materializationReceiptSha256: string | null;
  controllerSourceClosureSha256: string;
  requestSchemaSha256: string;
  reportSha256: string;
  counterexampleSetSha256: string;
  reviewerClass: "INDEPENDENT_CONTROLLER_SECURITY_REVIEW";
  critical: 0;
  important: 0;
  verdict: "PASS";
}>;

type GitHubControllerOperation =
  | "PROTECTED_MAIN_READBACK"
  | "FETCH_EXACT_OBJECT"
  | "PUSH_EXACT_BRANCH"
  | "PR_CREATE"
  | "PR_UPDATE_BODY"
  | "PR_READBACK"
  | "RULES_CHECKS_READBACK"
  | "PR_MERGE"
  | "COMMIT_BRANCH_PARENT_READBACK"
  | "WORKFLOW_RUN_READBACK"
  | "WORKFLOW_RERUN"
  | "CONTROLLER_VARIABLES_WRITE";

type GitHubVariableMutationBody = Readonly<{
  name: string;
  value: string;
}>;

type GitHubControllerApiRequestBody =
  | null
  | Readonly<{ base: "main"; head: string; title: string; body: string }>
  | Readonly<{ title: string; body: string }>
  | Readonly<{ body: string }>
  | Readonly<{
      merge_method: "merge";
      sha: string;
      commit_title?: string;
      commit_message?: string;
    }>
  | GitHubVariableMutationBody;

type GitHubControllerRequestBase<
  Operation extends GitHubControllerOperation,
  Payload,
> = Readonly<{
  schemaVersion: "organization-identity-github-controller-request/v2";
  requestId: string;
  operation: Operation;
  contractSha256: string;
  materializationReceiptSha256: string;
  controllerReviewReceiptSha256: string;
  authorizationReceiptSha256: string | null;
  credentialHandle: CredentialHandleBinding;
  payloadSchemaSha256: string;
  payloadSha256: string;
  apiRequestBodySchemaSha256: string | null;
  apiRequestBodySha256: string | null;
  apiRequestBody: GitHubControllerApiRequestBody;
  outputRecordPath: string;
  payload: Payload;
}>;

type GitHubControllerRequest =
  | GitHubControllerRequestBase<
      "PROTECTED_MAIN_READBACK",
      Readonly<{
        repository: "mlhjyx/global-backend";
        ref: "refs/heads/main";
      }>
    >
  | GitHubControllerRequestBase<
      "FETCH_EXACT_OBJECT",
      Readonly<{
        remote: "origin";
        ref: "refs/heads/main";
        objectSha: string;
        flags: readonly [
          "--no-tags",
          "--no-write-fetch-head",
          "--no-auto-maintenance",
          "--no-write-commit-graph",
        ];
      }>
    >
  | GitHubControllerRequestBase<
      "PUSH_EXACT_BRANCH",
      Readonly<{
        branch: "codex/pr407-organization-identity-caller-cutover-v2";
        expectedHead: string;
        setUpstream: true;
        force: false;
      }>
    >
  | GitHubControllerRequestBase<
      "PR_CREATE",
      Readonly<{
        base: "main";
        head: "codex/pr407-organization-identity-caller-cutover-v2";
        title: "Organization Identity writer ban-at-source";
        bodySha256: string;
      }>
    >
  | GitHubControllerRequestBase<
      "PR_UPDATE_BODY",
      Readonly<{
        number: number;
        expectedBaseSha: string;
        expectedHeadSha: string;
        title: "Organization Identity writer ban-at-source";
        bodySha256: string;
      }>
    >
  | GitHubControllerRequestBase<
      "PR_READBACK",
      Readonly<{
        number: number | null;
        headBranch: "codex/pr407-organization-identity-caller-cutover-v2";
      }>
    >
  | GitHubControllerRequestBase<
      "RULES_CHECKS_READBACK",
      Readonly<{
        number: number;
        expectedBaseSha: string;
        expectedHeadSha: string;
      }>
    >
  | GitHubControllerRequestBase<
      "PR_MERGE",
      Readonly<{
        number: number;
        expectedBaseSha: string;
        expectedHeadSha: string;
        mergeMethod: "merge";
        immediateReadbackReceiptSetSha256: string;
      }>
    >
  | GitHubControllerRequestBase<
      "COMMIT_BRANCH_PARENT_READBACK",
      Readonly<{
        mergeResponseSha: string;
        expectedParents: readonly [string, string];
      }>
    >
  | GitHubControllerRequestBase<
      "WORKFLOW_RUN_READBACK",
      Readonly<{
        workflowPath: ".github/workflows/organization-identity-writer-anchor.yml";
        expectedHeadSha: string;
        runId: number | null;
      }>
    >
  | GitHubControllerRequestBase<
      "WORKFLOW_RERUN",
      Readonly<{
        runId: number;
        runAttempt: number;
        expectedHeadSha: string;
      }>
    >
  | GitHubControllerRequestBase<
      "CONTROLLER_VARIABLES_WRITE",
      Readonly<{
        variableCount: 15;
        variableNameSetSha256: string;
        variableValueDigestSetSha256: string;
      }>
    >;

// GitHub request payloads are controller authorization/control records only.
// For mutation operations, apiRequestBody is the exact object passed to
// `gh api --input`. PR_CREATE is exactly { base, head, title, body };
// PR_UPDATE_BODY is exactly { title, body } or { body }; PR_MERGE is exactly
// { merge_method: "merge", sha: expectedHeadSha } plus only contracted commit
// title/message fields. CONTROLLER_VARIABLES_WRITE materializes fifteen exact
// variable create/update bodies or fifteen separate requests; a digest-only
// variable-count record is never an executable API body. PR create/update/merge,
// workflow readback and rerun operations produce mechanical pre/post readback
// receipts from observed API results, not passive caller metadata.

type GitHubControllerContract = Readonly<{
  schemaVersion: "organization-identity-github-controller-contract/v2";
  rootDirectory: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/github";
  requestRoot: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/github/requests";
  outputRoot: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/github/outputs";
  controllerSourceBlobId: string;
  controllerSourceSha256: string;
  controllerSourceClosure: ControllerSourceClosureV1;
  controllerSourceClosureSha256: string;
  repository: "mlhjyx/global-backend";
  remote: "origin";
  protectedRef: "refs/heads/main";
  executableClosure: readonly ExternalControllerExecutableEntry[];
  requiredRoles: readonly ["NODE", "GIT", "GH"];
  allowedEnvironmentNames: readonly [
    "PATH",
    "HOME",
    "XDG_CONFIG_HOME",
    "TMPDIR",
    "GH_HOST",
    "GITHUB_TOKEN_HANDLE",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_TERMINAL_PROMPT",
  ];
  credentialHandleSchemaSha256: string;
  operationRequestSchemaSha256: Readonly<
    Record<GitHubControllerOperation, string>
  >;
  operationResultSchemaSha256: Readonly<
    Record<GitHubControllerOperation, string>
  >;
  noSecretPersistence: true;
}>;

type GitHubControllerReceipt = Readonly<{
  schemaVersion: "organization-identity-github-controller-receipt/v2";
  contractSha256: string;
  controllerReviewReceiptSha256: string;
  controllerSourceClosureSha256: string;
  operation: GitHubControllerOperation;
  requestId: string;
  requestSha256: string;
  payloadSchemaSha256: string;
  payloadSha256: string;
  apiRequestBodySchemaSha256: string | null;
  apiRequestBodySha256: string | null;
  authorizationReceiptSha256: string | null;
  credentialHandleSha256: string | null;
  repository: "mlhjyx/global-backend";
  observedOrWrittenRef: string | null;
  observedBaseSha: string | null;
  observedHeadSha: string | null;
  resultSchemaSha256: string;
  resultSha256: string;
  httpStatus: number | null;
  executableClosureSetSha256: string;
  prePostToctouSha256: string;
  containsCredentialValue: false;
  result: "PASS";
}>;

type DisposablePostgresControllerContract = Readonly<{
  schemaVersion: "organization-identity-disposable-postgres-controller-contract/v2";
  rootDirectory: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/disposable-postgres";
  requestRoot: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/disposable-postgres/requests";
  outputRoot: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/disposable-postgres/outputs";
  controllerSourceBlobId: string;
  controllerSourceSha256: string;
  controllerSourceClosure: ControllerSourceClosureV1;
  controllerSourceClosureSha256: string;
  executableClosure: readonly ExternalControllerExecutableEntry[];
  requiredRoles: readonly [
    "NODE",
    "DOCKER",
    "PSQL",
    "COREPACK_SHIM",
    "COREPACK_LIB_COREPACK_CJS",
    "PNPM_SHIM",
    "PNPM_ENTRYPOINT",
    "PRISMA_CLI",
  ];
  allowedEnvironmentNames: readonly [
    "PATH",
    "HOME",
    "XDG_CONFIG_HOME",
    "TMPDIR",
    "DOCKER_HOST_HANDLE",
    "POSTGRES_CREDENTIAL_HANDLE",
    "CI",
    "LANG",
    "LC_ALL",
  ];
  allowedOperations: readonly ["0M_COMPATIBILITY", "B6_MIXED_FLEET"];
  topologySchemaSha256: string;
  resourceLabelSchemaSha256: string;
  imageDigestSchemaSha256: string;
  timeAndSpaceCapSchemaSha256: string;
  syntheticCredentialHandleSchemaSha256: string;
  migrationInputSchemaSha256: string;
  cleanupProofSchemaSha256: string;
  loopbackOnly: true;
  noEgress: true;
  retainedResourceAllowed: false;
}>;

type DisposablePostgresControllerRequest = Readonly<{
  schemaVersion: "organization-identity-disposable-postgres-controller-request/v2";
  requestId: string;
  operation: "0M_COMPATIBILITY" | "B6_MIXED_FLEET";
  contractSha256: string;
  materializationReceiptSha256: string;
  controllerReviewReceiptSha256: string;
  authorizationReceiptSha256: string;
  syntheticCredentialHandle: CredentialHandleBinding;
  imageDigest: string;
  topologySha256: string;
  resourceLabelSetSha256: string;
  timeAndSpaceCapSha256: string;
  migrationInputSetSha256: string;
  scenarioSetSha256: string;
  cleanupPlanSha256: string;
  outputRecordPath: string;
}>;

type DisposablePostgresControllerReceipt = Readonly<{
  schemaVersion: "organization-identity-disposable-postgres-controller-receipt/v2";
  contractSha256: string;
  controllerReviewReceiptSha256: string;
  controllerSourceClosureSha256: string;
  operation: "0M_COMPATIBILITY" | "B6_MIXED_FLEET";
  requestId: string;
  requestSha256: string;
  authorizationReceiptSha256: string;
  imageDigest: string;
  topologySha256: string;
  resourceSetSha256: string;
  migrationInputSetSha256: string;
  syntheticCredentialHandleSha256: string;
  scenarioResultSetSha256: string;
  cleanupProofSha256: string;
  executableClosureSetSha256: string;
  prePostToctouSha256: string;
  containsCredentialValue: false;
  retainedResources: 0;
  result: "PASS";
}>;

type GitleaksControllerContract = Readonly<{
  schemaVersion: "organization-identity-gitleaks-controller-contract/v2";
  rootDirectory: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/gitleaks";
  requestRoot: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/gitleaks/requests";
  outputRoot: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/gitleaks/outputs";
  controllerSourceBlobId: string;
  controllerSourceSha256: string;
  controllerSourceClosure: ControllerSourceClosureV1;
  controllerSourceClosureSha256: string;
  executableClosure: readonly ExternalControllerExecutableEntry[];
  requiredRoles: readonly ["NODE", "GITLEAKS"];
  allowedEnvironmentNames: readonly [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
  ];
  configPath: ".gitleaks.toml";
  configBlobId: string;
  configSha256: string;
  requestSchemaSha256: string;
  resultSchemaSha256: string;
  credentialIngressAllowed: false;
}>;

type GitleaksControllerRequest = Readonly<{
  schemaVersion: "organization-identity-gitleaks-controller-request/v2";
  requestId: string;
  contractSha256: string;
  materializationReceiptSha256: string;
  controllerReviewReceiptSha256: string;
  authorizationReceiptSha256: string;
  subjectCommit: string;
  sourceTreeSha256: string;
  configBlobId: string;
  configSha256: string;
  redact: true;
  noBanner: true;
  outputRecordPath: string;
}>;

type GitleaksControllerReceipt = Readonly<{
  schemaVersion: "organization-identity-gitleaks-controller-receipt/v2";
  contractSha256: string;
  controllerReviewReceiptSha256: string;
  controllerSourceClosureSha256: string;
  requestId: string;
  requestSha256: string;
  authorizationReceiptSha256: string;
  subjectCommit: string;
  sourceTreeSha256: string;
  configBlobId: string;
  executableClosureSetSha256: string;
  findingSetSha256: string;
  redactionVerified: true;
  result: "PASS";
}>;

type RootAnchorControllerContract = Readonly<{
  schemaVersion: "organization-identity-root-anchor-controller-contract/v2";
  rootDirectory: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/root-anchor";
  requestRoot: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/root-anchor/requests";
  outputRoot: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/root-anchor/outputs";
  anchorDirectory: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2";
  anchorPath: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json";
  controllerSource: Readonly<{
    path: "scripts/governance-organization-identity-root-anchor-controller.mjs";
    blobId: string;
    sha256: string;
  }>;
  controllerSourceClosure: ControllerSourceClosureV1;
  controllerSourceClosureSha256: string;
  controllerTests: readonly Readonly<{
    path:
      | "scripts/governance-organization-identity-root-anchor-closure.spec.mjs"
      | "scripts/governance-organization-identity-root-anchor-filesystem.spec.mjs";
    blobId: string;
    sha256: string;
  }>[];
  executableClosure: readonly ExternalControllerExecutableEntry[];
  requiredRoles: readonly ["ENV", "NODE"];
  allowedEnvironmentNames: readonly [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
  ];
  environmentValueRuleSha256: string;
  anchorSchemaSha256: string;
  requestSchemaSha256: string;
  writeReceiptSchemaSha256: string;
  readbackReceiptSchemaSha256: string;
  operationReviewSchemaSha256: string;
  canonicalizationRuleSha256: string;
  rootPolicy: Readonly<{
    ownerUid: 0;
    ownerGid: 0;
    directoryMode: 0o700;
    controllerMode: 0o500;
    recordMode: 0o600;
    anchorMode: 0o600;
    noFollow: true;
    createExclusive: true;
    overwriteAllowed: false;
    fileFsyncRequired: true;
    directoryFsyncRequired: true;
  }>;
  predecessorPolicy: Readonly<{
    mode: "GENESIS_ONLY";
    requiredPredecessorSha256: null;
    targetMustBeAbsent: true;
  }>;
  credentialIngressAllowed: false;
  anchorSelfHashFieldAllowed: false;
}>;

type AdmittedRefreshAcceptanceEvidenceV1 = Readonly<{
  schemaVersion: "organization-identity-admitted-refresh-acceptance-evidence/v1";
  artifactACommit: "2400bac28796bae44294114edc99eaccb1bd65b3";
  admittedLiveMainSha: string;
  refreshMergeCommit: string;
  refreshParents: readonly [string, string];
  currentMainAdmissionCommit: string;
  b0ImplementationSha: string;
  b0AcceptanceSha: string;
  acceptanceReviewSha256: string;
  result: "PASS";
}>;

type WorkflowRunEvidenceV1 = Readonly<{
  schemaVersion: "organization-identity-workflow-run-evidence/v1";
  repository: "mlhjyx/global-backend";
  workflowPath: ".github/workflows/organization-identity-writer-anchor.yml";
  workflowBlobId: string;
  event: "push" | "pull_request_target";
  ref: "refs/heads/main" | string;
  headSha: string;
  runId: number;
  runAttempt: number;
  conclusion: "success";
  result: "PASS";
}>;

type ExactAuthorizationReceiptV1 = Readonly<{
  schemaVersion: "organization-identity-exact-authorization/v1";
  authorizationClass:
    | "LOCAL_ROOT_MATERIALIZATION"
    | "GITHUB_CONTROLLER_OPERATION"
    | "GITLEAKS_CONTROLLER_OPERATION"
    | "DISPOSABLE_POSTGRES_CONTROLLER_OPERATION"
    | "ROOT_ANCHOR_CONTROLLER_MATERIALIZATION"
    | "ROOT_ANCHOR_WRITE"
    | "V3_WORKTREE_CREATE";
  authorizedRequestSha256: string;
  authorizedSubjectSha256: string;
  grantedBySha256: string;
  grantedAt: string;
  expiresAt: string;
  scopeSha256: string;
  containsCredentialValue: false;
  result: "PASS";
}>;

type RootAnchorUpstreamEvidenceClosureV2 = Readonly<{
  localLauncherReview: LauncherMaterializationReviewReceipt;
  bootstrapContract: BootstrapContract;
  githubProtectedMainReadback: GitHubControllerReceipt;
  githubControllerVariableWrite: GitHubControllerReceipt;
  protectedBaseLaunch: ProtectedBaseLauncherReceipt;
  admittedRefreshAcceptance: AdmittedRefreshAcceptanceEvidenceV1;
  workflowRun: WorkflowRunEvidenceV1;
  rootAnchorControllerMaterialization: ExternalControllerMaterializationReceipt;
  rootAnchorControllerReview: ControllerReviewReceipt;
  rootAnchorAuthorization: ExactAuthorizationReceiptV1;
}>;

type RootAnchorWriteRequest = Readonly<{
  schemaVersion: "organization-identity-root-anchor-write-request/v1";
  requestId: string;
  contractSha256: string;
  materializationReceiptSha256: string;
  controllerReviewReceiptSha256: string;
  controllerSourceClosureSha256: string;
  authorizationReceiptSha256: string;
  targetPath: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json";
  targetMode: 0o600;
  predecessor: Readonly<{
    mode: "GENESIS_ONLY";
    sha256: null;
    targetMustBeAbsent: true;
  }>;
  localLauncherEvidenceSha256: string;
  bootstrapContractSha256: string;
  githubControllerEvidenceSha256: string;
  protectedBaseEvidenceSha256: string;
  admittedRefreshAcceptanceEvidenceSha256: string;
  orderedMergeParents: readonly [string, string];
  workflowRunEvidenceSha256: string;
  controllerVariableWriteReceiptSha256: string;
  upstreamEvidenceClosureSha256: string;
  canonicalAnchorPayloadSha256: string;
  canonicalAnchorPayloadSize: number;
  writeReceiptPath: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/root-anchor/outputs/root-anchor-write-receipt.json";
}>;

type RootAnchorWriteReceipt = Readonly<{
  schemaVersion: "organization-identity-root-anchor-write-receipt/v2";
  contractSha256: string;
  materializationReceiptSha256: string;
  controllerReviewReceiptSha256: string;
  controllerSourceClosureSha256: string;
  requestSha256: string;
  authorizationReceiptSha256: string;
  targetPath: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json";
  anchorSha256: string;
  anchorSize: number;
  ownerUid: 0;
  ownerGid: 0;
  mode: 0o600;
  device: string;
  inode: string;
  predecessorSha256: null;
  fileFsyncSha256: string;
  directoryFsyncSha256: string;
  prePostToctouSha256: string;
  anchorContainsSelfHash: false;
  result: "PASS";
}>;

type RootAnchorReadbackReceipt = Readonly<{
  schemaVersion: "organization-identity-root-anchor-readback/v2";
  contractSha256: string;
  materializationReceiptSha256: string;
  controllerReviewReceiptSha256: string;
  controllerSourceClosureSha256: string;
  requestSha256: string;
  writeReceiptSha256: string;
  targetPath: "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json";
  noFollowVerified: true;
  ownerUid: 0;
  ownerGid: 0;
  mode: 0o600;
  device: string;
  inode: string;
  anchorSha256: string;
  anchorSize: number;
  canonicalSchemaSha256: string;
  inputEvidenceSetSha256: string;
  predecessorSha256: null;
  anchorContainsSelfHash: false;
  prePostToctouSha256: string;
  reviewerClass: "INDEPENDENT_ROOT_ANCHOR_READBACK";
  result: "PASS";
}>;

type RootAnchorOperationReviewReceipt = Readonly<{
  schemaVersion: "organization-identity-root-anchor-operation-review/v2";
  controllerContractSha256: string;
  controllerMaterializationReceiptSha256: string;
  controllerReviewReceiptSha256: string;
  controllerSourceClosureSha256: string;
  writeRequestSha256: string;
  writeReceiptSha256: string;
  readbackReceiptSha256: string;
  anchorSha256: string;
  reportSha256: string;
  counterexampleSetSha256: string;
  reviewerClass: "INDEPENDENT_ROOT_ANCHOR_OPERATION_REVIEW";
  critical: 0;
  important: 0;
  verdict: "PASS";
}>;

// validateRootAnchorUpstreamEvidenceClosureV2 rejects unknown or missing keys
// at every level and validates every nested SHA, Git ID, count, path, enum,
// array and literal predicate. It also enforces:
// - githubProtectedMainReadback.repository === protectedBaseLaunch.repository;
// - workflowRun.repository equals the same repository if present in the record;
// - protected-main readback head, protectedBaseCommit, workflow headSha and
//   accepted merge SHA agree;
// - ordered parents in the write request are exactly
//   [admittedLiveMainSha, reviewedB0AcceptanceSha];
// - controller-variable write uses the same GitHub controller contract, review
//   and ControllerSourceClosureV1 as protected-main readback;
// - protectedBaseLaunch.controllerVariableSetSha256 equals the variable-write
//   result digest set;
// - root-anchor materialization/review digests match the write request and
//   final operation review;
// - localLauncherReview.launcherContractSha256 equals
//   bootstrapContract.launcherContractSha256;
// - every operation receipt has containsCredentialValue === false.
// validateRootAnchorOperationReviewClosureV2 additionally recomputes
// writeRequest/writeReceipt/readback/operation-review canonical digests and
// requires operationReviewReceipt.controllerContractSha256,
// controllerMaterializationReceiptSha256, controllerReviewReceiptSha256 and
// controllerSourceClosureSha256 to equal the request/upstream records; requires
// writeReceipt contract/materialization/review/source-closure digests to equal
// the write request; and requires
// readbackReceipt.writeReceiptSha256 === sha256(writeReceipt).

type ProtectedBaseLauncherContract = Readonly<{
  schemaVersion: "organization-identity-protected-base-launcher-contract/v2";
  workflowPath: ".github/workflows/organization-identity-writer-anchor.yml";
  workflowBlobId: string;
  protectedBaseCommit: string;
  launcherSourceBlobId: string;
  bootstrapSourceBlobId: string;
  controllerSourceClosure: ControllerSourceClosureV1;
  controllerSourceClosureSha256: string;
  commandRegistrySha256: string;
  bootstrapContractSha256: string;
  toolLogicalExpectationSetSha256: string;
  runnerOs: "linux";
  runnerArchitecture: string;
  allowedEnvironmentNames: readonly [
    "GITHUB_ACTIONS",
    "GITHUB_EVENT_PATH",
    "GITHUB_REPOSITORY",
    "GITHUB_REF",
    "GITHUB_SHA",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "RUNNER_OS",
    "RUNNER_ARCH",
    "RUNNER_TEMP",
    "GITHUB_TOKEN_HANDLE",
  ];
  hostedMaterializationSchemaSha256: string;
  eventInputSchemaSha256: string;
  controllerVariableNameSetSha256: string;
  githubControllerContractSha256: string;
  prBytesExecutable: false;
}>;

type ProtectedBaseLaunchRequest = Readonly<{
  schemaVersion: "organization-identity-protected-base-launch-request/v1";
  requestId: string;
  contractSha256: string;
  protectedBaseCommit: string;
  workflowBlobId: string;
  event: "push" | "pull_request_target";
  eventInputPath: string;
  eventInputSha256: string;
  repository: "mlhjyx/global-backend";
  ref: string;
  headSha: string;
  runId: number;
  runAttempt: number;
  controllerVariableSetSha256: string;
  githubControllerReceiptSetSha256: string;
  prTreeDataSha256: string | null;
  localEquivalenceInputSha256: string;
  outputRecordPath: string;
}>;

type ProtectedBaseLauncherReceipt = Readonly<{
  schemaVersion: "organization-identity-protected-base-launcher-receipt/v2";
  contractSha256: string;
  contractReviewReceiptSha256: string;
  controllerSourceClosureSha256: string;
  workflowBlobId: string;
  protectedBaseCommit: string;
  event: "push" | "pull_request_target";
  repository: "mlhjyx/global-backend";
  ref: string;
  runId: number;
  runAttempt: number;
  runnerOs: "linux";
  runnerArchitecture: string;
  runnerUid: number;
  materializedTaskRootSha256: string;
  materializedSourceBlobSetSha256: string;
  executableClosureSetSha256: string;
  toolLogicalIdentitySetSha256: string;
  eventInputSha256: string;
  controllerVariableSetSha256: string;
  requestSetSha256: string;
  outputReceiptSetSha256: string;
  prePostToctouSha256: string;
  prBytesExecuted: false;
  result: "PASS";
}>;

type ProtectedBaseLauncherReceiptReview = Readonly<{
  schemaVersion: "organization-identity-protected-base-launcher-receipt-review/v2";
  contractSha256: string;
  contractReviewReceiptSha256: string;
  controllerSourceClosureSha256: string;
  protectedBaseLauncherReceiptSha256: string;
  reportSha256: string;
  counterexampleSetSha256: string;
  reviewerClass: "INDEPENDENT_HOSTED_LAUNCHER_REVIEW";
  critical: 0;
  important: 0;
  verdict: "PASS";
}>;
```

`ControllerReviewReceipt.materializationReceiptSha256` is non-null for the root-materialized GitHub/Gitleaks/disposable controllers. It is null only for Task 6's pre-run protected-base contract/source review; the first hosted materialization is instead bound by `ProtectedBaseLauncherReceipt` and its independent `ProtectedBaseLauncherReceiptReview` in Task 9. No null is accepted for a controller operation receipt.

The root-only wrapper accepts exactly one path to a discriminated `ClosedCommandRequest` below `LauncherContract.requestRoot`. It performs no shell evaluation and gives the request to the pinned absolute Node executable as `<tool-root>/bin/env -i <exact-local-environment> <tool-root>/bin/node <root-launcher.mjs> --request <path>`, where the exact environment values are the reviewed `LauncherContract.runtimeEnvironment` map and `PATH` is only `<tool-root>/bin`. Before dispatch, the stdlib launcher verifies request/root owner, mode, realpath, device, inode, create-exclusive provenance, canonical bytes, content-addressed URI, payload schema/digest and exact output path; it rejects unknown/extra JSON keys, filename-derived inputs, arbitrary argv, free-form commands, unregistered modes/environment names, reused request IDs, non-owned/symlinked paths and receipt drift before any non-`node:` dependency load.

The local registry is deliberately limited to bootstrap, scanner, tests, static repository verification, local source Git transitions and v3 worktree creation using only the exact `ENV`/`NODE`/`GIT`/Corepack/pnpm closure. It contains no fetch/push/PR/GitHub/workflow/controller-variable, Gitleaks, Docker, `psql`, disposable PostgreSQL or root-anchor command. A current interactive shell, `jq`, repository package script, credential value, unlisted executable or PR-controlled workflow byte is never part of a local authority claim.

`requestId` is the lowercase SHA-256 of canonical `(taskId, commandId, mode, subjectCommit, inputRecordSha256, payloadSchemaSha256, payloadSha256, authorizationReceiptSha256, externalControllerReceiptSha256, anchorReceiptSha256)`. `inputRecordUri` is exactly `sha256:<inputRecordSha256>`. Input and output basenames are exactly `<taskId>-<commandId-lowercase>-<requestId>.input.json` and `.output.json` below the contract roots; the validator rejects every alternate path or existing output. Each request variant's `parameters` is the complete canonical content of its typed input record, so no neighboring file, filename convention, hidden flag or ambient environment supplies an argument.

`SCOPED_REVIEW_VERIFY_V1/VERIFY` parses `ScopedReviewReceipt`, recomputes subject/range/path/report/counterexample digests, and rejects extra/missing keys, duplicate/conflicting severity fields, any nonzero Critical/Important, or a verdict other than PASS. For the launcher's own first review, the external reviewer also performs three separate exact assertions—`rg -qx 'Critical: 0'`, `rg -qx 'Important: 0'`, `rg -qx 'Verdict: PASS'`—and proves each label occurs exactly once before trusting the new verifier. Those direct assertions are bootstrap-of-trust checks only; every later machine review gate uses the exact mode.

The immutable `BootstrapContract` contains only exact-key schemas, derivation/comparison rules, local allowed environment names, pnpm argv policy and logical tool/version expectations. It contains no subject commit, subject configuration/absence digest, task root, realpath, inode, environment value, generated output or timestamp. `BootstrapRunReceipt` contains all of those per-command observations and binds exactly one request ID, command ID, mode, task ID, typed input/payload, output, subject, authorization/external-controller/anchor receipts and external launch. Reusing one receipt for a second command/request is `BOOTSTRAP_RECEIPT_REPLAY`; a task with multiple commands creates one receipt per command and a sorted `BootstrapRunReceiptSet` only for aggregation.

Validation uses this fixed algorithm:

1. Validate exact keys and schemas for contract, request, external launch and run receipt; reject any field path absent from the receipt schema or any purported variable path absent from `perRunVariableFieldPaths`.
2. Recompute the contract/launcher/materialization/review digests, request canonical SHA, typed input URI/path/SHA, payload schema/SHA, internally derived argv SHA and create-exclusive output path before loading dependencies.
3. Derive `subjectConfigurationSetSha256`, `subjectAbsenceSentinelSetSha256` and `subjectGitClosureSha256` from the exact run subject using the contract's invariant derivation rules. Compare them with the run receipt and the admitted current-main path dispositions; never compare them to an older B0 run.
4. Resolve every subject lock entry against `toolLogicalExpectations`; logical package/version/role/derivation rules must be invariant, while lock integrity, resolved realpath, loaded file set and TOCTOU are fresh nested run fields validated from current bytes.
5. Require the exact environment-name set; validate each fresh HOME/XDG/Corepack/pnpm/TMP/config value is below the current task root and hash it into `environmentValueSetSha256`. No unnamed environment or receipt field is normalizable.
6. Recompute task-root containment, device/inode/mode, dependency/tool roots, Prisma/generated outputs, hostile-marker zero, pre/post TOCTOU and output receipt; then atomically issue exactly one `BootstrapRunReceipt` for that request.

An admitted main change to package/config/sentinel bytes changes the subject-bound run digests and is either accepted by the unchanged derivation rules plus exact `CurrentMainAdmission` dispositions or returns `BUILD_SURFACE_DRIFT/HOLD`. It does not regenerate the immutable contract. A change to command/request schemas, derivation/comparator rules, allowed environment names, logical tool/version/role expectations or launcher/bootstrap source requires a separately reviewed new contract and new root materialization; no task silently evolves it.

The authority pnpm invocation is exactly `install --frozen-lockfile --ignore-scripts --ignore-pnpmfile` with `ignorePnpmfile=true`, `NPM_CONFIG_USERCONFIG=/dev/null`, and fixed store/virtual-store/modules/cache/config roots under the fresh task root. Before pnpm, the root controller verifies accepted Git blobs and required absence for package/workspace/lock/bootstrap/test files, `.dockerignore`, `.npmrc`, every `.pnpmfile*`, `patches/`, hook/config-dependency inputs and all executable/config/storage selectors. After install it rehashes bootstrap inode/realpath/digest. Prisma generation precedes generated-output verification; TypeScript/scanner modules are loaded only by dynamic import after all preflight receipts pass.

Every later reference to a local “authority run” means this exact outer form, with the request/input bytes written create-exclusively by the root controller and bound to the declared command ID/mode, subject, contract, authorization/external-controller receipt, optional anchor and one fresh command receipt:

```bash
/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher/identity-writer-launch \
  --request /global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/requests/task-0a-current-main-validate.json
```

The displayed Task 0A request is the concrete local form; every task below names its exact `ClosedCommandId`/mode, canonical request/input/output path and fresh receipt. Direct `node`, `pnpm`, local `git`, `jq` or `rg` blocks document non-authority diagnostics or internal local expansions. Direct `gh`, remote `git`, Gitleaks, Docker or `psql` blocks are diagnostics only: authority for those operations exists solely through the matching independently authorized `GitHubControllerReceipt`, `GitleaksControllerReceipt` or `DisposablePostgresControllerReceipt`, which the local launcher may verify as data but never execute.

Each external controller contract/materialization and each state-changing request has its own exact authorization and independent zero-Critical/zero-Important/PASS `ControllerReviewReceipt`. Executable closure, request/payload/result schemas and credential-handle scope are fixed before execution. Credential receipts contain only handle/scope digests; secret values never enter requests, outputs, logs or durable receipts.

### Current-main admission contracts and validator API

```ts
type AuditReviewReceipt = Readonly<{
  schemaVersion: "organization-identity-current-main-audit-review/v1";
  disposition: "PASS" | "FETCH_AUTH_REQUIRED";
  auditPacketSha256: string;
  githubControllerContractSha256: string;
  githubControllerReviewReceiptSha256: string;
  protectedMainReadbackReceiptSha256: string;
  localBootstrapRunReceiptSetSha256: string;
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
  launcherMaterializationReviewReceiptSha256: string;
  bootstrapContract: BootstrapContract;
  baselineBootstrapRunReceiptSetSha256: string;
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
    launcherMaterializationReviewReceiptSha256: string;
    bootstrapContractSchemaSha256: string;
    bootstrapContractBlobId: string;
    bootstrapContractSha256: string;
    bootstrapBlobId: string;
    bootstrapSha256: string;
    bootstrapTestBlobId: string;
    bootstrapTestSha256: string;
    runReceiptSchemaSha256: string;
    taskRunReceiptSets: readonly Readonly<{
      taskId: TaskId;
      subjectCommit: string;
      receiptSetSha256: string;
    }>[];
    perRunVariableFieldPathSetSha256: string;
  }>;
  externalControllers: Readonly<{
    githubContractSha256: string;
    githubControllerReviewReceiptSha256: string;
    gitleaksContractSha256: string;
    gitleaksControllerReviewReceiptSha256: string;
    disposablePostgresContractSha256: string;
    disposableControllerReviewReceiptSha256: string;
    protectedBaseLauncherContractSha256: string;
    protectedBaseContractReviewReceiptSha256: string;
    rootAnchorControllerSourceBlobId: string;
    rootAnchorControllerSourceSha256: string;
    rootAnchorControllerTestBlobId: string;
    rootAnchorControllerTestSha256: string;
    rootAnchorControllerContractSchemaSha256: string;
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
  localLauncher: Readonly<{
    contractSha256: string;
    materializationReceiptSha256: string;
    materializationReviewReceiptSha256: string;
    bootstrapContractSha256: string;
    bootstrapContractSchemaSha256: string;
  }>;
  hostedLauncher: Readonly<{
    contractSha256: string;
    receiptSha256: string;
    contractReviewReceiptSha256: string;
    receiptReviewSha256: string;
    equivalenceProofSha256: string;
  }>;
  githubController: Readonly<{
    contractSha256: string;
    materializationReceiptSha256: string;
    controllerReviewReceiptSha256: string;
    mergeAndReadbackReceiptSetSha256: string;
  }>;
  rootAnchorController: Readonly<{
    contractSha256: string;
    materializationReceiptSha256: string;
    controllerReviewReceiptSha256: string;
  }>;
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
  predecessorReceiptSha256: null;
  inputReceiptChainSha256: string;
  containsAnchorSelfHash: false;
  containsSecrets: false;
}>;
```

The anchor payload binds only evidence that does not depend on its own bytes: controller contract/materialization/review plus admitted/merge/hosted inputs. It contains no request SHA, expected-payload SHA, anchor SHA, write receipt, readback receipt or operation-review digest and never hashes itself. The authorized request externally binds the canonical anchor payload SHA; later receipts live only in the external evidence chain.

Local admission accepts the pair `(ProtectedMainAnchor, RootAnchorOperationReviewReceipt)` only from the exact root-owned evidence paths supplied to `ANCHOR_ONLY`. It reopens contract/materialization/review/request/write/readback/operation-review records, recomputes the anchor SHA and requires equality across the entire chain. The ordered `mergeParents` must be `[admittedLiveMainSha, acceptedB0Sha]`; ancestry without ordered-parent equality is insufficient. Every local B1–B6 command has its own fresh `BootstrapRunReceipt`; a task review binds the sorted receipt-set digest.

Hosted admission requires exact `ProtectedBaseLauncherContract` and `ProtectedBaseLauncherReceipt`; no unspecified hosted fallback is accepted. The equivalence verifier compares exact launcher/bootstrap source blobs, command registry digest, bootstrap contract digest/schema, request/output schema digests and logical tool/version/role expectation set. It deliberately does not compare the local Ubuntu root path, UID/GID, device/inode or absolute tool paths: the hosted receipt independently binds its runner UID, materialized task root, resolved executable closure, event/ref/repository/run/controller-variable inputs and TOCTOU. Any logical/source/schema mismatch is `PROTECTED_BASE_EQUIVALENCE_HOLD`.

The base-owned workflow obtains remote/event facts only through the reviewed GitHub controller contract/receipt and executes only the protected-base materialization. A PR may be fetched as a Git tree below the fixed data root, but no PR action, script, package hook, generated executable, workflow, config, launcher, bootstrap, request or controller value may execute.

## Task Dependencies, Review Units, and Critical Path

| Task | Produces                                                                                                | Consumed by         | Dependency                                                                |
| ---- | ------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------- |
| 0L   | Reviewed local launcher plus four external-controller contracts; authorized local materialization       | 0P, then 0A–18      | Exact approved plan; each materialization retains its own exact auth      |
| 0P   | Reviewed immutable bootstrap contract/fresh-run engine and hostile no-exec tests                        | 0L root phase/0A–18 | 0L tracked launcher scoped review PASS                                    |
| 0A   | Reviewed minimal current-main admission validator/contracts consuming launcher/bootstrap                | 0B/0F/0C and 1–8    | 0P PASS plus 0L root materialization/review PASS                          |
| 0B   | Reviewed no-fetch packet with `PASS`, `HOLD`, or `FETCH_AUTH_REQUIRED`                                  | 0F or 0C            | 0A PASS plus separately reviewed GitHub controller/readback receipt       |
| 0F   | Exact GitHub-controller fetch-only object receipt; no merge                                             | 0B rerun only       | Reviewed `FETCH_AUTH_REQUIRED` plus exact fetch request authorization     |
| 0C   | Exact two-parent refresh/admission pair, external Gitleaks receipt and post-refresh review              | 0M and 1–9          | 0B PASS, Gitleaks controller PASS and separate local-merge/tool auth      |
| 0M   | Sole migration, local static plus external disposable receipts and DB/security reviews                  | 1–8 and B4M         | 0C PASS plus migration-file/controller/disposable authorizations          |
| 1    | Closed scanner contracts, CLI shell, refreshed build/bootstrap-surface RED                              | 2–6                 | Separate scanner auth; HEAD descends from accepted `B0M_MIGRATION_COMMIT` |
| 2    | Delegate/capability-boundary engine                                                                     | 4–8 and every stage | 1                                                                         |
| 3    | Raw/wrapper/dependency-closure engine                                                                   | 4–8 and every stage | 1                                                                         |
| 4    | Final stage/derivation/resource/filesystem/redaction/anchor engine, reviewed before baseline generation | 5 and 6–8/B1–B6     | 2 and 3                                                                   |
| 5    | Reviewed refreshed build/raw/migration baselines plus Artifact A Identity authority/six-receipt intake  | 6–8                 | 4 final scanner/derivation review PASS                                    |
| 6    | Package/governance/runtime wiring plus reviewed protected-base launcher contract                        | 7 and 8             | 5                                                                         |
| 7    | Exact `B0_IMPLEMENTATION` review head and independent whole-review digest                               | 8                   | 1–6                                                                       |
| 8    | One-path accepted B0 commit and scoped acceptance review                                                | 9                   | 7                                                                         |
| 9    | GitHub/hosted receipts plus root-anchor write/readback/operation-review chain                           | 10                  | 8 plus separate GitHub/root-controller/write authorizations and reviews   |
| 10   | Exact v3 branch/worktree from protected-main merge                                                      | 11                  | 9 plus explicit local execution approval                                  |
| 11   | B1 Temporal five-outcome/replay RED                                                                     | 12                  | 10                                                                        |
| 12   | B2 Temporal resolver cutover, `3 → 2`                                                                   | 13                  | 11                                                                        |
| 13   | B3 projection five-outcome/chunk/replay RED                                                             | 14                  | 12                                                                        |
| 14   | B4 projection resolver cutover, `2 → 1`                                                                 | 15                  | 13                                                                        |
| 15   | B4M materialization resolver cutover, `1 → 0`                                                           | 16                  | 14                                                                        |
| 16   | B5 mandatory zero and downstream/governance promotion                                                   | 17                  | 15                                                                        |
| 17   | B6 mixed-fleet/replay/race/disposable proof                                                             | 18                  | 16 plus separate disposable-resource authorization                        |
| 18   | Independent whole Artifact B code/security/database review                                              | Handoff only        | 17                                                                        |

Critical path is `0L tracked launcher/four-controller RED/GREEN/commit/review → 0P → local launcher materialization → 0A → GitHub controller → 0B/0F → Gitleaks controller + 0C → disposable controller + 0M → scanner 1–5 → protected-base 6 → whole review/acceptance 7–8 → operation-specific GitHub gates 9 → root-anchor controller materialization/review → separate write authorization → anchor create-exclusive write/fsync → independent readback → operation review → local ANCHOR_ONLY → 10 → 11–18`. Read-only local classification may parallelize only after exact remote readback; 0F never merges. Baselines read `B0_REFRESH_BASE_COMMIT`; no scanner/derivation byte may change after Task 5 raw review without regeneration/review. Every committed unit ends at a scoped review/fix-loop barrier.

Receipt cardinality is part of every dependency edge: each local request/mode creates exactly one fresh `BootstrapRunReceipt`; the task review verifies `receiptCount === requestCount`, exact sorted request/receipt entries and `BootstrapRunReceiptSet.receiptSetSha256`. External controller operations create their own controller receipts and are referenced by digest, never counted as or substituted for local bootstrap receipts. A review/gate command itself is another local request and therefore has its own receipt.

## V2 Delivery: Current-Main Refresh, B0 Implementation, and Local Acceptance

### Task 0L: Closed-Command Launcher, Independent Review, and Separately Authorized Root Materialization

**Files:**

- Create: `scripts/governance-organization-identity-launcher.mjs`
- Create: `scripts/governance-organization-identity-launcher-request.spec.mjs`
- Create: `scripts/governance-organization-identity-launcher-trust.spec.mjs`
- Create: `scripts/governance-organization-identity-launcher-execution.spec.mjs`
- Create: `scripts/governance-organization-identity-test-fixtures.mjs`
- Create: `scripts/governance-organization-identity-root-materialization-packet.mjs`
- Create: `scripts/governance-organization-identity-root-materialization-packet.spec.mjs`
- Create: `scripts/governance-organization-identity-controller-contracts.mjs`
- Create: `scripts/governance-organization-identity-controller-contracts.spec.mjs`
- Create: `scripts/governance-organization-identity-github-controller.mjs`
- Create: `scripts/governance-organization-identity-github-controller.spec.mjs`
- Create: `scripts/governance-organization-identity-disposable-postgres-controller.mjs`
- Create: `scripts/governance-organization-identity-disposable-postgres-controller.spec.mjs`
- Create: `scripts/governance-organization-identity-gitleaks-controller.mjs`
- Create: `scripts/governance-organization-identity-gitleaks-controller.spec.mjs`
- Create: `scripts/governance-organization-identity-root-anchor-controller.mjs`
- Create if needed to keep the entry module below 800 lines: `scripts/governance-organization-identity-root-anchor-filesystem.mjs`
- Create: `scripts/governance-organization-identity-root-anchor-closure.spec.mjs`
- Create: `scripts/governance-organization-identity-root-anchor-filesystem.spec.mjs`
- Create local review: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-0l-launcher-review.md`
- Create local review receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-0l-launcher-review.json`
- Create only after separate root-write authorization: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher/identity-writer-launch`
- Create only after separate root-write authorization and Task 0P PASS: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher/identity-writer-launch.mjs`
- Create only after separate root-write authorization and Task 0P PASS: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher/identity-writer-bootstrap.mjs`
- Create only after separate root-write authorization and Task 0P PASS: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher/launcher-contract.json`
- Create only after separate root-write authorization: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root/bin/env`
- Create only after separate root-write authorization: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root/bin/node`
- Create only after separate root-write authorization: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root/bin/git`
- Create only after separate root-write authorization: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root/lib/corepack/dist/corepack.js`
- Create only after separate root-write authorization: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root/lib/corepack/dist/lib/corepack.cjs`
- Create only after separate root-write authorization: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root/lib/pnpm/9.15.9/bin/pnpm.cjs`
- Create only after separate root-write authorization: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root/lib/pnpm/9.15.9/dist/pnpm.cjs`
- Create only after separate root-write authorization: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime/{runtime,home,xdg-config,xdg-cache,corepack-home,pnpm-home,tmp}`
- Create only after launcher/tool/runtime/request/output fsync and independent readback: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher/launcher-materialization-readback.json`
- Create by the root materialization controller only after launcher/tool/runtime/request/output fsync and readback report: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher/launcher-materialization.json`
- Create by the independent reviewer only after verifying the materialization receipt: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher/launcher-materialization-review.json`
- Test: the three launcher split specs, the root-materialization-packet spec, the controller-contracts spec, GitHub/disposable/Gitleaks controller specs, and both root-anchor split specs.
- Read-only: exact approved plan/spec Git blobs; resolved realpath of `/usr/bin/env`; resolved Node/Git binaries; resolved Corepack `corepack.js` + `lib/corepack.cjs`; resolved pnpm 9.15.9 `bin/pnpm.cjs` + `dist/pnpm.cjs`; after Task 0P, exact reviewed bootstrap source/test/contract identities.

**Interfaces:**

- Consumes: exact approved plan commit/blob/SHA; final spec commit/blob/SHA; local launcher/request/bootstrap schemas; GitHub/Gitleaks/disposable/protected-base controller contracts; final reviewed Task 0P bootstrap commit/report/receipt; and separate exact local/external materialization authorizations.
- Produces: `parseClosedCommandRequest(bytes)`, `verifyLauncherContract(contract, observed)`, `verifyExecutableClosure(entries)`, `dispatchClosedCommand(request, verifiedContext)`, `validateBootstrapRunReceipt`, `validateBootstrapRunReceiptSet`, `validateLauncherReadbackReportV2`, `validateLauncherMaterializationReceiptV3`, `validateLauncherMaterializationReviewReceiptV3`, `validateBootstrapContractV2`, `validateGitHubControllerReceiptV2`, `validateProtectedBaseLauncherReceiptV2`, `validateAdmittedRefreshAcceptanceEvidenceV1`, `validateWorkflowRunEvidenceV1`, `validateControllerVariableWriteReceiptV2`, `validateRootAnchorUpstreamEvidenceClosureV2`, `validateRootAnchorOperationReviewClosureV2`, `validateVerifiedWorktreeReceiptV1`, `validateControllerSourceClosureV1`, `buildControllerReceiptSetSha256`, the tracked local-only ignored-packet generator `scripts/governance-organization-identity-root-materialization-packet.mjs`, its spec, independently reviewed tracked controller sources/contracts, and—only after the later local root authorization—the exact four launcher files, seven tool-root regular files, runtime roots, request/output roots, readback, materialization and materialization-review receipt chain. The local dispatcher never accepts arbitrary commands, external executables, caller-asserted worktrees or credentials.
- Produces: `parseClosedCommandRequest(bytes)`, `verifyLauncherContract(contract, observed)`, `verifyExecutableClosure(entries)`, `dispatchClosedCommand(request, verifiedContext)`, `validateBootstrapRunReceipt`, `validateBootstrapRunReceiptSet`, `validateLauncherReadbackReportV2`, `validateLauncherMaterializationReceiptV3`, `validateLauncherMaterializationReviewReceiptV3`, `validateLauncherMaterializationPacketV4`, `validateLauncherMaterializationPacketReviewReceiptV1`, `validateLauncherRootMaterializationRequestV1`, `validateBootstrapContractV2`, `validateGitHubControllerReceiptV2`, `validateProtectedBaseLauncherReceiptV2`, `validateAdmittedRefreshAcceptanceEvidenceV1`, `validateWorkflowRunEvidenceV1`, `validateControllerVariableWriteReceiptV2`, `validateRootAnchorUpstreamEvidenceClosureV2`, `validateRootAnchorOperationReviewClosureV2`, `validateVerifiedWorktreeReceiptV1`, `validateControllerSourceClosureV1`, `buildControllerReceiptSetSha256`, the tracked local-only ignored-packet generator `scripts/governance-organization-identity-root-materialization-packet.mjs`, its spec, independently reviewed tracked controller sources/contracts, and—only after the later local root authorization—the exact four launcher files, seven tool-root regular files, runtime roots, request/output roots, readback, materialization and materialization-review receipt chain. The local dispatcher never accepts arbitrary commands, external executables, caller-asserted worktrees or credentials.

**Commit message:** `feat: add closed identity governance launcher`

**Coverage amendment (2026-09-04):**

- Keep `scripts/governance-organization-identity-bootstrap-supplemental.spec.mjs` bounded to Task 0P bootstrap-only hostile/coverage cases; it must not become the place where launcher root-bound trust/output/default-Git coverage is padded in.
- If the normalized aggregate for `scripts/governance-organization-identity-launcher.mjs` plus `scripts/governance-organization-identity-bootstrap.mjs` remains below `>=80%` lines and `>=80%` functions after the bounded Task 0P bootstrap suite, close the remaining launcher spans only in the existing `scripts/governance-organization-identity-launcher-request.spec.mjs` and `scripts/governance-organization-identity-launcher-execution.spec.mjs`, both still below 800 lines.
- Authorize exactly two development-only stdlib launcher seams for that coverage work:
  1. `export async function verifyFixedLauncherTrust(request, { rootDirectory, fixtureMode } = {})`, where production uses the fixed default `ROOT_DIRECTORY`, and any non-default `rootDirectory` is allowed only when `fixtureMode` explicitly selects a local fixture path for non-authority testing.
  2. `export async function writeCanonicalOutputRecord(outputPath, value, owner, { fixtureRoot } = {})`, implemented only as `createExclusiveOutput(...)` followed by `finalizeOutput(...)`, and rejecting any path outside the explicit fixture root.
- `scripts/governance-organization-identity-launcher-request.spec.mjs` owns the temp-root trust-chain coverage for `readCanonicalRecord(...)` and `verifyFixedLauncherTrust(...)`, including a meaningful PASS plus canonical/digest drift failures; `scripts/governance-organization-identity-launcher-execution.spec.mjs` owns canonical output/readback and default Git snapshot coverage through closed launcher entrypoints, with zero root writes.
- Any authority-model version change to `LauncherContract`, `LauncherMaterializationPacket`, readback/materialization/review receipts, source/destination closure schemas, or generator output shape requires a fresh bootstrap digest rebind and a new whole review before any later root authorization can rely on it.
- Cross-hash cycle boundary is two-phase and commit-sensitive: Phase A freezes `LAUNCHER_SOURCE_COMMIT` by committing only launcher/validator/generator/tests and forbidding any `Hc`-bearing bootstrap bytes in that same commit; `LauncherContract/v3` and later `launcherContractSha256=Hc` may reference only that completed Phase A commit. Phase B is a later, distinct Task 0P commit that writes `Hc` into bootstrap source and `organization-identity-bootstrap-contract.json`. After Phase B, launcher bytes are frozen. If launcher bytes ever change again, the plan restarts from Phase A then repeats Phase B. A single commit that both changes launcher bytes and writes/updates bootstrap bytes carrying `Hc` is forbidden and must fail review.
- Exact commit scopes are fixed: Phase A may modify only Task 0L launcher/generator/test paths and may not include `scripts/governance-organization-identity-bootstrap.mjs`, `scripts/governance-organization-identity-bootstrap.spec.mjs`, `scripts/governance-organization-identity-bootstrap-supplemental.spec.mjs`, or `docs/governance/organization-identity-bootstrap-contract.json`. Phase B may modify only those Task 0P bootstrap paths and may not include launcher/generator/request/execution/trust/controller files. `Hc` is exactly `sha256(canonicalJsonBytes(LauncherContract/v3))`; any `digestRule` or projection surrogate is forbidden for current authority.
- Source-to-destination tool copy invariants are mechanical and ordered: the fixed seven-role order is `ENV`, `NODE`, `GIT`, `COREPACK_SHIM`, `COREPACK_LIB_COREPACK_CJS`, `PNPM_SHIM`, `PNPM_ENTRYPOINT`. For each position, `logicalIdentity`, `sourceSha256`, and `sourceSize` must equal the corresponding destination entry's `logicalIdentity`, `sha256`, and `size`; destination path must be the exact fixed `TOOL_ROOT` absolute path and path digest for that role; destination mode must equal the policy-fixed `0500` or `0400`; source mode is provenance only and is not required to equal destination mode.
- Historical `LauncherContract/v2`, `LauncherMaterializationPacket/v2` and `/v3`, `LauncherReadbackReport/v1`, `LauncherMaterializationReceipt/v2`, and `LauncherMaterializationReviewReceipt/v2` are retained only as historical `HOLD` diagnostics and are never accepted as current authority inputs.
- Reviewers reject no-op coverage padding. The gate closes only when those launcher/bootstrap percentages are reached by meaningful execution of the remaining root-bound behaviors under the allowed seams.

- [ ] **Step 1: Verify the future approved/committed local execution state and create the ignored review parent**

Run only after this exact plan is independently approved and committed. Use `mkdir -p .superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source`, create `.superpowers/sdd/.gitignore` with exact content `*` by `apply_patch` if absent, verify `git check-ignore`, and require a clean tracked/untracked worktree. This local phase is authorized by exact plan approval; no root path may exist or be written yet.

- [ ] **Step 2: Split Task 0L tests and write RED fixtures**

First split the old launcher/root-anchor spec shape into the exact file map above. Move shared fixture builders only to `scripts/governance-organization-identity-test-fixtures.mjs`; no production validator or controller execution logic may move there. Run a line-count check and stop if any non-exempt Task 0L file is still at or above 800 lines after the split.

`scripts/governance-organization-identity-launcher-request.spec.mjs` tests every exact schema key and enum plus mutations for an extra argv, arbitrary command/mode, shell metacharacter, unknown environment name, inherited `NODE_OPTIONS`/`NODE_PATH`, accessor/proxy JSON surrogate, relative/out-of-request-root input/output, wrong content-addressed URI, payload-schema mismatch, request replay, receipt reuse, malformed canonical bytes and non-null `verifiedWorktreeReceiptSha256` on non-Git modes.

`scripts/governance-organization-identity-launcher-trust.spec.mjs` asserts complete local executable closure equality, including separate entries for `COREPACK_SHIM`, `COREPACK_LIB_COREPACK_CJS`, `PNPM_SHIM`, and `PNPM_ENTRYPOINT`; requires each authority-used entry to materialize as the exact reviewed regular file under `tool-root`; rehashes approved plan/spec, wrapper, launcher, bootstrap, contract, tool-root receipt, materialization readback, materialization receipt, review receipt, runtime roots, request/output roots and every executable entry; and rejects caller-provided worktree objects unless `VerifiedWorktreeReceiptV1` is derived by the launcher-controlled Git closure and matches branch, clean status, head, subject and repository realpaths.

`scripts/governance-organization-identity-launcher-execution.spec.mjs` asserts GitHub/Gitleaks/Docker/psql IDs are absent from the local registry, every local argv is built internally, no generic executor can run a controller operation, and every rejected request performs zero dependency loads and zero hostile-marker executions.

`scripts/governance-organization-identity-controller-contracts.spec.mjs` owns shared validator RED fixtures for `ControllerSourceClosureV1`, controller materialization/review `/v2`, `VerifiedWorktreeReceiptV1`, `RootAnchorUpstreamEvidenceClosureV2`, `RootAnchorOperationReviewClosureV2`, canonical digest sets, exact-key rejection, passive credential-like fields, same-shape cross-controller substitution and every declared cross-record invariant.

`scripts/governance-organization-identity-github-controller.spec.mjs` adds RED fixtures proving controller control payloads are never written as API bodies: PR create rejects `{ expectedBaseSha, expectedHeadSha }` inside the body, PR update rejects `expectedBaseSha`/`expectedHeadSha`, PR merge rejects missing body `sha`, workflow readback rejects caller success metadata when returned workflow/head/run/blob facts mismatch, rerun requires successor readback before PASS, and controller-variable write rejects a digest-only record as an executable mutation.

`scripts/governance-organization-identity-disposable-postgres-controller.spec.mjs` and `scripts/governance-organization-identity-gitleaks-controller.spec.mjs` add RED fixtures for controller-owned CLI execution loops using local adapters only: no caller executor or argv substitution, exact materialization/review/authorization preflight before execution, fixed phase grammar, one create-exclusive output record, digest-bound receipt, cleanup `finallyPlan` on failure, retained resource count zero for disposable, source/config mismatch fail-before-exec for Gitleaks, and redaction false or unredacted result rejected.

`scripts/governance-organization-identity-root-anchor-closure.spec.mjs` tests extra target/path/file, wrong authorization, reordered parents/input receipts, incomplete upstream records, inconsistent protected-main/protected-base/workflow/acceptance commits, controller-variable source-closure mismatch, root materialization/review digest mismatch, wrong final controller contract/materialization/review/source-closure digest binding and current-shell/GitHub/local-launcher substitution. `scripts/governance-organization-identity-root-anchor-filesystem.spec.mjs` tests pre-existing target, overwrite/truncate/rename-over-existing, symlink/hardlink/nonregular target, non-root owner, broader mode, stale/non-null predecessor, partial file/directory fsync, pre/post inode swap, canonical payload mismatch, anchor self-hash/circular receipt and reused request.

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
node --test \
  scripts/governance-organization-identity-launcher-request.spec.mjs \
  scripts/governance-organization-identity-launcher-trust.spec.mjs \
  scripts/governance-organization-identity-launcher-execution.spec.mjs \
  scripts/governance-organization-identity-root-materialization-packet.spec.mjs \
  scripts/governance-organization-identity-controller-contracts.spec.mjs \
  scripts/governance-organization-identity-github-controller.spec.mjs \
  scripts/governance-organization-identity-disposable-postgres-controller.spec.mjs \
  scripts/governance-organization-identity-gitleaks-controller.spec.mjs \
  scripts/governance-organization-identity-root-anchor-closure.spec.mjs \
  scripts/governance-organization-identity-root-anchor-filesystem.spec.mjs
```

Expected: FAIL because the launcher module does not exist. This direct local Node run is development evidence only and cannot satisfy an authority gate.

- [ ] **Step 4: Implement the stdlib-only exact parser and predependency verifier**

Use only `node:` built-ins with no static/imported package dependency. Parse canonical JSON into a null-prototype plain record; reject extra/missing keys, accessors/proxies exposed by test adapters, non-NFC strings and non-absolute controller paths. Promote `scripts/governance-organization-identity-controller-contracts.mjs` into the single shared exact-key validator layer and add the exported validators named in the Task 0L interface list. Its validators own `ControllerSourceClosureV1`, controller materialization/review `/v2`, GitHub `/v2` request/receipt shape, protected-base `/v2` shape, `VerifiedWorktreeReceiptV1`, `RootAnchorUpstreamEvidenceClosureV2`, `RootAnchorOperationReviewClosureV2`, credential-like passive-field rejection and canonical receipt-set hashing.

Before dispatch, lstat/open/fstat/realpath/hash the approved plan/spec/wrapper/launcher/bootstrap bytes, launcher contract, materialization readback, materialization receipt, materialization review, request root, output root, environment schema and every executable-closure entry; repeat the inode/device/digest readback immediately before dependency loading. For Git-backed local commands, derive `VerifiedWorktreeReceiptV1` inside the launcher-controlled Git closure and compare worktree path, branch, clean status digest, head, subject commit, `.git` realpath and common-dir realpath before setting `invocation.cwd`. `dispatchClosedCommand` must not accept `verifiedContext.verifiedWorktree` or any caller-built worktree surrogate.

- [ ] **Step 5: Implement the closed dispatcher and reviewed wrapper content contract**

`dispatchClosedCommand` uses an exhaustive `switch` over the local-only `ClosedCommandId` and an exhaustive second switch over each variant's mode; `GIT_REFRESH_START_V1` and `GIT_REFRESH_COMMIT_V1` are separate. It opens the typed input record, validates that its canonical payload equals the request parameters/digests and constructs the complete argv internally. Scanner baseline/stage/acceptance and API test selections accept only their exact mode/suite unions. The root wrapper content is fixed and reviewed: it accepts exactly `--request ABSOLUTE_REQUEST_PATH`, rejects every other argc/flag, and `exec`s only `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root/bin/env -i` with the exact reviewed values `PATH=<tool-root>/bin`, `HOME=<runtime>/home`, `XDG_CONFIG_HOME=<runtime>/xdg-config`, `XDG_CACHE_HOME=<runtime>/xdg-cache`, `COREPACK_HOME=<runtime>/corepack-home`, `PNPM_HOME=<runtime>/pnpm-home`, `TMPDIR=<runtime>/tmp`, `NPM_CONFIG_USERCONFIG=/dev/null`, `CI=1`, `LANG=C.UTF-8`, and `LC_ALL=C.UTF-8`, then `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root/bin/node`, the root `identity-writer-launch.mjs`, and that request. It performs no `eval`, command substitution, PATH lookup outside `<tool-root>/bin`, JSON parsing, `jq`, sourcing or package load.

The GitHub controller separates authorization/control payloads from actual REST API bodies. It validates `GitHubControllerRequestV2.payload` as a closed precondition record, validates `apiRequestBody` as the exact object sent to `gh api --input`, and records `apiRequestBodySha256` independently. PR create/update performs immediate post-readback of base/head/title/body digest; merge performs immediate pre-readback of PR head/base and allowed merge method, sends exactly `{ merge_method: "merge", sha: expectedHeadSha }` plus only contracted commit title/message fields, then reads merge response, branch head and ordered parents. Workflow readback validates the returned workflow path/blob/event/ref/head/run/attempt/conclusion. Rerun only records the rerun request and cannot claim PASS until a successor readback receipt validates the new run attempt. Controller variables are fifteen exact GitHub variable create/update API bodies or fifteen separate request records, never one digest-only executable mutation.

The disposable PostgreSQL and Gitleaks controllers each own a closed CLI execution loop tested only with local adapters. `runDisposablePostgresControllerCli(argv, adapters)` and `runGitleaksControllerCli(argv, adapters)` open one canonical request, validate materialization/review/authorization/source closure, execute only the fixed phase grammar for their controller class, write exactly one output record create-exclusively, and validate/return one receipt. Disposable always runs a `finallyPlan` and proves retained resources are zero. Gitleaks verifies exact source/config readback and redaction before the receipt can pass.

The root-anchor entry module deletes duplicated upstream schema fragments and delegates to `validateRootAnchorUpstreamEvidenceClosureV2`. It keeps only root-anchor-specific canonical payload planning, no-follow/create-exclusive filesystem write, fsync, readback and operation-review entrypoints. If removing upstream validators does not bring the entry module below 800 lines, move only filesystem helpers into `scripts/governance-organization-identity-root-anchor-filesystem.mjs`; the entry module remains the public controller surface.

The GREEN order is fixed: shared controller-contract validators first, launcher request parser second, launcher trust/worktree receipt third, launcher execution dispatcher fourth, GitHub API-body/readback controller fifth, disposable controller loop sixth, Gitleaks controller loop seventh, root-anchor closure/filesystem eighth, line-count/diff checks ninth. A later phase may not mask an earlier RED; every failing fixture either turns green in that phase or remains an explicit HOLD before review.

- [ ] **Step 6: Run local GREEN, mutation tests, and diff check**

```bash
node --test \
  scripts/governance-organization-identity-launcher-request.spec.mjs \
  scripts/governance-organization-identity-launcher-trust.spec.mjs \
  scripts/governance-organization-identity-launcher-execution.spec.mjs \
  scripts/governance-organization-identity-root-materialization-packet.spec.mjs \
  scripts/governance-organization-identity-controller-contracts.spec.mjs \
  scripts/governance-organization-identity-github-controller.spec.mjs \
  scripts/governance-organization-identity-disposable-postgres-controller.spec.mjs \
  scripts/governance-organization-identity-gitleaks-controller.spec.mjs \
  scripts/governance-organization-identity-root-anchor-closure.spec.mjs \
  scripts/governance-organization-identity-root-anchor-filesystem.spec.mjs
git diff --check -- \
  scripts/governance-organization-identity-launcher.mjs \
  scripts/governance-organization-identity-launcher-request.spec.mjs \
  scripts/governance-organization-identity-launcher-trust.spec.mjs \
  scripts/governance-organization-identity-launcher-execution.spec.mjs \
  scripts/governance-organization-identity-test-fixtures.mjs \
  scripts/governance-organization-identity-root-materialization-packet.mjs \
  scripts/governance-organization-identity-root-materialization-packet.spec.mjs \
  scripts/governance-organization-identity-controller-contracts.mjs \
  scripts/governance-organization-identity-controller-contracts.spec.mjs \
  scripts/governance-organization-identity-github-controller.mjs \
  scripts/governance-organization-identity-github-controller.spec.mjs \
  scripts/governance-organization-identity-disposable-postgres-controller.mjs \
  scripts/governance-organization-identity-disposable-postgres-controller.spec.mjs \
  scripts/governance-organization-identity-gitleaks-controller.mjs \
  scripts/governance-organization-identity-gitleaks-controller.spec.mjs \
  scripts/governance-organization-identity-root-anchor-controller.mjs \
  scripts/governance-organization-identity-root-anchor-filesystem.mjs \
  scripts/governance-organization-identity-root-anchor-closure.spec.mjs \
  scripts/governance-organization-identity-root-anchor-filesystem.spec.mjs
```

Expected: PASS with zero dependency loads/hostile executions for every rejected request. These remain non-authority development tests because root materialization does not yet exist.

- [ ] **Step 7: Commit and independently review the tracked launcher unit**

```bash
git add scripts/governance-organization-identity-launcher.mjs \
  scripts/governance-organization-identity-launcher-request.spec.mjs \
  scripts/governance-organization-identity-launcher-trust.spec.mjs \
  scripts/governance-organization-identity-launcher-execution.spec.mjs \
  scripts/governance-organization-identity-test-fixtures.mjs \
  scripts/governance-organization-identity-root-materialization-packet.mjs \
  scripts/governance-organization-identity-root-materialization-packet.spec.mjs \
  scripts/governance-organization-identity-controller-contracts.mjs \
  scripts/governance-organization-identity-controller-contracts.spec.mjs \
  scripts/governance-organization-identity-github-controller.mjs \
  scripts/governance-organization-identity-github-controller.spec.mjs \
  scripts/governance-organization-identity-disposable-postgres-controller.mjs \
  scripts/governance-organization-identity-disposable-postgres-controller.spec.mjs \
  scripts/governance-organization-identity-gitleaks-controller.mjs \
  scripts/governance-organization-identity-gitleaks-controller.spec.mjs \
  scripts/governance-organization-identity-root-anchor-controller.mjs \
  scripts/governance-organization-identity-root-anchor-closure.spec.mjs \
  scripts/governance-organization-identity-root-anchor-filesystem.spec.mjs
test ! -e scripts/governance-organization-identity-root-anchor-filesystem.mjs || \
  git add scripts/governance-organization-identity-root-anchor-filesystem.mjs
git commit -m "feat: add closed identity governance launcher"
LAUNCHER_SOURCE_COMMIT="$(git rev-parse HEAD)"
```

The independent reviewer fixes the exact Task 0L path set, plan/spec/launcher/controller blob identities, local-only command/mode/request registry, shared validator exports, `ControllerSourceClosureV1`, `VerifiedWorktreeReceiptV1`, GitHub/disposable/Gitleaks/root-anchor controller operation/request/result/executable/environment/credential contracts, exact GitHub API body separation, controller-owned execution loops, root-anchor upstream/operation-review closure, all non-exempt line counts, exact wrapper content, permission matrix, redaction and hostile counterexamples. Before the new review verifier is trusted, require unique exact `Critical: 0`, `Important: 0`, `Verdict: PASS` lines using separate `rg -qx` commands and record their report/path/counterexample digests in the local Task 0L receipt. Findings produce a forward Task 0L-only fix commit and complete rerun/re-review; no amend.
The Task 0L review also verifies the Phase A boundary: this commit may freeze launcher/validator/generator/tests and compute `Hc=sha256(canonicalJsonBytes(LauncherContract/v3))`, but it must not modify `scripts/governance-organization-identity-bootstrap.mjs`, `scripts/governance-organization-identity-bootstrap.spec.mjs`, `scripts/governance-organization-identity-bootstrap-supplemental.spec.mjs`, or `docs/governance/organization-identity-bootstrap-contract.json`.

- [ ] **Step 8: Complete Task 0P, generate the ignored packet, and stop for separate exact root authorization**

Task 0P now creates/reviews the immutable `BootstrapContract` and bootstrap runner. Return to this step only after its exact final commit/report/receipt exist. Then generate the ignored packet only through the tracked local-only generator `scripts/governance-organization-identity-root-materialization-packet.mjs`, which:

- reads only the exact approved plan/spec/bootstrap/launcher Git objects and the current resolved source tool closure under `O_NOFOLLOW`;
- rejects source drift, plan/spec drift, review drift, worktree dirtiness, historical packet schema reuse, unexpected existing output, and any source executable that is not a resolved live regular file;
- rejects any `sourceToolClosure`/`materializedExecutableClosure` mismatch in fixed seven-role order, including `logicalIdentity` drift, `sourceSha256 != destination.sha256`, `sourceSize != destination.size`, destination path drift from the exact `TOOL_ROOT` absolute path/digest, destination mode drift from policy, review substitution, reuse, or generator drift;
- writes one create-exclusive ignored `LauncherMaterializationPacket/v4`, recommended path `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-0L-root-materialization-packet-v4.json`;
- writes one create-exclusive ignored `LauncherRootMaterializationRequest/v1` only after the packet has already received its own independent review, recommended path `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-0L-root-materialization-request-v1.json`;
- emits a packet whose `launcherContract/v3` contains only immutable pre-write wrapper/launcher destination plan plus contract self-path policy, whose `sourceToolClosure` contains only resolved source facts, whose `materializedExecutableClosure` contains only fixed `TOOL_ROOT` absolute destination paths plus destination path digests/hashes/sizes/modes, and whose bootstrap exact bytes are external to the contract and present only in the packet/materialization chain.

The packet must carry exact `launcherFileCount=4`, `toolRootFileCount=7`, `runtimeRootCount=7`, `requestRootCount=1`, and `outputRootCount=1`; exact five absolute roots; exact `LauncherContract` object plus `launcherContractSha256`; first-class `approvedArtifacts` identities for plan/spec/launcher/bootstrap/bootstrap-contract/generator/generator-spec including commit/blobId/sha256/size; source closure digest; destination closure digest; the three packet-safe review identities `authorityModelPlanReviewSha256`, `task0LFinalCodeReviewSha256`, and `task0PFinalReviewSha256`; root preflight; chronology; and `compatibilityStatus="HISTORICAL_V2_V3_PACKET_MODELS_HOLD_NOT_AUTHORITY_COMPATIBLE"`. The packet must not embed its own later packet-independent review digest, because that would be circular. Historical `task-0L-root-materialization-packet-v2.json` and any `/v2` or `/v3` packet schema remain historical HOLD diagnostics only. STOP and request separate root authorization that names the exact `/v4` packet digest and the external `packetIndependentReviewSha256`. Plan approval, launcher review, Task 0P review, or ignored packet generation do not imply any root write.

- [ ] **Step 9: Independently review the ignored packet before any root write**

Before any root authorization request is usable, conduct an independent local review of the ignored packet and its generator/spec. The review must explicitly challenge:

- pre-materialization immutable plan versus post-write observation separation;
- `sourceToolClosure` versus `materializedExecutableClosure` separation;
- exact `TOOL_ROOT` absolute destination path enforcement and mechanical rejection of `/controlled/bin`, `~/.fnm`, `/root/.cache/node/corepack`, or any non-fixed authority destination;
- self/circular hash exclusion, including contract-file self-digest exclusion;
- create-exclusive ignored output, source/root/HEAD/review drift, and historical packet HOLD compatibility.

Only a zero-Critical/zero-Important/PASS review may authorize the packet for the later root write. Its digest is external to the packet and is later bound by the authorization receipt and `LauncherMaterializationReceipt/v3`; it never appears inside the packet itself. The next create-exclusive object is canonical `LauncherRootMaterializationRequest/v1`, whose `scopeSha256` is `sha256(canonicalJsonBytes(scopeProjection))` for the fixed scope projection `{authorizationClass, subjectCommit, launcherMaterializationPacketSha256, launcherMaterializationPacketReviewReceiptSha256, launcherContractSha256, sourceToolClosureSha256, materializedExecutableClosureSha256, launcherFileCount, toolRootFileCount, runtimeRootCount, requestRootCount, outputRootCount, launcherRoot, toolRoot, runtimeRoot, requestRoot, outputRoot, chronology, targetMustBeAbsent, containsCredentialValue}` and whose `requestId` is `sha256(canonicalJsonBytes(requestTupleWithoutRequestId))`, where `requestTupleWithoutRequestId` is the full canonical request record with the `requestId` field omitted but including `scopeSha256`. Any packet or generator schema change after this review requires a fresh bootstrap digest rebind and a new whole review before authorization.
The Task 0P review also verifies the Phase B boundary: the bootstrap commit may write `Hc` into bootstrap source and tracked bootstrap contract JSON only after the launcher Phase A commit is frozen, and this Task 0P commit may modify only `scripts/governance-organization-identity-bootstrap.mjs`, `scripts/governance-organization-identity-bootstrap.spec.mjs`, `scripts/governance-organization-identity-bootstrap-supplemental.spec.mjs`, and `docs/governance/organization-identity-bootstrap-contract.json`. It must not modify launcher/generator files. Any launcher change after this point restarts the A→B sequence from scratch and requires a new whole review plus coverage rerun on the then-current sources.

- [ ] **Step 10: Materialize only the exact authorized bytes and bind packet + receipt + readback + review**

After separate exact root authorization naming the canonical `LauncherRootMaterializationRequest/v1` SHA and reviewed authorization receipt, the root materialization controller first reopens and cross-validates request + packet + packet-review receipt + authorization receipt. `ExactAuthorizationReceipt` must satisfy all of the following before any write:

- `authorizationClass === LOCAL_ROOT_MATERIALIZATION`;
- `authorizedRequestSha256 === sha256(canonicalJsonBytes(LauncherRootMaterializationRequest/v1))`;
- `authorizedSubjectSha256 === launcherMaterializationPacketSha256`;
- `scopeSha256 === request.scopeSha256`;
- `containsCredentialValue === false`;
- `result === PASS`;
- `grantedAt <= now < expiresAt`.

Only then does it create the launcher root, tool root, runtime root, six runtime subroots, request root, and output root; then materialize exactly four launcher files and seven tool-root regular files. It resolves `/usr/bin/env`, Node, Git, Corepack `corepack.js` + `lib/corepack.cjs`, and pnpm 9.15.9 `bin/pnpm.cjs` + `dist/pnpm.cjs` to regular-file sources before copy, rejects every live symlink/hardlink/nonregular destination, uses create-exclusive temporary files inside the exact parent, verifies source Git blobs and SHA-256 before and after copy, `fsync`s each file and directory, atomically renames, then enforces `root:root`, every directory `0700`, executable wrapper/launcher/bootstrap and copied `env`/`node`/`git` `0500`, copied JavaScript tool files `0400`, and contract `0600`.

The resulting `LauncherMaterializationReceipt/v3` must bind packet + contract + authorization + source + destination in one direction only:

- `launcherMaterializationPacketSha256`;
- `rootMaterializationRequestSha256`;
- `authorizationReceiptSha256`;
- `launcherContractSha256`;
- `sourceToolClosureSha256`;
- `materializedExecutableClosureSha256`;
- the observed launcher/tool/runtime/request/output roots and files;
- the readback report digest and environment value-set digest.

Existing unexpected paths, links, devices, inode changes, broader modes, digest mismatches, destination-path drift, or any source that cannot be re-materialized as the exact reviewed regular-file destination are `ROOT_LAUNCHER_MATERIALIZATION_HOLD`; never overwrite or recursively clean.

- [ ] **Step 11: Independently read back materialization and issue the review receipt**

An independent root-capable reviewer first opens only the four launcher files, seven tool-root files, runtime root plus its six environment subroots, and request/output roots without following symlinks, verifies owner/mode/device/inode/realpath/size/digest, recompares approved Git blobs, confirms the wrapper environment values equal the reviewed packet, recomputes the source and destination closure digests, and create-exclusively writes `LauncherReadbackReport/v2`. The root materialization controller then writes `LauncherMaterializationReceipt/v3`. The independent reviewer finally reopens/verifies packet + contract + authorization receipt + source closure + destination closure + readback + materialization receipt and create-exclusively writes `LauncherMaterializationReviewReceipt/v3`. Actual device/inode values are accepted only here, post-write; they are not part of `LauncherContract/v3` or `LauncherMaterializationPacket/v4`.

This one-way chain is exact and non-circular:

`LauncherContract/v3 + LauncherMaterializationPacket/v4 + authorization receipt -> write/fsync -> LauncherReadbackReport/v2 -> LauncherMaterializationReceipt/v3 -> LauncherMaterializationReviewReceipt/v3`

Historical `LauncherReadbackReport/v1`, `LauncherMaterializationReceipt/v2`, and `LauncherMaterializationReviewReceipt/v2` remain HOLD diagnostics only and are never accepted as current authority inputs.

- [ ] **Step 12: Freeze current trust-root identities and keep external controllers independently authorized**

Record `LAUNCHER_CONTRACT_SHA256`, `LAUNCHER_MATERIALIZATION_PACKET_SHA256`, `LAUNCHER_MATERIALIZATION_RECEIPT_SHA256`, `LAUNCHER_MATERIALIZATION_REVIEW_RECEIPT_SHA256`, `SOURCE_TOOL_CLOSURE_SHA256`, `MATERIALIZED_EXECUTABLE_CLOSURE_SHA256`, exact runtime-environment value-set digest, copied `env`/`node`/`git` destination paths and digests, wrapper/launcher/bootstrap digests, request/output-root receipts, copied Corepack `corepack.js` plus `lib/corepack.cjs`, copied pnpm `bin/pnpm.cjs`/`dist/pnpm.cjs`, and the final packet/review digests. From this point, every local authority command uses one canonical request/input/output and one fresh `BootstrapRunReceipt`; any future launcher/materialization schema version change rebinds bootstrap digests and repeats whole review.

Prepare four separate materialization packets for the reviewed GitHub, Gitleaks, disposable PostgreSQL, and root-anchor controller sources/contracts. Each packet names only that controller's exact executable closure, environment, credential policy, operation/request/result schemas, root target/modes, and review procedure. Do not materialize any controller under Task 0L local-launcher authorization. Task 0B requests the GitHub controller authorization before its first remote readback; Task 0C separately requests Gitleaks controller authorization; Task 0M separately requests disposable controller authorization; Task 9 separately requests root-anchor controller materialization before anchor-write authorization. Every controller materialization/review receipt is machine-verified before a request authorization is sought.

### Task 0P: Clean Pre-Execution Bootstrap, Review Contracts, and Independent Review

**Files:**

- Create: `scripts/governance-organization-identity-bootstrap.mjs`
- Create: `scripts/governance-organization-identity-bootstrap.spec.mjs`
- Create: `scripts/governance-organization-identity-bootstrap-supplemental.spec.mjs`
- Create: `docs/governance/organization-identity-bootstrap-contract.json`
- Create local review parent/exclusion: `.superpowers/sdd/.gitignore`
- Create local review narrative: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-0p-bootstrap-review.md`
- Create local review receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-0p-bootstrap-review.json`
- Test: `scripts/governance-organization-identity-bootstrap.spec.mjs`
- Test: `scripts/governance-organization-identity-bootstrap-supplemental.spec.mjs`
- Read-only: final spec/reviews; `package.json`, `apps/api/package.json`, `packages/db/package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.base.json`, API tsconfigs/Nest config, `.dockerignore`, `.gitignore`, Docker/runtime inputs, current absence of `.npmrc`, `.pnpmfile*`, and `patches/`.

**Interfaces:**

- Consumes: exact final spec commit/hash, reviewed Task 0L tracked launcher/review, pinned Node/Git/Corepack/pnpm/Prisma/TypeScript identities, accepted Git package/config/sentinel subjects, and the clean-launch/bootstrap/review schemas above.
- Produces: stdlib-only bootstrap CLI; exact immutable `docs/governance/organization-identity-bootstrap-contract.json`; `validateExternalLaunchReceipt`; `validateBootstrapContract`; `validateBootstrapRunReceipt`; `compareRunToAcceptedContract`; `materializeAcceptedInstallInputs`; `verifyBootstrapPreimage`; `verifyDependencyAndToolRoots`; `runAcceptedPrismaGenerate`; `loadAcceptedScanner`; `verify-review`; hostile no-exec marker fixtures; the bounded `<800` `scripts/governance-organization-identity-bootstrap-supplemental.spec.mjs` bootstrap-only coverage suite; independently reviewed `BOOTSTRAP_CONTRACT_COMMIT`. Actual authority begins only after Task 0L's separately authorized root materialization of these reviewed bytes.

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

Test exact-key `ExternalLaunchReceipt`, invariant `BootstrapContract`, one-command `BootstrapRunReceipt`, `BootstrapRunReceiptSet`, nested `ToolRootReceipt` and `ScopedReviewReceipt`. Mutate every enumerated `perRunVariableFieldPaths` entry and every unlisted top-level/nested field; require current-subject configuration/absence/lock/root/environment/TOCTOU/generated observations to validate by their invariant derivation rule rather than equality to an older receipt. Test accepted Git blob/absence verification for package/workspace/lock/bootstrap/test/`.dockerignore`/`.npmrc`/every `.pnpmfile*`/patch/config-dependency/hook input, request replay, receipt reuse, immutable fresh materialization, fixed root containment and rejection before a package manager or Node dependency module starts.

- [ ] **Step 4: Write hostile no-execution RED fixtures**

Create marker-bearing fake local/global pnpmfiles, lifecycle scripts, config dependencies, patches, redirected store/cache/config, `NODE_OPTIONS --require/--import`, custom loaders, `NODE_PATH`, changed bootstrap/compiler/generator/engine bytes and symlinks. Instrument module/tool loaders and require marker execution/load counts to remain zero, not merely a later nonzero exit.

- [ ] **Step 5: Run RED**

```bash
node --test \
  scripts/governance-organization-identity-bootstrap.spec.mjs \
  scripts/governance-organization-identity-bootstrap-supplemental.spec.mjs
```

Expected: FAIL because the bootstrap module, immutable contract and run-receipt validators do not exist. This direct Node run is non-authority development evidence.

- [ ] **Step 6: Implement accepted-subject pre-pnpm verification and immutable materialization**

Use only `node:` built-ins. Verify accepted Git blobs/required absence; the resolved realpath of `/usr/bin/env`; resolved Node and Git binaries; resolved Corepack `corepack.js` plus `lib/corepack.cjs`; resolved pnpm 9.15.9 `bin/pnpm.cjs` plus `dist/pnpm.cjs`; and bootstrap identities before constructing a fresh task root. Materialize only accepted package/workspace/lock/bootstrap/config inputs; mutable PR/current-tree bytes remain scanner data and never become installer configuration. Generate the canonical `BootstrapContract` from exact-key/request/output schemas, derivation/comparator rules, allowed environment names and logical tool/version/role expectations only. Explicitly reject subject commits, subject configuration/absence digests, lock integrity, environment values, roots/realpaths/inodes, generated outputs, timestamps or other observations in the contract.

- [ ] **Step 7: Implement the exact clean pnpm command and fixed roots**

The bootstrap returns a data-only closed argv/environment record; it never accepts argv from its caller. `BOOTSTRAP_AUTHORITY_RUN_V1` expands internally to the receipt-selected pnpm entrypoint with `install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --config.ignore-pnpmfile=true`, `NPM_CONFIG_USERCONFIG=/dev/null`, and fixed store/virtual-store/modules/cache/config/task-home roots under the reviewed runtime root. Disable local/global/config-dependency hook selectors. The Task 0P fixtures execute this expansion only inside hostile temporary roots and label it non-authority; after Task 0L root materialization, the exact same expansion can make an authority claim using only the copied tool-root files and reviewed runtime environment values. Missing copied Corepack `corepack.js`/`lib/corepack.cjs` or copied pnpm `bin/pnpm.cjs`/`dist/pnpm.cjs` results in `TOOL_BOOTSTRAP_UNAVAILABLE/HOLD`; never relax a flag or execute postinstall.

- [ ] **Step 8: Implement post-install rehash, Prisma generation and dynamic imports**

After install, reverify bootstrap inode/device/realpath/digest. The stdlib bootstrap rehashes the exact current-subject config/sentinel/lock/tool/declaration inputs, then expands exact `pnpm --filter @global/db generate` under the same clean environment, verifies generated schema/client/DMMF/delegate digests and TOCTOU state, and only then dynamically imports accepted TypeScript/compiler/scanner modules. It emits one fresh `BootstrapRunReceipt` for the exact request/command/mode; the receipt binds subject configuration/absence/Git closure, request/input/payload/output identities, environment-value digest and every nested root/TOCTOU observation. Static top-level `import "typescript"` is forbidden in bootstrap/CLI authority entrypoints.

- [ ] **Step 9: Implement closed review-receipt verification**

`verify-review` rejects missing/extra keys, conflicting/duplicate severity/verdict fields, subject/range/path/report/counterexample digest drift, `critical != 0`, `important != 0`, or `verdict != PASS`. It emits only closed codes/metadata.

- [ ] **Step 10: Run GREEN and hostile marker proof**

```bash
node --test \
  scripts/governance-organization-identity-bootstrap.spec.mjs \
  scripts/governance-organization-identity-bootstrap-supplemental.spec.mjs
git diff --check -- \
  scripts/governance-organization-identity-bootstrap.mjs \
  scripts/governance-organization-identity-bootstrap.spec.mjs \
  scripts/governance-organization-identity-bootstrap-supplemental.spec.mjs \
  docs/governance/organization-identity-bootstrap-contract.json
```

Expected: PASS; every hostile loaded/executed marker count is exactly zero, contract bytes are deterministic across distinct task roots/times/subjects, current-subject receipts differ only at the fully enumerated run paths and still rederive correctly, a receipt cannot serve two commands, and no untrusted value/path/body is printed. This direct run remains development evidence until 0L root materialization.

- [ ] **Step 11: Commit the bounded bootstrap unit**

```bash
git add scripts/governance-organization-identity-bootstrap.mjs \
  scripts/governance-organization-identity-bootstrap.spec.mjs \
  scripts/governance-organization-identity-bootstrap-supplemental.spec.mjs \
  docs/governance/organization-identity-bootstrap-contract.json
git commit -m "feat: add clean identity governance bootstrap"
BOOTSTRAP_CONTRACT_COMMIT="$(git rev-parse HEAD)"
```

- [ ] **Step 12: Run the independent scoped review and fix loop**

The reviewer fixes `BOOTSTRAP_CONTRACT_COMMIT`, its parent/range/path set and final spec hash; adds hostile pre-pnpm, TOCTOU, pnpm-hook, tool-byte, generated-output, dynamic-import, request replay, one-receipt-two-command, nested variable-field, current-main config drift and review-receipt counterexamples; and writes the narrative plus `ScopedReviewReceipt`. Because this is the verifier's first subject, require all three independent assertions and unique labels:

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

- Consumes: exact final spec commit/SHA-256; reviewed Task 0L launcher/root materialization and Task 0P bootstrap contract/review; one fresh receipt per Task 0A local command; complete `CurrentMainAdmission`/`AuditReviewReceipt` contracts and command registry; local fixture Git repositories only.
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

Run `git check-ignore -v .superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-admission-validator-review.md` as a diagnostic. Then dispatch canonical request `task-0a-bootstrap-review-verify.json` with `SCOPED_REVIEW_VERIFY_V1/VERIFY`, exact launcher/materialization/contract digests and its own fresh Task 0A receipt. The later validator-review request has a different request ID/receipt; the Task 0A review binds both via `BootstrapRunReceiptSet`. Task 0A cannot substitute a direct Node/package-script path for this authority check.

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

The direct commands above are diagnostics. Authority requires canonical `task-0a-validator-review-verify.json` dispatched as `SCOPED_REVIEW_VERIFY_V1/VERIFY`, binding the same report/receipt/subject and creating its own receipt. The Task 0A gate verifies the exact two-receipt set. Expected: validator scoped review PASS with exact subject/range/digests. If it fails, fix Task 0A files, commit `fix: address Task 0A scoped review`, rerun RED/GREEN and repeat review. No fetch, ref update, merge, admission JSON, migration or scanner exists.

### Task 0B: Read-Only Live-Main Audit and Reviewed Authorization Packet

**Files:**

- Create local audit output: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-read-only-audit.json`
- Create local audit narrative: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-read-only-audit.md`
- Create local independent review: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-read-only-audit-review.md`
- Create local dedicated audit review receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-read-only-audit-review.json`
- Create only after separate GitHub-controller materialization authorization: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/github/github-controller-contract.json`
- Create only after that controller's independent review: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/github/github-controller-materialization.json`, `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/github/github-controller-review.json`
- Create local external-controller operation receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-github-readback-receipt.json`
- Modify: none
- Test: `scripts/governance-organization-identity-current-main-admission.spec.mjs`
- Read-only: live `origin` main advertisement; cached refs/objects; exact branch; `.github/CODEOWNERS`; complete main-only path/migration sets; build/raw/schema/governance/runtime/caller/consumer/Identity authority source; no-write merge facts.

**Interfaces:**

- Consumes: exact reviewed Task 0A validator commit/report/receipt; accepted local launcher/bootstrap contract; separately authorized/materialized/reviewed `GitHubControllerContract`; one `GitHubControllerReceipt` for `PROTECTED_MAIN_READBACK`; one fresh local `BootstrapRunReceipt` for `CURRENT_MAIN_AUDIT_LOCAL_V1`; branch pre-refresh SHA and locally available Git objects only.
- Produces: reviewed metadata-only audit packet with `PASS | HOLD | FETCH_AUTH_REQUIRED`, exact GitHub-receipt live-main/protection identity, local branch/merge-base/ranges/set digests/classifications/conflicts/owners/migrations/deltas, exact expected conflict paths/hunks/resolution rules, distinct fetch/local-merge authorization requests, local command receipt-set digest, and dedicated `AuditReviewReceipt` binding the packet/set/controller/authorization digests. It writes no Git object/ref or tracked file.

**Commit message:** none; the audit packet is local review evidence and must not move the branch.

- [ ] **Step 1: Run the missing-packet RED**

```bash
AUDIT=.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-read-only-audit.json
test -s "$AUDIT"
```

Expected: RED with nonzero status before the live audit.

- [ ] **Step 2: Read the exact live protected-main advertisement without fetch**

If the GitHub controller is not already materialized and independently reviewed at the exact Task 0L source/contract, stop and request its separate materialization authorization. Its receipt must prove exact `NODE`/`GIT`/`GH` closure, clean typed environment, opaque repository-scoped credential handle and no secret persistence. Then execute exactly one read-only `PROTECTED_MAIN_READBACK` controller request; plan/Task 0B approval does not authorize fetch or mutation. The block below is diagnostic only:

```bash
git ls-remote --exit-code --refs origin refs/heads/main
REPOSITORY="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
gh api "repos/$REPOSITORY/branches/main" --jq '{sha:.commit.sha,protected:.protected}'
```

Require one reviewed `GitHubControllerReceipt` whose typed result contains exactly one `<40-lowercase-hex><TAB>refs/heads/main` record, exact equality with the branch API SHA, and `protected=true`; store only its contract/review/request/result digests plus SHA/ref/protected boolean. The direct network commands cannot satisfy this gate. Missing controller review, credential-handle scope, permission/protection evidence or receipt equality is `HOLD`, not an assumption.

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

The displayed direct Node command is the diagnostic expansion. Local authority dispatches canonical request `task-0b-current-main-audit.json` as `CURRENT_MAIN_AUDIT_LOCAL_V1/COLLECT_LOCAL_FACTS`, taking the reviewed GitHub receipt digest as typed input and producing its own fresh Task 0B `BootstrapRunReceipt`. Render the companion narrative from that JSON only; it may include paths/enums/digests/counts but no diff hunk/source/SQL/secret text.

- [ ] **Step 10: Independently review and machine-gate the audit packet**

The reviewer recomputes live/cached/object/ancestry/path/conflict/owner/migration facts, challenges every `ADMIT_*` disposition, and verifies the packet is `PASS`, `FETCH_AUTH_REQUIRED`, or an honest `HOLD`. The dedicated `AuditReviewReceipt` binds `auditPacketSha256`, GitHub controller contract/review/operation-receipt digests, local audit command receipt, branch preimage, advertised live main, merge base, exact path/conflict/migration/disposition set digests, authorization-request digest, optional fetch-receipt digest, report/counterexample digests and zero findings. Null set digests are permitted only for `FETCH_AUTH_REQUIRED` before the object exists. Run unique exact severity/verdict assertions and a second fresh local receipt for `task-0b-audit-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1/VERIFY`; aggregate the two local receipts in the Task 0B receipt set. A `FETCH_AUTH_REQUIRED` packet can have a PASS review without pretending the full audit passed.

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

- Consumes: independently reviewed Task 0B packet with status exactly `FETCH_AUTH_REQUIRED`; reviewed GitHub controller contract/materialization/review; exact fetch authorization naming `origin`, `refs/heads/main`, advertised 40-hex SHA and `FETCH_EXACT_OBJECT` request digest.
- Produces: reviewed `GitHubControllerReceipt` for `FETCH_EXACT_OBJECT`, exact object available locally, metadata-only fetch receipt and independent review; no branch/tracking ref update, merge, admission or merge authorization. Its sole successor is a complete Task 0B rerun.

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

The displayed Git command is diagnostic expansion only. Authority invokes the separately reviewed GitHub controller with operation `FETCH_EXACT_OBJECT`; its typed request fixes remote/ref/SHA and the exact Git flags, credential-handle scope and expected before-state. The resulting `GitHubControllerReceipt` binds authorization, request/payload, executable closure, before/after refs and fetched object. The local root launcher has no fetch command or credential access. No refspec, tracking-ref update, merge, checkout, reset, rebase, commit, auto-maintenance, commit-graph write or additional object request is authorized.

- [ ] **Step 3: Verify object identity and absence of merge/ref effects**

```bash
test "$(git cat-file -t "$LIVE_MAIN_COMMIT")" = commit
test "$(git rev-parse HEAD)" = "$BRANCH_PRE_REFRESH_COMMIT"
test "$(git rev-parse refs/remotes/origin/main)" = "$CACHED_MAIN_COMMIT"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

Write a closed receipt containing remote/ref/SHA, before/after branch/cached-ref identities, object type, authorization digest, zero merge/ref changes and no source bytes.

- [ ] **Step 4: Independently review the fetch-only receipt**

Use unique exact severity/verdict assertions plus one fresh local receipt for canonical request `task-0f-fetch-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1/VERIFY`, consuming the external GitHub receipt as data. The direct command below is diagnostic only. A finding repeats only Task 0F under a new exact authorization if network action must recur; it never upgrades the old Task 0B packet.

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

- Create on the first refresh, or Modify only in a newly authorized successor that starts at the exact pre-scanner `CURRENT_MAIN_ADMISSION_COMMIT`: `docs/governance/organization-identity-current-main-admission.json`
- Create local independent review: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-refresh-review.md`
- Create local review receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-refresh-review.json`
- Create only after separate Gitleaks-controller materialization authorization: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/gitleaks/gitleaks-controller-contract.json`, `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/gitleaks/gitleaks-controller-materialization.json`, `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/gitleaks/gitleaks-controller-review.json`
- Create local Gitleaks operation receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-gitleaks-receipt.json`
- Modify through exact Git merge only: the complete machine-recorded main-only/result path set from Task 0B
- Modify if and only if present in the reviewed conflict set: `docs/evidence/site-builder/copy-runtime-eligibility.json`
- Modify if and only if present in the reviewed conflict set: `docs/implementation-records/copy-fixed-source-impact-governance.md`
- Test: admission validator/spec; exact merge parent/path/conflict facts; complete migration/static/API/build/raw/schema/governance/docs/Gitleaks/ContractGraph packet.

**Interfaces:**

- Consumes: reviewed root launcher/materialization and Task 0P bootstrap contract; one fresh receipt per local Task 0C command; final Task 0B packet with status exactly PASS and exact `AuditReviewReceipt`; already-local exact live-main object; separately authorized local merge/admission commits; reviewed/materialized Gitleaks controller and separately authorized Gitleaks request; closed Copy command IDs.
- Produces: exact normal two-parent `REFRESH_MERGE_COMMIT == B0_REFRESH_BASE_COMMIT`; validated one-parent admission child `CURRENT_MAIN_ADMISSION_COMMIT`; reviewed `GitleaksControllerReceipt`; full post-refresh verification receipt set; and an independent review digest over the exact range through the admission child. Tasks 1–6 execute from the admission child but derive product/raw/build/current-migration facts only from the refresh merge tree.

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

Require a fresh complete Task 0B PASS packet plus dedicated `AuditReviewReceipt` and the distinct local merge/admission authorization. Invoke a new GitHub-controller `PROTECTED_MAIN_READBACK`; its receipt must equal Task 0B's admitted SHA/protected ref. Immediately before the merge request, local `CURRENT_MAIN_VALIDATE_V1/VALIDATE` consumes that external receipt, recomputes the canonical audit-packet SHA and exact branch/live-main/path/conflict/migration/disposition/authorization-request digests and requires equality. The authorization names packet, audit-review and latest GitHub-receipt SHA-256. Any drift returns to Task 0B and invalidates the merge authorization request; a direct `ls-remote` is diagnostic and there is no mutable ignored-packet gap.

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

The direct Git line is the closed expansion. Local authority dispatches `task-0c-refresh-start.json` as `GIT_REFRESH_START_V1/START_NO_COMMIT`; the launcher rechecks packet/receipt digests immediately before Git and creates one command receipt. Do not use rebase, squash, force, auto-stash, or blanket `ours/theirs`. Compare actual conflicts/hunk counts/blob triplets to the reviewed Task 0B packet before editing any conflict. Unexpected facts stop the merge; preserve diagnostics and use only the explicitly authorized abort/recovery boundary.

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

Authority dispatches a different canonical request `task-0c-refresh-commit.json` as `GIT_REFRESH_COMMIT_V1/COMMIT_REFRESH`; it permits exactly the fixed commit message and verifies the staged result set before writing the commit. It has its own fresh command receipt. The direct Git lines below are diagnostic readback.

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

Immediately rehash the audit packet and dedicated audit receipt. Authority dispatches `task-0c-admission-generate.json` as `CURRENT_MAIN_GENERATE_V1/GENERATE`, then `task-0c-admission-validate.json` as `CURRENT_MAIN_VALIDATE_V1/VALIDATE`, each with a distinct receipt. The generator embeds `auditPacketSha256`, `auditReviewReceiptSha256` and report digest; it cannot bind a changed ignored packet.

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

Create separate canonical local requests for `CURRENT_MAIN_VALIDATE_V1/VALIDATE`, `REFRESH_VERIFY_V1/VERIFY`, `PRISMA_GENERATE_V1/VERIFY`, `API_VERIFY_V1/VERIFY`, `GOVERNANCE_VERIFY_V1/VERIFY`, `DOCS_VERIFY_V1/VERIFY`, and `CONTRACT_GRAPH_VERIFY_V1/VERIFY`, each binding `CURRENT_MAIN_ADMISSION_COMMIT`, the same `BootstrapContract`, audit receipt and refresh pair and each producing its own fresh command receipt. Before Gitleaks, separately materialize/review the Gitleaks controller if needed and obtain exact static-tool authorization; invoke its only request against the exact subject/config/tree and consume the resulting `GitleaksControllerReceipt` in `REFRESH_VERIFY_V1`. The local registry contains no Gitleaks ID or executable. The command block below lists diagnostic expansions only.

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
test ! -e scripts/governance-organization-identity-writers.mjs
test ! -e docs/governance/organization-identity-writer-baseline.json
test ! -e docs/governance/organization-identity-writer-stage.json
test ! -e packages/db/prisma/migrations/20260902090000_organization_identity_materialization_outcome_compat
pnpm governance:verify
pnpm docs:verify
gitleaks detect --source . --config .gitleaks.toml --redact --no-banner
pnpm code-intelligence:scan
pnpm code-intelligence:check
pnpm --filter @global/code-intelligence exec tsx src/cli.ts status --repo ../..
```

Expected: commands execute at the sole successor's `CURRENT_MAIN_ADMISSION_COMMIT`, while every product/raw/build/current-migration derivation explicitly opens `B0_REFRESH_BASE_COMMIT`; core admission, Copy, migration, API/build, external Gitleaks and ContractGraph gates all PASS for that exact pair. The delta verifier proves complete build/raw/schema/migration/governance/runtime/caller/authority classification without claiming the later full writer scanner. The only allowed Task 0C subject is pre-scanner: 0M/scanner/manifests are absent and governance/docs PASS. There is no in-place repeat after Tasks 1–6 and no permitted expected governance/docs drift.

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

The direct review command is diagnostic; authority dispatches `task-0c-refresh-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1/VERIFY` with its own fresh receipt. The Task 0C receipt set includes every local request exactly once plus the external Gitleaks receipt digest. Expected: reviewed two-commit refresh/admission chain fixed. A finding in the merge result, either ordered parent, admission JSON/shape, or their review never produces a fix commit atop `CURRENT_MAIN_ADMISSION_COMMIT`: preserve and abandon both commits, return to the exact `BRANCH_PRE_REFRESH_COMMIT`, rerun full Task 0B for a fresh PASS packet/`AuditReviewReceipt`, obtain a new exact local-merge authorization, and recreate a new two-parent refresh merge plus one-parent admission child; then review the new exact pair. No amend, revert-as-substitute or forward admission fix is allowed. Task 0M—not Task 1—is the only successor. No push/PR/remote merge/root/v3 action is implied.

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
- Create only after separate disposable-controller materialization authorization: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/disposable-postgres/disposable-controller-contract.json`, `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/disposable-postgres/disposable-controller-materialization.json`, `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/disposable-postgres/disposable-controller-review.json`
- Test read-only preimage: exact `20260830130300`, `20260830130400`, `20260830130600` migration bytes and refreshed migration directory.
- Test: both new 0M test files plus existing migration/static suites.

**Interfaces:**

- Consumes: reviewed `B0_REFRESH_BASE_COMMIT`/`CURRENT_MAIN_ADMISSION_COMMIT`, final Task 0C review, root launcher/materialization, immutable Task 0P bootstrap contract, one fresh receipt per local Task 0M static/review command, exact source digests `f5692086…`, `b7706a19…`, `0695319e…`, old CHECK segment `b25fb488…`, expanded segment `128db73c…`, reviewed disposable-controller contract/materialization and separate migration-file/controller-request authorizations.
- Produces: sole DDL-only migration; exact `MaterializationOutcomeCompatCatalogReceipt`; `B0M_MIGRATION_COMMIT`; static/code, DB and security scoped-review receipts; authorized `DisposablePostgresControllerReceipt`; Task 0M local receipt-set digest; zero Prisma schema/DML/retained application.

**Commit message:** `fix: admit organization identity outcomes in materialization`

- [ ] **Step 1: Obtain and verify the separate migration-file authorization**

The authorization names the exact migration path/timestamp, allowed two-literal CHECK expansion, static/disposable test paths and no-DB boundary. It does not authorize disposable PostgreSQL, retained application, deployment, `migrate resolve`, scanner work or another migration.

- [ ] **Step 2: Verify name/timestamp/preimage absence under the clean bootstrap**

Dispatch `task-0m-preimage-verify.json` as `MIGRATION_STATIC_VERIFY_V1/VERIFY`. Require current-main admission to prove `20260902090000_organization_identity_materialization_outcome_compat` absent and strictly later than the exact refreshed maximum. Verify `packages/db/prisma/schema.prisma` and all existing migration blobs clean. A drifted name/maximum/preimage stops for spec amendment rather than renaming.

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

The direct block is diagnostic. Authority dispatches `task-0m-static-verify.json` as `MIGRATION_STATIC_VERIFY_V1/VERIFY` with its own fresh receipt. Expected: PASS; migration directory delta is exactly the one 0M path, production SQL has no DML or Prisma-ledger manipulation.

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

Review exact migration/test range, predicate delta, 58-byte name, timeout and retained `ACCESS EXCLUSIVE` lock chronology, no-DML/schema/authority scope and test separation. Machine-gate its narrative/receipt with canonical request `task-0m-static-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1/VERIFY`. Findings produce a forward fix commit limited to 0M files, full static rerun and new review subject; never amend an already reviewed migration commit.

- [ ] **Step 11: Request the separate disposable PostgreSQL authorization**

If the disposable controller is not already materialized and independently reviewed, first request its separate materialization authorization naming exact Node/Docker/psql/Corepack/pnpm/Prisma closure, loopback/no-egress policy, request/result schemas and synthetic credential-handle policy. Then present exact B0M subject, PostgreSQL 16 image digest, loopback/no-egress topology, unique resource labels, migration list, time/space caps, synthetic IDs/data, direct-psql fault transforms, Prisma operations and exact cleanup as one `0M_COMPATIBILITY` request. Without both controller review and request authorization, 0M remains HOLD and Task 1 cannot start.

- [ ] **Step 12: Run authorized disposable fresh/upgrade/lock/fault/ledger proof**

```bash
ORGANIZATION_IDENTITY_MATERIALIZATION_COMPAT_DISPOSABLE=1 \
  node --test packages/db/test/organization-identity-materialization-outcome-compat.disposable.spec.mjs
```

The direct block is diagnostic documentation. Authority invokes only the separately reviewed disposable controller with operation `0M_COMPATIBILITY`; the local root launcher has no Docker/psql/disposable command. The resulting `DisposablePostgresControllerReceipt` binds controller/review, exact authorization/request, executable process closure, opaque synthetic credential handle, image/topology/resources/caps/migration input, scenarios, cleanup and zero retained resources. Require old values and new values only in correct outcome shapes; wrong combinations fail; connection A/B lock contention hits bounded timeout and complete rollback; AX lock is observed after ADD through validation; all direct fault transforms restore exact preimage and unchanged ledger; Prisma fresh/upgrade catalog match, checksum/finished row is exact, and second deploy reports no pending migrations.

- [ ] **Step 13: Run independent DB and security reviews**

Each review fixes the final B0M subject, bootstrap contract/local static receipt set and external disposable controller contract/review/operation receipt, adds independent executable-closure/credential-handle/catalog/timeout/dependency/ledger/cross-shape/cleanup counterexamples, and produces its own machine-gated `ScopedReviewReceipt`. Each review verification has its own fresh local `SCOPED_REVIEW_VERIFY_V1/VERIFY` receipt. Both must have unique exact zero-C/I/PASS fields. Retained apply/timing/maintenance/recovery stays explicit HOLD.

- [ ] **Step 14: Freeze 0M and open the scanner gate**

Dispatch three canonical `SCOPED_REVIEW_VERIFY_V1/VERIFY` requests for static, DB and security receipts plus a separate `MIGRATION_STATIC_VERIFY_V1/VERIFY` request; each creates one fresh local receipt. Recompute migration SHA/last-change, verify complete refreshed-directory-plus-one-delta inventory and bind the external disposable receipt in the Task 0M receipt set. The direct loop below is diagnostic only. Any review fix repeats static or separately authorized disposable proof as affected. Only the final reviewed `B0M_MIGRATION_COMMIT`, controller receipt and local receipt set may be consumed by Task 1.

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

- Consumes: separately authorized scanner start at final reviewed `B0M_MIGRATION_COMMIT`; reviewed `CURRENT_MAIN_ADMISSION_COMMIT`/two-parent `B0_REFRESH_BASE_COMMIT`; latest `PROTECTED_MAIN_READBACK` GitHub-controller receipt; accepted launcher/root materialization and immutable Task 0P `BootstrapContract`; one fresh receipt per Task 1 local command; 0M review/disposable receipts; final spec; Artifact A authority; complete build/dependency/tool closure.
- Produces: scanner contracts, source views, bootstrap-contract/fresh-run verification, `canonicalJson`, `verifyBuildSurface`, root-launcher-only authority CLI shell, and independently reviewed Task 1 commit.

**Commit message:** `test: define organization identity scanner contracts`

- [ ] **Step 1: Re-run the refreshed-base, admission, live-main, and ownership preflight**

The root controller dispatches canonical `task-1-preflight.json` as `CURRENT_MAIN_VALIDATE_V1/VALIDATE`, consuming a fresh GitHub-controller `PROTECTED_MAIN_READBACK` receipt and binding the exact launcher/materialization/bootstrap contract, its own fresh receipt and the listed Git subjects. Bootstrap authority, Prisma generation, scanner tests and scoped-review verification each create different receipts; the Task 1 review binds the complete sorted set plus the external receipt digest. The block below is diagnostic readback only:

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

Dispatch canonical `task-1-bootstrap-authority-run.json` as `BOOTSTRAP_AUTHORITY_RUN_V1/INSTALL_AND_PRISMA_GENERATE`. The root wrapper—not the current shell—invokes the copied `tool-root/bin/env -i`; its environment is the exact reviewed `LauncherContract.runtimeEnvironment` map, and the Node executable is the copied `tool-root/bin/node` path from `LauncherContract`/`LauncherMaterializationReceipt`, never a hard-coded `/usr/bin/node`. That request produces one receipt for exact subject `B0M_MIGRATION_COMMIT`; the separate `task-1-prisma-generate.json` verification request uses `PRISMA_GENERATE_V1/VERIFY` and produces another. The internal expansion is:

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

Review complete build/bootstrap closure, launcher/materialization identities, immutable contract and subject-bound run validation, absence sentinels, clean install/generate order, source views, closed output and tests. Machine-gate the exact report/receipt with canonical `task-1-scanner-contract-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1/VERIFY`. Findings produce a Task 1-only fix commit, complete clean-bootstrap/test rerun and new review subject. Task 2 is blocked until PASS.

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

Dispatch canonical `task-2-scanner-test.json` as `SCANNER_TEST_V1/TEST` with the immutable contract and its own fresh receipt. The scoped-review command gets a second receipt; the Task 2 review binds both. The direct block is diagnostic expansion:

```bash
node --test --test-name-pattern='delegate|capability boundary|ManyAndReturn|generated parity|exact three' scripts/governance-organization-identity-writers.spec.mjs
git diff --check
git add scripts/governance-organization-identity-writers-typescript.mjs \
  scripts/governance-organization-identity-writers.spec.mjs
git commit -m "feat: detect identity delegate capability escapes"
```

- [ ] **Step 10: Run Task 2 independent scoped review/fix loop**

Review generated/native parity, all eight reads/nine writes, ManyAndReturn, dynamic models and every capability escape. Gate canonical `task-2-delegate-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1/VERIFY`. Findings create a Task 2-only fix commit, focused/full rerun and new review. Task 3/4 integration is blocked until PASS.

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

Dispatch canonical `task-3-scanner-test.json` as `SCANNER_TEST_V1/TEST` with the immutable contract and its own fresh receipt. The scoped-review command gets a second receipt; the Task 3 review binds both. The direct block is diagnostic expansion:

```bash
node --test --test-name-pattern='raw capability|wrapper ingress|dependency closure|interpolation|literal mention|budget|cycle' scripts/governance-organization-identity-writers.spec.mjs
git diff --check
git add scripts/governance-organization-identity-writers-contracts.mjs \
  scripts/governance-organization-identity-writers-typescript.mjs \
  scripts/governance-organization-identity-writers.spec.mjs
git commit -m "feat: freeze raw database capability closure"
```

- [ ] **Step 11: Run Task 3 independent scoped review/fix loop**

Review all raw forms, interpolation classifier, cross-file wrappers/ingress, full executable preimage, literal detector and non-resetting budgets/cycles. Gate canonical `task-3-raw-closure-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1/VERIFY`. Findings create Task 3-only fixes and complete reruns; Task 4 is blocked until PASS.

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

- Consumes: exact two-parent `B0_REFRESH_BASE_COMMIT`, its one-parent `CURRENT_MAIN_ADMISSION_COMMIT`, Task 0B+0C review identities, Task 2/3 final inventories, separate Artifact A authority contracts, future B0 acceptance Git-object shape fixtures, immutable bootstrap contract and one fresh receipt per Task 4 local command, plus optional external-anchor fixtures. It consumes no generated B0 baseline or stage file.
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

The direct block below is diagnostic. Authority dispatches canonical `task-4-scanner-test.json` as `SCANNER_TEST_V1/TEST` with the final Task 2/3 blobs, immutable bootstrap contract and its own fresh receipt. Fixture stage, fixture zero and scoped-review verification have separate request IDs/receipts; the Task 4 review binds the set. Pre-baseline assertions use the immutable fixture adapter and may not read or create governance manifests.

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

Review immutable expected sets, accepted-blob/refresh/0M/bootstrap bindings, external anchor inputs, redaction, budgets, symlink/TOCTOU, exit semantics and proof that no generated baseline was consumed. Gate canonical `task-4-stage-security-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1/VERIFY`; fix/retest/review until PASS before Task 5.

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

- Consumes: exact refresh/admission chain, accepted `B0M_MIGRATION_COMMIT`/migration SHA/static+DB+security+disposable receipts, immutable Task 0P bootstrap contract and one fresh receipt per Task 5 local command, final reviewed Task 4 scanner/stage/derivation blobs, Task 2/3 refreshed inventory, and Artifact A resolver/function/ACL/six-receipt authority.
- Produces: exact `WriterBaselineMeasurements`, complete `RawDispositionReviewReceipt`, immutable build/raw baseline, complete refresh-directory-plus-0M migration authority, Artifact A acceptance, initial stage and scoped review receipt.

**Commit message:** `test: bind refreshed identity authority inputs`

- [ ] **Step 1: Add manifest-schema and drift RED cases**

Test exact keys, duplicate records, ordering, digest formats, absolute/parent paths, wrong refresh/admitted-main/merge/admission/review identity, current-main admission drift, refreshed migration addition/removal/checksum/last-change/disposition drift, wrong Artifact A commit, function owner/language/security/search-path/proconfig/ACL/definition drift, and `app_user`/PUBLIC table/column privilege drift.

- [ ] **Step 2: Run migration prerequisites before generation**

Dispatch separate canonical requests `task-5-migration-prerequisites.json` as `MIGRATION_STATIC_VERIFY_V1/VERIFY` and `task-5-api-prerequisites.json` as `API_VERIFY_V1/VERIFY`, binding the final Task 4 derivation blobs. Each gets its own fresh receipt; receipt-only/raw-candidate/baseline-generate/baseline-check/scanner-test/review requests likewise remain one-to-one and form the Task 5 receipt set. The block below is diagnostic expansion:

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

Dispatch canonical `task-5-artifact-a-receipts.json` as `SCANNER_BASELINE_V1/RAW_RECEIPT_ONLY`. It reads only the six exact allowlisted paths and hard-coded digests below; the direct `sha256sum` block is diagnostic readback:

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

Expected: diagnostic exit 2 with the closed `INTEGRITY_ERROR` record because the baseline generator/disposition receipt is absent; stderr is empty. The RED request is canonical `task-5-baseline-red.json` under `SCANNER_BASELINE_V1/BASELINE_CHECK` and its expected non-PASS receipt is retained as TDD evidence, not authority acceptance.

- [ ] **Step 5: Implement refreshed migration derivation and separate Artifact A function/ACL verification**

Enumerate every migration directory at `B0_REFRESH_BASE_COMMIT`, then require exactly one accepted delta at `B0M_MIGRATION_COMMIT` with the fixed 0M path/SHA/definition/reviews/disposable receipt. Separately parse Artifact A resolver/catalog contracts and prove those authority bytes remain exact. Any second migration or 0M drift is HOLD.

The seven exact function identities are `organization_identity_acquire_advisory_until_v1(bigint,timestamp with time zone)`, `organization_identity_authority_from_raw_v1(text,jsonb)`, `organization_identity_blocker_from_raw_v1(jsonb)`, `organization_identity_canonical_suppression_value_v1(text,text)`, `organization_identity_plan_from_snapshot_v1(jsonb)`, `organization_identity_resolve_for_raw_worker_v1(text,text)`, and `resolve_organization_identity_for_raw_v1(text,text)`. The privilege baseline must also state that `app_user` has SELECT plus INSERT on exactly `id, workspace_id, canonical_type, canonical_id, raw_record_id, match_rule, confidence`, has no table-level INSERT and no UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER; `app_user` alone has EXECUTE on the public resolver; PUBLIC and `app_user` have no EXECUTE on private helpers; and PUBLIC has no relevant write authority.

- [ ] **Step 6: Generate a candidate raw inventory for independent classification**

Dispatch `task-5-raw-candidate.json` as `SCANNER_BASELINE_V1/RAW_CANDIDATE` against the real `B0_REFRESH_BASE_COMMIT` virtual Program and write a temporary closed candidate only below the fresh root-owned task root. The reviewer assigns one closed disposition to every refreshed record, rejects every dynamic/unresolved record, includes only record IDs/hashes/dispositions, and writes the exact ignored disposition receipt. The receipt contains no SQL/source text, absolute roots, or secrets.

- [ ] **Step 7: Independently review every raw capability and wrapper ingress**

The reviewer must verify every raw record/ingress, add independent counterexamples, and produce the exact `RawDispositionReviewReceipt` defined above. `rawRecordCount`, record/disposition/dependency/counterexample/report digests, reviewer class, zero C/I and PASS are all required; every baseline record's binding ID/hash/disposition digest must be present in that exact set. Arbitrary IDs, partial arrays, open Records or empty real receipts are invalid.

- [ ] **Step 8: Implement deterministic baseline generation**

Validate but never regenerate current-main admission. This task always runs in initial-create mode from the accepted pre-scanner successor: prove all four output paths absent, prove Task 4's final derivation commit/blobs and review receipt, generate candidates below the fresh bootstrap task root, verify deterministic complete bytes twice, then atomically create exactly those paths. Main drift abandons the lineage and restarts from the one allowed pre-scanner `CURRENT_MAIN_ADMISSION_COMMIT`; if abandoned 0M exists, it is not carried forward and must be recreated/reviewed. It never reuses stale outputs or performs an in-place arbitrary upsert. Bind refresh/admission/B0M/launcher/bootstrap-contract/fresh-run/Task4-review identities and exact raw record hashes.

- [ ] **Step 9: Measure and enforce headroom**

Record actual `B0_REFRESH_BASE_COMMIT` counts for source files, symbol/call edges, raw capabilities, wrapper ingresses, closure members, and committed bytes. Artifact A counts may appear only as comparative evidence. For every project-total refreshed measure assert `measured * 2 <= fixedLimit`; never round down or raise a limit.

- [ ] **Step 10: Generate the tracked B0 records**

Authority dispatches canonical `task-5-baseline-generate.json` as `SCANNER_BASELINE_V1/BASELINE_GENERATE`; the direct block documents its closed inputs:

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

Authority dispatches canonical `task-5-baseline-check.json` as `SCANNER_BASELINE_V1/BASELINE_CHECK` and `task-5-scanner-test.json` as `SCANNER_TEST_V1/TEST`, with distinct receipts. The direct block is diagnostic expansion:

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

Review exact measurements, 50% headroom, raw receipt/set equality, build/bootstrap closure, refresh+0M migration inventory, Artifact A authority and exact Task 4 derivation blob set. Machine-gate canonical `task-5-baseline-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1/VERIFY`. Findings create a Task 5-only fix commit, regenerate all four candidates from the same subjects, rerun tests and repeat review. Task 6 is blocked until PASS.

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
- Create: `scripts/governance-organization-identity-protected-base-launcher.mjs`
- Create: `scripts/governance-organization-identity-protected-base-launcher.spec.mjs`
- Create local scoped review: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-6-governance-anchor-review.md`
- Create local review receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-6-governance-anchor-review.json`
- Modify: `scripts/runtime-artifact-contract.spec.mjs:16-37,100-163,404-440`
- Test: `scripts/governance-organization-identity-writers.spec.mjs`
- Test: `scripts/governance-contracts.spec.mjs`
- Test: `scripts/governance-path-contracts.spec.mjs`
- Test: `scripts/runtime-artifact-contract.spec.mjs`
- Read-only assertion: `Dockerfile`, `runtime-entrypoint.mjs`, `scripts/verify-runtime-artifact.mjs`, `scripts/verify-runtime-image.mjs`, `scripts/generate-runtime-artifact-manifest.mjs`, `.github/CODEOWNERS`, `.github/required-contexts.json`

**Interfaces:**

- Consumes: accepted local launcher/materialization, immutable bootstrap contract, one receipt per local Task 6 command, admission/scanner/final Task 5 baseline, B0M authority, reviewed GitHub controller contracts and `ProtectedBaseLauncherContract` schemas.
- Produces: explicitly non-authority developer convenience aliases; local root-launcher authority wiring; reviewed `ProtectedBaseLauncherContract` implementation/equivalence verifier; non-authoritative ordinary PR CI; accepted protected-main `push` initial anchor and base-owned `pull_request_target` verifier; minimal permissions; runtime exclusion proof.

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
import "./governance-organization-identity-launcher-request.spec.mjs";
import "./governance-organization-identity-launcher-trust.spec.mjs";
import "./governance-organization-identity-launcher-execution.spec.mjs";
import "./governance-organization-identity-controller-contracts.spec.mjs";
import "./governance-organization-identity-github-controller.spec.mjs";
import "./governance-organization-identity-disposable-postgres-controller.spec.mjs";
import "./governance-organization-identity-gitleaks-controller.spec.mjs";
import "./governance-organization-identity-root-anchor-closure.spec.mjs";
import "./governance-organization-identity-root-anchor-filesystem.spec.mjs";
import "./governance-organization-identity-current-main-admission.spec.mjs";
import "./governance-organization-identity-writers.spec.mjs";
import "./governance-organization-identity-protected-base-launcher.spec.mjs";
```

to `scripts/governance-contracts.spec.mjs`. Extend the independently rooted path test so removing any import fails. Runtime/release/OCI exclusion fixtures cover every launcher/controller source, spec, contract/request/output/receipt and governance manifest; no trust-controller byte enters product artifacts.

- [ ] **Step 5: Wire current-main admission and current-stage verification into the governance runner**

Import the reviewed validator and scanner only after `BootstrapContract` equality and the current command's fresh `BootstrapRunReceipt` PASS. Validate admission, refresh/0M/Artifact A/launcher/bootstrap identities before stage. Local stages require the root anchor at B1+. Ordinary PR workflows can report CI but set authority class `NON_AUTHORITATIVE_PR_CI`; only an accepted `ProtectedBaseLauncherReceipt` may supply hosted authority.

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

`.github/workflows/organization-identity-writer-anchor.yml` has only `push` on `main` and `pull_request_target`. On the exact B0 merge push, base-owned workflow bytes require the independently read-back merge SHA and create the initial hosted receipt; failed/cancelled recovery requires a separately authorized GitHub-controller `WORKFLOW_RERUN` of that same immutable run/SHA. On `pull_request_target`, execute only the protected-main `ProtectedBaseLauncherContract` implementation and accepted launcher/bootstrap/scanner blobs. Fetch the PR head tree only as data through a GitHub-controller receipt and prohibit executing any PR action/script/package/generated binary/workflow/config.

`scripts/governance-organization-identity-protected-base-launcher.mjs` validates hosted runner OS/architecture/UID, exact workflow/base/event/ref/repository/run/controller-variable input, immutable task-root materialization, executable closure and TOCTOU, then emits `ProtectedBaseLauncherReceipt`. Its equivalence function compares exact protected-base launcher/bootstrap source blobs, local command registry, bootstrap contract/request/output schemas and tool logical expectations; it does not pretend hosted paths/UID/inodes equal local Ubuntu values. There is no source-only or undefined “equivalent controller” escape. Any PR-provided launcher/request/controller byte is rejected before execution.

Permissions are `contents: read` plus only the minimum checks/status write needed for the closed result; no secrets reach PR code. `required-contexts.json` keeps ordinary Governance CI separate from the new authority context. CODEOWNERS includes the anchor workflow and bootstrap.

- [ ] **Step 7: Extend runtime exclusion tests without widening runtime copies**

Keep `Dockerfile`, `runtime-entrypoint.mjs`, `verify-runtime-artifact.mjs`, `verify-runtime-image.mjs`, and the manifest generator unchanged unless a failing test proves an existing copy path includes governance. The GREEN implementation is the explicit negative test over compiled output, release manifest inventory, and OCI copy statements, not a new runtime filter that could hide a copied scanner.

- [ ] **Step 8: Run focused GREEN and root governance**

The direct block is a non-authority developer diagnostic. Authority dispatches `task-6-scanner-test.json` as `SCANNER_TEST_V1/TEST`, `task-6-stage.json` as `SCANNER_STAGE_V1/STAGE_CHECK`, `task-6-governance.json` as `GOVERNANCE_VERIFY_V1/VERIFY`, and `task-6-runtime-artifact.json` as `RUNTIME_ARTIFACT_VERIFY_V1/VERIFY`; each command creates its own fresh receipt and the Task 6 review binds their sorted set.

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

Dispatch `task-6-prisma-generate.json` as `PRISMA_GENERATE_V1/VERIFY`, `task-6-api-verify.json` as `API_VERIFY_V1/VERIFY`, `task-6-docs-verify.json` as `DOCS_VERIFY_V1/VERIFY`, and `task-6-migration-static.json` as `MIGRATION_STATIC_VERIFY_V1/VERIFY`, each with its own receipt. The direct block is diagnostic expansion.

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
  scripts/runtime-artifact-contract.spec.mjs \
  scripts/governance-organization-identity-protected-base-launcher.mjs \
  scripts/governance-organization-identity-protected-base-launcher.spec.mjs
git commit -m "ci: enforce identity writer governance boundary"
```

- [ ] **Step 11: Run Task 6 independent scoped review/fix loop**

Review ordinary-PR non-authority, protected-main push/base-owned `pull_request_target` workflow bytes, exact `ProtectedBaseLauncherContract`/receipt/equivalence algorithm, runner/event/materialization/tool/input TOCTOU, minimal permissions, PR-as-data rule, runtime exclusion and governance wiring. Gate canonical `task-6-governance-anchor-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1/VERIFY` with its own fresh receipt; Task 7 is blocked until PASS.

### Task 7: B0 Implementation Whole Review and Exact Parent Freeze

**Files:**

- Create (ignored review output): `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b0-implementation-whole-review.md`
- Create local review receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b0-implementation-whole-review.json`
- Modify: none
- Test: all B0 files from Tasks 1–6; exact six source receipts; three current writer sources; resolver/lock; package/governance/workflows/runtime exclusion; migration static suites.

**Interfaces:**

- Consumes: clean B0 implementation descending from accepted B0M; every Task 1–6 scoped review receipt; latest GitHub-controller `PROTECTED_MAIN_READBACK` receipt; reviewed GitHub/Gitleaks/disposable/protected-base controller contracts and completed receipts; launcher/materialization; immutable bootstrap contract plus one fresh receipt for each Task 7 local command; build/tool/raw/migration/Artifact A authority; and no writer acceptance JSON.
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

The direct network line is diagnostic. Authority uses a new GitHub-controller `PROTECTED_MAIN_READBACK` receipt and a separate local `CURRENT_MAIN_VALIDATE_V1/VALIDATE` receipt. Expected: PASS. Drift before B0 whole review preserves the abandoned lineage and creates the exact recovery branch/worktree from the pre-scanner `CURRENT_MAIN_ADMISSION_COMMIT` whose tree lacks 0M/scanner/manifests. Rerun Tasks 0B/0F/0C, separately authorize and rerun 0M, then Tasks 1–6 in initial-create mode and obtain a new whole review. Never start from `B0M_MIGRATION_COMMIT`, a Task 1–6 commit, or `B0_IMPLEMENTATION`; do not review an unadmitted subject.

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

Dispatch canonical requests `task-7-scanner-test.json` (`SCANNER_TEST_V1/TEST`), `task-7-stage.json` (`SCANNER_STAGE_V1/STAGE_CHECK`), `task-7-current-main.json` (`CURRENT_MAIN_VALIDATE_V1/VALIDATE`), `task-7-governance.json` (`GOVERNANCE_VERIFY_V1/VERIFY`), `task-7-runtime.json` (`RUNTIME_ARTIFACT_VERIFY_V1/VERIFY`), `task-7-migration.json` (`MIGRATION_STATIC_VERIFY_V1/VERIFY`), `task-7-prisma.json` (`PRISMA_GENERATE_V1/VERIFY`), `task-7-api.json` (`API_VERIFY_V1/VERIFY`) and `task-7-docs.json` (`DOCS_VERIFY_V1/VERIFY`) with the exact implementation subject. These nine requests create nine fresh `BootstrapRunReceipt`s; the later whole-review verification creates a tenth, and `task-7-bootstrap-run-set.json` binds all ten sorted request/receipt entries. The block below is diagnostic expansion:

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

The exact report must name the implementation SHA, two-parent `B0_REFRESH_BASE_COMMIT == REFRESH_MERGE_COMMIT`, one-parent `CURRENT_MAIN_ADMISSION_COMMIT`, admitted live-main/refresh parents, admission JSON and pre/post refresh review digests, amended spec SHA-256, local launcher/materialization/review, immutable bootstrap contract/task receipt sets, GitHub/Gitleaks/disposable/protected-base controller contracts/reviews/completed receipts, commands/results, counterexamples, all reviewed manifests, six source receipt digests, limitations, and final finding counts. It must not claim retained runtime/database, deployment, remote merge, or final authority.

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

The direct verifier is diagnostic. Authority dispatches `task-7-whole-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1/VERIFY`, producing the tenth Task 7 receipt and binding launcher/materialization, immutable bootstrap contract, implementation subject, report/path/counterexample digests and unique zero-C/I/PASS fields. The report separately binds the complete Task 7 receipt-set digest. Expected GREEN: report exists with exact subject and zero C/I; tracked/untracked Git state stays clean because the review path is ignored.

**Commit:** none. The reviewed implementation head must not move after this review. Any code/test/manifest change invalidates the review and restarts Task 7.

### Task 8: `B0_ACCEPTANCE` One-Parent/One-Path First Add and Scoped Review

**Files:**

- Create: `docs/governance/organization-identity-writer-acceptance.json`
- Create (ignored post-commit review): `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b0-acceptance-scoped-review.md`
- Create local review receipt: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b0-acceptance-scoped-review.json`
- Modify: none
- Test: `scripts/governance-organization-identity-writers.spec.mjs`, acceptance generator/checker, Git commit shape.

**Interfaces:**

- Consumes: exact reviewed `B0_IMPLEMENTATION_SHA`; exact two-parent `B0_REFRESH_BASE_COMMIT`; exact one-parent `CURRENT_MAIN_ADMISSION_COMMIT`; latest GitHub-controller `PROTECTED_MAIN_READBACK` receipt; admitted live-main/ordered refresh parents/admission JSON; Task 0B/0C/7 review digests; parent-tree controlled blobs; launcher/materialization and immutable bootstrap contract/schema/blob plus one fresh receipt per Task 8 local command; separate Artifact A Git authority; B0 baseline stage identities.
- Produces: exact `B0_ACCEPTANCE_SHA`; one first-added tracked JSON blob binding all refresh/authority subjects; separate scoped-review digest not written back; terminal local state `LOCAL_ACCEPTANCE_REVIEWED` only while live main remains admitted.

**Commit message:** `chore: anchor organization identity writer baseline`

- [ ] **Step 1: Run the missing-acceptance RED**

Run:

```bash
node scripts/governance-organization-identity-writers.mjs acceptance --check
```

The direct command is diagnostic; canonical `task-8-acceptance-red.json` dispatches `SCANNER_ACCEPTANCE_V1/ACCEPTANCE_RED` and must return the same expected RED. Expected: exit 1 with a closed policy result naming only the repository-relative acceptance path/kind; stderr empty. Exit 0 before first-add is forbidden.

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

The direct `ls-remote` is diagnostic; authority uses a new GitHub-controller `PROTECTED_MAIN_READBACK` receipt plus a distinct local validation receipt. Compare `B0_IMPLEMENTATION_SHA` and all refresh/admission/review/controller identities to the full subject printed inside the review report. Mismatch or live-main drift before acceptance preserves the old lineage and creates the one allowed recovery successor from its pre-scanner `CURRENT_MAIN_ADMISSION_COMMIT`, never from `B0M_MIGRATION_COMMIT` or `B0_IMPLEMENTATION`. Rerun 0B/0F/0C, separately authorized 0M, Tasks 1–7 and whole review before a new acceptance.

- [ ] **Step 3: Generate only the acceptance JSON from parent-tree blobs**

Authority dispatches canonical `task-8-acceptance-generate.json` as `SCANNER_ACCEPTANCE_V1/ACCEPTANCE_GENERATE`; the direct block documents the closed inputs. The acceptance freezes the immutable bootstrap contract/schema/blob/digest and launcher/materialization identities, never one opaque run receipt. It records the reviewed task-level `BootstrapRunReceiptSet` digests as non-invariant evidence, while each underlying receipt remains one-command/one-request.

Run:

```bash
node scripts/governance-organization-identity-writers.mjs acceptance \
  --implementation-parent "$B0_IMPLEMENTATION_SHA" \
  --refresh-base "$(jq -er '.refreshBaseCommit' docs/governance/organization-identity-writer-baseline.json)" \
  --current-main-admission-commit "$(jq -er '.currentMainAdmissionCommit' docs/governance/organization-identity-writer-baseline.json)" \
  --b0m-migration-commit "$(jq -er '.b0mMigrationCommit' docs/governance/organization-identity-writer-baseline.json)" \
  --bootstrap-contract docs/governance/organization-identity-bootstrap-contract.json \
  --task-run-receipt-set "$TASK_8_BOOTSTRAP_RUN_RECEIPT_SET" \
  --anchor-workflow .github/workflows/organization-identity-writer-anchor.yml \
  --current-main-admission docs/governance/organization-identity-current-main-admission.json \
  --current-main-refresh-review .superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/current-main-refresh-review.md \
  --artifact-a 2400bac28796bae44294114edc99eaccb1bd65b3 \
  --implementation-review "$REVIEW" \
  --output docs/governance/organization-identity-writer-acceptance.json
```

Expected: exit 0; exactly one untracked path exists. The generator gets refresh/admission, immutable bootstrap contract plus Task 0A–8 receipt-set digests, complete config/declaration/tool roots, exact GitHub/Gitleaks/disposable controller contracts/reviews/completed receipts, reviewed root-anchor controller source/test/contract-schema blobs, exact B0M receipts, protected-base launcher/workflow blobs, scanner/raw-review/measurement/migration baselines, all Task 1–7 reviews and stage machine from the implementation parent. No review self-attests.

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

Dispatch canonical `task-8-acceptance-check.json` as `SCANNER_ACCEPTANCE_V1/ACCEPTANCE_CHECK`, `task-8-current-main.json` as `CURRENT_MAIN_VALIDATE_V1/VALIDATE`, `task-8-scanner-test.json` as `SCANNER_TEST_V1/TEST`, `task-8-stage.json` as `SCANNER_STAGE_V1/STAGE_CHECK`, and `task-8-governance.json` as `GOVERNANCE_VERIFY_V1/VERIFY`, all against `B0_ACCEPTANCE_SHA`. These five requests create five distinct receipts. Acceptance RED, generation, working-file check, Git commit-shape write and scoped-review verification likewise each have their own request/receipt; the Task 8 review binds the complete sorted receipt set. The direct block is diagnostic expansion.

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

The direct verifier is diagnostic; authority dispatches `task-8-acceptance-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1/VERIFY` with its own receipt. Expected: `LOCAL_ACCEPTANCE_REVIEWED` only when live main is still the admitted SHA.

If live main advances after the acceptance commit, preserve the abandoned branch/head without amend/rebase/merge. Request exact authorization to create a successor v2 refresh worktree from the exact pre-scanner `CURRENT_MAIN_ADMISSION_COMMIT` recorded by the abandoned acceptance—not from its `B0_IMPLEMENTATION_SHA`. The deterministic branch/path suffix is the first 12 hex characters of the newly advertised main SHA. That starting tree must lack 0M, scanner/manifests and acceptance; rerun 0B/0F/0C, separately authorized 0M and Tasks 1–8 in initial-create mode.

If the scoped acceptance review itself finds a shape/content/binding defect while live main has not drifted, preserve the rejected acceptance commit and create a dedicated acceptance-repair branch/worktree from its exact parent `B0_IMPLEMENTATION_SHA`, where the acceptance path is absent. Apply any generator/implementation fix as a forward commit, rerun affected Tasks 1–6 plus the complete Task 7 whole review, then generate a new first-add acceptance and review it. Do not amend, revert-and-reuse, or add a fix commit atop the rejected one-path acceptance. Do not push/open/update a PR, merge, create the root receipt, or start B1 from either abandoned acceptance.

### Task 9: Protected-Main Anchor Run Card — Default HOLD, Do Not Execute Without Exact Authorizations

**Files:**

- Create only after separate root-receipt authorization: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json`
- Create only after separate root-anchor-controller materialization authorization/review: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/root-anchor/root-anchor-controller-contract.json`, `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/root-anchor/root-anchor-controller-materialization.json`, `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/root-anchor/root-anchor-controller-review.json`
- Create only after separate anchor-write authorization: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/root-anchor/requests/task-9-root-anchor-write.json`
- Create in one-way order after the anchor write: `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/root-anchor/outputs/root-anchor-write-receipt.json`, `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/root-anchor/outputs/root-anchor-readback-receipt.json`, `/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/root-anchor/outputs/root-anchor-operation-review.json`
- Modify only after separate controller-variable authorization: GitHub repository/controller variables `ORGANIZATION_IDENTITY_B0_ADMITTED_MAIN_SHA`, `ORGANIZATION_IDENTITY_B0_REFRESH_BASE_SHA`, `ORGANIZATION_IDENTITY_CURRENT_MAIN_ADMISSION_COMMIT_SHA`, `ORGANIZATION_IDENTITY_B0_ACCEPTED_SHA`, `ORGANIZATION_IDENTITY_B0_ACCEPTANCE_REVIEW_SHA256`, `ORGANIZATION_IDENTITY_B0_MERGE_SHA`, `ORGANIZATION_IDENTITY_B0_FIRST_PARENT_SHA`, `ORGANIZATION_IDENTITY_B0_SECOND_PARENT_SHA`, `ORGANIZATION_IDENTITY_B0_MERGE_METHOD`, `ORGANIZATION_IDENTITY_LAUNCHER_CONTRACT_SHA256`, `ORGANIZATION_IDENTITY_LAUNCHER_MATERIALIZATION_SHA256`, `ORGANIZATION_IDENTITY_LAUNCHER_MATERIALIZATION_REVIEW_SHA256`, `ORGANIZATION_IDENTITY_BOOTSTRAP_CONTRACT_SHA256`, `ORGANIZATION_IDENTITY_PROTECTED_BASE_CONTRACT_SHA256`, `ORGANIZATION_IDENTITY_GITHUB_CONTROLLER_CONTRACT_SHA256`
- Create local controller receipt set: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-9-github-controller-receipts.json`
- Create hosted receipt/readback: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-9-protected-base-launcher-receipt.json`
- Create hosted receipt review: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/task-9-protected-base-launcher-receipt-review.json`
- Modify: no repository file
- Test: local Git ancestry, live protected-main/PR/ruleset readback, root receipt ownership/mode/digest chain.

**Interfaces:**

- Consumes: exact admitted live-main SHA, refresh/admission/implementation/acceptance/review identities, accepted local launcher/bootstrap, reviewed GitHub/protected-base/root-anchor controller contracts/materializations/reviews, opaque GitHub credential-handle binding, and separately authorized push/PR/merge/readback/rerun/fetch/variable/root-anchor-controller materialization/anchor-write actions.
- Produces: exact operation-specific GitHub receipt set; protected-base receipt/review; root-anchor controller materialization/review; separately authorized `RootAnchorWriteRequest`; create-exclusive anchor/write receipt; independent readback; independent operation review; one local `ANCHOR_ONLY` receipt consuming the anchor plus the completed external chain; no repository commit.

**Commit message:** none; this task produces external readback/receipt state only after its separate authorizations.

- [ ] **Step 1: Confirm the default RED/HOLD state**

Run only the local check:

```bash
ANCHOR=/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json
test -f "$ANCHOR"
```

Expected RED now: nonzero because no authorized future receipt exists. This is the correct HOLD state. Do not create it to make the check green.

- [ ] **Step 2: Re-read admitted live main and separately authorize the exact push**

Invoke the reviewed GitHub controller operation `PROTECTED_MAIN_READBACK` and require its receipt to equal `CurrentMainAdmission.liveMainCommit`, protected ref and repository. Drift after acceptance abandons the sequence and uses the sole pre-scanner recovery start. When equal, present admitted main, refresh parents, `B0_IMPLEMENTATION_SHA`, `B0_ACCEPTANCE_SHA`, branch, review/controller/launcher/bootstrap digests and clean state. A separate push authorization names the exact `PUSH_EXACT_BRANCH` request/payload digest, forbids force and permits only this diagnostic expansion:

```bash
git push -u origin codex/pr407-organization-identity-caller-cutover-v2
```

The GitHub controller—not the local launcher—executes exact Git from its reviewed closure with the opaque credential handle and emits a `GitHubControllerReceipt`. This authorization does not cover PR creation/update, merge, workflow rerun, variables, root anchor, v3 or B1.

- [ ] **Step 3: Separately authorize and execute exact PR create or update**

Create the canonical PR body file in the controller input root and bind its SHA-256. Its title is exactly `Organization Identity writer ban-at-source`; base is `main`; head is `codex/pr407-organization-identity-caller-cutover-v2`; body binds refresh/admission/bootstrap/0M/controller identities, exactly one Artifact B migration, `B0_IMPLEMENTATION`, `B0_ACCEPTANCE`, review digests and `LOCAL_ACCEPTANCE_REVIEWED`.

First invoke `PR_READBACK` for the head branch. If no open PR exists, obtain a separate `PR_CREATE` authorization and execute only:

```bash
gh pr create --repo mlhjyx/global-backend \
  --base main \
  --head codex/pr407-organization-identity-caller-cutover-v2 \
  --title "Organization Identity writer ban-at-source" \
  --body-file /global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/github/requests/task-9-pr-body.md
```

If exactly one open PR already exists with the exact base/head, do not create another. Obtain a separate `PR_UPDATE_BODY` authorization before executing only:

```bash
gh pr edit "$PR_NUMBER" --repo mlhjyx/global-backend \
  --title "Organization Identity writer ban-at-source" \
  --body-file /global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/github/requests/task-9-pr-body.md
```

The direct commands are diagnostics. The GitHub controller has distinct closed request/result schemas for create and update; authorization of either cannot invoke the other. Afterward invoke a new `PR_READBACK` request and require exact PR number, URL, state, baseRefOid=`ADMITTED_LIVE_MAIN_COMMIT`, headRefOid=`B0_ACCEPTANCE_SHA`, title and body digest.

- [ ] **Step 4: Read exact rules/checks/conversation/workflow state and request merge authorization**

Invoke one `RULES_CHECKS_READBACK` request that binds the PR number/head/base, required checks/reviews, conversation resolution, protected branch/rulesets, allowed merge methods, auto-update/merge-queue state and exact protected-base workflow blob. The reviewed result schema forbids prose-only green status or omitted rule sets. Request separate merge authorization naming this receipt, exact PR/head/base, `MERGE_COMMIT` and disclosure that merge triggers the base-owned protected-main push workflow. Any missing review/check, auto-update, queue/rebase or workflow drift is HOLD.

- [ ] **Step 5: Recheck exact head/base/rules immediately before merge**

Immediately before the mutation, invoke a new `PR_READBACK` followed by `RULES_CHECKS_READBACK`; the merge request must bind both latest receipt digests. Require `headRefOid=B0_ACCEPTANCE_SHA`, `baseRefOid=ADMITTED_LIVE_MAIN_COMMIT`, green checks/reviews, resolved conversations and no auto-update/queue transition. A mismatch stops without merge and invalidates the merge authorization; an older readback cannot be reused.

- [ ] **Step 6: Perform only the separately authorized expected-head merge**

Invoke the GitHub controller operation `PR_MERGE` with the exact authorization and immediate readback receipts. Its fixed API payload is `PUT /repos/mlhjyx/global-backend/pulls/{number}/merge` with `merge_method=merge` and `sha=B0_ACCEPTANCE_SHA`. The direct diagnostic expansion is:

```bash
MERGE_RESPONSE="$(gh api --method PUT \
  "repos/mlhjyx/global-backend/pulls/$PR_NUMBER/merge" \
  -f merge_method=merge -f sha="$B0_ACCEPTANCE_SHA")"
PROTECTED_MAIN_MERGE_SHA="$(jq -er '.sha' <<<"$MERGE_RESPONSE")"
```

The controller receipt binds request, authorization, credential handle, HTTP status and exact response SHA. Squash/rebase/force/update-branch/merge-queue calls are absent from the operation registry.

- [ ] **Step 7: Separately read back the GitHub commit, branch and ordered parents**

Invoke `COMMIT_BRANCH_PARENT_READBACK` with the merge-response SHA. The direct API diagnostics are:

```bash
REMOTE_COMMIT="$(gh api \
  "repos/mlhjyx/global-backend/git/commits/$PROTECTED_MAIN_MERGE_SHA")"
REMOTE_MAIN="$(gh api "repos/mlhjyx/global-backend/branches/main")"
test "$(jq -er '.sha' <<<"$REMOTE_COMMIT")" = "$PROTECTED_MAIN_MERGE_SHA"
test "$(jq -er '.commit.sha' <<<"$REMOTE_MAIN")" = "$PROTECTED_MAIN_MERGE_SHA"
test "$(jq '.parents | length' <<<"$REMOTE_COMMIT")" -eq 2
test "$(jq -er '.parents[0].sha' <<<"$REMOTE_COMMIT")" = \
  "$ADMITTED_LIVE_MAIN_COMMIT"
test "$(jq -er '.parents[1].sha' <<<"$REMOTE_COMMIT")" = "$B0_ACCEPTANCE_SHA"
```

Only the typed GitHub controller receipt is authority. It must prove exact merge-response/branch equality and ordered parents `[admitted main, reviewed PR head]`. Mismatch produces no hosted/root anchor, fetch or v3.

- [ ] **Step 8: Read back the automatic protected-main workflow and handle rerun separately**

Invoke `WORKFLOW_RUN_READBACK` for the run triggered by the exact merge push. Require exact workflow/base blob, protected-base launcher contract/receipt, event=`push`, ref=`refs/heads/main`, head SHA=`PROTECTED_MAIN_MERGE_SHA`, repository/run identity, tool/materialization/event/request/output digests and PASS. An independent hosted-launcher reviewer recomputes the workflow/base/source/tool-logical/event/materialization/request/output/TOCTOU facts, executes PR-no-exec counterexamples, and writes `ProtectedBaseLauncherReceiptReview` with unique zero-C/I/PASS. If failed/cancelled, stop and request a distinct authorization for `WORKFLOW_RERUN` naming that immutable run ID/attempt/SHA. The only diagnostic mutation is:

```bash
gh run rerun "$RUN_ID" --repo mlhjyx/global-backend
```

After a rerun, invoke a new `WORKFLOW_RUN_READBACK`; moving-main dispatch, temporary ref/tag, replacement run or naked-SHA workflow dispatch is forbidden.

- [ ] **Step 9: Separately authorize and fetch only the exact merge object**

Verify the Git executable in the GitHub controller closure supports `--no-auto-maintenance` and `--no-write-commit-graph`; missing support is HOLD. Obtain exact `FETCH_EXACT_OBJECT` authorization for `PROTECTED_MAIN_MERGE_SHA`. The direct diagnostic expansion is:

```bash
git fetch --no-tags --no-write-fetch-head --no-auto-maintenance \
  --no-write-commit-graph origin "$PROTECTED_MAIN_MERGE_SHA"
test "$(git rev-parse "$PROTECTED_MAIN_MERGE_SHA^1")" = \
  "$ADMITTED_LIVE_MAIN_COMMIT"
test "$(git rev-parse "$PROTECTED_MAIN_MERGE_SHA^2")" = "$B0_ACCEPTANCE_SHA"
git merge-base --is-ancestor \
  "$B0_IMPLEMENTATION_SHA" "$PROTECTED_MAIN_MERGE_SHA"
```

The GitHub controller receipt proves no tracking-ref/`FETCH_HEAD`/maintenance/commit-graph write. Local `origin/main` is never treated as fresh authority.

- [ ] **Step 10: Authorize variables, root-anchor controller, write, readback and operation review in one-way order**

Prepare the exact fifteen-name/value-digest set. The GitHub controller `CONTROLLER_VARIABLES_WRITE` request is separately authorized and may write only those controller-owned variables to `mlhjyx/global-backend`; its receipt readbacks every variable digest. That GitHub receipt grants no filesystem authority.

If the root-anchor controller is not already materialized and independently reviewed, stop and request a separate materialization authorization naming its exact tracked source/test blobs, `ENV`/Node closure, no-credential clean environment, contract/request/output roots, anchor target, owner/modes, no-follow/create-exclusive/no-overwrite/fsync/TOCTOU/genesis-predecessor rules and schemas. The root materializer creates only the controller/contract/request/output roots and emits `ExternalControllerMaterializationReceipt{controllerClass:"ROOT_ANCHOR"}`; an independent security review produces `ControllerReviewReceipt{controllerClass:"ROOT_ANCHOR"}`. Neither receipt writes the anchor.

Construct canonical `RootAnchorWriteRequest` binding a new separate authorization, exact target/mode, `GENESIS_ONLY` null predecessor and absent-target proof, local launcher/materialization/review, bootstrap contract, GitHub controller contract/review/complete operation set, protected-base contract/receipt/receipt-review/equivalence, admitted/refresh/admission/implementation/acceptance/review identities, ordered parents, workflow run, variable-write receipt and expected canonical anchor payload digest/size. The authorization names the request SHA exactly; controller materialization, GitHub authorization or root ownership cannot imply this write.

After authorization, the root-anchor controller:

1. revalidates its contract/materialization/review, request/authorization and every input digest under `/usr/bin/env -i` with exact `ENV`/Node closure;
2. opens the `0700 root:root` parent without following links and requires the target absent, predecessor null and no sibling/temp collision;
3. canonicalizes the anchor payload, proves it has no anchor-SHA/write/readback/operation-review/self-hash field and matches the request digest/size;
4. create-exclusively writes a same-directory `0600 root:root` temporary file, fsyncs it, links it to the absent target with no-replace semantics, unlinks only its own temporary name, and fsyncs the parent directory;
5. reopens the target no-follow, verifies owner/mode/device/inode/size/SHA/TOCTOU, then writes and fsyncs `RootAnchorWriteReceipt` below the controller output root. It never overwrites, truncates, renames over or cleans an existing target.

An independent root-capable reviewer then reopens the anchor, request and write receipt without following links, recomputes canonical schema/input evidence/ordered parents/predecessor/owner/mode/inode/SHA/TOCTOU/fsync facts and create-exclusively writes `RootAnchorReadbackReceipt`. A separate independent operation review challenges extra path/file, overwrite, symlink/hardlink/nonregular target, stale predecessor, wrong receipt/parent/order, missing authorization, broader mode, partial fsync, inode swap, self-hash/circular evidence, replay and current-shell/local-launcher/GitHub-controller substitution. The operation review must validate `RootAnchorUpstreamEvidenceClosureV2`, recompute the canonical write request/write receipt/readback receipt digests, and compare `controllerContractSha256`, `controllerMaterializationReceiptSha256`, `controllerReviewReceiptSha256`, `controllerSourceClosureSha256`, `writeReceiptSha256`, `readbackReceiptSha256`, ordered parents, anchor SHA/size and no-credential flags across the request, write receipt, readback receipt, operation-review receipt and upstream controller records. Only zero Critical/Important and PASS creates `RootAnchorOperationReviewReceipt`.

The evidence direction is exactly:

```text
controller contract/materialization/review
  -> separately authorized RootAnchorWriteRequest
  -> create-exclusive anchor write + fsync + RootAnchorWriteReceipt
  -> independent RootAnchorReadbackReceipt
  -> independent RootAnchorOperationReviewReceipt
```

No earlier object binds a later digest. The anchor does not hash itself; the external operation-review receipt binds the anchor SHA and every controller/request/write/readback/review digest.

- [ ] **Step 11: Verify local and hosted anchor perspectives through external evidence**

Dispatch one local `SCANNER_STAGE_V1/ANCHOR_ONLY` request with its own fresh `BootstrapRunReceipt`. Its typed input contains both exact paths and digests:

```bash
node scripts/governance-organization-identity-writers.mjs stage \
  --anchor-receipt \
  /global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json \
  --anchor-operation-review \
  /global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/root-anchor/outputs/root-anchor-operation-review.json
```

The direct command is diagnostic. `ANCHOR_ONLY` reopens the controller contract/materialization/review, authorized request, write receipt, readback receipt and operation review; recomputes anchor SHA; verifies the pre-write controller/request identities embedded in the anchor; and separately validates hosted `ProtectedBaseLauncherReceipt` plus equivalence proof. A missing, reordered, replayed or mismatched external digest is `INTEGRITY_ERROR`. Ordinary PR Governance remains non-authoritative, and no local launcher/GitHub controller may substitute for the accepted root-anchor controller. The Task 9 evidence set binds every GitHub receipt, protected-base receipt/review, complete root-anchor chain and the one local consumption receipt.

- [ ] **Step 12: Record the task outcome without a repository commit**

**Commit:** none. The task outcome is either `PROTECTED_MAIN_ANCHORED` with exact live evidence or `HOLD` with the first failed gate. External waiting time is not estimated.

### Task 10: Create V3 From the Exact Protected-Main Merge Commit

**Files:**

- Create after Task 9 and explicit local execution approval: worktree `/global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v3`
- Create: branch `codex/pr407-organization-identity-caller-cutover-v3`
- Modify: no v2 file
- Test: worktree inventory, exact head/branch/status, root-anchor controller operation-review chain, hosted equivalence and anchor-aware stage/zero diagnostics.

**Interfaces:**

- Consumes: root-only anchor plus `RootAnchorOperationReviewReceipt`, exact `mergeCommitSha`, `acceptedB0Sha`, root-anchor/local/hosted/GitHub controller and launcher/bootstrap identities; locally available protected-main merge Git object; separate v3 creation authorization.
- Produces: clean v3 at the exact merge commit, one fresh receipt per worktree/bootstrap/Prisma/stage/zero command plus their v3 receipt-set digest, B0 stage passing with external anchor, live zero exit 1 with three writers.

**Commit message:** none; worktree creation is not a repository content commit.

- [ ] **Step 1: Run the expected absent-v3 RED**

```bash
test -d /global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v3
```

Expected RED before setup: nonzero. If the path or branch already exists, stop and audit ownership; do not reuse it.

- [ ] **Step 2: Read and validate the anchor without editing v2**

Authority dispatches `task-10-anchor-validate.json` as `SCANNER_STAGE_V1/ANCHOR_ONLY`. The direct `jq`/Git block is diagnostic readback and cannot select authority inputs.

```bash
ANCHOR=/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json
ANCHOR_OPERATION_REVIEW=/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/controllers/root-anchor/outputs/root-anchor-operation-review.json
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

Expected: exact local commit exists, both ordered parents match the anchor, the external operation review recomputes the same anchor SHA and complete root-controller evidence chain, and ancestry passes. Missing controller/request/write/readback/review object or parent mismatch remains HOLD; do not fetch without separate network authorization.

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

Dispatch canonical `task-10-bootstrap-authority-run.json` as `BOOTSTRAP_AUTHORITY_RUN_V1/INSTALL_AND_PRISMA_GENERATE`. The accepted root wrapper supplies copied `tool-root/bin/env -i`, exact `NPM_CONFIG_USERCONFIG=/dev/null`, the reviewed runtime environment values, and the copied `tool-root/bin/node` path from the accepted launcher receipt, not `/usr/bin/node`. It internally performs the exact install/generate sequence; a separate `PRISMA_GENERATE_V1/VERIFY` request verifies generated outputs before scanner load. The block below is diagnostic state readback plus the one authority launcher call:

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

The typed stage/zero requests bind both `ANCHOR` and `ANCHOR_OPERATION_REVIEW` digests and use `SCANNER_STAGE_V1/STAGE_CHECK` and `SCANNER_ZERO_V1/ZERO_CHECK`, each with a distinct fresh Task 10 receipt. Worktree creation, bootstrap, Prisma generation, stage and zero each have separate request IDs/receipts; the Task 10 setup evidence binds their receipt-set digest. Expected: stage exits 0 at `B0_BASELINE`; zero exits 1 with exactly the three accepted writer findings; stderr is empty.

**Commit:** none. Worktree creation is the setup boundary; Task 11 owns the first v3 commit.

## V3 Delivery: B1–B6 Caller Cutover

Every Task 11–18 authority command binds both the protected anchor SHA and `RootAnchorOperationReviewReceipt` digest, revalidates the complete root-anchor controller evidence chain, validates the accepted `BootstrapContract`/launcher and creates its own fresh `BootstrapRunReceipt` for that candidate head. The direct pnpm/Node command blocks are diagnostic/TDD expansions. A GREEN/stage/zero/governance/review claim exists only when every named request has a distinct receipt, the task receipt-set passes and the external anchor evidence remains byte-identical; intentional RED receipts are never promoted to PASS.

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

Dispatch `task-11-stage-generate.json` as `SCANNER_STAGE_V1/STAGE_GENERATE` to generate `B1_TEMPORAL_RED` so the source-tree observation still names three exact writers. Do not edit expected sets, baseline, scanner, acceptance, build, raw, or migration manifests.

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

Expected: diagnostic FAIL because current Temporal code still calls `tx.identityLink.create` and does not call the resolver/composite lock. Canonical `task-11-api-red.json` under `API_VERIFY_V1/VERIFY` with suite `API_TEMPORAL` records this expected RED without claiming PASS.

- [ ] **Step 7: Prove B1 governance remains green with three writers**

Dispatch `task-11-stage.json` as `SCANNER_STAGE_V1/STAGE_CHECK` and `task-11-zero.json` as `SCANNER_ZERO_V1/ZERO_CHECK`; each receives a separate receipt and the direct block is diagnostic expansion.

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

Review five-outcome/replay/lock/provenance RED contract and unchanged writer count. Gate `task-11-temporal-red-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1/VERIFY`; findings fix only Task 11 tests/stage and repeat RED/review. Task 12 is blocked until PASS.

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

Expected: diagnostic FAIL on the resolver/composite-receipt/direct-writer assertions. Canonical `task-12-api-red.json` under `API_VERIFY_V1/VERIFY` with suite `API_TEMPORAL` records the expected RED. If it passes before source changes, stop and inspect branch ownership or test weakness.

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

Dispatch canonical `task-12-api-focused-green.json` as `API_VERIFY_V1/VERIFY` with suite `API_TEMPORAL`; the direct block is diagnostic expansion.

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

Dispatch `task-12-stage.json` as `SCANNER_STAGE_V1/STAGE_CHECK` and `task-12-zero.json` as `SCANNER_ZERO_V1/ZERO_CHECK`; each command has a different fresh Task 12 receipt while binding the same anchor/subject. The direct block is diagnostic expansion.

Run:

```bash
ANCHOR=/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json
node scripts/governance-organization-identity-writers.mjs stage --anchor-receipt "$ANCHOR"
node scripts/governance-organization-identity-writers.mjs zero --anchor-receipt "$ANCHOR"
```

Expected: stage exit 0 with two expected writers; zero exit 1 with exactly those two; raw/build/migration baselines unchanged.

- [ ] **Step 10: Run proportional API/build checks and commit**

Dispatch canonical `task-12-api-full.json` as `API_VERIFY_V1/VERIFY` with suite `API_FULL`; the direct block is diagnostic expansion.

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

Review resolver/lock receipt use, all outcomes, contribution ownership, replay/history compatibility and exact `3 → 2`. Gate `task-12-temporal-cutover-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1/VERIFY`; fix/retest/review until PASS before Task 13.

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

Dispatch `task-13-stage-generate.json` as `SCANNER_STAGE_V1/STAGE_GENERATE` against unchanged B2 source. Stage must still pass with TenantProjection and materialization writers.

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

Expected: diagnostic FAIL because current projection still calls `tx.identityLink.create` and does not use the resolver/composite receipt. Canonical `task-13-api-red.json` under `API_VERIFY_V1/VERIFY` with suite `API_PROJECTION` records the expected RED.

- [ ] **Step 7: Verify the unchanged two-writer stage and commit RED**

Dispatch `task-13-stage.json` as `SCANNER_STAGE_V1/STAGE_CHECK`; the direct stage command is diagnostic expansion.

```bash
ANCHOR=/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json
node scripts/governance-organization-identity-writers.mjs stage --anchor-receipt "$ANCHOR"
git add apps/api/src/acquisition/tenant-projection.organization-identity.spec.ts \
  docs/governance/organization-identity-writer-stage.json
git commit -m "test: specify tenant projection identity cutover"
```

Expected: governance stage PASS with two writers; product RED remains intentional.

- [ ] **Step 8: Run Task 13 independent scoped review/fix loop**

Review five outcomes, Raw-before-resolver order, 101-row chunk lock refresh, replay stability and script result contract. Gate `task-13-projection-red-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1/VERIFY`; fix/retest/review until PASS before Task 14.

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

Expected: diagnostic FAIL on resolver/composite-receipt/direct-writer assertions. Canonical `task-14-api-red.json` under `API_VERIFY_V1/VERIFY` with suite `API_PROJECTION` records the expected RED. Passing before source changes is a stop condition.

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

Dispatch canonical `task-14-api-focused-green.json` as `API_VERIFY_V1/VERIFY` with suite `API_PROJECTION`; the direct block is diagnostic expansion.

```bash
pnpm --filter @global/api exec vitest run \
  src/acquisition/tenant-projection.organization-identity.spec.ts \
  src/acquisition/tenant-projection.raw-bridge.spec.ts \
  src/acquisition/tenant-projection.suppression.spec.ts
```

Expected: PASS for five outcomes, 101-row chunk refresh, response loss, suppression, raw bridge, and script-compatible result.

- [ ] **Step 7: Generate and verify B4 stage**

Dispatch `task-14-stage.json` as `SCANNER_STAGE_V1/STAGE_CHECK` and `task-14-zero.json` as `SCANNER_ZERO_V1/ZERO_CHECK`; the direct block is diagnostic expansion.

```bash
ANCHOR=/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json
node scripts/governance-organization-identity-writers.mjs stage --anchor-receipt "$ANCHOR"
node scripts/governance-organization-identity-writers.mjs zero --anchor-receipt "$ANCHOR"
```

Expected after generating `B4_PROJECTION_CUTOVER`: stage exit 0 with only the materialization writer; zero exit 1 with exactly one finding.

- [ ] **Step 8: Run API checks and commit**

Dispatch canonical `task-14-api-full.json` as `API_VERIFY_V1/VERIFY` with suite `API_FULL`; the direct block is diagnostic expansion.

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

Review composite receipt per chunk, governed Raw persistence, outcome writes, no contact writer and exact `2 → 1`. Gate `task-14-projection-cutover-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1/VERIFY`; fix/retest/review before Task 15.

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

Expected: diagnostic FAIL on current `identityLink.create`, manual identity advisory lock, absent resolver call, and `identity_v2` rejection. Canonical `task-15-api-red.json` under `API_VERIFY_V1/VERIFY` with suite `API_MATERIALIZATION` records the expected RED.

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

Dispatch `task-15-api-focused-green.json` as `API_VERIFY_V1/VERIFY` with suite `API_MATERIALIZATION` and `task-15-migration-static.json` as `MIGRATION_STATIC_VERIFY_V1/VERIFY`; the direct block is diagnostic expansion.

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

Dispatch `task-15-stage.json` as `SCANNER_STAGE_V1/STAGE_CHECK` and `task-15-zero.json` as `SCANNER_ZERO_V1/ZERO_CHECK`; each has a distinct fresh Task 15 receipt and both bind the protected anchor. The direct block is diagnostic expansion.

```bash
ANCHOR=/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json
node scripts/governance-organization-identity-writers.mjs stage --anchor-receipt "$ANCHOR"
node scripts/governance-organization-identity-writers.mjs zero --anchor-receipt "$ANCHOR"
```

Expected after generating `B4M_MATERIALIZATION_CUTOVER`: both commands exit 0, delegate finding set is empty, raw closure/build/migration authority remain exact.

- [ ] **Step 10: Run API/static migration checks and commit**

Dispatch `task-15-api-full.json` as `API_VERIFY_V1/VERIFY` with suite `API_FULL` and `task-15-migration-full.json` as `MIGRATION_STATIC_VERIFY_V1/VERIFY`; the direct block is diagnostic expansion.

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

Review accepted 0M dependency, `identity_v2`/`IDENTITY_CONFLICT` DB+application agreement, C-TX fences/replay/outcomes and exact `1 → 0`. Gate `task-15-materialization-cutover-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1/VERIFY`; fix/retest including 0M static tests and review before Task 16.

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

Expected: diagnostic governance test FAIL because current B0 wiring still selects stage rather than mandatory zero at B5. Canonical `task-16-governance-red.json` under `GOVERNANCE_VERIFY_V1/VERIFY` with suite `GOVERNANCE_ZERO` records the expected RED. The downstream test may already pass; if it fails, fix only test harness assumptions or a proven caller-consumer regression, never broaden a consumer to legacy IdentityLink writes.

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

Dispatch `task-16-stage-generate.json` as `SCANNER_STAGE_V1/STAGE_GENERATE` to generate `B5_ZERO_GATE` against the same zero source tree. The only governance manifest changed is the stage JSON; scanner, tests, baselines, acceptance, and derivation rules remain accepted-parent bytes.

- [ ] **Step 6: Run mandatory zero and governance GREEN locally**

Dispatch `task-16-scanner-test.json` as `SCANNER_TEST_V1/TEST`, `task-16-stage.json` as `SCANNER_STAGE_V1/STAGE_CHECK`, `task-16-zero.json` as `SCANNER_ZERO_V1/ZERO_CHECK`, and `task-16-governance.json` as `GOVERNANCE_VERIFY_V1/VERIFY`; the direct block is diagnostic expansion.

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

Dispatch canonical `task-16-downstream-api.json` as `API_VERIFY_V1/VERIFY` with suite `API_DOWNSTREAM`; the direct block is diagnostic expansion.

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

Dispatch `task-16-governance-topology.json` as `GOVERNANCE_VERIFY_V1/VERIFY` and `task-16-runtime-artifact.json` as `RUNTIME_ARTIFACT_VERIFY_V1/VERIFY`; the direct block is diagnostic expansion.

```bash
node --test \
  scripts/governance-contracts.spec.mjs \
  scripts/governance-path-contracts.spec.mjs \
  scripts/runtime-artifact-contract.spec.mjs
```

Expected: required Governance context still reaches mandatory zero; scanner/tests/manifests remain absent from compiled/release/OCI fixtures.

- [ ] **Step 9: Run full local non-runtime verification and commit**

Dispatch `task-16-prisma.json` as `PRISMA_GENERATE_V1/VERIFY`, `task-16-api-full.json` as `API_VERIFY_V1/VERIFY` with suite `API_FULL`, and `task-16-migration-static.json` as `MIGRATION_STATIC_VERIFY_V1/VERIFY`; the direct block is diagnostic expansion.

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

Review mandatory zero non-downgrade, downstream continuity, base-owned anchor topology and runtime exclusion. Gate `task-16-zero-governance-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1/VERIFY`; fix/retest/review before Task 17.

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

Expected: diagnostic FAIL until the harness is connected to all three cutover callers and old/new replay contracts. Canonical `task-17-api-red.json` under `API_VERIFY_V1/VERIFY` with suite `API_MIXED_FLEET` records the expected RED.

- [ ] **Step 5: Implement the minimal pure harness and reach GREEN**

Reuse actual caller functions and Artifact A resolver types with bounded fakes; do not add a product compatibility path. The only old writer exists inside the test harness/fixture and is excluded from product build/artifacts.

- [ ] **Step 6: Request explicit disposable PostgreSQL/container authorization**

Before running the enabled test, present exact image digest, loopback port policy, resource names/labels, migration list, data shape, time/resource caps, and cleanup commands. This authorization is separate from plan approval, code implementation, remote merge, retained database, deployment, and runtime authorization.

- [ ] **Step 7: Run the authorized disposable GREEN packet**

Only after authorization, invoke the reviewed disposable PostgreSQL controller operation `B6_MIXED_FLEET` with exact image/topology/resources/caps/migration/scenario/cleanup payload. The local launcher has no Docker/psql/disposable ID. The direct block is diagnostic expansion:

```bash
ORGANIZATION_IDENTITY_B6_DISPOSABLE=1 \
  node --test packages/db/test/organization-identity-artifact-b-cutover.disposable.spec.mjs
```

Expected: the `DisposablePostgresControllerReceipt` proves all scenarios PASS, exact executable/process closure, opaque synthetic credential handle, no URLs/passwords/SQL/customer/source text, and cleanup of only the unique controller-created container/network/volume. If cleanup cannot be proven, the receipt is HOLD and reports only bounded resource IDs without deleting anything outside the request.

- [ ] **Step 8: Generate B6 stage and rerun zero/governance**

Dispatch `task-17-stage.json` as `SCANNER_STAGE_V1/STAGE_CHECK`, `task-17-zero.json` as `SCANNER_ZERO_V1/ZERO_CHECK`, and `task-17-governance.json` as `GOVERNANCE_VERIFY_V1/VERIFY`; the direct block is diagnostic expansion.

```bash
ANCHOR=/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/protected-main-anchor.json
node scripts/governance-organization-identity-writers.mjs stage --anchor-receipt "$ANCHOR"
node scripts/governance-organization-identity-writers.mjs zero --anchor-receipt "$ANCHOR"
node scripts/governance-verify.mjs verify --identity-writer-anchor-receipt "$ANCHOR"
```

Expected after generating `B6_CLOSEOUT`: all PASS with zero writers; exact raw/build/migration baselines unchanged.

- [ ] **Step 9: Run the complete final technical packet**

Dispatch `task-17-scanner-test.json` as `SCANNER_TEST_V1/TEST`, `task-17-governance-full.json` as `GOVERNANCE_VERIFY_V1/VERIFY`, `task-17-runtime.json` as `RUNTIME_ARTIFACT_VERIFY_V1/VERIFY`, `task-17-migration.json` as `MIGRATION_STATIC_VERIFY_V1/VERIFY`, `task-17-prisma.json` as `PRISMA_GENERATE_V1/VERIFY`, and `task-17-api-full.json` as `API_VERIFY_V1/VERIFY` with suite `API_FULL`; the direct block is diagnostic expansion.

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

Review mixed fleet, old/new replay, suppression/conflict/races, accepted 0M catalog, disposable controller closure/credential handle and cleanup. Gate `task-17-mixed-fleet-review-verify.json` as `SCOPED_REVIEW_VERIFY_V1/VERIFY` with its own fresh local receipt; any fix reruns affected separately authorized disposable/static/full packets and repeats review. Task 18 is blocked until PASS.

### Task 18: Final Independent Artifact B Whole Review

**Files:**

- Create (ignored): `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b6-final-code-review.md`
- Create (ignored): `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b6-final-security-review.md`
- Create (ignored): `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b6-final-database-review.md`
- Create local review receipts: `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b6-final-code-review.json`, `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b6-final-security-review.json`, `.superpowers/sdd/2026-09-01-organization-identity-writer-ban-at-source/b6-final-database-review.json`
- Modify: none
- Test: exact local/hosted protected-main anchor, accepted bootstrap/refresh/0M/B0 acceptance, all Task 11–17 review receipts, full v3 range, zero inventory, B1–B6 zero-additional-migration diff, runtime exclusion and disposable cleanup.

**Interfaces:**

- Consumes: clean exact B6 head, protected anchor, accepted launcher/materialization/immutable bootstrap contract, one fresh receipt per Task 18 local command, and all preceding review/evidence identities.
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

Repeat Task 17's full local technical packet with one fresh receipt per root-launcher command at the exact review head, plus a separately authorized disposable-controller `B6_MIXED_FLEET` request when its prior external receipt is not exact-head reusable. Do not start a retained service or database.

- [ ] **Step 7: Write and verify the three reports**

Each narrative/receipt names exact subject/range/path/report/counterexample digests, launcher/bootstrap contract/task receipt-set/refresh/0M/acceptance/anchor/controller identities and limitations. Machine-gate each receipt separately through `SCOPED_REVIEW_VERIFY_V1/VERIFY`; a finding returns to the owning task, reruns affected proof and repeats all impacted reviews.

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

The direct verifier loop is diagnostic. Authority dispatches `task-18-code-review-verify.json`, `task-18-security-review-verify.json`, and `task-18-database-review-verify.json` as separate `SCOPED_REVIEW_VERIFY_V1/VERIFY` requests with three distinct receipts and a Task 18 receipt-set digest. Expected GREEN: clean exact B6 head and three zero-C/I reports. The correct conclusion is `CUTOVER_READY_FOR_CONTRACT` for the reviewed Artifact B implementation only. It is not final database authority, deployment, old-worker drain proof, retained migration approval, RuntimeEvidence, Release Bundle, PILOT, GA, Artifact C authorization, push, PR, merge, or worktree cleanup authorization.

**Commit:** none. Any later tracked change requires renewed scoped review.

## Stop Conditions

Stop at the first applicable condition and report the exact evidence boundary:

1. V2 does not descend from final spec `b060c5dd...`, the exact plan is not reviewed/approved/tracked for execution, v3 does not equal the anchored merge, a worktree is dirty, or ownership overlaps.
2. Task 0L tracked launcher/controller review fails; the launcher files + tool-root regular files + runtime roots + request/output roots → readback → materialization → review chronology, owner/modes/TOCTOU, exact runtime environment value map, no-live-symlink/cache rule or no-self/circular-digest rule fails; the local closure omits a required Corepack/pnpm file or includes an external tool; any GitHub/Gitleaks/disposable/root-anchor controller omits source/test/blob/executable/environment/request/result/materialization/review contracts; shared source-closure/root-upstream/operation-review validators omit an exact cross-record invariant; GitHub control payloads are usable as API bodies; controller execution is delegated to a caller executor; a Git-backed command accepts caller-asserted worktree trust; a free-form command/mode/argv/input/output is accepted; or current shell/PR bytes are used for authority.
3. Task 0P cannot distinguish invariant `BootstrapContract` rules/logical tools from current-subject `BootstrapRunReceipt` configuration/absence/lock/root/environment/TOCTOU/output observations; any schema field is unnamed, a nested variable path is omitted, one receipt serves two commands, request/receipt counts differ, current-main config is compared to an old B0 receipt, or clean bootstrap/generation/review fails.
4. Task 0A validator review has any C/I, permits set/rename/copy/case/owner/conflict/migration/bootstrap drift, free-form command or HOLD to pass.
5. Task 0B missing object yields reviewed `FETCH_AUTH_REQUIRED`; only exact-authorized GitHub-controller `FETCH_EXACT_OBJECT` may fetch in Task 0F, then full Task 0B reruns. A missing-object packet never supports merge authorization.
6. GitHub controller materialization/review/credential-handle or `PROTECTED_MAIN_READBACK` receipt fails; Task 0B live/cached/ancestry/path/status/conflict/owner/migration/build/raw/schema/governance/runtime/caller facts are incomplete; the exact harder-copy scan is missing; `AuditReviewReceipt` does not bind controller/local-receipt/packet/set/authorization digests; or its final packet/review is not PASS.
7. The Git executable in the GitHub controller closure lacks `--no-auto-maintenance`/`--no-write-commit-graph`, or its exact fetch writes a ref, `FETCH_HEAD`, maintenance state or commit graph.
8. Task 0C lacks separate merge authorization, its immediately rehashed audit packet/receipt differs, live main drifted, conflicts differ, Copy resolution source is not exactly MAIN_BYTES/WRITE_ELIGIBILITY/SYNC_HUMAN_CITATIONS with required input order, or any stale feature/blanket ours/theirs bytes are used.
9. Refresh/admission parent shapes or review fail, or Artifact A/admitted main ancestry fails. A Task 0C finding abandons/recreates the exact pair; it cannot be forward-fixed atop the admission child.
10. Task 0M path/name/timestamp/preimage drifts; disposable controller closure/materialization/review/request authorization/opaque credential/topology/caps/scenarios/cleanup receipt fails; timeout/58-byte/CHECK/catalog/dependency/AX/fault/Prisma-ledger/static/DB/security receipt fails; retained recovery is misrepresented as verified; or any second migration/schema/DML/authority change appears.
11. Live main advances before acceptance: abandon the scanner lineage, start only from exact pre-scanner `CURRENT_MAIN_ADMISSION_COMMIT`, rerun 0B/0F/0C/0M and Tasks 1–8. Drift after acceptance abandons acceptance too; never start from 0M/implementation or regenerate existing outputs in place.
12. Any accepted config/build/package/`.dockerignore`/absence-sentinel/declaration/tool/generated-output/native-extractor fact drifts or clean bootstrap no longer reproduces the accepted contracts/receipts.
13. TypeScript cannot build one complete Program from accepted roots, a delegate/raw/wrapper origin is ambiguous, or any refreshed baseline surface lacks a closed disposition.
14. A refreshed project-total measurement exceeds 50% of its fixed limit or any required measurement/raw-review field is missing/extra.
15. Any admitted file/root is symlinked/nonregular/escaped/changed, a manifest path invalid, or redaction fails.
16. A raw capability, wrapper ingress/caller, dependency closure, literal mention, admission/bootstrap/0M or controlled blob drifts outside a closed stage removal.
17. Any scanner/derivation blob changes after Task 5 generation without full baseline/raw regeneration and review, or any refreshed/0M migration or Artifact A function/ACL/six-receipt record differs.
18. B0 implementation/acceptance parent shape, controlled parent blobs or review receipts fail. An acceptance review finding abandons that one-path child, repairs from its exact parent in a dedicated successor, reruns whole review, and creates a new first-add acceptance; no amend or forward fix atop the rejected child.
19. Any scoped review receipt for Tasks 1–6 or 11–17, whole review, acceptance review, 0M review or final review lacks exact unique zero-C/I/PASS fields, subject/range/path/report/counterexample digests; any local request lacks its own receipt; task request/receipt set counts or digests differ; or a finding loop remains unresolved.
20. Any GitHub operation lacks its exact controller receipt; PR create/update is omitted or conflated; immediate PR/rules/check head/base receipt is stale; auto-update/queue rebase is active; merge response/GitHub branch/ordered-parent/workflow readback differs; or exact postmerge fetch authorization/receipt/local verification is absent.
21. `ProtectedBaseLauncherContract`/receipt/equivalence, protected-main push or base-owned `pull_request_target` identity/materialization/event/tool/TOCTOU fails; ordinary PR CI is treated as authority; or PR-controlled executable/input is used.
22. Any push/PR/readback/merge/workflow rerun/controller-variable/GitHub/Gitleaks/disposable/root-anchor/v3 action lacks its own authorization/review; or the root-anchor contract/materialization/review → authorized request → create-exclusive write/fsync → write receipt → independent readback → operation-review chain is missing, circular, self-hashing, replayed, overwritten or mismatched at `ANCHOR_ONLY`.
23. The stage set is not exactly `3/3/2/2/1/0/0/0`, or zero does not become exit 0 at B4M.
24. A caller needs any migration beyond accepted 0M, generic legacy writer, identity-only lock, synthesized/cross-transaction/workspace receipt, second PrismaClient, provider/model call or new state.
25. Any outcome writes Canonical/Evidence on terminal outcomes, replay changes bytes, B4M lacks accepted 0M, or application/DB disagree on `identity_v2`/`IDENTITY_CONFLICT`.
26. Disposable topology/cleanup or final review/clean-head proof fails.

## Rollback and Cleanup

- Task 0L local launcher changes are ordinary reviewed source commits. Root materialization is create-only under its separate authorization; on mismatch, preserve the failed packet/readback/materialization/review evidence and stop. Do not overwrite, recursively delete, chmod-widen or replace the launcher files, tool-root files, runtime roots, request/output roots, or their receipts without a new exact root authorization.
- GitHub, Gitleaks and disposable controller materializations/requests are independently create-only and authorization-scoped. Preserve a failed contract/materialization/request/receipt; never fall back to the local launcher, a current shell, another controller's executable closure/credential handle or an unreviewed replacement.
- Root-anchor controller materialization and anchor-write authorization are separate. If the target already exists, predecessor is stale, fsync/readback fails or a partial/hostile file is observed, preserve the target and all receipts as HOLD; do not overwrite, truncate, unlink, rename over, chmod-repair or ask another controller to recreate it. A correction requires a new reviewed successor-path/predecessor design and exact authorization outside this genesis-only write.
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
- A failed GitHub PR create does not authorize update/delete/close; a failed update does not authorize recreation. A failed workflow readback does not authorize rerun until the exact immutable run request is separately approved. Controller-variable rollback is a new exact fifteen-name operation, not an implicit consequence of merge failure.
- B1–B6 rollback before any future merge is v3 branch abandonment or forward revert commits under review. Do not resume implementation on v2.
- Artifact B has exactly one 0M forward migration. Before retained application there is only source/disposable rollback; once successfully applied, its migration row/bytes are immutable and semantic rollback is a later forward migration. Failed retained deploy recovery remains unverified; never improvise `migrate resolve` or edit ledger/migration bytes.
- The B6 disposable harness removes only its uniquely labeled container/network/volume and temp directory. It never deletes a retained/shared `global-*` resource. If cleanup fails, report exact created resource IDs and request direction.
- No worktree, branch, PR, remote ref, root receipt, review report, or evidence is deleted without a separate ownership/provenance audit and authorization.
- After future Artifact C, rollback floor is Artifact B; ambient IdentityLink INSERT is never restored. Artifact C is outside this plan.

## Estimated Active Time

External review queues, authorization waits, GitHub checks, merge queues, and human response time are not included.

| Phase                                           | P50 active | P90 active | Included work; external waiting excluded                                                                                                           |
| ----------------------------------------------- | ---------: | ---------: | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Final-spec/plan amendment and review-fix intake |       10 h |       24 h | spec deltas, prior/final 1C/9I/4M and 1C/5I/2M dispositions, plan correction/review rounds                                                         |
| 0L launcher/controller trust design             |       44 h |       96 h | shared validator/source-closure refactor, split specs, local requests, GitHub/Gitleaks/disposable/root-anchor contracts, hostile tests and reviews |
| 0P bootstrap                                    |       12 h |       24 h | external receipt, immutable materialization, pnpm hooks, tool roots, hostile markers, review fixes                                                 |
| 0A/0B/0F/0C refresh                             |       24 h |       52 h | validator, GitHub/Gitleaks controller gates, optional fetch, Copy and refresh reviews                                                              |
| 0M migration                                    |       24 h |       56 h | static migration, disposable controller, counterexamples and DB/security review fixes                                                              |
| Tasks 1–6 B0 scanner/governance                 |       56 h |      122 h | build/raw engines, receipt sets, per-task reviews and protected-base launcher                                                                      |
| Tasks 7–10 acceptance/remote/v3                 |       28 h |       62 h | reviews, GitHub gates, root-anchor materialize/write/readback/review, external consumption and v3                                                  |
| Tasks 11–17 caller cutover                      |       48 h |      100 h | TDD, per-task review/fix rounds, authorized disposable reruns                                                                                      |
| Task 18 final whole reviews                     |       10 h |       24 h | independent code/security/DB counterexamples and repair reruns                                                                                     |
| One main-drift full rebuild contingency         |       36 h |       80 h | successor, 0B/0F/0C/0M, regenerated baselines and reviews                                                                                          |
| **Total active excluding external waits**       |  **292 h** |  **640 h** | Arithmetic sum; P90 includes one drift rebuild and two substantive counterexample/fix rounds                                                       |

## Execution Completion Boundary

Execution is complete only when all 25 task gates and reviews PASS at one clean B6 head; accepted local launcher, immutable bootstrap receipt sets, GitHub/Gitleaks/disposable/protected-base controllers, and the full root-anchor controller contract/materialization/review/request/write/readback/operation-review chain must agree with refresh/admission/0M/scanner/B0 acceptance and stage zero. Handoff lists every commit, ordered parent, PR/rules/check/workflow operation, controller/evidence digest, receipt, migration/catalog, measurement and retained/deployment/Artifact C HOLD.

This plan's completion/review authorizes no implementation. Future plan approval covers only Task 0L tracked local design/tests/review plus 0P/0A/0B; it does not authorize 0L root materialization. Root launcher materialization, Task 0F fetch, 0C merge/admission, 0M migration file, 0M disposable, Tasks 1–8 scanner, push, PR, GitHub merge/readback/re-run, postmerge fetch, controller/root anchor receipt, v3 and later disposable/runtime actions each retain separate exact gates.
