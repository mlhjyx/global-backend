import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@temporalio/workflow', () => import('./testing/temporal-workflow.mock'));

import { acts, resetActivities } from './testing/temporal-workflow.mock';
import { sellerDocumentPendingCleanupWorkflow } from './seller-document-pending-cleanup.workflow';

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  resetActivities();
});

describe('sellerDocumentPendingCleanupWorkflow', () => {
  it('enumerates workspaces with cursor pagination and aggregates cleanup counts', async () => {
    const page1 = Array.from(
      { length: 50 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const page2 = [WS_B];
    acts.listStalePendingSellerDocumentWorkspaces
      .mockResolvedValueOnce({ workspaceIds: page1 })
      .mockResolvedValueOnce({ workspaceIds: page2 });
    acts.cleanupStalePendingSellerDocuments.mockResolvedValue({
      deletedCount: 1,
      s3NotFoundCount: 0,
      skippedMismatchCount: 0,
      hasMore: false,
    });

    await expect(sellerDocumentPendingCleanupWorkflow()).resolves.toEqual({
      workspaces: 51,
      deleted: 51,
      s3NotFound: 0,
      skippedMismatch: 0,
      failed: 0,
    });
    expect(acts.listStalePendingSellerDocumentWorkspaces).toHaveBeenNthCalledWith(
      1,
      { limit: 50 },
    );
    expect(acts.listStalePendingSellerDocumentWorkspaces).toHaveBeenNthCalledWith(
      2,
      { limit: 50, afterWorkspaceId: page1[49] },
    );
  });

  it('continues across remaining workspaces when one workspace fails and throws nonRetryable when all fail', async () => {
    acts.listStalePendingSellerDocumentWorkspaces.mockResolvedValue({
      workspaceIds: [WS_A, WS_B],
    });
    acts.cleanupStalePendingSellerDocuments
      .mockRejectedValueOnce(new Error('S3 503'))
      .mockResolvedValueOnce({
        deletedCount: 2,
        s3NotFoundCount: 1,
        skippedMismatchCount: 0,
        hasMore: false,
      });

    await expect(
      sellerDocumentPendingCleanupWorkflow({ olderThanHours: 12 }),
    ).resolves.toEqual({
      workspaces: 2,
      deleted: 2,
      s3NotFound: 1,
      skippedMismatch: 0,
      failed: 1,
    });
    expect(acts.cleanupStalePendingSellerDocuments).toHaveBeenCalledWith({
      workspaceId: WS_A,
      olderThanHours: 12,
    });

    acts.cleanupStalePendingSellerDocuments.mockReset();
    acts.cleanupStalePendingSellerDocuments.mockRejectedValue(
      new Error('storage down'),
    );
    await expect(sellerDocumentPendingCleanupWorkflow()).rejects.toThrow(
      'SELLER_DOCUMENT_PENDING_CLEANUP_ALL_FAILED:2',
    );
  });
});
