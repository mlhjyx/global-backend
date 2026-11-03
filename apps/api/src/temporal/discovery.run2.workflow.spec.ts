import { beforeEach, describe, expect, it, vi } from 'vitest';

const child = vi.hoisted(() => ({ executeChild: vi.fn() }));
vi.mock('@temporalio/workflow', async () => ({
  ...(await import('./testing/temporal-workflow.mock')),
  executeChild: child.executeChild,
}));

import { acts, resetActivities } from './testing/temporal-workflow.mock';
import { discoveryWorkflow } from './discovery.workflow';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const PLAN_ID = '33333333-3333-4333-8333-333333333333';
const ICP_ID = '44444444-4444-4444-8444-444444444444';

const EXECUTION_BUDGET = {
  authorityId: '55555555-5555-4555-8555-555555555555',
  replay: false,
  scopeKey: WORKSPACE_ID,
  accountKey: `discovery.run:discovery_run:request:${'c'.repeat(64)}:${'c'.repeat(64)}`,
  purpose: 'discovery.run',
  subjectType: 'discovery_run',
  subjectId: `request:${'c'.repeat(64)}`,
  requestSha256: 'c'.repeat(64),
};

function input(run2QuickScan?: boolean, run2Shadow?: boolean) {
  return {
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    planId: PLAN_ID,
    icpId: ICP_ID,
    executionContractVersion: 2 as const,
    executionBudget: EXECUTION_BUDGET,
    ...(run2QuickScan === undefined ? {} : { run2QuickScan }),
    ...(run2Shadow === undefined ? {} : { run2Shadow }),
  } as never;
}

function mockLegacyPipeline(): void {
  acts.loadPlanQueries.mockResolvedValue({ queries: [] });
  acts.canonicalizeRun.mockResolvedValue({ companies: 0, suppressed: 0 });
  acts.profileWebsitesForRun.mockResolvedValue({ profiled: 0, matched: 0 });
  acts.qualifyFitForRun.mockResolvedValue({
    judged: 0,
    verdicts: {},
    skippedForBudget: 0,
    unjudged: 0,
    nextCompanyId: null,
    previousCallCut: false,
    unreplayable: 0,
  });
  acts.enrichRun.mockResolvedValue({ enriched: 0, matched: 0, provider: null, budgetTruncated: false });
  acts.enrichSignalsRun.mockResolvedValue({ matched: 0, enriched: 0, provider: null });
  acts.discoverRunContacts.mockResolvedValue({
    companies: 0,
    people: 0,
    emails: 0,
    phones: 0,
    skipped: true,
    budgetTruncated: false,
  });
  acts.registerWatchesForRun.mockResolvedValue({
    candidates: 0,
    registered: 0,
    skippedSubjects: 0,
    unreplayable: 0,
  });
  acts.enqueuePatentLookupsForRun.mockResolvedValue({ candidates: 0, enqueued: 0 });
  acts.finalizeRun.mockResolvedValue(undefined);
  acts.listDeepTargets.mockResolvedValue({ companyIds: [] });
  acts.deepStageSummary.mockResolvedValue({ done: 0, failed: 0, skipped: 0, remaining: 0 });
  acts.skipUnfinishedDeepJobs.mockResolvedValue({ skipped: 0 });
  acts.markRunPhase.mockResolvedValue(undefined);
  acts.runElapsedMinutes.mockResolvedValue({ minutes: 5 });
  acts.recordRunShadowDiff.mockResolvedValue({
    legacyJudged: 4,
    legacyPositive: 3,
    shadowJudged: 5,
    shadowPositive: 5,
    agreement: 4,
    compared: 4,
    recallNotLower: true,
  });
  child.executeChild.mockResolvedValue({ stage: 'done' });
}

beforeEach(() => {
  resetActivities();
  mockLegacyPipeline();
});

