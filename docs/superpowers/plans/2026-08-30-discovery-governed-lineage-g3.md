# Discovery Governed Lineage G3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将Company Provider的settled physical operation、最终Provider index、Raw v2 UUID和A-owned governed relation在同一Q-TX中持久化，并使exact replay在零Provider调用、零写入下完成B/A attest。

**Architecture:** Program B新增三张append-only Q-TX表和一对query-batch append/attest SQL函数；`DiscoveryRun.stats.perQuery`降为兼容读模型。Activity在任何Provider/Taxonomy调用前先attest normalized receipt；首次执行在Domain ACK APPLIED callback内写Raw、B query/attempt/items并调用A append，REPLAYED只调用B/A attest。Canonical/Identity/terminal outcome属于后续独立C-TX migration，不能混入Q-TX。

**Tech Stack:** NestJS/TypeScript 5.9、Prisma 6、PostgreSQL 16、Temporal 1.20、Vitest、Node test、A-owned governed relation substrate。

**Spec:** [`ADR-025`](../../adr/registry.md)、[`current status`](../../status/current.md)、[`G2 foundation`](2026-08-30-discovery-lineage-g2-foundation.md)、[`A substrate`](2026-08-30-governed-subject-relation-foundation.md)。

## Global Constraints

- Exact base is `68cfce7e0ba565c281e07d22f502786c0b651024`; never copy/cherry-pick the quarantined mega-branch.
- Program B owns QueryReceipt/attempt/item/Raw/Identity/Canonical outcomes; Program A remains the only owner of generic governed subject/relation/tombstone primitives.
- Do not edit the immutable A-owned migrations `20260830120000_governed_subject_relation_schema`, `20260830121000_governed_subject_relation_append_attest` or `20260830122000_governed_subject_relation_tombstone`. Q-TX migration name is `20260830130000_discovery_query_lineage_schema`.
- Q-TX does not create CanonicalCompany, IdentityLink or terminal outcome facts. C-TX is a later migration and review slice.
- Do not change Temporal Workflow command order or add a Workflow patch. Existing pre-authority/raw/query-receipt histories must replay unchanged.
- `DISCOVERY_GOVERNED_LINEAGE_NOT_READY` remains until Q-TX, C-TX and Temporal replay all pass independently.
- A query enters governed Q-TX only when every selected Company adapter declares `discovery-company-result-lineage/v1`. A mixed capable/legacy query stays entirely on the legacy path; it never creates partial governed facts.
- A lineage-capable adapter that omits/forges lineage is a structured control failure before Raw/ACK writes.
- The company materialization ACK batch contains exactly the parsed lineage operation set. Auxiliary search/crawl/robots receipts use their existing registered product-consumer transactions and never enter the company batch, its ACK facts, attempt headers or A relations.
- Historical ACK with missing B/A lineage is `DOMAIN_ACK_DISCOVERY_GOVERNED_LINEAGE_REPLAY_INTEGRITY_HOLD`; never append/backfill on replay.
- APPLIED append is fresh-only. Any pre-existing complete or partial B/A fact during APPLIED is an integrity HOLD; normal replay uses identity-only attest and never fills gaps.
- A concurrent first execution may race before QueryReceipt exists, but stable operation identity must prevent a second physical wire. The loser may only attest after Domain ACK returns REPLAYED. UNKNOWN wire/ACK state never retries the physical call.
- Every production/test/support file remains below 800 lines. All PostgreSQL tests use fresh no-egress disposable databases and explicit sequential runners where fixtures share a database.

---

## Locked Public Contracts

### Versioned descriptors

```ts
export const DISCOVERY_QUERY_LINEAGE_COMMAND_V1 =
  'discovery-query-lineage-command/v1' as const;
export const DISCOVERY_QUERY_LINEAGE_CONTRACT_V1 =
  'discovery-query-lineage-contract/v1' as const;
export const DISCOVERY_QUERY_LINEAGE_LOOKUP_V1 =
  'discovery-query-lineage-lookup/v1' as const;
export const DISCOVERY_QUERY_RAW_RELATION_V1 =
  'discovery-query-raw-relation/v1' as const;
```

