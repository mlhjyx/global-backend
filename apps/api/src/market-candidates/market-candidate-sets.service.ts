import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type MarketCandidateFeedback, type MarketCandidateSet, type MarketCandidateSetRevision } from '@prisma/client';
import { isUUID } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestContext } from '../auth/request-context';
import {
  MAX_DOCUMENT_BYTES,
  type MarketCandidateBasisAvailabilityDto, type MarketCandidateBasisSnapshotDto,
  type MarketCandidateFeedbackResultDto, type MarketCandidateLatestDto,
  type MarketCandidateRevisionDto, type MarketCandidateRevisionPageDto,
  type MarketCandidateSetV1Dto, type MarketCandidateSourceReferenceDto,
  type MarketCandidateSourceSnapshotDto,
} from './dto/market-candidate-set.dto';
import { applyFeedback, canonicalJson, createInitialDocument, documentHash, invalidCandidateInput, parseDocument, parseDraft, parseFeedback } from './market-candidate-set.document';

type Tx = Prisma.TransactionClient;
type CompanyLock = { id: string; version: number; deletedAt: Date | null };
const transactionOptions = { maxWait: 20_000, timeout: 30_000 };

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !isUUID(value)) return invalidCandidateInput();
  return value.toLowerCase();
}
function context(value: RequestContext): RequestContext {
  if (!value || typeof value.workspaceId !== 'string' || !isUUID(value.workspaceId) || typeof value.userId !== 'string' || !isUUID(value.userId)) {
    throw new ForbiddenException({ error: { code: 'AUTH_CONTEXT_MISSING', message: '需要可信租户与用户上下文' } });
  }
  return { ...value, workspaceId: value.workspaceId.toLowerCase(), userId: value.userId.toLowerCase() };
}
function notFound(): never {
  throw new NotFoundException({ error: { code: 'NOT_FOUND', message: '候选文档或依据不可用' } });
}
function conflict(code: 'VERSION_CONFLICT' | 'IDEMPOTENCY_CONFLICT', currentRevision?: number): never {
  throw new ConflictException({ error: { code, message: code === 'VERSION_CONFLICT' ? '候选文档版本已变化，请核对当前版本' : '同一幂等标识不能提交不同意图',
    ...(currentRevision === undefined ? {} : { details: { currentRevision } }) } });
}
export function candidateHistoryPage(page: { limit?: number; cursor?: string } = {}): { limit: number; cursor?: number } {
  const limit = page.limit ?? 20;
  const cursor = page.cursor === undefined ? undefined : Number(page.cursor);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100
    || (page.cursor !== undefined && (!/^[1-9][0-9]*$/u.test(page.cursor) || !Number.isSafeInteger(cursor) || cursor! > 2_147_483_647))) return invalidCandidateInput();
  return { limit, cursor };
}

