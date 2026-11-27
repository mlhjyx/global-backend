import { patched, proxyActivities, sleep } from '@temporalio/workflow';
import type { createSellerDocumentActivities, SellerDocumentIngestInput } from './seller-document.activities';
import { MAX_SELLER_DOCUMENT_INGEST_ATTEMPTS, MAX_SELLER_DOCUMENT_RETRY_SECONDS } from './seller-document-ingest-policy';

type SellerDocumentActivities = ReturnType<typeof createSellerDocumentActivities>;

const activities = proxyActivities<SellerDocumentActivities>({
  startToCloseTimeout: '10 minutes', // Docling 长解析（300s 上限）+ 分批向量化
  heartbeatTimeout: '20 seconds',
  retry: { maximumAttempts: 3 },
});

const QUEUED_RETRY_PATCH_ID = 'seller-document-queued-retry-v1';
const DURABLE_RETRY_PATCH_ID = 'seller-document-durable-retry-v2';
const TAIL_PAGES_PATCH_ID = 'seller-document-tail-pages-v1';
const MAX_QUEUED_RETRIES = 3; // 冻结旧历史的重试次数
const MIN_RETRY_SLEEP_SECONDS = 5;
const MAX_RETRY_SLEEP_SECONDS = 300; // 冻结旧历史的退避上限
const RETRY_CLOCK_BUFFER_SECONDS = 2;

export type { SellerDocumentIngestInput };

/**
 * 资料摄入：单文档 activity，持久 lease/retry 真值在 seller_document 状态机；
 * Temporal 负责 activity 级重试，typed 瞬态失败回 queued+retry_at 后在工作流内按退避窗口自动重跑，
 * 避免临时抖动把文档永久滞留在 queued。大页数 PDF 首阶段先解析前 15 页立即置 ready，
 * 随后在工作流内自动后台补全剩余页。
 */
export async function sellerDocumentIngestWorkflow(
  input: SellerDocumentIngestInput,
): Promise<Awaited<ReturnType<SellerDocumentActivities['processSellerDocument']>>> {
  const first = await activities.processSellerDocument(input);
  let current = first;
  if (patched(QUEUED_RETRY_PATCH_ID) && current.outcome === 'queued') {
    const durableRetry = patched(DURABLE_RETRY_PATCH_ID);
    const maxRetries = durableRetry ? MAX_SELLER_DOCUMENT_INGEST_ATTEMPTS - 1 : MAX_QUEUED_RETRIES;
    const maxSleepSeconds = durableRetry ? MAX_SELLER_DOCUMENT_RETRY_SECONDS : MAX_RETRY_SLEEP_SECONDS;
    for (let retry = 0; retry < maxRetries && current.outcome === 'queued'; retry += 1) {
      const rawWait = current.retryAfterSeconds ?? 60;
      const waitSeconds = Math.min(
        Math.max(rawWait, MIN_RETRY_SLEEP_SECONDS),
        maxSleepSeconds,
      );
      await sleep((waitSeconds + RETRY_CLOCK_BUFFER_SECONDS) * 1000);
      current = await activities.processSellerDocument(input);
    }
  }
  if (
    current.outcome === 'ready' &&
    current.tailPagesPending === true &&
    typeof current.nextStartPage === 'number' &&
    patched(TAIL_PAGES_PATCH_ID)
  ) {
    await activities.processSellerDocumentTailPages({
      ...input,
      startPage: current.nextStartPage,
      ...(typeof current.totalPages === 'number' ? { totalPages: current.totalPages } : {}),
    });
  }
  return current;
}
