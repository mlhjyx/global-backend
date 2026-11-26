import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service';
import type { ModelGateway } from '../model-gateway/model-gateway';
import type { VisionReviewImage } from '../model-gateway/types';
import type { RuntimeTelemetry } from '../model-runtime/types';
import {
  executeStructuredTaskWithRuntime,
  executeVisionTaskWithRuntime,
} from '../model-runtime/structured-task-runtime-bridge';
import { getTask } from '../ai-tasks/task-registry';
import { isNavigationNoiseOffering } from '../discovery/offering-noise-filter';
import { mergeSelectionMarker, readSelectionMarker } from '../company/offering-selection';
import type { ModelClaimSuggestion } from './seller-document-claim-extractor';
import type { DoclingPageImage } from '../site-builder/docling.client';

const TASK_ID = 'seller_document.analyze' as const;
const MAX_PROMPT_CHARS = 12_000;
const MAX_PRODUCTS_PER_DOC = 25;
const MAX_VISION_PAGES = 6;
const MAX_VISION_BATCH_IMAGES = 3;
const MAX_VISION_IMAGE_BYTES = 1_500_000;
const DEFAULT_VISION_MODEL = 'gemini-3.8-flash';
const VALID_CLAIM_TYPES = new Set([
  'capability',
  'certification',
  'case',
  'param',
  'moq',
  'lead_time',
  'market',
  'company_fact',
  'value_prop',
]);

export interface SellerDocumentChunkInput {
  readonly seq: number;
  readonly text: string;
  readonly meta?: unknown;
}

export interface SellerDocumentAiProduct {
  readonly name: string;
  readonly description?: string;
  readonly attributes?: Record<string, unknown>;
  readonly evidence?: string;
  readonly confidence: number;
}

export interface SellerDocumentAiClaim {
  readonly chunkSeq: number;
  readonly type: string;
  readonly statement: string;
  readonly quote: string;
  readonly confidence: number;
}

export interface SellerDocumentAiOutput {
  readonly industry?: string;
  readonly summary?: string;
  readonly transcribedMarkdown?: string;
  readonly products: readonly SellerDocumentAiProduct[];
  readonly claims: readonly SellerDocumentAiClaim[];
}

export interface SellerDocumentAiAnalysisResult {
  readonly skipped: boolean;
  readonly visionUsed: boolean;
  readonly industry?: string;
  readonly summary?: string;
  readonly transcribedMarkdown?: string;
  readonly products: SellerDocumentAiProduct[];
  readonly modelSuggestionsByChunk: Map<number, ModelClaimSuggestion[]>;
}

export interface AnalyzeSellerDocumentChunksArgs {
  readonly gateway?: ModelGateway;
  readonly runtimeTelemetry?: RuntimeTelemetry;
  readonly workspaceId: string;
  readonly documentId: string;
  readonly filename: string;
  readonly chunks: readonly SellerDocumentChunkInput[];
  readonly correlationSuffix?: string;
  readonly signal?: AbortSignal;
}

export interface AnalyzeSellerDocumentVisionArgs {
  readonly gateway?: ModelGateway;
  readonly workspaceId: string;
  readonly documentId: string;
  readonly filename: string;
  readonly pageImages: readonly DoclingPageImage[];
  readonly resizePng?: (pngBytes: Buffer) => Promise<Buffer>;
  readonly signal?: AbortSignal;
}

const log = new Logger('SellerDocumentAiAnalyzer');

function resolveVisionModel(): string {
  return process.env.SELLER_DOCUMENTS_VISION_MODEL?.trim() || DEFAULT_VISION_MODEL;
}

