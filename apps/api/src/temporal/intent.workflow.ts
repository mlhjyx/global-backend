import { proxyActivities } from '@temporalio/workflow';
import type { IntentActivities } from './intent.activities';
import type { WatchResult } from '../intent/website-watch.service';

const acts = proxyActivities<IntentActivities>({
  startToCloseTimeout: '10 minutes', // 一个源可能有多页 × crawl4ai 渲染（每页可达数十秒）
  retry: { maximumAttempts: 2 },
});

export interface IntentSweepResult {
  swept: number;
  results: (WatchResult & { error?: string })[];
}

/**
 * 网站变更 intent sweep —— 由独立 Temporal Schedule 周期触发（overlap=SKIP）。
 * 取到期的 web_watch 源，逐个跑页面 diff；单源失败不影响其余（fail-safe）。
 * 与 acquisitionSweep 并列但**分开调度**：网站页日级刷新即可，各源 cadence 决定到期时机。
 */
export async function intentSweepWorkflow(input?: { limit?: number }): Promise<IntentSweepResult> {
  // 保留期清理（全局、廉价、fail-safe）：先删超期 web_watch 变更事件（GDPR 存储限制）。
  await acts.purgeStaleIntentEvents({}).catch(() => undefined);

  const { sourceIds } = await acts.listDueWatches({ limit: input?.limit ?? 50 });
  const results: (WatchResult & { error?: string })[] = [];
  for (const sourceId of sourceIds) {
    try {
      results.push(await acts.watchSource({ sourceId }));
    } catch (err) {
      results.push({
        sourceId, status: 'FAILED', pagesFetched: 0, pagesMissed: 0, added: 0, changed: 0, intentEvents: 0,
        error: String(err).slice(0, 200),
      });
    }
  }
  return { swept: sourceIds.length, results };
}
