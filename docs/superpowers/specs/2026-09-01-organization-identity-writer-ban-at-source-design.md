# Organization Identity Writer Ban-at-Source Design

**Status:** proposed for written-spec review; implementation is not authorized by this document.

**Branch/base:** `codex/pr407-organization-identity-caller-cutover-v2` at `2400bac28796bae44294114edc99eaccb1bd65b3`.

**Supersedes:** only the SQL-grammar portion of Artifact B Task B0 in `docs/superpowers/plans/2026-08-30-organization-identity-caller-cutover.md`.

**Preserves:** the Artifact A resolver, receipt, migration, lock-order, timeout, replay, materialization, and `TRANSITION_HOLD` contracts; the three Artifact B caller cutovers; Artifact C as a separately authorized later revoke.

## 1. Decision

Artifact B will not attempt to prove arbitrary PostgreSQL or PL/pgSQL statements safe with a repository-owned parser.

The static writer gate instead enforces a stronger source policy:

1. Product code must not use Prisma raw SQL to reference `identity_link` for either reads or writes.
2. Product code must not issue unresolved or dynamically constructed Prisma raw SQL whose complete text cannot be proven at scan time.
3. Product code must not mutate the Prisma `IdentityLink` delegate directly.
4. Organization Identity product behavior must use the exact Artifact A entry point `resolveOrganizationIdentityForRaw(tx, {workspaceId, rawRecordId})`.
5. Migration provenance is verified by the existing Artifact A migration tests and a separate exact migration inventory. It is not inferred by the product raw-SQL gate.

The policy is deliberately conservative. A raw query that merely contains the text `identity_link` in a comment, string literal, dollar body, cast modifier, CTE, procedure body, or read-only query is still forbidden in product source. The caller must remove the raw reference or move the behavior behind a separately designed governed command. The gate never returns `SAFE` by parsing the SQL text.

## 2. Why the previous design is rejected

The first Artifact B branch attempted a bounded TypeScript data-flow scanner plus a PostgreSQL/PLpgSQL subset parser inside `organization-identity-writer-inventory.spec.ts`. Independent reviews repeatedly found distinct fail-open families:

- raw method aliases and helper returns;
- computed Prisma delegate aliases;
- unbounded SQL lattice/origin traversals;
- quoted identifiers and dollar strings;
- PostgreSQL 16 `MERGE` ownership;
- `COPY` query/table direction and nested query ownership;
- SELECT fields whose names resemble DML keywords;
- PL/pgSQL `IF`/`ELSIF` writer ownership;
- cast type-modifier ranges that concealed mutation grammar.

The final exact counterexample remained:

```sql
MERGE INTO public.identity_link AS target
USING source_rows AS source
ON false::numeric(DELETE FROM public.identity_link)
WHEN MATCHED THEN DO NOTHING
```

and the same cast escape inside a nested `COPY (SELECT ...) TO STDOUT` query. Both were classified `SAFE` by the handcrafted parser.

This is an architectural failure, not one missing keyword. PostgreSQL expressions, casts, procedural bodies, nested queries, comments, identifiers, extensions, and versioned grammar form an open language. A partial parser cannot support a security claim that no direct writer exists.

The failed branch remains read-only provenance at `codex/pr407-organization-identity-caller-cutover@5adb69877501b240e89ae3d8617617d7bf81837f`. It is not rebased, reset, deleted, or used as the v2 implementation base.

## 3. Approaches considered

### 3.1 Recommended: conservative ban-at-source

Use TypeScript AST/symbol analysis only to identify Prisma delegate and raw-call origins. For raw calls, resolve a finite set of complete strings; then apply a bounded identifier-mention policy rather than SQL grammar parsing.

Benefits:

- closed, reviewable security contract;
- no PostgreSQL grammar/version emulation;
- no native or parser dependency;
- fail-closed behavior is simple to explain and mutation-test;
- current product code loses no approved raw `identity_link` route because none exists.

Cost:

- a harmless raw literal containing `identity_link` is blocked;
- future legitimate raw reads require a new governed helper or command;
- some dynamic raw SQL unrelated to Identity may require local refactoring if its complete string cannot be proven.

### 3.2 Rejected: add a maintained PostgreSQL parser dependency

A maintained PostgreSQL AST parser could improve SQL statement ownership, but this repository currently has no such dependency. It would add supply-chain, version-alignment, native/WASM, build, and maintenance surface. SQL parsers also do not automatically prove arbitrary PL/pgSQL bodies or TypeScript string construction safe.

This option may be reconsidered only for a repository-wide SQL governance program with its own dependency review and upgrade policy. It is disproportionate to the B0 goal.

