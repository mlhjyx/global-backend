import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockActs = vi.hoisted(() => ({
  loadPlanQueries: vi.fn(),
  executeQuery: vi.fn(),
  canonicalizeRun: vi.fn(),
  registerWatchesForRun: vi.fn(),
  initStreamingRun: vi.fn(),
  recordStreamingL0Complete: vi.fn(),
  processStreamingL1Company: vi.fn(),
  startStreamingL2Stage: vi.fn(),
  enrichStreamingTopKCompany: vi.fn(),
  finalizeStreamingRun: vi.fn(),
}));
const historyHasF7 = vi.hoisted(() => vi.fn());

vi.mock('@temporalio/workflow', () => {
  class CancelledFailure extends Error {
    constructor(msg = 'cancelled') {
      super(msg);
      this.name = 'CancelledFailure';
    }
  }
  return {
    ApplicationFailure: {
      nonRetryable: (message: string, type?: string) =>
        Object.assign(new Error(message), { name: 'ApplicationFailure', type: type ?? message, nonRetryable: true }),
    },
    CancellationScope: {
      nonCancellable: async <T>(fn: () => Promise<T>) => fn(),
    },
    isCancellation: (err: unknown) => err instanceof Error && err.name === 'CancelledFailure',
    patched: historyHasF7,
    proxyActivities: () => mockActs,
    CancelledFailure,
  };
});

import {
  discoveryStreamingWorkflow,
  selectTopKStreamingCompanies,
  type DiscoveryStreamingInput,
} from './discovery.streaming.workflow';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const RUN_ID = '20000000-0000-4000-8000-000000000002';
const PLAN_ID = '30000000-0000-4000-8000-000000000003';
const ICP_ID = '40000000-0000-4000-8000-000000000004';
const REQUEST_SHA = 'a'.repeat(64);

function makeInput(overrides: Partial<DiscoveryStreamingInput> = {}): DiscoveryStreamingInput {
  return {
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    planId: PLAN_ID,
    icpId: ICP_ID,
    executionContractVersion: 2,
    executionBudget: {
      authorityId: '50000000-0000-4000-8000-000000000005',
      replay: false,
      scopeKey: WORKSPACE_ID,
      accountKey: `discovery.run:discovery_run:${RUN_ID}:${REQUEST_SHA}`,
      purpose: 'discovery.run',
      subjectType: 'discovery_run',
      subjectId: RUN_ID,
      requestSha256: REQUEST_SHA,
    },
    ...overrides,
  };
}

