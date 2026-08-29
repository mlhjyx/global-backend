# Governed Subject Relation Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 current-main Execution Authority、Tool operation 与 Domain ACK 增加产品中立、append-only、可 exact replay/attest/DSR tombstone 的 GovernedSubject relation substrate。

**Architecture:** 三条严格递增、只追加且提交后永不改写的 migration依次提供 schema、append/attest、tombstone；纯 repository/types包装三个 SQL函数。它不理解 Discovery、Raw、Identity、Canonical或Provider，不注册Nest/Worker/Workflow，不改变readiness。

**Tech Stack:** PostgreSQL 16、Prisma 6、TypeScript 5.9、Vitest、真 PostgreSQL/RLS/concurrency测试。

**Spec:** [`ADR-025`](../../adr/registry.md)、[`current status`](../../status/current.md) 与 Program A current-main audit at `f1915d2ef22bba4ae26fc456531ed3a9405f0413`。

## Global Constraints

- Exact base/worktree: `main@f1915d2ef22bba4ae26fc456531ed3a9405f0413`, `codex/production-parity-generic-relation-successor`.
- Proposed migrations after live inventory proves names unused: `20260830120000_governed_subject_relation_schema`, `20260830121000_governed_subject_relation_append_attest`, `20260830122000_governed_subject_relation_tombstone`. Each task may only add its new migration; no later task edits an earlier migration.
- Never base/cherry-pick from the non-deployable mega-branch; provenance may inform newly written RED cases only.
- Forbidden production ownership: Discovery routes, Provider/producer mapping, RawSourceRecord/raw_source_record, IdentityLink/identity_link, CanonicalCompany/Contact and Opportunity.
- No Activity/Workflow/Worker/Relay/Nest/OpenAPI/readiness/runtime/deploy wiring; `DISCOVERY_GOVERNED_LINEAGE_NOT_READY` remains unchanged.
- TDD per task, changed scope ≥80% statements/branches, true PG/RLS for SQL, separate commits and independent review 0 C/H/M.

---

## Locked machine contract

- `governed_subject`: DB-generated UUID PK; `workspace_id`; `subject_type` lower-safe namespace `^[a-z][a-z0-9_.]{0,190}$`; caller UUID `subject_id`; `data_class=NON_PERSONAL|PERSONAL`; bounded `dsr_subject_type` matched dynamically to `deletion_request.subject_type` rather than an A-owned contact/company allowlist; optional `dsr_subject_id`; created_at. Unique `(workspace_id,subject_type,subject_id)` and `(workspace_id,id)`. PERSONAL requires both DSR fields; NON_PERSONAL forbids them.
- `tool_operation_subject`: one and only one row per `(workspace_id,operation_id)`; FK subject to `governed_subject`; exact authority/account/operation/generation/root subject/ACK/result digest; operation subject identity is namespace `tool_operation`, caller identity `operation_id`.
- `governed_subject_relation`: DB-generated UUID; exact workspace/authority/account/operation/generation/ACK; operation subject, parent, child; `relation_key` lower-safe max 200 unique within `(workspace_id,operation_id)`; kind `MATERIALIZED_CHILD|DERIVED_FROM`; `source_ref_namespace` lower-safe max 64 plus either UUID or lowercase SHA-256, never arbitrary text/JSON; lowercase 64-char `contract_sha256`; created_at.
- Tombstone key is `(workspace_id,governed_subject_id)`; audit key is deletion-request UUID. Same request/same subject=`REPLAYED`; same request/different subject=`CONFLICT`; new valid request/same subject=`AUDIT_APPENDED_WITH_EXISTING_FENCE`; first tombstoned_at never changes.
- Root cardinality is exactly one ToolOperationSubject per physical operation. Subject/relation IDs are DB-generated; caller controls only canonical business UUID and relation key. Exact replay tuple includes every authority/account/generation/operation/ACK/result/root/parent/child/relation-kind/source/contract field; any drift conflicts.
- Operation root constants are mandatory and independently revalidated: `root_subject_type=tool_operation`, `root_subject_id=operation_id`, `root_data_class=NON_PERSONAL`, `root_dsr_subject_type=NULL`, `root_dsr_subject_id=NULL`. Any caller drift is `GOVERNED_OPERATION_SUBJECT_INVALID`; negative TS/PG golden vectors cover every field.
- Graph root is the operation subject. Parent must be root or reachable from root within the same operation. Bounds: max depth 64, max 4096 subjects and 8192 relations per operation; boundary+1 fails before write under bounded statement timeout. Reject self-edge and any edge creating a cycle.
- `append_workspace_governed_child_relation_v1` accepts the complete tuple above and returns operation_subject_id, parent_subject_id, child_subject_id, relation_id, replay=false|true. `attest_workspace_governed_child_relation_v1` accepts the same exact tuple and returns the same IDs with replay=true without writes. `tombstone_workspace_governed_subject_v1` accepts workspace_id, governed_subject_id, deletion_request_id and returns fence/audit outcome.
- For an already SETTLED operation with exact receipt/result binding, natural authority expiry and later account exhausted/closed do not block historical append or attest; neither function reopens/increments account, reserves, settles or changes ref_count. Explicit authority revocation and any governed/artifact DSR tombstone block append/attest.
- Program A never creates/updates Domain ACK. Program B uses the existing same-transaction ACK wrapper: APPLIED callback writes B mapping/outcome then calls append; REPLAYED callback performs read-only B/A attest; UNRECEIPTED cannot create governed relations. ACK, B rows and A relation commit/rollback together; relation failure leaves no ACK row. Historical ACK-with-missing-relation is classified as integrity incident/HOLD and is never silently backfilled on replay.
- Source refs reject URL/email/name/prompt/response/control characters/Unicode confusables and any JSON. Repository input/result objects are closed, frozen and reject proxy/accessor/symbol/extra fields.
- Append/attest reject any tombstoned root, parent, intermediate path node or child. All PERSONAL subjects involved in a tuple/path acquire the existing DSR advisory-lock namespace in sorted `(workspace_id,dsr_subject_type,dsr_subject_id)` order before graph locks to prevent deadlock.
- Stable public errors: `GOVERNED_OPERATION_SUBJECT_INVALID`, `GOVERNED_SUBJECT_INVALID`, `GOVERNED_SUBJECT_RELATION_INVALID`, `GOVERNED_SUBJECT_RELATION_CONFLICT`, `GOVERNED_SUBJECT_TOMBSTONED`, `GOVERNED_SUBJECT_AUTHORITY_REVOKED`, `GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE`.

