# Discovery Company Materialization C-TX Implementation Plan

> Status: PLANNED / HOLD_IMPLEMENTATION
>
> Authority baseline: `90f005de6cb945a05632a079c00d53a994c33855`
>
> This is a strictly later successor to governed Discovery Q-TX. It must not
> modify migrations `20260830130000`, `20260830130100` or
> `20260830130200`. It does not authorize push, merge, retained migration,
> deployment, service restart, Provider dispatch or RuntimeEvidence.

## 1. Goal and non-goals

C-TX makes Canonical company materialization a durable, resumable and read-only
attestable consequence of already-settled Q-TX facts. It owns:

- deterministic Raw-to-Canonical materialization;
- exact IdentityLink and initial Raw-backed FieldEvidence writes;
- A-owned Raw-to-Canonical governed relations;
- one immutable outcome per Q item;
- bounded batch progress, query completion and run completion receipts;
- byte-identical response-loss readback.

C-TX does not change Provider routing, Q-TX, Raw writer, paid-call authorization,
Temporal Workflow commands or customer billing. It performs no external or model
call. It does not backfill ambiguous history, silently choose duplicate identities,
or remove `DISCOVERY_GOVERNED_LINEAGE_NOT_READY`.

## 2. Confirmed gaps in the legacy materializer

Current `canonicalizeRun()` remains the legacy fallback, but is not C-TX because:

1. it scans current Raw rows instead of Q item causality;
2. terminal branches leave no durable result;
3. response loss changes `{companies,suppressed}`;
4. IdentityLink has no company identity uniqueness and uses `findFirst -> create`;
5. multiple Raw rows can merge from stale Canonical bytes;
6. Raw is not locked against retention/disposition before writes;
7. merge order is implicit;
8. Canonical status lacks a database CHECK.

Existing authoritative facts remain:

- `CanonicalCompany(workspace_id,dedupe_key)` is the company identity root;
- the existing workspace suppression advisory lock is the only suppression lock;
- Raw restrictive RLS and restricted-processing triggers remain defense in depth;
- Raw-backed FieldEvidence already has a suitable uniqueness key and must use
  exact insert/readback, never `skipDuplicates`;
- retention uses Raw `FOR UPDATE SKIP LOCKED`, so C-TX must lock the same rows.

## 3. Durable ownership admission

Governed versus legacy ownership is never inferred from current time, process
version or “Q rows happen to exist.” The schema migration adds an immutable,
nullable `DiscoveryRun.materializationContractVersion`. New runs created after
C-TX activation are born with `discovery-company-materialization/v1`; pre-C runs
retain NULL. It cannot be updated after run creation. A durable admission row is
then created before the first materialization write:

Cutover order is fixed: deploy the nullable schema first; existing and in-flight
runs remain NULL; deploy run-creation code that writes the marker atomically with
new DiscoveryRun creation; only then enable C admission. No migration backfills an
existing run marker, including a run with zero legacy materialization writes.

A separate append-only platform singleton
`discovery_company_materialization_activation` closes fail-open writers. It stores
exact contract version/digest and activated time and can be inserted only by the
activation migration. It has no UPDATE/DELETE path and cannot activate a second
version.

Activation occurs only after pausing new runs, draining old API/Workers, deploying
the exact new image and readback of every DiscoveryRun creator. No default is set:
after activation, the DiscoveryRun INSERT trigger requires the caller to provide
exact v1 explicitly. Omitted, NULL or unknown marker is rejected. This deliberately
makes an N-1/forgotten writer fail closed instead of having a default disguise it
as governed while it still runs legacy canonicalization. Existing NULL rows remain
unchanged and updateable only with NULL staying NULL.

The marker allowlist is exactly NULL or `discovery-company-materialization/v1`
before activation and v1-only on new inserts after activation. A BEFORE UPDATE
trigger rejects any marker change while allowing normal status/stats updates. The
owner is subject to the same trigger.

```text
discovery_company_materialization_admission
  admission_id uuid
  workspace_id
  run_id
  mode = GOVERNED_C_TX | LEGACY
  reason_code
  q_contract_sha256 nullable
  created_at
```

Admission is append-only and one row per run.

`GOVERNED_C_TX` requires:

- the run-owned marker is exactly `discovery-company-materialization/v1`;
- activation singleton ID/version/digest are present and exact;
- exact plan-query ordinal set equals Q receipt set;
- every Q receipt has its v2 Q execution outcome;
- Q item/provider lineage is complete;
- no C state exists;
- no Q-item Raw already has pre-C legacy company IdentityLink or Raw-backed
  FieldEvidence contribution.

`LEGACY` is recorded when:

