import { proxyActivities } from '@temporalio/workflow';
import type { AcquisitionActivities } from './acquisition.activities';
import type { AcquireResult } from '../acquisition/acquisition.service';

const acts = proxyActivities<AcquisitionActivities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 2 },
});

export interface AcquisitionSweepResult {
  swept: number;
  results: (AcquireResult & { error?: string })[];
}

/**
 * 采集 sweep —— 由 Temporal Schedule 周期触发（overlap=SKIP，防重叠）。
 * 取到期的自动源，逐个跑增量 acquire；单源失败不影响其余（fail-safe）。
 * 每个源自带 cadence 决定下次到期时间；sweep 频率只要高于最短 cadence，
 * 没有到期源时近乎空转（廉价）。这就是「持续监控/增量更新」的驱动器。
 */
export async function acquisitionSweepWorkflow(input?: { limit?: number }): Promise<AcquisitionSweepResult> {
  const { sourceIds } = await acts.listDueSources({ limit: input?.limit ?? 50 });
  const results: (AcquireResult & { error?: string })[] = [];
  for (const sourceId of sourceIds) {
    try {
      results.push(await acts.acquireSource({ sourceId }));
    } catch (err) {
      results.push({
        sourceId, status: 'FAILED', total: 0, added: 0, updated: 0, removed: 0, unchanged: 0,
        error: String(err).slice(0, 200),
      });
    }
  }
  return { swept: sourceIds.length, results };
}
