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
// A literal on purpose: recorded histories carry the id, so renaming it breaks their replay.
const QUERY_FAILURE_STOP_PATCH = 'discovery-query-failure-stop-v1';
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
    ['executeQuery', 'query', 'ExecutionBudgetGrantError'],
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
        // A result recorded before the backfill counter existed reports 0 backfilled companies.
        stats: expect.objectContaining({ websiteProfile: { profiled: 1, matched: 1, unclassified: 0, backfilled: 0 } }),
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

  it('keeps earlier same-class receipts in the FAILED record when a later query activity fails', async () => {
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
    // An ordinary failure after the retries stops the run; the receipts earned before it stay.
    const failed = activityFailure('executeQuery', 'ProviderTransportError');
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
      .mockRejectedValueOnce(failed);

    await expect(discoveryWorkflow(discoveryInput())).rejects.toBe(failed);

    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'FAILED',
        stats: expect.objectContaining({
          failures: 0,
          failure: { stage: 'query', errorType: 'ProviderTransportError', control: false },
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

describe('discoveryWorkflow queries skipped because their source is off (BI-30)', () => {
  const QUERIES = [
    { source_class: 'public_intelligence', filters: { source_hint: 'public_web' }, keywords: ['Pumpen'], priority: 1 },
    { source_class: 'company_registry', filters: { source_hint: 'wikidata' }, keywords: [], priority: 2 },
    { source_class: 'trade_data', filters: {}, keywords: [], priority: 3 },
  ];

  function executed(
    queryOrdinal: number,
    sourceClass: string,
    providers: string[],
    accepted: number,
    skipReason?: string,
  ) {
    return {
      rawCount: accepted,
      quarantinedCount: 0,
      rejectedCount: 0,
      duplicateCount: 0,
      costCents: 0,
      provider: providers.join('+') || null,
      budgetTruncated: false,
      queryReceipt: {
        schemaVersion: 'discovery-query-receipt/v1',
        queryKey: String(queryOrdinal + 1).repeat(64),
        queryOrdinal,
        sourceClass,
        providers,
        accepted,
        quarantined: 0,
        rejected: 0,
        governanceDenied: 0,
        duplicate: 0,
        usageQuantity: accepted,
        costCents: 0,
      },
      ...(skipReason ? { skipReason } : {}),
    };
  }

  it('counts each skipped query by reason and finalizes PARTIAL, not FAILED', async () => {
    primeDiscovery();
    acts.loadPlanQueries.mockResolvedValue({ queries: QUERIES });
    acts.executeQuery
      .mockResolvedValueOnce(executed(0, 'public_intelligence', ['public_web'], 1))
      .mockResolvedValueOnce(executed(1, 'company_registry', [], 0, 'SOURCE_DISABLED'))
      .mockResolvedValueOnce(executed(2, 'trade_data', [], 0, 'SOURCE_UNKNOWN'));

    await discoveryWorkflow(discoveryInput());

    expect(acts.executeQuery).toHaveBeenCalledTimes(3);
    expect(acts.canonicalizeRun).toHaveBeenCalledOnce();
    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'PARTIAL',
        stats: expect.objectContaining({
          queries: 3,
          failures: 0,
          skippedQueries: { SOURCE_DISABLED: 1, SOURCE_UNKNOWN: 1 },
          // Skipped queries still carry their zero receipt, as before.
          perSource: expect.objectContaining({
            company_registry: expect.objectContaining({ rawCount: 0, providers: [] }),
            trade_data: expect.objectContaining({ rawCount: 0, providers: [] }),
          }),
        }),
      }),
    );
  });

  it('keeps a run whose every query was skipped PARTIAL', async () => {
    primeDiscovery();
    acts.loadPlanQueries.mockResolvedValue({ queries: [QUERIES[1]] });
    acts.executeQuery.mockResolvedValue(executed(0, 'company_registry', [], 0, 'SOURCE_DISABLED'));

    await discoveryWorkflow(discoveryInput());

    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'PARTIAL',
        stats: expect.objectContaining({
          failures: 0,
          skippedQueries: { SOURCE_DISABLED: 1 },
        }),
      }),
    );
  });

  it('counts a query skipped for missing governed lineage and finalizes PARTIAL (lineage gate)', async () => {
    primeDiscovery();
    acts.loadPlanQueries.mockResolvedValue({ queries: QUERIES });
    acts.executeQuery
      .mockResolvedValueOnce(executed(0, 'public_intelligence', ['public_web'], 1))
      .mockResolvedValueOnce(executed(1, 'company_registry', [], 0, 'SOURCE_LINEAGE_UNAVAILABLE'))
      .mockResolvedValueOnce(executed(2, 'trade_data', [], 0, 'SOURCE_UNKNOWN'));

    await discoveryWorkflow(discoveryInput());

    expect(acts.canonicalizeRun).toHaveBeenCalledOnce();
    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'PARTIAL',
        stats: expect.objectContaining({
          failures: 0,
          skippedQueries: { SOURCE_LINEAGE_UNAVAILABLE: 1, SOURCE_UNKNOWN: 1 },
        }),
      }),
    );
  });

  it('counts no skip for a reason it does not know', async () => {
    primeDiscovery();
    acts.executeQuery.mockResolvedValue(
      executed(0, 'official_registry', ['gleif'], 1, 'SOMETHING_ELSE'),
    );

    await discoveryWorkflow(discoveryInput());

    const [{ status, stats }] = acts.finalizeRun.mock.calls[0]!;
    expect(status).toBe('DONE');
    expect(stats).not.toHaveProperty('skippedQueries');
  });

  it('records the skips on a run that a later control error fails (BI-25)', async () => {
    primeDiscovery();
    acts.loadPlanQueries.mockResolvedValue({ queries: QUERIES.slice(0, 2) });
    const control = activityFailure('executeQuery', 'ExecutionBudgetGrantError');
    acts.executeQuery
      .mockResolvedValueOnce(executed(0, 'company_registry', [], 0, 'SOURCE_DISABLED'))
      .mockRejectedValueOnce(control);

    await expect(discoveryWorkflow(discoveryInput())).rejects.toBe(control);

    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'FAILED',
        stats: expect.objectContaining({ skippedQueries: { SOURCE_DISABLED: 1 } }),
      }),
    );
  });
});

