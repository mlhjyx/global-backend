# Organization Identity Writer Ban-at-Source Design

**Status:** revised after independent architecture/security review; pending scoped re-review and user written-spec confirmation. Implementation is not authorized by this document.

**Branch/base:** `codex/pr407-organization-identity-caller-cutover-v2` from exact Artifact A head `2400bac28796bae44294114edc99eaccb1bd65b3`.

**Authority scope:** this document is the complete Artifact B static-admission and caller-cutover design. It does not depend on an untracked plan in another worktree. A new implementation plan will be written in this branch only after the user confirms this written spec.

## 1. Objective and claim boundary

Artifact B replaces exactly three product `IdentityLink` delegate writers with the Artifact A resolver while preventing Artifact B from introducing or changing another Prisma/raw database write surface unnoticed.

The design does **not** claim to parse arbitrary PostgreSQL or PL/pgSQL, infer every function's transitive database effects from SQL text, or prove final database authority. It establishes a transition admission contract from an exact reviewed Artifact A baseline:

1. direct or possible Prisma `IdentityLink` delegate mutation is rejected;
2. the complete product raw-capability surface and its statically reachable wrapper ingress graph are reviewed and structurally frozen;
3. Artifact B may not add or structurally change a raw SQL capability, raw wrapper ingress, migration, or database-function authority surface;
4. literal `identity_link` source mentions are a secondary conservative detector, not semantic SQL proof;
5. the exact Artifact A migration/function/ACL inventory remains independently pinned;
6. B2, B4, and B4M remove the three known delegate writers in a machine-checked `3 → 2 → 1 → 0` sequence;
7. Artifact C remains the later database privilege revoke and final write-authority boundary.

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

## 3. Why the previous parser design is rejected

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

## 4. Approaches considered

### 4.1 Chosen: frozen raw authority surface plus conservative source admission

The chosen design uses TypeScript project analysis for Prisma capability ownership, freezes every existing raw capability/callsite/wrapper ingress from Artifact A, and rejects structural drift during Artifact B. A simple literal mention detector is defense-in-depth only.

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

### 4.2 Rejected: maintained PostgreSQL parser dependency

The repository currently has no PostgreSQL AST parser. Adding one would introduce supply-chain, version, native/WASM, build, and PL/pgSQL coverage obligations disproportionate to Artifact B. It may be reconsidered only as a separately approved repository-wide SQL-governance program.

### 4.3 Rejected: literal token search as sole authority

A contiguous token cannot see runtime command concatenation, `format('%I', ...)`, `U&"..."` identifiers, or side-effecting functions. Literal search remains useful for conservative blocking, but it cannot close the writer gate by itself.

### 4.4 Rejected: another handcrafted parser recovery

Renaming a third parser fix loop would evade the completed breaker rather than change the architecture.

## 5. Tracked artifacts and file responsibilities

Artifact B v2 introduces repository-governance files outside product runtime:

```text
scripts/governance-organization-identity-writers.mjs
  Project/build-surface admission, TypeScript capability inventory,
  baseline/stage verification, deterministic redacted CLI.

scripts/governance-organization-identity-writers.spec.mjs
  Scanner unit, mutation, hostile-input, manifest, stage, redaction,
  resource-bound, source-root, and runtime-exclusion tests.

docs/governance/organization-identity-writer-baseline.json
  Exact Artifact A build surface, raw capability/callsite/wrapper-ingress graph,
  direct delegate inventory, normalized structural hashes and dispositions.

docs/governance/organization-identity-migration-authority.json
  Exact Artifact A migration directory inventory, checksums, last-change
  commits, resolver/function/ACL authority records and prerequisite receipts.

docs/governance/organization-identity-writer-stage.json
  Current Artifact B stage enum and observation receipt only. Expected finding
  sets come from the immutable accepted stage-machine definition, never from
  mutable paths supplied by this file.

docs/governance/organization-identity-writer-acceptance.json
  First-add B0 acceptance anchor: reviewed implementation parent, scanner and
  manifest Git blob IDs/digests, Artifact A Git object, review receipts and
  immutable stage-machine definition.

docs/governance/organization-identity-artifact-a-acceptance.json
  Durable non-secret Artifact A head, migration, disposable/static gate and
  independent-review receipt identities/digests consumed by B0.

package.json
  Named scanner self-test, stage verification and zero verification commands.

scripts/governance-verify.mjs
  B0 self-test/stage integration and B5 live-zero integration.
```

