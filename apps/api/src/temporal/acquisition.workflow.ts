import { proxyActivities } from '@temporalio/workflow';
import type { AcquisitionActivities } from './acquisition.activities';
import type { AcquireResult } from '../acquisition/acquisition.service';
import { isExecutionControlError } from '../execution-budget/execution-control-error';
import type { PlatformScheduleAuthorityActivities } from './platform-schedule-authority.activities';
import type { PlatformScheduleWorkflowInput } from './platform-schedule-authority';
import { admitPlatformScheduleForWorkflow } from './platform-schedule-authority.workflow';
import { ACQ_SWEEP_SCHEDULE_ID } from './understanding.constants';

const acts = proxyActivities<AcquisitionActivities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 2 },
});
const authorityActs = proxyActivities<PlatformScheduleAuthorityActivities>({
  startToCloseTimeout: '1 minute', retry: { maximumAttempts: 2 },
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
export async function acquisitionSweepWorkflow(input: ({ limit?: number } & PlatformScheduleWorkflowInput) = {}): Promise<AcquisitionSweepResult> {
  const executionBudget = await admitPlatformScheduleForWorkflow({ activities: authorityActs, scheduleId: ACQ_SWEEP_SCHEDULE_ID, workflowInput: input });
  const authorityArgs = executionBudget ? { executionContractVersion: 1 as const, executionBudget } : {};
  const { sourceIds } = await acts.listDueSources({ limit: input.limit ?? 50, ...authorityArgs });
  const results: (AcquireResult & { error?: string })[] = [];
  for (const sourceId of sourceIds) {
    try {
      results.push(await acts.acquireSource({ sourceId, ...authorityArgs }));
    } catch (err) {
      if (isExecutionControlError(err)) throw err;
      results.push({
        sourceId, status: 'FAILED', total: 0, added: 0, updated: 0, removed: 0, unchanged: 0,
        error: String(err).slice(0, 200),
      });
    }
  }
  return { swept: sourceIds.length, results };
}
