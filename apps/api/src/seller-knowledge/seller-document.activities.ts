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
const HEARTBEAT_INTERVAL_MS = 5_000;

const TEXT_MIMES = new Set(['text/plain', 'text/markdown']);
const EXT_FOR_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/plain': 'txt',
  'text/markdown': 'md',
};

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
  filename?: string | null;
  object_key: string;
  mime: string;
  processing_attempt: number;
};

function backoffSeconds(attempt: number): number {
  return Math.min(60 * 2 ** Math.max(attempt - 1, 0), 3600);
}

function stripControlChars(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  return out;
}

/** 为 Docling 构造带合法扩展名的文件名，避免裸 UUID 导致格式识别失败。 */
export function resolveDoclingFilename(
  documentId: string,
  filename: string | null | undefined,
  mime: string,
): string {
  const ext = EXT_FOR_MIME[mime] ?? 'bin';
  const rawBase = filename?.trim().split(/[\\/]/).pop();
  const base = rawBase ? stripControlChars(rawBase).trim() : '';
  if (base && /\.[a-z0-9]{1,8}$/iu.test(base)) return base;
  if (base) return `${base}.${ext}`;
  return `${documentId}.${ext}`;
}

function isTerminalIngestError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { disposition?: unknown }).disposition === 'terminal'
  );
}

function currentActivityContext(): ActivityContext | undefined {
  try {
    return ActivityContext.current();
  } catch {
    // 直接调用（测试/运维脚本）没有 activity 上下文，忽略。
    return undefined;
  }
}