The scanner and manifests are governed artifacts. They do not enter `apps/api/src`, API/Worker composition roots, compiled `apps/api/dist`, or the runtime OCI image.

## 6. Product and shipped-source admission boundary

### 6.1 Pinned build inputs

Before reporting any inventory, the scanner verifies exact reviewed hashes and semantics for:

```text
apps/api/tsconfig.json
apps/api/tsconfig.build.json
apps/api/package.json
Dockerfile
runtime-entrypoint.mjs
scripts/verify-runtime-image.mjs
pnpm-lock.yaml Prisma/@prisma/client resolution
packages/code-intelligence/src/extractors/typescript.ts Prisma operation set
```

The build manifest binds:

- API `start` entrypoint `dist/main.js`;
- Worker entrypoint `dist/temporal/worker.js`;
- TypeScript include/exclude behavior;
- supported source extensions `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, and `.mjs`;
- the two explicitly copied runtime scripts;
- Prisma version `6.19.3` and the reviewed model-operation inventory.

Any configuration, entrypoint, Docker copy, extension, generated-source, Prisma-version, or native-extractor operation drift produces `BUILD_SURFACE_DRIFT` and a non-clean result before source findings are evaluated.

### 6.2 Traversal and file safety

The conservative TypeScript admission root is `apps/api/src/`, filtered by the exact reviewed build contract. Separately shipped first-party runtime entrypoints are included in the build-surface manifest and scanned for imports/references that could reach Prisma or database clients.

Traversal uses `lstat`, rejects every symlink and non-regular file in an admitted source root, verifies normalized realpaths remain below the root, and records pre/post device, inode, mode, size, and digest. A file that changes between read and post-readback is `SOURCE_TOCTOU`. Empty paths, absolute manifest paths, `..` segments, duplicate normalized paths, case collisions, and unsupported extensions are integrity errors.

Build exclusions are machine-derived and pinned. The scanner may conservatively include additional non-shipped source, but it must label the root `CONSERVATIVE_ADMISSION_ROOT`; it may never call the larger root an exact runtime inventory. Skipping a compiled or shipped file is forbidden.

## 7. Closed finding and output contract

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

## 8. Prisma `IdentityLink` delegate admission

### 8.1 Closed read-only set

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

### 8.2 Conservative capability-boundary rule

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

## 9. Raw capability baseline and transition freeze

### 9.1 What is inventoried

The scanner inventories every product raw capability surface, not only direct invocations:

- four direct Prisma raw methods;
- direct tagged calls and ordinary call forms;
- extraction, assignment, destructuring, `.bind`, return, export, import, parameter, class-field, object/array/map, and conditional storage;
- structurally typed or injected Prisma clients/transactions/extensions containing raw methods;
- `Prisma.sql`, `Prisma.raw`, `Prisma.join`, `Prisma.empty`, `Sql` values, sql-template-tag `Sql`, and relevant `any`/`unknown`/union flows;
- same-file and cross-file raw-capable wrapper functions and their statically reachable ingress callsites;
- dynamic raw method and dynamic model access on possible Prisma origins.

The TypeScript project graph follows import/export aliases, direct arguments/parameters/returns, finite object/map keys, and named wrapper call edges. When a capability or wrapper ingress cannot be completely classified, the baseline disposition is `RAW_STRUCTURE_AMBIGUOUS`; B0 cannot pass until that ambiguity is removed or the wrapper is replaced by an exact reviewed adapter contract.

### 9.2 Artifact A baseline manifest

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
- reviewer/evidence receipt identifiers without source or SQL text.

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

### 9.3 Immutable B0 acceptance anchor

B0 uses a two-step checkpoint so the scanner/manifests cannot authorize same-task regeneration:

1. `B0_IMPLEMENTATION` creates the scanner, baseline/migration/build manifests and green self/stage tests. It is committed and independently reviewed at one exact commit.
2. `B0_ACCEPTANCE` is a separate child commit that first adds `organization-identity-writer-acceptance.json`. The record names the reviewed parent commit, exact Artifact A commit, scanner/test blob IDs and SHA-256 values, baseline/migration/build manifest blob IDs and SHA-256 values, stage-machine digest, independent review report digests, and the allowed later mutable stage path. The acceptance commit itself receives an independent scoped review.

Every B1-B6 run locates the Git commit that first added the acceptance path, requires it to be the reviewed `B0_ACCEPTANCE` commit, and reads the authority values from that immutable Git object with `git show`. Current working-tree acceptance bytes, scanner derivation rules, baseline/migration/build manifests, native-extractor pin, and test implementation must equal their accepted Git blobs. Editing and regenerating any of them is drift before current-tree recomputation occurs.

B1 must fork the exact reviewed B0 acceptance commit. If the first-add history is absent, duplicated, rewritten, unreachable from HEAD, has the wrong parent, or differs from the accepted record, the scanner returns `INTEGRITY_ERROR`; it does not accept a replacement anchor.

On every run, the accepted scanner directly re-derives the current closure and also derives the Artifact A closure from exact Git object `2400bac28796bae44294114edc99eaccb1bd65b3`. Only the closed stage removals are permitted. A same-commit source change plus regenerated manifest cannot become clean because accepted manifest/scanner blobs and the Artifact A Git preimage remain immutable comparison subjects.

### 9.4 Drift rule during Artifact B

From B0 through B6:

- no new raw capability surface or wrapper ingress is allowed;
- no baseline structural hash may change;
- no new caller may enter a raw-capable wrapper's ingress graph;
- removal is allowed and recorded;
- the existing `GOVERNED_IDENTITY_RESOLVER` raw command remains exact Artifact A bytes;
- any other addition, deletion mismatch, structural change, call-graph change, dynamic origin, or manifest edit without a new independent review is `RAW_CAPABILITY_BASELINE_DRIFT`.

B2/B4/B4M may change their caller files, but the normalized hashes are scoped to raw capability expressions, executable dependency closures, and wrapper ingress edges. Unrelated business-logic edits do not rewrite the raw baseline. A changed raw expression cannot be hidden by regenerating the manifest: current manifest bytes must equal the accepted first-add Git blob, and the re-derived closure must match the immutable accepted/Artifact A subjects. Any future manifest evolution requires a new design with a different authority path; it is not an Artifact B stage update.

This transition freeze, rather than literal SQL semantics, blocks new runtime concatenation, `U&` identifiers, `format('%I', ...)`, side-effecting raw function calls, imported raw binders, and structural fragments during Artifact B.

## 10. Parameter values versus SQL structure

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

## 11. Secondary literal-mention detector

The literal detector performs a bounded, ASCII-case-insensitive substring search for `identity_link` across every statically available raw template segment, string, nested finite `Prisma.Sql`, comment, quote, dollar body, cast text, and procedural body.

It intentionally has no identifier-boundary claim. It may conservatively flag longer identifiers, quoted case variants, comments, or literals. A match is `RAW_LITERAL_IDENTITY_LINK_FORBIDDEN`.

Absence of the substring proves nothing about dynamic SQL or semantic table effects. `U&` identifiers, runtime concatenation, `format`, and side-effecting functions are controlled by the frozen raw/migration authority surfaces, not by this detector.

## 12. Resource bounds

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

The B0 implementation measures and records exact Artifact A counts using the real project graph. Every project-total capacity must be at least twice the measured baseline and the baseline must consume no more than 50% of its hard limit. If any measured count violates that headroom, B0 stops for a spec revision rather than silently raising the limit. Tests prove the exact baseline fits and adversarial fanout/depth/cycle/record/byte cases exhaust deterministically.

Budget exhaustion is `SCAN_BUDGET_EXHAUSTED` and exit 1. A TypeScript-program, filesystem, configuration, manifest-schema, or unexpected scanner failure is normalized to one closed integrity code and exit 2. Neither can yield a clean inventory.

## 13. Migration and database-function authority manifest

`organization-identity-migration-authority.json` binds the complete Artifact A migration directory inventory for Artifact B:

- every migration directory name, migration.sql SHA-256, and last-change commit;
- the exact resolver migration and rejected/superseded checksum set;
- exact public/private Organization Identity function signatures, owners, languages, volatility/security, search paths, proconfig, ACLs, and function-definition digests;
- exact `app_user`/PUBLIC table- and column-privilege observations relevant to `identity_link`;
- immutable references to Artifact A static and disposable review receipts.

The durable prerequisite record is `docs/governance/organization-identity-artifact-a-acceptance.json`. Its B0 first revision must bind exact Artifact A head/range and these current non-secret source receipts before the B0 implementation review. Every table path is relative to exact source workspace `/global/backend/.codex/worktrees/root-worktree-remote-closeout-plan/`:

| Evidence class      | Source path in the closeout evidence workspace                                                               | SHA-256                                                            | Required verdict                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------- |
| A7 implementation   | `.superpowers/sdd/2026-08-30-organization-identity-command-expansion/task-A7-report.md`                      | `a7faa97ecca4bbc28f79cd4a8c77ff33eedcbc771273cea793bbfdd086b91cab` | local implementation GREEN at `2400bac…`      |
| Whole-branch review | `.superpowers/sdd/2026-08-30-organization-identity-command-expansion/final-whole-branch-review.md`           | `0263be60a8c66a13ec36bd8d4c541c53c0ef91d2ab5c77bd1a771295cee067b4` | local technical PASS; bounded Artifact B only |
| Code review         | `.superpowers/sdd/2026-08-30-organization-identity-command-expansion/task-A7-independent-code-review.md`     | `b473e15b84ef9d4db72de7b24f7844d905e913203043824d7741b663fbe269e0` | `0 Critical / 0 Important`                    |
| DB review           | `.superpowers/sdd/2026-08-30-organization-identity-command-expansion/task-A7-independent-db-review.md`       | `9ee0be2034eaded1e532b6b7c7a2079c0917d2b684ea52a65111cb03945f0f13` | `0 Critical / 0 Important`; retained DB HOLD  |
| Security review     | `.superpowers/sdd/2026-08-30-organization-identity-command-expansion/task-A7-independent-security-review.md` | `3debad7dc240981e5cb25be983c53a6e02b2234d2b57e1bd5e780355734d9989` | `0 Critical / 0 Important`; `TRANSITION_HOLD` |
| Task review         | `.superpowers/sdd/2026-08-30-organization-identity-command-expansion/task-A7-task-review.md`                 | `7fbcbb0582d344e4579b1887e5a16a2a49e7d1d3a0ab8e5eb4c791f74787426d` | Spec PASS / Quality Approved                  |

The local ignored reports are source evidence for B0 intake, not durable authority by themselves. B0 verifies all six exact bytes and verdicts, then materializes their identities, hashes, Artifact A commit/range, migration checksums, and a no-secret schema into the tracked acceptance JSON. The B0 implementation review reads the six sources and the tracked record. The later B0 acceptance first-add commit immutably anchors that tracked blob. If any source report is absent or has a different digest before acceptance, B0 stops; after acceptance, later stages consume the immutable accepted Git blob and do not depend on mutable local report paths.

Prerequisite commands are named exactly:

```bash
node --test \
  packages/db/test/organization-identity-v2-resolver-command.spec.mjs \
  packages/db/test/pinned-prisma-migration-stage.spec.mjs
