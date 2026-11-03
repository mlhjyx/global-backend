import { Context as ActivityContext } from '@temporalio/activity';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service';
import { chunkMarkdown } from '../site-builder/chunker';
import type { DoclingClient } from '../site-builder/docling.client';
import type { EmbeddingsClient } from '../site-builder/embeddings.client';
import type { SellerDocumentsStorage } from './seller-documents.storage';

/**
 * 卖家资料解析（模块 02 · Phase 2b）：租约认领 → 下载 → Docling/文本直读 →
 * 结构感知分块 → BGE-M3 批量嵌入 → 事务写 chunk 并置 ready。
 * 真值在 seller_document 状态机；Temporal 只负责 activity 级重试与心跳。
 * 失败按 attempt 指数退避（60s→1h，最多 8 次）回 queued，超过即 failed_terminal。
 */
const MAX_INGEST_ATTEMPTS = 8;
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024 + 1024 * 1024;
const MAX_CHUNKS = 512;
const EMBED_BATCH = 32;
const LEASE_MINUTES = 10;

const TEXT_MIMES = new Set(['text/plain', 'text/markdown']);

export interface SellerDocumentIngestInput {
  workspaceId: string;
  companyId: string;
  documentId: string;
}

export interface SellerDocumentActivityDeps {
  prisma: PrismaService;
  storage: SellerDocumentsStorage;
  docling: DoclingClient;
  embeddings: EmbeddingsClient;
}

type ClaimedRow = {
  object_key: string;
  mime: string;
  processing_attempt: number;
};

function backoffSeconds(attempt: number): number {
  return Math.min(60 * 2 ** Math.max(attempt - 1, 0), 3600);
}