### 3.3 Rejected: continue the handcrafted parser

The two completed fix loops demonstrated that each grammar correction exposed another syntactic escape. A third renamed recovery task would launder the review cap rather than change the architecture.

## 4. Scope and source boundary

### 4.1 Product source

The product inventory scans every `.ts` file under:

```text
apps/api/src/
```

It excludes only files whose basename ends with:

```text
.spec.ts
.test.ts
.e2e-spec.ts
```

It does not infer product ownership from a path allowlist. Any future non-test TypeScript file under `apps/api/src/` enters the scan automatically.

Test/disposable sources are scanned by scanner self-tests and fixture classification, but they never satisfy or suppress the product inventory:

```text
apps/api/test/
packages/db/test/
```

Generated outputs, `node_modules`, `.code-intelligence`, `dist`, and worktree-management paths are outside the source root and are never traversed.

### 4.2 Current exact product writers

Fresh ContractGraph and source readback at the v2 base identify exactly three direct Prisma writers:

```text
apps/api/src/acquisition/tenant-projection.service.ts
apps/api/src/temporal/discovery-company-materialization-canonical.ts
apps/api/src/temporal/discovery.activities.ts
```

Each calls `identityLink.create`. The scanner has no “approved writer” bypass. The initial B0 integration assertion records the exact three as a baseline and a separate target-zero assertion remains intentionally RED until B2, B4, and B4M remove them.

## 5. Scanner architecture

The scanner is repository governance tooling, not product runtime code.

### 5.1 Files and responsibilities

The implementation will use focused files outside the product runtime module graph:

```text
scripts/governance-organization-identity-writers.mjs
  Repository traversal, TypeScript AST/symbol analysis, bounded value resolution,
  findings, deterministic JSON output, and CLI exit code.

scripts/governance-organization-identity-writers.spec.mjs
  Literal scanner fixtures, hostile alias/data-flow cases, output redaction,
  resource-bound tests, and repository integration assertions.
```

The scanner does not enter `apps/api/src/`, the API OCI image, or a production composition root.

### 5.2 Finding contract

Findings use a closed union:

```ts
type IdentityWriterFindingKind =
  | "PRISMA_IDENTITY_LINK_MUTATION"
  | "PRISMA_IDENTITY_LINK_MUTATION_AMBIGUOUS"
  | "RAW_SQL_IDENTITY_LINK_FORBIDDEN"
  | "RAW_SQL_AMBIGUOUS"
  | "SCAN_BUDGET_EXHAUSTED";

type IdentityWriterFinding = Readonly<{
  path: string;
  line: number;
  column: number;
  kind: IdentityWriterFindingKind;
  method?: string;
}>;
```

Output never contains SQL text, string literals, source snippets, Raw values, credentials, URLs, or environment data. Diagnostics expose only repository-relative path, machine-shaped location, finding kind, and a closed method token.

The CLI emits deterministic JSON sorted by `path`, `line`, `column`, `kind`, and `method`. It exits:

```text
0  no product findings
1  one or more product findings
2  scanner/configuration/integrity failure
```

Exit `2` must never be converted to an empty or clean inventory.

## 6. Prisma delegate policy

The following mutation methods are forbidden when their receiver is, or may be, the Prisma `IdentityLink` delegate:

```text
create
createMany
update
updateMany
delete
deleteMany
upsert
```

The TypeScript checker establishes symbols and assignments within one source unit. The bounded resolver follows:

- `client.identityLink.create(...)`;
- element access with a literal or finite literal-key set;
- delegate extraction and destructuring;
- assignment aliases;
- `.bind(...)` aliases;
- direct-return helper functions in the same source unit;
- conditional expressions with a finite set of possible methods;
- Prisma client/transaction aliases proven by their symbol/value origin.

A call is `PRISMA_IDENTITY_LINK_MUTATION` when the delegate and mutation method are proven. It is `PRISMA_IDENTITY_LINK_MUTATION_AMBIGUOUS` when the receiver may be the IdentityLink delegate but the invoked method cannot be resolved to a closed safe set.

Unknown object properties that have no possible Prisma/IdentityLink origin are not findings. Surface variable names such as `tx`, `db`, or `client` alone are not authority; origin follows symbols and expressions.

## 7. Raw SQL policy

The scanner recognizes these Prisma raw methods:

```text
$executeRaw
$executeRawUnsafe
$queryRaw
$queryRawUnsafe
```

It follows direct calls, extraction, assignment, `.bind(...)`, direct-return same-file helpers, and finite conditional method sets. A dynamic element access on a proven Prisma client/transaction origin is raw-capable and therefore requires a fully resolved method and SQL value.

