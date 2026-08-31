# Discovery Lineage G2 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在唯一 Program B writer 上实现三个纯 G2 因果合同，使未来 Activity 可以把每个已结算物理 company operation 精确映射到原始 Provider index 和 Raw UUID，而不接入数据库 materialization 或解锁 Workflow。

**Architecture:** 三个独立切片分别固定 Domain ACK identity、保留 index 的 Raw reconciliation resolution、Provider-owned receipt lineage。它们只产生不可变纯合同和 Provider result metadata；现有 `executeQuery`、Prisma schema、migration、Domain ACK persistence、Canonicalization 和 Temporal v3 全部保持不变。

**Tech Stack:** TypeScript 5.9、Vitest 4、现有 Raw v2 ingestion、DurableExecutionReceipt、ToolBroker/ModelGateway callbacks。

**Spec:** [`ADR-025`](../../adr/registry.md)、[`GPP-B-LINEAGE-001`](../../governance/conflict-register.md)、[`G0 closeout`](2026-08-30-discovery-lineage-g0-closeout.md) 与用户批准的“开发即生产”能力优先计划。

## Global Constraints

- Exact base is `main@f1915d2ef22bba4ae26fc456531ed3a9405f0413`.
- Unique writer/worktree is `codex/discovery-query-materialization-successor` at `/global/backend/.codex/worktrees/discovery-query-materialization-successor`.
- Do not cherry-pick or copy implementation/PASS evidence from `codex/production-parity-capability-cutover@91cae351`; historical tests may only inform newly written RED cases.
- No Prisma/schema/migration/DB/Activity/Workflow/runtime/readiness/deploy/real Provider/model/paid call changes.
- Preserve `DISCOVERY_GOVERNED_LINEAGE_NOT_READY` and every v2 history/callsite.
- Every task uses RED → GREEN → refactor, a separate commit, changed-scope statements and branches at least 80%, and independent review with 0 Critical/High/Medium.

---

### Task 1: Define one strict v3 company Domain ACK identity

**Files:**
- Create: `apps/api/src/discovery/discovery-company-domain-ack.ts`
- Create: `apps/api/src/discovery/discovery-company-domain-ack.spec.ts`
- Test: `apps/api/src/durable-results/domain-ack.spec.ts`

**Interfaces:**

```ts
export const DISCOVERY_COMPANY_DOMAIN_ACK_INVALID =
  'DISCOVERY_COMPANY_DOMAIN_ACK_INVALID' as const;

export type DiscoveryCompanyDomainAckIdentity = Readonly<{
  domainAckKey: string;
  domainRevision: string;
}>;

export function discoveryCompanyDomainAckIdentity(input: Readonly<{
  runId: string;
  providerKey: string;
  operationId: string;
  resultDigest: string;
}>): DiscoveryCompanyDomainAckIdentity;
```

- [ ] Write RED tests for exact output `runId:providerKey:operationId` plus raw result digest; reject extra/missing/accessor/proxy keys, non-UUID IDs, provider keys outside `^[a-z][a-z0-9_]{0,63}$`, and non-lowercase SHA-256. Feed output through `DomainAckService` and prove exactly one opacity hash. Prove `discovery.activities.ts` does not import the helper.
- [ ] Run `pnpm --filter @global/api exec vitest run src/discovery/discovery-company-domain-ack.spec.ts src/durable-results/domain-ack.spec.ts`; expect missing-module RED.
- [ ] Implement a descriptor-based closed parser returning a frozen new object. Do not hash inside the helper; `DomainAckService` remains the only hashing authority.
- [ ] Run GREEN with coverage include for the new file; require statements/branches ≥80%; run API build and scoped lint.
- [ ] Commit `feat: define discovery company ack identity` and obtain independent review.

### Task 2: Preserve every original Provider index through Raw reconciliation

**Files:**
- Modify: `apps/api/src/discovery/raw-source-ingestion.ts`
- Modify: `apps/api/src/discovery/raw-source-ingestion.spec.ts`
- Test: `apps/api/src/discovery/provider-raw-boundary.integration.spec.ts`

**Interfaces:**

