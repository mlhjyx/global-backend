import { beforeEach, describe, expect, it, vi } from 'vitest';

/** sellerDocumentIngestWorkflow 编排单测：单 activity 透传，重试权归 Temporal/状态机。 */

vi.mock('@temporalio/workflow', () => import('../temporal/testing/temporal-workflow.mock'));

import { acts, resetActivities, setPatched, sleep } from '../temporal/testing/temporal-workflow.mock';
import { sellerDocumentIngestWorkflow } from './seller-document-ingest.workflow';

beforeEach(() => resetActivities());

const INPUT = {
  workspaceId: '10000000-0000-4000-8000-000000000001',
  companyId: '30000000-0000-4000-8000-000000000003',
  documentId: '40000000-0000-4000-8000-000000000004',
};

describe('sellerDocumentIngestWorkflow（Phase 2b）', () => {
  it('单文档 workflow 透传 workspace/company/document 三项身份', async () => {
    acts.processSellerDocument.mockResolvedValue({ documentId: INPUT.documentId, outcome: 'ready' });

    const out = await sellerDocumentIngestWorkflow(INPUT);

    expect(acts.processSellerDocument).toHaveBeenCalledTimes(1);
    expect(acts.processSellerDocument).toHaveBeenCalledWith(INPUT);
    expect(sleep).not.toHaveBeenCalled();
    expect(out).toEqual({ documentId: INPUT.documentId, outcome: 'ready' });
  });

  it('瞬态失败回 queued 后按 retryAfterSeconds 自动休眠重跑直至 ready', async () => {
    acts.processSellerDocument
      .mockResolvedValueOnce({ documentId: INPUT.documentId, outcome: 'queued', retryAfterSeconds: 60 })
      .mockResolvedValueOnce({ documentId: INPUT.documentId, outcome: 'ready' });

    const out = await sellerDocumentIngestWorkflow(INPUT);

    expect(acts.processSellerDocument).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(62_000);
    expect(out).toEqual({ documentId: INPUT.documentId, outcome: 'ready' });
  });

  it('旧历史 replay（patched=false）保持单次调用不触发 sleep', async () => {
    setPatched(() => false);
    acts.processSellerDocument.mockResolvedValue({ documentId: INPUT.documentId, outcome: 'queued', retryAfterSeconds: 60 });

    const out = await sellerDocumentIngestWorkflow(INPUT);

    expect(acts.processSellerDocument).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(out.outcome).toBe('queued');
  });

  it('首阶段返回 tailPagesPending 时，工作流自动调度阶段二后台补全尾页', async () => {
    acts.processSellerDocument.mockResolvedValue({
      documentId: INPUT.documentId,
      outcome: 'ready',
      tailPagesPending: true,
      nextStartPage: 16,
      totalPages: 48,
    });
    acts.processSellerDocumentTailPages.mockResolvedValue({
      documentId: INPUT.documentId,
      appendedChunks: 12,
      parsedPages: 48,
      partial: false,
    });

    const out = await sellerDocumentIngestWorkflow(INPUT);

    expect(out.outcome).toBe('ready');
    expect(acts.processSellerDocumentTailPages).toHaveBeenCalledTimes(1);
    expect(acts.processSellerDocumentTailPages).toHaveBeenCalledWith({
      ...INPUT,
      startPage: 16,
      totalPages: 48,
    });
  });

  it('activity 失败原样上抛（Temporal retry 拥有重试权，状态机保持 queued/retryAt）', async () => {
    acts.processSellerDocument.mockRejectedValue(new Error('docling down'));
    await expect(sellerDocumentIngestWorkflow(INPUT)).rejects.toThrow('docling down');
  });
});