describe("discoveryWorkflow stages that stopped for the run's admission lease", () => {
  const QUERIES = [0, 1, 2].map((priority) => ({
    source_class: 'public_intelligence',
    filters: {},
    keywords: [],
    priority,
  }));

  function executed(queryOrdinal: number, accepted: number, extra: Record<string, unknown> = {}) {
    return {
      rawCount: accepted,
      quarantinedCount: 0,
      rejectedCount: 0,
      duplicateCount: 0,
      costCents: 0,
      provider: accepted > 0 ? 'public_web' : null,
      budgetTruncated: false,
      queryReceipt: {
        schemaVersion: 'discovery-query-receipt/v1',
        queryKey: String(queryOrdinal + 1).repeat(64),
        queryOrdinal,
        sourceClass: 'public_intelligence',
        providers: accepted > 0 ? ['public_web'] : [],
        accepted,
        quarantined: 0,
        rejected: 0,
        governanceDenied: 0,
        duplicate: 0,
        usageQuantity: accepted,
        costCents: 0,
      },
      ...extra,
    };
  }
  const finalStats = () =>
    (acts.finalizeRun.mock.calls[0]![0] as { status: string; stats: Record<string, unknown> });

  it('finalizes PARTIAL with the fit companies left for the lease, apart from the budget and unjudged counts', async () => {
    primeDiscovery();
    acts.qualifyFitForRun.mockResolvedValueOnce({
      judged: 3,
      verdicts: { match: 3 },
      skippedForBudget: 0,
      unjudged: 0,
      nextCompanyId: null,
      previousCallCut: false,
      skippedForLease: 7,
    });

    await discoveryWorkflow(discoveryInput());

    const { status, stats } = finalStats();
    expect(status).toBe('PARTIAL');
    expect(stats).toMatchObject({
      skippedForLease: { fit: 7 },
      budgetTruncated: false,
      fitUnjudged: 0,
      fitSkippedForBudget: 0,
    });
  });

  it('counts the queries the lease left, apart from the BI-30 skips, and still materializes the rest', async () => {
    primeDiscovery();
    acts.loadPlanQueries.mockResolvedValue({ queries: QUERIES });
    acts.executeQuery
      .mockResolvedValueOnce(executed(0, 1))
      .mockResolvedValueOnce(executed(1, 0, { skippedForLease: true }))
      .mockResolvedValueOnce(executed(2, 0, { skippedForLease: true }));

    await discoveryWorkflow(discoveryInput());

    expect(acts.canonicalizeRun).toHaveBeenCalledOnce();
    const { status, stats } = finalStats();
    expect(status).toBe('PARTIAL');
    expect(stats).toMatchObject({ skippedForLease: { queries: 2 }, failures: 0, queries: 3 });
    expect(stats).not.toHaveProperty('skippedQueries');
  });

  it('adds up what every stage left for the lease across its passes', async () => {
    primeDiscovery();
    acts.profileWebsitesForRun
      .mockResolvedValueOnce({ profiled: 1, matched: 0, skippedSubjects: 0, budgetTruncated: false, nextIndex: 1 })
      .mockResolvedValueOnce({ profiled: 0, matched: 0, skippedSubjects: 0, budgetTruncated: false, nextIndex: null, skippedForLease: 4 });
    acts.enrichRun.mockResolvedValueOnce({ matched: 0, enriched: 1, provider: null, budgetTruncated: false, nextIndex: null, skippedForLease: 2 });
    acts.registerWatchesForRun.mockResolvedValueOnce({ candidates: 3, registered: 0, skippedSubjects: 0, unreplayable: 0, skippedForLease: 3 });

    await discoveryWorkflow(discoveryInput());

    const { status, stats } = finalStats();
    expect(status).toBe('PARTIAL');
    expect(stats.skippedForLease).toEqual({ websiteProfile: 4, enrich: 2, watches: 3 });
  });

  it('fails a run the lease left no query to bring data for, keeping its plan READY', async () => {
    primeDiscovery();
    acts.loadPlanQueries.mockResolvedValue({ queries: QUERIES.slice(0, 2) });
    acts.executeQuery
      .mockResolvedValueOnce(executed(0, 0, { skippedForLease: true }))
      .mockResolvedValueOnce(executed(1, 0, { skippedForLease: true }));

    await discoveryWorkflow(discoveryInput());

    expect(finalStats()).toMatchObject({ status: 'FAILED', stats: { skippedForLease: { queries: 2 } } });
  });

  it('fails a run whose only other queries lost their provider to an unreplayable operation', async () => {
    primeDiscovery();
    acts.loadPlanQueries.mockResolvedValue({ queries: QUERIES.slice(0, 2) });
    acts.executeQuery
      .mockResolvedValueOnce(executed(0, 0, { unreplayable: true }))
      .mockResolvedValueOnce(executed(1, 0, { skippedForLease: true }));

    await discoveryWorkflow(discoveryInput());

    expect(finalStats().status).toBe('FAILED');
  });

  it('fails a run whose only other queries were skipped because their source is off', async () => {
    primeDiscovery();
    acts.loadPlanQueries.mockResolvedValue({ queries: QUERIES.slice(0, 2) });
    acts.executeQuery
      .mockResolvedValueOnce(executed(0, 0, { skipReason: 'SOURCE_DISABLED' }))
      .mockResolvedValueOnce(executed(1, 0, { skippedForLease: true }));

    await discoveryWorkflow(discoveryInput());

    expect(finalStats()).toMatchObject({
      status: 'FAILED',
      stats: { skippedQueries: { SOURCE_DISABLED: 1 }, skippedForLease: { queries: 1 } },
    });
  });

  it('keeps a run PARTIAL when a query that lost one provider still brought records', async () => {
    primeDiscovery();
    acts.loadPlanQueries.mockResolvedValue({ queries: QUERIES.slice(0, 2) });
    acts.executeQuery
      .mockResolvedValueOnce(executed(0, 7, { unreplayable: true }))
      .mockResolvedValueOnce(executed(1, 0, { skippedForLease: true }));

    await discoveryWorkflow(discoveryInput());

    expect(finalStats()).toMatchObject({ status: 'PARTIAL', stats: { failures: 1, skippedForLease: { queries: 1 } } });
  });

  it('keeps what every stage left for the lease in the stats of a run a later stage fails (BI-25)', async () => {
    primeDiscovery();
    acts.loadPlanQueries.mockResolvedValue({ queries: QUERIES });
    acts.executeQuery
      .mockResolvedValueOnce(executed(0, 1))
      .mockResolvedValueOnce(executed(1, 0, { skippedForLease: true }))
      .mockResolvedValueOnce(executed(2, 0, { skippedForLease: true }));
    acts.qualifyFitForRun.mockResolvedValueOnce({
      judged: 2,
      verdicts: { match: 2 },
      skippedForBudget: 0,
      unjudged: 0,
      nextCompanyId: null,
      previousCallCut: false,
      skippedForLease: 4,
    });
    // The case the unchecked signals stage leaves: it overruns the lease and fails the run.
    const control = activityFailure('enrichSignalsRun', 'ExecutionBudgetGrantError');
    acts.enrichSignalsRun.mockRejectedValueOnce(control);

    await expect(discoveryWorkflow(discoveryInput())).rejects.toBe(control);

    const { status, stats } = finalStats();
    expect(status).toBe('FAILED');
    expect(stats.skippedForLease).toEqual({ queries: 2, fit: 4 });
    expect(stats).toMatchObject({ failure: { stage: 'signals' } });
  });

  it('keeps DONE and the stats shape of a run the lease did not cut short', async () => {
    primeDiscovery();

    await discoveryWorkflow(discoveryInput());

    const { status, stats } = finalStats();
    expect(status).toBe('DONE');
    expect(stats).not.toHaveProperty('skippedForLease');
  });
});

