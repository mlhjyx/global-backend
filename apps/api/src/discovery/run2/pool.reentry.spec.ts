import { describe, expect, it, vi } from 'vitest';
import { loadQuickScanPool } from './pool';
import { createRun2Activities } from '../../temporal/discovery.run2.activities';

const WS = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const ICP = '33333333-3333-4333-8333-333333333333';
const HASH = 'c'.repeat(64);
const BUDGET = {
  authorityId: '55555555-5555-4555-8555-555555555555',
  replay: false,
  scopeKey: WS,
  accountKey: `discovery.run:discovery_run:request:${HASH}:${HASH}`,
  purpose: 'discovery.run',
  subjectType: 'discovery_run',
  subjectId: `request:${HASH}`,
  requestSha256: HASH,
};

describe('Phase 1: Run 2.0 quick-scan pool re-entry & prefilter provisional cleanup', () => {
  it('excludes companies whose latest job for this ICP was quick_scan=mismatch, deep=mismatch, or prefiltered_out', async () => {
    const capturedWheres: Array<Record<string, unknown>> = [];
    const tx = {
      discoveryQueryPlan: { findFirst: vi.fn(async () => null) },
      qualificationRule: { findMany: vi.fn(async () => []) },
      discoveryCompanyJob: {
        findMany: vi.fn(async () => [
          {
            canonicalCompanyId: 'c-mismatch',
            stage: 'quick_judged',
            verdictQuick: 'mismatch',
            verdictDeep: null,
            createdAt: new Date('2026-11-24T10:00:00Z'),
          },
          {
            canonicalCompanyId: 'c-prefiltered',
            stage: 'prefiltered_out',
            verdictQuick: null,
            verdictDeep: null,
            createdAt: new Date('2026-11-24T10:00:00Z'),
          },
          {
            canonicalCompanyId: 'c-deep-mismatch',
            stage: 'done',
            verdictQuick: 'weak',
            verdictDeep: 'mismatch',
            createdAt: new Date('2026-11-24T10:00:00Z'),
          },
          {
            canonicalCompanyId: 'c-weak-ok',
            stage: 'quick_judged',
            verdictQuick: 'weak',
            verdictDeep: null,
            createdAt: new Date('2026-11-24T10:00:00Z'),
          },
        ]),
      },
      canonicalCompany: {
        count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          capturedWheres.push(where);
          return 1;
        }),
        findMany: vi.fn(async () => [
          { id: 'c-weak-ok', name: 'Weak Co', domain: 'weak.it', country: 'IT', industry: 'solar', employeeCount: 10, revenueUsd: null, attributes: {} },
        ]),
      },
    };

    await loadQuickScanPool(tx as never, { icpId: ICP, runId: RUN }, 50);

    expect(capturedWheres).toHaveLength(1);
    const idFilter = capturedWheres[0]!.id as { notIn?: string[] } | undefined;
    expect(idFilter?.notIn).toEqual(expect.arrayContaining(['c-mismatch', 'c-prefiltered', 'c-deep-mismatch']));
    expect(idFilter?.notIn).not.toContain('c-weak-ok');
  });

  it('rejects existing provisional weak leads when prefilterPool marks a company prefiltered_out', async () => {
    const leadUpdateMany = vi.fn(async () => ({ count: 1 }));
    let seq = 0n;
    const tx = {
      $queryRaw: vi.fn(async () => []),
      discoveryQueryPlan: { findFirst: vi.fn(async () => null) },
      qualificationRule: {
        findMany: vi.fn(async () => [
          { id: 'r1', kind: 'EXCLUSION', field: 'country', operator: 'eq', value: 'US', weight: 1 },
        ]),
      },
      discoveryCompanyJob: {
        findMany: vi.fn(async () => []),
        upsert: vi.fn(async () => ({})),
      },
      canonicalCompany: {
        count: vi.fn(async () => 1),
        findMany: vi.fn(async () => [
          { id: 'c-us', name: 'US Corp', domain: 'us.example', country: 'US', industry: 'solar', employeeCount: 20, revenueUsd: null, attributes: {} },
        ]),
      },
      lead: { updateMany: leadUpdateMany },
      runEvent: {
        aggregate: vi.fn(async () => ({ _max: { seq: seq === 0n ? null : seq } })),
        create: vi.fn(async () => {
          seq += 1n;
          return {};
        }),
      },
    };
    const activities = createRun2Activities({
      prisma: {
        withWorkspace: async <T>(_ws: string, cb: (client: typeof tx) => Promise<T>) => cb(tx),
      } as never,
      gateway: {} as never,
      providers: {} as never,
      budgetStore: { attestAuthorized: vi.fn(async () => undefined) } as never,
    });

    const out = await activities.prefilterPool({
      workspaceId: WS,
      runId: RUN,
      icpId: ICP,
      executionContractVersion: 2,
      executionBudget: BUDGET,
    });

    expect(out.prefilteredOut).toBe(1);
    expect(leadUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: WS,
          icpId: ICP,
          canonicalCompanyId: 'c-us',
        }),
        data: expect.objectContaining({
          fitVerdict: 'mismatch',
          queue: 'rejected',
          status: 'REJECTED',
        }),
      }),
    );
  });
});