/** 挑选信息密度最高的分块（优先保留首部总览、含参数表/型号/资质的分块，总字符 ≤ 12,000）。 */
export function selectHighSignalChunks(
  chunks: readonly SellerDocumentChunkInput[],
  maxChars = MAX_PROMPT_CHARS,
): SellerDocumentChunkInput[] {
  if (chunks.length === 0) return [];
  const scored = chunks.map((chunk, idx) => {
    const text = chunk.text.trim();
    let score = 0;
    if (idx < 3) score += 25 - idx * 5;
    if (text.includes('|')) score += 18; // Markdown 参数表
    if (/\b(ISO|CE|UL|TUV|TÜV|IEC|RoHS|FDA|REACH|SGS|MOQ|OEM|ODM)\b/i.test(text)) score += 16;
    if (/\d+\s*(W|kW|kWh|V|A|mm|cm|kg|pcs|sets|days|weeks|%|℃)/i.test(text)) score += 14;
    if (/^#{1,3}\s/m.test(text)) score += 10;
    if (text.length < 40) score -= 20;
    return { chunk, score };
  });
  scored.sort((a, b) => b.score - a.score || a.chunk.seq - b.chunk.seq);

  const picked: SellerDocumentChunkInput[] = [];
  let usedChars = 0;
  for (const item of scored) {
    const snippetLen = item.chunk.text.length + 32;
    if (picked.length > 0 && usedChars + snippetLen > maxChars) continue;
    picked.push(item.chunk);
    usedChars += snippetLen;
    if (usedChars >= maxChars) break;
  }
  picked.sort((a, b) => a.seq - b.seq);
  return picked;
}

function cleanProducts(rawProducts: readonly SellerDocumentAiProduct[] | undefined): SellerDocumentAiProduct[] {
  if (!Array.isArray(rawProducts)) return [];
  const seen = new Set<string>();
  const out: SellerDocumentAiProduct[] = [];
  for (const item of rawProducts) {
    if (!item || typeof item.name !== 'string') continue;
    const name = item.name.trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 120 || isNavigationNoiseOffering(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const confidence =
      typeof item.confidence === 'number' && Number.isFinite(item.confidence)
        ? Math.min(Math.max(item.confidence, 0), 1)
        : 0.75;
    out.push({
      name,
      ...(typeof item.description === 'string' && item.description.trim()
        ? { description: item.description.trim().slice(0, 1000) }
        : {}),
      ...(item.attributes && typeof item.attributes === 'object' && !Array.isArray(item.attributes)
        ? { attributes: item.attributes }
        : {}),
      ...(typeof item.evidence === 'string' && item.evidence.trim()
        ? { evidence: item.evidence.trim().slice(0, 800) }
        : {}),
      confidence,
    });
    if (out.length >= MAX_PRODUCTS_PER_DOC) break;
  }
  return out;
}

function groupClaimSuggestions(
  rawClaims: readonly SellerDocumentAiClaim[] | undefined,
  allowedSeqs: ReadonlySet<number>,
): Map<number, ModelClaimSuggestion[]> {
  const map = new Map<number, ModelClaimSuggestion[]>();
  if (!Array.isArray(rawClaims)) return map;
  for (const item of rawClaims) {
    if (!item || typeof item.statement !== 'string' || typeof item.quote !== 'string') continue;
    const seq = Math.trunc(Number(item.chunkSeq));
    if (!Number.isSafeInteger(seq) || !allowedSeqs.has(seq)) continue;
    const type = typeof item.type === 'string' && VALID_CLAIM_TYPES.has(item.type) ? item.type : 'company_fact';
    const statement = item.statement.trim();
    const quote = item.quote.trim();
    if (statement.length < 4 || quote.length < 4) continue;
    const confidence =
      typeof item.confidence === 'number' && Number.isFinite(item.confidence)
        ? Math.min(Math.max(item.confidence, 0), 1)
        : 0.8;
    const list = map.get(seq) ?? [];
    list.push({ type, statement, quote, confidence });
    map.set(seq, list);
  }
  return map;
}

function isGracefulSkipError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  const code = (error as { code?: unknown }).code;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    name === 'BudgetAccountUnavailableError' ||
    name === 'ExecutionBudgetGrantError' ||
    code === 'BUDGET_ACCOUNT_UNAVAILABLE' ||
    code === 'EXECUTION_BUDGET_GRANT_MISSING' ||
    /no model provider|ACCOUNT_UNAVAILABLE|BUDGET_ACCOUNT/i.test(msg)
  );
}

