import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { sellerDocumentStagingKey } from './seller-documents.service';
import {
  isS3NotFoundError,
  type SellerDocumentsStorage,
} from './seller-documents.storage';

export const PENDING_UPLOAD_EXPIRED_CODE = 'PENDING_UPLOAD_EXPIRED' as const;
export const DEFAULT_SELLER_DOCUMENT_PENDING_UPLOAD_TTL_HOURS = 24;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function resolveSellerDocumentPendingUploadTtlHours(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.SELLER_DOCUMENT_PENDING_UPLOAD_TTL_HOURS?.trim();
  if (!raw) return DEFAULT_SELLER_DOCUMENT_PENDING_UPLOAD_TTL_HOURS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 720) {
    return DEFAULT_SELLER_DOCUMENT_PENDING_UPLOAD_TTL_HOURS;
  }
  return parsed;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export interface SellerDocumentPendingCleanupActivityDeps {
  readonly prisma: PrismaService;
  readonly storage: Pick<SellerDocumentsStorage, 'delete'>;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ListStalePendingWorkspacesInput {
  readonly olderThanHours?: number;
  readonly limit?: number;
  readonly afterWorkspaceId?: string;
}

export interface CleanupStalePendingDocumentsInput {
  readonly workspaceId: string;
  readonly olderThanHours?: number;
  readonly batchLimit?: number;
  readonly maxBatches?: number;
}

export interface CleanupStalePendingDocumentsResult {
  readonly deletedCount: number;
  readonly s3NotFoundCount: number;
  readonly skippedMismatchCount: number;
  readonly hasMore: boolean;
}

export interface SellerDocumentPendingCleanupActivities {
  listStalePendingSellerDocumentWorkspaces(
    input?: ListStalePendingWorkspacesInput,
  ): Promise<{ workspaceIds: string[] }>;
  cleanupStalePendingSellerDocuments(
    input: CleanupStalePendingDocumentsInput,
  ): Promise<CleanupStalePendingDocumentsResult>;
}

export function createSellerDocumentPendingCleanupActivities(
  deps: SellerDocumentPendingCleanupActivityDeps,
): SellerDocumentPendingCleanupActivities {
  const logger = new Logger('SellerDocumentPendingCleanupActivities');

  return {
    async listStalePendingSellerDocumentWorkspaces(
      input: ListStalePendingWorkspacesInput = {},
    ): Promise<{ workspaceIds: string[] }> {
      const olderThanHours = clampInt(
        input.olderThanHours ?? resolveSellerDocumentPendingUploadTtlHours(deps.env),
        1,
        720,
      );
      const limit = clampInt(input.limit ?? 50, 1, 500);
      let afterWorkspaceId: string | null = null;
      if (input.afterWorkspaceId !== undefined) {
        if (!UUID_PATTERN.test(input.afterWorkspaceId)) {
          throw new Error('SELLER_DOCUMENT_PENDING_CLEANUP_INVALID_CURSOR');
        }
        afterWorkspaceId = input.afterWorkspaceId;
      }

      const rows = await deps.prisma.$queryRaw<Array<{ workspace_id: string }>>(
        Prisma.sql`
          SELECT workspace_id::text AS workspace_id
          FROM public.list_stale_pending_seller_document_workspaces_v1(
            ${olderThanHours}::integer,
            ${limit}::integer,
            ${afterWorkspaceId}::uuid
          )
        `,
      );
      return { workspaceIds: rows.map((row) => row.workspace_id) };
    },

    async cleanupStalePendingSellerDocuments(
      input: CleanupStalePendingDocumentsInput,
    ): Promise<CleanupStalePendingDocumentsResult> {
      if (!UUID_PATTERN.test(input.workspaceId)) {
        throw new Error('SELLER_DOCUMENT_PENDING_CLEANUP_INVALID_WORKSPACE');
      }
      const olderThanHours = clampInt(
        input.olderThanHours ?? resolveSellerDocumentPendingUploadTtlHours(deps.env),
        1,
        720,
      );
      const batchLimit = clampInt(input.batchLimit ?? 100, 1, 500);
      const maxBatches = clampInt(input.maxBatches ?? 5, 1, 20);

      let deletedCount = 0;
      let s3NotFoundCount = 0;
      let skippedMismatchCount = 0;
      let failedRows = 0;
      let hasMore = false;

      for (let batch = 0; batch < maxBatches; batch += 1) {
        const candidates = await deps.prisma.withWorkspace(input.workspaceId, (tx) =>
          tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT "id"::text AS id
            FROM "seller_document"
            WHERE "workspace_id" = ${input.workspaceId}::uuid
              AND "status" = 'pending_upload'
              AND "deleted_at" IS NULL
              AND "created_at" <= statement_timestamp() - make_interval(hours => ${olderThanHours}::integer)
            ORDER BY "created_at" ASC, "id" ASC
            LIMIT ${batchLimit}::integer
          `),
        );
        if (candidates.length === 0) {
          hasMore = false;
          break;
        }

        let progressedInBatch = false;
        for (const candidate of candidates) {
          try {
            const outcome = await deps.prisma.withWorkspace(
              input.workspaceId,
              async (tx): Promise<'deleted' | 'skipped' | 'mismatch'> => {
                const locked = await tx.$queryRaw<
                  Array<{ id: string; object_key: string }>
                >(Prisma.sql`
                  SELECT "id"::text AS id, "object_key" AS object_key
                  FROM "seller_document"
                  WHERE "id" = ${candidate.id}::uuid
                    AND "workspace_id" = ${input.workspaceId}::uuid
                    AND "status" = 'pending_upload'
                    AND "deleted_at" IS NULL
                    AND "created_at" <= statement_timestamp() - make_interval(hours => ${olderThanHours}::integer)
                  FOR UPDATE SKIP LOCKED
                `);
                const row = locked[0];
                if (!row) return 'skipped';

                const expectedKey = sellerDocumentStagingKey(
                  input.workspaceId,
                  row.id,
                );
                if (row.object_key !== expectedKey) {
                  logger.warn(
                    `skipping stale pending_upload ${row.id} due to unexpected staging key`,
                  );
                  return 'mismatch';
                }

                try {
                  await deps.storage.delete(row.object_key);
                } catch (error) {
                  if (!isS3NotFoundError(error)) throw error;
                  s3NotFoundCount += 1;
                }

                await tx.$executeRaw(Prisma.sql`
                  UPDATE "seller_document"
                  SET "status" = 'deleted',
                      "deleted_at" = statement_timestamp(),
                      "processing_error_code" = ${PENDING_UPLOAD_EXPIRED_CODE},
                      "lease_token" = NULL,
                      "lease_until" = NULL,
                      "updated_at" = statement_timestamp()
                  WHERE "id" = ${row.id}::uuid
                    AND "workspace_id" = ${input.workspaceId}::uuid
                    AND "status" = 'pending_upload'
                    AND "deleted_at" IS NULL
                `);
                return 'deleted';
              },
            );
            if (outcome === 'deleted') {
              deletedCount += 1;
              progressedInBatch = true;
            } else if (outcome === 'mismatch') {
              skippedMismatchCount += 1;
            }
          } catch (error) {
            failedRows += 1;
            logger.warn(
              `stale pending_upload cleanup failed for ${candidate.id}: ${
                error instanceof Error ? error.message.slice(0, 120) : 'unknown'
              }`,
            );
          }
        }

        if (candidates.length < batchLimit) {
          hasMore = failedRows > 0;
          break;
        }
        hasMore = true;
        if (!progressedInBatch) break;
      }

      if (failedRows > 0) {
        throw new Error(
          `SELLER_DOCUMENT_PENDING_CLEANUP_STORAGE_FAILED:${failedRows}`,
        );
      }

      return {
        deletedCount,
        s3NotFoundCount,
        skippedMismatchCount,
        hasMore,
      };
    },
  };
}