@Injectable()
export class MarketCandidateSetsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private async company(tx: Tx, companyId: string, write = false): Promise<CompanyLock> {
    const rows = write
      ? await tx.$queryRaw<CompanyLock[]>`SELECT id,version,deleted_at AS "deletedAt" FROM company_profile WHERE id=${companyId}::uuid FOR UPDATE`
      : await tx.$queryRaw<CompanyLock[]>`SELECT id,version,deleted_at AS "deletedAt" FROM company_profile WHERE id=${companyId}::uuid FOR SHARE`;
    if (!rows[0] || rows[0].deletedAt) return notFound();
    return rows[0];
  }
  private latest(tx: Tx, companyId: string): Promise<MarketCandidateSet | null> {
    return tx.marketCandidateSet.findFirst({ where: { companyId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  }
  private async set(tx: Tx, setId: string, write = false): Promise<{ head: MarketCandidateSet; company: CompanyLock }> {
    const visible = await tx.marketCandidateSet.findUnique({ where: { id: setId } });
    if (!visible) return notFound();
    const company = await this.company(tx, visible.companyId, write);
    if (write) await tx.$queryRaw`SELECT id FROM market_candidate_set WHERE id=${setId}::uuid FOR UPDATE`;
    const head = await tx.marketCandidateSet.findUnique({ where: { id: setId } });
    if (!head) return notFound();
    return { head, company };
  }
  private async revision(tx: Tx, head: MarketCandidateSet, revision: number): Promise<MarketCandidateSetRevision> {
    const row = await tx.marketCandidateSetRevision.findUnique({ where: { workspaceId_setId_revision: { workspaceId: head.workspaceId, setId: head.id, revision } } });
    if (!row) return notFound();
    return row;
  }
  private async assertDocumentStorageSize(tx: Tx, document: MarketCandidateSetV1Dto): Promise<void> {
    // JSONB text includes separator spaces that canonical hashing deliberately omits.
    const encoded = canonicalJson(document);
    const [stored] = await tx.$queryRaw<{ bytes: number }[]>`SELECT octet_length(${encoded}::jsonb::text) AS bytes`;
    if (stored.bytes > MAX_DOCUMENT_BYTES) return invalidCandidateInput();
  }
  private checkedDocument(row: MarketCandidateSetRevision): MarketCandidateSetV1Dto {
    const doc = parseDocument(row.documentJson);
    if (doc.setId !== row.setId || doc.companyId !== row.companyId || doc.revision !== row.revision || documentHash(doc) !== row.documentHash) {
      throw new Error('MARKET_CANDIDATE_DOCUMENT_INTEGRITY');
    }
    return doc;
  }
  private async claim(tx: Tx, id: string, companyId: string, lock: boolean) {
    // Never wait on a child lock while approval transactions hold it before the parent.
    if (lock) await tx.$queryRaw`SELECT id FROM claim WHERE id=${id}::uuid AND company_id=${companyId}::uuid FOR SHARE NOWAIT`;
    const claim = await tx.claim.findUnique({ where: { id } });
    if (!claim || claim.companyId !== companyId || ['REVOKED','EXPIRED'].includes(claim.status)
      || (claim.validUntil !== null && claim.validUntil.getTime() <= Date.now())) return null;
    return claim;
  }
  private async source(tx: Tx, companyId: string, reference: MarketCandidateSourceReferenceDto, lock: boolean): Promise<MarketCandidateSourceSnapshotDto | null> {
    const id = uuid(reference.sourceId);
    const base: MarketCandidateSourceSnapshotDto = { kind: reference.kind, sourceId: id, key: `${reference.kind}:${id}`,
      version: null, status: null, digest: '', contentHash: null, parentId: null, parentContentHash: null, position: null, sourceDate: null };
    if (reference.kind === 'OFFERING') {
      if (lock) await tx.$queryRaw`SELECT id FROM offering WHERE id=${id}::uuid AND company_id=${companyId}::uuid FOR SHARE`;
      const row = await tx.offering.findUnique({ where: { id } });
      if (!row || row.companyId !== companyId) return null;
      return { ...base, digest: documentHash({ name: row.name, description: row.description, attributes: row.attributes,
        source: row.source, sourceUrl: row.sourceUrl, evidence: row.evidence, confidence: row.confidence }), sourceDate: row.createdAt.toISOString() };
    }
    if (reference.kind === 'CLAIM') {
      const row = await this.claim(tx, id, companyId, lock);
      if (!row) return null;
      return { ...base, version: row.version, status: row.status,
        digest: documentHash({ type: row.type, statement: row.statement, status: row.status, validUntil: row.validUntil?.toISOString() ?? null,
          verifiedBy: row.verifiedBy, verifiedAt: row.verifiedAt?.toISOString() ?? null, verificationMethod: row.verificationMethod, verificationProof: row.verificationProof }),
        sourceDate: row.createdAt.toISOString() };
    }
    if (reference.kind === 'EVIDENCE') {
      const row = await tx.evidence.findUnique({ where: { id } });
      if (!row) return null;
      // Evidence is append-only for app_user; lock its mutable Claim rather than granting Evidence UPDATE for row locks.
      const claim = await this.claim(tx, row.claimId, companyId, lock);
      if (!claim) return null;
      return { ...base, parentId: row.claimId, status: claim.status, contentHash: row.sourceContentHash,
        digest: documentHash({ claimId: row.claimId, claimVersion: claim.version, sourceContentHash: row.sourceContentHash,
          snippet: row.snippet, sourceUrl: row.sourceUrl, sourceSnapshotId: row.sourceSnapshotId, quoteStart: row.quoteStart, quoteEnd: row.quoteEnd,
          quotePrefix: row.quotePrefix, quoteSuffix: row.quoteSuffix }),
        position: { seq: null, page: null, section: null, quoteStart: row.quoteStart, quoteEnd: row.quoteEnd }, sourceDate: row.fetchedAt?.toISOString() ?? null };
    }
    if (reference.kind === 'SELLER_DOCUMENT') {
      if (lock) await tx.$queryRaw`SELECT id FROM seller_document WHERE id=${id}::uuid AND company_id=${companyId}::uuid FOR SHARE`;
      const row = await tx.sellerDocument.findUnique({ where: { id } });
      if (!row || row.companyId !== companyId || row.deletedAt || row.status !== 'ready') return null;
      return { ...base, status: row.status, contentHash: row.contentHash,
        digest: documentHash({ contentHash: row.contentHash, status: row.status, kind: row.kind, sizeBytes: row.sizeBytes.toString() }), sourceDate: row.createdAt.toISOString() };
    }
    const found = await tx.sellerDocumentChunk.findUnique({ where: { id } });
    if (!found) return null;
    if (lock) {
      await tx.$queryRaw`SELECT id FROM seller_document WHERE id=${found.documentId}::uuid AND company_id=${companyId}::uuid FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM seller_document_chunk WHERE id=${id}::uuid FOR SHARE`;
    }
    const row = await tx.sellerDocumentChunk.findUnique({ where: { id } });
    if (!row || row.documentId !== found.documentId) return null;
    const parent = await tx.sellerDocument.findUnique({ where: { id: row.documentId } });
    if (!parent || parent.companyId !== companyId || parent.deletedAt || parent.status !== 'ready' || !parent.contentHash) return null;
    const meta = row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta) ? row.meta : {};
    const page = typeof meta.page === 'number' && Number.isSafeInteger(meta.page) && meta.page >= 1 ? meta.page : null;
    const section = typeof meta.section === 'string' && meta.section.length <= 2000 ? meta.section : null;
    return { ...base, parentId: parent.id, parentContentHash: parent.contentHash, status: parent.status,
      contentHash: createHashOfText(row.text), digest: documentHash({ text: row.text, meta: row.meta, seq: row.seq, parentContentHash: parent.contentHash }),
      position: { seq: row.seq, page, section, quoteStart: null, quoteEnd: null }, sourceDate: row.createdAt.toISOString() };
  }
  private async availability(tx: Tx, company: CompanyLock, snapshot: MarketCandidateBasisSnapshotDto): Promise<MarketCandidateBasisAvailabilityDto[]> {
    const changed = (key: string): MarketCandidateBasisAvailabilityDto => ({ key, status: 'CHANGED', reason: 'VERSION_OR_DIGEST_CHANGED' });
    const result: MarketCandidateBasisAvailabilityDto[] = [company.version === snapshot.company.version
      ? { key: `COMPANY:${company.id}`, status: 'CURRENT', reason: 'MATCHED' }
      : changed(`COMPANY:${company.id}`)];
    for (const source of snapshot.sources) {
      const live = await this.source(tx, company.id, source, false);
      if (!live) result.push({ key: source.key, status: 'UNAVAILABLE', reason: 'SOURCE_UNAVAILABLE' });
      else if (documentHash(live) !== documentHash(source)) result.push(changed(source.key));
      else if (['EVIDENCE','SELLER_DOCUMENT'].includes(source.kind) && !source.contentHash) result.push({ key: source.key, status: 'UNKNOWN', reason: 'FINGERPRINT_UNKNOWN' });
      else result.push({ key: source.key, status: 'CURRENT', reason: 'MATCHED' });
    }
    return result;
  }
  private async present(tx: Tx, head: MarketCandidateSet, company: CompanyLock, row: MarketCandidateSetRevision): Promise<MarketCandidateRevisionDto> {
    const document = this.checkedDocument(row);
    const latest = await this.latest(tx, head.companyId);
    return { document, documentHash: row.documentHash, createdBy: row.createdBy, createdAt: row.createdAt.toISOString(),
      historical: row.revision !== head.currentRevision || latest?.id !== head.id,
      basisAvailability: await this.availability(tx, company, document.basisSnapshot) };
  }

  async persistInitial(ctx: RequestContext, companyId: string, input: unknown, operationIdentity: string): Promise<{ setId: string; revision: 1; documentHash: string; replayed: boolean }> {
    ctx = context(ctx); companyId = uuid(companyId); operationIdentity = uuid(operationIdentity);
    const draft = parseDraft(input);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.withWorkspace(ctx.workspaceId, async tx => {
          return this.persistInitialInTransaction(tx, ctx, companyId, draft, operationIdentity);
        }, transactionOptions);
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2010' || error.meta?.code !== '55P03') throw error;
      }
    }
    throw new ConflictException({ error: { code: 'VERSION_CONFLICT', message: '候选依据正在变更，请沿用原操作标识重试' } });
  }

  async persistInitialInTransaction(tx: Tx, ctx: RequestContext, companyId: string, input: unknown, operationIdentity: string): Promise<{setId:string;revision:1;documentHash:string;replayed:boolean}> {
    ctx = context(ctx); companyId = uuid(companyId); operationIdentity = uuid(operationIdentity);
    const draft = parseDraft(input), requestHash = documentHash(draft);
    const company = await this.company(tx, companyId, true);
    const prior = await tx.marketCandidateSet.findUnique({ where: { workspaceId_companyId_initialOperationId: { workspaceId: ctx.workspaceId, companyId, initialOperationId: operationIdentity } } });
    if (prior) {
      if (prior.initialRequestHash !== requestHash) return conflict('IDEMPOTENCY_CONFLICT');
      const row = await this.revision(tx, prior, 1);
      this.checkedDocument(row);
      return { setId: prior.id, revision: 1 as const, documentHash: row.documentHash, replayed: true };
    }
    const sources: MarketCandidateSourceSnapshotDto[] = [];
    const sorted = [...draft.sources].sort((a, b) => `${a.kind}:${a.sourceId}`.localeCompare(`${b.kind}:${b.sourceId}`, 'en'));
    for (const reference of sorted) {
      const source = await this.source(tx, companyId, reference, true);
      if (!source) return notFound();
      sources.push(source);
    }
    const setId = randomUUID();
    const document = createInitialDocument(draft, { setId, companyId, candidateIds: draft.candidates.map(() => randomUUID()) }, { company: { companyId, version: company.version }, sources });
    await this.assertDocumentStorageSize(tx, document);
    const hash = documentHash(document), latest = await this.latest(tx, companyId);
    const createdAt = new Date(Math.max(Date.now(), (latest?.createdAt.getTime() ?? 0) + 1));
    await tx.marketCandidateSet.create({ data: { id: setId, workspaceId: ctx.workspaceId, companyId, currentRevision: 1,
      initialOperationId: operationIdentity, initialRequestHash: requestHash, createdAt, updatedAt: createdAt } });
    await tx.marketCandidateSetRevision.create({ data: { workspaceId: ctx.workspaceId, companyId, setId, revision: 1, parentRevision: null,
      documentJson: document as unknown as Prisma.InputJsonValue, documentHash: hash, createdBy: ctx.userId } });
    return { setId, revision: 1 as const, documentHash: hash, replayed: false };
  }

  async getLatest(ctx: RequestContext, companyId: string): Promise<MarketCandidateLatestDto> {
    ctx = context(ctx); companyId = uuid(companyId);
    return this.prisma.withWorkspace(ctx.workspaceId, async tx => {
      const company = await this.company(tx, companyId);
      const head = await this.latest(tx, companyId);
      if (!head) return { status: 'NOT_ANALYZED', result: null };
      return { status: 'AVAILABLE', result: await this.present(tx, head, company, await this.revision(tx, head, head.currentRevision)) };
    }, transactionOptions);
  }
  async getCurrent(ctx: RequestContext, setId: string): Promise<MarketCandidateRevisionDto> {
    ctx = context(ctx); setId = uuid(setId);
    return this.prisma.withWorkspace(ctx.workspaceId, async tx => {
      const { head, company } = await this.set(tx, setId);
      return this.present(tx, head, company, await this.revision(tx, head, head.currentRevision));
    }, transactionOptions);
  }
  async listRevisions(ctx: RequestContext, setId: string, page: { limit?: number; cursor?: string } = {}): Promise<MarketCandidateRevisionPageDto> {
    ctx = context(ctx); setId = uuid(setId);
    const { limit, cursor } = candidateHistoryPage(page);
    return this.prisma.withWorkspace(ctx.workspaceId, async tx => {
      await this.set(tx, setId);
      const rows = await tx.marketCandidateSetRevision.findMany({ where: { setId, ...(cursor === undefined ? {} : { revision: { lt: cursor } }) },
        select: { revision: true, documentHash: true, createdBy: true, createdAt: true }, orderBy: { revision: 'desc' }, take: limit + 1 });
      const revisions = rows.slice(0, limit).map(row => ({ ...row, createdAt: row.createdAt.toISOString() }));
      return { revisions, nextCursor: rows.length > limit ? String(revisions.at(-1)!.revision) : null };
    }, transactionOptions);
  }
  async getRevision(ctx: RequestContext, setId: string, revision: number): Promise<MarketCandidateRevisionDto> {
    ctx = context(ctx); setId = uuid(setId);
    if (!Number.isSafeInteger(revision) || revision < 1 || revision > 2_147_483_647) return invalidCandidateInput();
    return this.prisma.withWorkspace(ctx.workspaceId, async tx => {
      const { head, company } = await this.set(tx, setId);
      return this.present(tx, head, company, await this.revision(tx, head, revision));
    }, transactionOptions);
  }
  private async feedbackResult(tx: Tx, head: MarketCandidateSet, company: CompanyLock, row: MarketCandidateFeedback, replayed: boolean): Promise<MarketCandidateFeedbackResultDto> {
    const recorded = await this.revision(tx, head, row.toRevision);
    const document = this.checkedDocument(recorded);
    const previous = this.checkedDocument(await this.revision(tx, head, row.fromRevision));
    const before = previous.candidates.find(candidate => candidate.candidateId === row.candidateId), after = document.candidates.find(candidate => candidate.candidateId === row.candidateId);
    if (!before || !after || documentHash(feedbackOverlay(before)) !== documentHash(row.beforeJson) || documentHash(feedbackOverlay(after)) !== documentHash(row.afterJson)) throw new Error('MARKET_CANDIDATE_FEEDBACK_INTEGRITY');
    return { feedbackId: row.id, setId: row.setId, candidateId: row.candidateId, recordedRevision: row.toRevision, documentHash: recorded.documentHash,
      action: row.action as MarketCandidateFeedbackResultDto['action'], reason: row.reason,
      correction: row.correction as unknown as MarketCandidateFeedbackResultDto['correction'], before, after,
      actorId: row.actorId, createdAt: row.createdAt.toISOString(), replayed,
      basisAvailability: await this.availability(tx, company, document.basisSnapshot) };
  }
  async recordFeedback(ctx: RequestContext, setId: string, candidateId: string, input: unknown, idempotencyKey: string): Promise<MarketCandidateFeedbackResultDto> {
    ctx = context(ctx); setId = uuid(setId); candidateId = uuid(candidateId); idempotencyKey = uuid(idempotencyKey);
    const intention = parseFeedback(input), requestHash = documentHash({ candidateId, input: intention });
    return this.prisma.withWorkspace(ctx.workspaceId, async tx => {
      const { head, company } = await this.set(tx, setId, true);
      const prior = await tx.marketCandidateFeedback.findUnique({ where: { workspaceId_setId_actorId_idempotencyKey: { workspaceId: ctx.workspaceId, setId, actorId: ctx.userId, idempotencyKey } } });
      if (prior) {
        if (prior.requestHash !== requestHash) return conflict('IDEMPOTENCY_CONFLICT');
        return this.feedbackResult(tx, head, company, prior, true);
      }
      const latest = await this.latest(tx, head.companyId);
      if (latest?.id !== setId || intention.expectedRevision !== head.currentRevision) return conflict('VERSION_CONFLICT', head.currentRevision);
      const current = this.checkedDocument(await this.revision(tx, head, head.currentRevision));
      const before = current.candidates.find(candidate => candidate.candidateId === candidateId);
      if (!before) return notFound();
      const next = applyFeedback(current, candidateId, intention), hash = documentHash(next);
      await this.assertDocumentStorageSize(tx, next);
      const after = next.candidates.find(candidate => candidate.candidateId === candidateId)!;
      await tx.marketCandidateSetRevision.create({ data: { workspaceId: ctx.workspaceId, companyId: head.companyId, setId, revision: next.revision,
        parentRevision: head.currentRevision, documentJson: next as unknown as Prisma.InputJsonValue, documentHash: hash, createdBy: ctx.userId } });
      const feedback = await tx.marketCandidateFeedback.create({ data: { id: randomUUID(), workspaceId: ctx.workspaceId, companyId: head.companyId,
        setId, candidateId, fromRevision: head.currentRevision, toRevision: next.revision, action: intention.action, reason: intention.reason,
        correction: intention.correction ? intention.correction as Prisma.InputJsonValue : Prisma.DbNull,
        beforeJson: feedbackOverlay(before) as unknown as Prisma.InputJsonValue, afterJson: feedbackOverlay(after) as unknown as Prisma.InputJsonValue,
        actorId: ctx.userId, idempotencyKey, requestHash } });
      const advanced = await tx.marketCandidateSet.updateMany({ where: { id: setId, currentRevision: head.currentRevision }, data: { currentRevision: next.revision, updatedAt: new Date() } });
      if (advanced.count !== 1) return conflict('VERSION_CONFLICT', head.currentRevision);
      return this.feedbackResult(tx, head, company, feedback, false);
    }, transactionOptions);
  }
}

function createHashOfText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function feedbackOverlay(candidate: MarketCandidateFeedbackResultDto['before']) {
  return { corrections: candidate.corrections, feedback: candidate.feedback,
    needsReassessment: candidate.needsReassessment, impactScope: candidate.impactScope };
}
