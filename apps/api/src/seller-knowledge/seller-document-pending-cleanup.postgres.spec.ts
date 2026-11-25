import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { createSellerDocumentPendingCleanupActivities } from './seller-document-pending-cleanup.activities';
import { sellerDocumentStagingKey } from './seller-documents.service';

const ownerUrl = process.env.SELLER_DOCUMENT_PENDING_CLEANUP_TEST_DATABASE_URL;
const appUrl =
  process.env.SELLER_DOCUMENT_PENDING_CLEANUP_TEST_APP_DATABASE_URL;
if (Boolean(ownerUrl) !== Boolean(appUrl)) {
  throw new Error(
    'seller document pending cleanup tests need both SELLER_DOCUMENT_PENDING_CLEANUP_TEST_DATABASE_URL and SELLER_DOCUMENT_PENDING_CLEANUP_TEST_APP_DATABASE_URL',
  );
}
for (const value of [ownerUrl, appUrl]) {
  if (!value) continue;
  const url = new URL(value);
  if (
    url.protocol !== 'postgresql:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !url.pathname.endsWith('_test') ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(
      'seller document pending cleanup tests require a loopback *_test database',
    );
  }
}

function sqlState(error: unknown): string | null {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== 'P2010'
  ) {
    return null;
  }
  const code = (error.meta as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : null;
}

