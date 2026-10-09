import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock(
  '@temporalio/workflow',
  () => import('./testing/temporal-workflow.mock'),
);

import {
  ActivityFailure,
  ApplicationFailure,
  CancelledFailure,
} from '@temporalio/common';
import {
  acts,
  CancellationScope,
  resetActivities,
  setPatched,
} from './testing/temporal-workflow.mock';
import { createDiscoveryActivities } from './discovery.activities';
import {
  DISCOVERY_AUTHORITY_PATCH,
  DISCOVERY_FAILURE_FINALIZE_PATCH,
  DISCOVERY_RAW_GOVERNANCE_PATCH,
  DISCOVERY_WEBSITE_PROFILE_PATCH,
  discoveryWorkflow,
} from './discovery.workflow';
import { understandingWorkflow } from './understanding.workflow';

const WS = '10000000-0000-4000-8000-000000000001';
const SHA = 'a'.repeat(64);
const QUERY_RECEIPT_PATCH = 'discovery-query-receipt-input-v1';
const QUERY_RECEIPT_MODE = 'raw-governance-query-receipt/v1';
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
const UNDERSTANDING_BUDGET = Object.freeze({
  ...DISCOVERY_BUDGET,
  accountKey: `understanding.run:company:request:${SHA}:${SHA}`,
  purpose: 'understanding.run' as const,
  subjectType: 'company',
});

function primeDiscovery() {
  acts.loadPlanQueries.mockResolvedValue({
    queries: [
      {
        source_class: 'official_registry',
        filters: {},
        keywords: [],
        priority: 1,
      },
    ],
  });
  acts.executeQuery.mockResolvedValue({
    rawCount: 1,
    quarantinedCount: 0,
    rejectedCount: 0,
    duplicateCount: 0,
    queryReceipt: {
      schemaVersion: 'discovery-query-receipt/v1',
      queryKey: 'a'.repeat(64),
      queryOrdinal: 0,
      sourceClass: 'official_registry',
      providers: ['gleif'],
      accepted: 1,
      quarantined: 0,
      rejected: 0,
      governanceDenied: 0,
      duplicate: 0,
      usageQuantity: 1,
      costCents: 0,
    },
    provider: 'gleif',
    budgetTruncated: false,
  });
  acts.canonicalizeRun.mockResolvedValue({ companies: 1, suppressed: 0 });
  acts.qualifyFitForRun.mockResolvedValue({
    verdicts: { match: 1 },
    skippedForBudget: 0,
  });
  acts.profileWebsitesForRun.mockResolvedValue({
    profiled: 1,
    matched: 1,
    skippedSubjects: 0,
    budgetTruncated: false,
  });
  acts.enrichRun.mockResolvedValue({
    matched: 1,
    enriched: 1,
    provider: 'gleif',
    budgetTruncated: false,
  });
  acts.enrichSignalsRun.mockResolvedValue({
    matched: 1,
    enriched: 1,
    provider: 'public_web',
    budgetTruncated: false,
  });
  acts.registerWatchesForRun.mockResolvedValue({
    candidates: 1,
    registered: 1,
  });
  acts.enqueuePatentLookupsForRun.mockResolvedValue({
    candidates: 1,
    enqueued: 1,
  });
  acts.finalizeRun.mockResolvedValue(undefined);
  acts.resetRunBudget.mockResolvedValue(undefined);
}

function discoveryInput() {
  return {
    workspaceId: WS,
    runId: 'run-1',
    planId: 'plan-1',
    icpId: 'icp-1',
    executionContractVersion: 2 as const,
    executionBudget: DISCOVERY_BUDGET,
  };
}

/** What Temporal hands the workflow once an activity's last attempt has failed. */
function activityFailure(activityType: string, type: string) {
  return new ActivityFailure(
    'Activity task failed',
    activityType,
    '5',
    'MAXIMUM_ATTEMPTS_REACHED',
    'worker-1',
    new ApplicationFailure('Temporal execution failed', type, false),
  );
}

beforeEach(() => resetActivities());