Their SHA-256 values are derived from closed canonical descriptors in `discovery-query-governed-lineage.ts`; tests use golden vectors and reject hand-written unrelated digests.

### Normalized table matrix

All UUID-typed identifiers use canonical lower-case UUID text at TypeScript boundaries and PostgreSQL `uuid` columns. All digest fields are `char(64)` lower-case hex. Bounded symbolic identifiers use their explicitly declared lower-safe regex. All timestamps are `timestamptz(3)` without mutable defaults except `created_at=clock_timestamp()`.

`discovery_query_receipt`:

```text
workspace_id uuid NOT NULL
run_id uuid NOT NULL
plan_id uuid NOT NULL
authority_id uuid NOT NULL
account_key varchar(200) NOT NULL
purpose varchar(64) NOT NULL CHECK purpose='discovery.run'
subject_type varchar(80) NOT NULL CHECK subject_type='discovery_run'
subject_id varchar(200) NOT NULL CHECK subject_id='request:'||request_sha256
request_sha256 char(64) NOT NULL CHECK lower-case SHA-256
query_key char(64) NOT NULL CHECK lower-case SHA-256
query_ordinal integer NOT NULL CHECK query_ordinal BETWEEN 0 AND 1023
source_class varchar(128) NOT NULL
providers jsonb NOT NULL CHECK closed sorted unique string array, 0..16 entries
provider_count integer NOT NULL CHECK provider_count=jsonb_array_length(providers)
record_count bigint NOT NULL CHECK record_count BETWEEN 0 AND 524160
accepted_count bigint NOT NULL CHECK accepted_count BETWEEN 0 AND 524160
quarantined_count bigint NOT NULL CHECK quarantined_count BETWEEN 0 AND 524160
rejected_count bigint NOT NULL CHECK rejected_count BETWEEN 0 AND 524160
duplicate_count bigint NOT NULL CHECK duplicate_count BETWEEN 0 AND 524160
governance_denied_count bigint NOT NULL CHECK governance_denied_count BETWEEN 0 AND 524160
usage_quantity bigint NOT NULL CHECK usage_quantity BETWEEN 0 AND 524160
cost_cents bigint NOT NULL CHECK cost_cents BETWEEN 0 AND 1000000000
contract_sha256 char(64) NOT NULL
created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
PRIMARY KEY (workspace_id,run_id,query_key)
UNIQUE (workspace_id,run_id,query_ordinal)
FOREIGN KEY (workspace_id,run_id)
  REFERENCES discovery_run(workspace_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT
```

`discovery_query_operation_attempt`:

```text
workspace_id uuid NOT NULL
run_id uuid NOT NULL
query_key char(64) NOT NULL CHECK lower-case SHA-256
provider_key varchar(128) NOT NULL
producer_id varchar(128) NOT NULL
operation_id uuid NOT NULL
scope_key varchar(128) NOT NULL CHECK scope_key=workspace_id::text
authority_id uuid NOT NULL
account_id uuid NOT NULL
operation_generation integer NOT NULL CHECK operation_generation BETWEEN 1 AND 2147483647
ack_id char(64) NOT NULL
consumer varchar(200) NOT NULL
domain_aggregate_type varchar(200) NOT NULL CHECK domain_aggregate_type='RawSourceRecord'
domain_ack_key char(64) NOT NULL
domain_revision char(64) NOT NULL
result_digest char(64) NOT NULL
result_schema varchar(128) NOT NULL
lineage_schema varchar(128) NOT NULL
provider_record_count integer NOT NULL CHECK provider_record_count BETWEEN 0 AND 1000000
covered_item_count integer NOT NULL CHECK covered_item_count BETWEEN 0 AND LEAST(provider_record_count,4095)
contract_sha256 char(64) NOT NULL
created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
PRIMARY KEY (workspace_id,operation_id)
UNIQUE (workspace_id,run_id,query_key,provider_key,operation_id)
FOREIGN KEY (workspace_id,run_id,query_key)
  REFERENCES discovery_query_receipt(workspace_id,run_id,query_key) ON DELETE RESTRICT ON UPDATE RESTRICT
FOREIGN KEY (scope_key,operation_id)
  REFERENCES tool_budget_operation(scope_key,id) ON DELETE RESTRICT ON UPDATE RESTRICT
FOREIGN KEY (ack_id)
  REFERENCES execution_domain_ack(ack_id) ON DELETE RESTRICT ON UPDATE RESTRICT
```

