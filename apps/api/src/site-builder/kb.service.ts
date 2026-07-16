import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Asset, KbDocument, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext } from '../auth/request-context';
import { Chunk, chunkMarkdown } from './chunker';
import { DoclingClient } from './docling.client';
import { EmbeddingsClient } from './embeddings.client';
import { asKbIngestError, errorMessage, KbIngestError } from './kb-errors';
import { StorageService } from './storage.service';

const EMBED_BATCH = 32;
const KB_LEASE_MS = 20 * 60 * 1000;
const KB_RETRY_BASE_MS = 60 * 1000;
const KB_RETRY_MAX_MS = 60 * 60 * 1000;
const KB_DUE_BATCH = 25;

/** 直读文本的 MIME；其余文档类走 Docling 解析。 */
const TEXT_MIMES: ReadonlySet<string> = new Set(['text/plain', 'text/markdown']);

export interface IngestTextInput {
  siteId: string;
  source: 'intake' | 'wizard' | 'upload' | 'storefront' | 'web_research';
  title: string;
  text: string;
  lang?: string;
  assetId?: string;
}

export interface KbStatus {
  documents: number;
  chunks: number;
  /** 待补资料清单（最新 brand_profile 版本回填；见 agents/brand-profile.ts GapItem）。 */
  gaps: { field: string; reason: string; hint: string }[];
}

export interface SearchHit {
  documentId: string;
  seq: number;
  text: string;
  score: number;
}

export type KbProcessOutcome =
  | 'ready'
  | 'retry_scheduled'
  | 'failed_terminal'
  | 'not_due'
  | 'superseded';

export interface KbProcessResult {
  assetId: string;
  outcome: KbProcessOutcome;
  attempt?: number;
  errorCode?: string;
  retryAt?: Date;
}

interface KbFence {
  token: string;
  attempt: number;
}

export interface KbProcessOptions {
  signal?: AbortSignal;
  heartbeat?: (stage: string) => void;
}

/**
 * 知识库地基（02 §12）：解析（Docling/直读）→ 结构感知切块 → BGE-M3 批量向量化 →
 * pgvector 落库（RLS 事务内）。网络调用（embedding/解析）在事务外，避免长事务。
 */
@Injectable()
export class KbService {
  private readonly log = new Logger(KbService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: EmbeddingsClient,
    private readonly docling: DoclingClient,
    private readonly storage: StorageService,
  ) {}