describe('discoveryWorkflow execution-control propagation', () => {
  it.each([
    ['executeQuery', 'query', 'BudgetOperationReplayError'],
    ['enrichSignalsRun', 'signals', 'ExecutionBudgetGrantError'],
    ['registerWatchesForRun', 'watches', 'ExecutionBudgetGrantError'],
    ['enqueuePatentLookupsForRun', 'patentEnqueue', 'ExecutionBudgetGrantError'],
  ] as const)(
    'rethrows wrapped controls from %s after recording the run FAILED, never EXECUTED/PARTIAL',
    async (activityName, stage, type) => {
      primeDiscovery();
      const failure = activityFailure(activityName, type);
      acts[activityName].mockRejectedValue(failure);

      await expect(discoveryWorkflow(discoveryInput())).rejects.toBe(failure);
      expect(acts.finalizeRun).toHaveBeenCalledOnce();
      expect(acts.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'FAILED',
          stats: expect.objectContaining({
            failure: { stage, errorType: type, control: true },
          }),
        }),
      );
    },
  );

  it.each([
    ['website profiling', 'profileWebsitesForRun'],
    ['signal enrichment', 'enrichSignalsRun'],
    ['watch registration', 'registerWatchesForRun'],
  ] as const)('finalizes PARTIAL when %s skipped a denied company subject (G3 5.5)', async (_label, stage) => {
    primeDiscovery();
    const base = stage === 'enrichSignalsRun'
      ? { matched: 0, enriched: 0, provider: null, budgetTruncated: false }
      : stage === 'profileWebsitesForRun'
        ? { profiled: 0, matched: 0, budgetTruncated: false }
        : { candidates: 1, registered: 0 };
    acts[stage].mockResolvedValue({ ...base, skippedSubjects: 1 });

    await discoveryWorkflow(discoveryInput());

    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'PARTIAL',
        stats: expect.objectContaining({ skippedSubjects: 1 }),
      }),
    );
  });

  it('profiles company websites after canonicalization and before the fit judge (G3 5.4b)', async () => {
    primeDiscovery();

    await discoveryWorkflow(discoveryInput());

    const [profiledAt] = acts.profileWebsitesForRun.mock.invocationCallOrder;
    expect(profiledAt).toBeGreaterThan(acts.canonicalizeRun.mock.invocationCallOrder[0]!);
    expect(profiledAt).toBeLessThan(acts.qualifyFitForRun.mock.invocationCallOrder[0]!);
    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'DONE',
        stats: expect.objectContaining({ websiteProfile: { profiled: 1, matched: 1, unclassified: 0 } }),
      }),
    );
  });

  it('keeps pre-profile histories on their old command sequence (patch guard)', async () => {
    primeDiscovery();
    setPatched((patchId) => patchId !== DISCOVERY_WEBSITE_PROFILE_PATCH);

    await discoveryWorkflow(discoveryInput());

    expect(acts.profileWebsitesForRun).not.toHaveBeenCalled();
    expect(acts.qualifyFitForRun).toHaveBeenCalled();
  });

  it('keeps an ordinary query failure in the normal status path while still finalizing', async () => {
    primeDiscovery();
    acts.executeQuery.mockRejectedValue(new Error('provider unavailable'));

    await discoveryWorkflow(discoveryInput());

    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'FAILED',
        stats: expect.objectContaining({ failures: 1 }),
      }),
    );
  });

  it.each([
    {
      label: 'SOURCE_POLICY_MISSING quarantine',
      receipt: {
        rawCount: 0,
        quarantinedCount: 1,
        rejectedCount: 0,
        duplicateCount: 0,
      },
    },
    {
      label: 'UNKNOWN_PAYLOAD_FIELD rejection',
      receipt: {
        rawCount: 0,
        quarantinedCount: 0,
        rejectedCount: 1,
        duplicateCount: 0,
      },
    },
  ])(
    'does not finalize DONE when every provider result is denied by governance: $label',
    async ({ receipt }) => {
      primeDiscovery();
      acts.executeQuery.mockResolvedValue({
        ...receipt,
        queryReceipt: {
          schemaVersion: 'discovery-query-receipt/v1',
          queryKey: 'd'.repeat(64),
          queryOrdinal: 0,
          sourceClass: 'official_registry',
          providers: ['public_web'],
          accepted: receipt.rawCount,
          quarantined: receipt.quarantinedCount,
          rejected: receipt.rejectedCount,
          governanceDenied: receipt.quarantinedCount + receipt.rejectedCount,
          duplicate: receipt.duplicateCount,
          usageQuantity: receipt.rawCount,
          costCents: 0,
        },
        provider: 'public_web',
        budgetTruncated: false,
      });

      await discoveryWorkflow(discoveryInput());

      expect(acts.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'FAILED',
          stats: expect.objectContaining({
            perSource: {
              official_registry: expect.objectContaining({
                ...receipt,
                provider: 'public_web',
              }),
            },
          }),
        }),
      );
    },
  );

  it('finalizes PARTIAL and preserves all disposition counters for mixed accepted and denied Raw', async () => {
    primeDiscovery();
    acts.executeQuery.mockResolvedValue({
      rawCount: 1,
      quarantinedCount: 2,
      rejectedCount: 3,
      duplicateCount: 4,
      queryReceipt: {
        schemaVersion: 'discovery-query-receipt/v1',
        queryKey: 'e'.repeat(64),
        queryOrdinal: 0,
        sourceClass: 'official_registry',
        providers: ['public_web'],
        accepted: 1,
        quarantined: 2,
        rejected: 3,
        governanceDenied: 5,
        duplicate: 4,
        usageQuantity: 1,
        costCents: 0,
      },
      provider: 'public_web',
      budgetTruncated: false,
    });

    await discoveryWorkflow(discoveryInput());

    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'PARTIAL',
        stats: expect.objectContaining({
          perSource: {
            official_registry: expect.objectContaining({
              rawCount: 1,
              quarantinedCount: 2,
              rejectedCount: 3,
              duplicateCount: 4,
              provider: 'public_web',
            }),
          },
        }),
      }),
    );
  });

  it('keeps TED, openFDA, and public-web receipts query-scoped while summing their shared source class', async () => {
    primeDiscovery();
    acts.loadPlanQueries.mockResolvedValue({
      queries: [
        {
          source_class: 'public_intelligence',
          filters: { source_hint: 'ted' },
          keywords: [],
          priority: 1,
        },
        {
          source_class: 'public_intelligence',
          filters: { source_hint: 'openfda' },
          keywords: [],
          priority: 2,
        },
        {
          source_class: 'public_intelligence',
          filters: { source_hint: 'public_web' },
          keywords: ['pump'],
          priority: 3,
        },
      ],
    });
    const receipts = [
      {
        schemaVersion: 'discovery-query-receipt/v1',
        queryKey: 'a'.repeat(64),
        queryOrdinal: 0,
        sourceClass: 'public_intelligence',
        providers: ['ted'],
        accepted: 1,
        quarantined: 0,
        rejected: 0,
        governanceDenied: 0,
        duplicate: 1,
        usageQuantity: 1,
        costCents: 2,
      },
      {
        schemaVersion: 'discovery-query-receipt/v1',
        queryKey: 'b'.repeat(64),
        queryOrdinal: 1,
        sourceClass: 'public_intelligence',
        providers: ['openfda'],
        accepted: 0,
        quarantined: 2,
        rejected: 0,
        governanceDenied: 2,
        duplicate: 3,
        usageQuantity: 0,
        costCents: 4,
      },
      {
        schemaVersion: 'discovery-query-receipt/v1',
        queryKey: 'c'.repeat(64),
        queryOrdinal: 2,
        sourceClass: 'public_intelligence',
        providers: ['public_web'],
        accepted: 0,
        quarantined: 0,
        rejected: 1,
        governanceDenied: 1,
        duplicate: 5,
        usageQuantity: 0,
        costCents: 6,
      },
    ] as const;
    acts.executeQuery
      .mockResolvedValueOnce({
        rawCount: 1,
        quarantinedCount: 0,
        rejectedCount: 0,
        duplicateCount: 1,
        queryReceipt: receipts[0],
        provider: 'ted',
        budgetTruncated: false,
      })
      .mockResolvedValueOnce({
        rawCount: 0,
        quarantinedCount: 2,
        rejectedCount: 0,
        duplicateCount: 3,
        queryReceipt: receipts[1],
        provider: 'openfda',
        budgetTruncated: false,
      })
      .mockResolvedValueOnce({
        rawCount: 0,
        quarantinedCount: 0,
        rejectedCount: 1,
        duplicateCount: 5,
        queryReceipt: receipts[2],
        provider: 'public_web',
        budgetTruncated: false,
      });

    await discoveryWorkflow(discoveryInput());

    expect(
      acts.executeQuery.mock.calls.map(([args]) => ({
        planId: args.planId,
        queryOrdinal: args.queryOrdinal,
        queryReceiptMode: args.queryReceiptMode,
        sourceHint: args.query.filters.source_hint,
      })),
    ).toEqual([
      {
        planId: 'plan-1',
        queryOrdinal: 0,
        queryReceiptMode: QUERY_RECEIPT_MODE,
        sourceHint: 'ted',
      },
      {
        planId: 'plan-1',
        queryOrdinal: 1,
        queryReceiptMode: QUERY_RECEIPT_MODE,
        sourceHint: 'openfda',
      },
      {
        planId: 'plan-1',
        queryOrdinal: 2,
        queryReceiptMode: QUERY_RECEIPT_MODE,
        sourceHint: 'public_web',
      },
    ]);
    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'PARTIAL',
        stats: expect.objectContaining({
          perQuery: {
            ['a'.repeat(64)]: receipts[0],
            ['b'.repeat(64)]: receipts[1],
            ['c'.repeat(64)]: receipts[2],
          },
          perSource: {
            public_intelligence: {
              rawCount: 1,
              quarantinedCount: 2,
              rejectedCount: 1,
              governanceDenied: 3,
              duplicateCount: 9,
              usageQuantity: 1,
              costCents: 12,
              providers: ['openfda', 'public_web', 'ted'],
              provider: 'openfda+public_web+ted',
            },
          },
          rawGovernance: {
            accepted: 1,
            quarantined: 2,
            rejected: 1,
            governanceDenied: 3,
            duplicate: 9,
            usageQuantity: 1,
            costCents: 12,
          },
        }),
      }),
    );
  });

  it('preserves earlier same-class receipts when a later query fails', async () => {
    primeDiscovery();
    acts.loadPlanQueries.mockResolvedValue({
      queries: [
        {
          source_class: 'public_intelligence',
          filters: { source_hint: 'ted' },
          keywords: [],
          priority: 1,
        },
        {
          source_class: 'public_intelligence',
          filters: { source_hint: 'public_web' },
          keywords: ['pump'],
          priority: 2,
        },
      ],
    });
    const receipt = {
      schemaVersion: 'discovery-query-receipt/v1',
      queryKey: 'f'.repeat(64),
      queryOrdinal: 0,
      sourceClass: 'public_intelligence',
      providers: ['ted'],
      accepted: 1,
      quarantined: 0,
      rejected: 0,
      governanceDenied: 0,
      duplicate: 0,
      usageQuantity: 1,
      costCents: 0,
    } as const;
    acts.executeQuery
      .mockResolvedValueOnce({
        rawCount: 1,
        quarantinedCount: 0,
        rejectedCount: 0,
        duplicateCount: 0,
        queryReceipt: receipt,
        provider: 'ted',
        budgetTruncated: false,
      })
      .mockRejectedValueOnce(new Error('provider unavailable'));

    await discoveryWorkflow(discoveryInput());

    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'PARTIAL',
        stats: expect.objectContaining({
          failures: 1,
          perQuery: { [receipt.queryKey]: receipt },
          perSource: {
            public_intelligence: {
              rawCount: 1,
              quarantinedCount: 0,
              rejectedCount: 0,
              governanceDenied: 0,
              duplicateCount: 0,
              usageQuantity: 1,
              costCents: 0,
              providers: ['ted'],
              provider: 'ted',
            },
          },
        }),
      }),
    );
  });

  it.each([
    { ...discoveryInput(), executionContractVersion: undefined },
    { ...discoveryInput(), executionBudget: undefined },
  ])('fails a malformed v2 workflow input non-retryably', async (input) => {
    await expect(discoveryWorkflow(input as never)).rejects.toMatchObject({
      type: 'EXECUTION_BUDGET_WORKFLOW_INPUT_INVALID',
      nonRetryable: true,
    });
    expect(acts.loadPlanQueries).not.toHaveBeenCalled();
  });
});