async function defaultResizePagePng(pngBytes: Buffer): Promise<Buffer> {
  try {
    const sharpMod = await import('sharp');
    const sharpFn = (sharpMod.default ?? sharpMod) as unknown as (
      input: Buffer,
    ) => {
      resize: (opts: { width: number; withoutEnlargement: boolean }) => {
        png: (opts: { compressionLevel: number; palette?: boolean }) => { toBuffer: () => Promise<Buffer> };
      };
    };
    const resized = await sharpFn(pngBytes)
      .resize({ width: 1280, withoutEnlargement: true })
      .png({ compressionLevel: 8 })
      .toBuffer();
    if (resized.byteLength <= MAX_VISION_IMAGE_BYTES) return resized;
    return sharpFn(pngBytes)
      .resize({ width: 960, withoutEnlargement: true })
      .png({ compressionLevel: 9, palette: true })
      .toBuffer();
  } catch {
    return pngBytes;
  }
}

/**
 * L2 轻量文本 AI 分析：对高信息密度分块做一次结构化提取，输出：
 * - products → 写入 offering（source='seller_document'），立即可在建档与企业档案勾选；
 * - claims → 按 chunkSeq 分组交给 SellerDocumentClaimsService 做 UTF-8 原句字节核验，零幻觉落 NEEDS_REVIEW；
 * - industry / summary → 仅在企业档案当前为空时补充。
 */
export async function analyzeSellerDocumentTextChunks(
  args: AnalyzeSellerDocumentChunksArgs,
): Promise<SellerDocumentAiAnalysisResult> {
  const empty: SellerDocumentAiAnalysisResult = {
    skipped: true,
    visionUsed: false,
    products: [],
    modelSuggestionsByChunk: new Map(),
  };
  if (!args.gateway || args.chunks.length === 0) return empty;
  const contract = getTask(TASK_ID);
  if (!contract) return empty;

  const selected = selectHighSignalChunks(args.chunks);
  if (selected.length === 0) return empty;
  const allowedSeqs = new Set(selected.map((c) => c.seq));

  const formattedChunks = selected
    .map((chunk) => `[CHUNK seq=${chunk.seq}]\n${chunk.text}`)
    .join('\n\n---\n\n')
    .slice(0, MAX_PROMPT_CHARS + 1000);

  const prompt = [
    `文件名称：${args.filename}`,
    '请从以下卖家产品画册分块中提取：',
    '1. products：所有具体产品/型号（去重、不要提取目录/联系方式/公司简介等非产品词），附简述与明确出现的 moq/lead_time/params/certifications/materials 属性；',
    '2. claims：高价值企业事实（认证、产能、核心参数、MOQ、交期、案例、优势），每条必须给出准确的 chunkSeq 以及逐字摘自该分块原文的连续原句 quote；',
    '3. 若画册清晰体现所属主行业与主营简介，可填 industry 与 summary；未出现则省略。',
    '',
    formattedChunks,
  ].join('\n');

  try {
    const res = await executeStructuredTaskWithRuntime<SellerDocumentAiOutput>(
      args.gateway,
      {
        task: contract.id,
        prompt,
        system: contract.description,
        model: contract.model,
        schema: contract.outputSchema,
        signal: args.signal,
      },
      {
        workspaceId: args.workspaceId,
        correlationId: `seller-doc:${args.documentId}${args.correlationSuffix ? `:${args.correlationSuffix}` : ''}`,
        durableResultSchema: 'seller-document-analyze/v1',
      },
      { telemetry: args.runtimeTelemetry },
    );
    const out = res.data;
    return {
      skipped: false,
      visionUsed: false,
      ...(typeof out.industry === 'string' && out.industry.trim() ? { industry: out.industry.trim().slice(0, 200) } : {}),
      ...(typeof out.summary === 'string' && out.summary.trim() ? { summary: out.summary.trim().slice(0, 2000) } : {}),
      products: cleanProducts(out.products),
      modelSuggestionsByChunk: groupClaimSuggestions(out.claims, allowedSeqs),
    };
  } catch (error) {
    if (args.signal?.aborted) throw error;
    const msg = error instanceof Error ? error.message : String(error);
    if (isGracefulSkipError(error)) {
      log.warn(`seller document L2 AI analysis skipped (gateway/budget unavailable) (${args.documentId}): ${msg}`);
    } else {
      log.warn(`seller document L2 AI analysis degraded (${args.documentId}): ${msg}`);
    }
    return empty;
  }
}