`execution_domain_ack` has no workspace composite key, so the single-column `ack_id` FK proves existence only. Task 4 must additionally lock the exact ACK row and prove `ack_id/scope_key/operation_id/consumer/domain_aggregate_type/authority_id/account_id/result_schema/result_digest` as one database invariant before any B/A append.

`discovery_query_attempt_item`:

```text
id uuid PRIMARY KEY
workspace_id uuid NOT NULL
run_id uuid NOT NULL
query_key char(64) NOT NULL CHECK lower-case SHA-256
provider_key varchar(128) NOT NULL
operation_id uuid NOT NULL
record_index integer NOT NULL CHECK record_index BETWEEN 0 AND 999999
resolution_kind varchar(32) NOT NULL CHECK IN (INSERTED,EXISTING,REUSE_BATCH)
source_record_index integer NULL
raw_record_id uuid NOT NULL
raw_payload_hash char(64) NOT NULL
raw_ingest_status varchar(32) NOT NULL CHECK IN (ACCEPTED,QUARANTINED,REJECTED)
relation_key varchar(192) NOT NULL
operation_subject_id uuid NOT NULL
child_subject_id uuid NOT NULL
relation_id uuid NOT NULL
contract_sha256 char(64) NOT NULL
created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
UNIQUE (workspace_id,run_id,query_key,provider_key,record_index)
UNIQUE (workspace_id,operation_id,relation_key)
FOREIGN KEY (workspace_id,run_id,query_key,provider_key,operation_id)
  REFERENCES discovery_query_operation_attempt(workspace_id,run_id,query_key,provider_key,operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT
FOREIGN KEY (workspace_id,raw_record_id)
  REFERENCES raw_source_record(workspace_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT
```

`INSERTED|EXISTING` require `source_record_index IS NULL`. `REUSE_BATCH` requires `0 <= source_record_index < record_index`, an earlier item in the same workspace/run/query/provider, and the same `raw_record_id`. Every final Provider index has its own B item and A relation even when multiple indexes resolve to one Raw UUID; only the Raw row is deduplicated.

Query counts are recomputed by SQL, not trusted from TypeScript:

```text
record_count = total item count
accepted_count = INSERTED items with Raw status ACCEPTED
quarantined_count = INSERTED items with Raw status QUARANTINED
rejected_count = INSERTED items with Raw status REJECTED
duplicate_count = EXISTING + REUSE_BATCH item count
governance_denied_count = quarantined_count + rejected_count
usage_quantity = accepted_count
record_count = accepted + quarantined + rejected + duplicate
```

All three tables are append-only and FORCE RLS with the repository-standard `workspace_id = current_workspace_id()` policy. `app_user` receives SELECT only; PUBLIC/platform/runtime groups receive no direct DML. Public functions use the same caller admission as A-owned functions: `session_user='app_user'`, `current_setting('role',true)='none'` and exact workspace context; SET ROLE is rejected. This Q-TX does not invent a separate runtime-role membership path. Only the migration owner may execute internal helpers. Static mutation tests reject any weaker policy, missing composite tenant FK, missing ACK scope validation or direct B update/delete path.

### Query-batch SQL functions and distinct command schemas

```sql
append_discovery_query_lineage_v1(p_append_command jsonb)
  RETURNS TABLE(status text,
                attempt_count integer,
                item_count integer,
                query_key text);

attest_discovery_query_lineage_v1(p_attestation_key jsonb)
  RETURNS TABLE(status text,
                query_receipt jsonb,
                attempt_count integer,
                item_count integer,
                replay boolean);
```

`DiscoveryQueryLineageAppendCommandV1` is the full closed batch command. `DiscoveryQueryLineageAttestationKeyV1` contains exactly `schemaVersion=discovery-query-lineage-lookup/v1`, `workspaceId/runId/planId/queryKey/queryOrdinal` and the purely parsed immutable `ExecutionBudgetBinding` fields (`authorityId/accountKey/purpose/subjectType/subjectId/requestSha256`). It cannot carry attempts, items, ACK or A facts. Attest first matches those immutable binding fields to the stored QueryReceipt, then loads all expected facts from B tables, reconstructs every stored A tuple and calls A attest; it never calls BudgetStore, Provider or caller-supplied materialization facts. It does not require the stored authority/account to remain unexpired/open/unexhausted.