describe('discoveryWorkflow failure finalization (BI-25)', () => {
  const HAPPY_RECEIPT = {
    schemaVersion: 'discovery-query-receipt/v1',
    queryKey: 'a'.repeat(64),
    queryOrdinal: 0,
    sourceClass: 'official_registry',
    providers: ['gleif'],
    accepted: 1,
    quarantined: 0,
    rejected: 0,
    governanceDenied: 0,
    duplicate: 0,
    usageQuantity: 1,
    costCents: 0,
  };
  const HAPPY_QUERY_STATS = {
    perSource: {
      official_registry: {
        rawCount: 1,
        quarantinedCount: 0,
        rejectedCount: 0,
        governanceDenied: 0,
        duplicateCount: 0,
        usageQuantity: 1,
        costCents: 0,
        providers: ['gleif'],
        provider: 'gleif',
      },
    },
    perQuery: { ['a'.repeat(64)]: HAPPY_RECEIPT },
    rawGovernance: {
      accepted: 1,
      quarantined: 0,
      rejected: 0,
      governanceDenied: 0,
      duplicate: 0,
      usageQuantity: 1,
      costCents: 0,
    },
  };

  it('finalizes a successful run exactly as before and never asks for the failure patch', async () => {
    const asked: string[] = [];
    setPatched((patchId) => {
      asked.push(patchId);
      return true;
    });
    primeDiscovery();

    await discoveryWorkflow(discoveryInput());

    expect(asked).not.toContain(DISCOVERY_FAILURE_FINALIZE_PATCH);
    expect(acts.finalizeRun).toHaveBeenCalledOnce();
    expect(acts.finalizeRun).toHaveBeenCalledWith({
      workspaceId: WS,
      runId: 'run-1',
      planId: 'plan-1',
      icpId: 'icp-1',
      status: 'DONE',
      stats: {
        ...HAPPY_QUERY_STATS,
        companies: 1,
        suppressed: 0,
        fit: { match: 1 },
        fitSkippedForBudget: 0,
        fitUnjudged: 0,
        discoveryBudgetTruncated: false,
        enrichBudgetTruncated: false,
        signalsBudgetTruncated: false,
        budgetTruncated: false,
        skippedSubjects: 0,
        websiteProfile: { profiled: 1, matched: 1, unclassified: 0 },
        enrich: { matched: 1, of: 1, provider: 'gleif' },
        signals: { matched: 1, of: 1, provider: 'public_web' },
        watches: { registered: 1, of: 1 },
        patentEnqueue: { enqueued: 1, of: 1 },
        queries: 1,
        failures: 0,
      },
      executionContractVersion: 2,
      executionBudget: DISCOVERY_BUDGET,
    });
  });

  it('records a fit stage that failed after its retries as FAILED, with the stage and error type, then fails', async () => {
    primeDiscovery();
    // The type is the last attempt's. In production a lost fit call is usually
    // retried into BudgetOperationReplayError (covered below); a transport
    // failure surfaces as itself only when it ends the last attempt.
    const transport = activityFailure('qualifyFitForRun', 'ProviderTransportError');
    acts.qualifyFitForRun.mockRejectedValue(transport);

    await expect(discoveryWorkflow(discoveryInput())).rejects.toBe(transport);

    expect(acts.finalizeRun).toHaveBeenCalledOnce();
    expect(acts.finalizeRun).toHaveBeenCalledWith({
      workspaceId: WS,
      runId: 'run-1',
      planId: 'plan-1',
      icpId: 'icp-1',
      status: 'FAILED',
      // The query totals keep the exact shape finalizeRun checks against the stored receipts.
      stats: {
        ...HAPPY_QUERY_STATS,
        queries: 1,
        failures: 0,
        failure: {
          stage: 'fit',
          errorType: 'ProviderTransportError',
          control: false,
        },
      },
      executionContractVersion: 2,
      executionBudget: DISCOVERY_BUDGET,
    });
    expect(acts.finalizeRun.mock.invocationCallOrder[0]).toBeGreaterThan(
      acts.qualifyFitForRun.mock.invocationCallOrder[0]!,
    );
    for (const later of [
      'enrichRun',
      'enrichSignalsRun',
      'registerWatchesForRun',
      'enqueuePatentLookupsForRun',
    ]) {
      expect(acts[later], later).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['loadPlanQueries', 'plan', 0],
    ['canonicalizeRun', 'canonicalize', 1],
    ['qualifyFitForRun', 'fit', 1],
    ['enrichRun', 'enrich', 1],
  ] as const)(
    'records FAILED when %s fails for an ordinary reason',
    async (activityName, stage, queries) => {
      primeDiscovery();
      const failure = activityFailure(activityName, 'PrismaClientKnownRequestError');
      acts[activityName].mockRejectedValue(failure);

      await expect(discoveryWorkflow(discoveryInput())).rejects.toBe(failure);

      expect(acts.finalizeRun).toHaveBeenCalledOnce();
      expect(acts.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'FAILED',
          stats: expect.objectContaining({
            queries,
            failure: {
              stage,
              errorType: 'PrismaClientKnownRequestError',
              control: false,
            },
          }),
        }),
      );
    },
  );

  it.each([
    ['executeQuery', 'query', 'BudgetOperationReplayError'],
    ['canonicalizeRun', 'canonicalize', 'ExecutionBudgetGrantError'],
    ['profileWebsitesForRun', 'websiteProfile', 'ExecutionBudgetGrantError'],
    ['qualifyFitForRun', 'fit', 'BudgetOperationReplayError'],
    ['enrichRun', 'enrich', 'ExecutionControlError'],
  ] as const)(
    'still surfaces a control stop from %s after recording the run FAILED',
    async (activityName, stage, type) => {
      primeDiscovery();
      const control = activityFailure(activityName, type);
      acts[activityName].mockRejectedValue(control);

      await expect(discoveryWorkflow(discoveryInput())).rejects.toBe(control);

      expect(acts.finalizeRun).toHaveBeenCalledOnce();
      expect(acts.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'FAILED',
          stats: expect.objectContaining({
            failure: { stage, errorType: type, control: true },
          }),
        }),
      );
    },
  );

  it('keeps the receipts already returned when a later query stops on a control error', async () => {
    primeDiscovery();
    acts.loadPlanQueries.mockResolvedValue({
      queries: [
        { source_class: 'official_registry', filters: {}, keywords: [], priority: 1 },
        { source_class: 'public_intelligence', filters: {}, keywords: ['pump'], priority: 2 },
      ],
    });
    const replay = activityFailure('executeQuery', 'BudgetOperationReplayError');
    acts.executeQuery
      .mockResolvedValueOnce({
        rawCount: 1,
        quarantinedCount: 0,
        rejectedCount: 0,
        duplicateCount: 0,
        queryReceipt: HAPPY_RECEIPT,
        provider: 'gleif',
        budgetTruncated: false,
      })
      .mockRejectedValueOnce(replay);

    await expect(discoveryWorkflow(discoveryInput())).rejects.toBe(replay);

    expect(acts.canonicalizeRun).not.toHaveBeenCalled();
    expect(acts.finalizeRun).toHaveBeenCalledOnce();
    expect(acts.finalizeRun.mock.calls[0]![0]).toMatchObject({
      status: 'FAILED',
      stats: {
        ...HAPPY_QUERY_STATS,
        queries: 2,
        failures: 0,
        failure: {
          stage: 'query',
          errorType: 'BudgetOperationReplayError',
          control: true,
        },
      },
    });
  });

  it('records a pre-receipt Raw-governance history without receipt fields', async () => {
    setPatched((patchId) => patchId !== 'discovery-query-receipt-input-v1');
    primeDiscovery();
    acts.executeQuery.mockResolvedValue({
      rawCount: 1,
      quarantinedCount: 2,
      rejectedCount: 3,
      duplicateCount: 4,
      costCents: 0,
      provider: 'gleif',
      budgetTruncated: false,
    });
    const failure = activityFailure('enrichRun', 'Error');
    acts.enrichRun.mockRejectedValue(failure);

    await expect(discoveryWorkflow(discoveryInput())).rejects.toBe(failure);

    const stats = acts.finalizeRun.mock.calls[0]![0].stats;
    expect(stats).not.toHaveProperty('perQuery');
    expect(stats).toEqual({
      perSource: {
        official_registry: {
          rawCount: 1,
          quarantinedCount: 2,
          rejectedCount: 3,
          duplicateCount: 4,
          provider: 'gleif',
        },
      },
      rawGovernance: { accepted: 1, quarantined: 2, rejected: 3, duplicate: 4 },
      queries: 1,
      failures: 0,
      failure: { stage: 'enrich', errorType: 'Error', control: false },
    });
  });

  it('surfaces the stage error, not the bookkeeping error, when recording FAILED also fails', async () => {
    primeDiscovery();
    const transport = activityFailure('qualifyFitForRun', 'ProviderTransportError');
    acts.qualifyFitForRun.mockRejectedValue(transport);
    acts.finalizeRun.mockRejectedValue(
      activityFailure('finalizeRun', 'ExecutionBudgetGrantError'),
    );

    await expect(discoveryWorkflow(discoveryInput())).rejects.toBe(transport);
    expect(acts.finalizeRun).toHaveBeenCalledOnce();
  });

  it('leaves a bug in workflow code to fail the workflow task, without recording the run', async () => {
    const asked: string[] = [];
    setPatched((patchId) => {
      asked.push(patchId);
      return true;
    });
    primeDiscovery();
    // A malformed activity result breaks the workflow code itself: Temporal fails
    // the workflow task and retries it, so a fixed build can still resume the run.
    acts.loadPlanQueries.mockResolvedValue({});

    await expect(discoveryWorkflow(discoveryInput())).rejects.toBeInstanceOf(TypeError);
    expect(asked).not.toContain(DISCOVERY_FAILURE_FINALIZE_PATCH);
    expect(acts.finalizeRun).not.toHaveBeenCalled();
  });

  it('still records a cancelled run, in a scope the cancellation cannot reach', async () => {
    const nonCancellable = vi.spyOn(CancellationScope, 'nonCancellable');
    try {
      primeDiscovery();
      const cancelled = new CancelledFailure('Workflow cancelled');
      acts.qualifyFitForRun.mockRejectedValue(cancelled);

      await expect(discoveryWorkflow(discoveryInput())).rejects.toBe(cancelled);

      expect(nonCancellable).toHaveBeenCalledOnce();
      expect(acts.finalizeRun).toHaveBeenCalledOnce();
      expect(acts.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'FAILED',
          stats: expect.objectContaining({
            failure: { stage: 'fit', errorType: 'CancelledFailure', control: true },
          }),
        }),
      );
    } finally {
      nonCancellable.mockRestore();
    }
  });

  /** Routes the workflow's finalizeRun through the real activity over a locked run row. */
  function realFinalizeRun(storedReceipts: Record<string, unknown>) {
    const update = vi.fn(async () => ({}));
    const outboxCreate = vi.fn(async () => ({}));
    const tx = {
      $queryRaw: vi.fn(async () => [
        {
          id: 'run-1',
          plan_id: 'plan-1',
          stats: { perQuery: storedReceipts },
          status: 'RUNNING',
        },
      ]),
      discoveryRun: { update },
      discoveryQueryPlan: { update: vi.fn(async () => ({})) },
      outboxEvent: { create: outboxCreate },
    };
    const activities = createDiscoveryActivities({
      prisma: {
        withWorkspace: async (
          _workspaceId: string,
          callback: (client: typeof tx) => Promise<unknown>,
        ) => callback(tx),
      },
      providers: {},
      gateway: {},
      budgetStore: {
        attestAuthorized: vi.fn(async (input: { authorityId: string }) => ({
          accountId: '40000000-0000-4000-8000-000000000004',
          authorityId: input.authorityId,
          authorizedCapMicrousd: 1_000_000n,
          generation: 1,
        })),
      },
    } as never);
    acts.finalizeRun.mockImplementation((args) => activities.finalizeRun(args));
    return { update, outboxCreate };
  }

  it('passes the real finalizeRun receipt check with the FAILED stats it builds', async () => {
    primeDiscovery();
    const { update, outboxCreate } = realFinalizeRun({
      [HAPPY_RECEIPT.queryKey]: HAPPY_RECEIPT,
    });
    const replay = activityFailure('qualifyFitForRun', 'BudgetOperationReplayError');
    acts.qualifyFitForRun.mockRejectedValue(replay);

    await expect(discoveryWorkflow(discoveryInput())).rejects.toBe(replay);

    expect(update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: expect.objectContaining({
        status: 'FAILED',
        stats: {
          ...HAPPY_QUERY_STATS,
          queries: 1,
          failures: 0,
          failure: {
            stage: 'fit',
            errorType: 'BudgetOperationReplayError',
            control: true,
          },
        },
      }),
    });
    expect(outboxCreate).toHaveBeenCalledOnce();
  });

  it('reports the stage error, and leaves the run open, when the store holds a receipt the workflow never saw', async () => {
    primeDiscovery();
    const unseen = { ...HAPPY_RECEIPT, queryKey: 'b'.repeat(64), queryOrdinal: 1 };
    const { update, outboxCreate } = realFinalizeRun({
      [HAPPY_RECEIPT.queryKey]: HAPPY_RECEIPT,
      [unseen.queryKey]: unseen,
    });
    const replay = activityFailure('qualifyFitForRun', 'BudgetOperationReplayError');
    acts.qualifyFitForRun.mockRejectedValue(replay);

    await expect(discoveryWorkflow(discoveryInput())).rejects.toBe(replay);

    expect(acts.finalizeRun).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
    expect(outboxCreate).not.toHaveBeenCalled();
  });

  it('does not follow a failed normal finalization with a FAILED one', async () => {
    primeDiscovery();
    const drift = activityFailure('finalizeRun', 'Error');
    acts.finalizeRun.mockRejectedValue(drift);

    await expect(discoveryWorkflow(discoveryInput())).rejects.toBe(drift);
    expect(acts.finalizeRun).toHaveBeenCalledOnce();
    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'DONE' }),
    );
  });

  it('keeps histories recorded before the patch on their old command sequence', async () => {
    setPatched((patchId) => patchId !== DISCOVERY_FAILURE_FINALIZE_PATCH);
    primeDiscovery();
    const transport = activityFailure('qualifyFitForRun', 'ProviderTransportError');
    acts.qualifyFitForRun.mockRejectedValue(transport);

    await expect(discoveryWorkflow(discoveryInput())).rejects.toBe(transport);
    expect(acts.finalizeRun).not.toHaveBeenCalled();
  });

  it('never asks for the patch on a pre-authority history, whose finalizeRun would be parked', async () => {
    const asked: string[] = [];
    setPatched((patchId) => {
      asked.push(patchId);
      return patchId === DISCOVERY_FAILURE_FINALIZE_PATCH;
    });
    primeDiscovery();
    const transport = activityFailure('qualifyFitForRun', 'ProviderTransportError');
    acts.qualifyFitForRun.mockRejectedValue(transport);

    await expect(
      discoveryWorkflow({
        workspaceId: WS,
        runId: 'run-1',
        planId: 'plan-1',
        icpId: 'icp-1',
      } as never),
    ).rejects.toBe(transport);
    expect(asked).not.toContain(DISCOVERY_FAILURE_FINALIZE_PATCH);
    expect(acts.finalizeRun).not.toHaveBeenCalled();
  });
});