Exact SQL signatures are locked; nullable source/DSR members are SQL NULLs, never JSON/tag strings:

```sql
append_workspace_governed_child_relation_v1(
  p_workspace_id uuid, p_authority_id uuid, p_account_id uuid,
  p_operation_id uuid, p_operation_generation integer,
  p_ack_id char(64), p_result_digest char(64),
  p_root_subject_type varchar(191), p_root_subject_id uuid,
  p_root_data_class varchar(16), p_root_dsr_subject_type varchar(191),
  p_root_dsr_subject_id uuid, p_parent_governed_subject_id uuid,
  p_child_subject_type varchar(191), p_child_subject_id uuid,
  p_child_data_class varchar(16), p_child_dsr_subject_type varchar(191),
  p_child_dsr_subject_id uuid, p_relation_key varchar(200),
  p_relation_kind varchar(32), p_source_ref_namespace varchar(64),
  p_source_ref_uuid uuid, p_source_ref_sha256 char(64),
  p_contract_sha256 char(64)
) RETURNS TABLE(operation_subject_id uuid, parent_subject_id uuid,
  child_subject_id uuid, relation_id uuid, replay boolean);

attest_workspace_governed_child_relation_v1(
  -- identical 24 parameters in identical order
) RETURNS TABLE(operation_subject_id uuid, parent_subject_id uuid,
  child_subject_id uuid, relation_id uuid, replay boolean);

tombstone_workspace_governed_subject_v1(
  p_workspace_id uuid, p_governed_subject_id uuid,
  p_deletion_request_id uuid
) RETURNS TABLE(governed_subject_id uuid, tombstoned_at timestamptz,
  audit_id uuid, outcome varchar(48));
```

TS inputs are closed `Readonly` camelCase projections of every parameter; sourceRef is exactly `{namespace,uuid,sha256}` with exactly one of uuid/sha256 non-null. Append/attest result is the five returned fields; tombstone result is the four returned fields. Parent NULL means the operation subject; otherwise pass an existing governed subject ID reachable from that root. Root/child rows resolve by `(workspaceId,subjectType,subjectId)` and DB-generate internal IDs. Append resolves exactly one root, operation subject, child and relation; replay resubmits all fields.

FK/check matrix: subject composite uniques above; tool-operation-subject FKs `(workspace_id,subject_id)` and root to governed subject, unique `(workspace_id,operation_id)` and `(workspace_id,operation_generation,subject_id)`; relation FKs for operation subject, parent and child, unique `(workspace_id,operation_id,relation_key)`. Authority/account/operation use current composite scope FKs where available; ACK linkage uses exact SQL row-lock/assert against `execution_domain_ack`. Golden vectors lock parameter order, NULL union, returned columns and conflict tuple.

Attest is declared VOLATILE because it takes fixed advisory xact locks for tombstone linearization, but is persistently read-only: no INSERT/UPDATE/DELETE, sequences, ACK/ref-count changes or subject/relation/audit creation. It must not be labeled STABLE.

Access matrix: `PUBLIC`, platform writer and runtime API/Worker/Relay group roles have no table privilege or internal-helper EXECUTE. `app_user` gets EXECUTE only on the three public functions, not direct table SELECT/WRITE. Helpers are owner-only. Tombstoned identity therefore cannot leak via direct SELECT. Artifact fences match only the current PERSONAL `(workspace_id,dsr_subject_type,dsr_subject_id)`; unrelated fences and NON_PERSONAL subjects never block.

