# Organization Identity Writer Ban-at-Source Design

**Status:** revised after user confirmation because live protected `main` advanced across B0 authority surfaces; pending renewed independent review and exact user reconfirmation. Implementation is not authorized by this document.

**Branch/base:** `codex/pr407-organization-identity-caller-cutover-v2` from exact Artifact A head `2400bac28796bae44294114edc99eaccb1bd65b3`.

**Authority scope:** this document is the complete Artifact B static-admission and caller-cutover design. It does not depend on an untracked plan in another worktree. A new implementation plan will be written in this branch only after the user confirms this written spec.

## 1. Objective and claim boundary

Artifact B replaces exactly three product `IdentityLink` delegate writers with the Artifact A resolver while preventing Artifact B from introducing or changing another Prisma/raw database write surface unnoticed. Artifact A remains the Identity authority foundation, while the B0 working baseline must also admit exact live protected `main` before scanner construction.

The design does **not** claim to parse arbitrary PostgreSQL or PL/pgSQL, infer every function's transitive database effects from SQL text, or prove final database authority. It establishes a transition admission contract from an exact reviewed Artifact A baseline:

1. direct or possible Prisma `IdentityLink` delegate mutation is rejected;
2. an exact current-main admission merge is independently reviewed before B0 implementation;
3. the complete refreshed product raw-capability surface and its statically reachable wrapper ingress graph are reviewed and structurally frozen;
4. except for the one §14.1 compatibility migration created during B0M before `B0_ACCEPTANCE`, Artifact B may not add or structurally change a raw SQL capability, raw wrapper ingress, migration, or database-function authority surface after that admitted baseline; B1–B6 add zero migrations;
5. literal `identity_link` source mentions are a secondary conservative detector, not semantic SQL proof;
6. the exact Artifact A migration/function/ACL inventory remains independently pinned inside the refreshed baseline;
7. B2, B4, and B4M remove the three known delegate writers in a machine-checked `3 → 2 → 1 → 0` sequence;
8. Artifact C remains the later database privilege revoke and final write-authority boundary.

This combination prevents a new dynamic command, Unicode-escaped identifier, side-effecting function call, imported raw wrapper, or future Prisma write method from receiving a clean result merely because a literal token scanner did not understand it.

## 2. Current exact facts

Fresh ContractGraph and source readback at the Artifact A base identify exactly three direct product writers:

```text
apps/api/src/acquisition/tenant-projection.service.ts:230
  tx.identityLink.create

apps/api/src/temporal/discovery.activities.ts:906
  tx.identityLink.create

apps/api/src/temporal/discovery-company-materialization-canonical.ts:206
  transaction.identityLink.create
```

Artifact A exposes:

```ts
resolveOrganizationIdentityForRaw(
  tx: Prisma.TransactionClient,
  input: Readonly<{ workspaceId: string; rawRecordId: string }>,
  lockReceipt?: SuppressionThenIdentityLockReceipt,
): Promise<OrganizationIdentityResolutionReceipt>
```

The optional third argument is allowed only when it is the exact `SuppressionThenIdentityLockReceipt` acquired in the same transaction and workspace. A caller that already holds the composite suppression→identity lock passes that receipt so the helper does not create a second lock path. Every other receipt origin or workspace mismatch is rejected by the Artifact A source contract.

The pinned dependency graph resolves Prisma and `@prisma/client` to `6.19.3`. Current repository-native extraction also recognizes `createManyAndReturn` and `updateManyAndReturn` as Prisma model writes.

An independent syntax readback observed 161 direct raw invocations under the proposed product admission root, plus aliases, structurally typed clients, helpers, maps, and wrappers that require project-level classification. That number is an audit input, not a permanent expected count; the generated baseline owns the exact inventory.

Artifact A's resolver-command migration remains:

```text
packages/db/prisma/migrations/20260830090000_organization_identity_v2_resolver_command/migration.sql
SHA-256 3cb5fe7ca22b3067b92d71ac25198c7ff14d08c08a0907343d84130bb0b7a882
```

The existing static migration suites pass 15/15 at this base:

```bash
node --test \
  packages/db/test/organization-identity-v2-resolver-command.spec.mjs \
  packages/db/test/pinned-prisma-migration-stage.spec.mjs
```

Current C-TX machine contract `20260830130300_discovery_company_materialization_schema` rejects two exact Artifact A/B values required by B4M:

```text
CANONICALIZED match_rule allowed today:
  domain_exact | identifier_exact | name_country

NOT_CANONICALIZABLE reason allowed today:
  MISSING_NAME | NON_PRODUCT_PROVENANCE | COMPANY_IDENTITY_INVALID

Required by Artifact A/B:
  match_rule identity_v2
  reason IDENTITY_CONFLICT
```

The existing active-link equality validator does not widen the table CHECK. B4M therefore requires one additive forward compatibility migration; source-only changes cannot make the current database contract accept these values.

Live readback during implementation-plan self-review observed protected main at `8f3f615ea9d0494a55f67075c7eee0bb126b3386`, 35 commits after the `c998ca7f…` main already integrated into Artifact A. The live SHA is drift-prone and is not hardcoded as the future execution base. The observed delta includes `discovery.activities.ts`, runtime/governance files, Prisma schema, and two later migrations:

```text
20260901060000_generic_operation_artifact_privacy_prefix
20260901110000_runtime_process_lease_atomic_terminalization
```

A read-only three-way merge reports three conflict hunks limited to generated Copy eligibility JSON/human citations; product source and schema auto-merge in that snapshot. This is current audit evidence only. Execution must repeat the complete live audit and may not assume the conflict set is stable.

## 3. Current-main admission before B0

### 3.1 Two authority subjects

Artifact B uses two distinct immutable subjects:

```text
ARTIFACT_A_COMMIT
  2400bac28796bae44294114edc99eaccb1bd65b3
  Identity resolver/migration/function/ACL/review authority.

B0_REFRESH_BASE_COMMIT
  Produced later by a reviewed, non-rewriting merge of exact live protected
  main into v2. Product build/raw/migration inventory subject for B0.
```

The refreshed subject must retain `ARTIFACT_A_COMMIT` and the exact live-main commit as ancestors. It does not replace or rewrite Artifact A evidence. Identity-specific resolver/migration/function/ACL bytes must remain equal to the reviewed Artifact A authority unless the refresh review explicitly stops for a new spec.

### 3.2 Refresh admission task

Before any scanner implementation, one current-main admission task must:

1. read live GitHub protected-main SHA, cached refs, worktree inventory, ahead/behind, merge base, and exact changed paths without modifying the branch;
2. classify every main-only change that intersects build inputs, raw-capability sources, migrations, Prisma schema, governance, runtime artifact rules, the three writers, resolver/lock, or B1-B6 consumers;
3. run a no-write three-way merge and enumerate every conflict;
4. stop on any Identity authority semantic drift, migration/function/ACL interaction, new direct writer, unresolved owner, or conflict outside an exact disposition;
5. stop after the read-only packet and request separate exact authorizations for any required fetch/ref update and for creation of the exact local two-parent refresh merge commit; spec reconfirmation, plan drafting/approval, and scanner implementation authority do not imply either action;
6. only after the exact local-merge authorization, merge the admitted live-main commit with a normal two-parent merge commit—never rebase, squash, force, or blanket `ours/theirs`;
7. resolve unrelated generated evidence conflicts from current main or the official generator output, never from stale feature bytes;
8. regenerate and independently review current-main admission evidence, focused/full tests, migration-chain compatibility, governance/docs, Gitleaks, and exact ContractGraph;
9. record the reviewed live-main SHA, merge commit, parents, path classifications, conflict resolutions, migration additions, raw/build delta and review digest in `organization-identity-current-main-admission.json`.

The refresh admission record contains metadata/digests only. It does not claim retained migration application, deployment, runtime health, or secret validity.

### 3.3 Baseline derivation after refresh

Product build, raw capability, wrapper ingress, current migration-directory, Prisma-version, native-extractor, and source-root baselines are derived from exact `B0_REFRESH_BASE_COMMIT`. Artifact A resolver/function/ACL authority is separately re-derived from `ARTIFACT_A_COMMIT` and checked byte-for-byte inside the refreshed tree.

Every main-only migration is included in the refreshed migration-directory manifest and receives an explicit `IDENTITY_AUTHORITY_UNCHANGED` or `HOLD` disposition. A migration is never admitted merely because its name appears unrelated. The refresh is not allowed to edit migration bytes.

