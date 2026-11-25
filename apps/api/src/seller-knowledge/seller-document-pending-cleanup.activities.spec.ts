import { describe, expect, it, vi } from 'vitest';
import {
  createSellerDocumentPendingCleanupActivities,
  DEFAULT_SELLER_DOCUMENT_PENDING_UPLOAD_TTL_HOURS,
  PENDING_UPLOAD_EXPIRED_CODE,
  resolveSellerDocumentPendingUploadTtlHours,
} from './seller-document-pending-cleanup.activities';
import { sellerDocumentStagingKey } from './seller-documents.service';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const DOC_1 = '22222222-2222-4222-8222-222222222222';
const DOC_2 = '33333333-3333-4333-8333-333333333333';

describe('sellerDocumentPendingCleanupActivities', () => {
  it('resolves configurable pending_upload TTL hours with 24h fallback', () => {
    expect(resolveSellerDocumentPendingUploadTtlHours({})).toBe(
      DEFAULT_SELLER_DOCUMENT_PENDING_UPLOAD_TTL_HOURS,
    );
    expect(
      resolveSellerDocumentPendingUploadTtlHours({
        SELLER_DOCUMENT_PENDING_UPLOAD_TTL_HOURS: '12',
      }),
    ).toBe(12);
    expect(
      resolveSellerDocumentPendingUploadTtlHours({
        SELLER_DOCUMENT_PENDING_UPLOAD_TTL_HOURS: '0',
      }),
    ).toBe(24);
    expect(
      resolveSellerDocumentPendingUploadTtlHours({
        SELLER_DOCUMENT_PENDING_UPLOAD_TTL_HOURS: 'abc',
      }),
    ).toBe(24);
  });

  it('rejects malformed cursors or workspace IDs before querying', async () => {
    const queryRaw = vi.fn();
    const withWorkspace = vi.fn();
    const acts = createSellerDocumentPendingCleanupActivities({
      prisma: { $queryRaw: queryRaw, withWorkspace } as never,
      storage: { delete: vi.fn() },
    });

    await expect(
      acts.listStalePendingSellerDocumentWorkspaces({
        afterWorkspaceId: 'not-a-uuid',
      }),
    ).rejects.toThrow('SELLER_DOCUMENT_PENDING_CLEANUP_INVALID_CURSOR');
    await expect(
      acts.cleanupStalePendingSellerDocuments({ workspaceId: 'bad-id' }),
    ).rejects.toThrow('SELLER_DOCUMENT_PENDING_CLEANUP_INVALID_WORKSPACE');
    expect(queryRaw).not.toHaveBeenCalled();
    expect(withWorkspace).not.toHaveBeenCalled();
  });

  it('deletes staging objects, tolerates S3 404/NoSuchKey, skips mismatched keys, and rethrows transient S3 failures', async () => {
    const executed: string[] = [];
    const storageDelete = vi.fn(async (key: string) => {
      if (key === sellerDocumentStagingKey(WORKSPACE_ID, DOC_2)) {
        throw Object.assign(new Error('NoSuchKey'), {
          name: 'NoSuchKey',
          $metadata: { httpStatusCode: 404 },
        });
      }
    });

    let call = 0;
    const withWorkspace = vi.fn(async (_wid: string, fn: (tx: unknown) => Promise<unknown>) => {
      call += 1;
      if (call === 1) {
        return fn({
          $queryRaw: vi.fn(async () => [{ id: DOC_1 }, { id: DOC_2 }]),
        });
      }
      if (call === 2) {
        return fn({
          $queryRaw: vi.fn(async () => [
            { id: DOC_1, object_key: sellerDocumentStagingKey(WORKSPACE_ID, DOC_1) },
          ]),
          $executeRaw: vi.fn(async () => {
            executed.push(DOC_1);
            return 1;
          }),
        });
      }
      return fn({
        $queryRaw: vi.fn(async () => [
          { id: DOC_2, object_key: sellerDocumentStagingKey(WORKSPACE_ID, DOC_2) },
        ]),
        $executeRaw: vi.fn(async () => {
          executed.push(DOC_2);
          return 1;
        }),
      });
    });

    const acts = createSellerDocumentPendingCleanupActivities({
      prisma: { $queryRaw: vi.fn(), withWorkspace } as never,
      storage: { delete: storageDelete },
      env: { SELLER_DOCUMENT_PENDING_UPLOAD_TTL_HOURS: '24' },
    });

    const result = await acts.cleanupStalePendingSellerDocuments({
      workspaceId: WORKSPACE_ID,
    });
    expect(result).toEqual({
      deletedCount: 2,
      s3NotFoundCount: 1,
      skippedMismatchCount: 0,
      hasMore: false,
    });
    expect(executed).toEqual([DOC_1, DOC_2]);
    expect(storageDelete).toHaveBeenCalledTimes(2);
    expect(PENDING_UPLOAD_EXPIRED_CODE).toBe('PENDING_UPLOAD_EXPIRED');

    // Mismatch key is skipped without calling S3 delete or UPDATE.
    let mismatchCall = 0;
    const mismatchExecute = vi.fn();
    const mismatchStorageDelete = vi.fn();
    const mismatchActs = createSellerDocumentPendingCleanupActivities({
      prisma: {
        $queryRaw: vi.fn(),
        withWorkspace: vi.fn(async (_wid: string, fn: (tx: unknown) => Promise<unknown>) => {
          mismatchCall += 1;
          if (mismatchCall === 1) {
            return fn({ $queryRaw: vi.fn(async () => [{ id: DOC_1 }]) });
          }
          return fn({
            $queryRaw: vi.fn(async () => [
              { id: DOC_1, object_key: `ws/${WORKSPACE_ID}/companies/c/seller-documents/${DOC_1}/canon.pdf` },
            ]),
            $executeRaw: mismatchExecute,
          });
        }),
      } as never,
      storage: { delete: mismatchStorageDelete },
    });
    await expect(
      mismatchActs.cleanupStalePendingSellerDocuments({ workspaceId: WORKSPACE_ID }),
    ).resolves.toEqual({
      deletedCount: 0,
      s3NotFoundCount: 0,
      skippedMismatchCount: 1,
      hasMore: false,
    });
    expect(mismatchStorageDelete).not.toHaveBeenCalled();
    expect(mismatchExecute).not.toHaveBeenCalled();

    // Transient 5xx aborts the row transaction and raises for Temporal retry.
    let errCall = 0;
    const errExecute = vi.fn();
    const errActs = createSellerDocumentPendingCleanupActivities({
      prisma: {
        $queryRaw: vi.fn(),
        withWorkspace: vi.fn(async (_wid: string, fn: (tx: unknown) => Promise<unknown>) => {
          errCall += 1;
          if (errCall === 1) {
            return fn({ $queryRaw: vi.fn(async () => [{ id: DOC_1 }]) });
          }
          return fn({
            $queryRaw: vi.fn(async () => [
              { id: DOC_1, object_key: sellerDocumentStagingKey(WORKSPACE_ID, DOC_1) },
            ]),
            $executeRaw: errExecute,
          });
        }),
      } as never,
      storage: {
        delete: vi.fn(async () => {
          throw Object.assign(new Error('S3 InternalError'), {
            name: 'InternalError',
            $metadata: { httpStatusCode: 500 },
          });
        }),
      },
    });
    await expect(
      errActs.cleanupStalePendingSellerDocuments({ workspaceId: WORKSPACE_ID }),
    ).rejects.toThrow('SELLER_DOCUMENT_PENDING_CLEANUP_STORAGE_FAILED:1');
    expect(errExecute).not.toHaveBeenCalled();
  });
});