describe('discoveryWorkflow model extractions dropped after a failed call', () => {
  const QUERIES = [
    { source_class: 'public_intelligence', filters: { source_hint: 'public_web' }, keywords: ['Pumpen'], priority: 1 },
    { source_class: 'industry_data', filters: { source_hint: 'public_web' }, keywords: ['Pumpen'], priority: 2 },
  ];

  function executed(queryOrdinal: number, accepted: number, modelExtractions?: unknown) {
    return {
      rawCount: accepted,
      quarantinedCount: 0,
      rejectedCount: 0,
      duplicateCount: 0,
      costCents: 0,
      provider: 'public_web',
      budgetTruncated: false,
      queryReceipt: {
        schemaVersion: 'discovery-query-receipt/v1',
        queryKey: String(queryOrdinal + 1).repeat(64),
        queryOrdinal,
        sourceClass: QUERIES[queryOrdinal]!.source_class,
        providers: ['public_web'],
        accepted,
        quarantined: 0,
        rejected: 0,
        governanceDenied: 0,
        duplicate: 0,
        usageQuantity: accepted,
        costCents: 0,
      },
      ...(modelExtractions ? { modelExtractions } : {}),
    };
  }

  it('counts dropped extractions by reason and finalizes PARTIAL', async () => {
    primeDiscovery();
    acts.loadPlanQueries.mockResolvedValue({ queries: QUERIES });
    acts.executeQuery
      .mockResolvedValueOnce(executed(0, 9, {
        invoked: 10,
        failedByReason: { STRUCTURED_OUTPUT_EMPTY_TRUNCATED: 1 },
      }))
      .mockResolvedValueOnce(executed(1, 5, { invoked: 5, failedByReason: {} }));

    await discoveryWorkflow(discoveryInput());

    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'PARTIAL',
        stats: expect.objectContaining({
          failures: 0,
          modelExtractions: {
            invoked: 15,
            failed: 1,
            failedByReason: { STRUCTURED_OUTPUT_EMPTY_TRUNCATED: 1 },
            queriesAllFailed: 0,
          },
        }),
      }),
    );
  });

  it('flags a query whose every model extraction failed', async () => {
    primeDiscovery();
    acts.loadPlanQueries.mockResolvedValue({ queries: QUERIES });
    acts.executeQuery
      .mockResolvedValueOnce(executed(0, 4, { invoked: 4, failedByReason: {} }))
      .mockResolvedValueOnce(executed(1, 0, {
        invoked: 3,
        failedByReason: { STRUCTURED_OUTPUT_EMPTY_TRUNCATED: 2, MODEL_CALL_FAILED: 1 },
      }));

    await discoveryWorkflow(discoveryInput());

    const [{ status, stats }] = acts.finalizeRun.mock.calls[0]!;
    expect(status).toBe('PARTIAL');
    expect(stats).toMatchObject({
      modelExtractions: { invoked: 7, failed: 3, queriesAllFailed: 1 },
    });
  });

  it('fails a run whose every extraction failed with nothing accepted, keeping its plan READY', async () => {
    primeDiscovery();
    acts.loadPlanQueries.mockResolvedValue({ queries: QUERIES });
    acts.executeQuery
      .mockResolvedValueOnce(executed(0, 0, {
        invoked: 3,
        failedByReason: { CHAT_COMPLETIONS_STREAM_TRUNCATED: 3 },
      }))
      .mockResolvedValueOnce(executed(1, 0, {
        invoked: 2,
        failedByReason: { STRUCTURED_OUTPUT_EMPTY_TRUNCATED: 2 },
      }));

    await discoveryWorkflow(discoveryInput());

    const [{ status, stats }] = acts.finalizeRun.mock.calls[0]!;
    expect(status).toBe('FAILED');
    expect(stats).toMatchObject({
      modelExtractions: { invoked: 5, failed: 5, queriesAllFailed: 2 },
    });
  });

  it('keeps DONE and the stats shape when no extraction was dropped', async () => {
    primeDiscovery();
    acts.loadPlanQueries.mockResolvedValue({ queries: QUERIES });
    acts.executeQuery
      .mockResolvedValueOnce(executed(0, 4, { invoked: 4, failedByReason: {} }))
      // An activity result recorded before the counter existed.
      .mockResolvedValueOnce(executed(1, 2));

    await discoveryWorkflow(discoveryInput());

    const [{ status, stats }] = acts.finalizeRun.mock.calls[0]!;
    expect(status).toBe('DONE');
    expect(stats).not.toHaveProperty('modelExtractions');
  });

  it('records the dropped extractions on a run that a later control error fails (BI-25)', async () => {
    primeDiscovery();
    acts.loadPlanQueries.mockResolvedValue({ queries: QUERIES });
    const control = activityFailure('executeQuery', 'ExecutionBudgetGrantError');
    acts.executeQuery
      .mockResolvedValueOnce(executed(0, 3, {
        invoked: 4,
        failedByReason: { STRUCTURED_OUTPUT_EMPTY_TRUNCATED: 1 },
      }))
      .mockRejectedValueOnce(control);

    await expect(discoveryWorkflow(discoveryInput())).rejects.toBe(control);

    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'FAILED',
        stats: expect.objectContaining({
          modelExtractions: {
            invoked: 4,
            failed: 1,
            failedByReason: { STRUCTURED_OUTPUT_EMPTY_TRUNCATED: 1 },
            queriesAllFailed: 0,
          },
        }),
      }),
    );
  });
});

