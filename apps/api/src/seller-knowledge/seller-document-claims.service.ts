import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestContext } from '../auth/request-context';
import {
  documentClaimBindingHash,
  documentClaimOriginKey,
  documentClaimQuoteBytes,
  documentClaimRequestDigest,
  documentClaimStatementDigest,
  DocumentClaimBasisError,
  loadDocumentClaimBindingInTransaction,
  parseDocumentClaimSourceRef,
  validDocumentClaimStatement,
  validDocumentClaimType,
  verifyDocumentClaimReference,
  type DocumentClaimSourceRef,
} from '../claim/document-claim-basis';

type Tx = Prisma.TransactionClient;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
function contextMeta(meta: unknown): Record<string, unknown> | null {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return null;
  try {
    return JSON.stringify(meta).length <= 4096 ? (meta as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
function basisError(error: unknown): never {
  if (error instanceof DocumentClaimBasisError) {
    const status =
      error.code === 'INVALID_DOCUMENT_CLAIM_REF' || error.code === 'DOCUMENT_CLAIM_QUOTE_TOO_LARGE'
        ? 400
        : 409;
    const payload = { error: { code: error.code, message: 'document claim reference is not usable' } };
    if (status === 400) throw new BadRequestException(payload);
    throw new ConflictException(payload);
  }
  throw error;
}

@Injectable()
export class SellerDocumentClaimsService {
  constructor(private readonly prisma: PrismaService) {}

  async readChunk(ctx: RequestContext, companyId: string, documentId: string, seq: number) {
    if (!Number.isSafeInteger(seq) || seq < 0) throw new BadRequestException({
      error: { code: 'INVALID_DOCUMENT_CHUNK_SEQ', message: 'chunk seq must be a nonnegative integer' },
    });
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const document = await this.loadDocument(tx, ctx, companyId, documentId, true);
      const chunk = await tx.sellerDocumentChunk.findFirst({
        where: { workspaceId: ctx.workspaceId, documentId, seq },
        select: { seq: true, text: true, meta: true },
      });
      if (!chunk) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'chunk not found' } });
      return {
        documentId,
        documentContentHash: document.contentHash!,
        parseRevision: document.parseRevision!,
        chunkSeq: chunk.seq,
        chunkTextHash: sha256(chunk.text),
        text: chunk.text,
        context: contextMeta(chunk.meta),
      };
    });
  }

  async preview(
    ctx: RequestContext,
    companyId: string,
    documentId: string,
    input: { reference: unknown; type: string; statement: string },
  ) {
    const reference = this.parseReference(documentId, input);
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) =>
      this.previewInTransaction(tx, ctx, companyId, reference, input.type, input.statement),
    );
  }

  async createDraft(
    ctx: RequestContext,
    companyId: string,
    documentId: string,
    input: { reference: unknown; type: string; statement: string; requestDigest: string },
  ) {
    const reference = this.parseReference(documentId, input);
    const requestDigest = documentClaimRequestDigest({
      workspaceId: ctx.workspaceId,
      companyId,
      requesterId: ctx.userId,
      reference,
      type: input.type,
      statement: input.statement,
    });
    if (typeof input.requestDigest !== 'string' || input.requestDigest !== requestDigest) {
      throw new ConflictException({
        error: { code: 'DOCUMENT_CLAIM_REQUEST_MISMATCH', message: 'request digest does not match the current request' },
      });
    }
    try {
      return await this.prisma.withWorkspace(ctx.workspaceId, async (tx) =>
        this.createInTransaction(tx, ctx, companyId, reference, input.type, input.statement, requestDigest),
      );
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw basisError(error);
      // Concurrent identical origin: replay the winner under current scope.
      return this.prisma.withWorkspace(ctx.workspaceId, async (tx) =>
        this.replayByOrigin(tx, ctx, companyId, reference, input.type, input.statement),
      );
    }
  }

  private parseReference(documentId: string, input: { reference: unknown; type: string; statement: string }): DocumentClaimSourceRef {
    if (!validDocumentClaimType(input.type)) throw new BadRequestException({
      error: { code: 'INVALID_DOCUMENT_CLAIM_TYPE', message: 'claim type must be 1-50 chars of letters/digits/._:-' },
    });
    if (!validDocumentClaimStatement(input.statement)) throw new BadRequestException({
      error: { code: 'INVALID_DOCUMENT_CLAIM_STATEMENT', message: 'statement must be 1-4000 characters' },
    });
    try {
      const reference = parseDocumentClaimSourceRef(input.reference);
      if (reference.documentId !== documentId) throw new DocumentClaimBasisError('INVALID_DOCUMENT_CLAIM_REF');
      return reference;
    } catch (error) {
      return basisError(error);
    }
  }

  private async loadDocument(
    tx: Tx,
    ctx: RequestContext,
    companyId: string,
    documentId: string,
    requireReady: boolean,
  ) {
    const document = await tx.sellerDocument.findFirst({
      where: { id: documentId, workspaceId: ctx.workspaceId, companyId, deletedAt: null },
      select: { id: true, workspaceId: true, companyId: true, contentHash: true, parseRevision: true, status: true, deletedAt: true, kind: true },
    });
    if (!document) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'document not found' } });
    if (requireReady && (document.status !== 'ready' || document.contentHash === null || document.parseRevision === null))
      throw new ConflictException({ error: { code: 'DOCUMENT_CLAIM_SOURCE_UNAVAILABLE', message: 'document is not ready for exact quoting' } });
    return document;
  }

  private async previewInTransaction(
    tx: Tx,
    ctx: RequestContext,
    companyId: string,
    reference: DocumentClaimSourceRef,
    type: string,
    statement: string,
  ) {
    const document = await this.loadDocument(tx, ctx, companyId, reference.documentId, true);
    const chunk = await tx.sellerDocumentChunk.findFirst({
      where: { workspaceId: ctx.workspaceId, documentId: reference.documentId, seq: reference.chunkSeq },
      select: { documentId: true, seq: true, text: true, meta: true },
    });
    let verified: { quote: string; quoteDigest: string; chunkTextHash: string };
    try {
      verified = verifyDocumentClaimReference({ document, chunk, evidenceSnippet: null, reference, context: { workspaceId: ctx.workspaceId, companyId } });
    } catch (error) {
      return basisError(error);
    }
    const statementDigest = documentClaimStatementDigest(statement);
    const bindingHash = documentClaimBindingHash({
      documentId: reference.documentId,
      documentContentHash: reference.documentContentHash,
      parseRevision: reference.parseRevision,
      chunkSeq: reference.chunkSeq,
      chunkTextHash: verified.chunkTextHash,
      quoteStartByte: reference.quoteStartByte,
      quoteEndByte: reference.quoteEndByte,
      quoteDigest: verified.quoteDigest,
      type,
      statementDigest,
    });
    const requestDigest = documentClaimRequestDigest({
      workspaceId: ctx.workspaceId,
      companyId,
      requesterId: ctx.userId,
      reference,
      type,
      statement,
    });
    return {
      documentId: reference.documentId,
      documentContentHash: reference.documentContentHash,
      parseRevision: reference.parseRevision,
      chunkSeq: reference.chunkSeq,
      quote: verified.quote,
      quoteStartByte: reference.quoteStartByte,
      quoteEndByte: reference.quoteEndByte,
      quoteDigest: verified.quoteDigest,
      statementDigest,
      bindingHash,
      requestDigest,
      context: contextMeta(chunk?.meta ?? null),
    };
  }

  private originFor(
    ctx: RequestContext,
    companyId: string,
    reference: DocumentClaimSourceRef,
    type: string,
    statement: string,
  ): string {
    return documentClaimOriginKey({
      workspaceId: ctx.workspaceId,
      companyId,
      documentId: reference.documentId,
      parseRevision: reference.parseRevision,
      chunkSeq: reference.chunkSeq,
      quoteStartByte: reference.quoteStartByte,
      quoteEndByte: reference.quoteEndByte,
      type,
      statementDigest: documentClaimStatementDigest(statement),
    });
  }

  private async createInTransaction(
    tx: Tx,
    ctx: RequestContext,
    companyId: string,
    reference: DocumentClaimSourceRef,
    type: string,
    statement: string,
    requestDigest: string,
  ) {
    // Lock order: company -> document -> claim/reference.
    const company = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "company_profile"
      WHERE "id" = ${companyId}::uuid AND "workspace_id" = ${ctx.workspaceId}::uuid AND "deleted_at" IS NULL
      FOR SHARE`);
    if (company.length !== 1) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'company not found' } });
    const documentRow = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "seller_document"
      WHERE "id" = ${reference.documentId}::uuid AND "workspace_id" = ${ctx.workspaceId}::uuid AND "company_id" = ${companyId}::uuid
      FOR UPDATE`);
    if (documentRow.length !== 1) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'document not found' } });
    const originKey = this.originFor(ctx, companyId, reference, type, statement);
    const existing = await tx.claim.findUnique({ where: { companyId_originKey: { companyId, originKey } } });
    if (existing) return this.replayExisting(tx, ctx, companyId, existing, reference, type, statement);
    const document = await this.loadDocument(tx, ctx, companyId, reference.documentId, true);
    const chunk = await tx.sellerDocumentChunk.findFirst({
      where: { workspaceId: ctx.workspaceId, documentId: reference.documentId, seq: reference.chunkSeq },
      select: { documentId: true, seq: true, text: true },
    });
    let verified: { quote: string; quoteDigest: string; chunkTextHash: string };
    try {
      verified = verifyDocumentClaimReference({ document, chunk, evidenceSnippet: null, reference, context: { workspaceId: ctx.workspaceId, companyId } });
    } catch (error) {
      return basisError(error);
    }
    const statementDigest = documentClaimStatementDigest(statement);
    const bindingHash = documentClaimBindingHash({
      documentId: reference.documentId,
      documentContentHash: reference.documentContentHash,
      parseRevision: reference.parseRevision,
      chunkSeq: reference.chunkSeq,
      chunkTextHash: verified.chunkTextHash,
      quoteStartByte: reference.quoteStartByte,
      quoteEndByte: reference.quoteEndByte,
      quoteDigest: verified.quoteDigest,
      type,
      statementDigest,
    });
    const source = await tx.knowledgeSource.create({
      data: {
        workspaceId: ctx.workspaceId,
        companyId,
        type: document.kind,
        uri: `seller-document:${document.id}#rev${reference.parseRevision}:chunk${reference.chunkSeq}`,
        status: 'PARSED',
        ingestKey: `document-claim:${originKey}`,
      },
      select: { id: true },
    });
    const claim = await tx.claim.create({
      data: {
        workspaceId: ctx.workspaceId,
        companyId,
        sourceId: source.id,
        originKey,
        factKey: null,
        type,
        statement,
        status: 'NEEDS_REVIEW',
        confidence: 1,
      },
      select: { id: true, version: true, status: true },
    });
    // Existing Evidence rows store character offsets; the typed reference keeps exact UTF-8
    // byte offsets. Convert at this boundary so both invariants stay true for multi-byte text.
    const chunkBytes = Buffer.from(chunk!.text, 'utf8');
    const charStart = Array.from(chunkBytes.subarray(0, reference.quoteStartByte).toString('utf8')).length;
    const evidence = await tx.evidence.create({
      data: {
        workspaceId: ctx.workspaceId,
        claimId: claim.id,
        originKey,
        sourceUrl: null,
        sourceContentHash: reference.documentContentHash,
        snippet: verified.quote,
        quoteStart: charStart,
        quoteEnd: charStart + Array.from(verified.quote).length,
        confidence: 1,
        fetchedAt: new Date(),
      },
      select: { id: true },
    });
    const referenceRow = await tx.claimDocumentEvidence.create({
      data: {
        workspaceId: ctx.workspaceId,
        companyId,
        claimId: claim.id,
        evidenceId: evidence.id,
        documentId: document.id,
        sourceDocumentId: reference.documentId,
        documentContentSha256: reference.documentContentHash,
        parseRevision: reference.parseRevision,
        chunkSeq: reference.chunkSeq,
        chunkTextSha256: verified.chunkTextHash,
        quoteStartByte: reference.quoteStartByte,
        quoteEndByte: reference.quoteEndByte,
        referenceVersion: 1,
        claimStatementDigest: statementDigest,
        claimType: type,
        bindingSha256: bindingHash,
        requesterId: ctx.userId,
        requestDigest,
      },
      select: { id: true },
    });
    return {
      claimId: claim.id,
      evidenceId: evidence.id,
      referenceId: referenceRow.id,
      bindingHash,
      status: claim.status,
      claimVersion: claim.version,
      replayed: false,
      available: true,
    };
  }

  private async replayByOrigin(
    tx: Tx,
    ctx: RequestContext,
    companyId: string,
    reference: DocumentClaimSourceRef,
    type: string,
    statement: string,
  ) {
    const originKey = this.originFor(ctx, companyId, reference, type, statement);
    const existing = await tx.claim.findUnique({ where: { companyId_originKey: { companyId, originKey } } });
    if (!existing) throw new ConflictException({ error: { code: 'DOCUMENT_CLAIM_CONFLICT', message: 'claim changed concurrently' } });
    return this.replayExisting(tx, ctx, companyId, existing, reference, type, statement);
  }

  private async replayExisting(
    tx: Tx,
    ctx: RequestContext,
    companyId: string,
    existing: { id: string; status: string; version: number },
    reference: DocumentClaimSourceRef,
    type: string,
    statement: string,
  ) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "claim" WHERE "id" = ${existing.id}::uuid AND "workspace_id" = ${ctx.workspaceId}::uuid FOR UPDATE`);
    if (locked.length !== 1) throw new ConflictException({ error: { code: 'DOCUMENT_CLAIM_CONFLICT', message: 'claim changed concurrently' } });
    const current = await tx.claim.findUniqueOrThrow({ where: { id: existing.id }, select: { id: true, companyId: true, status: true, version: true, statement: true, type: true } });
    const ref = await tx.claimDocumentEvidence.findUnique({ where: { claimId: current.id } });
    const evidence = ref ? await tx.evidence.findFirst({ where: { id: ref.evidenceId, workspaceId: ctx.workspaceId, claimId: current.id } }) : null;
    if (
      !ref ||
      !evidence ||
      current.type !== type ||
      documentClaimStatementDigest(statement) !== ref.claimStatementDigest ||
      ref.documentContentSha256 !== reference.documentContentHash ||
      ref.parseRevision !== reference.parseRevision ||
      ref.chunkSeq !== reference.chunkSeq ||
      ref.chunkTextSha256 !== reference.chunkTextHash ||
      ref.quoteStartByte !== reference.quoteStartByte ||
      ref.quoteEndByte !== reference.quoteEndByte
    )
      throw new ConflictException({ error: { code: 'DOCUMENT_CLAIM_CONFLICT', message: 'same origin differs from the stored draft' } });
    const quote = documentClaimQuoteBytes(evidence.snippet ?? '', 0, Buffer.byteLength(evidence.snippet ?? '', 'utf8'));
    const bindingHash = documentClaimBindingHash({
      documentId: ref.sourceDocumentId,
      documentContentHash: ref.documentContentSha256,
      parseRevision: ref.parseRevision,
      chunkSeq: ref.chunkSeq,
      chunkTextHash: ref.chunkTextSha256,
      quoteStartByte: ref.quoteStartByte,
      quoteEndByte: ref.quoteEndByte,
      quoteDigest: quote.quoteDigest,
      type: ref.claimType,
      statementDigest: ref.claimStatementDigest,
    });
    if (bindingHash !== ref.bindingSha256)
      throw new ConflictException({ error: { code: 'DOCUMENT_CLAIM_CONFLICT', message: 'stored binding is inconsistent' } });
    const binding = await loadDocumentClaimBindingInTransaction(tx, { workspaceId: ctx.workspaceId, companyId }, current);
    return {
      claimId: current.id,
      evidenceId: ref.evidenceId,
      referenceId: ref.id,
      bindingHash,
      status: current.status,
      claimVersion: current.version,
      replayed: true,
      available: binding !== null,
    };
  }
}
