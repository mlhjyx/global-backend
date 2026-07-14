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
 * 单 activity 透传：基建级失败（扫库/入口抛错）上抛交 Temporal retry，文档留 queued
 * 可被 refurbish P1 或下次 commit 再扫；**逐文档**失败由 activity 内 fail-safe 标 failed
 * 不触发重试（复审 C5——failed 文档的重触发端点列 M1-b fast-follow）。
 */
export async function kbIngestWorkflow(
  input: KbIngestWorkflowInput,
): Promise<{ processed: number; failed: number }> {
  return activities.processQueuedKbDocs(input);
}
