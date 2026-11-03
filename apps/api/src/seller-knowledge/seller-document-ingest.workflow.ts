import { proxyActivities } from '@temporalio/workflow';
import type { createSellerDocumentActivities, SellerDocumentIngestInput } from './seller-document.activities';

type SellerDocumentActivities = ReturnType<typeof createSellerDocumentActivities>;

const activities = proxyActivities<SellerDocumentActivities>({
  startToCloseTimeout: '10 minutes', // Docling 长解析（300s 上限）+ 分批向量化
  heartbeatTimeout: '20 seconds',
  retry: { maximumAttempts: 3 },
});

export type { SellerDocumentIngestInput };

/**
 * 资料摄入：单文档 activity，持久 lease/retry 真值在 seller_document 状态机；
 * Temporal 只重试 activity 级失败，typed 失败会回 queued+retry_at 由重试端点/后续扫描捡起。
 */
export async function sellerDocumentIngestWorkflow(
  input: SellerDocumentIngestInput,
): Promise<Awaited<ReturnType<SellerDocumentActivities['processSellerDocument']>>> {
  return activities.processSellerDocument(input);
}
