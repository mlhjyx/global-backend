import { Context as ActivityContext } from '@temporalio/activity';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service';
import type { ModelGateway } from '../model-gateway/model-gateway';
import type { RuntimeTelemetry } from '../model-runtime/types';
import { chunkMarkdown } from '../site-builder/chunker';
import type { DoclingClient, DoclingPageImage } from '../site-builder/docling.client';
import type { EmbeddingsClient } from '../site-builder/embeddings.client';
import type { SellerDocumentsStorage } from './seller-documents.storage';
import { createSellerDocumentPendingCleanupActivities } from './seller-document-pending-cleanup.activities';
import type { SellerDocumentClaimsService } from './seller-document-claims.service';
import { computePdfPageBatches, countPdfPages } from './pdf-page-utils';
import {
  analyzeSellerDocumentTextChunks,
  analyzeSellerDocumentVisionPages,
  persistSellerDocumentAiFindings,
  type SellerDocumentAiProduct,
} from './seller-document-ai-analyzer';

/**
 * 卖家资料解析（模块 02 · Phase 2b + Track 1/3）：
 * 租约认领 → 下载 → PDF 页数探测（大文件/大页数优先解析前 15 页防 Docling OOM）→
 * 稀疏扫描件按需走 OCR + L3 多模态视觉兜底 → 结构感知分块 → BGE-M3 批量嵌入 →
 * 事务写 chunk 并置 ready → L2 轻量 AI 抽取产品/要点 + S2 确定性原句字节核验落 NEEDS_REVIEW →
 * 若存在尾页则由工作流自动后台分批补全。
 */
const MAX_INGEST_ATTEMPTS = 8;
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024 + 1024 * 1024;
const MAX_CHUNKS = 512;
const DEFAULT_EMBED_BATCH = 8;
const MAX_EMBED_BATCH = 32;
const HEARTBEAT_INTERVAL_MS = 5_000;
const AUTO_ASSISTED_MAX_CHUNKS = 25;
const AUTO_ASSISTED_MAX_CANDIDATES = 20;

export const PRIORITY_PDF_PAGES = 15;
export const TAIL_PDF_PAGE_BATCH = 15;
export const MAX_PDF_PAGES = 120;
const LARGE_UNKNOWN_PDF_BYTES = 10 * 1024 * 1024;
const SPARSE_PDF_MIN_TOTAL_CHARS = 300;
const SPARSE_PDF_MIN_CHARS_PER_PAGE = 150;
const VISION_FALLBACK_MAX_PAGES = 6;

function resolveEmbedBatchSize(): number {
  const raw = process.env.SELLER_DOCUMENTS_EMBED_BATCH;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_EMBED_BATCH) {
    return parsed;
  }
  return DEFAULT_EMBED_BATCH;
}

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

export interface SellerDocumentTailPagesInput extends SellerDocumentIngestInput {
  startPage: number;
  totalPages?: number;
}

export interface SellerDocumentActivityDeps {
  prisma: PrismaService;
  storage: SellerDocumentsStorage;
  docling: DoclingClient;
  embeddings: EmbeddingsClient;
  /** 可选 S2 自动要点草稿抽取器：文档置 ready 后尽力生成带字节原句证据的 NEEDS_REVIEW 草稿。 */
  claims?: Pick<SellerDocumentClaimsService, 'createAssistedDrafts'>;
  /** 可选模型网关：用于 L2 轻量产品/要点结构化提取与 L3 扫描件多模态视觉兜底。 */
  gateway?: ModelGateway;
  runtimeTelemetry?: RuntimeTelemetry;
  /** 测试可注入的 PNG 压缩函数（生产默认使用 sharp）。 */
  resizeVisionPng?: (pngBytes: Buffer) => Promise<Buffer>;
}

type ClaimedRow = {
  filename?: string | null;
  object_key: string;
  mime: string;
  processing_attempt: number;
  uploaded_by?: string | null;
};