- the run marker is NULL/pre-C; and
- all C tables are still empty for the run.

NULL/pre-C marker is sufficient and authoritative even if legacy canonicalization
previously produced zero rows (zero items, suppression, invalid payload or other
terminal behavior). C admission does not try to infer whether that old Activity
already ran. It preserves LEGACY behavior either way.

Any governed-marked run with a missing Q receipt, Q v2 outcome or Q item is HOLD,
never LEGACY. Any admission/marker/C-state conflict is HOLD. A run admitted
LEGACY never writes C state. A run admitted C-TX never falls back per item.

This closes the deployment window where Q-TX is live before C-TX: old runs have a
NULL marker and remain LEGACY even when Q facts exist. C-TX does not promise a
byte-identical LEGACY summary or bypass the existing legacy BudgetStore freshness
behavior; it preserves the old behavior without adding C backfill. Byte-identical
response-loss guarantees apply only to governed-marked runs.

The eligibility set is derived only from plan ordinals, Q v2 receipts/items and
their declared company Provider lineage. It does not scan generalized run Raw
rows, so auxiliary crawl/robots/tool Raw cannot create false legacy admission.

## 4. Locked outcome contract

Every Q item has exactly one outcome:

```text
CANONICALIZED
RAW_QUARANTINED
RAW_REJECTED
RESTRICTED_PROCESSING
SUPPRESSED
NOT_CANONICALIZABLE
EXPIRED_BEFORE_CANONICALIZATION
```

Outcome precedence is fixed:

1. exact existing C state: attest it, never recompute;
2. Q-time QUARANTINED: `RAW_QUARANTINED`;
3. Q-time REJECTED: `RAW_REJECTED`;
4. permanent restricted-processing disposition: `RESTRICTED_PROCESSING`;
5. suppression match under the shared lock: `SUPPRESSED`;
6. exact reusable CanonicalCompany + company IdentityLink, with no item C partial:
   `CANONICALIZED/REUSED`;
7. current EXPIRED: `EXPIRED_BEFORE_CANONICALIZATION`;
8. closed company parser/identity failure: `NOT_CANONICALIZABLE`;
9. otherwise: `CANONICALIZED`.

Q-time terminal status precedes later governance/expiry because it was already
causally terminal in Q-TX. For a Q-time eligible item, permanent restriction and
suppression precede reuse/expiry so durable compliance decisions are not erased by
retention. An exact reusable link may be recorded after expiry without reading the
erased payload, but only when it passed restriction/suppression and no item C
partial exists. Mutation tests swap every adjacent priority and must fail.

If Raw payload or current FieldEvidence is unavailable, REUSED is allowed only by
copying the evidence manifest from an existing exact C outcome with the same
workspace, Raw UUID, IdentityLink UUID, CanonicalCompany UUID, contract and a
covering committed batch receipt. A different identity/canonical cannot lend a
manifest. Without such prior C outcome, an expired Raw becomes
`EXPIRED_BEFORE_CANONICALIZATION`; no implementation may invent
`evidenceCount=0`.

### 4.1 Common outcome columns

All outcome rows require:

- complete Q item identity, including item UUID, query/provider/index, operation,
  Raw UUID, Q Raw governed subject UUID and Q relation UUID;
- outcome, contract digest and created time;
- `rawGovernedSubjectId` always non-null, including terminal rows;
- initial FieldEvidence manifest count/digest for CANONICALIZED, otherwise NULL.

### 4.2 CANONICALIZED columns

Required:

- CanonicalCompany UUID;
- IdentityLink UUID and `identityCanonicalType=company`;
- Canonical governed subject UUID;
- C A-relation ID and key;
- match rule and confidence;
- mutation class `CREATED | UPDATED | LINKED | REUSED`;
- `evidenceCount >= 0` and `evidenceManifestSha256`.

All terminal-provenance columns are NULL.

Company match rule is restricted to `domain_exact | identifier_exact |
name_country`. Confidence is a finite PostgreSQL double precision value in
`0..1`; NaN and positive/negative infinity are rejected. Outcome match/confidence
must equal the exact IdentityLink row.

### 4.3 Terminal provenance matrix

Exact columns:

```text
restrictedDispositionId       uuid nullable
suppressionMatchSha256        char(64) nullable
suppressionMatchCount         integer nullable
rawExpiredAt                  timestamptz nullable
notCanonicalizableReasonCode  varchar(64) nullable
```

Matrix:

- `RESTRICTED_PROCESSING`: disposition ID required; all other terminal columns NULL.
- `SUPPRESSED`: digest + count required, count `1..64`; all others NULL.
- `EXPIRED_BEFORE_CANONICALIZATION`: expiredAt required; all others NULL.
- `NOT_CANONICALIZABLE`: closed reason required; all others NULL.
- `RAW_QUARANTINED` / `RAW_REJECTED`: all terminal-provenance columns NULL.
- `CANONICALIZED`: all terminal-provenance columns NULL.

Every terminal row requires all Canonical/Identity/C-relation/mutation/match/evidence
fields NULL, but retains the common Raw governed subject identity.

Suppression representation is locked to digest + count, not JSON or an optional
UUID array. The digest is SHA-256 of canonical JSON containing sorted suppression
record UUIDs only. No type, value, reason or user text is stored. Append validates
the current append-only UUID set under the suppression lock; attest validates the
stored digest/count without exposing values.

Restricted disposition gets an exact composite FK after adding
`UNIQUE(workspace_id,id,raw_record_id)` to its source table.

## 5. Five-layer additive state model

Use strictly later migrations:

```text
20260830130300_discovery_company_materialization_schema
20260830130400_discovery_company_materialization_functions
20260830130500_discovery_company_materialization_activation
```

Numbers may advance with main, but earlier migrations remain byte-identical.
The activation migration is deployed only after the controlled drain/image/creator
readback gate; it inserts the singleton activation fact and never backfills runs.

Activation is a separate later commit/release bundle, not merely the third pending
migration in the first artifact. Release A contains schema/functions and the new
explicit-marker image but no activation row. After pause, drain and exact image +
creator readback, Release B contains only the activation migration/fence and is
applied/read back before resuming runs. Ordinary `prisma migrate deploy` must not
see activation pending during Release A.

### 5.0 Platform activation singleton

`discovery_company_materialization_activation` has `activation_id SMALLINT`
fixed to 1 as PK, exact contract version, exact lowercase contract SHA-256 and
activated time. It admits only the v1 row, has no DELETE/UPDATE grant, and an owner
immutable trigger rejects mutation. A second row/version is impossible. The
DiscoveryRun INSERT guard reads this row: absent means pre-activation marker rules;
present means every new run must explicitly supply exact v1.

### 5.1 Run admission

`discovery_company_materialization_admission` stores the immutable LEGACY/C-TX
ownership decision described in section 3. Exact keys:

- `admission_id UUID` primary key;
- unique `(workspace_id,admission_id)`;
- unique `(workspace_id,run_id)`;
- unique `(workspace_id,admission_id,run_id)`;
- composite FK `(workspace_id,run_id)` to DiscoveryRun;
- copied run contract marker, mode, closed reason, contract digest and created time;
- every FK is `ON UPDATE RESTRICT ON DELETE RESTRICT`.

Same-row matrix:

- GOVERNED_C_TX: copied marker v1, reason `GOVERNED_Q_V2_COMPLETE`, exact lowercase
  Q contract SHA-256 required;
- LEGACY: copied marker NULL, reason `PRE_C_NULL_MARKER`, Q contract digest NULL;
- every other mode/reason/marker/digest combination is rejected by CHECK and admit.

### 5.2 Item outcome

`discovery_company_materialization_outcome` has:

- PK `(workspace_id,query_item_id)`;
- unique `(workspace_id,run_id,query_key,provider_key,record_index)`;
- non-null `admission_id` and `batch_ordinal`;
- exact composite FK to the full Q item tuple;
- composite FK `(workspace_id,admission_id,run_id)` to the same-run admission;
- deferred composite FK `(workspace_id,run_id,query_key,batch_ordinal)` to
  the covering batch receipt, `DEFERRABLE INITIALLY DEFERRED` because the receipt
  is inserted last;
- exact Canonical, IdentityLink, governed-subject and A-relation bindings;
- the CANONICALIZED/terminal CHECK matrix.

### 5.3 Batch receipt

`discovery_company_materialization_batch_receipt` proves one deterministic query
batch committed atomically:

- workspace/run/query, batch ordinal;
- first/last sorted item key;
- expected item count and item-set digest;
- seven outcome counts;
- four mutation counts;
- evidence manifest aggregate digest/count;
- contract digest and created time.

PK is `(workspace_id,run_id,query_key,batch_ordinal)`. A batch receipt and its exact
outcome set are one transaction. Outcomes without the covering receipt, a receipt
with missing/extra outcomes, or overlapping/non-canonical ranges are HOLD.

Batch membership is database-derived from Q items sorted by
`provider_key,record_index,raw_record_id,item_id`, with fixed size 128:

```text
batchOrdinal = floor(zeroBasedSortedPosition / 128)
```