The formal Discovery authority subject is request-bound, not run-ID-bound: `subjectId='request:' + requestSha256`, while `runId` is independently bound by the workspace-composite DiscoveryRun FK. Append and attest require `accountKey = purpose + ':' + subjectType + ':' + subjectId + ':' + requestSha256`; a binding that substitutes `runId` for subjectId, or changes any request/account component for the same query, fails before stored data is returned.

Attest has three closed outcomes. `NOT_FOUND` and `REPLAYED` are returned rows; corruption raises only the trusted `P0001` integrity marker mapped to the stable HOLD code:

```text
NOT_FOUND: no QueryReceipt and no related B rows; zero writes and zero A calls
REPLAYED: complete QueryReceipt/attempt/item set and every A attest succeeds
INTEGRITY_HOLD: any orphan/partial/drifted B fact, missing A fact or identity collision
```

`NOT_FOUND` is the only outcome that may continue into initial budget authorization and Provider execution. Absence and corruption are never represented by the same empty row/error.

`cost_cents` deliberately preserves the existing `DiscoveryQueryReceiptV1.costCents` contract and its `0..1_000_000_000` bound; Q-TX does not invent a cents-to-microusd conversion. Exact Provider execution cost remains the execution/spend ledger's responsibility.

Both functions are `VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public`. Append is fresh-only, returns `status='APPLIED'`, may write B rows and call A append; it never returns replay and never completes partial historical state. Attest is persistently read-only and calls A attest only. Both reject SET ROLE, temp shadow, cross-workspace, open/extra JSON fields, oversized arrays and unknown provider contracts. B never directly reads A-owned tables: it compares the operation-subject, child-subject and relation IDs returned by A append/attest with the B snapshots.

The append command contains `0..128` company attempts. Attempt count is descriptor-snapshotted and validated before the first ACK repository/database call or any Raw/B/A lock/write; 129 attempts raise `DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID`. Zero attempts is reserved for the two locked zero-company shapes, and settled zero-output attempts still count toward the 128 bound.

Before append accepts any attempt, it locks all `execution_domain_ack` rows with the exact `scope_key/operation_id/consumer/domain_aggregate_type` and applies this matrix:

```text
0 rows: invalid/HOLD because the current APPLIED ACK must already exist in this transaction
1 row and exact ack_id/authority/account/result/schema facts: eligible for fresh append
1 row and exact new binding/identity: eligible for fresh append
1 row but legacy or otherwise non-exact: historical identity HOLD
2 or more rows across the registered legacy/new allowlist: historical/duplicate identity HOLD
```

This check occurs before Raw/B/A materialization. It does not search only the new binding. For each producer it searches the exact registered union of the legacy tuple and new tuple; unrelated consumers of the same physical operation are excluded. If a legacy ACK exists and the new identity was tentatively inserted in the outer transaction, the function observes both allowlisted rows, raises `DOMAIN_ACK_DISCOVERY_GOVERNED_LINEAGE_REPLAY_INTEGRITY_HOLD`, and the whole transaction rolls the new ACK back.

### Locked company ACK identity and binding

The governed path must call `discoveryCompanyDomainAckIdentity({runId,providerKey,operationId,resultDigest})`. The resulting raw `domainAckKey=runId:providerKey:operationId` is opaque-hashed exactly once by DomainAckService; `domainRevision=resultDigest`; queryKey never participates.

| Provider | Producer | Consumer | Domain aggregate |
|---|---|---|---|
| `trade_fair` | `tradefair.algolia` | `TradeFairDiscoveryProvider` | `RawSourceRecord` |
| `public_web` | `discovery.extract_company` | `PublicWebDiscoveryProvider.mineDomain` | `RawSourceRecord` |
| `directory` | `discovery.extract_list` | `DirectoryDiscoveryProvider.extractList` | `RawSourceRecord` |

