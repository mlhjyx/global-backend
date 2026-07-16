import { proxyActivities } from '@temporalio/workflow';
import type { createSiteBuilderActivities } from './site-builder.activities';

type SiteBuilderActivities = ReturnType<typeof createSiteBuilderActivities>;

const activities = proxyActivities<SiteBuilderActivities>({
  startToCloseTimeout: '10 minutes', // Docling 长解析（300s 上限）+ 分批向量化
  heartbeatTimeout: '20 seconds',
  retry: { maximumAttempts: 3 },
});

export interface KbIngestWorkflowInput {
  workspaceId: string;
  siteId: string;
  assetId: string;
}

/**
 * KB 摄入：单素材 activity，持久 lease/retry 真值归 Asset 状态机；Temporal 仅重试
 * activity 基建失败。typed dependency failure 会回 queued+retryAt，由 recovery sweep 自愈。
 */
export async function kbIngestWorkflow(
  input: KbIngestWorkflowInput,
): Promise<Awaited<ReturnType<SiteBuilderActivities['processKbAsset']>>> {
  return activities.processKbAsset(input);
}