  async ingestText(ctx: RequestContext, input: IngestTextInput): Promise<KbDocument> {
    if ((input.source === 'upload') !== Boolean(input.assetId)) {
      throw new Error('KB upload documents require exactly one assetId');
    }
    const chunks = chunkMarkdown(input.text);
    const vectors = await this.embedAll(chunks.map((c) => c.text));

    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const doc = await tx.kbDocument.create({
        data: {
          workspaceId: ctx.workspaceId,
          siteId: input.siteId,
          assetId: input.assetId ?? null,
          source: input.source,
          title: input.title,
          lang: input.lang ?? null,
          status: 'ready',
          chunkCount: chunks.length,
        },
      });
      for (let i = 0; i < chunks.length; i += 1) {
        await this.insertChunk(tx, ctx.workspaceId, doc.id, chunks[i], vectors[i]);
      }
      return doc;
    });
  }

  /**
   * 处理一个 canonical doc Asset。claim、失败回写和最终事务都匹配 attempt+token；
   * lease 过期接管后旧 worker 只能得到 superseded，不能 zombie write。
   */
  async processAsset(
    ctx: RequestContext,
    siteId: string,
    assetId: string,
    options: KbProcessOptions = {},
  ): Promise<KbProcessResult> {
    const asset = await this.claimAsset(ctx, siteId, assetId);
    if (!asset) return { assetId, outcome: 'not_due' };
    const fence = this.fenceOf(asset);
    try {
      let buffer: Buffer;
      try {
        options.heartbeat?.('storage');
        buffer = await this.storage.getBuffer(asset.objectKey, options.signal);
        options.signal?.throwIfAborted();
      } catch (err) {
        throw new KbIngestError(
          'KB_STORAGE_UNAVAILABLE',
          'retryable',
          'storage',
          errorMessage(err),
          err instanceof Error ? { cause: err } : undefined,
        );
      }
      const markdown = TEXT_MIMES.has(asset.mime)
        ? buffer.toString('utf8')
        : (await this.docling.convertToMarkdown(asset.filename, buffer, options.signal)).markdown;
      options.heartbeat?.('parsed');
      options.signal?.throwIfAborted();
      if (markdown.trim().length === 0) {
        throw new KbIngestError(
          'KB_DOCUMENT_INVALID',
          'terminal',
          'parse',
          'document produced no text',
        );
      }
      const chunks = chunkMarkdown(markdown);
      await this.renewFence(ctx, asset, fence);
      const vectors = await this.embedAll(chunks.map((c) => c.text), () =>
        this.renewFence(ctx, asset, fence),
        options.signal,
        options.heartbeat,
      );
      options.signal?.throwIfAborted();
      await this.persistAssetDocument(
        ctx,
        asset,
        fence,
        chunks,
        vectors,
        options.signal,
        options.heartbeat,
      );
      return { assetId, outcome: 'ready', attempt: fence.attempt };
    } catch (err) {
      const typed = asKbIngestError(err, 'persist');
      if (typed.disposition === 'superseded') {
        return {
          assetId,
          outcome: 'superseded',
          attempt: fence.attempt,
          errorCode: typed.code,
        };
      }
      const released = await this.releaseFailure(ctx, asset, fence, typed);
      if (!released) {
        return {
          assetId,
          outcome: 'superseded',
          attempt: fence.attempt,
          errorCode: 'KB_LEASE_SUPERSEDED',
        };
      }
      this.log.warn(
        `kb ingest ${typed.disposition} for asset ${asset.id} attempt ${fence.attempt}: ${typed.code}`,
      );
      return {
        assetId,
        outcome: typed.disposition === 'terminal' ? 'failed_terminal' : 'retry_scheduled',
        attempt: fence.attempt,
        errorCode: typed.code,
        retryAt: released.retryAt ?? undefined,
      };
    }
  }

  /** commit/refurbish 兼容入口：只列有界 due/过期 ID，再复用单素材 primitive。 */
  async processQueued(
    ctx: RequestContext,
    siteId: string,
    options: KbProcessOptions = {},
  ): Promise<{ processed: number; failed: number }> {
    const now = new Date();
    const due = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.asset.findMany({
        where: {
          siteId,
          kind: 'doc',
          contentHash: { not: null },
          deletedAt: null,
          OR: [
            {
              processingStatus: 'queued',
              OR: [{ retryAt: null }, { retryAt: { lte: now } }],
            },
            { processingStatus: 'processing', leaseUntil: { lte: now } },
          ],
        },
        orderBy: [
          { processingStatus: 'asc' },
          { leaseUntil: { sort: 'asc', nulls: 'last' } },
          { retryAt: { sort: 'asc', nulls: 'first' } },
          { createdAt: 'asc' },
          { id: 'asc' },
        ],
        take: KB_DUE_BATCH,
        select: { id: true },
      }),
    );
    let processed = 0;
    let failed = 0;
    for (const candidate of due) {
      options.heartbeat?.(`queued:${candidate.id}`);
      options.signal?.throwIfAborted();
      const result = await this.processAsset(ctx, siteId, candidate.id, options);
      if (result.outcome === 'ready') processed += 1;
      else if (result.outcome === 'retry_scheduled' || result.outcome === 'failed_terminal') {
        failed += 1;
      }
    }
    return { processed, failed };
  }

  /** 运维 redrive：只改持久真值；周期 sweep 或显式 processAsset 随后认领。 */
  async redriveAsset(
    ctx: RequestContext,
    siteId: string,
    assetId: string,
    opts: { includeTerminal?: boolean } = {},
  ): Promise<boolean> {
    const moved = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.asset.updateMany({
        where: {
          id: assetId,
          siteId,
          kind: 'doc',
          deletedAt: null,
          contentHash: { not: null },
          processingStatus: opts.includeTerminal
            ? { in: ['queued', 'failed_terminal'] }
            : 'queued',
        },
        data: {
          processingStatus: 'queued',
          retryAt: new Date(0),
          leaseToken: null,
          leaseUntil: null,
          processingErrorCode: null,
          error: null,
        },
      }),
    );
    return moved.count === 1;
  }

  async status(ctx: RequestContext, siteId: string): Promise<KbStatus> {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const site = await tx.site.findUnique({ where: { id: siteId }, select: { id: true } });
      if (!site) throw new NotFoundException('site not found');
      const docs = await tx.kbDocument.findMany({ where: { siteId } });
      const chunks = docs.reduce((sum, d) => sum + (d.chunkCount ?? 0), 0);
      // gaps 从最新 brand_profile 版本回填（M1-b；构建过一次才有，未构建=[]）
      const latest = await tx.brandProfile.findFirst({
        where: { siteId },
        orderBy: { version: 'desc' },
        select: { gaps: true },
      });
      const gaps = (latest?.gaps as KbStatus['gaps'] | null) ?? [];
      return { documents: docs.length, chunks, gaps };
    });
  }

  /**
   * brandProfile 的 KB digest 取材（M1-b）：按最新文档取前若干块拼正文。
   * 只取 ready 文档；截断策略在 agents/kb-digest.ts（本方法只管取数）。
   */
  async digestSources(
    ctx: RequestContext,
    siteId: string,
    opts: { maxDocs?: number; chunksPerDoc?: number } = {},
  ): Promise<{ source: string; title: string; text: string }[]> {
    const maxDocs = opts.maxDocs ?? 12;
    const chunksPerDoc = opts.chunksPerDoc ?? 4;
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const docs = await tx.kbDocument.findMany({
        where: { siteId, status: 'ready' },
        orderBy: { createdAt: 'desc' },
        take: maxDocs,
      });
      const out: { source: string; title: string; text: string }[] = [];
      for (const doc of docs) {
        const chunks = await tx.kbChunk.findMany({
          where: { documentId: doc.id },
          orderBy: { seq: 'asc' },
          take: chunksPerDoc,
          select: { text: true },
        });
        out.push({
          source: doc.source,
          title: doc.title,
          text: chunks.map((c) => c.text).join('\n'),
        });
      }
      return out;
    });
  }

  /** 语义检索（halfvec cosine，与 HNSW 索引同 cast，02 §12）。 */
  async search(ctx: RequestContext, siteId: string, query: string, k = 5): Promise<SearchHit[]> {
    const [vector] = await this.embeddings.embed([query]);
    const literal = toVectorLiteral(vector);
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const rows = await tx.$queryRaw<
        { document_id: string; seq: number; text: string; score: number }[]
      >`
        SELECT c.document_id, c.seq, c.text,
               1 - (c.embedding::halfvec(1024) <=> ${literal}::halfvec(1024)) AS score
        FROM kb_chunk c
        JOIN kb_document d ON d.id = c.document_id
        WHERE d.site_id = ${siteId}::uuid AND c.embedding IS NOT NULL
        ORDER BY c.embedding::halfvec(1024) <=> ${literal}::halfvec(1024)
        LIMIT ${k}
      `;
      return rows.map((r) => ({
        documentId: r.document_id,
        seq: r.seq,
        text: r.text,
        score: Number(r.score),
      }));
    });
  }

  private async embedAll(
    texts: string[],
    beforeBatch?: () => Promise<void>,
    signal?: AbortSignal,
    heartbeat?: (stage: string) => void,
  ): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      await beforeBatch?.();
      heartbeat?.(`embedding:${i / EMBED_BATCH}`);
      signal?.throwIfAborted();
      const batch = texts.slice(i, i + EMBED_BATCH);
      vectors.push(...(await this.embeddings.embed(batch, signal)));
    }
    return vectors;
  }

  private async insertChunk(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    documentId: string,
    chunk: Chunk,
    vector: number[],
  ): Promise<void> {
    const literal = toVectorLiteral(vector);
    await tx.$executeRaw`
      INSERT INTO kb_chunk (id, workspace_id, document_id, seq, text, meta, embed_model, embed_version, embedding)
      VALUES (${randomUUID()}::uuid, ${workspaceId}::uuid, ${documentId}::uuid, ${chunk.seq},
              ${chunk.text}, ${JSON.stringify(chunk.meta)}::jsonb,
              ${this.embeddings.model}, ${this.embeddings.version}, ${literal}::vector)
    `;
  }

  private async claimAsset(
    ctx: RequestContext,
    siteId: string,
    assetId: string,
  ): Promise<Asset | null> {
    const now = new Date();
    const token = randomUUID();
    const leaseUntil = new Date(now.getTime() + KB_LEASE_MS);
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const moved = await tx.asset.updateMany({
        where: {
          id: assetId,
          siteId,
          kind: 'doc',
          contentHash: { not: null },
          deletedAt: null,
          OR: [
            {
              processingStatus: 'queued',
              OR: [{ retryAt: null }, { retryAt: { lte: now } }],
            },
            { processingStatus: 'processing', leaseUntil: { lte: now } },
          ],
        },
        data: {
          processingStatus: 'processing',
          processingAttempt: { increment: 1 },
          leaseToken: token,
          leaseUntil,
          retryAt: null,
          processingErrorCode: null,
          error: null,
        },
      });
      if (moved.count !== 1) return null;
      return tx.asset.findUnique({ where: { id: assetId } });
    });
  }

  private async persistAssetDocument(
    ctx: RequestContext,
    asset: Asset,
    fence: KbFence,
    chunks: Chunk[],
    vectors: number[][],
    signal?: AbortSignal,
    heartbeat?: (stage: string) => void,
  ): Promise<void> {
    signal?.throwIfAborted();
    await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      // This fenced write takes the Asset row lock and extends the lease inside the same
      // transaction as document/chunk replacement. A takeover that already changed token
      // makes count=0 and the entire transaction aborts before any KB write survives.
      const held = await tx.asset.updateMany({
        where: {
          id: asset.id,
          processingStatus: 'processing',
          processingAttempt: fence.attempt,
          leaseToken: fence.token,
          deletedAt: null,
        },
        data: { leaseUntil: new Date(Date.now() + KB_LEASE_MS) },
      });
      if (held.count !== 1) throw this.superseded(asset.id);
      heartbeat?.('persist:document');
      signal?.throwIfAborted();

      const existing = await tx.kbDocument.findUnique({ where: { assetId: asset.id } });
      const doc = existing
        ? await tx.kbDocument.update({
            where: { id: existing.id },
            data: {
              source: 'upload',
              title: asset.filename,
              lang: null,
              status: 'ready',
              parsedMeta: Prisma.DbNull,
              chunkCount: chunks.length,
              error: null,
            },
          })
        : await tx.kbDocument.create({
            data: {
              workspaceId: ctx.workspaceId,
              siteId: asset.siteId,
              assetId: asset.id,
              source: 'upload',
              title: asset.filename,
              status: 'ready',
              chunkCount: chunks.length,
            },
          });
      if (existing) await tx.kbChunk.deleteMany({ where: { documentId: doc.id } });
      for (let i = 0; i < chunks.length; i += 1) {
        heartbeat?.(`persist:chunk:${i}`);
        signal?.throwIfAborted();
        await this.insertChunk(tx, ctx.workspaceId, doc.id, chunks[i], vectors[i]);
      }

      heartbeat?.('persist:ready');
      signal?.throwIfAborted();
      const ready = await tx.asset.updateMany({
        where: {
          id: asset.id,
          processingStatus: 'processing',
          processingAttempt: fence.attempt,
          leaseToken: fence.token,
          deletedAt: null,
        },
        data: {
          processingStatus: 'ready',
          leaseToken: null,
          leaseUntil: null,
          retryAt: null,
          processingErrorCode: null,
          error: null,
        },
      });
      if (ready.count !== 1) throw this.superseded(asset.id);
    });
  }

  private async renewFence(ctx: RequestContext, asset: Asset, fence: KbFence): Promise<void> {
    const moved = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.asset.updateMany({
        where: {
          id: asset.id,
          processingStatus: 'processing',
          processingAttempt: fence.attempt,
          leaseToken: fence.token,
          deletedAt: null,
        },
        data: { leaseUntil: new Date(Date.now() + KB_LEASE_MS) },
      }),
    );
    if (moved.count !== 1) throw this.superseded(asset.id);
  }

  private async releaseFailure(
    ctx: RequestContext,
    asset: Asset,
    fence: KbFence,
    err: KbIngestError,
  ): Promise<{ retryAt: Date | null } | null> {
    const retryAt =
      err.disposition === 'terminal'
        ? null
        : new Date(Date.now() + this.retryDelayMs(fence.attempt));
    const moved = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.asset.updateMany({
        where: {
          id: asset.id,
          processingStatus: 'processing',
          processingAttempt: fence.attempt,
          leaseToken: fence.token,
          deletedAt: null,
        },
        data: {
          processingStatus: err.disposition === 'terminal' ? 'failed_terminal' : 'queued',
          leaseToken: null,
          leaseUntil: null,
          retryAt,
          processingErrorCode: err.code,
          error: err.message.slice(0, 2000),
        },
      }),
    );
    return moved.count === 1 ? { retryAt } : null;
  }

  private fenceOf(asset: Asset): KbFence {
    if (!asset.leaseToken) throw this.superseded(asset.id);
    return { token: asset.leaseToken, attempt: asset.processingAttempt };
  }

  private superseded(assetId: string): KbIngestError {
    return new KbIngestError(
      'KB_LEASE_SUPERSEDED',
      'superseded',
      'persist',
      `KB lease superseded for asset ${assetId}`,
    );
  }

  private retryDelayMs(attempt: number): number {
    return Math.min(KB_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), KB_RETRY_MAX_MS);
  }
}

function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}
