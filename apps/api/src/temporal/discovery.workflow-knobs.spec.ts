import { beforeEach, describe, expect, it, vi } from 'vitest';

const child = vi.hoisted(() => ({ executeChild: vi.fn() }));
vi.mock('@temporalio/workflow', async () => ({
  ...(await import('./testing/temporal-workflow.mock')),
  executeChild: child.executeChild,
}));

import { acts, resetActivities } from './testing/temporal-workflow.mock';
import { discoveryWorkflow } from './discovery.workflow';
import type { DiscoveryRunInput } from './discovery.activities';

/**
 * B1（L01）：工作流控制流用到的可调常量必须来自启动输入——relay 注入并随 run
 * 写入历史，重放不受后续代码常量变更影响。这里验证三个旋钮真正参与控制流，
 * 且坏输入按纯函数规则收敛。
 */
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

function input(overrides: Partial<DiscoveryRunInput> = {}): DiscoveryRunInput {
  return {
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    planId: PLAN_ID,
    icpId: ICP_ID,
    executionContractVersion: 2,
    executionBudget: EXECUTION_BUDGET,
    ...overrides,
  } as DiscoveryRunInput;
}

function mockQuickScanStage(candidates: number): void {
  acts.prefilterPool.mockResolvedValue({ poolSize: 30, candidates, prefilteredOut: 5 });
  acts.quickJudgeBatch.mockResolvedValue({
    judged: candidates,
    verdicts: { match: 10, weak: candidates - 10 },
    fallbackPerCompany: 0,
    ruleFallback: 0,
    failed: 0,
    skipped: 0,
  });
  acts.materializeProvisionalLeads.mockResolvedValue({ leads: candidates });
  acts.markRunPhase.mockResolvedValue(undefined);
  acts.listDeepTargets.mockResolvedValue({ companyIds: [] });
  acts.deepStageSummary.mockResolvedValue({ done: 0, failed: 0, skipped: 0, remaining: 0 });
  acts.skipUnfinishedDeepJobs.mockResolvedValue({ skipped: 0 });
  acts.runElapsedMinutes.mockResolvedValue({ minutes: 5 });
  acts.finalizeRun.mockResolvedValue(undefined);
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
  acts.runElapsedMinutes.mockResolvedValue({ minutes: 5 });
  acts.finalizeRun.mockResolvedValue(undefined);
  child.executeChild.mockResolvedValue({ stage: 'done' });
}

beforeEach(() => {
  resetActivities();
  vi.clearAllMocks();
  mockLegacyPipeline();
});

describe('池搜索兜底阈值来自输入（run2PoolSearchFallbackThreshold）', () => {
  it('候选数达到输入阈值时跳过整轮搜索', async () => {
    mockQuickScanStage(25);

    await discoveryWorkflow(input({ run2QuickScan: true, run2PoolSearchFallbackThreshold: 25 }));

    expect(acts.loadPlanQueries).not.toHaveBeenCalled();
  });

  it('候选数低于输入阈值时执行有界搜索兜底', async () => {
    mockQuickScanStage(25);

    await discoveryWorkflow(input({ run2QuickScan: true, run2PoolSearchFallbackThreshold: 26 }));

    expect(acts.loadPlanQueries).toHaveBeenCalledTimes(1);
  });

  it('输入缺省时保持现值 20（旧历史重放语义）', async () => {
    mockQuickScanStage(20);
    await discoveryWorkflow(input({ run2QuickScan: true }));
    expect(acts.loadPlanQueries).not.toHaveBeenCalled();

    resetActivities();
    mockLegacyPipeline();
    mockQuickScanStage(19);
    await discoveryWorkflow(input({ run2QuickScan: true }));
    expect(acts.loadPlanQueries).toHaveBeenCalledTimes(1);
  });

  it('非法阈值收敛：NaN 回落默认 20，越界值夹到边界', async () => {
    mockQuickScanStage(10);
    await discoveryWorkflow(input({ run2QuickScan: true, run2PoolSearchFallbackThreshold: Number.NaN }));
    // NaN → 默认 20，10 < 20 → 搜索
    expect(acts.loadPlanQueries).toHaveBeenCalledTimes(1);

    resetActivities();
    mockLegacyPipeline();
    mockQuickScanStage(10);
    // 越下界 -5 → 夹到 0，10 < 0 为假 → 不搜索
    await discoveryWorkflow(input({ run2QuickScan: true, run2PoolSearchFallbackThreshold: -5 }));
    expect(acts.loadPlanQueries).not.toHaveBeenCalled();
  });
});

