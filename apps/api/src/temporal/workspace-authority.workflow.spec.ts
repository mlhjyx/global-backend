import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock(
  '@temporalio/workflow',
  () => import('./testing/temporal-workflow.mock'),
);

import {
  acts,
  resetActivities,
  setPatched,
} from './testing/temporal-workflow.mock';
import { discoveryWorkflow } from './discovery.workflow';
import { understandingWorkflow } from './understanding.workflow';

const WS = '10000000-0000-4000-8000-000000000001';
const SHA = 'a'.repeat(64);
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

function wrappedControl(code: string) {
  return {
    name: 'ActivityFailure',
    message: 'Activity task failed',
    cause: { type: 'ApplicationFailure', cause: { code } },
  };
}

beforeEach(() => resetActivities());

describe('discoveryWorkflow execution-control propagation', () => {
  it.each([
    'executeQuery',
    'enrichSignalsRun',
    'registerWatchesForRun',
    'enqueuePatentLookupsForRun',
  ])(
    'rethrows wrapped controls from %s instead of finalizing EXECUTED/PARTIAL',
    async (activityName) => {
      primeDiscovery();
      const failure = wrappedControl(
        activityName === 'executeQuery'
          ? 'BUDGET_OPERATION_REPLAY_UNAVAILABLE'
          : 'EXECUTION_BUDGET_AUTHORITY_REVOKED',
      );
      acts[activityName].mockRejectedValue(failure);

      await expect(discoveryWorkflow(discoveryInput())).rejects.toBe(failure);
      expect(acts.finalizeRun).not.toHaveBeenCalled();
    },
  );

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

    expect(acts.executeQuery.mock.calls.map(([args]) => ({
      planId: args.planId,
      queryOrdinal: args.queryOrdinal,
      sourceHint: args.query.filters.source_hint,
    }))).toEqual([
      { planId: 'plan-1', queryOrdinal: 0, sourceHint: 'ted' },
      { planId: 'plan-1', queryOrdinal: 1, sourceHint: 'openfda' },
      { planId: 'plan-1', queryOrdinal: 2, sourceHint: 'public_web' },
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

describe('workspace authority Temporal compatibility', () => {
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