describe.runIf(Boolean(ownerUrl && appUrl))(
  'seller_document pending_upload scheduled cleanup on PostgreSQL as app_user',
  { timeout: 120_000 },
  () => {
    let owner: PrismaClient;
    let app: PrismaClient;
    const wsA = randomUUID();
    const wsB = randomUUID();
    const companyA = randomUUID();
    const companyB = randomUUID();
    const userA = randomUUID();
    const userB = randomUUID();

    function appPrismaService(): PrismaService {
      return {
        $queryRaw: (query: Prisma.Sql) => app.$queryRaw(query),
        withWorkspace: <T>(
          workspaceId: string,
          fn: (tx: Prisma.TransactionClient) => Promise<T>,
        ) =>
          app.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
            return fn(tx);
          }),
      } as unknown as PrismaService;
    }

    async function seedSellerDocument(input: {
      id?: string;
      workspaceId: string;
      companyId: string;
      uploadedBy: string;
      status: 'pending_upload' | 'queued' | 'ready' | 'deleted';
      ageHours: number;
      sizeBytes?: bigint;
      objectKey?: string;
    }): Promise<string> {
      const id = input.id ?? randomUUID();
      const objectKey =
        input.objectKey ?? sellerDocumentStagingKey(input.workspaceId, id);
      const deletedAt = input.status === 'deleted' ? new Date() : null;
      await owner.$executeRaw`
        INSERT INTO "seller_document" (
          "id", "workspace_id", "company_id", "uploaded_by",
          "filename", "mime", "size_bytes", "kind", "object_key",
          "status", "deleted_at", "created_at", "updated_at"
        ) VALUES (
          ${id}::uuid, ${input.workspaceId}::uuid, ${input.companyId}::uuid, ${input.uploadedBy}::uuid,
          ${`doc-${id}.pdf`}, 'application/pdf', ${input.sizeBytes ?? 1024n}, 'pdf', ${objectKey},
          ${input.status}, ${deletedAt},
          statement_timestamp() - make_interval(hours => ${input.ageHours}::integer),
          statement_timestamp() - make_interval(hours => ${input.ageHours}::integer)
        )
      `;
      return id;
    }

    beforeAll(async () => {
      owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
      app = new PrismaClient({ datasources: { db: { url: appUrl } } });
      await owner.$executeRaw`
        INSERT INTO workspace (id, name, created_at, updated_at) VALUES
          (${wsA}::uuid, 'Pending Cleanup WS A', now(), now()),
          (${wsB}::uuid, 'Pending Cleanup WS B', now(), now())
      `;
      await owner.$executeRaw`
        INSERT INTO company_profile (id, workspace_id, name, created_at, updated_at) VALUES
          (${companyA}::uuid, ${wsA}::uuid, 'Pending Cleanup Co A', now(), now()),
          (${companyB}::uuid, ${wsB}::uuid, 'Pending Cleanup Co B', now(), now())
      `;
    });

    afterAll(async () => {
      if (owner) {
        await owner.$executeRaw`
          DELETE FROM seller_document WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)
        `;
        await owner.$executeRaw`
          DELETE FROM company_profile WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)
        `;
        await owner.$executeRaw`
          DELETE FROM workspace WHERE id IN (${wsA}::uuid, ${wsB}::uuid)
        `;
      }
      await Promise.all([owner?.$disconnect(), app?.$disconnect()]);
    });

    it('keeps runtime_customer_worker_ops excluded from public.seller_document and the new SECURITY DEFINER enumerator', async () => {
      const hasRole = await owner.$queryRaw<Array<{ present: boolean }>>`
        SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'runtime_customer_worker_ops') AS present
      `;
      if (hasRole[0]?.present) {
        const privs = await owner.$queryRaw<
          Array<{ table_sel: boolean; fn_exec: boolean }>
        >`
          SELECT
            has_table_privilege('runtime_customer_worker_ops', 'public.seller_document', 'SELECT') AS table_sel,
            has_function_privilege(
              'runtime_customer_worker_ops',
              'public.list_stale_pending_seller_document_workspaces_v1(integer, integer, uuid)',
              'EXECUTE'
            ) AS fn_exec
        `;
        expect(privs[0]).toEqual({ table_sel: false, fn_exec: false });
      }
      const appExec = await owner.$queryRaw<Array<{ fn_exec: boolean }>>`
        SELECT has_function_privilege(
          'app_user',
          'public.list_stale_pending_seller_document_workspaces_v1(integer, integer, uuid)',
          'EXECUTE'
        ) AS fn_exec
      `;
      expect(appExec[0]).toEqual({ fn_exec: true });

      let deniedState: string | null = null;
      try {
        await app.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL ROLE runtime_customer_worker_ops`;
          await tx.$queryRaw`
            SELECT * FROM public.list_stale_pending_seller_document_workspaces_v1(24::integer, 10::integer, NULL::uuid)
          `;
        });
      } catch (error) {
        deniedState = sqlState(error);
      }
      if (hasRole[0]?.present) {
        expect(['42501']).toContain(deniedState);
      }
    });

    it('enumerates stale workspaces, cleans expired pending_upload rows with S3 404 tolerance, frees quotas, and preserves fresh/queued/locked/5xx rows', async () => {
      const staleOkId = await seedSellerDocument({
        workspaceId: wsA,
        companyId: companyA,
        uploadedBy: userA,
        status: 'pending_upload',
        ageHours: 25,
        sizeBytes: 123_456n,
      });
      const stale404Id = await seedSellerDocument({
        workspaceId: wsA,
        companyId: companyA,
        uploadedBy: userA,
        status: 'pending_upload',
        ageHours: 26,
        sizeBytes: 654_321n,
      });
      const freshId = await seedSellerDocument({
        workspaceId: wsA,
        companyId: companyA,
        uploadedBy: userA,
        status: 'pending_upload',
        ageHours: 2,
        sizeBytes: 1_000n,
      });
      const queuedId = await seedSellerDocument({
        workspaceId: wsA,
        companyId: companyA,
        uploadedBy: userA,
        status: 'queued',
        ageHours: 30,
        sizeBytes: 2_000n,
      });
      const wsBStaleId = await seedSellerDocument({
        workspaceId: wsB,
        companyId: companyB,
        uploadedBy: userB,
        status: 'pending_upload',
        ageHours: 48,
        sizeBytes: 5_000n,
      });

      const storageKeysDeleted: string[] = [];
      const acts = createSellerDocumentPendingCleanupActivities({
        prisma: appPrismaService(),
        storage: {
          delete: vi.fn(async (key: string) => {
            storageKeysDeleted.push(key);
            if (key === sellerDocumentStagingKey(wsA, stale404Id)) {
              throw Object.assign(new Error('NoSuchKey'), {
                name: 'NoSuchKey',
                $metadata: { httpStatusCode: 404 },
              });
            }
          }),
        },
        env: { SELLER_DOCUMENT_PENDING_UPLOAD_TTL_HOURS: '24' },
      });

      const listed = await acts.listStalePendingSellerDocumentWorkspaces({
        olderThanHours: 24,
        limit: 50,
      });
      expect(listed.workspaceIds).toContain(wsA);
      expect(listed.workspaceIds).toContain(wsB);

      const cleanupA = await acts.cleanupStalePendingSellerDocuments({
        workspaceId: wsA,
      });
      expect(cleanupA).toEqual({
        deletedCount: 2,
        s3NotFoundCount: 1,
        skippedMismatchCount: 0,
        hasMore: false,
      });
      expect(storageKeysDeleted.sort()).toEqual(
        [
          sellerDocumentStagingKey(wsA, staleOkId),
          sellerDocumentStagingKey(wsA, stale404Id),
        ].sort(),
      );

      // Verify quota freed (only freshId + queuedId count toward active deletedAt: null) and wsB untouched.
      const rows = await owner.$queryRaw<
        Array<{
          id: string;
          status: string;
          deleted_at: Date | null;
          processing_error_code: string | null;
        }>
      >`
        SELECT id::text, status, deleted_at, processing_error_code
        FROM seller_document
        WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid)
      `;
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(staleOkId)).toMatchObject({
        status: 'deleted',
        processing_error_code: 'PENDING_UPLOAD_EXPIRED',
      });
      expect(byId.get(staleOkId)?.deleted_at).toBeInstanceOf(Date);
      expect(byId.get(stale404Id)).toMatchObject({
        status: 'deleted',
        processing_error_code: 'PENDING_UPLOAD_EXPIRED',
      });
      expect(byId.get(freshId)).toMatchObject({
        status: 'pending_upload',
        deleted_at: null,
      });
      expect(byId.get(queuedId)).toMatchObject({
        status: 'queued',
        deleted_at: null,
      });
      expect(byId.get(wsBStaleId)).toMatchObject({
        status: 'pending_upload',
        deleted_at: null,
      });

      // Quota aggregation after cleanup excludes deleted stale rows.
      const [quotaAfter] = await app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${wsA}, true)`;
        return tx.$queryRaw<Array<{ active_count: bigint; active_bytes: bigint }>>`
          SELECT count(*) AS active_count, coalesce(sum(size_bytes), 0)::bigint AS active_bytes
          FROM seller_document
          WHERE deleted_at IS NULL
        `;
      });
      expect(quotaAfter).toEqual({ active_count: 2n, active_bytes: 3_000n });

      // Transient S3 5xx preserves wsBStaleId as pending_upload.
      const failingActs = createSellerDocumentPendingCleanupActivities({
        prisma: appPrismaService(),
        storage: {
          delete: vi.fn(async () => {
            throw Object.assign(new Error('S3 503'), {
              name: 'ServiceUnavailable',
              $metadata: { httpStatusCode: 503 },
            });
          }),
        },
      });
      await expect(
        failingActs.cleanupStalePendingSellerDocuments({ workspaceId: wsB }),
      ).rejects.toThrow('SELLER_DOCUMENT_PENDING_CLEANUP_STORAGE_FAILED:1');
      const [wsBAfterFail] = await owner.$queryRaw<
        Array<{ status: string; deleted_at: Date | null }>
      >`
        SELECT status, deleted_at FROM seller_document WHERE id = ${wsBStaleId}::uuid
      `;
      expect(wsBAfterFail).toEqual({ status: 'pending_upload', deleted_at: null });

      // Concurrent FOR UPDATE lock is skipped via SKIP LOCKED without touching S3.
      const skipLockDelete = vi.fn();
      const skipLockActs = createSellerDocumentPendingCleanupActivities({
        prisma: appPrismaService(),
        storage: { delete: skipLockDelete },
      });
      let releaseLock!: () => void;
      let markLocked!: () => void;
      const lockedPromise = new Promise<void>((resolve) => {
        markLocked = resolve;
      });
      const gatePromise = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const lockHolder = owner.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT id FROM seller_document WHERE id = ${wsBStaleId}::uuid FOR UPDATE
          `;
          markLocked();
          await gatePromise;
        },
        { timeout: 30_000, maxWait: 10_000 },
      );
      await lockedPromise;
      const skipResult = await skipLockActs.cleanupStalePendingSellerDocuments({
        workspaceId: wsB,
      });
      releaseLock();
      await lockHolder;
      expect(skipResult.deletedCount).toBe(0);
      expect(skipLockDelete).not.toHaveBeenCalled();
    });
  },
);