/**
 * L3 稀疏页多模态视觉兜底：仅在扫描件 / 转曲印刷 PDF 提取文本极少时按需触发，
 * 将最多 6 页压缩为 ≤1280px PNG 分批（每批 ≤3 张）送视觉模型提取产品清单与忠实原文 Markdown 转写。
 */
export async function analyzeSellerDocumentVisionPages(
  args: AnalyzeSellerDocumentVisionArgs,
): Promise<SellerDocumentAiAnalysisResult> {
  const empty: SellerDocumentAiAnalysisResult = {
    skipped: true,
    visionUsed: false,
    products: [],
    modelSuggestionsByChunk: new Map(),
  };
  if (!args.gateway || args.pageImages.length === 0) return empty;
  const contract = getTask(TASK_ID);
  if (!contract) return empty;

  const resize = args.resizePng ?? defaultResizePagePng;
  const pages = args.pageImages.slice(0, MAX_VISION_PAGES);
  const visionModel = resolveVisionModel();
  const mergedProducts: SellerDocumentAiProduct[] = [];
  const mdSections: string[] = [];
  let industry: string | undefined;
  let summary: string | undefined;
  let usedAny = false;

  for (let offset = 0; offset < pages.length; offset += MAX_VISION_BATCH_IMAGES) {
    args.signal?.throwIfAborted();
    const batch = pages.slice(offset, offset + MAX_VISION_BATCH_IMAGES);
    const images: VisionReviewImage[] = [];
    for (const page of batch) {
      const png = await resize(page.pngBytes);
      if (png.byteLength < 8 || png.byteLength > MAX_VISION_IMAGE_BYTES) continue;
      // 校验 PNG 文件头，避免畸形图触碰网关硬拒绝
      if (png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) continue;
      const bytes = new Uint8Array(png.byteLength);
      bytes.set(png);
      images.push({
        materialClass: 'workspace_site_screenshot',
        workspaceId: args.workspaceId,
        artifactId: `seller-doc-${args.documentId.slice(0, 8)}-p${page.pageNo}`,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        mimeType: 'image/png',
        bytes,
        target: {
          locale: 'und',
          pageId: `page-${page.pageNo}`,
          breakpoint: 1440,
        },
      });
    }
    if (images.length === 0) continue;

    const pageNumbers = batch.map((p) => p.pageNo).join(', ');
    const prompt = [
      `文件名称：${args.filename}（第 ${pageNumbers} 页扫描/印刷页图像）`,
      '请忠实阅读这些画册页面图像并返回结构化 JSON：',
      '1. products：页面中出现的具体产品名称/型号、简述、参数、功率、尺寸、认证、MOQ 或交期（严禁编造）；',
      '2. transcribedMarkdown：按页面把关键产品标题、规格参数表、认证标识和公司资质忠实转写为简洁 Markdown，供知识库检索与原文溯源；',
      '3. claims：可留空数组（服务端将对 transcribedMarkdown 做确定性原文切片与核验）；',
      '4. 如封面/简介页明确包含所属主行业与简介，填 industry / summary。',
    ].join('\n');

    try {
      const res = await executeVisionTaskWithRuntime<SellerDocumentAiOutput>(
        args.gateway,
        {
          task: TASK_ID,
          prompt,
          system: contract.description,
          model: visionModel,
          schema: contract.outputSchema,
          images,
          maxTokens: Math.min(contract.maxOutputTokens ?? 4096, 8192),
          maxCostCents: Math.min(contract.maxCostCents ?? 15, 30),
          signal: args.signal,
        },
        {
          workspaceId: args.workspaceId,
          correlationId: `seller-doc-vision:${args.documentId}:b${offset}`,
        },
      );
      usedAny = true;
      const out = res.data;
      if (!industry && typeof out.industry === 'string' && out.industry.trim()) {
        industry = out.industry.trim().slice(0, 200);
      }
      if (!summary && typeof out.summary === 'string' && out.summary.trim()) {
        summary = out.summary.trim().slice(0, 2000);
      }
      if (typeof out.transcribedMarkdown === 'string' && out.transcribedMarkdown.trim()) {
        mdSections.push(`## Pages ${pageNumbers}\n\n${out.transcribedMarkdown.trim()}`);
      }
      mergedProducts.push(...cleanProducts(out.products));
    } catch (error) {
      if (args.signal?.aborted) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      log.warn(`seller document L3 vision batch skipped (${args.documentId}, pages=${pageNumbers}): ${msg}`);
      if (isGracefulSkipError(error)) break;
    }
  }

  return {
    skipped: !usedAny,
    visionUsed: usedAny,
    ...(industry ? { industry } : {}),
    ...(summary ? { summary } : {}),
    ...(mdSections.length > 0 ? { transcribedMarkdown: mdSections.join('\n\n') } : {}),
    products: cleanProducts(mergedProducts),
    modelSuggestionsByChunk: new Map(),
  };
}