describe('discoveryWorkflow queries that lost a provider to an unreplayable operation', () => {
  const query = (priority: number) => ({
    source_class: 'public_intelligence',
    filters: {},
    keywords: [`Pumpen ${priority}`],
    priority,
  });
  const unreplayable = () => activityFailure('executeQuery', 'BudgetOperationReplayError');
  // What the activity answers once a retry met the lost operation: a zero receipt, flagged.
  const lostQuery = async () => {
    const answered = await acts.executeQuery.getMockImplementation()!();
    return {
      ...answered,
      rawCount: 0,
      unreplayable: true,
      queryReceipt: { ...answered.queryReceipt, accepted: 0, usageQuantity: 0 },
    };
  };
  const handOffOf = (call: number) =>
    (acts.executeQuery.mock.calls[call]![0] as { previousQueryUnreplayable?: unknown })
      .previousQueryUnreplayable;

  it('counts such a query as failed, tells the next query, and runs the rest of the plan', async () => {
    primeDiscovery();
    acts.loadPlanQueries.mockResolvedValue({ queries: [query(1), query(2)] });
    acts.executeQuery.mockResolvedValueOnce(await lostQuery());

    await discoveryWorkflow(discoveryInput());

    expect(acts.executeQuery).toHaveBeenCalledTimes(2);
    expect(handOffOf(0)).toBeUndefined();
    expect(handOffOf(1)).toBe(true);
    expect(acts.canonicalizeRun).toHaveBeenCalled();
    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'PARTIAL',
        stats: expect.objectContaining({
          failures: 1,
          unreplayableSkips: expect.objectContaining({ queries: 1 }),
        }),
      }),
    );
  });

  it('fails the run when the activity reports the second such query in a row', async () => {
    primeDiscovery();
    acts.loadPlanQueries.mockResolvedValue({ queries: [query(1), query(2), query(3)] });
    const second = unreplayable();
    acts.executeQuery.mockResolvedValueOnce(await lostQuery()).mockRejectedValueOnce(second);

    await expect(discoveryWorkflow(discoveryInput())).rejects.toBe(second);

    expect(acts.executeQuery).toHaveBeenCalledTimes(2);
    expect(handOffOf(1)).toBe(true);
    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'FAILED',
        stats: expect.objectContaining({
          failure: { stage: 'query', errorType: 'BudgetOperationReplayError', control: true },
        }),
      }),
    );
  });

  it('counts such queries again once a query in between succeeded, without a hand-off', async () => {
    primeDiscovery();
    acts.loadPlanQueries.mockResolvedValue({ queries: [query(1), query(2), query(3)] });
    const succeeded = await acts.executeQuery.getMockImplementation()!();
    acts.executeQuery
      .mockResolvedValueOnce(await lostQuery())
      .mockResolvedValueOnce(succeeded)
      .mockResolvedValueOnce(await lostQuery());

    await discoveryWorkflow(discoveryInput());

    expect(handOffOf(1)).toBe(true);
    expect(handOffOf(2)).toBeUndefined();
    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'PARTIAL',
        stats: expect.objectContaining({
          failures: 2,
          unreplayableSkips: expect.objectContaining({ queries: 2 }),
        }),
      }),
    );
  });

  it('no longer absorbs a query activity that failed on an unreplayable operation: it left no receipt', async () => {
    primeDiscovery();
    acts.loadPlanQueries.mockResolvedValue({ queries: [query(1), query(2)] });
    const failed = unreplayable();
    acts.executeQuery.mockRejectedValueOnce(failed);

    await expect(discoveryWorkflow(discoveryInput())).rejects.toBe(failed);

    expect(acts.executeQuery).toHaveBeenCalledTimes(1);
    expect(acts.canonicalizeRun).not.toHaveBeenCalled();
    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'FAILED',
        stats: expect.objectContaining({
          failure: { stage: 'query', errorType: 'BudgetOperationReplayError', control: true },
        }),
      }),
    );
  });

  it('counts fit companies the fit pass left unjudged as unreplayable', async () => {
    primeDiscovery();
    acts.qualifyFitForRun.mockResolvedValueOnce({
      judged: 2,
      verdicts: { match: 2 },
      skippedForBudget: 0,
      unjudged: 1,
      unreplayable: 1,
      nextCompanyId: null,
      previousCallCut: false,
    });

    await discoveryWorkflow(discoveryInput());

    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'PARTIAL',
        stats: expect.objectContaining({
          fitUnjudged: 1,
          unreplayableSkips: { queries: 0, websiteProfile: 0, fit: 1, signals: 0, watches: 0 },
        }),
      }),
    );
  });
});

