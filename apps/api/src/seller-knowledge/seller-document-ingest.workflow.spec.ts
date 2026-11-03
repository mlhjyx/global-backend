import { beforeEach, describe, expect, it, vi } from 'vitest';

/** sellerDocumentIngestWorkflow 编排单测：单 activity 透传，重试权归 Temporal/状态机。 */

vi.mock('@temporalio/workflow', () => import('../temporal/testing/temporal-workflow.mock'));

import { acts, resetActivities } from '../temporal/testing/temporal-workflow.mock';
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
    expect(out).toEqual({ documentId: INPUT.documentId, outcome: 'ready' });
  });

  it('activity 失败原样上抛（Temporal retry 拥有重试权，状态机保持 queued/retryAt）', async () => {
    acts.processSellerDocument.mockRejectedValue(new Error('docling down'));
    await expect(sellerDocumentIngestWorkflow(INPUT)).rejects.toThrow('docling down');
  });
});