### Task 1: Add product-neutral append-only schema and ACL/RLS

**Files:**
- Create: `packages/db/prisma/migrations/20260830120000_governed_subject_relation_schema/migration.sql`
- Modify: `packages/db/prisma/schema.prisma`
- Create: `apps/api/src/execution-budget/governed-subject-relation.migration.spec.ts`
- Create: `packages/db/test/governed-subject-relation.rls.spec.mjs`

Create the five locked-contract tables with no business-table FK. Apply FORCE RLS, public-function-only app access, explicit REVOKE, append-only update/delete denial, workspace composite keys and indexes supporting operation root, relation-key uniqueness, reachability and tombstone lookup.

- [ ] Write RED static and true-PG tests only for absent tables/models/constraints/RLS/ACL, forbidden business ownership, fresh/upgrade parity, cross-workspace and append-only rules. Append/attest function RED belongs exclusively to Task 2; tombstone function RED belongs exclusively to Task 3.
- [ ] Run RED and preserve failure evidence.
- [ ] Implement additive schema only; no production caller.
- [ ] Run Prisma validate/generate, fresh migration deploy, schema diff 0 and true PG/RLS GREEN.
- [ ] Commit `feat: add governed subject relation schema`; independent DB/security review.

### Task 2: Implement append and read-only attest repository

**Files:**
- Create: `apps/api/src/execution-budget/governed-subject-relation.types.ts`
- Create: `apps/api/src/execution-budget/governed-subject-relation.repository.ts`
- Create: corresponding specs
- Create: `packages/db/prisma/migrations/20260830121000_governed_subject_relation_append_attest/migration.sql`; never modify Task 1 migration.

Public functions are `append_workspace_governed_child_relation_v1` and `attest_workspace_governed_child_relation_v1`; repository methods are `appendChildRelationV1(tx,input)` and `attestChildRelationV1(tx,input)`.

Implement the locked complete signatures and expiry/ACK/graph semantics. Attest is VOLATILE only for advisory locks and persistently read-only; it cannot insert, update, delete, use sequences, lock rows for mutation or change ref_count. Add TS↔SQL golden vectors for the full tuple/result and every stable error.

- [ ] RED closed-input/result parser/repository tests and true-PG append/replay/conflict/graph tests.
- [ ] GREEN minimal SQL/repository without `@Injectable()` or module registration.
- [ ] Prove 100 repeated attest calls change no rows, ref-count, ACK, subjects, relations or audits.
- [ ] Run coverage/build/lint/PG/RLS; commit `feat: add governed relation append and attest`; independent review.

### Task 3: Add DSR tombstone and append/tombstone linearization

**Files:** Create `packages/db/prisma/migrations/20260830122000_governed_subject_relation_tombstone/migration.sql`; never modify Tasks 1–2 migrations.

Public function is `tombstone_workspace_governed_subject_v1`; repository method is `tombstoneSubjectV1(tx,input)`.

PERSONAL requires exact dynamic DSR ref; NON_PERSONAL forbids it. Validate deletion_request workspace/type/id by exact equality; use the same artifact DSR advisory-lock namespace and canonical multi-subject order. Enforce the three locked replay outcomes, append-vs-tombstone linearization, path-wide tombstone rejection and no post-tombstone identity leakage. No deletion Activity wiring.

- [ ] RED true-PG DSR identity, the three replay outcomes, dual-PERSONAL/opposite-edge concurrency, deep path tombstone, ACL/RLS and append/tombstone races.
- [ ] GREEN SQL/repository and stable errors without SQL/PII leakage.
- [ ] Run authority/Domain ACK/artifact tombstone/personal cleanup regressions and coverage.
- [ ] Commit `feat: add governed subject tombstone primitive`; independent review.

### Final substrate gate

- Fresh/upgrade PG parity applies the three new migrations in order to disposable databases and proves earlier migration checksums unchanged; Prisma validate/generate and authority/ACK/DSR regressions pass.
- SECURITY DEFINER tests require fixed `search_path=pg_catalog,public`, temp shadow rejection, no direct table/internal-helper write/execute, no SET ROLE/membership/platform-writer confusion, exact API/Worker/Relay grants and bounded non-leaking SQLSTATE/errors.
- Graph tests cover depth/subject/edge boundary and boundary+1, recursive CTE cycle guard, opposite-direction concurrent edges, statement timeout and index-backed bounded execution.
- API build/lint, governance/docs, fresh ContractGraph status/impact, secret/PII/error review and diff check.
- Prove no forbidden Program B business tokens or runtime callsites in the cumulative diff.
- Completion means generic substrate only. Program B separately owns QueryReceipt/Raw/outcome transactions and integration; Workflow remains HOLD until that integration and Temporal replay pass.