/**
 * 将画册 AI 提取出的产品安全写回 offering 表（source='seller_document', sourceUrl=null）：
 * - 完整保留既有人工勾选标记（OfferingSelectionMarker）；
 * - 绝不覆盖用户手填或官网已提取的非空 description / industry / summary。
 */
export async function persistSellerDocumentAiFindings(
  prisma: PrismaService,
  args: {
    workspaceId: string;
    companyId: string;
    products: readonly SellerDocumentAiProduct[];
    industry?: string;
    summary?: string;
  },
): Promise<{ offeringsUpserted: number }> {
  const products = cleanProducts(args.products);
  const industry = args.industry?.trim() || undefined;
  const summary = args.summary?.trim() || undefined;
  if (products.length === 0 && !industry && !summary) {
    return { offeringsUpserted: 0 };
  }

  let offeringsUpserted = 0;
  await prisma.withWorkspace(
    args.workspaceId,
    async (tx) => {
      if (products.length > 0 && tx.offering) {
        const existing = await tx.offering.findMany({
          where: { companyId: args.companyId },
          select: { name: true, description: true, attributes: true, source: true },
        });
        const existingByName = new Map(existing.map((row) => [row.name, row]));

        for (const product of products) {
          const prior = existingByName.get(product.name);
          const marker = readSelectionMarker(prior?.attributes);
          const mergedAttrs = mergeSelectionMarker(
            product.attributes ?? (prior?.attributes && typeof prior.attributes === 'object' ? (prior.attributes as Record<string, unknown>) : undefined),
            marker,
          );
          await tx.offering.upsert({
            where: { companyId_name: { companyId: args.companyId, name: product.name } },
            create: {
              workspaceId: args.workspaceId,
              companyId: args.companyId,
              name: product.name,
              description: product.description ?? null,
              attributes: (mergedAttrs ?? Prisma.JsonNull) as Prisma.InputJsonValue,
              source: 'seller_document',
              sourceUrl: null,
              evidence: product.evidence ?? null,
              confidence: product.confidence,
            },
            update: {
              ...(prior?.description ? {} : product.description ? { description: product.description } : {}),
              ...(mergedAttrs ? { attributes: mergedAttrs as Prisma.InputJsonValue } : {}),
            },
          });
          offeringsUpserted += 1;
        }
      }

      if ((industry || summary) && tx.companyProfile) {
        const company = await tx.companyProfile.findUnique({
          where: { id: args.companyId },
          select: { industry: true, summary: true },
        });
        if (company) {
          const patch: Prisma.CompanyProfileUpdateInput = {};
          if (!company.industry?.trim() && industry) patch.industry = industry;
          if (!company.summary?.trim() && summary) patch.summary = summary;
          if (Object.keys(patch).length > 0) {
            await tx.companyProfile.update({
              where: { id: args.companyId },
              data: patch,
            });
          }
        }
      }
    },
    { maxWait: 10_000, timeout: 15_000 },
  );

  return { offeringsUpserted };
}
