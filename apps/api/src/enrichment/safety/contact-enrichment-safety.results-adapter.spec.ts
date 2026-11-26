import { describe, expect, it, vi } from 'vitest';
import { buildFrozenEnrichmentPlan } from './enrichment-call-plan';
import {
  listContactEnrichmentQualityFacts,
  listContactEnrichmentResults,
  readContactEnrichmentQualityFacts,
  readContactEnrichmentResult,
  type ContactEnrichmentResultsAdapterDeps,
} from './contact-enrichment-safety.composition';
import { decodeContactEnrichmentResultCursor } from './contact-enrichment-results.dto';
import type { EnrichmentRuntimeExecutionRecord } from './enrichment-safety.contract';

const W = '00000000-0000-4000-8000-000000000001';
const C = '00000000-0000-4000-8000-000000000002';
const CONTACT = '00000000-0000-4000-8000-000000000003';
const A = '00000000-0000-4000-8000-000000000004';
const ACCOUNT = '00000000-0000-4000-8000-000000000005';
const RUN_A = '00000000-0000-4000-8000-0000000000aa';
const RUN_B = '00000000-0000-4000-8000-0000000000bb';
const parsed = { limit: 10 as const, cursor: null, businessRunId: null };
interface Row {
  id: string;
  createdAt: string;
  businessRunId?: string;
  streaming?: boolean;
}