### 3.4 Main drift after refresh

Immediately before B0 whole review, immediately before `B0_ACCEPTANCE`, and immediately before the protected-main merge authorization, live main must still equal the admitted live-main SHA.

If live main advances before `B0_ACCEPTANCE`, the implementation head may merge the new exact main only by repeating the complete refresh-admission task, regenerating baselines, rerunning all B0 gates, and obtaining a new whole review.

If live main advances after `B0_ACCEPTANCE`, that acceptance is abandoned and must not be merged. Create a new reviewed refresh/implementation/acceptance sequence; never merge a newer main only in the GitHub merge commit because the accepted baseline would not cover it.

## 4. Why the previous parser design is rejected

The failed Artifact B branch attempted a repository-owned PostgreSQL/PLpgSQL subset parser. Independent reviews successively found raw alias, computed delegate, traversal-budget, quoted identifier, dollar literal, `MERGE`, `COPY`, SELECT-keyword, procedural-control, and cast type-modifier escapes.

The final exact counterexample remained:

```sql
MERGE INTO public.identity_link AS target
USING source_rows AS source
ON false::numeric(DELETE FROM public.identity_link)
WHEN MATCHED THEN DO NOTHING
```

The same cast escape survived inside nested `COPY (SELECT ...) TO STDOUT`. The failed branch is preserved read-only at:

```text
codex/pr407-organization-identity-caller-cutover
5adb69877501b240e89ae3d8617617d7bf81837f
```

It is not rebased, reset, deleted, or used as the v2 implementation base.

### 3.5 Closed current-main admission record

`organization-identity-current-main-admission.json` has exact keys and no extra fields:

```ts
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
  review: Readonly<{ reportSha256: string; verdict: "PASS" }>;
}>;
```

Every `paths` record binds repository-relative path, base/branch/main/result Git blob IDs (nullable only when mechanically absent), closed classifications chosen from `BUILD | RAW_CAPABILITY | PRISMA_SCHEMA | MIGRATION | GOVERNANCE | RUNTIME_ARTIFACT | IDENTITY_CALLER | IDENTITY_AUTHORITY | GENERATED_EVIDENCE | OTHER`, owner, evidence digests, and disposition `ADMIT_IDENTITY_AUTHORITY_UNCHANGED | ADMIT_IDENTITY_IRRELEVANT | ADMIT_GENERATED_MAIN_BYTES | ADMIT_GENERATED_REBUILT | HOLD`.

Every conflict record binds path, exact hunk count, base/ours/theirs/result blob IDs, and resolution source. `ADMIT_GENERATED_REBUILT` additionally requires generator source commit, closed command ID, input digest, output blob/digest, generated JSON schema/readback digest, and exact human-citation readback digest. Free-form commands or prose are forbidden.

Every migration record binds name, path, result blob, SHA-256, last-change commit, main-only flag, Artifact A relationship, and disposition `IDENTITY_AUTHORITY_UNCHANGED | IDENTITY_IRRELEVANT | HOLD`.

The validator computes the main-only path set from exact `mergeBaseCommit..liveMainCommit` with NUL-delimited Git plumbing and requires exact set equality with `paths`: no missing, duplicate, renamed, case-colliding, out-of-range, or extra record. Conflict paths/hunk counts must equal the no-write merge facts; migration records must equal the complete refreshed migration directory. Any record or top-level `HOLD` makes the entire admission non-admissible.

The minimal current-main admission validator and its tests are the first separately reviewed implementation unit after plan approval and before any fetch/local merge authorization. After the exact refresh merge, it generates and validates the admission JSON. The later accepted writer scanner imports the same closed contracts, reruns the validator before scanner baseline generation and `B0_ACCEPTANCE`, and wires it into `governance:verify`. B0 acceptance binds the validated admission blob and review digest; prose review cannot substitute for set equality.

### 3.6 Authorization partition for the refresh

Exact amended-spec reconfirmation authorizes only implementation-plan drafting. Later approval of the implementation plan authorizes only the local code/document tasks explicitly placed before the refresh authorization gate; it does not imply fetch, ref update, or creation of a local merge commit.

The live SHA/path/no-write merge audit uses `ls-remote`, local Git objects, and merge-tree analysis without fetch. If the admitted live-main object is not already available locally, fetching that exact object/ref requires a separate explicit authorization naming the remote/ref/SHA. After the read-only audit packet and validator review are complete, creation of the exact two-parent local refresh merge commit requires another separate authorization naming branch pre-refresh SHA, admitted live-main SHA, expected conflict paths, and resolution rules.

Scanner/baseline implementation begins only from the separately authorized and independently reviewed refresh commit. Push, PR create/update, GitHub merge, protected-main readback, controller inputs, root-only receipt, v3 creation, disposable PostgreSQL, and every later remote/runtime action remain independent gates.

## 5. Approaches considered

### 5.1 Chosen: frozen raw authority surface plus conservative source admission

The chosen design uses TypeScript project analysis for Prisma capability ownership, freezes every existing raw capability/callsite/wrapper ingress from exact `B0_REFRESH_BASE_COMMIT`, separately preserves Artifact A Identity resolver/function/ACL authority, and rejects structural drift during Artifact B. A simple literal mention detector is defense-in-depth only.

Benefits:

- no SQL grammar emulation;
- dynamic SQL and Unicode syntax cannot enter through a new/changed raw surface without manifest drift;
- current complex parameterized raw calls can remain after exact review instead of being falsely classified from their parameter values;
- future Prisma methods and wrapper shapes fail closed;
- final authority remains honestly assigned to Artifact C database ACLs.

Costs:

- B0 must review and freeze the full current raw capability surface;
- any raw-capability or migration drift during Artifact B requires explicit re-review;
- manifest churn is intentional during the transition and is not a general permanent repository policy unless separately adopted.

### 5.2 Rejected: maintained PostgreSQL parser dependency

The repository currently has no PostgreSQL AST parser. Adding one would introduce supply-chain, version, native/WASM, build, and PL/pgSQL coverage obligations disproportionate to Artifact B. It may be reconsidered only as a separately approved repository-wide SQL-governance program.

### 5.3 Rejected: literal token search as sole authority

A contiguous token cannot see runtime command concatenation, `format('%I', ...)`, `U&"..."` identifiers, or side-effecting functions. Literal search remains useful for conservative blocking, but it cannot close the writer gate by itself.

### 5.4 Rejected: another handcrafted parser recovery

Renaming a third parser fix loop would evade the completed breaker rather than change the architecture.

## 6. Tracked artifacts and file responsibilities

Artifact B v2 introduces repository-governance files outside product runtime:

