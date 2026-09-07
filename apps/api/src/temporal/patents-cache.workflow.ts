import { patched, proxyActivities } from '@temporalio/workflow';
import type { PatentsCacheActivities } from './patents-cache.activities';
import type { PlatformScheduleAuthorityActivities } from './platform-schedule-authority.activities';
import type { PlatformScheduleWorkflowInput } from './platform-schedule-authority';
import { admitPlatformScheduleForWorkflow } from './platform-schedule-authority.workflow';
import { PATENTS_CACHE_REFRESH_SCHEDULE_ID } from './understanding.constants';
import { PLATFORM_EXECUTION_ACTIVITY_MAXIMUM_ATTEMPTS } from '../platform-authority/platform-execution-contract';

const acts = proxyActivities<PatentsCacheActivities>({
  // 一次共享大扫 + 批量落库：BigQuery 全表扫可数十秒~分钟，给足 headroom（overlap=SKIP 已防叠跑）。
  startToCloseTimeout: '15 minutes',
  retry: { maximumAttempts: PLATFORM_EXECUTION_ACTIVITY_MAXIMUM_ATTEMPTS },
});
const authorityActs = proxyActivities<PlatformScheduleAuthorityActivities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: PLATFORM_EXECUTION_ACTIVITY_MAXIMUM_ATTEMPTS },
});

export const PATENTS_INTENTIONALLY_DISABLED_NO_EGRESS_PATCH =
  'platform-patents-intentionally-disabled-no-egress-v1';

const PATENTS_DISABLED_RESULT = Object.freeze({
  status: 'DISABLED' as const,
  anchorCount: 0,
  rowCount: 0,
  bytesScanned: null,
  purged: 0,
  cached: 0,
  empty: 0,
  detail: 'INTENTIONALLY_DISABLED_NO_EGRESS' as const,
});

/**
 * **专利发明人缓存刷新 sweep**（scale-safe #89，第 5 个周期 Schedule）——一次共享大扫落 postgres，
 * 令逐公司发现零 BQ 字节读缓存。当前 reviewed policy 是 intentionally disabled/no-egress；
 * 新历史在申请 Grant 前返回确定性 DISABLED，patch 只用于保持旧历史 replay 的原命令序列。
 */
export async function patentsCacheRefreshWorkflow(input: ({ maxAnchors?: number } & PlatformScheduleWorkflowInput) = {}) {
  if (patched(PATENTS_INTENTIONALLY_DISABLED_NO_EGRESS_PATCH)) {
    return PATENTS_DISABLED_RESULT;
  }
  const executionBudget = await admitPlatformScheduleForWorkflow({ activities: authorityActs, scheduleId: PATENTS_CACHE_REFRESH_SCHEDULE_ID, workflowInput: input });
  return acts.refreshPatentCacheActivity({
    ...(input.maxAnchors === undefined ? {} : { maxAnchors: input.maxAnchors }),
    ...(executionBudget ? { executionContractVersion: 1 as const, executionBudget } : {}),
  });
}