describe('workspace authority Temporal compatibility', () => {
  it('keeps an authority-era non-Raw history on the exact legacy executeQuery shape', async () => {
    setPatched((patchId) => patchId === DISCOVERY_AUTHORITY_PATCH);
    primeDiscovery();

    await discoveryWorkflow(discoveryInput());

    expect(acts.executeQuery).toHaveBeenCalledWith({
      workspaceId: WS,
      runId: 'run-1',
      query: {
        source_class: 'official_registry',
        filters: {},
        keywords: [],
        priority: 1,
      },
      executionContractVersion: 2,
      executionBudget: DISCOVERY_BUDGET,
    });
    expect(acts.finalizeRun.mock.calls[0]![0].stats).not.toHaveProperty(
      'perQuery',
    );
  });

  it('replays a Raw-governance history recorded before the receipt patch without receipt identity or parsing', async () => {
    setPatched(
      (patchId) =>
        patchId === DISCOVERY_AUTHORITY_PATCH ||
        patchId === DISCOVERY_RAW_GOVERNANCE_PATCH,
    );
    primeDiscovery();
    acts.executeQuery.mockResolvedValue({
      rawCount: 1,
      quarantinedCount: 2,
      rejectedCount: 3,
      duplicateCount: 4,
      costCents: 0,
      provider: 'gleif',
      budgetTruncated: false,
    });

    await discoveryWorkflow(discoveryInput());

    expect(acts.executeQuery).toHaveBeenCalledWith({
      workspaceId: WS,
      runId: 'run-1',
      query: {
        source_class: 'official_registry',
        filters: {},
        keywords: [],
        priority: 1,
      },
      executionContractVersion: 2,
      executionBudget: DISCOVERY_BUDGET,
    });
    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'PARTIAL',
        stats: expect.objectContaining({
          perSource: {
            official_registry: {
              rawCount: 1,
              quarantinedCount: 2,
              rejectedCount: 3,
              duplicateCount: 4,
              provider: 'gleif',
            },
          },
          rawGovernance: {
            accepted: 1,
            quarantined: 2,
            rejected: 3,
            duplicate: 4,
          },
        }),
      }),
    );
    expect(acts.finalizeRun.mock.calls[0]![0].stats).not.toHaveProperty(
      'perQuery',
    );
  });

  it('uses the closed receipt identity only when the new Raw receipt patch is present', async () => {
    setPatched(
      (patchId) =>
        patchId === DISCOVERY_AUTHORITY_PATCH ||
        patchId === DISCOVERY_RAW_GOVERNANCE_PATCH ||
        patchId === QUERY_RECEIPT_PATCH,
    );
    primeDiscovery();

    await discoveryWorkflow(discoveryInput());

    expect(acts.executeQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: 'plan-1',
        queryOrdinal: 0,
        queryReceiptMode: QUERY_RECEIPT_MODE,
      }),
    );
    expect(acts.finalizeRun.mock.calls[0]![0].stats).toHaveProperty('perQuery');
  });

  it('replays a pre-authority discovery history with its exact legacy activity argument shapes', async () => {
    setPatched(() => false);
    primeDiscovery();

    await discoveryWorkflow({
      workspaceId: WS,
      runId: 'run-1',
      planId: 'plan-1',
      icpId: 'icp-1',
    } as never);

    expect(acts.resetRunBudget).toHaveBeenCalledWith({
      workspaceId: WS,
      runId: 'run-1',
    });
    expect(acts.loadPlanQueries).toHaveBeenCalledWith({
      workspaceId: WS,
      planId: 'plan-1',
    });
    expect(acts.executeQuery).toHaveBeenCalledWith(
      expect.not.objectContaining({ executionBudget: expect.anything() }),
    );
    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.not.objectContaining({ executionBudget: expect.anything() }),
    );
    for (const activityName of [
      'loadPlanQueries',
      'executeQuery',
      'canonicalizeRun',
      'qualifyFitForRun',
      'enrichRun',
      'enrichSignalsRun',
      'registerWatchesForRun',
      'enqueuePatentLookupsForRun',
      'finalizeRun',
    ]) {
      for (const [args] of acts[activityName].mock.calls) {
        expect(args).not.toHaveProperty('executionContractVersion');
        expect(args).not.toHaveProperty('executionBudget');
      }
    }
  });

  it('replays a pre-authority understanding history with its exact legacy activity argument shapes', async () => {
    setPatched(() => false);
    acts.setStatus.mockResolvedValue(undefined);
    acts.crawlWebsite.mockResolvedValue({
      url: 'https://acme.example/',
      text: 'home',
    });
    acts.selectSubpages.mockResolvedValue([]);
    acts.crawlPages.mockResolvedValue({ pages: [] });
    acts.extractClaims.mockResolvedValue({ claims: [] });
    acts.extractOfferings.mockResolvedValue({ offerings: [] });
    acts.persistClaims.mockResolvedValue(undefined);
    acts.persistOfferings.mockResolvedValue(undefined);
    acts.persistPublicContacts.mockResolvedValue(undefined);
    acts.extractAndPersistProfile.mockResolvedValue(undefined);

    await understandingWorkflow({
      workspaceId: WS,
      companyId: 'company-1',
      website: 'https://acme.example/',
    } as never);

    expect(acts.setStatus).toHaveBeenNthCalledWith(1, {
      companyId: 'company-1',
      workspaceId: WS,
      status: 'ENRICHING',
    });
    expect(acts.selectSubpages).toHaveBeenCalledWith({
      markdown: 'home',
      website: 'https://acme.example/',
    });
    expect(acts.extractClaims).toHaveBeenCalledWith({
      workspaceId: WS,
      text: 'home',
    });
    expect(acts.setStatus).toHaveBeenNthCalledWith(2, {
      companyId: 'company-1',
      workspaceId: WS,
      status: 'REVIEW',
    });
    for (const activityName of [
      'setStatus',
      'crawlWebsite',
      'selectSubpages',
      'crawlPages',
      'extractClaims',
      'extractOfferings',
      'persistClaims',
      'persistOfferings',
      'persistPublicContacts',
      'extractAndPersistProfile',
    ]) {
      for (const [args] of acts[activityName].mock.calls) {
        expect(args).not.toHaveProperty('executionContractVersion');
        expect(args).not.toHaveProperty('executionBudget');
      }
    }
  });

  it('uses explicit v2 workflow and activity inputs for new histories', async () => {
    primeDiscovery();

    await discoveryWorkflow(discoveryInput());

    expect(acts.resetRunBudget).not.toHaveBeenCalled();
    expect(acts.loadPlanQueries).toHaveBeenCalledWith(
      expect.objectContaining({
        executionContractVersion: 2,
        executionBudget: DISCOVERY_BUDGET,
      }),
    );
  });

  it('uses explicit v2 inputs across a new understanding history', async () => {
    acts.setStatus.mockResolvedValue(undefined);
    acts.crawlWebsite.mockResolvedValue({
      url: 'https://acme.example/',
      text: 'home',
    });
    acts.selectSubpages.mockResolvedValue([]);
    acts.crawlPages.mockResolvedValue({ pages: [] });
    acts.extractClaims.mockResolvedValue({ claims: [] });
    acts.extractOfferings.mockResolvedValue({ offerings: [] });
    acts.persistClaims.mockResolvedValue(undefined);
    acts.persistOfferings.mockResolvedValue(undefined);
    acts.persistPublicContacts.mockResolvedValue(undefined);
    acts.extractAndPersistProfile.mockResolvedValue(undefined);

    await understandingWorkflow({
      workspaceId: WS,
      companyId: 'company-1',
      website: 'https://acme.example/',
      executionContractVersion: 2,
      executionBudget: UNDERSTANDING_BUDGET,
    });

    expect(acts.setStatus).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        executionContractVersion: 2,
        executionBudget: UNDERSTANDING_BUDGET,
      }),
    );
    expect(acts.selectSubpages).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        executionContractVersion: 2,
        executionBudget: UNDERSTANDING_BUDGET,
      }),
    );
  });

  it.each([
    {
      workspaceId: WS,
      companyId: 'company-1',
      website: 'https://acme.example/',
      executionBudget: UNDERSTANDING_BUDGET,
    },
    {
      workspaceId: WS,
      companyId: 'company-1',
      website: 'https://acme.example/',
      executionContractVersion: 2 as const,
    },
  ])(
    'fails a malformed understanding v2 input non-retryably',
    async (input) => {
      await expect(understandingWorkflow(input)).rejects.toMatchObject({
        type: 'EXECUTION_BUDGET_WORKFLOW_INPUT_INVALID',
        nonRetryable: true,
      });
      expect(acts.setStatus).not.toHaveBeenCalled();
    },
  );
});