```ts
export type RawSourceIndexedResolution =
  | Readonly<{ recordIndex: number; kind: 'WRITE'; row: PreparedRawSourceRow }>
  | Readonly<{ recordIndex: number; kind: 'EXISTING'; rawRecordId: string }>
  | Readonly<{ recordIndex: number; kind: 'REUSE_BATCH'; sourceRecordIndex: number }>;

export function resolveRawSourceBatchByIndex(
  prepared: readonly PreparedRawSourceRow[],
  existing: readonly ExistingRawSourceReceipt[],
): readonly RawSourceIndexedResolution[];
```

- [ ] Write RED table tests: new row, existing exact UUID, intra-batch duplicate, external-ID drift quarantine, repeated drift, accepted/quarantined/rejected order, invalid/duplicate existing receipts, and `REUSE_BATCH.sourceRecordIndex < recordIndex`.
- [ ] Run focused RED; expect missing export.
- [ ] Implement without changing `reconcileRawSourceBatch()` or Activity callsites. Return exactly one frozen resolution per original input index; never infer from names/URLs/external text.
- [ ] Run old/new Raw regression, provider boundary integration and changed-scope coverage ≥80%.
- [ ] Commit `feat: preserve raw source provider indexes` and obtain independent review.

### Task 3: Emit strict provider-owned company receipt lineage

**Files:**
- Create: `apps/api/src/discovery/company-discovery-lineage.ts`
- Create: `apps/api/src/discovery/company-discovery-lineage.spec.ts`
- Modify: `apps/api/src/discovery/provider-contract.ts`
- Modify: `apps/api/src/discovery/providers/trade-fair.provider.ts`
- Modify: `apps/api/src/discovery/providers/public-web.provider.ts`
- Modify: `apps/api/src/discovery/providers/directory.provider.ts`
- Create: `apps/api/src/discovery/providers/company-lineage.provider.spec.ts`

**Interfaces:**

```ts
export const DISCOVERY_COMPANY_LINEAGE_INVALID =
  'DISCOVERY_COMPANY_LINEAGE_INVALID' as const;
export const DISCOVERY_COMPANY_RESULT_LINEAGE_V1 =
  'discovery-company-result-lineage/v1' as const;

export type DiscoveryCompanyReceiptAttemptV1 = Readonly<{
  producerId: string;
  receipt: DurableExecutionReceipt;
}>;
export type DiscoveryCompanyReceiptCoverageV1 =
  DiscoveryCompanyReceiptAttemptV1 & Readonly<{ recordIndexes: readonly number[] }>;
export type DiscoveryCompanyResultLineageV1 = Readonly<{
  schemaVersion: typeof DISCOVERY_COMPANY_RESULT_LINEAGE_V1;
  recordCount: number;
  attemptReceipts: readonly DiscoveryCompanyReceiptAttemptV1[];
  receiptCoverage: readonly DiscoveryCompanyReceiptCoverageV1[];
}>;
```

Provider capability/result additions:

```ts
readonly companyResultLineage?: typeof DISCOVERY_COMPANY_RESULT_LINEAGE_V1;
lineage?: DiscoveryCompanyResultLineageV1;
```

- [ ] Write RED parser/collector/provider tests for exact total coverage, operation uniqueness, zero-output attempts, first-wins dedup, callback forwarding once, invoked-without-settled-receipt omitting the entire optional lineage, and not-invoked early exits. Search/crawl/robots receipts must never enter company lineage.
- [ ] Run focused RED; expect missing contract/helper/capability.
- [ ] Implement one private collector per fair/domain/listing page. Mark immediately before the company-producing call; build coverage after final dedup. Support only `trade_fair←tradefair.algolia`, `public_web←discovery.extract_company`, `directory←discovery.extract_list`.
- [ ] Run provider regression, API build/lint and changed-scope statements/branches ≥80%. Confirm Contact/PII files and Activity remain untouched.
- [ ] Commit `feat: add provider-owned company lineage` and obtain independent review.

### Final foundation gate

- Run Tasks 1–3 focused suites, API build/lint, `pnpm docs:verify`, `pnpm governance:verify`, ContractGraph and `git diff --check`.
- Assert no migration, schema, Activity, Workflow, runtime or Release path changed.
- Write a separate downstream plan only after the A-owned generic governed-relation interface enters main. That later plan owns B DB headers/items/outcomes, true PostgreSQL/RLS, Activity append/attest, Canonical/terminal mappings and Temporal replay; it still may not unlock v3 until all are complete.