```

B0 also consumes the exact Artifact A disposable DB/ACL/function-residue report; it does not rerun or claim retained-database evidence without authorization.

Any migration addition, removal, checksum change, last-change drift, relevant function/ACL digest drift, current manifest edit, or mismatch with the accepted first-add Git blob causes `MIGRATION_AUTHORITY_DRIFT`. Artifact B contains no migration task, so such drift is HOLD pending a separately reviewed current-main refresh. The scanner does not infer semantic non-writing from partial SQL grammar and never edits migration bytes or `_prisma_migrations`.

This complete directory freeze ensures a future second migration-installed writer cannot appear while the prerequisite remains green merely because an old historical-stage test did not include it.

## 14. Stage matrix and test/CI behavior

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

## 15. Governance wiring and runtime exclusion

B0 adds named root commands:

```text
governance:identity-writers:test
governance:identity-writers:stage
governance:identity-writers:zero
```

B0 wires the self-tests and current-stage command into the existing explicit governance test aggregator and `.github/workflows/governance.yml` path through `governance:verify`. Because the stage contract expects three findings at B0, governance remains green.

B1/B3 advance only the stage value while retaining the same expected writer set; their RED product tests may change as specified. B2/B4 atomically change caller source plus the closed stage value and expected set. The stage JSON is the only mutable governance manifest in B1-B4; scanner, acceptance, raw/build/migration baselines and their derivation rules cannot change.

B4M changes the stage to zero. B5 adds `governance:identity-writers:zero` as a mandatory `governance:verify` subgate and proves the existing governance workflow invokes it. A nonzero or exit-2 result fails CI.

Runtime-artifact tests prove the governance script, tests, and manifests are absent from API/Worker compiled output, release artifact manifests, and OCI files. `scripts/` naming alone is not accepted as proof.

## 16. Artifact B caller sequence

The implementation plan written after spec confirmation must contain these tasks:

```text
B0   build-surface/raw/migration baseline, scanner, exact-three stage gate
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