```text
scripts/governance-organization-identity-current-main-admission.mjs
  Closed current-main admission schema, Git diff/conflict/migration completeness
  validator and deterministic redacted receipt generator. Implemented and
  independently reviewed before the local refresh merge.

scripts/governance-organization-identity-current-main-admission.spec.mjs
  Path-set, disposition, conflict/generator provenance, migration and HOLD
  mutation tests for the pre-refresh validator.

scripts/governance-organization-identity-bootstrap.mjs
  Stdlib-only post-launch preflight. It loads no TypeScript/Prisma/dependency
  module until an external clean-environment launcher has pinned Node,
  pnpm/Corepack, bootstrap, config and tool-execution bytes.

scripts/governance-organization-identity-bootstrap.spec.mjs
  Hostile preload/loader/path/config/hook/lifecycle/tool-byte and generated-
  output ordering tests; no hostile executable is actually loaded.

scripts/governance-organization-identity-writers.mjs
  Project/build-surface admission, TypeScript capability inventory,
  baseline/stage verification, deterministic redacted CLI.

scripts/governance-organization-identity-writers.spec.mjs
  Scanner unit, mutation, hostile-input, manifest, stage, redaction,
  resource-bound, source-root, and runtime-exclusion tests.

docs/governance/organization-identity-writer-baseline.json
  Exact admitted current-main build surface, raw capability/callsite/wrapper-
  ingress graph, direct delegate inventory, normalized structural hashes and
  dispositions; Artifact A resolver authority remains separately pinned.

docs/governance/organization-identity-current-main-admission.json
  Exact live-main SHA, B0 refresh merge/parents, changed-path classifications,
  conflict resolutions, migration/raw/build deltas and independent review.

docs/governance/organization-identity-migration-authority.json
  Exact admitted refresh migration directory inventory, checksums, last-change
  commits and current-main dispositions, plus separately pinned Artifact A
  resolver/function/ACL authority records and prerequisite receipts.

docs/governance/organization-identity-writer-stage.json
  Current Artifact B stage enum and observation receipt only. Expected finding
  sets come from the immutable accepted stage-machine definition, never from
  mutable paths supplied by this file.

docs/governance/organization-identity-writer-acceptance.json
  First-add B0 acceptance anchor: reviewed implementation parent, scanner and
  manifest Git blob IDs/digests, Artifact A Git object, admitted current-main
  and refresh merge, review receipts and immutable stage-machine definition.

docs/governance/organization-identity-artifact-a-acceptance.json
  Durable non-secret Artifact A head, migration, disposable/static gate and
  independent-review receipt identities/digests consumed by B0.

packages/db/prisma/migrations/
  20260902090000_organization_identity_materialization_outcome_compat/
  migration.sql
  The only Artifact B migration: additive DDL-only C-TX CHECK compatibility
  for `identity_v2` and `IDENTITY_CONFLICT`; no DML or Prisma schema edit.

packages/db/test/
  organization-identity-materialization-outcome-compat.spec.mjs
  Static exact-definition, ordering, timeout, no-DML and provenance tests.

packages/db/test/
  organization-identity-materialization-outcome-compat.disposable.spec.mjs
  PostgreSQL 16 fresh/upgrade/catalog/lock/fault/rollback/second-deploy proof.

package.json
  Named scanner self-test, stage verification and zero verification commands.

scripts/governance-verify.mjs
  B0 self-test/stage integration and B5 live-zero integration.

.github/workflows/organization-identity-writer-anchor.yml
  Protected-main/base-owned post-merge and pull-request-target verifier. It
  executes only accepted scanner bytes from protected main and treats PR Git
  objects as data; it never checks out or executes PR-controlled code.
```

The scanner and manifests are governed artifacts. They do not enter `apps/api/src`, API/Worker composition roots, compiled `apps/api/dist`, or the runtime OCI image.

## 7. Product and shipped-source admission boundary

### 7.1 Pinned build inputs

Before reporting any inventory, the scanner verifies exact reviewed hashes and semantics for:

```text
apps/api/tsconfig.json
apps/api/tsconfig.build.json
tsconfig.base.json
apps/api/nest-cli.json
apps/api/package.json
package.json
pnpm-workspace.yaml
Dockerfile
.dockerignore
runtime-entrypoint.mjs
scripts/verify-runtime-image.mjs
pnpm-lock.yaml and packageManager pnpm@9.15.9 resolution
packages/code-intelligence/src/extractors/typescript.ts Prisma operation set
```

The build manifest binds:

