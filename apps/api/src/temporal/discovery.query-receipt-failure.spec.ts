import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityFailure, ApplicationFailure } from '@temporalio/common';

/** 查询批量里一个查询失败、另一个已成功落收据：失败的 run 也必须带上已落盘的收据。 */

vi.mock('@temporalio/workflow', () => import('./testing/temporal-workflow.mock'));

import { acts, resetActivities } from './testing/temporal-workflow.mock';
import { discoveryWorkflow } from './discovery.workflow';

const WS = '10000000-0000-4000-8000-000000000001';
const SHA = 'a'.repeat(64);
const ICP_ID = '30000000-0000-4000-8000-000000000003';
const RECEIPT_KEY = 'b'.repeat(64);

const DISCOVERY_BUDGET = Object.freeze({
  authorityId: '20000000-0000-4000-8000-000000000002',
  replay: false,
  scopeKey: WS,
  accountKey: `discovery.run:discovery_run:request:${SHA}:${SHA}`,
  purpose: 'discovery.run' as const,
  subjectType: 'discovery_run',
  subjectId: `request:${SHA}`,
  requestSha256: SHA,
});

const INPUT = {
  workspaceId: WS,
  runId: '40000000-0000-4000-8000-000000000001',
  planId: '50000000-0000-4000-8000-000000000001',
  icpId: ICP_ID,
  executionContractVersion: 2 as const,
  executionBudget: DISCOVERY_BUDGET,
};

const QUERY = { source_class: 'public_intelligence', filters: {}, keywords: ['Pumpen'], priority: 1 };

const RECEIPT = {
  schemaVersion: 'discovery-query-receipt/v1' as const,
  queryKey: RECEIPT_KEY,
  queryOrdinal: 1,
  sourceClass: 'public_intelligence',
  providers: ['public_web'],
  accepted: 8,
  quarantined: 0,
  rejected: 0,
  governanceDenied: 0,
  duplicate: 0,
  usageQuantity: 8,
  costCents: 0,
};

beforeEach(() => resetActivities());

describe('discoveryWorkflow：查询批量失败时的收据折叠', () => {
  it('一个查询失败停止 run 时，仍把同批已成功查询的收据并入 FAILED 收尾统计', async () => {
    acts.loadPlanQueries.mockResolvedValue({
      queries: [
        { ...QUERY, keywords: ['Pumpen A'] },
        { ...QUERY, keywords: ['Pumpen B'] },
      ],
    });
    acts.executeQuery.mockImplementation(async (args: { queryOrdinal: number }) => {
      if (args.queryOrdinal === 0) {
        throw new ActivityFailure(
          'Activity task failed',
          'executeQuery',
          '1',
          'MAXIMUM_ATTEMPTS_REACHED',
          'worker-1',
          new ApplicationFailure('upstream down', 'ProviderTransportError', false),
        );
      }
      return {
        rawCount: RECEIPT.accepted,
        quarantinedCount: RECEIPT.quarantined,
        rejectedCount: RECEIPT.rejected,
        duplicateCount: RECEIPT.duplicate,
        costCents: RECEIPT.costCents,
        provider: RECEIPT.providers.join('+'),
        budgetTruncated: false,
        queryReceipt: RECEIPT,
      };
    });
    acts.finalizeRun.mockResolvedValue(undefined);

    await expect(discoveryWorkflow(INPUT)).rejects.toBeTruthy();

    expect(acts.finalizeRun).toHaveBeenCalledTimes(1);
    const finalized = acts.finalizeRun.mock.calls[0]![0] as {
      status: string;
      stats: { perQuery?: Record<string, unknown>; failure?: { stage?: string } };
    };
    expect(finalized.status).toBe('FAILED');
    expect(finalized.stats.failure?.stage).toBe('query');
    expect(Object.keys(finalized.stats.perQuery ?? {})).toEqual([RECEIPT_KEY]);
  });
});
