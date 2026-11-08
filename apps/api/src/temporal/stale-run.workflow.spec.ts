import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@temporalio/workflow', () => import('./testing/temporal-workflow.mock'));

import { acts, resetActivities } from './testing/temporal-workflow.mock';
import { staleRunSweepWorkflow } from './stale-run.workflow';
import { DISCOVERY_RUN_STALE_AFTER_MS, STALE_RUN_SWEEP_LIMIT } from './discovery-run-lifecycle';

const ROW = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  planId: '33333333-3333-4333-8333-333333333333',
  icpId: '44444444-4444-4444-8444-444444444444',
  createdAt: '2026-11-07T18:39:20.248Z',
};

beforeEach(() => {
  resetActivities();
});

/**
 * B3（审计 F2）：看门狗扫描超期 RUNNING 的 run 并逐条收尾；单条失败不阻塞其余。
 * 活体依据：run 1541ffd9 在 worker 排空后永远 RUNNING，发车窗口被迫人工对账。
 */
describe('staleRunSweepWorkflow（B3）', () => {
  it('对每条 stale run 调用收尾，返回聚合结果', async () => {
    acts.listStaleDiscoveryRuns.mockResolvedValue([
      ROW,
      { ...ROW, runId: '55555555-5555-4555-8555-555555555555' },
    ]);
    acts.finalizeStaleDiscoveryRun.mockResolvedValue(undefined);

    await expect(staleRunSweepWorkflow()).resolves.toEqual({
      examined: 2,
      finalized: 2,
      failed: 0,
    });
    expect(acts.finalizeStaleDiscoveryRun).toHaveBeenCalledTimes(2);
    expect(acts.finalizeStaleDiscoveryRun).toHaveBeenNthCalledWith(1, ROW);
  });

  it('阈值与批量来自输入（缺省=215 分钟/50 条）', async () => {
    acts.listStaleDiscoveryRuns.mockResolvedValue([]);
    await staleRunSweepWorkflow();
    expect(acts.listStaleDiscoveryRuns).toHaveBeenCalledWith({
      staleAfterMs: DISCOVERY_RUN_STALE_AFTER_MS,
      limit: STALE_RUN_SWEEP_LIMIT,
    });

    resetActivities();
    acts.listStaleDiscoveryRuns.mockResolvedValue([]);
    await staleRunSweepWorkflow({ staleAfterMs: 60_000, limit: 5 });
    expect(acts.listStaleDiscoveryRuns).toHaveBeenCalledWith({
      staleAfterMs: 60_000,
      limit: 5,
    });
  });

  it('单条收尾失败不阻塞其余（幂等事务下一轮重试）', async () => {
    acts.listStaleDiscoveryRuns.mockResolvedValue([
      ROW,
      { ...ROW, runId: '66666666-6666-4666-8666-666666666666' },
      { ...ROW, runId: '77777777-7777-4777-8777-777777777777' },
    ]);
    acts.finalizeStaleDiscoveryRun
      .mockRejectedValueOnce(new Error('ledger unavailable'))
      .mockResolvedValue(undefined);

    await expect(staleRunSweepWorkflow()).resolves.toEqual({
      examined: 3,
      finalized: 2,
      failed: 1,
    });
  });

  it('全部收尾失败以 nonRetryable 失败暴露（不静默绿）', async () => {
    acts.listStaleDiscoveryRuns.mockResolvedValue([
      ROW,
      { ...ROW, runId: '88888888-8888-4888-8888-888888888888' },
    ]);
    acts.finalizeStaleDiscoveryRun.mockRejectedValue(new Error('ledger unavailable'));

    await expect(staleRunSweepWorkflow()).rejects.toMatchObject({
      type: 'STALE_RUN_SWEEP_ALL_FAILED',
    });
  });

  it('没有 stale run 时不调用收尾', async () => {
    acts.listStaleDiscoveryRuns.mockResolvedValue([]);
    await expect(staleRunSweepWorkflow()).resolves.toEqual({
      examined: 0,
      finalized: 0,
      failed: 0,
    });
    expect(acts.finalizeStaleDiscoveryRun).not.toHaveBeenCalled();
  });
});
