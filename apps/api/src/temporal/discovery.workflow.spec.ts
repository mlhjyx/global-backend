import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@temporalio/workflow', () => import('./testing/temporal-workflow.mock'));

import { acts, resetActivities, setPatched } from './testing/temporal-workflow.mock';
import { discoveryWorkflow } from './discovery.workflow';

const INPUT = {
  workspaceId: 'ws-1',
  runId: 'run-1',
  planId: 'plan-1',
  icpId: 'icp-1',
};
const QUERY = {
  source_class: 'public_intelligence',
  filters: {},
  keywords: [],
  priority: 1,
};

function mockDownstream(): void {
  acts.resetRunBudget.mockResolvedValue(undefined);
  acts.canonicalizeRun.mockResolvedValue({ companies: 0, suppressed: 0 });
  acts.qualifyFitForRun.mockResolvedValue({
    judged: 0,
    failed: 0,
    verdicts: { match: 0, weak: 0, mismatch: 0 },
    skippedForBudget: 0,
  });
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
  acts.registerWatchesForRun.mockResolvedValue({
    candidates: 0,
    registered: 0,
  });
  acts.enqueuePatentLookupsForRun.mockResolvedValue({
    candidates: 0,
    enqueued: 0,
  });
  acts.finalizeRun.mockResolvedValue(undefined);
}

beforeEach(() => {
  resetActivities();
  mockDownstream();
});