Only the smallest missing batch may append. Fully committed earlier batches are
legal `PARTIAL_RESUMABLE`, not an integrity violation.

Each batch row carries `admission_id` and has a RESTRICT composite FK
`(workspace_id,admission_id,run_id)` to the same-run admission plus a FK to the
exact Q receipt. Outcome commit without a matching receipt, wrong batch ordinal,
overlapping range or item-set digest drift fails at transaction commit/HOLD.

### 5.4 Query completion receipt

`discovery_company_materialization_query_receipt` is inserted after all expected
batches are exact. Exact columns:

```text
workspace_id, run_id, query_key
batch_count, item_count
outcome_canonicalized_count
outcome_raw_quarantined_count
outcome_raw_rejected_count
outcome_restricted_processing_count
outcome_suppressed_count
outcome_not_canonicalizable_count
outcome_expired_before_canonicalization_count
mutation_created_count
mutation_updated_count
mutation_linked_count
mutation_reused_count
companies_count
contract_sha256, created_at
```

Same-row CHECKs:

- seven outcome counts sum to item count;
- four mutation counts sum to canonicalized count;
- companies count equals created + updated;
- batch count matches the deterministic item-count partition;
- zero items require batch count zero and all counts zero.

Suppressed Activity output is `outcome_suppressed_count`; there is no duplicate
`suppressed_count` column.

The query receipt carries `admission_id` and has a RESTRICT composite FK
`(workspace_id,admission_id,run_id)` to the same-run admission plus the exact Q
receipt FK.

### 5.5 Run completion receipt

`discovery_company_materialization_run_receipt` is the sole governed Activity
completion authority:

- workspace/run and admission ID;
- expected and completed query counts;
- total batches/items;
- summed query counts and frozen `{companies,suppressed}`;
- ordered query-header-set digest;
- contract digest and created time.

It is inserted only when the exact plan ordinal set equals the exact Q receipt set
and exact C query header set. Missing headers are `PARTIAL_RESUMABLE`; extra or
conflicting headers are HOLD. Response-loss preflight returns only from this run
receipt.

The run receipt has a RESTRICT composite FK
`(workspace_id,admission_id,run_id)` to the same-run admission and a separate
`(workspace_id,run_id)` FK to DiscoveryRun. All subordinate rows use the same
triple; cross-run admission composition is structurally impossible, not merely
rejected by functions.

### 5.6 RLS and immutability

All five workspace C tables use FORCE RLS with the established workspace policy. `app_user`
receives SELECT only; PUBLIC/platform/runtime roles receive no DML. Exact SECURITY
DEFINER functions get app-user EXECUTE. Owner UPDATE/DELETE triggers fail P0001.
The platform activation singleton contains no tenant/user data, grants runtime
roles no DML and is owner-immutable; only the DiscoveryRun guard reads it.

## 6. Identity and typed-target hardening

Upgrade starts with read-only inventories. Duplicate/multi-target company links,
invalid Canonical status or typed-target corruption are migration HOLD; no row is
deleted or selected as winner.

Add:

- `CanonicalCompany UNIQUE(workspace_id,id)` and supported-status CHECK;
- `IdentityLink UNIQUE(workspace_id,id)`;
- exact composite unique `(workspace_id,id,canonical_type,canonical_id,raw_record_id)`;
- partial unique `(workspace_id,raw_record_id) WHERE canonical_type='company'`;
- CHECK `canonical_type IN ('company','contact')`;
- `RawSourceGovernanceDisposition UNIQUE(workspace_id,id,raw_record_id)`;
- full Q-item composite unique needed by the outcome FK.

The IdentityLink typed-target trigger is fixed:

- BEFORE INSERT, SECURITY DEFINER, fixed `pg_catalog,public` search path;
- `company`: same-workspace CanonicalCompany must exist;
- `contact`: same-workspace CanonicalContact must exist;
- other types fail;
- no dynamic SQL, role change or value-bearing error.

Inventory checks both branches before trigger installation. Existing legacy
company writers must use the same company-Raw identity lock and convert unique
collision into exact readback or `DOMAIN_ACK_DISCOVERY_COMPANY_IDENTITY_CONFLICT`;
Prisma P2002 is not treated as a transient Provider failure.

IdentityLink UPDATE/DELETE is revoked from app runtime roles and rejected for the
owner by an immutable trigger. INSERT remains only through approved legacy/C-TX
boundaries until all company writers migrate.

## 7. A Raw-to-Canonical relation

CANONICALIZED reuses the Q item's physical operation, authority, account, ACK and
result digest:

```text
parentGovernedSubjectId = Q item Raw childSubjectId
childSubjectType        = canonical_company
childSubjectId          = CanonicalCompany UUID
childDataClass          = NON_PERSONAL
relationKind            = DERIVED_FROM
relationKey             = discovery.canonical_company:<recordIndex>
sourceRef.namespace     = discovery_company_materialization_outcome
sourceRef.uuid          = query item UUID
contractSha256          = frozen C relation descriptor
```

Every index has its own relation. Terminal outcomes have no C relation.

REUSED permits an existing exact CanonicalCompany and company IdentityLink only.
The item-specific C relation, outcome and batch receipt must not yet exist and are
created fresh in the current batch. Any pre-existing item C relation without its
exact outcome/batch receipt, outcome without receipt, header without complete
batches, or link+C relation without C outcome is HOLD. C never upgrades partial
state by filling holes.

The Q company Domain ACK means only physical-operation-to-Raw Q materialization.
It is not Canonical readiness and is never overwritten or reinterpreted. C run
receipt is the C completion authority. A future final ACK, if required, needs a
new C-domain ACK identity.

## 8. Lock order and deterministic merge

Exact query lock namespace:

```text
discovery-company-materialization:<workspaceId>:<runId>:<queryKey>
```

Exact run-admission/finalization namespace:

```text
discovery-company-materialization-run:<workspaceId>:<runId>
```

Admission and run finalization take the run lock. Query finalization takes run
then query lock. Batch write takes suppression, then run, then query lock and
holds all three to commit. Run finalize reads immutable query headers and does not
enter query append functions.

Every batch writer uses:

1. existing workspace suppression advisory lock;
2. exact run C advisory lock;
3. exact query C advisory lock;
4. verify every lower query ordinal has an exact finalized query receipt and the
   target is the smallest missing batch ordinal of the current query;
5. Q receipt/items in canonical order;
6. distinct Raw UUIDs `FOR UPDATE` in UUID order;
7. reread status, expiry and disposition;
8. derive/sort dedupe keys and acquire identity advisory locks;
9. Canonical rows `FOR UPDATE` or unique insert;
10. exact IdentityLink and FieldEvidence writes;
11. A relations in `(operationId,relationKey)` order;
12. item outcomes;
13. batch receipt last.

The run lock makes same-run query order deterministic rather than scheduler-first.
A later query cannot commit while any earlier query/batch is incomplete; it
returns resumable wait with zero writes. Opposite-start tests must produce the
same Canonical bytes, version, mutation counts and run summary. Cross-run sharing
is serialized by sorted Raw/identity/Canonical locks and follows real transaction
commit order; this is distinct from the fixed within-run order. Retention and
disposition linearize on Raw; suppression uses the shared existing namespace.

The global work cursor includes query finalization: after a query's last batch,
`FINALIZE_QUERY(queryOrdinal)` is the next required work unit. No batch from a
higher query ordinal may start until that immutable query header exists and
attests. Thus an ACK loss after the last batch resumes query finalization before
any later query materialization.

Merge rules:

- process canonical Q order only;
- recompute from latest locked Canonical bytes;
- existing non-null scalar wins; first deterministic valid item fills null;
- region follows the same rule, never later overwrite;
- attributes use the existing sanitizer/merge in canonical order;
- version increments only on byte change;
- exact Raw replay does not increment or rewrite.

Mutation counts preserve current observable semantics: `companies = CREATED +
UPDATED`; `suppressed = SUPPRESSED item outcomes`.

## 9. Single business implementation and evidence manifest

Governed C uses a two-stage interface inside one outer workspace transaction per
batch. Batches do not share a long database transaction; each committed batch is
independently exact and covered by its receipt:

1. a pure TypeScript candidate builder validates closed input shape only;
2. a SECURITY DEFINER batch-facts function derives the Raw set from the exact Q
   batch, takes suppression -> run -> query -> Raw locks, enforces the globally
   smallest missing batch plus exact finalized receipts for all earlier queries,
   and rereads disposition/status/expiry;
3. it returns payload only for allowed items and value-free terminal facts for
   restricted/quarantined/rejected/expired items;
4. repository reads suppression/Canonical under the already-held locks;
5. the existing official TypeScript product-provenance, identity, sanitizer and
   merge functions produce the final write plan from those locked facts;
6. Prisma writes CanonicalCompany, IdentityLink and FieldEvidence;
7. SQL batch function validates the exact already-written database facts, calls
   A append and writes outcomes + batch receipt.

SQL does not reimplement company parsing, identity or attribute merge. TypeScript
does not synthesize RLS, FK, ACK/A or batch-completeness facts. The SQL function
validates the locked Raw status/disposition, exact IDs/digests and C shape before
commit.

The batch-facts boundary is:

```text
lock_discovery_company_materialization_batch_facts_v1(
  admissionId, workspaceId, runId, queryKey, batchOrdinal
)
```

It is SECURITY DEFINER with fixed `pg_catalog,public` search path, exact app-user
caller/workspace checks and no dynamic SQL/role changes. The caller cannot submit
Raw IDs, statuses, dispositions or payload. The function derives the canonical
batch from Q rows, locks every Raw UUID in order including rows hidden by
restrictive RLS, and validates the full Q-item tuple. Restricted items return only
disposition ID/status/hash metadata; their payload is never returned. Allowed
items return only the bounded Raw product fields required by the official builder.
It runs in the same per-batch outer Prisma transaction as all later writes.

The function is owned by a dedicated
`discovery_materialization_fact_reader NOLOGIN BYPASSRLS` role because FORCE RLS
otherwise hides restricted Raw even from a normal table owner. That role receives
only the SELECT privileges required by this function, owns no business, tenant or
product-state table, owns only the internal no-runtime-ACL transaction-fence table, cannot LOGIN,
is not granted to any runtime role and cannot be reached with SET ROLE. No other
function uses its capability. `app_user` receives EXECUTE on this exact signature
only. Production-like role tests prove direct restricted Raw SELECT returns zero,
the function returns terminal metadata with payload NULL, and capability does not
spread to another function or role.

Batch facts also create an unforgeable transaction fence in the same connection:

```text
discovery_company_materialization_tx_fence
  fence_id uuid
  backend_pid integer
  transaction_id xid8
  admission/workspace/run/query/batch tuple
  snapshot_sha256 char(64)
```

This is an internal no-runtime-ACL table owned by the fact-reader. The facts
function inserts/returns the exact fence ID and digest. A deferred constraint
trigger rejects commit while an unconsumed fence remains. Append-batch requires
and consumes the exact row for `pg_backend_pid()`, `pg_current_xact_id()`, tuple
and snapshot digest. It then revalidates the locked facts. Rollback removes the
fence; facts-only commit fails; another connection/transaction/batch cannot borrow
it; app_user cannot SELECT/INSERT/UPDATE/DELETE it. The append command carries the
returned fence ID/digest but those values alone are not capability outside the
owning transaction.

FieldEvidence is written in the same initial transaction, but legal DSR deletion
must not invalidate historical C replay. Each CANONICALIZED outcome therefore
stores a value-free evidence manifest count/digest. The digest covers sorted
`field + evidence UUID + value digest + provider/license/action digest`; it stores
no value. Append validates the exact evidence set before saving the manifest.
Attest validates the immutable initial evidence snapshot and C facts; it does not
claim that current FieldEvidence rows still exist, nor distinguish authorized DSR
cleanup from later absence. Current-row/authorized-erasure proof would require a
future value-free evidence-member/erasure ledger bound to deletion requests and is
explicitly outside this C receipt. The existing deletion/audit system remains the
authority for cleanup execution, not C replay completeness.

Cross-batch manifest reuse copies the prior immutable count/digest only under the
exact same Raw/Identity/Canonical/contract tuple and covering batch receipt. Tests
expire Raw and delete current evidence after batch 0, then require batch 1 sharing
that Raw to copy the exact manifest. If no prior C outcome exists, the current Raw
is expired and there is no C partial, the result is
`EXPIRED_BEFORE_CANONICALIZATION`. If any candidate prior outcome exists but its
own Q item, Q Raw relation, item-specific C A relation, outcome or covering batch
receipt cannot independently attest, the result is HOLD. Across independently
attested candidates, compare only the shared reuse tuple:
workspace/admission/run, Raw UUID, IdentityLink UUID, CanonicalCompany UUID,
C contract, evidence count and evidence manifest. Item UUID, operation, relation
ID/key, sourceRef and batch receipt are intentionally item-specific and need not
match each other. Multiple candidates may be reused only when the shared tuple and
manifest are identical; any shared-tuple/manifest divergence is HOLD. The new
target item always creates its own C A relation/outcome/batch receipt and never
copies a prior relation identity. Relation/outcome without covering receipt is
partial HOLD. No path fabricates an empty manifest.

## 10. Public database state machine

### 10.1 Admit

```text
admit_discovery_company_materialization_v1(closed run identity)
```

Under the exact run lock it validates caller/workspace/run/plan, the immutable
run-owned contract marker, complete governed Q facts or verified pre-C ownership,
and zero C-state conflicts. It atomically inserts GOVERNED_C_TX or LEGACY.
Exact existing admission is read-only replay; different mode/binding/marker or a
governed-marked run with incomplete Q facts is HOLD. Inspect remains read-only.
The caller supplies identity only and cannot choose mode, reason or Q digest.
The function is SECURITY DEFINER with fixed search path and exact app-user caller
and workspace checks.