export function createSellerDocumentActivities(deps: SellerDocumentActivityDeps) {
  const log = new Logger('SellerDocumentActivities');

  function heartbeat(stage: string, documentId: string) {
    try {
      ActivityContext.current().heartbeat({ documentId, stage });
    } catch {
      // 直接调用（测试/运维脚本）没有 activity 上下文，忽略。
    }
  }

  async function claim(
    input: SellerDocumentIngestInput,
  ): Promise<{ claim: ClaimedRow; leaseToken: string } | { outcome: 'not_due' | 'gone' }> {
    const leaseToken = randomUUID();
    return deps.prisma.withWorkspace(input.workspaceId, async (tx) => {
      const rows = await tx.$queryRaw<ClaimedRow[]>(Prisma.sql`
        UPDATE "seller_document"
        SET "status" = 'processing',
            "processing_stage" = 'download',
            "processing_attempt" = "processing_attempt" + 1,
            "lease_token" = ${leaseToken}::uuid,
            "lease_until" = now() + interval '${Prisma.raw(String(LEASE_MINUTES))} minutes',
            "processing_error_code" = NULL,
            "updated_at" = now()
        WHERE "id" = ${input.documentId}::uuid
          AND "workspace_id" = ${input.workspaceId}::uuid
          AND "company_id" = ${input.companyId}::uuid
          AND "deleted_at" IS NULL
          AND "status" = 'queued'
          AND ("retry_at" IS NULL OR "retry_at" <= now())
        RETURNING "object_key", "mime", "processing_attempt"
      `);
      if (rows.length > 0) return { claim: rows[0], leaseToken };
      const current = await tx.sellerDocument.findFirst({
        where: { id: input.documentId },
        select: { status: true, deletedAt: true },
      });
      if (!current || current.deletedAt) return { outcome: 'gone' as const };
      return { outcome: 'not_due' as const };
    });
  }

  async function finalize(
    input: SellerDocumentIngestInput,
    leaseToken: string,
    chunkCount: number,
  ): Promise<boolean> {
    return deps.prisma.withWorkspace(input.workspaceId, async (tx) => {
      const updated = await tx.$executeRaw(Prisma.sql`
        UPDATE "seller_document"
        SET "status" = 'ready',
            "chunk_count" = ${chunkCount},
            "parsed_meta" = jsonb_build_object('chunks', ${chunkCount}::int),
            "processing_stage" = NULL,
            "processing_error_code" = NULL,
            "lease_token" = NULL,
            "lease_until" = NULL,
            "retry_at" = NULL,
            "updated_at" = now()
        WHERE "id" = ${input.documentId}::uuid
          AND "workspace_id" = ${input.workspaceId}::uuid
          AND "lease_token" = ${leaseToken}::uuid
          AND "status" = 'processing'
      `);
      return updated === 1;
    });
  }

  async function fail(
    input: SellerDocumentIngestInput,
    leaseToken: string,
    attempt: number,
    code: string,
  ): Promise<'queued' | 'failed_terminal'> {
    const terminal = attempt >= MAX_INGEST_ATTEMPTS;
    const nextStatus = terminal ? 'failed_terminal' : 'queued';
    await deps.prisma.withWorkspace(input.workspaceId, async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "seller_document"
        SET "status" = ${nextStatus},
            "processing_error_code" = ${code},
            "processing_stage" = NULL,
            "lease_token" = NULL,
            "lease_until" = NULL,
            "retry_at" = ${
              terminal
                ? null
                : new Date(Date.now() + backoffSeconds(attempt) * 1000)
            },
            "updated_at" = now()
        WHERE "id" = ${input.documentId}::uuid
          AND "workspace_id" = ${input.workspaceId}::uuid
          AND "lease_token" = ${leaseToken}::uuid
          AND "status" = 'processing'
      `);
    });
    return nextStatus;
  }

  return {
    /** 单文档解析：一条工作流只处理一份资料（fenced lease 防重复写）。 */
    async processSellerDocument(
      input: SellerDocumentIngestInput,
    ): Promise<{ documentId: string; outcome: 'ready' | 'queued' | 'failed_terminal' | 'not_due' | 'gone' }> {
      heartbeat('claim', input.documentId);
      const claimed = await claim(input);
      if ('outcome' in claimed) {
        return { documentId: input.documentId, outcome: claimed.outcome };
      }
      const { claim: row, leaseToken } = claimed;
      const attempt = row.processing_attempt;

      try {
        heartbeat('download', input.documentId);
        let content: Buffer;
        try {
          content = await deps.storage.getBufferBounded(row.object_key, MAX_DOCUMENT_BYTES);
        } catch {
          const outcome = await fail(input, leaseToken, attempt, 'DOCUMENT_DOWNLOAD_UNAVAILABLE');
          return { documentId: input.documentId, outcome };
        }

        heartbeat('parse', input.documentId);
        let markdown: string;
        if (TEXT_MIMES.has(row.mime)) {
          markdown = content.toString('utf8');
        } else {
          try {
            markdown = (await deps.docling.convertToMarkdown(input.documentId, content)).markdown;
          } catch {
            const outcome = await fail(input, leaseToken, attempt, 'DOCUMENT_PARSE_UNAVAILABLE');
            return { documentId: input.documentId, outcome };
          }
        }
        if (!markdown.trim()) {
          const outcome = await fail(input, leaseToken, attempt, 'DOCUMENT_NO_CONTENT');
          return { documentId: input.documentId, outcome };
        }

        heartbeat('chunk', input.documentId);
        const chunks = chunkMarkdown(markdown).slice(0, MAX_CHUNKS);
        if (chunks.length === 0) {
          const outcome = await fail(input, leaseToken, attempt, 'DOCUMENT_NO_CONTENT');
          return { documentId: input.documentId, outcome };
        }

        heartbeat('embed', input.documentId);
        const vectors: number[][] = [];
        for (let index = 0; index < chunks.length; index += EMBED_BATCH) {
          const batch = chunks.slice(index, index + EMBED_BATCH);
          try {
            const embedded = await deps.embeddings.embed(batch.map((chunk) => chunk.text));
            if (embedded.length !== batch.length) {
              throw new Error('embedding batch length mismatch');
            }
            vectors.push(...embedded);
          } catch {
            const outcome = await fail(input, leaseToken, attempt, 'DOCUMENT_EMBEDDING_UNAVAILABLE');
            return { documentId: input.documentId, outcome };
          }
        }

        heartbeat('persist', input.documentId);
        const persisted = await deps.prisma.withWorkspace(input.workspaceId, async (tx) => {
          // 幂等重放：清掉该文档的旧分块（同一次 lease 内重试才会到这里）。
          await tx.sellerDocumentChunk.deleteMany({ where: { documentId: input.documentId } });
          for (const [index, chunk] of chunks.entries()) {
            const vector = `[${vectors[index].join(',')}]`;
            await tx.$executeRaw(Prisma.sql`
              INSERT INTO "seller_document_chunk"
                ("id", "workspace_id", "document_id", "seq", "text", "meta", "embed_model", "embed_version", "embedding")
              VALUES
                (${randomUUID()}::uuid, ${input.workspaceId}::uuid, ${input.documentId}::uuid,
                 ${chunk.seq}, ${chunk.text}, ${JSON.stringify(chunk.meta)}::jsonb,
                 ${deps.embeddings.model}, ${deps.embeddings.version}, ${vector}::vector)
            `);
          }
          return true;
        });
        if (!persisted) {
          return { documentId: input.documentId, outcome: 'queued' };
        }

        const finalized = await finalize(input, leaseToken, chunks.length);
        if (!finalized) {
          // 租约已被回收（过期/被新 attempt 接管）：不覆盖新持有者的真值。
          log.warn(`seller document finalize lost lease (${input.documentId})`);
          return { documentId: input.documentId, outcome: 'not_due' };
        }
        return { documentId: input.documentId, outcome: 'ready' };
      } catch (error) {
        // 未预期错误：释放租约回 queued 后退避，让 Temporal 按 retry policy 重试。
        await fail(input, leaseToken, attempt, 'DOCUMENT_INGEST_FAILED').catch(() => undefined);
        throw error;
      }
    },
  };
}
