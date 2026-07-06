import { proxyActivities } from '@temporalio/workflow';
import type { DiscoveryActivities, DiscoveryRunInput } from './discovery.activities';

const acts = proxyActivities<DiscoveryActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3 },
});

/**
 * Discover 编排（PRD 5.5 / 7.4.8 Waterfall 的发现段）：
 * READY 计划 → 按 priority 逐源执行（单源失败不终止整个 run → PARTIAL）→
 * 归一 + 身份解析 + Suppression → 收尾（计划 EXECUTED + DiscoveryRunCompleted 事件）。
 * 联系人发现/邮箱验证是后续按需步骤（仅对高价值企业，Waterfall 第 5/7 步），不在此。
 */
export async function discoveryWorkflow(input: DiscoveryRunInput): Promise<void> {
  const { workspaceId, runId, planId } = input;
  const perSource: Record<string, { rawCount: number; provider: string | null; error?: string }> = {};
  let failures = 0;

  const { queries } = await acts.loadPlanQueries({ workspaceId, planId });
  for (const query of queries) {
    try {
      const r = await acts.executeQuery({ workspaceId, runId, query });
      perSource[query.source_class] = { rawCount: r.rawCount, provider: r.provider };
    } catch (err) {
      failures += 1;
      perSource[query.source_class] = { rawCount: 0, provider: null, error: String(err).slice(0, 200) };
    }
  }

  const { companies, suppressed } = await acts.canonicalizeRun({ workspaceId, runId });

  const status = failures === 0 ? 'DONE' : failures < queries.length ? 'PARTIAL' : 'FAILED';
  await acts.finalizeRun({
    workspaceId,
    runId,
    planId,
    status,
    stats: { perSource, companies, suppressed, queries: queries.length, failures },
  });
}
