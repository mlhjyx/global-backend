import { proxyActivities } from '@temporalio/workflow';
import type { DiscoveryActivities, DiscoveryRunInput } from './discovery.activities';

const acts = proxyActivities<DiscoveryActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3 },
});

// 信号富集是**慢活动**（抓官网/sitemap，逐家数十秒）：单独长超时代理，绝不用上面的 2 分钟超时
// （否则会超时重试整段富集）。工作量有界（SIGNAL_ENRICH_LIMIT 家 × 逐家有 AbortSignal 超时），30 分钟足够。
const signalActs = proxyActivities<DiscoveryActivities>({
  startToCloseTimeout: '30 minutes',
  retry: { maximumAttempts: 2 },
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

  // 富集（Waterfall 富化段）：只给过了 fit 门的高价值公司补 GLEIF 法律身份 + 母子关系（快事实，2 分钟活动）
  const enrich = await acts.enrichRun({ workspaceId, runId });

  // 信号富集（数字足迹 + 结构化收割）：慢且时变，走独立长活动 + heartbeat；失败不拖垮整个 run
  let signals: { matched: number; enriched: number; provider: string | null } = { matched: 0, enriched: 0, provider: null };
  try {
    signals = await signalActs.enrichSignalsRun({ workspaceId, runId });
  } catch {
    /* 信号富集是尽力而为的富化，失败不影响 run 状态 */
  }

  // 从 ICP 短名单自动注册网站变更监控（#4 loop）：对 fit=match 公司建 web_watch，交给 intentSweep 持续盯变更。
  // best-effort（每家一次 sitemap 探测，慢）→ 长活动；失败不影响 run 状态。
  let watches: { candidates: number; registered: number } = { candidates: 0, registered: 0 };
  try {
    watches = await signalActs.registerWatchesForRun({ workspaceId, runId });
  } catch {
    /* 监控注册是尽力而为的收口，失败不影响 run 状态 */
  }

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
      signals: { matched: signals.matched, of: signals.enriched, provider: signals.provider },
      watches: { registered: watches.registered, of: watches.candidates },
      queries: queries.length,
      failures,
    },
  });
}