describe('M0③ 快扫编排（patched + 启动开关）', () => {
  it('consumes the company pool without any search when the pool is deep enough', async () => {
    acts.prefilterPool.mockResolvedValue({ poolSize: 30, candidates: 25, prefilteredOut: 5 });
    acts.quickJudgeBatch.mockResolvedValue({
      judged: 20,
      verdicts: { match: 8, weak: 12 },
      fallbackPerCompany: 1,
      ruleFallback: 0,
      failed: 0,
      skipped: 0,
    });
    acts.materializeProvisionalLeads.mockResolvedValue({ leads: 20 });

    await discoveryWorkflow(input(true));

    expect(acts.loadPlanQueries).not.toHaveBeenCalled();
    expect(acts.canonicalizeRun).not.toHaveBeenCalled();
    expect(acts.prefilterPool).toHaveBeenCalledTimes(1);
    expect(acts.quickJudgeBatch).toHaveBeenCalledTimes(1);
    expect(acts.materializeProvisionalLeads).toHaveBeenCalledTimes(1);
    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'DONE',
        stats: expect.objectContaining({
          quickScan: expect.objectContaining({
            poolSize: 30,
            candidates: 25,
            prefilteredOut: 5,
            judged: 20,
            leads: 20,
          }),
        }),
      }),
    );
  });

  it('falls back to one bounded search when the pool is short, then pre-filters again', async () => {
    acts.prefilterPool
      .mockResolvedValueOnce({ poolSize: 5, candidates: 5, prefilteredOut: 0 })
      .mockResolvedValueOnce({ poolSize: 32, candidates: 27, prefilteredOut: 5 });
    acts.quickJudgeBatch.mockResolvedValue({
      judged: 27,
      verdicts: { match: 10, weak: 17 },
      fallbackPerCompany: 0,
      ruleFallback: 0,
      failed: 0,
      skipped: 0,
    });
    acts.materializeProvisionalLeads.mockResolvedValue({ leads: 27 });

    await discoveryWorkflow(input(true));

    expect(acts.loadPlanQueries).toHaveBeenCalledTimes(1);
    expect(acts.canonicalizeRun).toHaveBeenCalledTimes(1);
    expect(acts.prefilterPool).toHaveBeenCalledTimes(2);
    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'DONE',
        stats: expect.objectContaining({ quickScan: expect.objectContaining({ candidates: 27 }) }),
      }),
    );
  });

  it('keeps the legacy orchestration when the start input does not enable Run 2.0', async () => {
    await discoveryWorkflow(input());

    expect(acts.prefilterPool).not.toHaveBeenCalled();
    expect(acts.quickJudgeBatch).not.toHaveBeenCalled();
    expect(acts.loadPlanQueries).toHaveBeenCalledTimes(1);
    expect(acts.finalizeRun).toHaveBeenCalled();
  });

  it('reports FAILED when the quick judge produced no verdict at all', async () => {
    acts.prefilterPool.mockResolvedValue({ poolSize: 30, candidates: 25, prefilteredOut: 5 });
    acts.quickJudgeBatch.mockResolvedValue({
      judged: 0,
      verdicts: {},
      fallbackPerCompany: 0,
      ruleFallback: 0,
      failed: 25,
      skipped: 0,
    });
    acts.materializeProvisionalLeads.mockResolvedValue({ leads: 0 });

    await discoveryWorkflow(input(true));

    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'FAILED' }),
    );
  });

  it('runs one child workflow per deep target and finalizes from the deep summary', async () => {
    acts.prefilterPool.mockResolvedValue({ poolSize: 30, candidates: 25, prefilteredOut: 5 });
    acts.quickJudgeBatch.mockResolvedValue({
      judged: 25,
      verdicts: { match: 10, weak: 15 },
      fallbackPerCompany: 0,
      ruleFallback: 0,
      failed: 0,
      skipped: 0,
    });
    acts.materializeProvisionalLeads.mockResolvedValue({ leads: 25 });
    acts.listDeepTargets.mockResolvedValue({ companyIds: ['c1', 'c2', 'c3'] });
    acts.deepStageSummary.mockResolvedValue({ done: 3, failed: 0, skipped: 0, remaining: 0 });

    await discoveryWorkflow(input(true));

    expect(child.executeChild).toHaveBeenCalledTimes(3);
    expect(child.executeChild).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        workflowId: expect.stringContaining('discovery-'),
      }),
    );
    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'DONE',
        stats: expect.objectContaining({
          deep: expect.objectContaining({ targets: 3, done: 3, stopped: false }),
        }),
      }),
    );
  });

  it('marks unfinished companies and finalizes CANCELLED when the run is cancelled mid-deep', async () => {
    acts.prefilterPool.mockResolvedValue({ poolSize: 30, candidates: 25, prefilteredOut: 5 });
    acts.quickJudgeBatch.mockResolvedValue({
      judged: 25,
      verdicts: { match: 10, weak: 15 },
      fallbackPerCompany: 0,
      ruleFallback: 0,
      failed: 0,
      skipped: 0,
    });
    acts.materializeProvisionalLeads.mockResolvedValue({ leads: 25 });
    acts.listDeepTargets.mockResolvedValue({ companyIds: ['c1', 'c2'] });
    child.executeChild.mockRejectedValueOnce(
      Object.assign(new Error('cancelled'), { name: 'CancelledFailure' }),
    );
    acts.deepStageSummary.mockResolvedValue({ done: 0, failed: 0, skipped: 2, remaining: 0 });

    await discoveryWorkflow(input(true));

    expect(acts.skipUnfinishedDeepJobs).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN_ID, errorCode: 'DEEP_STOPPED' }),
    );
    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'CANCELLED',
        stats: expect.objectContaining({
          deep: expect.objectContaining({ stopped: true }),
        }),
      }),
    );
  });

  it('records a shadow comparison instead of materialising leads when only shadow mode is on', async () => {
    acts.prefilterPool.mockResolvedValue({ poolSize: 30, candidates: 25, prefilteredOut: 5 });
    acts.quickJudgeBatch.mockResolvedValue({
      judged: 25,
      verdicts: { match: 10, weak: 15 },
      fallbackPerCompany: 0,
      ruleFallback: 0,
      failed: 0,
      skipped: 0,
    });

    await discoveryWorkflow(input(undefined, true));

    expect(acts.materializeProvisionalLeads).not.toHaveBeenCalled();
    expect(acts.listDeepTargets).not.toHaveBeenCalled();
    expect(acts.recordRunShadowDiff).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN_ID, icpId: ICP_ID, shadowFallback: 0 }),
    );
    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        stats: expect.objectContaining({
          shadow: expect.objectContaining({ legacyPositive: 3, shadowPositive: 5, recallNotLower: true }),
        }),
      }),
    );
  });
});