## 17. Test and independent-review requirements

### 17.1 Delegate fixtures

- all eight closed read operations;
- all nine current write operations, including `createManyAndReturn` and `updateManyAndReturn`;
- unknown/future method;
- literal and dynamic model keys;
- delegate extraction, destructuring, bind, return, parameter, import/export, map/object/array/class-field/closure storage;
- same-file and cross-file helper boundaries;
- `any`, `unknown`, generic, union, extension, and proxy-shaped origins;
- Prisma-version/generated/native-extractor drift.

### 17.2 Raw capability fixtures

- all four raw methods in tag/call/extracted/bound/wrapper forms;
- direct tags and `Prisma.sql` with ordinary bound values;
- direct-tag `Prisma.raw`, `Prisma.join`, local/imported/helper-returned `Prisma.Sql`;
- `Sql|string`, `any`, `unknown`, dynamic method, injected writer, map/object lookup, cross-file raw binder;
- new caller to an existing raw wrapper;
- unsafe finite constant and dynamic unsafe string;
- SQL-time concatenation, `format`, dynamic `EXECUTE`, `U&` identifier, side-effecting function call, Unicode-adjacent and quoted-case literal mentions;
- baseline addition/removal/hash/call-graph drift;
- every shared budget and cycle.

### 17.3 Build, filesystem, redaction, and manifest fixtures