For a v1-marked run, missing activation returns stable NOT_ACTIVATED/UNAVAILABLE
with zero admission/C writes and never downgrades to LEGACY. Wrong singleton
version/digest is integrity HOLD. Only exact singleton permits GOVERNED_C_TX. A
NULL pre-C run may still receive LEGACY admission after activation. An admission
already committed against the immutable singleton remains independently
attestable; no environment flag participates.

### 10.2 Lock batch facts

The SECURITY DEFINER `lock_discovery_company_materialization_batch_facts_v1`
implements the RLS-safe lock/snapshot boundary from section 9. It must be the first
Raw/product fact read in a governed batch. While holding suppression -> run ->
query locks it verifies admission, exact finalized query receipts for every lower
ordinal, the canonical batch prefix for the current query and the current smallest
missing batch before it locks Q/Raw and creates the transaction fence.

### 10.3 Inspect

```text
inspect_discovery_company_materialization_v1(identity-only lookup)
```

Returns exactly:

- `NOT_FOUND`: admission exists, no batch/outcome/query/run receipt;
- `PARTIAL_RESUMABLE`: every existing outcome is covered by an exact batch
  receipt, batches form the canonical prefix, completed earlier queries have exact
  headers, and no later query state exists ahead of an unfinalized earlier query;
- `REPLAYED`: exact run receipt and all subordinate facts attest;
- integrity HOLD: orphan, extra, drift, overlap, forbidden relation or header.

It is strictly read-only.

### 10.4 Append one batch

```text
append_discovery_company_materialization_batch_v1(closed batch command)
```

- accepts only the database-derived smallest missing batch;
- requires exact headers for all earlier query ordinals;
- command covers every item in that batch exactly once;
- Canonical/Identity/Evidence/A/outcomes/batch receipt are one transaction;
- existing exact completed batch is read-only attest, never rerun writes;
- non-exact pre-existing state is HOLD;
- never writes query/run completion headers.

### 10.5 Finalize query

```text
finalize_discovery_company_materialization_query_v1(identity-only lookup)
```

Under run then query lock it verifies all earlier query headers, all expected
current-query batches/outcomes, and absence of any later-query state. It recomputes
counts and inserts the immutable query header, advancing the global run cursor.
Exact existing header returns REPLAYED; current final batch complete with no later
state is resumable finalization; partial/drift/ahead-of-cursor state is classified
by inspect as PARTIAL or HOLD.

### 10.6 Finalize run

```text
finalize_discovery_company_materialization_run_v1(run identity)
```

Verifies exact plan/Q/query-header sets, aggregates them in query-ordinal order,
and inserts the run receipt. Exact replay returns the stored summary.

Stable bounded errors:

```text
DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID
DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_CONFLICT
DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_UNAVAILABLE
DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD
DOMAIN_ACK_DISCOVERY_COMPANY_IDENTITY_CONFLICT
```

No SQL, Raw payload, company text, suppression value, evidence value or credential
appears in an error.

## 11. Activity and Temporal compatibility

Public surface remains:

```text
canonicalizeRun(existing input) -> {companies:number,suppressed:number}
```

No Workflow patch or command is added.

Flow:

1. parse execution binding without BudgetStore;
2. load/create durable admission;
3. LEGACY: execute existing implementation and `ensureRunBudget()` unchanged;
4. C-TX: inspect before BudgetStore;
5. REPLAYED: return run receipt summary, zero writes/calls;
6. NOT_FOUND/PARTIAL_RESUMABLE: append the smallest missing batches;
7. finalize each query and then the run;
8. heartbeat between batches; Temporal retry resumes from inspect.

C-TX has no paid call. Natural authority expiry or closed/exhausted account does
not block exact deterministic C work/readback; authority comes from frozen Q/ACK/A
facts. Batch size is fixed at 128 and does not create Workflow history events.

## 12. Implementation tasks

### C1 RED contracts and inventories

- pure candidate builder tests;
- admission/pre-C legacy inventory;
- IdentityLink/typed-target/status conflict inventories;
- seven-status/terminal/mutation/evidence manifest mutation tests;
- batch prefix/orphan/overlap state-machine RED.

### C2 additive schema

- five workspace tables, composite keys, typed-target/immutability/status hardening;
- nullable immutable run marker and platform activation singleton/INSERT guard;
- Prisma models;
- fresh and prior-revision upgrade with earlier checksums unchanged;
- FORCE RLS, ACL, owner immutability and zero-item/run receipts;
- Copy eligibility refresh remains HOLD if schema changes.