function record(operationRef: string, createdAt: string): EnrichmentRuntimeExecutionRecord {
  const plan = buildFrozenEnrichmentPlan({
    workspaceId: W,
    companyId: C,
    entrypoint: 'http',
    businessRunId: null,
    requestSha256: 'a'.repeat(64),
    admittedAtMs: 1000,
    deadlineAtMs: 601000,
    targets: [{ contactId: CONTACT, contactOrdinal: 0, inputVersion: 'a'.repeat(64), beforeDigest: 'b'.repeat(64), pointRefs: [] }],
    slots: [{ slotKey: 'finder', contactId: CONTACT, contactOrdinal: 0, phase: 'FINDER', provider: 'hunter', toolId: 'contact_email.find.hunter', toolVersion: '1.0.0', quoteMicrousd: '1700', pricingVersion: 'p1', dependsOnSlotKey: null }],
    limits: { authorityCapMicrousd: '500000', companyCapMicrousd: '500000', contactCapMicrousd: '150000', finderCompanyMax: 10, finderContactMax: 3, verifyAddressMax: 6, maxContacts: 10 },
  });
  return {
    view: { executionId: 'e'.repeat(8) + '-0000-4000-8000-000000000000', operationRef, planSha256: plan.planSha256, status: 'PREPARED', accountId: ACCOUNT, authorityId: A, generation: 1 },
    workspaceId: W,
    companyId: C,
    entrypoint: 'http',
    businessRunId: null,
    requestSha256: plan.requestSha256,
    admissionRequestSha256: 'c'.repeat(64),
    accountKey: 'synthetic-key',
    currentAccount: { accountId: ACCOUNT, authorityId: A, generation: 1 },
    plan,
    targetCount: 1,
    executionOptions: { lawfulBasisKind: 'legitimate_interest', tier: 'B' },
    createdAt,
    resultRevision: 1,
    resultSnapshot: null,
    steps: [],
  } as EnrichmentRuntimeExecutionRecord;
}
function head(index: number, businessRunId?: string): Row {
  return {
    id: `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
    createdAt: `2026-11-22T00:00:${String(index).padStart(2, '0')}.000Z`,
    ...(businessRunId === undefined ? {} : { businessRunId }),
  };
}
function textOf(argument: unknown): string {
  if (typeof (argument as { sql?: unknown })?.sql === 'string') return (argument as { sql: string }).sql;
  return Array.isArray(argument) ? (argument as unknown[]).join('?') : '';
}
function valuesOf(argument: unknown, rest: readonly unknown[]): readonly unknown[] {
  const embedded = (argument as { values?: unknown })?.values;
  return Array.isArray(embedded) ? embedded : rest;
}
function world(config: { companyExists?: boolean; rows?: Row[]; records?: ReadonlySet<string> }) {
  const scopes: string[] = [];
  const headQueries: Array<{ cursor: { createdAt: string; id: string } | null; businessRunId: unknown; limit: number }> = [];
  const database = {
    withWorkspace: vi.fn(async (workspaceId: string, work: (tx: unknown) => Promise<unknown>) => {
      scopes.push(workspaceId);
      const tx = {
        $queryRaw: vi.fn(async (...args: unknown[]) => {
          const text = textOf(args[0]);
          const values = valuesOf(args[0], args.slice(1));
          if (text.includes('WITH head AS')) {
            const [workspace, company, id, operationRef] = values;
            if (workspace !== W || company !== C || config.companyExists === false) return [];
            const found = config.rows?.find((row) => row.streaming &&
              (id !== null ? row.id === id : resultRef(row) === operationRef));
            return found ? [{
              run_id: found.businessRunId, operation_ref: resultRef(found), started_at: new Date(found.createdAt),
              result_status: 'RATE_LIMITED', company_suppressed: false,
              contact_id: null, attempt_refs: null, attempt_outcomes: null,
            }] : [];
          }
          if (text.includes('public.canonical_company')) return config.companyExists === false ? [] : [{ id: C }];
          if (!text.includes('public.contact_enrichment_execution e')) return [];
          const combinesStreaming = text.includes('WITH page_scope AS');
          const includesStreaming = combinesStreaming && values[5] === true;
          const businessRunId = values[2] ?? null;
          const cursorAt = values[combinesStreaming ? 3 : 4] ?? null;
          const cursorId = values[combinesStreaming ? 4 : 6] ?? null;
          const limit = Number(values[combinesStreaming ? 6 : 7]) - 1;
          headQueries.push({
            cursor: cursorAt === null ? null : { createdAt: String(cursorAt), id: String(cursorId) },
            businessRunId,
            limit,
          });
          return (config.rows ?? [])
            .filter((row) => includesStreaming || !row.streaming)
            .filter((row) => businessRunId === null || row.businessRunId === businessRunId)
            .filter(
              (row) =>
                cursorAt === null ||
                (row.createdAt > String(cursorAt) ||
                  (row.createdAt === String(cursorAt) && row.id > String(cursorId))),
            )
            .slice(0, limit + 1)
            .map((row) => ({ id: row.id, created_at: new Date(row.createdAt), streaming: Boolean(row.streaming) }));
        }),
      };
      return work(tx);
    }),
  } as unknown as ContactEnrichmentResultsAdapterDeps['database'];
  const loadById = vi.fn(async (_scope: { workspaceId: string; companyId: string }, id: string) =>
    config.records?.has(id) ? record(resultRef({ id }), '2026-11-22T00:00:00.000Z') : null,
  );
  const loadByRef = vi.fn(async (_scope: { workspaceId: string; companyId: string }, ref: string) =>
    ref === 'a'.repeat(64) ? record(ref, '2026-11-22T00:00:00.000Z') : null,
  );
  const deps: ContactEnrichmentResultsAdapterDeps = { database, loadById, loadByRef };
  return { deps, scopes, headQueries, loadById, loadByRef };
}

function resultRef(row: Pick<Row, 'id' | 'streaming'>) {
  return (row.streaming ? 'e' : 'f').repeat(60) + row.id.slice(-4);
}

describe('real enrichment result list/read adapters distinguish unknown companies from empty pages', () => {
  it('returns null (404 path) for a missing, foreign or soft-deleted company without querying heads', async () => {
    const x = world({ companyExists: false });
    await expect(listContactEnrichmentResults(x.deps, { workspaceId: W }, C, parsed)).resolves.toBeNull();
    await expect(listContactEnrichmentQualityFacts(x.deps, { workspaceId: W }, C, parsed)).resolves.toBeNull();
    expect(x.scopes).toEqual([W, W]);
    expect(x.headQueries).toEqual([]);
    expect(x.loadById).not.toHaveBeenCalled();
  });
  it('returns a legitimate empty page for a readable company with zero executions', async () => {
    const x = world({ companyExists: true, rows: [], records: new Set() });
    await expect(listContactEnrichmentResults(x.deps, { workspaceId: W }, C, parsed)).resolves.toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
    await expect(listContactEnrichmentQualityFacts(x.deps, { workspaceId: W }, C, parsed)).resolves.toMatchObject({
      items: [],
      hasMore: false,
    });
  });
  it('binds the cursor, limit and business run into the next page query', async () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, index) => head(index, RUN_A)),
      ...Array.from({ length: 3 }, (_, index) => head(30 + index, RUN_B)),
    ];
    const allIds = new Set(rows.map((row) => row.id));
    const x = world({ companyExists: true, rows, records: allIds });
    const page1 = await listContactEnrichmentResults(x.deps, { workspaceId: W }, C, {
      limit: 10,
      cursor: null,
      businessRunId: RUN_A,
    });
    expect(page1?.items).toHaveLength(10);
    expect(page1?.hasMore).toBe(true);
    const cursor = decodeContactEnrichmentResultCursor(page1!.nextCursor!);
    expect(cursor).toEqual({ createdAt: rows[9]!.createdAt, id: rows[9]!.id });
    expect(x.headQueries[0]).toEqual({ cursor: null, businessRunId: RUN_A, limit: 10 });

    const page2 = await listContactEnrichmentResults(x.deps, { workspaceId: W }, C, {
      limit: 10,
      cursor,
      businessRunId: RUN_A,
    });
    expect(x.headQueries[1]).toEqual({ cursor, businessRunId: RUN_A, limit: 10 });
    expect(page2?.items).toHaveLength(2);
    expect(page2?.hasMore).toBe(false);
    expect(page2?.nextCursor).toBeNull();
    // Dropping the cursor would repeat the first page; dropping the run filter would pull run B rows.
    expect(x.headQueries[1]!.cursor).not.toBeNull();
    expect(x.loadById).toHaveBeenLastCalledWith({ workspaceId: W, companyId: C }, rows[11]!.id);
  });
  it('keeps the cursor on the last head of the page when an intermediate record cannot hydrate', async () => {
    const rows = Array.from({ length: 11 }, (_, index) => head(index, RUN_A));
    const records = new Set(rows.map((row) => row.id));
    records.delete(rows[3]!.id);
    const x = world({ companyExists: true, rows, records });
    const page = await listContactEnrichmentQualityFacts(x.deps, { workspaceId: W }, C, {
      limit: 10,
      cursor: null,
      businessRunId: RUN_A,
    });
    expect(page?.items).toHaveLength(9);
    expect(page?.hasMore).toBe(true);
    const cursor = decodeContactEnrichmentResultCursor(page!.nextCursor!);
    expect(cursor).toEqual({ createdAt: rows[9]!.createdAt, id: rows[9]!.id });
    expect(x.headQueries[0]).toEqual({ cursor: null, businessRunId: RUN_A, limit: 10 });
    expect(x.loadById).toHaveBeenCalledTimes(10);
    expect(x.loadById).toHaveBeenCalledWith({ workspaceId: W, companyId: C }, rows[0]!.id);
  });
  it('merges legacy and streaming results once per head across a shared millisecond and filters by run', async () => {
    const boundaryTime = '2026-11-22T00:00:08.000Z';
    const rows = Array.from({ length: 13 }, (_, index) => ({
      ...head(index, RUN_A),
      ...(index >= 8 && index <= 11 ? { createdAt: boundaryTime } : {}),
      streaming: [2, 9, 10].includes(index),
    }));
    const excluded = { ...head(25, RUN_B), streaming: true };
    const records = new Set(rows.filter((row) => !row.streaming).map((row) => row.id));
    const x = world({ rows: [...rows, excluded], records });
    const page1 = await listContactEnrichmentResults(x.deps, { workspaceId: W }, C, { ...parsed, businessRunId: RUN_A });
    expect(page1?.items.map((item) => (item as { operationRef: string }).operationRef)).toEqual(rows.slice(0, 10).map(resultRef));
    const cursor = decodeContactEnrichmentResultCursor(page1!.nextCursor!);
    expect(cursor).toEqual({ id: rows[9]!.id, createdAt: boundaryTime });

    const page2 = await listContactEnrichmentResults(x.deps, { workspaceId: W }, C, {
      ...parsed, businessRunId: RUN_A, cursor,
    });
    expect(page2?.items.map((item) => (item as { operationRef: string }).operationRef)).toEqual(rows.slice(10).map(resultRef));
    expect(page2).toMatchObject({ hasMore: false, nextCursor: null });
    expect(x.loadById).not.toHaveBeenCalledWith({ workspaceId: W, companyId: C }, rows[9]!.id);

    const detail = await readContactEnrichmentResult(x.deps, { workspaceId: W }, C, resultRef(rows[9]!));
    expect(detail).toMatchObject({ operationRef: resultRef(rows[9]!), status: 'APPLY_PENDING', businessRunId: RUN_A });
    expect(x.loadByRef).toHaveBeenCalledExactlyOnceWith({ workspaceId: W, companyId: C }, resultRef(rows[9]!));
    const facts = await listContactEnrichmentQualityFacts(x.deps, { workspaceId: W }, C, { ...parsed, businessRunId: RUN_A });
    expect(facts?.items).toHaveLength(10);
    expect(facts).toMatchObject({ hasMore: false, nextCursor: null });
  });
  it('reads by exact operation ref through loadByRef and returns null when absent', async () => {
    const x = world({ companyExists: true });
    await expect(readContactEnrichmentResult(x.deps, { workspaceId: W }, C, 'a'.repeat(64))).resolves.toMatchObject({
      operationRef: 'a'.repeat(64),
    });
    await expect(readContactEnrichmentQualityFacts(x.deps, { workspaceId: W }, C, 'b'.repeat(64))).resolves.toBeNull();
    expect(x.loadByRef).toHaveBeenCalledWith({ workspaceId: W, companyId: C }, 'a'.repeat(64));
    expect(x.loadByRef).toHaveBeenCalledWith({ workspaceId: W, companyId: C }, 'b'.repeat(64));
  });
});