- config, entrypoint, Docker, extension, generated-source, Prisma-version, and extractor drift;
- internal/external symlink, special file, realpath escape, unsupported extension, duplicate/case-collision path, pre/post TOCTOU;
- invalid manifests, duplicate records, wrong digests, absolute/`..` paths;
- FS, TypeScript, resolver, budget, config, and unexpected exceptions containing credential-like and SQL text;
- absence of those bytes, absolute roots, messages, causes, stacks, and diagnostics from stdout and stderr;
- migration addition/removal/checksum/function/ACL drift;
- runtime artifact exclusion.

Expectations are literal, hand-derived, exercise the real scanner, and name the mutation they catch. The independent reviewer must add counterexamples not copied from the implementer report.

## 18. Security, privacy, rollback, and external boundaries

- The scanner reads only admitted repository files and never reads `.env`, credentials, customer data, runtime payloads, prompts, ignored caches, or unrelated worktrees.
- Findings and error output are metadata-only under the closed schemas above.
- No clean result authorizes SQL execution, migration application, provider dispatch, paid calls, deployment, or runtime claims.
- The failed v1 branch remains preserved/read-only. V2 rollback before merge is branch abandonment, never reset of Artifact A or shared main.
- Artifact B contains no migration. Any migration need is a design stop.
- Artifact C remains separately authorized after Artifact B deployment, old-worker drain, and rollback-floor proof; rollback never restores ambient INSERT.
- This spec does not authorize push, PR creation/update, merge, retained migration, database mutation, deployment, restart, provider/credential action, remote branch action, PR #407 closure, or worktree deletion.

## 19. Completion gates

The written spec may advance to implementation planning only after:

- independent architecture/security review reports zero Critical/Important findings;
- the user confirms this exact committed spec revision.

The later implementation may advance from B0 to B1 only after:

- build/raw/migration baselines are complete and independently reviewed;
- the separate B0 acceptance first-add commit and its parent implementation commit are independently reviewed, reachable, and byte-exact;
- every current raw capability surface has a non-blocking reviewed disposition;
- scanner tests, stage verification, Artifact A prerequisites, governance wiring, redaction, bounds, and runtime exclusion pass;
- live stage verification reports exactly the three baseline delegate writers and no drift/ambiguity;
- the failed v1 branch is unchanged and the v2 worktree is clean.

B0 completion authorizes only local B1 RED work. Every external action remains separately gated.
