import { proxyActivities } from '@temporalio/workflow';
import type { IntentActivities } from './intent.activities';
import type { WatchResult } from '../intent/website-watch.service';
import { isExecutionControlError } from '../execution-budget/execution-control-error';
import type { PlatformScheduleAuthorityActivities } from './platform-schedule-authority.activities';
import type { PlatformScheduleWorkflowInput } from './platform-schedule-authority';
import { admitPlatformScheduleForWorkflow } from './platform-schedule-authority.workflow';
import { INTENT_SWEEP_SCHEDULE_ID } from './understanding.constants';

const acts = proxyActivities<IntentActivities>({
  startToCloseTimeout: '10 minutes', // 一个源可能有多页 × crawl4ai 渲染（每页可达数十秒）
  retry: { maximumAttempts: 2 },
});
const authorityActs = proxyActivities<PlatformScheduleAuthorityActivities>({
  startToCloseTimeout: '1 minute', retry: { maximumAttempts: 2 },
});

export interface IntentSweepResult {
  swept: number;
  results: (WatchResult & { error?: string })[];
  /** loop 收口：本轮 sweep 后自动投影进各租户的结果（事件 → attributes.intent.* → 评分可见）。 */
  projected: { workspaces: number; companiesTouched: number; eventsProjected: number };
}

/**
 * 网站变更 intent sweep —— 由独立 Temporal Schedule 周期触发（overlap=SKIP）。
 * 取到期的 web_watch 源，逐个跑页面 diff；单源失败不影响其余（fail-safe）。
 * 与 acquisitionSweep 并列但**分开调度**：网站页日级刷新即可，各源 cadence 决定到期时机。
 */
export async function intentSweepWorkflow(input: ({ limit?: number } & PlatformScheduleWorkflowInput) = {}): Promise<IntentSweepResult> {
  const executionBudget = await admitPlatformScheduleForWorkflow({ activities: authorityActs, scheduleId: INTENT_SWEEP_SCHEDULE_ID, workflowInput: input });
  const authorityArgs = executionBudget ? { executionContractVersion: 1 as const, executionBudget } : {};
  // 保留期清理（全局、廉价、fail-safe）：先删超期 web_watch 变更事件（GDPR 存储限制）。
  try { await acts.purgeStaleIntentEvents({ ...authorityArgs }); }
  catch (error) { if (isExecutionControlError(error)) throw error; }

  const { sourceIds } = await acts.listDueWatches({ limit: input.limit ?? 50, ...authorityArgs });
  const results: (WatchResult & { error?: string })[] = [];
  for (const sourceId of sourceIds) {
    try {
      results.push(await acts.watchSource({ sourceId, ...authorityArgs }));
    } catch (err) {
      if (isExecutionControlError(err)) throw err;
      results.push({
        sourceId, status: 'FAILED', pagesFetched: 0, pagesMissed: 0, added: 0, changed: 0, intentEvents: 0,
        error: String(err).slice(0, 200),
      });
    }
  }

  // loop 收口：sweep 完自动把新事件投影进各租户（此前投影无自动触发 → 事件永不流到 Intent 维评分）。
  // fail-safe：投影失败不影响 sweep 本身的结果。
  let projected = { workspaces: 0, companiesTouched: 0, eventsProjected: 0 };
  try {
    projected = await acts.projectIntentAllWorkspaces({ ...authorityArgs });
  } catch (error) {
    if (isExecutionControlError(error)) throw error;
    /* 投影是尽力而为的收口 */
  }
  return { swept: sourceIds.length, results, projected };
}
