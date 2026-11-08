import { ApplicationFailure, proxyActivities } from '@temporalio/workflow';
import type { DiscoveryActivities } from './discovery.activities';
import {
  DISCOVERY_RUN_STALE_AFTER_MS,
  STALE_RUN_SWEEP_LIMIT,
} from './discovery-run-lifecycle';

/**
 * B3（审计 F2）：stale-run 看门狗。周期扫描「RUNNING 超过租约+余量」的 discovery_run，
 * 逐条交给 finalizeStaleDiscoveryRun 以写一次事务收尾为 FAILED（stats.failure.stage='watchdog'）。
 *
 * 背景（2026-11-07 活体证据）：run 1541ffd9 在 worker 排空后取消请求永不生效，DB 永远
 * RUNNING，发车硬窗口被迫人工对账。执行时限（relay 的 215m workflowExecutionTimeout）
 * 负责终止僵尸实例，本 sweep 负责把 DB 行收尸——两者合起来不允许再出现「人手改库才能发车」。
 *
 * 重放安全：阈值/批量只作为活动输入参数；循环次数由活动返回的行数决定（历史重放一致）。
 */
const acts = proxyActivities<
  Pick<DiscoveryActivities, 'listStaleDiscoveryRuns' | 'finalizeStaleDiscoveryRun'>
>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 5 },
});

export interface StaleRunSweepInput {
  staleAfterMs?: number;
  limit?: number;
}

export interface StaleRunSweepResult {
  examined: number;
  finalized: number;
  failed: number;
}

export async function staleRunSweepWorkflow(
  input: StaleRunSweepInput = {},
): Promise<StaleRunSweepResult> {
  const staleAfterMs = input.staleAfterMs ?? DISCOVERY_RUN_STALE_AFTER_MS;
  const limit = input.limit ?? STALE_RUN_SWEEP_LIMIT;
  const runs = await acts.listStaleDiscoveryRuns({ staleAfterMs, limit });
  let finalized = 0;
  let failed = 0;
  for (const run of runs) {
    try {
      await acts.finalizeStaleDiscoveryRun(run);
      finalized += 1;
    } catch {
      // 单条收尾失败不阻塞其余；幂等的写一次事务会在下一轮重试。
      failed += 1;
    }
  }
  if (runs.length > 0 && finalized === 0 && failed > 0) {
    // 全部收尾失败（例如账本/连接池同时不可用）不能让 sweep 静默绿：以 nonRetryable
    // 失败暴露到 Temporal UI/调度日志，下一周期幂等重试。
    throw ApplicationFailure.nonRetryable(
      `STALE_RUN_SWEEP_ALL_FAILED:${failed}`,
      'STALE_RUN_SWEEP_ALL_FAILED',
    );
  }
  return { examined: runs.length, finalized, failed };
}