### C3 functions and true PostgreSQL

- admit, lock-batch-facts, inspect, append-batch, finalize-query, finalize-run;
- A append/attest only through public A functions;
- concurrency, partial-resume, deadlock, retention/disposition/suppression tests.

### C4 Activity integration

- focused governed C module below 800 lines;
- unchanged legacy fallback and Temporal surface;
- run-receipt preflight before BudgetStore;
- unchanged historical replay fixtures.
- machine-enumerate every DiscoveryRun creator and require explicit v1 marker;
- activation only after drain, exact-image readback and creator mutation tests.

### C5 verification

- API build/lint/full tests and changed-scope line/branch coverage >=80%;
- fresh/upgrade PostgreSQL and concurrency matrices;
- governance/docs, fresh ContractGraph, secret/error review;
- independent DB/security and Activity/Temporal review at 0 C/H/M;
- local commit only; external actions remain separate gates.

## 13. Required acceptance matrix

At minimum:

1. zero-query and zero-item completion;
2. all seven outcomes and terminal NULL matrix;
3. CREATED/UPDATED/LINKED/REUSED summaries;
4. Q-time status versus later expiry priority mutations;
5. restricted/suppressed/expired/not-canonicalizable evidence columns;
6. two indexes same Raw and two Raw same Canonical;
7. exact FieldEvidence manifest and post-DSR replay;
8. same Raw to two Canonicals conflict;
9. C relation only, outcome only, batch only, query header only, run header only;
10. complete batches without query header are PARTIAL_RESUMABLE;
11. orphan/overlap/extra batches are HOLD;
12. query0 complete/query1 partial and exact run aggregation;
13. response-loss returns byte-identical run summary;
14. Q-live/C-not-live legacy materialization retry remains LEGACY;
15. admission/C-state conflicts HOLD;
16. same query two connections: one batch APPLIED, one exact attest;
17. opposite item orders without deadlock;
18. cross-query shared Raw/Canonical locking;
19. suppression/materialization both orders;
20. disposition/materialization both orders;
21. retention/materialization both orders;
22. cross-workspace RLS/ACL/owner immutability;
23. typed company/contact targets and legacy P2002 exact readback;
24. A append failure full batch rollback;
25. A relation missing on inspect/replay HOLD;
26. auxiliary Raw does not affect admission;
27. pre-C NULL marker with or without legacy company artifacts is durable LEGACY;
28. v1 marker with pre-existing non-C company link/evidence is HOLD, never LEGACY;
29. REUSE_BATCH multiple items sharing one Raw;
30. partial batches resume smallest missing batch only;
31. old Temporal histories keep command/input/output sequence;
32. control errors survive Temporal wrapping;
33. governed-marked run missing any Q receipt/item/outcome is HOLD, never LEGACY;
34. pre-C NULL-marker zero-write/terminal ACK-loss retry remains LEGACY;
35. concurrent admit produces one exact admission;
36. restricted-only and allowed+restricted batches return no restricted payload;
37. outcome without deferred covering batch FK fails commit;
38. match-rule allowlist and finite confidence boundaries;
39. activation before/after inserts, immutable old NULL and N-1 writer rejection;
40. activation singleton cannot update/delete/activate a second version;
41. v1 run before activation yields NOT_ACTIVATED and zero C writes;
42. facts fence exact same-transaction append succeeds;
43. missing/new-transaction/other-batch/tampered fence fails and cannot commit;
44. opposite-start cross-query same-dedupe produces identical bytes/counts;
45. manifest missing means EXPIRED while any candidate drift means HOLD;
46. query last-batch ACK loss blocks later query until earlier header finalizes;
47. multiple prior outcomes with distinct valid item A relations share one manifest;
48. prior item A missing/wrong sourceRef is HOLD; new item never copies relation ID;
49. changed-scope coverage >=80%.

## 14. Final gate

C-TX is complete only when:

- every C-owned Q item has one exact outcome and covering batch receipt;
- every query and run has an exact immutable completion receipt;
- legal partial batches are resumable and every illegal partial is HOLD;
- pre-C legacy histories never receive C backfill;
- IdentityLink uniqueness and typed targets are database-enforced;
- retention, disposition and suppression races linearize in both orders;
- response-loss replay uses the run receipt without BudgetStore or writes;
- Canonical/Identity/Evidence/A/outcome/batch share one transaction boundary;
- all earlier Q/A migrations remain byte-identical;
- full verification and independent reviews pass;
- Task 7 replay/evidence still passes before readiness HOLD is removed.