### 7.1 SQL-structure resolution

The scanner distinguishes SQL structure from parameter values.

For `$queryRaw`/`$executeRaw` used directly as a Prisma tagged template, ordinary `${value}` substitutions are bound parameters and cannot introduce table identifiers. The scanner inspects every static template segment for the forbidden token but does not require parameter values such as workspace IDs, timestamps, hashes, or numeric limits to resolve to strings.

For `Prisma.sql` tagged templates, the same rule applies to ordinary bound values. A nested statically known `Prisma.Sql` fragment is traversed recursively. `Prisma.raw(...)`, an imported/returned unknown `Prisma.Sql` fragment, a dynamic tag, or any other structure-bearing interpolation is `RAW_SQL_AMBIGUOUS` unless its complete SQL bytes resolve to a finite set.

For `$queryRawUnsafe`/`$executeRawUnsafe`, and for raw calls receiving a string instead of a proven parameterizing tagged template, the scanner resolves only a bounded, finite set of complete strings produced by:

- string literals;
- no-substitution template literals;
- template literals whose substitutions each resolve to a finite string set;
- string concatenation whose operands each resolve to a finite string set;
- const identifiers and same-file direct-return helpers;
- conditional expressions with finite string branches.

The scanner does not execute getters, proxies, iterators, functions, imports, environment access, or user code. It does not evaluate arbitrary JavaScript.

If any structure-bearing fragment or possible unsafe string is unresolved, cyclic, over-budget, imported from an unproved source, or dependent on runtime input, the raw call produces `RAW_SQL_AMBIGUOUS` even when another branch appears safe.

### 7.2 Identifier-mention rule

For each complete resolved string, the scanner performs one bounded, case-insensitive ASCII search for the exact table identifier token:

```text
identity_link
```

The bytes immediately before and after must not be an ASCII identifier character `[A-Za-z0-9_$]`. Quotes, schema qualification, comments, single-quoted strings, dollar bodies, casts, and procedural syntax are intentionally irrelevant: the mention is forbidden wherever it occurs.

Examples that are all `RAW_SQL_IDENTITY_LINK_FORBIDDEN`:

```sql
SELECT * FROM public.identity_link
INSERT INTO "public"."identity_link" DEFAULT VALUES
SELECT 'identity_link'
SELECT $$ identity_link $$
-- identity_link
DO $$ BEGIN DELETE FROM identity_link; END $$
```

Examples that do not match the exact identifier token:

```text
identity_links
organization_identity_linkage
"identity""_link"
```

This token test is not a SQL safety parser. Its only claim is that product raw SQL containing the governed table identifier is forbidden.

### 7.3 Raw calls unrelated to IdentityLink

A fully resolved raw string with no `identity_link` token is not an Organization Identity writer finding. This scanner makes no general claim that the SQL is safe, authorized, non-mutating, or suitable for production; other governance and runtime gates remain responsible for those properties.

## 8. Resource bounds and fail-closed behavior

Every source-file scan has one shared immutable budget:

```text
AST nodes visited       20,000
resolution depth            32
symbol assignment fanout    32
candidate strings          256
total candidate bytes  1,000,000
```

Cycles are keyed by TypeScript checker symbol plus resolution operation. Candidate creation is charged before allocation. A budget may not reset inside a helper, alias, template substitution, concatenation, origin check, or diagnostic path.

Any budget exhaustion produces `SCAN_BUDGET_EXHAUSTED` for that source location and causes CLI exit `1`. A scanner exception, unreadable source root, TypeScript program failure, or malformed configuration causes exit `2`. Neither path may emit a clean inventory.

## 9. Migration provenance boundary

The product scanner does not parse or approve migration SQL.

Artifact A already pins the exact migration chain and independently proves the resolver command, ACL, function residue, and migration checksums. B0 reads those tests/reports as prerequisites.

The only new IdentityLink INSERT command migration remains:

```text
packages/db/prisma/migrations/20260830090000_organization_identity_v2_resolver_command/migration.sql
```

Migration inventory remains INSERT-only and separate from runtime product raw SQL. It must:

- bind the exact path and reviewed checksum from Artifact A;
- reject a second migration that installs another direct IdentityLink INSERT path;
- never classify UPDATE, DELETE, TRUNCATE, COPY, comments, or unrelated migration text as the resolver INSERT provenance;
- never edit historical migration bytes or `_prisma_migrations`;
- retain all rejected/superseded checksums as HOLD evidence.

The v2 B0 implementation may call the existing Artifact A migration tests; it must not build a second general SQL parser for provenance.

## 10. Test strategy

### 10.1 Scanner unit fixtures

