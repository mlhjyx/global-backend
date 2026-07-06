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

  // ICP 资格门：判定本次归一出的公司是否为该 ICP 的真实目标客户（评测驱动）
  const fit = await acts.qualifyFitForRun({ workspaceId, runId, icpId: input.icpId });

  // 富集（Waterfall 富化段）：只给过了 fit 门的高价值公司补 GLEIF 法律身份 + 母子关系
  const enrich = await acts.enrichRun({ workspaceId, runId });

  const status = failures === 0 ? 'DONE' : failures < queries.length ? 'PARTIAL' : 'FAILED';
  await acts.finalizeRun({
    workspaceId,
    runId,
    planId,
    status,
    stats: {
      perSource,
      companies,
      suppressed,
      fit: fit.verdicts,
      enrich: { matched: enrich.matched, of: enrich.enriched, provider: enrich.provider },
      queries: queries.length,
      failures,
    },
  });
}
