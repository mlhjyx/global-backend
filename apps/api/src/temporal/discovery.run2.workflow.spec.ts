import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CancelledFailure } from '@temporalio/common';

const child = vi.hoisted(() => ({ executeChild: vi.fn() }));
vi.mock('@temporalio/workflow', async () => ({
  ...(await import('./testing/temporal-workflow.mock')),
  executeChild: child.executeChild,
}));

import { CancellationScope, TemporalFailure, acts, resetActivities, setPatched } from './testing/temporal-workflow.mock';
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

  it('runs the selected procurement search even if the general company pool is deep', async () => {
    acts.prefilterPool.mockResolvedValue({
      poolSize: 0, candidates: 0, prefilteredOut: 0, requiresProcurementSearch: true,
    });
    acts.quickJudgeBatch.mockResolvedValue({
      judged: 25, verdicts: { match: 4, weak: 21 },
      fallbackPerCompany: 0, ruleFallback: 0, failed: 0, skipped: 0,
    });
    acts.materializeProvisionalLeads.mockResolvedValue({ leads: 25 });

    await discoveryWorkflow(input(true));

    expect(acts.prefilterPool).toHaveBeenNthCalledWith(1, expect.objectContaining({ planId: PLAN_ID }));
    expect(acts.loadPlanQueries).toHaveBeenCalledTimes(1);
    expect(acts.prefilterPool).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ planId: PLAN_ID, afterProcurementSearch: true }));
    expect(acts.prefilterPool).toHaveBeenCalledTimes(2);
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

  it('labels a deep-stage child failure with its own stage instead of quickScan (2026-11-04)', async () => {
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
    acts.listDeepTargets.mockResolvedValue({ companyIds: ['c1'] });
    child.executeChild.mockRejectedValueOnce(new TemporalFailure('boom', new Error('socket hang up')));
    acts.deepStageSummary.mockResolvedValue({ done: 0, failed: 0, skipped: 0, remaining: 1 });

    await discoveryWorkflow(input(true)).catch(() => undefined);

    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'FAILED',
        stats: expect.objectContaining({
          failure: expect.objectContaining({ stage: 'deep' }),
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
    let workflowCancelled = false;
    let insideNonCancellable = false;
    const scopeSpy = vi
      .spyOn(CancellationScope, 'nonCancellable')
      .mockImplementation(async (fn) => {
        insideNonCancellable = true;
        try {
          return await fn();
        } finally {
          insideNonCancellable = false;
        }
      });
    child.executeChild.mockImplementationOnce(async () => {
      workflowCancelled = true;
      throw new CancelledFailure('cancelled');
    });
    // Real Temporal throws CancelledFailure for any activity scheduled outside
    // CancellationScope.nonCancellable once the workflow scope is cancelled.
    acts.deepStageSummary.mockImplementation(async () => {
      if (workflowCancelled && !insideNonCancellable) {
        throw new CancelledFailure('activity cancelled outside nonCancellable');
      }
      return { done: 0, failed: 0, skipped: 2, remaining: 0 };
    });

    try {
      await discoveryWorkflow(input(true));
    } finally {
      scopeSpy.mockRestore();
    }

    expect(acts.skipUnfinishedDeepJobs).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN_ID, errorCode: 'DEEP_STOPPED' }),
    );
    expect(acts.deepStageSummary).toHaveBeenCalledTimes(1);
    expect(acts.markRunPhase).not.toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'deep_done' }),
    );
    expect(acts.finalizeRun).toHaveBeenCalledTimes(1);
    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'CANCELLED',
        stats: expect.objectContaining({
          quickScan: expect.objectContaining({ judged: 25, leads: 25 }),
          deep: expect.objectContaining({ stopped: true, skipped: 2, targets: 2 }),
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

  it('Phase 1: registers watches for Run 2.0 completed deep targets and skips on pre-patch replay', async () => {
    const { DISCOVERY_RUN2_WATCHES_PATCH } = await import('./discovery.workflow');
    acts.prefilterPool.mockResolvedValue({ poolSize: 10, candidates: 5, prefilteredOut: 5 });
    acts.quickJudgeBatch.mockResolvedValue({
      judged: 5,
      verdicts: { match: 2, weak: 3 },
      fallbackPerCompany: 0,
      ruleFallback: 0,
      failed: 0,
      skipped: 0,
    });
    acts.materializeProvisionalLeads.mockResolvedValue({ leads: 5 });
    acts.listDeepTargets.mockResolvedValue({ companyIds: ['c1', 'c2'] });
    acts.deepStageSummary.mockResolvedValue({ done: 2, failed: 0, skipped: 0, remaining: 0 });
    acts.registerWatchesForRun.mockResolvedValue({ candidates: 2, registered: 2, skippedSubjects: 0, unreplayable: 0 });

    await discoveryWorkflow(input(true));

    expect(acts.registerWatchesForRun).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE_ID, runId: RUN_ID, icpId: ICP_ID }),
    );
    expect(acts.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'DONE',
        stats: expect.objectContaining({
          watches: { registered: 2, of: 2 },
        }),
      }),
    );

    // Pre-patch replay must NOT schedule registerWatchesForRun
    acts.registerWatchesForRun.mockClear();
    acts.finalizeRun.mockClear();
    setPatched((patchId) => patchId !== DISCOVERY_RUN2_WATCHES_PATCH);

    await discoveryWorkflow(input(true));

    expect(acts.registerWatchesForRun).not.toHaveBeenCalled();
  });
});

describe('manufacturer execution frozen history propagation',()=>{
  it.each(['manufacturer-network/v1','manufacturer-network/v2'] as const)('passes %s and original attempt through the child workflow input',async(manufacturerNetworkRevision)=>{
    const {manufacturerNetworkExecutionSnapshot}=await import('../discovery/manufacturer-network-execution');
    const snapshot=manufacturerNetworkExecutionSnapshot(PLAN_ID,{attemptId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',manufacturerNetworkRevision})!;
    acts.prefilterPool.mockResolvedValue({poolSize:30,candidates:25,prefilteredOut:5});
    acts.quickJudgeBatch.mockResolvedValue({judged:25,verdicts:{match:10,weak:15},fallbackPerCompany:0,ruleFallback:0,failed:0,skipped:0});
    acts.materializeProvisionalLeads.mockResolvedValue({leads:25});acts.listDeepTargets.mockResolvedValue({companyIds:['c1']});
    acts.deepStageSummary.mockResolvedValue({done:1,failed:0,skipped:0,remaining:0});
    await discoveryWorkflow({workspaceId:WORKSPACE_ID,runId:RUN_ID,planId:PLAN_ID,icpId:ICP_ID,executionContractVersion:2,executionBudget:EXECUTION_BUDGET,run2QuickScan:true,manufacturerNetworkExecution:snapshot} as never);
    expect(child.executeChild).toHaveBeenCalledWith(expect.any(Function),expect.objectContaining({args:[expect.objectContaining({manufacturerNetworkExecution:snapshot,executionContractVersion:2,enrichmentSlot:0})]}));
  });
});