describe('discoveryWorkflow query activities that failed for an ordinary reason', () => {
  const query = (priority: number) => ({
    source_class: 'official_registry',
    filters: {},
    keywords: [`Pumpen ${priority}`],
    priority,
  });
  // What Temporal hands the workflow once the query activity's last attempt failed on a plain
  // error: no receipt was committed, so the materialization admission would hold the run.
  const ordinary = () => activityFailure('executeQuery', 'PrismaClientKnownRequestError');
  const answered = () => acts.executeQuery.getMockImplementation()!();

  it('stops the run at the query stage, before the later queries run: the failed query left no receipt', async () => {
    primeDiscovery();
    acts.loadPlanQueries.mockResolvedValue({ queries: [query(1), query(2), query(3)] });
    const first = await answered();
    const failed = ordinary();
    acts.executeQuery.mockResolvedValueOnce(first).mockRejectedValueOnce(failed);

    await expect(discoveryWorkflow(discoveryInput())).rejects.toBe(failed);

    expect(acts.executeQuery).toHaveBeenCalledTimes(2);
    expect(acts.canonicalizeRun).not.toHaveBeenCalled();
    expect(acts.finalizeRun).toHaveBeenCalledOnce();
    // The receipts already earned stay in the record; the stop is described, not counted.
    expect(acts.finalizeRun.mock.calls[0]![0]).toMatchObject({
      status: 'FAILED',
      stats: {
        perQuery: { [first.queryReceipt.queryKey]: first.queryReceipt },
        queries: 3,
        failures: 0,
        failure: { stage: 'query', errorType: 'PrismaClientKnownRequestError', control: false },
      },
    });
  });

  it('keeps counting the queries that ended with a zero receipt before the stop, not the stop itself', async () => {
    primeDiscovery();
    acts.loadPlanQueries.mockResolvedValue({ queries: [query(1), query(2)] });
    const first = await answered();
    const lost = {
      ...first,
      rawCount: 0,
      unreplayable: true,
      queryReceipt: { ...first.queryReceipt, accepted: 0, usageQuantity: 0 },
    };
    const failed = ordinary();
    acts.executeQuery.mockResolvedValueOnce(lost).mockRejectedValueOnce(failed);

    await expect(discoveryWorkflow(discoveryInput())).rejects.toBe(failed);

    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'FAILED',
        stats: expect.objectContaining({
          failures: 1,
          failure: { stage: 'query', errorType: 'PrismaClientKnownRequestError', control: false },
        }),
      }),
    );
  });

  it('keeps histories recorded before the patch on their old command sequence: the failed query counts and the plan goes on', async () => {
    setPatched((patchId) => patchId !== QUERY_FAILURE_STOP_PATCH);
    primeDiscovery();
    acts.loadPlanQueries.mockResolvedValue({ queries: [query(1), query(2)] });
    acts.executeQuery.mockRejectedValueOnce(ordinary());

    await discoveryWorkflow(discoveryInput());

    expect(acts.executeQuery).toHaveBeenCalledTimes(2);
    expect(acts.canonicalizeRun).toHaveBeenCalled();
    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'PARTIAL',
        stats: expect.objectContaining({ queries: 2, failures: 1 }),
      }),
    );
  });

  it('never asks for the patch on a history recorded before query receipts, which absorbs the failure as before', async () => {
    const asked: string[] = [];
    setPatched((patchId) => {
      asked.push(patchId);
      return patchId !== QUERY_RECEIPT_PATCH;
    });
    primeDiscovery();
    acts.executeQuery.mockRejectedValue(ordinary());

    await discoveryWorkflow(discoveryInput());

    expect(asked).not.toContain(QUERY_FAILURE_STOP_PATCH);
    expect(acts.canonicalizeRun).toHaveBeenCalled();
    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'FAILED',
        stats: expect.objectContaining({
          failures: 1,
          perSource: {
            official_registry: { rawCount: 0, provider: null, error: 'QUERY_EXECUTION_FAILED' },
          },
        }),
      }),
    );
  });
});