export function createSellerDocumentActivities(deps: SellerDocumentActivityDeps) {
  const log = new Logger('SellerDocumentActivities');

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
            "lease_token" = ${leaseToken},
            "lease_until" = now() + interval '10 minutes',
            "processing_error_code" = NULL,
            "updated_at" = now()
        WHERE "id" = ${input.documentId}::uuid
          AND "workspace_id" = ${input.workspaceId}::uuid
          AND "company_id" = ${input.companyId}::uuid
          AND "deleted_at" IS NULL
          AND (
            ("status" = 'queued' AND ("retry_at" IS NULL OR "retry_at" <= now()))
            OR ("status" = 'processing' AND ("lease_until" IS NULL OR "lease_until" <= now()))
          )
        RETURNING "filename", "object_key", "mime", "processing_attempt"
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

  async function fail(
    input: SellerDocumentIngestInput,
    leaseToken: string,
    attempt: number,
    code: string,
    options: { terminal?: boolean; immediateRetry?: boolean } = {},
  ): Promise<'queued' | 'failed_terminal'> {
    const terminal = options.terminal === true || attempt >= MAX_INGEST_ATTEMPTS;
    const nextStatus = terminal ? 'failed_terminal' : 'queued';
    const retryAt = terminal
      ? null
      : options.immediateRetry
        ? new Date()
        : new Date(Date.now() + backoffSeconds(attempt) * 1000);
    await deps.prisma.withWorkspace(input.workspaceId, async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "seller_document"
        SET "status" = ${nextStatus},
            "processing_error_code" = ${code},
            "processing_stage" = NULL,
            "lease_token" = NULL,
            "lease_until" = NULL,
            "retry_at" = ${retryAt},
            "updated_at" = now()
        WHERE "id" = ${input.documentId}::uuid
          AND "workspace_id" = ${input.workspaceId}::uuid
          AND "lease_token" = ${leaseToken}
          AND "status" = 'processing'
      `);
    });
    return nextStatus;
  }

  async function parseDocument(
    documentId: string,
    row: ClaimedRow,
    content: Buffer,
    signal?: AbortSignal,
  ): Promise<{ ok: true; markdown: string } | { ok: false; code: string; terminal: boolean }> {
    if (TEXT_MIMES.has(row.mime)) {
      return { ok: true, markdown: content.toString('utf8') };
    }
    try {
      const filename = resolveDoclingFilename(documentId, row.filename, row.mime);
      const converted = await deps.docling.convertToMarkdown(filename, content, signal);
      return { ok: true, markdown: converted.markdown };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (isTerminalIngestError(error)) {
        return { ok: false, code: 'DOCUMENT_INVALID', terminal: true };
      }
      return { ok: false, code: 'DOCUMENT_PARSE_UNAVAILABLE', terminal: false };
    }
  }

  async function embedChunks(
    chunks: ReturnType<typeof chunkMarkdown>,
    onBatch: (stage: string) => void,
    signal?: AbortSignal,
  ): Promise<{ ok: true; vectors: number[][] } | { ok: false; code: string; terminal: boolean }> {
    const vectors: number[][] = [];
    for (let index = 0; index < chunks.length; index += EMBED_BATCH) {
      signal?.throwIfAborted();
      onBatch(`embed:${index / EMBED_BATCH}`);
      const batch = chunks.slice(index, index + EMBED_BATCH);
      try {
        const embedded = await deps.embeddings.embed(
          batch.map((chunk) => chunk.text),
          signal,
        );
        if (embedded.length !== batch.length) {
          throw new Error('embedding batch length mismatch');
        }
        vectors.push(...embedded);
      } catch (error) {
        if (signal?.aborted) throw error;
        if (isTerminalIngestError(error)) {
          return { ok: false, code: 'DOCUMENT_EMBEDDING_CONFIGURATION_INVALID', terminal: true };
        }
        return { ok: false, code: 'DOCUMENT_EMBEDDING_UNAVAILABLE', terminal: false };
      }
    }
    return { ok: true, vectors };
  }

  return {
    /** 单文档解析：一条工作流只处理一份资料（fenced lease 防重复写；5s 心跳 + 取消透传）。 */
    async processSellerDocument(
      input: SellerDocumentIngestInput,
    ): Promise<{ documentId: string; outcome: 'ready' | 'queued' | 'failed_terminal' | 'not_due' | 'gone' }> {
      const activity = currentActivityContext();
      const signal = activity?.cancellationSignal;
      let stage = 'claim';
      const pulse = (nextStage: string) => {
        stage = nextStage;
        activity?.heartbeat({ documentId: input.documentId, stage });
      };
      pulse('claim');
      const heartbeatTimer = activity
        ? setInterval(() => activity.heartbeat({ documentId: input.documentId, stage }), HEARTBEAT_INTERVAL_MS)
        : undefined;
      heartbeatTimer?.unref();

      let leaseToken: string | undefined;
      let attempt = 0;
      try {
        const claimed = await claim(input);
        if ('outcome' in claimed) {
          return { documentId: input.documentId, outcome: claimed.outcome };
        }
        const row = claimed.claim;
        leaseToken = claimed.leaseToken;
        attempt = row.processing_attempt;

        pulse('download');
        signal?.throwIfAborted();
        let content: Buffer;
        try {
          content = await deps.storage.getBufferBounded(row.object_key, MAX_DOCUMENT_BYTES);
        } catch {
          const outcome = await fail(input, leaseToken, attempt, 'DOCUMENT_DOWNLOAD_UNAVAILABLE');
          return { documentId: input.documentId, outcome };
        }

        pulse('parse');
        signal?.throwIfAborted();
        const parsed = await parseDocument(input.documentId, row, content, signal);
        if (!parsed.ok) {
          const outcome = await fail(input, leaseToken, attempt, parsed.code, {
            terminal: parsed.terminal,
          });
          return { documentId: input.documentId, outcome };
        }
        if (!parsed.markdown.trim()) {
          const outcome = await fail(input, leaseToken, attempt, 'DOCUMENT_NO_CONTENT', {
            terminal: true,
          });
          return { documentId: input.documentId, outcome };
        }

        pulse('chunk');
        const chunks = chunkMarkdown(parsed.markdown).slice(0, MAX_CHUNKS);
        if (chunks.length === 0) {
          const outcome = await fail(input, leaseToken, attempt, 'DOCUMENT_NO_CONTENT', {
            terminal: true,
          });
          return { documentId: input.documentId, outcome };
        }

        pulse('embed');
        const embedded = await embedChunks(chunks, pulse, signal);
        if (!embedded.ok) {
          const outcome = await fail(input, leaseToken, attempt, embedded.code, {
            terminal: embedded.terminal,
          });
          return { documentId: input.documentId, outcome };
        }

        pulse('persist');
        signal?.throwIfAborted();
        // 新 chunks/metadata 发布、parseRevision 递增与 ready 同一事务：旧引用在提交前不可见，
        // 提交后即指向新修订；租约丢失时不覆盖新持有者的真值。
        const published = await deps.prisma.withWorkspace(input.workspaceId, async (tx) => {
          const rows = await tx.$queryRaw<Array<{ parse_revision: number }>>(Prisma.sql`
            UPDATE "seller_document"
            SET "status" = 'ready',
                "chunk_count" = ${chunks.length},
                "parsed_meta" = jsonb_build_object('chunks', ${chunks.length}::int),
                "parse_revision" = COALESCE("parse_revision", 0) + 1,
                "processing_stage" = NULL,
                "processing_error_code" = NULL,
                "lease_token" = NULL,
                "lease_until" = NULL,
                "retry_at" = NULL,
                "updated_at" = now()
            WHERE "id" = ${input.documentId}::uuid
              AND "workspace_id" = ${input.workspaceId}::uuid
              AND "lease_token" = ${leaseToken}
              AND "status" = 'processing'
            RETURNING "parse_revision"
          `);
          if (rows.length !== 1) return null;
          await tx.sellerDocumentChunk.deleteMany({ where: { documentId: input.documentId } });
          for (const [index, chunk] of chunks.entries()) {
            const vector = `[${embedded.vectors[index].join(',')}]`;
            await tx.$executeRaw(Prisma.sql`
              INSERT INTO "seller_document_chunk"
                ("id", "workspace_id", "document_id", "seq", "text", "meta", "embed_model", "embed_version", "embedding")
              VALUES
                (${randomUUID()}::uuid, ${input.workspaceId}::uuid, ${input.documentId}::uuid,
                 ${chunk.seq}, ${chunk.text}, ${JSON.stringify(chunk.meta)}::jsonb,
                 ${deps.embeddings.model}, ${deps.embeddings.version}, ${vector}::vector)
            `);
          }
          return rows[0].parse_revision;
        });
        if (published === null) {
          log.warn(`seller document finalize lost lease (${input.documentId})`);
          return { documentId: input.documentId, outcome: 'not_due' };
        }
        return { documentId: input.documentId, outcome: 'ready' };
      } catch (error) {
        // 取消或未预期错误：释放租约回 queued（取消时立即可重试），让 Temporal 按 retry policy 重试。
        if (leaseToken) {
          await fail(input, leaseToken, attempt, signal?.aborted ? 'DOCUMENT_INGEST_CANCELLED' : 'DOCUMENT_INGEST_FAILED', {
            immediateRetry: signal?.aborted === true,
          }).catch(() => undefined);
        }
        throw error;
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
      }
    },
  };
}