- API `start` entrypoint `dist/main.js`;
- Worker entrypoint `dist/temporal/worker.js`;
- TypeScript include/exclude behavior;
- the complete `extends` chain, Nest compiler/source-root/assets configuration, workspace package roots, package manager/version and dependency-resolution inputs;
- supported source extensions `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, and `.mjs`;
- the two explicitly copied runtime scripts;
- Prisma version `6.19.3` and the reviewed model-operation inventory.
- exact absence sentinels for root `.npmrc`, `.pnpmfile.cjs`, `patches/`, and every pnpm patch/hook/config path recognized by pinned pnpm 9.15.9; later appearance is build drift.

The TypeScript project necessarily reads dependency declarations after `pnpm install --frozen-lockfile` and `pnpm --filter @global/db generate`. Dependency authority is split into two exact roots, neither of which grants arbitrary ignored-cache access.

`DEPENDENCY_DECLARATION_ROOT` permits only:

```text
TypeScript 5.9.3 lib/*.d.ts and package metadata
@prisma/client 6.19.3 declaration/package files
generated .prisma/client declaration/DMMF/schema artifacts
transitive declaration files actually resolved by the admitted Program
```

`TOOL_EXECUTION_ROOT` permits and commits only the exact bytes actually executed to derive authority:

```text
TypeScript 5.9.3 compiler JavaScript/package files loaded by the scanner
Prisma 6.19.3 generator CLI/runtime JavaScript and exact engine/native binary
files loaded by `pnpm --filter @global/db generate`
pnpm 9.15.9/corepack launcher metadata needed to prove the frozen install/generate commands
```

For both roots the scanner records logical package, lockfile integrity/resolution, normalized realpath, exact loaded/executed file set, content digest, pre/post TOCTOU metadata, and generated-output binding. Expected pnpm symlinks are resolved and must terminate inside the exact workspace dependency graph. Undeclared packages, unrecorded JS/native execution, postinstall drift, arbitrary `node_modules` traversal, source maps, caches and runtime application code are forbidden. No dependency/tool bytes are emitted.

A fresh v2/v3 worktree must use the clean bootstrap sequence below for frozen installation, Prisma generation, declaration/tool-root verification and generated schema/client/DMMF admission before scanner execution. Mutation tests change `.dockerignore`, add each absence-sentinel path/patch, redirect a pnpm symlink, and alter TypeScript compiler JS or Prisma generator/engine bytes; every case is `BUILD_SURFACE_DRIFT` or `INTEGRITY_ERROR` without executing the changed tool.

### 7.2 Pre-execution bootstrap and clean launch environment

No Node process can attest away code already executed through preload/loader options. Every local and hosted authority invocation therefore begins outside Node with a controller/base-owned launcher that uses `/usr/bin/env -i` and exact pinned absolute executables. The launcher receipt binds OS/architecture, `/usr/bin/env`, Node runtime, pnpm/Corepack launcher and bootstrap script paths/digests before starting Node. A mismatch stops before the governance process runs.

The child environment has an exact allowlist. It sets fixed task-specific empty `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `COREPACK_HOME`, `PNPM_HOME`, `TMPDIR`, minimal `PATH`, `CI=1`, and fixed UTF-8 locale. It requires absent/empty `NODE_OPTIONS`, `NODE_PATH`, preload/import/loader/require flags, `BASH_ENV`, `ENV`, npm/pnpm user/global config selectors, alternate registry/config paths, hook selectors, lifecycle-enabling overrides and every unrecognized `NODE_*`, `NPM_*`, `npm_config_*`, `PNPM_*`, or `COREPACK_*` control variable. It emits names/codes only and never values.

The closed bootstrap sequence is:

1. before starting pnpm, the branch-external controller or protected-base workflow reads accepted immutable Git objects and verifies exact blobs/required absence for root/app package files, lockfile, workspace file, `.dockerignore`, `.npmrc`, every `.pnpmfile*`, patch/config-dependency/hook input, bootstrap/test files, and every path pinned pnpm can execute or use to redirect config/storage; it also verifies exact `/usr/bin/env`, Node, pnpm/Corepack and bootstrap identities;
2. materialize only the accepted package/lock/workspace/bootstrap inputs into a fresh task root; mutable PR/current-tree bytes remain scanner data and are never installer configuration;
3. invoke exact pnpm 9.15.9 under the clean environment with `install --frozen-lockfile --ignore-scripts --ignore-pnpmfile` (or the independently proven pinned-version equivalent), force `ignorePnpmfile=true`, disable local/global/config-dependency hook selectors, and pass highest-precedence fixed store, virtual-store, modules, cache and config roots below the task root; registry routing is fixed to the reviewed public registry contract and credential-bearing inputs are unavailable to the authority process;
4. hostile fixtures and a pinned-source test prove pnpm 9.15.9 cannot call `requireHooks` or load a local/global pnpmfile under the exact effective arguments; if that proof or installation fails, return `TOOL_BOOTSTRAP_UNAVAILABLE/HOLD` rather than relaxing a flag;
5. after install and immediately before Node execution, the external controller re-verifies bootstrap inode/realpath/digest and executes the already verified immutable materialization, closing install-time TOCTOU;
6. invoke the stdlib-only bootstrap, which imports only `node:` built-ins and rehashes the complete accepted repository config/sentinel preimage, dependency declaration/tool-execution roots, lock integrity, symlink/realpath graph and effective non-secret configuration before loading any dependency module;
7. only after preflight may the bootstrap spawn the exact accepted Prisma generator/engine under the same clean environment, then verify generated schema/client/DMMF digests and post-execution TOCTOU state;
8. only after generation verification may the bootstrap dynamically import the exact accepted TypeScript compiler and scanner modules; static top-level `import "typescript"` in the bootstrap/CLI path is forbidden;
9. every scanner/governance command and the protected-main workflow calls this bootstrap path; direct Node/pnpm/package-script invocation cannot satisfy an authority gate.

If `--ignore-scripts` installation cannot provide the exact pinned Prisma generator/engine without executing lifecycle code, the task is `TOOL_BOOTSTRAP_UNAVAILABLE/HOLD`; it does not enable scripts or download a substitute. Network/cache provisioning, if later required, is a separately reviewed non-authority preparation step whose outputs still must satisfy the clean bootstrap digests.

Hostile tests construct environment/config/tool fixtures for `--require`, `--import`, custom loaders, `NODE_PATH`, redirected npm/pnpm/Corepack homes/configs, local/global `.pnpmfile` hooks, config-dependency/patch selection, store/cache redirection, lifecycle-before-preflight, bootstrap rewrite, symlink redirection and changed compiler/generator/engine bytes. Marker/loader instrumentation proves no hostile hook/module/tool body is loaded or executed, not merely that the run later exits nonzero. Pre/post install and bootstrap receipts are accepted controlled blobs/identities frozen by `B0_ACCEPTANCE`; stdout/stderr remain closed.

Any configuration, entrypoint, Docker copy, extension, generated-source, Prisma-version, or native-extractor operation drift produces `BUILD_SURFACE_DRIFT` and a non-clean result before source findings are evaluated.

### 7.3 Traversal and file safety

The conservative TypeScript admission root is `apps/api/src/`, filtered by the exact reviewed build contract. Separately shipped first-party runtime entrypoints are included in the build-surface manifest and scanned for imports/references that could reach Prisma or database clients.

Traversal uses `lstat`, rejects every symlink and non-regular file in an admitted source root, verifies normalized realpaths remain below the root, and records pre/post device, inode, mode, size, and digest. A file that changes between read and post-readback is `SOURCE_TOCTOU`. Empty paths, absolute manifest paths, `..` segments, duplicate normalized paths, case collisions, and unsupported extensions are integrity errors.

Build exclusions are machine-derived and pinned. The scanner may conservatively include additional non-shipped source, but it must label the root `CONSERVATIVE_ADMISSION_ROOT`; it may never call the larger root an exact runtime inventory. Skipping a compiled or shipped file is forbidden.

## 8. Closed finding and output contract

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
```

Paths are normalized POSIX repository-relative paths with no empty, absolute, or `..` segment. `method` is a literal union and is never populated from untrusted source text.

The CLI emits deterministic JSON sorted by `path`, `line`, `column`, `kind`, and `method`:

```text
exit 0  requested stage/zero contract satisfied
exit 1  policy finding, stage mismatch, drift, ambiguity, or budget exhaustion
exit 2  scanner/configuration/integrity execution failure
```

Stdout for exits 0/1 contains only the closed JSON schema. Stderr is empty. Exit 2 emits one closed JSON integrity code to stdout and nothing to stderr. The top-level normalizer never prints exception messages, causes, stacks, TypeScript diagnostic text, source snippets, SQL, string literals, absolute paths, environment values, or OS errors.

## 9. Prisma `IdentityLink` delegate admission

### 9.1 Closed read-only set

Safety is defined by a closed read-only set, not by an incomplete write list:

```text
findUnique
findUniqueOrThrow
findFirst
findFirstOrThrow
findMany
count
aggregate
groupBy
```

Every proved call on an `IdentityLink` delegate outside that set is a mutation or ambiguity. The current generated/native write set includes:

```text
create
createMany
createManyAndReturn
update
updateMany
updateManyAndReturn
upsert
delete
deleteMany
```

The scanner verifies parity among the pinned Prisma version, generated delegate surface, and repository-native ContractGraph extractor. A new or unknown callable method on a possible `IdentityLink` delegate is `PRISMA_IDENTITY_LINK_MUTATION_AMBIGUOUS`, never safe.

### 9.2 Conservative capability-boundary rule

The scanner uses one TypeScript project and checker. It permits direct closed read calls, but rejects or marks ambiguous any possible `IdentityLink` capability that is:

- passed as a function argument;
- accepted as a parameter;
- returned;
- exported or imported through a wrapper;
- assigned into an object, array, map, class field, closure, or collection;
- extracted, destructured, rebound, or stored for later invocation;
- selected through a dynamic model property;
- hidden behind `any`, `unknown`, an unresolved generic, union, proxy, extension context, or structural type that may include the delegate.

This boundary ban deliberately avoids project-wide semantic propagation of an escaped delegate. Artifact B has no approved need to pass the `IdentityLink` delegate across a boundary.

Direct call-site aliases are resolved only when the capability remains in the same expression/symbol chain and no boundary above is crossed. `tx[unknownModel].create(...)` on a proved Prisma origin is ambiguous because the model may be `identityLink`.

## 10. Raw capability baseline and transition freeze

### 10.1 What is inventoried

The scanner inventories every product raw capability surface, not only direct invocations:

- four direct Prisma raw methods;
- direct tagged calls and ordinary call forms;
- extraction, assignment, destructuring, `.bind`, return, export, import, parameter, class-field, object/array/map, and conditional storage;
- structurally typed or injected Prisma clients/transactions/extensions containing raw methods;
- `Prisma.sql`, `Prisma.raw`, `Prisma.join`, `Prisma.empty`, `Sql` values, sql-template-tag `Sql`, and relevant `any`/`unknown`/union flows;
- same-file and cross-file raw-capable wrapper functions and their statically reachable ingress callsites;
- dynamic raw method and dynamic model access on possible Prisma origins.

The TypeScript project graph follows import/export aliases, direct arguments/parameters/returns, finite object/map keys, and named wrapper call edges. When a capability or wrapper ingress cannot be completely classified, the baseline disposition is `RAW_STRUCTURE_AMBIGUOUS`; B0 cannot pass until that ambiguity is removed or the wrapper is replaced by an exact reviewed adapter contract.

### 10.2 Artifact A baseline manifest

`organization-identity-writer-baseline.json` records for every surface:

- repository-relative path and machine location;
- enclosing symbol identity;
- capability kind and closed method token;
- normalized TypeScript AST structural hash;
- statically reachable wrapper-ingress identities and hashes;
- disposition:
  - `PARAMETERIZED_STATIC_STRUCTURE`
  - `REVIEWED_UNSAFE_CONSTANT`
  - `GOVERNED_IDENTITY_RESOLVER`
  - `TYPE_ONLY_CAPABILITY`
  - `FORBIDDEN_DYNAMIC_STRUCTURE`
- one exact closed raw-disposition review receipt without source or SQL text.

The baseline uses exact-key machine records rather than open `Record<string, number>` or arbitrary receipt IDs:

```ts
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
```

The scanner requires the measurement keys exactly once and rejects unknown/missing/duplicate metrics. The raw review record set must equal the complete refreshed baseline set; every record has one closed disposition, and the independent reviewer/counterexample digests are recomputed before B0 acceptance. A same-named free-form receipt or partial record set is invalid.

The initial B0 review must classify every current surface. A `FORBIDDEN_DYNAMIC_STRUCTURE` or unresolved surface blocks B0; it is not an allowlist entry.

“Structural hash” means one canonical dependency-closure commitment, not a call-expression shape. Each record commits, by digest without printing the bytes, all executable preimage that can change its SQL/capability behavior:

- complete raw template/string token and literal bytes;
- referenced `const` definitions;
- finite object/map values used to choose SQL or function names;
- local and imported helper-return definitions;
- `Prisma.Sql`/join item definitions and their ordered arguments;
- structural client/delegate/raw types and relevant union members;
- wrapper ingress call arguments and the complete statically reachable dependency closure;
- normalized source-file blob IDs for every closure member;
- scanner implementation, build-surface contract, native-extractor, TypeScript/Prisma version and derivation-rule blob IDs.

Changing only a SQL literal, referenced constant, map value, helper return, existing wrapper argument, imported type, scanner rule, or manifest therefore changes the commitment even when the outer callsite topology is unchanged.

### 10.3 B0 acceptance and protected-main trust anchor

B0 uses a two-step checkpoint so the scanner/manifests cannot authorize same-task regeneration:

1. `B0_IMPLEMENTATION` descends from exact `B0_REFRESH_BASE_COMMIT`, creates the scanner, current-main admission/baseline/migration/build manifests and green self/stage tests, and is independently reviewed at one exact commit while live main still equals the admitted SHA.
2. `B0_ACCEPTANCE` is a one-parent child of the exact reviewed `B0_IMPLEMENTATION` commit and first adds `organization-identity-writer-acceptance.json`. `git diff-tree` must prove that this commit changes exactly one path: the first addition of that JSON. The record names the parent implementation commit, exact Artifact A commit, admitted live-main SHA, refresh merge/parents, scanner/test blob IDs and SHA-256 values, current-main admission/baseline/migration/build manifest blob IDs and SHA-256 values, stage-machine digest, implementation-review report digests, and the allowed later mutable stage path. Every controlled blob is read from the parent Git tree, never from the acceptance/current tree. The acceptance commit itself receives an independent scoped review while live main remains unchanged.

The acceptance commit cannot attest its own review. After its scoped review, B0 stops at `LOCAL_ACCEPTANCE_REVIEWED`. Starting B1 requires separate user authorizations to push the exact branch head, open/update the exact B0 PR, and merge it with a GitHub merge commit that preserves the reviewed `B0_IMPLEMENTATION` and `B0_ACCEPTANCE` commits. Squash, rebase, force-push, and history rewriting are forbidden for this anchor.

If protected main no longer equals the admitted live-main SHA at the start of acceptance review or merge authorization, the acceptance sequence is invalid and cannot be merged; repeat the complete current-main admission/implementation/review/acceptance sequence on a new head.

Merge authorization and actual GitHub merge execution are separate events. Immediately before the authorized merge call, read live PR head/base and require exact head=`B0_ACCEPTANCE` and exact base SHA=`admitted liveMainCommit`; auto-update, merge-queue rebasing, or any mechanism that silently changes the head/base is forbidden. Use expected-head/base preconditions when the GitHub API supports them; a mismatch stops without merging and invalidates the acceptance for this sequence.

Immediately after the merge response, independently read back the merge commit and require exactly two parents in order:

```text
first parent  = exact admitted liveMainCommit
second parent = exact reviewed B0 PR head containing B0_ACCEPTANCE
```

The root-only receipt binds both parent SHAs. If a base/head mismatch is observed before execution, do not merge. If GitHub nevertheless creates a commit with different parents, do not create the protected-main anchor or v3 worktree and do not treat it as valid B0 admission; stop for a separately authorized forward corrective plan. Ancestry alone is insufficient.

The non-self-referential trust root is protected GitHub `main` plus a controller-owned root-only readback receipt created only after the authorized merge:

```text
/global/backups/backend-root-reconciliation-20260826/successors/
  identity-writer-b0-v2/protected-main-anchor.json
```

The `0700 root:root` receipt records the live GitHub main SHA, merge commit, exact reviewed acceptance commit SHA, acceptance-review report SHA-256, PR number/head/method, peeled ancestry proof, timestamp, and receipt-chain digest. It contains no source, SQL, secret, or credential values. Creation of this receipt and every remote action are future separate authorization gates; this spec does not authorize them.

B1 uses a new branch/worktree from the exact protected-main merge commit, not from the pre-merge local v2 branch. Every B1-B6 local run requires the exact root-only receipt as a CLI input.

The ordinary `pull_request` Governance workflow is PR-controlled and is never an anchor authority. After B0 is merged, the protected-main copy of `.github/workflows/organization-identity-writer-anchor.yml` becomes the hosted trust entrypoint:

- the protected-main `push` event produced by the authorized B0 merge creates the initial hosted anchor receipt at exact `GITHUB_SHA`; the merge authorization packet explicitly discloses this automatic base-owned workflow side effect;
- B1-B6 use `pull_request_target`, whose workflow bytes come from protected base main;
- the workflow checks out/executes only the exact accepted scanner and verifier blobs from protected main;
- the PR head SHA/tree is fetched/read only as a Git object input and no PR script, package command, action, generated binary, or workflow byte is executed;
- repository/controller variables are mapped only by the protected-base workflow and the scanner verifies the exact protected workflow blob, event type, base/ref, run/repository identity, accepted B0/review/ordered-parent values and initial hosted-anchor run receipt;
- permissions are read-only except the minimum checks/status permission required to publish the closed result; no secret is exposed to PR code;
- a PR-supplied workflow, environment variable, artifact, job output, package script, or similarly named check cannot satisfy the anchor context.

The initial anchor does not rely on `workflow_dispatch` accepting a naked commit SHA. The protected-base workflow requires `event_name='push'`, `ref='refs/heads/main'`, `GITHUB_SHA` equal to the exact read-back B0 merge commit, and the protected-main workflow blob at that commit. If the initial push run is cancelled or fails, a separately authorized GitHub re-run of that same immutable workflow run/SHA may recover it; dispatching a later moving `main` ref, creating a temporary tag/branch, or substituting another run is not an allowed fallback. If exact run/SHA identity cannot be recovered, B1 remains HOLD pending a new spec.

The accepted scanner first verifies its own/current controlled blobs against the parent-tree values, then proves the reviewed acceptance commit and protected workflow blob are anchored by the externally supplied protected-main SHA. Missing network/readback input, absent receipt, receipt-chain mismatch, wrong event/workflow/ref/repository/run identity, wrong merge method, non-ancestor history, or different accepted/review SHA is `INTEGRITY_ERROR`.

The scanner may verify consistency against an externally fixed acceptance SHA; it never claims to infer “reviewed” or detect a replaced history from the current branch alone.

Every B1-B6 run reads authority values from the externally fixed acceptance Git object with `git show`. Current working-tree acceptance bytes, scanner derivation rules, baseline/migration/build manifests, native-extractor pin, and test implementation must equal their accepted parent-tree blobs. Editing and regenerating any of them is drift before current-tree recomputation occurs.

On every run, the accepted scanner directly re-derives the current closure from exact admitted `B0_REFRESH_BASE_COMMIT`, verifies its live-main/merge parents from the accepted current-main admission manifest, and also derives the Artifact A Identity authority closure from exact Git object `2400bac28796bae44294114edc99eaccb1bd65b3`. Only the closed stage removals are permitted. A same-commit source change plus regenerated manifest cannot become clean because protected-main ancestry, accepted parent-tree blobs, the admitted refresh subject, and the Artifact A Git preimage remain immutable comparison subjects.

### 10.4 Drift rule during Artifact B

From B0 through B6:

- no new raw capability surface or wrapper ingress is allowed;
- no baseline structural hash may change;
- no new caller may enter a raw-capable wrapper's ingress graph;
- removal is allowed and recorded;
- the existing `GOVERNED_IDENTITY_RESOLVER` raw command remains exact Artifact A bytes;
- any other addition, deletion mismatch, structural change, call-graph change, dynamic origin, or manifest edit without a new independent review is `RAW_CAPABILITY_BASELINE_DRIFT`.

B2/B4/B4M may change their caller files, but the normalized hashes are scoped to raw capability expressions, executable dependency closures, and wrapper ingress edges. Unrelated business-logic edits do not rewrite the raw baseline. A changed raw expression cannot be hidden by regenerating the manifest: current manifest bytes must equal the accepted first-add Git blob, and the re-derived closure must match the immutable accepted/Artifact A subjects. Any future manifest evolution requires a new design with a different authority path; it is not an Artifact B stage update.

This transition freeze, rather than literal SQL semantics, blocks new runtime concatenation, `U&` identifiers, `format('%I', ...)`, side-effecting raw function calls, imported raw binders, and structural fragments during Artifact B.

## 11. Parameter values versus SQL structure

One interpolation classifier applies equally to direct Prisma raw tags and `Prisma.sql` tags.

An interpolation is `BOUND_VALUE` only when its static type and origin exclude:

```text
Prisma.Sql
sql-template-tag Sql
Prisma.raw
Prisma.join
Prisma.empty
any
unknown
unresolved generic
every union containing a structural possibility
imported/helper-returned unproved SQL structure
```

Ordinary bound values such as workspace IDs, timestamps, hashes, enums, booleans, and numeric limits do not become SQL structure and need not resolve to literal strings.

Finite `Prisma.Sql` and `Prisma.join` items are traversed recursively under the shared budget. An unresolved item is `RAW_STRUCTURE_AMBIGUOUS`. `Prisma.raw(...)` is forbidden during Artifact B regardless of its argument; it cannot be reclassified as a bound value or legalized by resolving one string.

The same rule applies to direct tags such as:

```ts
tx.$executeRaw`DELETE FROM ${Prisma.raw("identity_link")}`;
```

which is `RAW_STRUCTURE_AMBIGUOUS` plus baseline drift, never a parameterized safe call.

## 12. Secondary literal-mention detector

The literal detector performs a bounded, ASCII-case-insensitive substring search for `identity_link` across every statically available raw template segment, string, nested finite `Prisma.Sql`, comment, quote, dollar body, cast text, and procedural body.

It intentionally has no identifier-boundary claim. It may conservatively flag longer identifiers, quoted case variants, comments, or literals. A match is `RAW_LITERAL_IDENTITY_LINK_FORBIDDEN`.

Absence of the substring proves nothing about dynamic SQL or semantic table effects. `U&` identifiers, runtime concatenation, `format`, and side-effecting functions are controlled by the frozen raw/migration authority surfaces, not by this detector.

## 13. Resource bounds

Each project scan uses closed project-total and per-resolution budgets:

```text
source files                 2,000
AST nodes per file          20,000
project symbol/call edges  200,000
raw capability records       4,096
wrapper ingress records      8,192
dependency-closure members  16,384
resolution depth                32
per-symbol assignment fanout     32
per-resolution alternatives     256
candidate bytes per record 1,000,000
project committed bytes    64,000,000
```

`raw capability records`, `wrapper ingress records`, and `dependency-closure members` count total unique canonical records in one project scan. `per-resolution alternatives` counts simultaneous possible values/structures for one resolution root; it is not charged once for every ordinary raw node in the project. `per-symbol assignment fanout` counts assignments/keys reached from one checker symbol.

Cycles are keyed by checker symbol plus operation. Candidate work is charged before allocation. Budgets do not reset by recursively re-entering aliases, imports, helpers, wrappers, interpolation classification, ingress traversal, manifest comparison, or diagnostics.

The B0 implementation measures and records exact `B0_REFRESH_BASE_COMMIT` counts using the real project graph. Artifact A counts may be retained as comparative evidence, but every 50% admission/headroom threshold applies to the refreshed graph. Every project-total capacity must be at least twice the measured refreshed baseline and that baseline must consume no more than 50% of its hard limit. If any measured count violates that headroom, B0 stops for a spec revision rather than silently raising the limit. Tests prove the exact refreshed baseline fits and adversarial fanout/depth/cycle/record/byte cases exhaust deterministically.

Budget exhaustion is `SCAN_BUDGET_EXHAUSTED` and exit 1. A TypeScript-program, filesystem, configuration, manifest-schema, or unexpected scanner failure is normalized to one closed integrity code and exit 2. Neither can yield a clean inventory.

## 14. Migration and database-function authority manifest

`organization-identity-migration-authority.json` binds the complete admitted `B0_REFRESH_BASE_COMMIT` migration directory inventory for Artifact B while separately preserving the exact Artifact A Identity authority:

- every refreshed migration directory name, migration.sql SHA-256, last-change commit, and current-main delta disposition;
- the exact resolver migration and rejected/superseded checksum set;
- exact public/private Organization Identity function signatures, owners, languages, volatility/security, search paths, proconfig, ACLs, and function-definition digests;
- exact `app_user`/PUBLIC table- and column-privilege observations relevant to `identity_link`;
- immutable references to Artifact A static and disposable review receipts.

The durable prerequisite record is `docs/governance/organization-identity-artifact-a-acceptance.json`. Its B0 first revision must bind exact Artifact A head/range and these current non-secret source receipts before the B0 implementation review. Every table path is relative to exact source workspace `/global/backend/.codex/worktrees/root-worktree-remote-closeout-plan/`:

| Evidence class      | Source path in the closeout evidence workspace                                                               | SHA-256                                                            | Required verdict                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| A7 chronology       | `.superpowers/sdd/2026-08-30-organization-identity-command-expansion/task-A7-report.md`                      | `a7faa97ecca4bbc28f79cd4a8c77ff33eedcbc771273cea793bbfdd086b91cab` | exact §11 `Final GREEN verification and receipt-bound cleanup`; stale top `BLOCKED` metadata is historical and is not a gate |
| Whole-branch review | `.superpowers/sdd/2026-08-30-organization-identity-command-expansion/final-whole-branch-review.md`           | `0263be60a8c66a13ec36bd8d4c541c53c0ef91d2ab5c77bd1a771295cee067b4` | local technical PASS; bounded Artifact B only                                                                                |
| Code review         | `.superpowers/sdd/2026-08-30-organization-identity-command-expansion/task-A7-independent-code-review.md`     | `b473e15b84ef9d4db72de7b24f7844d905e913203043824d7741b663fbe269e0` | `0 Critical / 0 Important`                                                                                                   |
| DB review           | `.superpowers/sdd/2026-08-30-organization-identity-command-expansion/task-A7-independent-db-review.md`       | `9ee0be2034eaded1e532b6b7c7a2079c0917d2b684ea52a65111cb03945f0f13` | `0 Critical / 0 Important`; retained DB HOLD                                                                                 |
| Security review     | `.superpowers/sdd/2026-08-30-organization-identity-command-expansion/task-A7-independent-security-review.md` | `3debad7dc240981e5cb25be983c53a6e02b2234d2b57e1bd5e780355734d9989` | `0 Critical / 0 Important`; `TRANSITION_HOLD`                                                                                |
| Task review         | `.superpowers/sdd/2026-08-30-organization-identity-command-expansion/task-A7-task-review.md`                 | `7fbcbb0582d344e4579b1887e5a16a2a49e7d1d3a0ab8e5eb4c791f74787426d` | Spec PASS / Quality Approved                                                                                                 |

The local ignored reports are source evidence for B0 intake, not durable authority by themselves. B0 verifies all six exact bytes and verdicts, then materializes their identities, hashes, Artifact A commit/range, migration checksums, and a no-secret schema into the tracked acceptance JSON. The B0 implementation review reads the six sources and the tracked record. The later B0 acceptance first-add commit immutably anchors that tracked blob. If any source report is absent or has a different digest before acceptance, B0 stops; after acceptance, later stages consume the immutable accepted Git blob and do not depend on mutable local report paths.

Prerequisite commands are named exactly:

```bash
node --test \
  packages/db/test/organization-identity-v2-resolver-command.spec.mjs \
  packages/db/test/pinned-prisma-migration-stage.spec.mjs
```

Any migration addition, removal, checksum change, last-change drift, relevant function/ACL digest drift, current manifest edit, or mismatch with the accepted first-add Git blob causes `MIGRATION_AUTHORITY_DRIFT`, except for the one exact spec-authorized compatibility migration below during B0 implementation. The scanner does not infer semantic non-writing from partial SQL grammar and never edits existing migration bytes or `_prisma_migrations`.

This complete refreshed-directory freeze ensures a current-main or future second migration-installed writer cannot appear while the prerequisite remains green merely because an old historical-stage test did not include it.

### 14.1 Exact additive C-TX compatibility migration

The sole Artifact B migration path is:

```text
packages/db/prisma/migrations/
20260902090000_organization_identity_materialization_outcome_compat/
migration.sql
```

Before creation, current-main admission proves the name is absent and its timestamp is strictly later than the then-live maximum migration. If that fact drifts, stop for a spec amendment; do not rename opportunistically.

The migration is DDL-only and changes no Prisma schema. It must:

1. as the first executable statements after transaction start, before any table/catalog lock or preflight scan, set and read back `0ms < lock_timeout <= 5s`, `0ms < statement_timeout <= 60s`, and `lock_timeout < statement_timeout`; zero, malformed, missing, over-limit, or wrong ordering is a static/disposable failure;
2. exact-preflight the closed catalog receipt in §14.2 and absence of the temporary constraint;
3. read `SHOW max_identifier_length`, require at least `63`, and statically prove every new name's UTF-8 octet length is within that bound;
4. add exact 58-byte `discovery_company_materialization_outcome_artifact_b_check` as `NOT VALID`, with the old predicate byte-semantically preserved except:
   - add `identity_v2` to the `CANONICALIZED` match-rule set;
   - add `IDENTITY_CONFLICT` to the `NOT_CANONICALIZABLE` reason set;
5. validate the new constraint completely before removing the old constraint;
6. drop the old constraint with `RESTRICT` semantics and rename the validated new constraint to the exact old name in the same transaction;
7. leave one final constraint, no temporary constraint, no data changes, no privilege/function/trigger changes, and no catalog residue after direct-SQL fault rollback;
8. be idempotent only through successful Prisma migration-ledger semantics—running `prisma migrate deploy` twice is allowed, but the SQL does not silently accept an unrecorded pre-existing final state.

The design deliberately keeps one PostgreSQL transaction for atomic catalog rollback. `ADD CHECK ... NOT VALID` acquires `ACCESS EXCLUSIVE`, and that lock remains held through the complete `VALIDATE`, old drop, rename and commit. The old constraint remains active while the broader new constraint validates, so there is no unprotected write window, but the validation scan occurs inside the retained `ACCESS EXCLUSIVE` window. Production-size timing, maintenance window, lock budget, failed retained-deploy recovery and retained deployment remain HOLD; disposable success cannot promote them.

### 14.2 Closed catalog preimage and postimage

The migration/test authority binds these exact source subjects:

```text
20260830130300 schema migration SHA-256
  f5692086951541f9c49606c16d8bd27ae3e1ce453e53ada9cbb59c98347fe515

20260830130400 function migration SHA-256
  b7706a1903dfc12e75c786ab3f0e9682d64154be9edad89ae9d178e20a6b4833

20260830130600 active-link compatibility migration SHA-256
  0695319e648ce9938b419ae204ee0e279a54c74dbd850e70939ab8b6359a6b51

old CHECK source segment SHA-256
  b25fb48850d832fcb78625036f929096e4bf6115da4d5e1cea3076abddbbad6c

expanded CHECK source segment SHA-256
  128db73caf587ba6b5ccf823e73ac5c5c73a5f88eb8633dd25ac803c6e33561b
```

The source-segment digest starts at the exact `CONSTRAINT discovery_company_materialization_outcome_shape_check CHECK(` token and ends at its balanced closing parenthesis with LF bytes. The expanded segment differs only by the two approved literals.

`organization-identity-materialization-outcome-compat.spec.mjs` defines an exact-key catalog receipt containing:

- schema `public`, table `discovery_company_materialization_outcome`, expected owner `global`, `relkind='r'`, not partitioned, no inheritance/children;
- old/final name `discovery_company_materialization_outcome_shape_check` and temporary name `discovery_company_materialization_outcome_artifact_b_check`;
- `contype='c'`, `convalidated=true` for old/final, nondeferrable, initially immediate, local, inheritance count zero, not `NO INHERIT`;
- old source digest and a hand-reviewed PostgreSQL 16 normalized `pg_get_constraintdef(...,true)` digest fixed in the RED/static fixture before migration GREEN;
- exact sorted `pg_depend` semantic records and dependency-set digest, derived from the accepted old source/columns and independently reviewed rather than copied from arbitrary runtime state;
- exact materialization validator trigger/function identities, owners, security/volatility/search-path/ACL and definition digests derived from the three pinned migrations above;
- temporary constraint expected absent in preimage; final expected source/catalog/dependency digests; exact one final canonical name and zero temporary names in postimage;
- row count/table size as readiness observations only, never as authority values.

The disposable test first proves the accepted refreshed-main database matches this closed preimage. It never turns a runtime-observed drifted definition into the expected value. Any owner/relkind/partition/inheritance/flag/definition/dependency/function/trigger/ACL mismatch raises one fixed no-echo admission error before DDL.

Static and disposable PostgreSQL 16 tests must prove:

- exact old→expanded predicate delta and no unrelated relaxation;
- fresh database, exact refreshed-main upgrade, second deploy, catalog definitions and zero Prisma residual drift;
- existing old values and new `identity_v2`/`IDENTITY_CONFLICT` values succeed only in their correct outcome shapes;
- wrong outcome/value combinations still fail;
- two-connection contention where connection A holds an ADD-conflicting lock and connection B executes the exact candidate, proving bounded `lock_timeout`, full transaction rollback, old constraint OID/definition/validated state intact, temporary constraint absent, and no row/function/trigger/ACL/schema-file residue;
- a test-only observation transform proves the migration transaction holds `ACCESS EXCLUSIVE` after ADD and through validation; no observation hook enters production migration bytes;
- direct-SQL fault transforms after add, after validate, after old drop and before rename leave the complete catalog preimage and `_prisma_migrations` byte/row state unchanged;
- successful Prisma deploy tests cover fresh full chain, exact refreshed-main upgrade, exact checksum/finished ledger row, identical fresh/upgrade final catalog, and second deploy `No pending migrations to apply`;
- no DML, no existing migration edit, no Prisma schema change, and no `_prisma_migrations` manipulation in production migration bytes;
- exact disposable resources are receipt-bound and cleaned separately.

Fault/rollback tests execute a closed test-only transform of the exact reviewed migration bytes directly through `psql`, inserting `RAISE EXCEPTION` only after predefined markers. They do not use `prisma migrate deploy`, do not modify the production migration file, and therefore make no claim about Prisma failed-ledger recovery.

Failed retained `prisma migrate deploy` recovery remains `HOLD / NOT_VERIFIED`. A future retained-deploy spec must separately choose and authorize either exact `migrate resolve --rolled-back` only after proving PostgreSQL schema returned to the complete accepted preimage, or another controlled executor/recovery contract. This spec does not authorize either. A successfully applied row with `finished_at IS NOT NULL` and `rolled_back_at IS NULL` is permanently immutable; it is never resolved away, and semantic rollback uses a new forward migration.

B0 migration authority records the refreshed directory plus this one planned delta, its SHA-256, last-change commit, exact definition digest and independent database/security reviews. `B0_ACCEPTANCE` freezes the resulting complete migration inventory. B1–B6 add no migration and compare against the accepted B0 inventory.

The migration file, disposable PostgreSQL creation/use/deletion, retained application and deployment are separate authorization gates. Spec/plan approval does not apply it to any database. Once applied to a retained database, rollback is a new forward correction; the migration is never edited or resolved away.

## 15. Stage matrix and test/CI behavior

Default scanner tests and stage verification are always green when the current stage has the exact expected inventory. There is no permanently failing test in the default suite.

`organization-identity-writer-stage.json` may declare only the closed stage enum and a machine observation receipt. The scanner loads the stage-to-expected-set mapping from the immutable B0 acceptance Git blob and rejects extra expected paths/methods/counts in the mutable stage file. The accepted state machine is:

| Stage                         | Expected remaining delegate writer       |
| ----------------------------- | ---------------------------------------- |
| `B0_BASELINE`                 | all three exact paths, one `create` each |
| `B1_TEMPORAL_RED`             | same three exact paths                   |
| `B2_TEMPORAL_CUTOVER`         | TenantProjection + materialization       |
| `B3_PROJECTION_RED`           | TenantProjection + materialization       |
| `B4_PROJECTION_CUTOVER`       | materialization only                     |
| `B4M_MATERIALIZATION_CUTOVER` | none                                     |
| `B5_ZERO_GATE`                | none; zero is mandatory                  |
| `B6_CLOSEOUT`                 | none                                     |

Every expected finding binds kind, closed method, repository path, exact call count, and a structural callsite identity. Line/column are reported and tested for validity but are not stable identity keys.

The immutable Artifact A baseline manifest and receipt preserve the original exact-three evidence. Live stage verification does not keep asserting that changed source still equals the original three.

The explicit live-zero command is expected to exit 1 through B4 and is recorded as a diagnostic receipt, not run as a default success gate. It must exit 0 at B4M and later.

## 16. Governance wiring and runtime exclusion

B0 adds named root commands:

```text
governance:identity-writers:test
governance:identity-writers:stage
governance:identity-writers:zero
```

These package names are developer conveniences only; the authority gate verifies that their exact commands invoke the accepted clean-environment bootstrap and never treats an arbitrary current package script as trusted. Local/controller and protected workflows invoke the bootstrap directly with the external environment receipt, then verify the package aliases are byte-equal convenience routes.

B0 wires the self-tests and current-stage command into the existing explicit governance test aggregator and `.github/workflows/governance.yml` path through `governance:verify`. Because the stage contract expects three findings at B0, governance remains green.

That ordinary PR workflow is CI evidence only. It does not establish the external anchor. The separately reviewed `organization-identity-writer-anchor.yml` is inert as authority until its exact blob is merged into protected main. After the B0 merge it runs from protected main/base as specified in §10.3; B1 cannot begin until its initial exact-main run and root/GitHub readback are PASS. B1-B6 hosted anchor checks use only its base-owned `pull_request_target` execution and never trust a same-named PR-controlled job.

B1/B3 advance only the stage value while retaining the same expected writer set; their RED product tests may change as specified. B2/B4 atomically change caller source plus the closed stage value and expected set. The stage JSON is the only mutable governance manifest in B1-B4; scanner, acceptance, raw/build/migration baselines and their derivation rules cannot change.

B4M changes the stage to zero. B5 adds `governance:identity-writers:zero` as a mandatory `governance:verify` subgate and proves the existing governance workflow invokes it. A nonzero or exit-2 result fails CI.

Runtime-artifact tests prove the governance script, tests, and manifests are absent from API/Worker compiled output, release artifact manifests, and OCI files. `scripts/` naming alone is not accepted as proof.

## 17. Artifact B caller sequence

The v2 branch ends after the independently reviewed B0 acceptance PR is merged and protected-main readback is anchored. B1 starts from that exact protected-main merge commit in:

```text
branch:   codex/pr407-organization-identity-caller-cutover-v3
worktree: /global/backend/.codex/worktrees/pr407-organization-identity-caller-cutover-v3
```

The implementation plan written after spec confirmation must contain these tasks:

```text
B0R  current-main validator/audit/authorized refresh/admission review
B0M  additive C-TX compatibility migration, static/disposable/review gates
B0   build-surface/raw/accepted-migration baseline, scanner, exact-three stage
B1   Temporal five-outcome/replay RED without writer-count change
B2   Temporal resolver cutover; stage 3 → 2
B3   TenantProjection five-outcome/chunk/replay RED without count change
B4   TenantProjection resolver cutover; stage 2 → 1
B4M  governed materialization resolver cutover; stage 1 → 0
B5   zero gate, downstream consumers, governance:verify promotion
B6   mixed fleet, old/new replay, race, disposable DB and whole review
```

B2/B4/B4M call:

```ts
resolveOrganizationIdentityForRaw(tx, { workspaceId, rawRecordId }, lockReceipt?)
```

When the caller already owns the same-transaction/workspace composite lock, it passes the exact receipt. The caller must not synthesize, cache across transactions, cross workspace, or substitute another receipt.

The outcome contract remains:

```text
bound/created  caller-owned governed Canonical/Evidence contribution
legacy_bound   read-only reuse; zero new identity/canonical/evidence write
suppressed     terminal suppression; zero contribution
conflict       terminal conflict; zero contribution
```

The final Artifact B terminal state is `CUTOVER_READY_FOR_CONTRACT`. It is not final database authority, retained migration approval, deployment, RuntimeEvidence, PILOT, or GA.

## 18. Test and independent-review requirements

### 18.1 Delegate fixtures

- all eight closed read operations;
- all nine current write operations, including `createManyAndReturn` and `updateManyAndReturn`;
- unknown/future method;
- literal and dynamic model keys;
- delegate extraction, destructuring, bind, return, parameter, import/export, map/object/array/class-field/closure storage;
- same-file and cross-file helper boundaries;
- `any`, `unknown`, generic, union, extension, and proxy-shaped origins;
- Prisma-version/generated/native-extractor drift.

### 18.2 Raw capability fixtures

- all four raw methods in tag/call/extracted/bound/wrapper forms;
- direct tags and `Prisma.sql` with ordinary bound values;
- direct-tag `Prisma.raw`, `Prisma.join`, local/imported/helper-returned `Prisma.Sql`;
- `Sql|string`, `any`, `unknown`, dynamic method, injected writer, map/object lookup, cross-file raw binder;
- new caller to an existing raw wrapper;
- unsafe finite constant and dynamic unsafe string;
- SQL-time concatenation, `format`, dynamic `EXECUTE`, `U&` identifier, side-effecting function call, Unicode-adjacent and quoted-case literal mentions;
- baseline addition/removal/hash/call-graph drift;
- every shared budget and cycle.

### 18.3 Build, filesystem, redaction, and manifest fixtures

- config, entrypoint, Dockerfile/`.dockerignore`, package-manager absence sentinel/patch/hook, extension, generated-source, Prisma-version, declaration-root, TypeScript compiler tool-root, Prisma generator/engine tool-root, and extractor drift;
- internal/external symlink, special file, realpath escape, unsupported extension, duplicate/case-collision path, pre/post TOCTOU;
- invalid manifests, duplicate records, wrong digests, absolute/`..` paths;
- FS, TypeScript, resolver, budget, config, and unexpected exceptions containing credential-like and SQL text;
- external clean-launch receipt, Node preload/import/loader/path, npm/pnpm/Corepack config/home/hook/lifecycle controls, bootstrap-before-tool ordering, exact tool executable bytes, and rejection before hostile execution;
- absence of those bytes, absolute roots, messages, causes, stacks, and diagnostics from stdout and stderr;
- exact planned compatibility migration definition/lock/fault/catalog tests and rejection of every other migration addition/removal/checksum/function/ACL drift;
- runtime artifact exclusion.
- protected-main initial `push` run exact SHA/workflow-blob identity, same-run re-run recovery, moving-main dispatch rejection, and base-owned `pull_request_target` rejection of every PR-controlled executable/input substitute.

Expectations are literal, hand-derived, exercise the real scanner, and name the mutation they catch. The independent reviewer must add counterexamples not copied from the implementer report.

## 19. Security, privacy, rollback, and external boundaries

- The scanner reads only admitted repository files plus the exact declaration/tool-execution roots admitted by the clean bootstrap. It never reads `.env`, credential values, customer data, runtime payloads, prompts, any other ignored cache, or unrelated worktrees.
- Findings and error output are metadata-only under the closed schemas above.
- No clean result authorizes SQL execution, migration application, provider dispatch, paid calls, deployment, or runtime claims.
- The failed v1 branch remains preserved/read-only. V2 rollback before merge is branch abandonment, never reset of Artifact A or shared main.
- Artifact B contains exactly the one additive compatibility migration in §14.1. Any second migration, DML, Prisma schema change, existing migration edit, or authority expansion is a design stop.
- Artifact C remains separately authorized after Artifact B deployment, old-worker drain, and rollback-floor proof; rollback never restores ambient INSERT.
- This spec does not authorize push, PR creation/update, merge, retained migration, database mutation, deployment, restart, provider/credential action, remote branch action, PR #407 closure, or worktree deletion.

## 20. Completion gates

The written spec may advance to implementation planning only after:

- independent architecture/security review reports zero Critical/Important findings;
- the user confirms this exact committed spec revision.

The later implementation may advance from B0 to B1 only after:

- exact live protected main is integrated through the independently reviewed current-main admission merge and remains unchanged through B0 acceptance/merge authorization;
- any required fetch and the exact local two-parent refresh merge were separately authorized after read-only audit;
- the admitted refresh commit retains exact live main and Artifact A as ancestors, with every build/raw/migration/schema/governance/caller delta classified;
- build/raw/migration baselines are complete and independently reviewed;
- the exact compatibility migration is DDL-only, independently database/security reviewed, accepted into the B0 migration authority, and proven on an authorized disposable PostgreSQL 16 topology; retained application remains unauthorized;
- the separate B0 acceptance first-add commit and its parent implementation commit are independently reviewed, reachable, and byte-exact;
- the exact B0 PR is merged to protected `main` with a history-preserving merge commit under separate authorization;
- actual merge preflight proves exact admitted base/reviewed head, and post-readback proves exact ordered parents rather than ancestry alone;
- live GitHub/main ancestry and the root-only protected-main anchor receipt bind the accepted B0 SHA and acceptance-review digest;
- B1 starts from the exact protected-main merge commit in the v3 worktree;
- every current raw capability surface has a non-blocking reviewed disposition;
- scanner tests, stage verification, Artifact A prerequisites, governance wiring, redaction, bounds, and runtime exclusion pass;
- live stage verification reports exactly the three baseline delegate writers and no drift/ambiguity;
- the failed v1 branch is unchanged and the v2 worktree is clean.

B0 completion authorizes only local B1 RED work. Every external action remains separately gated.
