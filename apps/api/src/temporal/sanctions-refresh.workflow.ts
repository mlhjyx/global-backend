import { proxyActivities } from '@temporalio/workflow';
import type { SanctionsRefreshActivities } from './sanctions-refresh.activities';
import type { PlatformScheduleAuthorityActivities } from './platform-schedule-authority.activities';
import type { PlatformScheduleWorkflowInput } from './platform-schedule-authority';
import { admitPlatformScheduleForWorkflow } from './platform-schedule-authority.workflow';
import { SANCTIONS_REFRESH_SCHEDULE_ID } from './understanding.constants';

const { refreshSanctionsLists } = proxyActivities<SanctionsRefreshActivities>({
  startToCloseTimeout: '15 minutes',
  retry: { maximumAttempts: 2 },
});
const authorityActs = proxyActivities<PlatformScheduleAuthorityActivities>({ startToCloseTimeout: '1 minute', retry: { maximumAttempts: 2 } });

/**
 * 制裁名单每日刷新（Qualify 第五门，Schedule 驱动）：刷新全部 ENABLED 源（OFAC SDN/Consolidated + EU FSF）
 * → sanctions_entity（仅 Entity）+ 重建内存索引。DISABLED 源零动作（Phase 1 默认全 DISABLED，真测绿后 ops 翻）。
 */
export async function sanctionsRefreshWorkflow(input: PlatformScheduleWorkflowInput = {}): Promise<{ sources: number }> {
  const executionBudget = await admitPlatformScheduleForWorkflow({ activities: authorityActs, scheduleId: SANCTIONS_REFRESH_SCHEDULE_ID, workflowInput: input });
  const res = await refreshSanctionsLists(executionBudget ? { executionContractVersion: 1, executionBudget } : undefined);
  return { sources: res.sources };
}