type ParsedMetaState = {
  chunks: number;
  mode: 'priority_pages' | 'full';
  parsedPages?: number;
  totalPages?: number;
  fullParsePending: boolean;
  tailParsePartial?: boolean;
  aiProductsCount?: number;
  aiClaimsCount?: number;
  visionUsed?: boolean;
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

function isSparsePdfText(markdown: string, pageCount: number): boolean {
  const compactLen = markdown.replace(/\s+/g, '').length;
  const pages = Math.max(1, pageCount);
  return compactLen < SPARSE_PDF_MIN_TOTAL_CHARS || compactLen / pages < SPARSE_PDF_MIN_CHARS_PER_PAGE;
}

function buildSyntheticMarkdownFromProducts(products: readonly SellerDocumentAiProduct[]): string {
  if (products.length === 0) return '';
  return products
    .map((p) => {
      const lines = [`### ${p.name}`];
      if (p.description) lines.push(p.description);
      if (p.evidence) lines.push(`> ${p.evidence}`);
      return lines.join('\n');
    })
    .join('\n\n');
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
        RETURNING "filename", "object_key", "mime", "processing_attempt", "uploaded_by"
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
  ): Promise<{ outcome: 'queued' | 'failed_terminal'; retryAfterSeconds?: number }> {
    const terminal = options.terminal === true || attempt >= MAX_INGEST_ATTEMPTS;
    const nextStatus = terminal ? 'failed_terminal' : 'queued';
    const retryAfterSeconds = terminal
      ? undefined
      : options.immediateRetry
        ? 5
        : backoffSeconds(attempt);
    const retryAt = terminal
      ? null
      : options.immediateRetry
        ? new Date()
        : new Date(Date.now() + (retryAfterSeconds ?? 60) * 1000);
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
    return retryAfterSeconds === undefined
      ? { outcome: nextStatus }
      : { outcome: nextStatus, retryAfterSeconds };
  }

  async function recordStage(
    input: SellerDocumentIngestInput,
    leaseToken: string,
    nextStage: string,
  ): Promise<void> {
    await deps.prisma
      .withWorkspace(input.workspaceId, async (tx) => {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "seller_document"
          SET "processing_stage" = ${nextStage},
              "lease_until" = now() + interval '10 minutes',
              "updated_at" = now()
          WHERE "id" = ${input.documentId}::uuid
            AND "workspace_id" = ${input.workspaceId}::uuid
            AND "lease_token" = ${leaseToken}
            AND "status" = 'processing'
        `);
      })
      .catch(() => undefined);
  }

  async function updateParsedMeta(
    input: SellerDocumentIngestInput,
    patch: Record<string, unknown>,
  ): Promise<void> {
    await deps.prisma
      .withWorkspace(input.workspaceId, async (tx) => {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "seller_document"
          SET "parsed_meta" = COALESCE("parsed_meta", '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb,
              "updated_at" = now()
          WHERE "id" = ${input.documentId}::uuid
            AND "workspace_id" = ${input.workspaceId}::uuid
            AND "status" = 'ready'
        `);
      })
      .catch(() => undefined);
  }

  async function parsePrimaryDocument(
    input: SellerDocumentIngestInput,
    row: ClaimedRow,
    content: Buffer,
    pulse: (stage: string) => void,
    signal?: AbortSignal,
  ): Promise<
    | {
        ok: true;
        markdown: string;
        parsedPages?: number;
        totalPages?: number;
        tailPagesPending: boolean;
        visionUsed: boolean;
        visionProducts: SellerDocumentAiProduct[];
        visionIndustry?: string;
        visionSummary?: string;
      }
    | { ok: false; code: string; terminal: boolean }
  > {
    if (TEXT_MIMES.has(row.mime)) {
      return {
        ok: true,
        markdown: content.toString('utf8'),
        tailPagesPending: false,
        visionUsed: false,
        visionProducts: [],
      };
    }

    const filename = resolveDoclingFilename(input.documentId, row.filename, row.mime);
    const isPdf = row.mime === 'application/pdf';
    const detectedPages = isPdf ? countPdfPages(content) : null;
    const usePriorityWindow =
      isPdf &&
      ((detectedPages !== null && detectedPages > PRIORITY_PDF_PAGES) ||
        (detectedPages === null && content.byteLength > LARGE_UNKNOWN_PDF_BYTES));

    let markdown: string;
    let doclingPageCount: number | undefined;
    try {
      const converted = await deps.docling.convertToMarkdown(
        filename,
        content,
        signal,
        input.workspaceId,
        usePriorityWindow
          ? {
              pageRange: [1, PRIORITY_PDF_PAGES],
              returnPageCount: true,
              allowEmptyMarkdown: isPdf,
            }
          : isPdf
            ? { allowEmptyMarkdown: true }
            : undefined,
      );
      markdown = converted.markdown;
      doclingPageCount = converted.pageCount;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (isTerminalIngestError(error)) {
        return { ok: false, code: 'DOCUMENT_INVALID', terminal: true };
      }
      return { ok: false, code: 'DOCUMENT_PARSE_UNAVAILABLE', terminal: false };
    }

    const totalPages = detectedPages ?? (usePriorityWindow ? undefined : doclingPageCount);
    const parsedPages = usePriorityWindow
      ? Math.min(PRIORITY_PDF_PAGES, totalPages ?? PRIORITY_PDF_PAGES)
      : totalPages;
    const tailPagesPending =
      usePriorityWindow &&
      (totalPages === undefined
        ? (doclingPageCount ?? PRIORITY_PDF_PAGES) >= PRIORITY_PDF_PAGES
        : totalPages > PRIORITY_PDF_PAGES);

    let visionUsed = false;
    let visionProducts: SellerDocumentAiProduct[] = [];
    let visionIndustry: string | undefined;
    let visionSummary: string | undefined;

    // L3 按需兜底：仅当 PDF 文本密度极稀疏（典型为转曲印刷画册/扫描件）时触发 force_ocr + 视觉模型
    if (isPdf && isSparsePdfText(markdown, parsedPages ?? 1)) {
      pulse('parse_ocr_vision');
      const fallbackEndPage = Math.min(parsedPages ?? VISION_FALLBACK_MAX_PAGES, VISION_FALLBACK_MAX_PAGES);
      let pageImages: readonly DoclingPageImage[] = [];
      try {
        const ocrResult = await deps.docling.convertToMarkdown(
          filename,
          content,
          signal,
          input.workspaceId,
          {
            pageRange: [1, fallbackEndPage],
            forceOcr: true,
            includePageImages: Boolean(deps.gateway),
            imagesScale: 1.0,
            allowEmptyMarkdown: true,
          },
        );
        if (ocrResult.markdown.replace(/\s+/g, '').length > markdown.replace(/\s+/g, '').length) {
          markdown = ocrResult.markdown;
        }
        pageImages = ocrResult.pageImages ?? [];
      } catch (ocrError) {
        if (signal?.aborted) throw ocrError;
        log.warn(
          `seller document force_ocr fallback skipped (${input.documentId}): ${
            ocrError instanceof Error ? ocrError.message : String(ocrError)
          }`,
        );
      }

      if (deps.gateway && pageImages.length > 0 && isSparsePdfText(markdown, fallbackEndPage)) {
        const vision = await analyzeSellerDocumentVisionPages({
          gateway: deps.gateway,
          workspaceId: input.workspaceId,
          documentId: input.documentId,
          filename,
          pageImages,
          resizePng: deps.resizeVisionPng,
          signal,
        });
        if (vision.visionUsed) {
          visionUsed = true;
          visionProducts = vision.products;
          visionIndustry = vision.industry;
          visionSummary = vision.summary;
          const extraMd =
            vision.transcribedMarkdown?.trim() || buildSyntheticMarkdownFromProducts(vision.products);
          if (extraMd) {
            markdown = markdown.trim() ? `${markdown.trim()}\n\n${extraMd}` : extraMd;
          }
        }
      }
    }

    return {
      ok: true,
      markdown,
      ...(parsedPages !== undefined ? { parsedPages } : {}),
      ...(totalPages !== undefined ? { totalPages } : {}),
      tailPagesPending,
      visionUsed,
      visionProducts,
      ...(visionIndustry ? { visionIndustry } : {}),
      ...(visionSummary ? { visionSummary } : {}),
    };
  }

  async function embedChunks(
    chunks: ReturnType<typeof chunkMarkdown>,
    workspaceId: string,
    onBatch: (stage: string) => void,
    signal?: AbortSignal,
  ): Promise<{ ok: true; vectors: number[][] } | { ok: false; code: string; terminal: boolean }> {
    const batchSize = resolveEmbedBatchSize();
    const vectors: number[][] = [];
    for (let index = 0; index < chunks.length; index += batchSize) {
      signal?.throwIfAborted();
      onBatch(`embed:${index / batchSize}`);
      const batch = chunks.slice(index, index + batchSize);
      try {
        const embedded = await deps.embeddings.embed(
          batch.map((chunk) => chunk.text),
          signal,
          workspaceId,
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

  async function runPostPublishEnrichment(args: {
    input: SellerDocumentIngestInput;
    uploadedBy?: string | null;
    filename: string;
    chunks: ReadonlyArray<{ seq: number; text: string; meta?: unknown }>;
    chunkSeqs?: readonly number[];
    visionProducts?: readonly SellerDocumentAiProduct[];
    visionIndustry?: string;
    visionSummary?: string;
    visionUsed: boolean;
    correlationSuffix?: string;
    pulse: (stage: string) => void;
    signal?: AbortSignal;
  }): Promise<{ aiProductsCount: number; aiClaimsCount: number }> {
    let aiProductsCount = 0;
    let aiClaimsCount = 0;
    const allProducts: SellerDocumentAiProduct[] = [...(args.visionProducts ?? [])];
    let industry = args.visionIndustry;
    let summary = args.visionSummary;
    let modelSuggestionsByChunk = new Map<number, Array<{ type: string; statement: string; quote: string; confidence?: number }>>();

    // L2 轻量文本 AI 抽取：在有网关时运行，缺失账户或瞬态失败优雅降级，绝不影响文档 ready 状态
    if (deps.gateway && args.chunks.length > 0) {
      args.pulse('ai_analyze');
      const analyzed = await analyzeSellerDocumentTextChunks({
        gateway: deps.gateway,
        runtimeTelemetry: deps.runtimeTelemetry,
        workspaceId: args.input.workspaceId,
        documentId: args.input.documentId,
        filename: args.filename,
        chunks: args.chunks,
        correlationSuffix: args.correlationSuffix,
        signal: args.signal,
      });
      if (!analyzed.skipped) {
        allProducts.push(...analyzed.products);
        if (!industry && analyzed.industry) industry = analyzed.industry;
        if (!summary && analyzed.summary) summary = analyzed.summary;
        modelSuggestionsByChunk = analyzed.modelSuggestionsByChunk;
      }
    }

    if (allProducts.length > 0 || industry || summary) {
      try {
        const persisted = await persistSellerDocumentAiFindings(deps.prisma, {
          workspaceId: args.input.workspaceId,
          companyId: args.input.companyId,
          products: allProducts,
          industry,
          summary,
        });
        aiProductsCount = persisted.offeringsUpserted;
      } catch (persistError) {
        log.warn(
          `seller document AI offering persist skipped (${args.input.documentId}): ${
            persistError instanceof Error ? persistError.message : String(persistError)
          }`,
        );
      }
    }

    // S2 确定性 + 模型原句字节核验要点草稿（严格 NEEDS_REVIEW，零幻觉）：
    if (deps.claims) {
      args.pulse('extract_claims');
      try {
        const res = await deps.claims.createAssistedDrafts(
          {
            workspaceId: args.input.workspaceId,
            userId: args.uploadedBy?.trim() || args.input.workspaceId,
            roles: [],
            scopes: [],
          },
          args.input.companyId,
          args.input.documentId,
          {
            ...(args.chunkSeqs?.length ? { chunkSeqs: args.chunkSeqs } : {}),
            maxChunks: AUTO_ASSISTED_MAX_CHUNKS,
            maxCandidates: AUTO_ASSISTED_MAX_CANDIDATES,
            ...(modelSuggestionsByChunk.size > 0 ? { modelSuggestionsByChunk } : {}),
          },
        );
        aiClaimsCount = Array.isArray(res?.drafts) ? res.drafts.length : 0;
      } catch (extractError) {
        log.warn(
          `seller document assisted claim extraction skipped (${args.input.documentId}): ${
            extractError instanceof Error ? extractError.message : String(extractError)
          }`,
        );
      }
    }

    return { aiProductsCount, aiClaimsCount };
  }

  return {
    ...createSellerDocumentPendingCleanupActivities({
      prisma: deps.prisma,
      storage: deps.storage,
    }),
    /** 单文档解析（首阶段）：大页数 PDF 优先解析前 15 页快速变 ready，随后由工作流自动补全尾页。 */
    async processSellerDocument(
      input: SellerDocumentIngestInput,
    ): Promise<{
      documentId: string;
      outcome: 'ready' | 'queued' | 'failed_terminal' | 'not_due' | 'gone';
      retryAfterSeconds?: number;
      tailPagesPending?: boolean;
      nextStartPage?: number;
      totalPages?: number;
    }> {
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
          const failed = await fail(input, leaseToken, attempt, 'DOCUMENT_DOWNLOAD_UNAVAILABLE');
          return { documentId: input.documentId, ...failed };
        }

        pulse('parse');
        await recordStage(input, leaseToken, 'parse');
        signal?.throwIfAborted();
        const parsed = await parsePrimaryDocument(input, row, content, pulse, signal);
        if (!parsed.ok) {
          const failed = await fail(input, leaseToken, attempt, parsed.code, {
            terminal: parsed.terminal,
          });
          return { documentId: input.documentId, ...failed };
        }
        if (!parsed.markdown.trim()) {
          const failed = await fail(input, leaseToken, attempt, 'DOCUMENT_NO_CONTENT', {
            terminal: true,
          });
          return { documentId: input.documentId, ...failed };
        }

        pulse('chunk');
        const chunks = chunkMarkdown(parsed.markdown).slice(0, MAX_CHUNKS);
        if (chunks.length === 0) {
          const failed = await fail(input, leaseToken, attempt, 'DOCUMENT_NO_CONTENT', {
            terminal: true,
          });
          return { documentId: input.documentId, ...failed };
        }

        pulse('embed');
        await recordStage(input, leaseToken, 'embed');
        const embedded = await embedChunks(chunks, input.workspaceId, pulse, signal);
        if (!embedded.ok) {
          const failed = await fail(input, leaseToken, attempt, embedded.code, {
            terminal: embedded.terminal,
          });
          return { documentId: input.documentId, ...failed };
        }

        pulse('persist');
        await recordStage(input, leaseToken, 'persist');
        signal?.throwIfAborted();
        const parsedMeta: ParsedMetaState = {
          chunks: chunks.length,
          mode: parsed.tailPagesPending ? 'priority_pages' : 'full',
          ...(parsed.parsedPages !== undefined ? { parsedPages: parsed.parsedPages } : {}),
          ...(parsed.totalPages !== undefined ? { totalPages: parsed.totalPages } : {}),
          fullParsePending: parsed.tailPagesPending,
          visionUsed: parsed.visionUsed,
        };
        const published = await deps.prisma.withWorkspace(
          input.workspaceId,
          async (tx) => {
            const rows = await tx.$queryRaw<Array<{ parse_revision: number }>>(Prisma.sql`
              UPDATE "seller_document"
              SET "status" = 'ready',
                  "chunk_count" = ${chunks.length},
                  "parsed_meta" = ${JSON.stringify(parsedMeta)}::jsonb,
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
          },
          { maxWait: 10_000, timeout: 15_000 },
        );
        if (published === null) {
          log.warn(`seller document finalize lost lease (${input.documentId})`);
          return { documentId: input.documentId, outcome: 'not_due' };
        }

        const filename = resolveDoclingFilename(input.documentId, row.filename, row.mime);
        const enriched = await runPostPublishEnrichment({
          input,
          uploadedBy: row.uploaded_by,
          filename,
          chunks,
          visionProducts: parsed.visionProducts,
          visionIndustry: parsed.visionIndustry,
          visionSummary: parsed.visionSummary,
          visionUsed: parsed.visionUsed,
          correlationSuffix: `rev${published}`,
          pulse,
          signal,
        });
        if (enriched.aiProductsCount > 0 || enriched.aiClaimsCount > 0) {
          await updateParsedMeta(input, {
            aiProductsCount: enriched.aiProductsCount,
            aiClaimsCount: enriched.aiClaimsCount,
          });
        }

        return {
          documentId: input.documentId,
          outcome: 'ready',
          ...(parsed.tailPagesPending
            ? {
                tailPagesPending: true,
                nextStartPage: (parsed.parsedPages ?? PRIORITY_PDF_PAGES) + 1,
                ...(parsed.totalPages !== undefined ? { totalPages: parsed.totalPages } : {}),
              }
            : {}),
        };
      } catch (error) {
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

    /** 阶段二（后台尾页补全）：按 15 页安全批次解析剩余页并追加分块与 AI 抽取，失败不回退已就绪的前 15 页。 */
    async processSellerDocumentTailPages(
      input: SellerDocumentTailPagesInput,
    ): Promise<{ documentId: string; appendedChunks: number; parsedPages: number; partial: boolean }> {
      const activity = currentActivityContext();
      const signal = activity?.cancellationSignal;
      let stage = 'tail_load';
      const pulse = (nextStage: string) => {
        stage = nextStage;
        activity?.heartbeat({ documentId: input.documentId, stage });
      };
      const heartbeatTimer = activity
        ? setInterval(() => activity.heartbeat({ documentId: input.documentId, stage }), HEARTBEAT_INTERVAL_MS)
        : undefined;
      heartbeatTimer?.unref();

      try {
        const doc = await deps.prisma.withWorkspace(input.workspaceId, (tx) =>
          tx.sellerDocument.findFirst({
            where: {
              id: input.documentId,
              companyId: input.companyId,
              deletedAt: null,
              status: 'ready',
            },
            select: {
              filename: true,
              objectKey: true,
              mime: true,
              uploadedBy: true,
              chunkCount: true,
              parsedMeta: true,
            },
          }),
        );
        if (!doc || doc.mime !== 'application/pdf') {
          return { documentId: input.documentId, appendedChunks: 0, parsedPages: input.startPage - 1, partial: false };
        }

        const existingChunks = doc.chunkCount ?? 0;
        const remainingChunkBudget = Math.max(0, MAX_CHUNKS - existingChunks);
        if (remainingChunkBudget === 0) {
          await updateParsedMeta(input, { mode: 'full', fullParsePending: false });
          return { documentId: input.documentId, appendedChunks: 0, parsedPages: input.startPage - 1, partial: false };
        }

        pulse('tail_download');
        signal?.throwIfAborted();
        const content = await deps.storage.getBufferBounded(doc.objectKey, MAX_DOCUMENT_BYTES);
        const filename = resolveDoclingFilename(input.documentId, doc.filename, doc.mime);
        const targetEndPage = Math.min(input.totalPages ?? MAX_PDF_PAGES, MAX_PDF_PAGES);
        const batches = computePdfPageBatches(input.startPage, targetEndPage, TAIL_PDF_PAGE_BATCH);

        const tailMarkdownParts: string[] = [];
        let lastParsedPage = input.startPage - 1;
        let partial = false;

        for (const [batchStart, batchEnd] of batches) {
          signal?.throwIfAborted();
          pulse(`tail_parse:${batchStart}-${batchEnd}`);
          try {
            const converted = await deps.docling.convertToMarkdown(
              filename,
              content,
              signal,
              input.workspaceId,
              {
                pageRange: [batchStart, batchEnd],
                returnPageCount: true,
                allowEmptyMarkdown: true,
              },
            );
            if (converted.markdown.trim()) {
              tailMarkdownParts.push(converted.markdown.trim());
            }
            const returnedCount = converted.pageCount;
            if (returnedCount !== undefined && returnedCount === 0) {
              break;
            }
            lastParsedPage =
              returnedCount !== undefined
                ? Math.min(batchEnd, batchStart + returnedCount - 1)
                : batchEnd;
            if (input.totalPages === undefined && returnedCount !== undefined && returnedCount < batchEnd - batchStart + 1) {
              break;
            }
          } catch (batchErr) {
            if (signal?.aborted) throw batchErr;
            log.warn(
              `seller document tail batch ${batchStart}-${batchEnd} degraded (${input.documentId}): ${
                batchErr instanceof Error ? batchErr.message : String(batchErr)
              }`,
            );
            partial = true;
            break;
          }
        }

        const combinedTailMd = tailMarkdownParts.join('\n\n');
        const rawTailChunks = combinedTailMd ? chunkMarkdown(combinedTailMd).slice(0, remainingChunkBudget) : [];

        if (rawTailChunks.length === 0) {
          await updateParsedMeta(input, {
            mode: 'full',
            parsedPages: lastParsedPage,
            ...(input.totalPages !== undefined ? { totalPages: input.totalPages } : { totalPages: lastParsedPage }),
            fullParsePending: false,
            ...(partial ? { tailParsePartial: true } : {}),
          });
          return { documentId: input.documentId, appendedChunks: 0, parsedPages: lastParsedPage, partial };
        }

        pulse('tail_embed');
        const embedded = await embedChunks(rawTailChunks, input.workspaceId, pulse, signal);
        if (!embedded.ok) {
          await updateParsedMeta(input, {
            mode: 'full',
            parsedPages: lastParsedPage,
            fullParsePending: false,
            tailParsePartial: true,
          });
          return { documentId: input.documentId, appendedChunks: 0, parsedPages: lastParsedPage, partial: true };
        }

        pulse('tail_persist');
        const appendedSeqs: number[] = [];
        const persistedTail = await deps.prisma.withWorkspace(
          input.workspaceId,
          async (tx) => {
            const agg = await tx.sellerDocumentChunk.aggregate({
              where: { documentId: input.documentId },
              _max: { seq: true },
              _count: { _all: true },
            });
            const baseSeq = (agg._max.seq ?? -1) + 1;
            const totalChunks = (agg._count._all ?? 0) + rawTailChunks.length;
            const prevMeta =
              doc.parsedMeta && typeof doc.parsedMeta === 'object' && !Array.isArray(doc.parsedMeta)
                ? (doc.parsedMeta as Record<string, unknown>)
                : {};
            const nextMeta: Record<string, unknown> = {
              ...prevMeta,
              chunks: totalChunks,
              mode: 'full',
              parsedPages: lastParsedPage,
              totalPages: input.totalPages ?? lastParsedPage,
              fullParsePending: false,
              ...(partial ? { tailParsePartial: true } : {}),
            };
            for (const [index, chunk] of rawTailChunks.entries()) {
              const nextSeq = baseSeq + index;
              appendedSeqs.push(nextSeq);
              const vector = `[${embedded.vectors[index].join(',')}]`;
              await tx.$executeRaw(Prisma.sql`
                INSERT INTO "seller_document_chunk"
                  ("id", "workspace_id", "document_id", "seq", "text", "meta", "embed_model", "embed_version", "embedding")
                VALUES
                  (${randomUUID()}::uuid, ${input.workspaceId}::uuid, ${input.documentId}::uuid,
                   ${nextSeq}, ${chunk.text}, ${JSON.stringify(chunk.meta)}::jsonb,
                   ${deps.embeddings.model}, ${deps.embeddings.version}, ${vector}::vector)
              `);
            }
            const rows = await tx.$queryRaw<Array<{ parse_revision: number }>>(Prisma.sql`
              UPDATE "seller_document"
              SET "chunk_count" = ${totalChunks},
                  "parsed_meta" = ${JSON.stringify(nextMeta)}::jsonb,
                  "parse_revision" = COALESCE("parse_revision", 0) + 1,
                  "updated_at" = now()
              WHERE "id" = ${input.documentId}::uuid
                AND "workspace_id" = ${input.workspaceId}::uuid
                AND "status" = 'ready'
              RETURNING "parse_revision"
            `);
            return { parseRevision: rows[0]?.parse_revision ?? 1, baseSeq };
          },
          { maxWait: 10_000, timeout: 15_000 },
        );

        const tailChunksWithSeq = rawTailChunks.map((chunk, idx) => ({
          seq: persistedTail.baseSeq + idx,
          text: chunk.text,
          meta: chunk.meta,
        }));
        const enriched = await runPostPublishEnrichment({
          input,
          uploadedBy: doc.uploadedBy,
          filename,
          chunks: tailChunksWithSeq,
          chunkSeqs: appendedSeqs,
          visionUsed: false,
          correlationSuffix: `tail-rev${persistedTail.parseRevision}`,
          pulse,
          signal,
        });
        if (enriched.aiProductsCount > 0 || enriched.aiClaimsCount > 0) {
          const prevMeta =
            doc.parsedMeta && typeof doc.parsedMeta === 'object' && !Array.isArray(doc.parsedMeta)
              ? (doc.parsedMeta as Record<string, unknown>)
              : {};
          const prevProducts = typeof prevMeta.aiProductsCount === 'number' ? prevMeta.aiProductsCount : 0;
          const prevClaims = typeof prevMeta.aiClaimsCount === 'number' ? prevMeta.aiClaimsCount : 0;
          await updateParsedMeta(input, {
            aiProductsCount: prevProducts + enriched.aiProductsCount,
            aiClaimsCount: prevClaims + enriched.aiClaimsCount,
          });
        }

        return {
          documentId: input.documentId,
          appendedChunks: rawTailChunks.length,
          parsedPages: lastParsedPage,
          partial,
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        log.warn(
          `seller document tail pages failed softly (${input.documentId}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await updateParsedMeta(input, {
          mode: 'full',
          fullParsePending: false,
          tailParsePartial: true,
        });
        return { documentId: input.documentId, appendedChunks: 0, parsedPages: input.startPage - 1, partial: true };
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
      }
    },
  };
}