describe('discoveryWorkflow Raw Source v2', () => {
  it('按 provider 跨多个 query 累加真实尝试，不被相同 source_class 的后一次覆盖', async () => {
    acts.loadPlanQueries.mockResolvedValue({
      queries: [
        { ...QUERY, filters: { source_hint: 'wikidata' }, priority: 1 },
        { ...QUERY, filters: { source_hint: 'wikidata' }, priority: 2 },
        { ...QUERY, filters: { source_hint: 'ted' }, priority: 3 },
      ],
    });
    acts.executeQuery
      .mockResolvedValueOnce({
        rawCount: 2,
        quarantinedCount: 0,
        rejectedCount: 0,
        duplicateCount: 1,
        costCents: 0,
        provider: 'wikidata',
        failedProviderCount: 0,
        budgetTruncated: false,
        perProvider: {
          wikidata: {
            attemptedCount: 1,
            successCount: 1,
            zeroResultCount: 0,
            failureCount: 0,
            rawCount: 2,
            quarantinedCount: 0,
            rejectedCount: 0,
            duplicateCount: 1,
          },
        },
      })
      .mockResolvedValueOnce({
        rawCount: 0,
        quarantinedCount: 0,
        rejectedCount: 0,
        duplicateCount: 0,
        costCents: 0,
        provider: null,
        failedProviderCount: 0,
        budgetTruncated: false,
        perProvider: {
          wikidata: {
            attemptedCount: 1,
            successCount: 1,
            zeroResultCount: 1,
            failureCount: 0,
            rawCount: 0,
            quarantinedCount: 0,
            rejectedCount: 0,
            duplicateCount: 0,
          },
        },
      })
      .mockResolvedValueOnce({
        rawCount: 0,
        quarantinedCount: 0,
        rejectedCount: 0,
        duplicateCount: 0,
        costCents: 0,
        provider: null,
        failedProviderCount: 1,
        budgetTruncated: false,
        perProvider: {
          ted: {
            attemptedCount: 1,
            successCount: 0,
            zeroResultCount: 0,
            failureCount: 1,
            rawCount: 0,
            quarantinedCount: 0,
            rejectedCount: 0,
            duplicateCount: 0,
          },
        },
      });

    await discoveryWorkflow(INPUT);

    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        stats: expect.objectContaining({
          perProvider: {
            ted: {
              attemptedCount: 1,
              successCount: 0,
              zeroResultCount: 0,
              failureCount: 1,
              rawCount: 0,
              quarantinedCount: 0,
              rejectedCount: 0,
              duplicateCount: 0,
            },
            wikidata: {
              attemptedCount: 2,
              successCount: 2,
              zeroResultCount: 1,
              failureCount: 0,
              rawCount: 2,
              quarantinedCount: 0,
              rejectedCount: 0,
              duplicateCount: 1,
            },
          },
        }),
      }),
    );
  });

  it('marks a single-source timeout FAILED instead of reporting a false DONE with zero rows', async () => {
    acts.loadPlanQueries.mockResolvedValue({ queries: [QUERY] });
    acts.executeQuery.mockResolvedValue({
      rawCount: 0,
      quarantinedCount: 0,
      rejectedCount: 0,
      duplicateCount: 0,
      costCents: 0,
      provider: null,
      failedProviderCount: 1,
      budgetTruncated: false,
    });

    await discoveryWorkflow(INPUT);

    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'FAILED',
        stats: expect.objectContaining({
          perSource: expect.objectContaining({
            public_intelligence: expect.objectContaining({
              failedProviderCount: 1,
            }),
          }),
        }),
      }),
    );
  });

  it('marks Contracts Finder PARTIAL when three pages still expose a continuation', async () => {
    acts.loadPlanQueries.mockResolvedValue({ queries: [QUERY] });
    acts.executeQuery.mockResolvedValue({
      rawCount: 3,
      quarantinedCount: 0,
      rejectedCount: 0,
      duplicateCount: 0,
      costCents: 0,
      provider: 'uk_contracts_finder',
      failedProviderCount: 0,
      budgetTruncated: false,
      paginationTruncated: true,
    });

    await discoveryWorkflow(INPUT);

    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'PARTIAL',
        stats: expect.objectContaining({
          perSource: expect.objectContaining({
            public_intelligence: expect.objectContaining({ paginationTruncated: true }),
          }),
        }),
      }),
    );
  });

  it('enriches public fit evidence before qualification on new workflow histories', async () => {
    acts.loadPlanQueries.mockResolvedValue({ queries: [] });

    await discoveryWorkflow(INPUT);

    expect(acts.enrichRun).toHaveBeenCalledTimes(2);
    expect(acts.enrichRun).toHaveBeenNthCalledWith(1, {
      workspaceId: INPUT.workspaceId,
      runId: INPUT.runId,
      icpId: INPUT.icpId,
      phase: 'pre_fit_evidence',
    });
    expect(acts.enrichRun.mock.invocationCallOrder[0]).toBeLessThan(
      acts.qualifyFitForRun.mock.invocationCallOrder[0],
    );
    expect(acts.enrichRun).toHaveBeenNthCalledWith(2, {
      workspaceId: INPUT.workspaceId,
      runId: INPUT.runId,
      icpId: INPUT.icpId,
    });
  });

  it('marks a directory-backed SEC submissions failure PARTIAL and preserves enrichment execution facts', async () => {
    acts.loadPlanQueries.mockResolvedValue({ queries: [QUERY] });
    acts.executeQuery.mockResolvedValue({
      rawCount: 1,
      quarantinedCount: 0,
      rejectedCount: 0,
      duplicateCount: 0,
      costCents: 0,
      provider: 'sec_edgar',
      failedProviderCount: 0,
      budgetTruncated: false,
      perProvider: {
        sec_edgar: {
          attemptedCount: 1,
          successCount: 1,
          zeroResultCount: 0,
          failureCount: 0,
          rawCount: 1,
          quarantinedCount: 0,
          rejectedCount: 0,
          duplicateCount: 0,
        },
      },
    });
    acts.canonicalizeRun.mockResolvedValue({
      companies: 1,
      suppressed: 0,
      identityQuality: {
        sec_edgar: {
          acceptedRows: 1,
          namedRows: 1,
          domainRows: 0,
          authorityIdentifierRows: 1,
          officialRegistrationRows: 1,
          boundRows: 1,
          uniqueCompanies: 1,
          conflictRows: 0,
          suppressedRows: 0,
          replayedRows: 0,
        },
      },
    });
    acts.enrichRun
      .mockResolvedValueOnce({
        matched: 0,
        enriched: 1,
        provider: null,
        budgetTruncated: false,
        dataQualityBlocked: true,
        perProvider: {
          sec_edgar: {
            attemptedCount: 1,
            successCount: 0,
            zeroResultCount: 0,
            failureCount: 1,
            rawCount: 0,
            quarantinedCount: 0,
            rejectedCount: 0,
            duplicateCount: 0,
          },
        },
      })
      .mockResolvedValueOnce({
        matched: 0,
        enriched: 0,
        provider: null,
        budgetTruncated: false,
      });

    await discoveryWorkflow(INPUT);

    expect(acts.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({
      status: 'PARTIAL',
      stats: expect.objectContaining({
        dataQualityBlocked: true,
        perProvider: {
          sec_edgar: {
            attemptedCount: 2,
            successCount: 1,
            zeroResultCount: 0,
            failureCount: 1,
            rawCount: 1,
            quarantinedCount: 0,
            rejectedCount: 0,
            duplicateCount: 0,
          },
        },
        identityQuality: {
          sec_edgar: {
            acceptedRows: 1,
            namedRows: 1,
            domainRows: 0,
            authorityIdentifierRows: 1,
            officialRegistrationRows: 1,
            boundRows: 1,
            uniqueCompanies: 1,
            conflictRows: 0,
            suppressedRows: 0,
            replayedRows: 0,
          },
        },
      }),
    }));
  });

  it('merges successful SEC directory and submissions Raw/identity quality without double-counting the company', async () => {
    const execution = {
      attemptedCount: 1,
      successCount: 1,
      zeroResultCount: 0,
      failureCount: 0,
      rawCount: 1,
      quarantinedCount: 0,
      rejectedCount: 0,
      duplicateCount: 0,
    };
    const identity = {
      acceptedRows: 1,
      namedRows: 1,
      domainRows: 0,
      authorityIdentifierRows: 1,
      officialRegistrationRows: 1,
      boundRows: 1,
      uniqueCompanies: 1,
      conflictRows: 0,
      suppressedRows: 0,
      replayedRows: 0,
    };
    acts.loadPlanQueries.mockResolvedValue({ queries: [QUERY] });
    acts.executeQuery.mockResolvedValue({
      rawCount: 1,
      quarantinedCount: 0,
      rejectedCount: 0,
      duplicateCount: 0,
      costCents: 0,
      provider: 'sec_edgar',
      failedProviderCount: 0,
      budgetTruncated: false,
      perProvider: { sec_edgar: execution },
    });
    acts.canonicalizeRun.mockResolvedValue({
      companies: 1,
      suppressed: 0,
      identityQuality: { sec_edgar: identity },
    });
    acts.enrichRun
      .mockResolvedValueOnce({
        matched: 1,
        enriched: 1,
        provider: 'sec_edgar',
        budgetTruncated: false,
        dataQualityBlocked: false,
        perProvider: { sec_edgar: execution },
        identityQuality: { sec_edgar: identity },
      })
      .mockResolvedValueOnce({
        matched: 0,
        enriched: 0,
        provider: null,
        budgetTruncated: false,
      });

    await discoveryWorkflow(INPUT);

    expect(acts.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({
      status: 'DONE',
      stats: expect.objectContaining({
        perProvider: {
          sec_edgar: { ...execution, attemptedCount: 2, successCount: 2, rawCount: 2 },
        },
        identityQuality: {
          sec_edgar: {
            ...identity,
            acceptedRows: 2,
            namedRows: 2,
            authorityIdentifierRows: 2,
            officialRegistrationRows: 2,
            boundRows: 2,
            uniqueCompanies: 1,
          },
        },
      }),
    }));
  });

  it('marks the run PARTIAL and counts a fit judgment failure after discovery data was acquired', async () => {
    acts.loadPlanQueries.mockResolvedValue({ queries: [QUERY] });
    acts.executeQuery.mockResolvedValue({
      rawCount: 1,
      quarantinedCount: 0,
      rejectedCount: 0,
      duplicateCount: 0,
      costCents: 0,
      provider: 'wikidata',
      failedProviderCount: 0,
      budgetTruncated: false,
    });
    acts.canonicalizeRun.mockResolvedValue({ companies: 1, suppressed: 0 });
    acts.qualifyFitForRun.mockResolvedValue({
      judged: 0,
      failed: 1,
      verdicts: { match: 0, weak: 0, mismatch: 0 },
      skippedForBudget: 0,
    });

    await discoveryWorkflow(INPUT);

    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'PARTIAL',
        stats: expect.objectContaining({
          failures: 1,
          sourceFailures: 0,
          fitFailures: 1,
        }),
      }),
    );
  });

  it('marks the run FAILED when an activity fails before normal finalization', async () => {
    const failure = Object.assign(new Error('database credentials rejected'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P1000',
    });
    acts.resetRunBudget.mockRejectedValue(failure);

    await expect(discoveryWorkflow(INPUT)).resolves.toBeUndefined();

    expect(acts.finalizeRun).toHaveBeenCalledTimes(1);
    expect(acts.finalizeRun).toHaveBeenCalledWith({
      workspaceId: INPUT.workspaceId,
      runId: INPUT.runId,
      planId: INPUT.planId,
      icpId: INPUT.icpId,
      status: 'FAILED',
      stats: {
        failure: {
          stage: 'reset_run_budget',
          errorType: 'PrismaClientKnownRequestError',
          errorCode: 'P1000',
        },
      },
    });
    expect(acts.loadPlanQueries).not.toHaveBeenCalled();
  });

  it('records the fatal stage without exposing the raw error message', async () => {
    acts.loadPlanQueries.mockResolvedValue({ queries: [] });
    acts.canonicalizeRun.mockRejectedValue(
      Object.assign(new Error('postgresql://user:secret@database/internal'), {
        name: 'PrismaClientKnownRequestError',
        code: 'P2010',
      }),
    );

    await expect(discoveryWorkflow(INPUT)).resolves.toBeUndefined();

    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'FAILED',
        stats: {
          failure: {
            stage: 'canonicalize_run',
            errorType: 'PrismaClientKnownRequestError',
            errorCode: 'P2010',
          },
        },
      }),
    );
    expect(JSON.stringify(acts.finalizeRun.mock.calls)).not.toContain('secret');
  });

  it('sweeps retention and marks a run PARTIAL when provider rows are quarantined', async () => {
    acts.expireRawSourceRecords.mockResolvedValue({
      expired: 3,
      deferredForConflict: 1,
    });
    acts.loadPlanQueries.mockResolvedValue({ queries: [QUERY] });
    acts.executeQuery.mockResolvedValue({
      rawCount: 0,
      quarantinedCount: 1,
      rejectedCount: 0,
      duplicateCount: 2,
      costCents: 0,
      provider: 'registry',
      budgetTruncated: false,
    });

    await discoveryWorkflow(INPUT);

    expect(acts.expireRawSourceRecords).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      limit: 200,
    });
    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'PARTIAL',
        stats: expect.objectContaining({
          dataQualityBlocked: true,
          rawRetention: { expired: 3, deferredForConflict: 1 },
          perSource: {
            public_intelligence: {
              rawCount: 0,
              quarantinedCount: 1,
              rejectedCount: 0,
              duplicateCount: 2,
              provider: 'registry',
              failedProviderCount: 0,
              paginationTruncated: false,
            },
          },
        }),
      }),
    );
  });

  it('includes provider identity quality in the completed run stats', async () => {
    acts.loadPlanQueries.mockResolvedValue({ queries: [] });
    acts.canonicalizeRun.mockResolvedValue({
      companies: 1,
      suppressed: 0,
      identityQuality: {
        wikidata: {
          acceptedRows: 1,
          namedRows: 1,
          domainRows: 1,
          authorityIdentifierRows: 1,
          officialRegistrationRows: 1,
          boundRows: 1,
          uniqueCompanies: 1,
          conflictRows: 0,
          suppressedRows: 0,
          replayedRows: 0,
        },
      },
    });

    await discoveryWorkflow(INPUT);

    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        stats: expect.objectContaining({
          identityQuality: expect.objectContaining({
            wikidata: expect.objectContaining({ boundRows: 1, uniqueCompanies: 1 }),
          }),
        }),
      }),
    );
  });

  it('does not add the retention activity to pre-v2 Temporal histories', async () => {
    setPatched(() => false);
    acts.loadPlanQueries.mockResolvedValue({ queries: [] });

    await discoveryWorkflow(INPUT);

    expect(acts.expireRawSourceRecords).not.toHaveBeenCalled();
    expect(acts.enrichRun).toHaveBeenCalledTimes(1);
    expect(acts.enrichRun).toHaveBeenCalledWith({
      workspaceId: INPUT.workspaceId,
      runId: INPUT.runId,
      icpId: INPUT.icpId,
    });
    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'DONE',
        stats: expect.objectContaining({
          rawRetention: { expired: 0, deferredForConflict: 0 },
        }),
      }),
    );
    const terminalStats = acts.finalizeRun.mock.calls[0]?.[0]?.stats;
    expect(terminalStats).not.toHaveProperty('perProvider');
  });
});