describe('深挖并发来自输入（deepCompanyConcurrency）', () => {
  async function runWithConcurrency(concurrency: number | undefined): Promise<number> {
    mockQuickScanStage(25);
    acts.listDeepTargets.mockResolvedValue({ companyIds: ['c1', 'c2', 'c3', 'c4'] });
    acts.deepStageSummary.mockResolvedValue({ done: 4, failed: 0, skipped: 0, remaining: 0 });
    let inFlight = 0;
    let maxInFlight = 0;
    child.executeChild.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return { stage: 'done' };
    });

    await discoveryWorkflow(
      input({
        run2QuickScan: true,
        ...(concurrency === undefined ? {} : { deepCompanyConcurrency: concurrency }),
      }),
    );
    expect(child.executeChild).toHaveBeenCalledTimes(4);
    return maxInFlight;
  }

  it('并发 2 时同时在飞的子工作流不超过 2', async () => {
    expect(await runWithConcurrency(2)).toBe(2);
  });

  it('输入缺省时保持现值 16（4 个目标全部并行）', async () => {
    expect(await runWithConcurrency(undefined)).toBe(4);
  });

  it('非法并发收敛到 1，不会出现零并发死循环', async () => {
    expect(await runWithConcurrency(0)).toBe(1);
  });
});

describe('查询批大小来自输入（discoveryQueryBatchSize）', () => {
  const QUERIES = [1, 2, 3].map((priority) => ({
    source_class: 'official_registry',
    filters: {},
    keywords: [`Pumpen ${priority}`],
    priority,
  }));
  const RECEIPT = (ordinal: number) => ({
    schemaVersion: 'discovery-query-receipt/v1',
    queryKey: `b${ordinal}`.padEnd(64, 'b'),
    queryOrdinal: ordinal,
    sourceClass: 'official_registry',
    providers: ['gleif'],
    accepted: 0,
    quarantined: 0,
    rejected: 0,
    governanceDenied: 0,
    duplicate: 0,
    usageQuantity: 0,
    costCents: 0,
  });

  async function runWithBatch(batch: number | undefined): Promise<number> {
    mockLegacyPipeline();
    acts.loadPlanQueries.mockResolvedValue({ queries: QUERIES });
    let inFlight = 0;
    let maxInFlight = 0;
    acts.executeQuery.mockImplementation(async (args: { queryOrdinal: number }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return {
        rawCount: 0,
        quarantinedCount: 0,
        rejectedCount: 0,
        duplicateCount: 0,
        provider: 'gleif',
        budgetTruncated: false,
        queryReceipt: RECEIPT(args.queryOrdinal),
      };
    });

    await discoveryWorkflow(
      input(batch === undefined ? {} : { discoveryQueryBatchSize: batch }),
    );
    expect(acts.executeQuery).toHaveBeenCalledTimes(3);
    return maxInFlight;
  }

  it('批 1 时查询逐个调度', async () => {
    expect(await runWithBatch(1)).toBe(1);
  });

  it('输入缺省时保持现值 2', async () => {
    expect(await runWithBatch(undefined)).toBe(2);
  });

  it('非法批大小收敛到 1', async () => {
    expect(await runWithBatch(0)).toBe(1);
  });
});