The legacy allowlist uses the same three consumer strings with `domain_aggregate_type=CanonicalCompany`; the new allowlist uses `RawSourceRecord`. No other consumer/aggregate tuple participates in historical-upgrade detection.

The company ACK input operation set must equal the union of parsed `attemptReceipts` and `receiptCoverage` operations exactly: no missing or auxiliary operations and no duplicates. Wrong provider/producer/result schema cannot create an ACK.

### Locked A relation tuple

Each Provider index has one relation, including two indexes that resolve to the same Raw UUID:

```text
rootSubjectType = tool_operation
rootSubjectId = operationId
rootDataClass = NON_PERSONAL
rootDsrSubjectType/rootDsrSubjectId = null
parentGovernedSubjectId = null
childSubjectType = raw_source_record
childSubjectId = rawRecordId
childDataClass = NON_PERSONAL
childDsrSubjectType/childDsrSubjectId = null
relationKind = MATERIALIZED_CHILD
relationKey = discovery.raw_source_record:<recordIndex>
sourceRef.namespace = discovery_query_attempt_item
sourceRef.uuid = item.id
sourceRef.sha256 = null
contractSha256 = canonical DISCOVERY_QUERY_RAW_RELATION_V1 descriptor digest
```

Settled zero-output and no physical attempt are different contracts. Settled zero-output creates QueryReceipt + one company attempt + one company ACK, with zero items/relations. A proven not-invoked Provider creates zero company attempt/item/relation; its auxiliary search/crawl/robots receipts, if any, are still ACKed in the globally sorted auxiliary partition in the same transaction. Invoked-without-receipt is a non-retryable control failure; it never uses the empty-ack `UNRECEIPTED` callback as a substitute. `providers` equals the sorted selected-adapter key set exactly (maximum 16), not merely adapters with records. A non-empty selected set remains non-empty if adapters fail or prove not-invoked; ordinary failure cannot rewrite it to `[]`.

Zero selected adapters is an explicit governed zero-attempt/zero-item/global-zero-ACK query: it creates one normalized zero QueryReceipt so later replay is zero-call. It is not classified by incidental JavaScript `[].every()` behavior. A non-empty selected set with zero company attempts is a different shape: auxiliary ACK facts may commit with QueryReceipt, while company attempts/items/A relations remain zero.

Final resolution kinds are derived, not copied:

```text
resolver WRITE + writer inserted=true  -> INSERTED
resolver WRITE + writer inserted=false -> EXISTING
resolver EXISTING                       -> EXISTING
resolver REUSE_BATCH                    -> REUSE_BATCH
```

The writer Raw UUID/hash/status must match the final item. During REPLAYED, any resolver `WRITE` is an integrity HOLD; replay never invokes the writer to test whether an insert would deduplicate.

### Domain ACK callback facts

```ts
export interface DomainAckMaterializationFact {
  readonly producerId: string;
  readonly operationId: string;
  readonly status: 'APPLIED' | 'REPLAYED';
  readonly ack: DomainAckRecord;
}
```

`applyDomainAckConsumerTransactions()` first descriptor-snapshots all acknowledgement inputs, validates operation uniqueness/bindings, sorts the inputs by `receipt.operationId`, and only then performs the first ACK repository/database call in that order. It collects the exact returned records into a same-order frozen fact array for `apply(transaction,facts)` or `readback(transaction,facts)`. Existing callbacks may ignore the second argument; the existing public result shape remains unchanged.

### Stable error contract

The implementation maps only trusted `P2010/P0001` markers to stable `ExecutionControlError` codes in the already-approved `DOMAIN_ACK_` family and never returns SQL, Raw payload, URL, company name, receipt body or token:

```text
DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID
DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_CONFLICT
DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_UNAVAILABLE
DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_PROVIDER_UNSUPPORTED
DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH
DOMAIN_ACK_DISCOVERY_GOVERNED_LINEAGE_REPLAY_INTEGRITY_HOLD
```

Tests must prove all six survive Temporal `ApplicationFailure/ActivityFailure` wrapping and are rethrown by the Workflow instead of incrementing ordinary query failures; arbitrary message-only Error/Proxy/getter objects cannot impersonate a trusted control failure.

## Task 1: Pure governed Q-TX plan builder

