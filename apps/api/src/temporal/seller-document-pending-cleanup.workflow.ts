import { ApplicationFailure, proxyActivities } from '@temporalio/workflow';
import type { SellerDocumentPendingCleanupActivities } from '../seller-knowledge/seller-document-pending-cleanup.activities';

/**
 * 定时清收超时未确认（pending_upload）的卖家资料上传占位行与 staging 对象，释放计数与字节配额。
 * 重放安全：无模块级数值常量，分页与批次参数均随 workflow input 传入（活动侧兜底读取 env TTL）。
 */
const acts = proxyActivities<SellerDocumentPendingCleanupActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 5 },
});

export interface SellerDocumentPendingCleanupWorkflowInput {
  olderThanHours?: number;
  limit?: number;
  maxPages?: number;
  batchLimit?: number;
  maxBatches?: number;
}

export interface SellerDocumentPendingCleanupWorkflowResult {
  workspaces: number;
  deleted: number;
  s3NotFound: number;
  skippedMismatch: number;
  failed: number;
}

export async function sellerDocumentPendingCleanupWorkflow(
  input: SellerDocumentPendingCleanupWorkflowInput = {},
): Promise<SellerDocumentPendingCleanupWorkflowResult> {
  const limit = input.limit ?? 50;
  const maxPages = input.maxPages ?? 4;
  let workspaces = 0;
  let deleted = 0;
  let s3NotFound = 0;
  let skippedMismatch = 0;
  let failed = 0;
  let afterWorkspaceId: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const listed = await acts.listStalePendingSellerDocumentWorkspaces({
      ...(input.olderThanHours !== undefined
        ? { olderThanHours: input.olderThanHours }
        : {}),
      limit,
      ...(afterWorkspaceId ? { afterWorkspaceId } : {}),
    });
    const workspaceIds = listed.workspaceIds;
    workspaces += workspaceIds.length;
    for (const workspaceId of workspaceIds) {
      try {
        const res = await acts.cleanupStalePendingSellerDocuments({
          workspaceId,
          ...(input.olderThanHours !== undefined
            ? { olderThanHours: input.olderThanHours }
            : {}),
          ...(input.batchLimit !== undefined
            ? { batchLimit: input.batchLimit }
            : {}),
          ...(input.maxBatches !== undefined
            ? { maxBatches: input.maxBatches }
            : {}),
        });
        deleted += res.deletedCount;
        s3NotFound += res.s3NotFoundCount;
        skippedMismatch += res.skippedMismatchCount;
      } catch {
        failed += 1;
        console.warn(
          `[seller-doc-pending-cleanup] cleanup failed for ${workspaceId}`,
        );
      }
    }
    if (workspaceIds.length < limit) return finish();
    afterWorkspaceId = workspaceIds[workspaceIds.length - 1];
  }
  return finish();

  function finish(): SellerDocumentPendingCleanupWorkflowResult {
    if (workspaces > 0 && deleted === 0 && failed > 0) {
      throw ApplicationFailure.nonRetryable(
        `SELLER_DOCUMENT_PENDING_CLEANUP_ALL_FAILED:${failed}`,
        'SELLER_DOCUMENT_PENDING_CLEANUP_ALL_FAILED',
      );
    }
    return { workspaces, deleted, s3NotFound, skippedMismatch, failed };
  }
}
