import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestContext } from '../auth/request-context';
import {
  SELLER_DOCUMENT_CLEANUP_MAX_CHUNKS,
  SELLER_DOCUMENT_CLEANUP_POLICY_VERSION,
  SELLER_DOCUMENT_CLEANUP_SUBJECT_TYPE,
} from './seller-document-cleanup.types';

/**
 * 内部 seller_document 清理请求：复用 DeletionRequest/Receipt/outbox 底座，
 * 不进入公共 DELETION_SUBJECT_TYPES，不对客户声称物理完成。
 *
 * The relay dispatches this dedicated internal command (never the public DeletionRequested)
 * into the same deletionWorkflow with subjectType=seller_document.
 */
@Injectable()
export class SellerDocumentCleanupService {
  constructor(private readonly prisma: PrismaService) {}

  /** Same workspace transaction as the authorized delete entry; snapshot is ID/count-only. */
  static async createSellerDocumentCleanupRequestInTransaction(
    tx: Prisma.TransactionClient,
    ctx: RequestContext,
    input: { documentId: string; companyId: string },
  ): Promise<{ requestId: string; replayed: boolean }> {
    const existing = await tx.deletionRequest.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        subjectType: SELLER_DOCUMENT_CLEANUP_SUBJECT_TYPE,
        subjectId: input.documentId,
        status: { in: ['RECEIVED', 'FROZEN', 'ERASING'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (existing) return { requestId: existing.id, replayed: true };

    const references = await tx.claimDocumentEvidence.findMany({
      where: { workspaceId: ctx.workspaceId, documentId: input.documentId },
      select: { id: true, claimId: true, evidenceId: true },
    });
    const claimIds = [...new Set(references.map((row) => row.claimId))].sort();
    const evidenceIds = [...new Set(references.map((row) => row.evidenceId))].sort();
    const referenceIds = references.map((row) => row.id).sort();
    const chunks = await tx.sellerDocumentChunk.findMany({
      where: { workspaceId: ctx.workspaceId, documentId: input.documentId },
      select: { id: true },
      orderBy: { seq: 'asc' },
      take: SELLER_DOCUMENT_CLEANUP_MAX_CHUNKS + 1,
    });
    if (chunks.length > SELLER_DOCUMENT_CLEANUP_MAX_CHUNKS)
      throw new ConflictException({
        error: { code: 'SELLER_DOCUMENT_CLEANUP_TOO_LARGE', message: 'document has too many chunks for one cleanup request' },
      });
    const sources = claimIds.length
      ? await tx.claim.findMany({
          where: { id: { in: claimIds }, workspaceId: ctx.workspaceId, companyId: input.companyId },
          select: { sourceId: true },
        })
      : [];
    const knowledgeSourceIds = [...new Set(sources.flatMap((row) => (row.sourceId === null ? [] : [row.sourceId])))].sort();

    const created = await tx.deletionRequest.create({
      data: {
        workspaceId: ctx.workspaceId,
        subjectType: SELLER_DOCUMENT_CLEANUP_SUBJECT_TYPE,
        subjectId: input.documentId,
        status: 'RECEIVED',
        requestedBy: ctx.userId,
        reason: 'manual',
        stats: {
          policyVersion: SELLER_DOCUMENT_CLEANUP_POLICY_VERSION,
          documentId: input.documentId,
          companyId: input.companyId,
          chunkIds: chunks.map((row) => row.id),
          claimIds,
          evidenceIds,
          referenceIds,
          knowledgeSourceIds,
        } as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    const event = await tx.outboxEvent.create({
      data: {
        workspaceId: ctx.workspaceId,
        eventType: 'SellerDocumentCleanupRequested',
        aggregateType: 'DeletionRequest',
        aggregateId: created.id,
        payload: { subjectType: SELLER_DOCUMENT_CLEANUP_SUBJECT_TYPE, subjectId: input.documentId },
      },
      select: { eventId: true },
    });
    await tx.sellerDocument.updateMany({
      where: { id: input.documentId, workspaceId: ctx.workspaceId, companyId: input.companyId, deletedAt: { not: null } },
      data: { cleanupEventId: event.eventId },
    });
    return { requestId: created.id, replayed: false };
  }

  /** Customer-facing delete entry: soft delete + internal cleanup request in one transaction. */
  async requestCleanup(ctx: RequestContext, companyId: string, documentId: string): Promise<{ requestId: string }> {
    const row = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.sellerDocument.findFirst({ where: { id: documentId, companyId, deletedAt: null }, select: { id: true } }),
    );
    if (!row) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'document not found' } });
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "seller_document"
         WHERE "id" = ${documentId}::uuid AND "workspace_id" = ${ctx.workspaceId}::uuid AND "company_id" = ${companyId}::uuid
         FOR UPDATE`);
      if (locked.length !== 1) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'document not found' } });
      await tx.sellerDocument.update({
        where: { id: documentId },
        data: { status: 'deleted', deletedAt: new Date(), deletedBy: ctx.userId },
      });
      const request = await SellerDocumentCleanupService.createSellerDocumentCleanupRequestInTransaction(tx, ctx, {
        documentId,
        companyId,
      });
      return { requestId: request.requestId };
    });
  }
}