**Files:**
- Create: `apps/api/src/discovery/discovery-query-governed-lineage.ts`
- Create: `apps/api/src/discovery/discovery-query-governed-lineage.spec.ts`

**Interfaces:**
- `buildDiscoveryQueryLineageLookup()` consumes run/plan/ordinal/normalized query identity plus the purely parsed immutable `ExecutionBudgetBinding` and produces the identity-only preflight key.
- `buildDiscoveryQueryProviderPlan()` consumes selected adapter capabilities, parsed `DiscoveryCompanyResultLineageV1` and callback receipts and produces frozen coverage/attempt intent.
- `finalizeDiscoveryQueryLineageCommand()` consumes provider intent, index-preserving resolutions, exact Raw writer receipts, full `BudgetAccountAuthorization` and frozen `DomainAckMaterializationFact[]` and produces the closed append command. The bigint authorized cap remains only in the authoritative budget object; it is neither JSON-encoded nor persisted in B because Q-TX needs only the validated authority/account/generation snapshots.
- Operation generation is loaded from the Tool operation by SQL and checked against the ACK/operation authority/account facts; it is never trusted from browser or Provider input.

- [ ] Write RED tests for capable/legacy classification, callback-lineage exact equality, settled zero-output versus proven not-invoked, multi-attempt disjoint coverage, WRITE/EXISTING/REUSE_BATCH, duplicate Raw UUID with distinct per-index relations, hostile reflection and exact ancillary receipt exclusion.
- [ ] Prove the lineage operation set equals the ACK-fact set and every attempt has exactly one ACK fact; missing/extra ACK or auxiliary operation fails closed.
- [ ] Lock the attempt boundary with 0/128 success vectors and a 129-attempt RED that fails before the first ACK/database action; mutation removing or widening 128 must fail.
- [ ] Prove lookup identity is computable before BudgetStore/Taxonomy/Provider and has closed `NOT_FOUND|REPLAYED|INTEGRITY_HOLD` semantics.
- [ ] Add golden RED where legal `subjectId=request:<requestSha256>` differs from `runId` and append/replay pass; `subjectId=runId` or changed request/account facts fail closed.
- [ ] Run focused Vitest; reference mutations pass and production import fails.
- [ ] Implement immutable parsers/builders and canonical descriptor digests without database or Activity imports.
- [ ] Run coverage with statements/branches at least 80% and commit `feat: build governed discovery query lineage plans`.
- [ ] Obtain independent API/security review at `0 C/H/M`.

## Task 2: Exact Domain ACK materialization facts

**Files:**
- Modify: `apps/api/src/durable-results/domain-ack-consumer-bindings.ts`
- Modify: `apps/api/src/durable-results/domain-ack.spec.ts`

**Interfaces:**
- Produces frozen `DomainAckMaterializationFact[]` for APPLIED and REPLAYED closures.
- Preserves `DomainAckConsumerBatchResult` and all existing callers.

- [ ] Write RED tests for repeated producer/different operation, exact ACK identity, immutable sorted facts, mixed state rejection and callback failure rollback.
- [ ] Add concurrency RED proving opposite input orders use identical operation lock order, and an instrumentation RED proving sorting occurs before the first ACK repository call.
- [ ] Descriptor-snapshot and sort acknowledgement inputs before repository calls, retain `result.ack`, and pass same-order frozen facts to closures.
- [ ] Run all Domain ACK consumers and commit `feat: expose exact domain ack materialization facts`.
- [ ] Independently review lock order and legacy caller compatibility.

## Task 3: Q-TX additive schema

**Files:**
- Create: `packages/db/prisma/migrations/20260830130000_discovery_query_lineage_schema/migration.sql`
- Modify: `packages/db/prisma/schema.prisma`
- Create: `apps/api/src/discovery/discovery-query-lineage.migration.spec.ts`
- Create: `packages/db/test/discovery-query-lineage-schema.rls.spec.mjs`

**Interfaces:**
- Produces the three locked tables only; public functions belong to Task 4.

