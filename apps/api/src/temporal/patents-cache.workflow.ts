import { proxyActivities } from '@temporalio/workflow';
import type { PatentsCacheActivities } from './patents-cache.activities';
import type { PlatformScheduleAuthorityActivities } from './platform-schedule-authority.activities';
import type { PlatformScheduleWorkflowInput } from './platform-schedule-authority';
import { admitPlatformScheduleForWorkflow } from './platform-schedule-authority.workflow';
import { PATENTS_CACHE_REFRESH_SCHEDULE_ID } from './understanding.constants';

const acts = proxyActivities<PatentsCacheActivities>({
  // 一次共享大扫 + 批量落库：BigQuery 全表扫可数十秒~分钟，给足 headroom（overlap=SKIP 已防叠跑）。
  startToCloseTimeout: '15 minutes',
  retry: { maximumAttempts: 2 },
});
const authorityActs = proxyActivities<PlatformScheduleAuthorityActivities>({ startToCloseTimeout: '1 minute', retry: { maximumAttempts: 2 } });

/**
 * **专利发明人缓存刷新 sweep**（scale-safe #89，第 5 个周期 Schedule）——一次共享大扫落 postgres，
 * 令逐公司发现零 BQ 字节读缓存。空队列 → SKIPPED_EMPTY（零成本）；§8.8 SUSPENDED → DENIED（不扫）。
 * seed DISABLED + PATENT_SOURCE_MODE=off 时本 sweep 仍可跑（预热/verify），但读侧 provider 关（off）不消费。
 */
export async function patentsCacheRefreshWorkflow(input: ({ maxAnchors?: number } & PlatformScheduleWorkflowInput) = {}) {
  const executionBudget = await admitPlatformScheduleForWorkflow({ activities: authorityActs, scheduleId: PATENTS_CACHE_REFRESH_SCHEDULE_ID, workflowInput: input });
  return acts.refreshPatentCacheActivity({
    ...(input.maxAnchors === undefined ? {} : { maxAnchors: input.maxAnchors }),
    ...(executionBudget ? { executionContractVersion: 1 as const, executionBudget } : {}),
  });
}
