import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@temporalio/workflow', () => import('./testing/temporal-workflow.mock'));

import { acts, resetActivities } from './testing/temporal-workflow.mock';
import { discoveryWorkflow } from './discovery.workflow';

const SENSITIVE_ERROR =
  'Erika Einkauf <erika@example.de> https://private.example/discovery token=secret';

function primeDiscovery(error: unknown): void {
  acts.resetRunBudget.mockResolvedValue(undefined);
  acts.loadPlanQueries.mockResolvedValue({
    queries: [
      {
        source_class: 'public_web',
        filters: {},
        keywords: ['pump'],
        rationale: 'test',
        priority: 1,
      },
    ],
  });
  acts.executeQuery.mockRejectedValue(error);
  acts.canonicalizeRun.mockResolvedValue({ companies: 0, suppressed: 0 });
  acts.qualifyFitForRun.mockResolvedValue({ verdicts: 0, skippedForBudget: 0 });
  acts.enrichRun.mockResolvedValue({
    matched: 0,
    enriched: 0,
    provider: null,
    budgetTruncated: false,
  });
  acts.enrichSignalsRun.mockResolvedValue({
    matched: 0,
    enriched: 0,
    provider: null,
    budgetTruncated: false,
  });
  acts.registerWatchesForRun.mockResolvedValue({ candidates: 0, registered: 0 });
  acts.enqueuePatentLookupsForRun.mockResolvedValue({ candidates: 0, enqueued: 0 });
  acts.finalizeRun.mockResolvedValue(undefined);
}

beforeEach(() => resetActivities());

describe('discoveryWorkflow safe failure evidence', () => {
  it.each([
    [new Error(SENSITIVE_ERROR), 'DISCOVERY_QUERY_FAILED'],
    [
      {
        name: 'ActivityFailure',
        cause: { type: 'BudgetExceededError', message: SENSITIVE_ERROR },
      },
      'BUDGET_EXCEEDED',
    ],
  ])('finalizeRun 仅接收闭合 code：%s', async (failure, expectedCode) => {
    primeDiscovery(failure);

    await discoveryWorkflow({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      runId: '22222222-2222-4222-8222-222222222222',
      planId: '33333333-3333-4333-8333-333333333333',
      icpId: '44444444-4444-4444-8444-444444444444',
    });

    const finalize = acts.finalizeRun.mock.calls[0]?.[0] as {
      status: string;
      stats: { perSource: Record<string, { error?: string }>; failures: number };
    };
    expect(finalize.status).toBe('FAILED');
    expect(finalize.stats.failures).toBe(1);
    expect(finalize.stats.perSource.public_web?.error).toBe(expectedCode);
    expect(JSON.stringify(finalize)).not.toContain(SENSITIVE_ERROR);
  });
});