Literal, hand-derived fixtures cover:

- all seven direct delegate mutation methods;
- delegate extraction, destructuring, bind, helper return, conditional key sets;
- unknown computed delegate method and receiver ambiguity;
- all four Prisma raw methods;
- raw method extraction, bind, helper return, dynamic member, and conditional method sets;
- complete unsafe literals, templates, concatenations, helpers, and finite branches;
- parameterized Prisma tagged templates whose ordinary values remain runtime-dependent without becoming SQL structure;
- nested `Prisma.Sql` and forbidden/ambiguous `Prisma.raw` structure fragments;
- dynamic values, imports, cycles, getters, proxies, fanout, path, depth, node, and byte exhaustion;
- `identity_link` in SQL code, comments, quotes, dollar bodies, casts, CTEs, nested queries, and procedural bodies;
- nonmatching longer identifiers and escaped quoted identifiers;
- diagnostics contain no source text or literal values.

Each fixture names the concrete implementation mutation it catches. Expectations are literal and do not reuse scanner helpers.

### 10.2 Repository integration

At the v2 base, integration must mechanically identify exactly these three product findings and no product raw-SQL finding:

```text
PRISMA_IDENTITY_LINK_MUTATION  apps/api/src/acquisition/tenant-projection.service.ts
PRISMA_IDENTITY_LINK_MUTATION  apps/api/src/temporal/discovery-company-materialization-canonical.ts
PRISMA_IDENTITY_LINK_MUTATION  apps/api/src/temporal/discovery.activities.ts
```

The test has two separate assertions:

1. a provenance assertion that the current findings equal the exact three baseline locations;
2. a target-zero assertion that fails until all three callers are cut over.

No production allowlist converts the three findings to success. B2, B4, and B4M must remove them through real resolver adoption.

### 10.3 Non-product classification

Fixtures and disposable writers must prove the scanner can detect prohibited shapes, but their findings are reported under a separate test-only inventory. They never count toward the product target-zero result and never authorize product behavior.

### 10.4 Mutation checks

The independent reviewer must test at least:

- split-string `"identity_" + "link"`;
- template substitution producing `identity_link`;
- one safe and one forbidden conditional branch;
- helper-returned raw method and SQL;
- dynamic raw method or SQL value;
- a string literal, comment, and dollar body containing the token;
- a longer nonmatching identifier;
- an alias chain that reaches each budget;
- diagnostic redaction by embedding credential-like fixture text and proving it is absent from JSON output.

## 11. Artifact B integration and terminal states

B0 v2 is complete only when:

- the new scanner/spec receive an independent task review with zero Critical/Important findings;
- the product inventory proves exactly three direct delegate writers and zero raw-policy findings;
- the target-zero assertion is the sole intentional RED;
- Artifact A exact head/reports/checksums are unchanged and valid;
- the failed v1 branch remains preserved/read-only.

B0 completion authorizes only local B1 RED work. It does not authorize push, PR creation/update, merge, retained migration, deployment, runtime action, provider/credential action, remote branch action, or Artifact C.

Artifact B continues in the existing order:

```text
B1/B2  Temporal RED and resolver cutover
B3/B4  TenantProjection RED and resolver cutover
B4M    governed materialization resolver cutover
B5     target-zero proof and downstream consumer verification
B6     mixed-fleet, replay, race, disposable DB, and final review
```

After all B tasks and independent whole-branch review, the terminal state is `CUTOVER_READY_FOR_CONTRACT`, not final database authority, deployment, RuntimeEvidence, PILOT, or GA.

## 12. Security, privacy, and rollback

- Scanner output is metadata-only and never prints source literals or SQL bodies.
- The scanner never reads `.env`, credentials, generated caches, customer data, runtime payloads, or ignored worktree content.
- Repository traversal uses explicit roots and does not follow symlinks outside them.
- No scanner result authorizes SQL execution, migration application, provider dispatch, or deployment.
- The failed v1 branch is preserved; v2 rollback is branch abandonment, not reset of shared main or Artifact A.
- Once caller cutover commits exist, rollback before merge is ordinary branch history; after any future merge/deploy, correction is forward-only under the existing migration/runtime rules.

## 13. Non-goals

This design does not:

- parse or validate arbitrary PostgreSQL/PLpgSQL;
- prove raw SQL unrelated to `identity_link` safe;
- modify Artifact A migrations or resolver behavior;
- cut over any of the three callers;
- revoke IdentityLink privileges;
- add Organization Identity HTTP APIs or Provider Quality;
- push, open/modify a PR, merge, deploy, restart, call a provider, incur cost, rotate credentials, close PR #407, or delete a branch/worktree.
