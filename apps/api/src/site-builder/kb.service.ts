import { Injectable, Logger } from '@nestjs/common';
import { KbDocument, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext } from '../auth/request-context';
import { Chunk, chunkMarkdown } from './chunker';
import { DoclingClient } from './docling.client';
import { EmbeddingsClient } from './embeddings.client';
import { StorageService } from './storage.service';

const EMBED_BATCH = 32;

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
  gaps: { field: string; hintKey: string }[];
}

export interface SearchHit {
  documentId: string;
  seq: number;
  text: string;
  score: number;
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

  /** commit 后排队的 doc 素材 → 解析入库；单个失败不阻断其余（fail-safe）。 */
  async processQueued(
    ctx: RequestContext,
    siteId: string,
  ): Promise<{ processed: number; failed: number }> {
    const queued = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.asset.findMany({ where: { siteId, processingStatus: 'queued' } }),
    );
    let processed = 0;
    let failed = 0;
    for (const asset of queued) {
      // CAS 认领（Codex P2）：commit 触发的 kbIngestWorkflow 与 refurbish P1 可能并发扫同站——
      // queued→processing 原子翻转，翻不动=已被别处认领，跳过（防重复解析/重复入库）。
      const claimed = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
        tx.asset.updateMany({
          where: { id: asset.id, processingStatus: 'queued' },
          data: { processingStatus: 'processing' },
        }),
      );
      if (claimed.count === 0) continue;
      try {
        const buffer = await this.storage.getBuffer(asset.objectKey);
        const markdown = TEXT_MIMES.has(asset.mime)
          ? buffer.toString('utf8')
          : (await this.docling.convertToMarkdown(asset.filename, buffer)).markdown;
        await this.ingestText(ctx, {
          siteId,
          source: 'upload',
          title: asset.filename,
          text: markdown,
          assetId: asset.id,
        });
        await this.updateAssetStatus(ctx, asset.id, 'ready', null);
        processed += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn(`kb ingest failed for asset ${asset.id}: ${message}`);
        await this.updateAssetStatus(ctx, asset.id, 'failed', message);
        failed += 1;
      }
    }
    return { processed, failed };
  }

  async status(ctx: RequestContext, siteId: string): Promise<KbStatus> {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const docs = await tx.kbDocument.findMany({ where: { siteId } });
      const chunks = docs.reduce((sum, d) => sum + (d.chunkCount ?? 0), 0);
      // gaps 由 M1 brandProfile 产出「待补资料」清单；M0 恒空
      return { documents: docs.length, chunks, gaps: [] };
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

  private async embedAll(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH);
      vectors.push(...(await this.embeddings.embed(batch)));
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

  private async updateAssetStatus(
    ctx: RequestContext,
    assetId: string,
    status: string,
    error: string | null,
  ): Promise<void> {
    await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.asset.update({ where: { id: assetId }, data: { processingStatus: status, error } }),
    );
  }
}

function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}