describe('discoveryStreamingWorkflow (Plan B three-stage funnel)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    historyHasF7.mockReturnValue(true);
    mockActs.loadPlanQueries.mockResolvedValue({
      queries: [
        { source_class: 'public_intelligence', filters: { country: 'IT' }, keywords: ['moduli fotovoltaici'], rationale: 'q1', priority: 1 },
        { source_class: 'public_intelligence', filters: { country: 'IT' }, keywords: ['distributore solare'], rationale: 'q2', priority: 2 },
      ],
    });
    mockActs.initStreamingRun.mockResolvedValue(undefined);
    mockActs.executeQuery.mockResolvedValue({ rawCount: 5, sourceClass: 'public_intelligence' });
    mockActs.canonicalizeRun.mockResolvedValue({ companies: 3, suppressed: 0 });
    mockActs.recordStreamingL0Complete.mockResolvedValue({
      companyIds: ['c-1', 'c-2', 'c-3'],
    });
    mockActs.processStreamingL1Company.mockImplementation(async ({ companyId }: { companyId: string }) => ({
      companyId,
      verdict: companyId === 'c-3' ? 'mismatch' : companyId === 'c-1' ? 'match' : 'weak',
      score: companyId === 'c-1' ? 92 : companyId === 'c-2' ? 68 : 15,
      fetchMethod: 'raw_http' as const,
      usedCrawl4aiFallback: false,
      usedWwwRetry: false,
      pdfSkipped: false,
      channelsCount: 2,
    }));
    mockActs.startStreamingL2Stage.mockResolvedValue(undefined);
    mockActs.enrichStreamingTopKCompany.mockResolvedValue({ companyId: 'c-1', contactsCreated: 1 });
    mockActs.registerWatchesForRun.mockResolvedValue({ candidates: 2, registered: 2, skippedSubjects: 0, unreplayable: 0 });
    mockActs.finalizeStreamingRun.mockResolvedValue(undefined);
  });

  it('executes L0 (canonical upsert BEFORE any web fetch) -> L1 single-activity -> L2 Top-K -> finalize DONE', async () => {
    const order: string[] = [];
    mockActs.canonicalizeRun.mockImplementation(async () => {
      order.push('canonicalizeRun');
      return { companies: 3, suppressed: 0 };
    });
    mockActs.processStreamingL1Company.mockImplementation(async ({ companyId }: { companyId: string }) => {
      order.push(`L1:${companyId}`);
      return {
        companyId,
        verdict: companyId === 'c-3' ? 'mismatch' : companyId === 'c-1' ? 'match' : 'weak',
        score: companyId === 'c-1' ? 92 : companyId === 'c-2' ? 68 : 15,
        fetchMethod: 'raw_http' as const,
        usedCrawl4aiFallback: false,
        usedWwwRetry: false,
        pdfSkipped: false,
        channelsCount: 2,
      };
    });

    await discoveryStreamingWorkflow(makeInput({ streamingTopKCap: 2 }));

    expect(order[0]).toBe('canonicalizeRun');
    expect(order.slice(1)).toEqual(['L1:c-1', 'L1:c-2', 'L1:c-3']);
    // Only c-1 (match) and c-2 (weak) enter L2; c-3 (mismatch) is excluded!
    expect(mockActs.enrichStreamingTopKCompany).toHaveBeenCalledTimes(2);
    expect(mockActs.enrichStreamingTopKCompany.mock.calls.map((c) => c[0].companyId)).toEqual(['c-1', 'c-2']);
    expect(mockActs.enrichStreamingTopKCompany.mock.calls[0]![0]).toHaveProperty('enrichmentSlot', 0);
    expect(mockActs.enrichStreamingTopKCompany.mock.calls[1]![0]).not.toHaveProperty('enrichmentSlot');
    expect(mockActs.registerWatchesForRun).toHaveBeenCalledTimes(1);
    expect(mockActs.finalizeStreamingRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'DONE',
        summary: expect.objectContaining({
          canonicalCount: 3,
          l1Processed: 3,
          l2Selected: 2,
          l2Enriched: 2,
          watchesRegistered: 2,
        }),
      }),
    );
  });

  it('bounds F7 to the existing company cap and keeps older histories on the old activity args', async () => {
    const companyIds = Array.from({ length: 28 }, (_, index) => 'match-' + String(index).padStart(2, '0'));
    mockActs.recordStreamingL0Complete.mockResolvedValue({ companyIds });
    mockActs.processStreamingL1Company.mockImplementation(async ({ companyId }) => ({
      companyId, verdict: 'match', score: 90,
    }));
    await discoveryStreamingWorkflow(makeInput({ streamingTopKCap: 28 }));
    const calls = mockActs.enrichStreamingTopKCompany.mock.calls;
    expect(calls).toHaveLength(28);
    expect(calls.slice(0, 25).map(([request]) => request.enrichmentSlot))
      .toEqual(Array.from({ length: 25 }, (_, index) => index));
    expect(calls.slice(25).every(([request]) => request.enrichmentSlot === undefined)).toBe(true);

    historyHasF7.mockReturnValue(false);
    mockActs.enrichStreamingTopKCompany.mockClear();
    await discoveryStreamingWorkflow(makeInput({ streamingTopKCap: 2 }));
    expect(mockActs.enrichStreamingTopKCompany.mock.calls).toHaveLength(2);
    expect(mockActs.enrichStreamingTopKCompany.mock.calls.every(([request]) => !('enrichmentSlot' in request))).toBe(true);
  });

  it('finalizes as CANCELLED inside CancellationScope.nonCancellable with preserved partial L1 counts', async () => {
    let processed = 0;
    mockActs.processStreamingL1Company.mockImplementation(async ({ companyId }: { companyId: string }) => {
      processed += 1;
      if (processed === 2) {
        const err = new Error('workflow cancelled');
        err.name = 'CancelledFailure';
        throw err;
      }
      return {
        companyId,
        verdict: 'match' as const,
        score: 88,
        fetchMethod: 'raw_http' as const,
        usedCrawl4aiFallback: false,
        usedWwwRetry: false,
        pdfSkipped: false,
        channelsCount: 1,
      };
    });

    // Cancellation finishes cleanly with CANCELLED status (does not fail as FAILED).
    await discoveryStreamingWorkflow(makeInput({ streamingL1Concurrency: 1 }));

    expect(mockActs.finalizeStreamingRun).toHaveBeenCalledTimes(1);
    expect(mockActs.finalizeStreamingRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'CANCELLED',
        summary: expect.objectContaining({
          l1Processed: 1,
        }),
      }),
    );
  });

  it('selectTopKStreamingCompanies ranks match ahead of weak, orders by score desc, and excludes mismatch', () => {
    const selected = selectTopKStreamingCompanies(
      [
        { companyId: 'c-weak-high', verdict: 'weak', score: 95, fetchMethod: 'raw_http', usedCrawl4aiFallback: false, usedWwwRetry: false, pdfSkipped: false, channelsCount: 1 },
        { companyId: 'c-mismatch', verdict: 'mismatch', score: 99, fetchMethod: 'raw_http', usedCrawl4aiFallback: false, usedWwwRetry: false, pdfSkipped: false, channelsCount: 1 },
        { companyId: 'c-match-low', verdict: 'match', score: 80, fetchMethod: 'raw_http', usedCrawl4aiFallback: false, usedWwwRetry: false, pdfSkipped: false, channelsCount: 1 },
        { companyId: 'c-match-high', verdict: 'match', score: 91, fetchMethod: 'raw_http', usedCrawl4aiFallback: false, usedWwwRetry: false, pdfSkipped: false, channelsCount: 1 },
      ],
      2,
    );
    expect(selected.map((item) => item.companyId)).toEqual(['c-match-high', 'c-match-low']);
  });
});