describe('discoveryWorkflow company passes handed from one activity to the next', () => {
  const fitPass = (overrides: Record<string, unknown>) => ({
    judged: 0,
    verdicts: {},
    skippedForBudget: 0,
    unjudged: 0,
    nextCompanyId: null,
    previousCallCut: false,
    ...overrides,
  });
  const profilePass = (overrides: Record<string, unknown>) => ({
    profiled: 0,
    matched: 0,
    skippedSubjects: 0,
    budgetTruncated: false,
    unclassified: 0,
    nextIndex: null,
    ...overrides,
  });

  it('runs the fit judge until no company is left and adds up every pass', async () => {
    primeDiscovery();
    acts.qualifyFitForRun
      .mockResolvedValueOnce(
        fitPass({ judged: 2, verdicts: { match: 1, weak: 1 }, nextCompanyId: 'company-2', previousCallCut: true }),
      )
      .mockResolvedValueOnce(fitPass({ judged: 1, verdicts: { match: 1 }, unjudged: 1 }));

    await discoveryWorkflow(discoveryInput());

    expect(acts.qualifyFitForRun).toHaveBeenCalledTimes(2);
    expect(acts.qualifyFitForRun.mock.calls[0]![0]).not.toHaveProperty('afterCompanyId');
    expect(acts.qualifyFitForRun.mock.calls[1]![0]).toMatchObject({
      icpId: 'icp-1',
      afterCompanyId: 'company-2',
      previousCallCut: true,
    });
    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'PARTIAL',
        stats: expect.objectContaining({
          fit: { match: 2, weak: 1 },
          fitUnjudged: 1,
          fitSkippedForBudget: 0,
        }),
      }),
    );
  });

  it('reports the companies a single profile pass backfilled apart from the run’s own (W5-f)', async () => {
    primeDiscovery();
    acts.profileWebsitesForRun.mockResolvedValueOnce(profilePass({ profiled: 2, matched: 1, backfilled: 4 }));

    await discoveryWorkflow(discoveryInput());

    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        stats: expect.objectContaining({ websiteProfile: { profiled: 2, matched: 1, unclassified: 0, backfilled: 4 } }),
      }),
    );
  });

  it('profiles websites until no company is left and adds up every pass', async () => {
    primeDiscovery();
    acts.profileWebsitesForRun
      .mockResolvedValueOnce(profilePass({ profiled: 2, matched: 1, unclassified: 1, backfilled: 1, nextIndex: 2 }))
      .mockResolvedValueOnce(profilePass({ profiled: 1, matched: 1, backfilled: 3 }));

    await discoveryWorkflow(discoveryInput());

    expect(acts.profileWebsitesForRun).toHaveBeenCalledTimes(2);
    expect(acts.profileWebsitesForRun.mock.calls[1]![0]).toMatchObject({ icpId: 'icp-1', startIndex: 2 });
    expect(acts.profileWebsitesForRun.mock.invocationCallOrder[1]).toBeLessThan(
      acts.qualifyFitForRun.mock.invocationCallOrder[0]!,
    );
    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'DONE',
        stats: expect.objectContaining({ websiteProfile: { profiled: 3, matched: 2, unclassified: 1, backfilled: 4 } }),
      }),
    );
  });

  it('stops profiling once a pass reports the run budget spent', async () => {
    primeDiscovery();
    acts.profileWebsitesForRun.mockResolvedValueOnce(
      profilePass({ profiled: 2, matched: 2, budgetTruncated: true, nextIndex: 2 }),
    );

    await discoveryWorkflow(discoveryInput());

    expect(acts.profileWebsitesForRun).toHaveBeenCalledOnce();
    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'PARTIAL', stats: expect.objectContaining({ budgetTruncated: true }) }),
    );
  });

  it('continues a profile pass at its index without carrying unreplayable state', async () => {
    primeDiscovery();
    acts.profileWebsitesForRun
      .mockResolvedValueOnce(profilePass({ profiled: 1, unreplayable: 1, nextIndex: 2 }))
      .mockResolvedValueOnce(profilePass({ profiled: 1 }));

    await discoveryWorkflow(discoveryInput());

    const secondCall = acts.profileWebsitesForRun.mock.calls[1]![0];
    expect(secondCall).toMatchObject({ startIndex: 2 });
    expect(secondCall).not.toHaveProperty('previousUnreplayable');
  });

  it('finalizes PARTIAL and counts companies the best-effort stages skipped as unreplayable', async () => {
    primeDiscovery();
    acts.profileWebsitesForRun.mockResolvedValueOnce(profilePass({ profiled: 2, unreplayable: 1 }));
    acts.enrichSignalsRun.mockResolvedValueOnce({
      matched: 0,
      enriched: 1,
      provider: null,
      budgetTruncated: false,
      skippedSubjects: 0,
      unreplayable: 2,
    });
    acts.registerWatchesForRun.mockResolvedValueOnce({
      candidates: 1,
      registered: 0,
      skippedSubjects: 0,
      unreplayable: 1,
    });

    await discoveryWorkflow(discoveryInput());

    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'PARTIAL',
        stats: expect.objectContaining({
          unreplayableSkips: { queries: 0, websiteProfile: 1, fit: 0, signals: 2, watches: 1 },
        }),
      }),
    );
  });

  it('keeps the stats shape of a run that skipped nothing', async () => {
    primeDiscovery();

    await discoveryWorkflow(discoveryInput());

    const [{ status, stats }] = acts.finalizeRun.mock.calls[0]! as [{ status: string; stats: object }];
    expect(status).toBe('DONE');
    expect(stats).not.toHaveProperty('unreplayableSkips');
  });

  it('enriches until no company is left and adds up every pass', async () => {
    primeDiscovery();
    acts.enrichRun
      .mockResolvedValueOnce({ enriched: 2, matched: 1, provider: 'gleif', budgetTruncated: false, nextIndex: 2 })
      .mockResolvedValueOnce({ enriched: 1, matched: 1, provider: 'gleif', budgetTruncated: false, nextIndex: null });

    await discoveryWorkflow(discoveryInput());

    expect(acts.enrichRun).toHaveBeenCalledTimes(2);
    expect(acts.enrichRun.mock.calls[0]![0]).not.toHaveProperty('startIndex');
    expect(acts.enrichRun.mock.calls[1]![0]).toMatchObject({ icpId: 'icp-1', startIndex: 2 });
    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'DONE',
        stats: expect.objectContaining({ enrich: { matched: 2, of: 3, provider: 'gleif' } }),
      }),
    );
  });

  it('stops enriching once a pass reports the run budget spent', async () => {
    primeDiscovery();
    acts.enrichRun.mockResolvedValueOnce({
      enriched: 2,
      matched: 1,
      provider: 'gleif',
      budgetTruncated: true,
      nextIndex: 2,
    });

    await discoveryWorkflow(discoveryInput());

    expect(acts.enrichRun).toHaveBeenCalledOnce();
    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'PARTIAL',
        stats: expect.objectContaining({ enrichBudgetTruncated: true }),
      }),
    );
  });

  it('keeps the counts of earlier profile passes when a later pass fails, and reports the run PARTIAL', async () => {
    primeDiscovery();
    acts.profileWebsitesForRun
      .mockResolvedValueOnce(profilePass({ profiled: 2, matched: 1, nextIndex: 2 }))
      .mockRejectedValueOnce(new Error('crawler unavailable'));

    await discoveryWorkflow(discoveryInput());

    // Fit still runs, but the companies after the failure go without their profile.
    expect(acts.qualifyFitForRun).toHaveBeenCalled();
    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'PARTIAL',
        stats: expect.objectContaining({
          websiteProfile: { profiled: 2, matched: 1, unclassified: 0, backfilled: 0, stageFailed: true },
        }),
      }),
    );
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
    expect(asked).not.toContain(QUERY_FAILURE_STOP_PATCH);
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
        // W5-f: stats only; the profile result here predates the counter, so 0.
        websiteProfile: { profiled: 1, matched: 1, unclassified: 0, backfilled: 0 },
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
    ['executeQuery', 'query', 'ExecutionBudgetGrantError'],
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
    const replay = activityFailure('executeQuery', 'ExecutionBudgetGrantError');
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
          errorType: 'ExecutionBudgetGrantError',
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