- [ ] Write static and true-PG RED tests for the exact matrix above, the real `tool_budget_operation(scope_key,id)` and `execution_domain_ack(ack_id)` FKs, composite tenant FKs, count equalities, dense items, settled-zero/no-attempt split, REUSE_BATCH source constraints, RLS/ACL, append-only triggers, fresh/upgrade parity and forbidden Canonical/Identity ownership.
- [ ] Implement the additive schema; never modify earlier migrations.
- [ ] Run Prisma format/validate/generate, fresh and 118→119 upgrade schema parity, RLS/ACL and commit `feat: add discovery query lineage schema`.
- [ ] Refresh Copy eligibility only if `schema.prisma` changes; it must remain STALE_HOLD/NOT_AUTHORIZED/BLOCKED.
- [ ] Obtain independent DB/security review.

## Task 4: Q-TX append/read-only attest SQL repository

**Files:**
- Create: `apps/api/src/discovery/discovery-query-lineage.repository.ts`
- Create: `apps/api/src/discovery/discovery-query-lineage.repository.spec.ts`
- Create: `packages/db/prisma/migrations/20260830130100_discovery_query_lineage_functions/migration.sql`
- Create: `packages/db/test/discovery-query-lineage-functions.rls.spec.mjs`

**Interfaces:**
- Produces `appendQueryLineageV1(tx,command)` and `attestQueryLineageV1(tx,command)`.
- Calls A append/attest functions inside SQL; no direct A table access.

- [ ] Write RED for exact fresh append, identity-only attest, drift conflict, settled-zero/no-attempt, dense holes/duplicates/out-of-range, Raw run/provider/hash/status mismatch, ACK missing, historical legacy-consumer/CanonicalCompany ACK missing B/A HOLD and relation failure rollback.
- [ ] Lock two zero-company-operation shapes: `selected=[]` directly appends QueryReceipt with globally zero ACK/Raw/attempt/item/A facts; selected capable adapters proven not-invoked first apply any auxiliary ACK-only facts in global order, then append QueryReceipt in the same transaction with zero company attempt/item/A facts. Neither calls the empty-ack helper.
- [ ] Write RED proving APPLIED with any complete/partial prior B/A state fails without backfill, attestation key rejects materialization fields, and B functions never read A tables directly.
- [ ] Write concurrency RED for same tuple, same operation drift, QueryReceipt collision and 100 read-only attests with zero mutation.
- [ ] Implement closed append/key validation, sorted row locks, fresh-only append, exact read-only attest, the locked per-index A tuple, count reconciliation and persisted A IDs on every item.
- [ ] Run fresh 120-migration PG plus 119→120 upgrade inventory/checksum parity, coverage/build/lint and commit `feat: add discovery query lineage append and attest`.
- [ ] Obtain independent DB/security review at `0 C/H/M`.

## Task 5: Activity Q-TX integration and zero-call replay

**Files:**
- Modify: `apps/api/src/temporal/discovery.activities.ts`
- Modify: `apps/api/src/temporal/discovery.activities.spec.ts`
- Modify: `apps/api/src/temporal/raw-source-activities.spec.ts`
- Test only: `apps/api/src/temporal/workspace-authority.replay.spec.ts`

**Interfaces:**
- Managed query preflight calls B attest before taxonomy/provider work; existing receipt returns immediately.
- APPLIED callback writes Raw, B Q-TX and A relations; REPLAYED callback only attests.

