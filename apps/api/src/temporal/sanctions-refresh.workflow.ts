import { proxyActivities } from '@temporalio/workflow';
import type { SanctionsRefreshActivities } from './sanctions-refresh.activities';

const { refreshSanctionsLists } = proxyActivities<SanctionsRefreshActivities>({
  startToCloseTimeout: '15 minutes',
  retry: { maximumAttempts: 2 },
});

/**
 * 制裁名单每日刷新（Qualify 第五门，Schedule 驱动）：刷新全部 ENABLED 源（OFAC SDN/Consolidated + EU FSF）
 * → sanctions_entity（仅 Entity）+ 重建内存索引。DISABLED 源零动作（Phase 1 默认全 DISABLED，真测绿后 ops 翻）。
 */
export async function sanctionsRefreshWorkflow(): Promise<{ sources: number }> {
  const res = await refreshSanctionsLists();
  return { sources: res.sources };
}
