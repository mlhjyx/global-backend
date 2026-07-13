import { proxyActivities } from '@temporalio/workflow';
import type { createSiteBuilderActivities } from './site-builder.activities';

type SiteBuilderActivities = ReturnType<typeof createSiteBuilderActivities>;

const activities = proxyActivities<SiteBuilderActivities>({
  startToCloseTimeout: '10 minutes', // Docling 长解析（300s 上限）+ 分批向量化
  retry: { maximumAttempts: 3 },
});

export interface KbIngestWorkflowInput {
  workspaceId: string;
  siteId: string;
}

/**
 * KB 摄入（M1-a：assets.controller M0 fire-and-forget 挂账的 Temporal 化）。
 * 单 activity 透传：失败原样上抛交 Temporal retry；重试耗尽=文档留 queued，
 * 下次 commit 或 refurbish P1 再扫（语义与 M0 一致，多了持久重试）。
 */
export async function kbIngestWorkflow(
  input: KbIngestWorkflowInput,
): Promise<{ processed: number; failed: number }> {
  return activities.processQueuedKbDocs(input);
}