- [ ] Write RED proving identity-only normalized receipt preflight occurs before taxonomy/provider, exact replay invokes zero adapters, and legacy path remains unchanged when not all selected adapters declare lineage.
- [ ] Move preflight ahead of `ensureRunBudget()`: parse execution binding without BudgetStore, compute the lookup key, call B attest, and on REPLAYED return stored receipt without budget/account freshness checks. Only NOT_FOUND may call `attestAuthorized()` and proceed.
- [ ] Prove replay rejects a different immutable authority/workspace/purpose/subject/request binding before returning stored data, while exact historical binding succeeds after natural authority expiry or account closure/exhaustion without BudgetStore freshness calls.
- [ ] Write RED for capable missing lineage, undeclared lineage, callback/lineage drift, mixed lineage/legacy query, lineage errors not swallowed and historical old ACK HOLD.
- [ ] Replace governed path reconciliation with index-preserving resolution; resolve every final index to an exact Raw UUID and never WRITE during REPLAYED.
- [ ] For `selected=[]`, bypass ACK orchestration and call fresh-only B append directly. For selected-all-not-invoked, process exact auxiliary ACK-only facts and B append in the same transaction. In both shapes first run writes exactly one QueryReceipt and second run returns through preflight with zero BudgetStore/adapter/Provider calls.
- [ ] Split exact company materialization facts from auxiliary receipts while preserving one globally operation-ID-sorted ACK repository sequence in the same outer workspace transaction. Auxiliary receipts keep existing producer/consumer/aggregate/key semantics, use no-op domain apply, never enter the Q-TX builder and any auxiliary ACK failure rolls back the whole Q-TX.
- [ ] Add a G3 partitioned ACK orchestrator in `domain-ack-consumer-bindings.ts`: it descriptor-snapshots and globally sorts company+auxiliary inputs before the first lock, returns separately frozen fact arrays, enforces homogeneous state only for the company partition, and preserves the existing public helper/result for all legacy callers.
- [ ] Test company APPLIED + auxiliary REPLAYED, company REPLAYED + auxiliary APPLIED (missing QueryReceipt => HOLD and auxiliary insert rollback), auxiliary failure rollback and opposite input-order concurrency without deadlock or second wire.
- [ ] Preserve and pass the full authorization returned by `attestAuthorized()` (`authorityId/accountId/generation/authorized cap`) instead of reducing it to `ExecutionBudgetBinding`.
- [ ] Wire frozen ACK facts and B append/attest commands inside the same workspace transaction; relation failure rolls back ACK/Raw/B rows/stats/usage.
- [ ] Prove a concurrent first-run loser only attests after REPLAYED ACK, stable operation identity prevents a second physical wire, and UNKNOWN physical/ACK state never retries.
- [ ] Keep `DiscoveryRun.stats.perQuery` as a compatibility read model derived from normalized receipt.
- [ ] Run the exact pre-authority, authority, raw-governance and query-receipt Temporal history fixtures unchanged and commit `feat: integrate governed discovery query lineage`.
- [ ] Obtain independent Activity/Temporal/security review.

## Task 6: C-TX Canonical or terminal outcome

**Files:**
- Create: `docs/superpowers/plans/2026-08-30-discovery-company-materialization-ctx.md`

- [ ] Audit and lock an exact IdentityLink uniqueness/database materializer contract.
- [ ] Define one immutable outcome per Q item: `CANONICALIZED|RAW_QUARANTINED|RAW_REJECTED|RESTRICTED_PROCESSING|SUPPRESSED|NOT_CANONICALIZABLE|EXPIRED_BEFORE_CANONICALIZATION`.
- [ ] Bind CANONICALIZED to CanonicalCompany UUID, IdentityLink UUID and A Raw→Canonical relation; terminal outcomes forbid those fields.
- [ ] Implement in a strictly later migration/PR. Do not modify Q-TX migrations.

## Task 7: Temporal replay, HOLD removal and evidence

- [ ] Replay pre-authority, authority, raw-governance and query-receipt workflow histories without nondeterminism.
- [ ] Prove Activity completion ACK loss returns via normalized preflight with zero Provider calls.
- [ ] Prove APPLIED/REPLAYED mixed batch, old ACK without relation and unknown physical state fail closed without second wire.
- [ ] Only after Q-TX, C-TX and replay pass, create a separate reviewed change to remove `DISCOVERY_GOVERNED_LINEAGE_NOT_READY`.
- [ ] Generate RuntimeEvidence only after exact image/migration/runtime readback; local PG and unit tests are not RuntimeEvidence.

## Final G3 Gate

- Fresh and upgrade PostgreSQL apply all migrations in order; earlier checksums unchanged.
- API build/lint, changed-scope coverage ≥80%, governance/docs, fresh ContractGraph and secret/error-leak review pass.
- QueryReceipt/Raw/B items/A relations/Domain ACK/UsageLedger are one commit boundary.
- REPLAYED and preflight paths perform zero writes and zero Provider adapter calls.
- No unsupported adapter produces partial governed facts; overall Discovery remains HOLD until all required providers and C-TX are complete.
- No push, merge, retained migration, deploy, service restart or real Provider/model call is implied by local completion.