describe('discoveryWorkflow term normalization counters (W2)', () => {
  const query = (priority: number) => ({
    source_class: 'public_intelligence',
    filters: { industry: 'Pumpen' },
    keywords: [],
    priority,
  });
  it('counts the queries whose normalization fell back or skipped the model, without degrading the status', async () => {
    primeDiscovery();
    acts.loadPlanQueries.mockResolvedValue({ queries: [query(1), query(2), query(3)] });
    // Read the primed answer before queueing: getMockImplementation() returns the next queued one.
    const answered = await acts.executeQuery.getMockImplementation()!();
    acts.executeQuery
      .mockResolvedValueOnce({ ...answered, taxonomyFallback: true })
      .mockResolvedValueOnce({ ...answered, taxonomyModelSkipped: true })
      .mockResolvedValueOnce({ ...answered, taxonomyModelSkipped: true });

    await discoveryWorkflow(discoveryInput());

    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'DONE',
        stats: expect.objectContaining({ failures: 0, taxonomyFallback: 1, taxonomyModelSkipped: 2 }),
      }),
    );
  });

  it('keeps the stats shape of a run whose normalization neither fell back nor skipped the model', async () => {
    primeDiscovery();

    await discoveryWorkflow(discoveryInput());

    const [{ stats }] = acts.finalizeRun.mock.calls[0]!;
    expect(stats).not.toHaveProperty('taxonomyFallback');
    expect(stats).not.toHaveProperty('taxonomyModelSkipped');
  });
});
