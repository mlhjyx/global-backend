import { Injectable } from '@nestjs/common';
import { KbIngestError } from './kb-errors';
import {
  positiveIntEnv,
  TenantConcurrencySemaphore,
} from '../runtime/tenant-concurrency-semaphore';

export type DoclingBackendMode = 'local' | 'managed_api';

export function resolveDoclingBackendMode(
  env: NodeJS.ProcessEnv = process.env,
): DoclingBackendMode {
  return env.DOCLING_BACKEND?.trim().toLowerCase() === 'managed_api'
    ? 'managed_api'
    : 'local';
}

const CONVERT_TIMEOUT_MS = 300_000; // 首次调用会下载布局模型，放宽
const MAX_EXTRACTED_PAGE_IMAGES = 8;
const MAX_RAW_PAGE_IMAGE_BYTES = 8 * 1024 * 1024;
const PNG_DATA_URI_PREFIX = 'data:image/png;base64,';

export interface DoclingConvertOptions {
  /** 可选工作空间 ID，用于租户并发隔离信号量与 X-Workspace-Id 透传。 */
  readonly workspaceId?: string;
  /** 1-based 闭区间页码范围（如 [1, 15]），仅对分页文档生效。 */
  readonly pageRange?: readonly [number, number];
  /** 强制启用 OCR（扫描件 / 转曲印刷 PDF 兜底）。 */
  readonly forceOcr?: boolean;
  /** 返回页面渲染 PNG（供 L3 视觉模型解析扫描件/图文表）。 */
  readonly includePageImages?: boolean;
  /** 页面图像缩放比例（默认 1.0）。 */
  readonly imagesScale?: number;
  /** 同时请求 json 结构以读取实际解析页数。 */
  readonly returnPageCount?: boolean;
  /** 允许空 Markdown 返回（调用方决定是否走 OCR/视觉兜底，而不直接判失败）。 */
  readonly allowEmptyMarkdown?: boolean;
}

export interface DoclingPageImage {
  readonly pageNo: number;
  readonly pngBytes: Buffer;
}

export interface DoclingConvertResult {
  readonly markdown: string;
  readonly pageCount?: number;
  readonly pageImages?: readonly DoclingPageImage[];
}

interface DoclingPageEntry {
  page_no?: unknown;
  image?: { uri?: unknown };
}

interface DoclingResponse {
  document?: {
    md_content?: string;
    json_content?: {
      pages?: Record<string, DoclingPageEntry>;
    };
  };
  status?: string;
  errors?: unknown[];
}

function extractPagesInfo(jsonContent: unknown): {
  pageCount?: number;
  pageImages: DoclingPageImage[];
} {
  if (!isRecord(jsonContent) || !isRecord(jsonContent.pages)) {
    return { pageImages: [] };
  }
  const entries = Object.entries(jsonContent.pages);
  const pageCount = entries.length > 0 ? entries.length : undefined;
  const pageImages: DoclingPageImage[] = [];
  const sorted = entries
    .map(([key, value]) => ({
      pageNo: Number(isRecord(value) && typeof value.page_no === 'number' ? value.page_no : key),
      value,
    }))
    .filter((entry) => Number.isSafeInteger(entry.pageNo) && entry.pageNo >= 1)
    .sort((a, b) => a.pageNo - b.pageNo);

  for (const entry of sorted) {
    if (pageImages.length >= MAX_EXTRACTED_PAGE_IMAGES) break;
    if (!isRecord(entry.value) || !isRecord(entry.value.image)) continue;
    const uri = entry.value.image.uri;
    if (typeof uri !== 'string' || !uri.startsWith(PNG_DATA_URI_PREFIX)) continue;
    const b64 = uri.slice(PNG_DATA_URI_PREFIX.length);
    if (!b64) continue;
    const pngBytes = Buffer.from(b64, 'base64');
    if (pngBytes.byteLength >= 8 && pngBytes.byteLength <= MAX_RAW_PAGE_IMAGE_BYTES) {
      pageImages.push({ pageNo: entry.pageNo, pngBytes });
    }
  }
  return { ...(pageCount !== undefined ? { pageCount } : {}), pageImages };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isDocumentInputFailure(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const component = String(value.component_type ?? value.component ?? value.scope ?? '').toLowerCase();
  const marker = String(value.code ?? value.type ?? value.error_type ?? '').toLowerCase();
  const message = String(value.message ?? value.error_message ?? value.detail ?? '').toLowerCase();
  const userInput = component === 'user_input' || component === 'document' || component === 'input';
  const formatFailure =
    /data format|unsupported (file |document )?format|invalid (file|document)|corrupt|malformed/.test(
      `${marker} ${message}`,
    );
  return userInput && formatFailure;
}

function hasDocumentInputFailure(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const candidates: unknown[] = [value, value.error, value.detail];
  if (Array.isArray(value.errors)) candidates.push(...value.errors);
  return candidates.some(isDocumentInputFailure);
}

function requestSignal(external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(CONVERT_TIMEOUT_MS);
  return external ? AbortSignal.any([external, timeout]) : timeout;
}

/**
 * Docling 解析容器客户端（02 §12：PDF/DOCX/PPTX → markdown，表格保结构，全本地）。
 * 解析在非特权容器内进行（06 §2），本客户端只送 base64 收 markdown。
 */
@Injectable()
export class DoclingClient {
  readonly backendMode: DoclingBackendMode = resolveDoclingBackendMode(process.env);
  private readonly baseUrl = (
    (this.backendMode === 'managed_api'
      ? process.env.DOCLING_MANAGED_URL?.trim() || process.env.DOCLING_URL?.trim()
      : process.env.DOCLING_URL?.trim()) || 'http://localhost:5001'
  ).replace(/\/$/, '');
  private readonly apiKey =
    this.backendMode === 'managed_api'
      ? process.env.DOCLING_API_KEY?.trim() || process.env.MODEL_GATEWAY_KEY?.trim() || ''
      : process.env.DOCLING_API_KEY?.trim() || '';
  private readonly semaphore = new TenantConcurrencySemaphore({
    name: 'docling',
    perTenantLimit: positiveIntEnv(process.env, 'DOCLING_MAX_CONCURRENT_PER_TENANT', 2, 16),
    globalLimit: positiveIntEnv(process.env, 'DOCLING_MAX_CONCURRENT_GLOBAL', 6, 64),
    acquireTimeoutMs: CONVERT_TIMEOUT_MS,
  });

  async convertToMarkdown(
    filename: string,
    data: Buffer,
    signal?: AbortSignal,
    workspaceIdOrOpts?: string | DoclingConvertOptions,
    optsArg?: DoclingConvertOptions,
  ): Promise<DoclingConvertResult> {
    const workspaceId =
      typeof workspaceIdOrOpts === 'string'
        ? workspaceIdOrOpts
        : workspaceIdOrOpts?.workspaceId;
    const opts =
      typeof workspaceIdOrOpts === 'string' ? optsArg : workspaceIdOrOpts;
    const needJson = opts?.includePageImages === true || opts?.returnPageCount === true;
    const options: Record<string, unknown> = {
      to_formats: needJson ? ['md', 'json'] : ['md'],
    };
    if (opts?.pageRange) {
      const [start, end] = opts.pageRange;
      if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 1 && end >= start) {
        options.page_range = [start, end];
      }
    }
    if (opts?.forceOcr === true) {
      options.force_ocr = true;
    }
    if (opts?.includePageImages === true) {
      options.include_images = true;
      options.generate_page_images = true;
      options.image_export_mode = 'embedded';
      options.images_scale =
        typeof opts.imagesScale === 'number' && Number.isFinite(opts.imagesScale) && opts.imagesScale > 0
          ? Math.min(Math.max(opts.imagesScale, 0.5), 2.0)
          : 1.0;
    }

    const run = async (): Promise<DoclingConvertResult> => {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        ...(workspaceId?.trim() ? { 'X-Workspace-Id': workspaceId.trim() } : {}),
      };
      let res: Response;
      try {
        if (signal?.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new Error('Aborted');
        }
        res = await fetch(`${this.baseUrl}/v1/convert/source`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            options,
            sources: [{ kind: 'file', base64_string: data.toString('base64'), filename }],
          }),
          signal: requestSignal(signal),
        });
      } catch (err) {
        throw new KbIngestError(
          'KB_DOCLING_UNAVAILABLE',
          'retryable',
          'parse',
          `docling unavailable: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? { cause: err } : undefined,
        );
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        let structured: unknown;
        try {
          structured = JSON.parse(body);
        } catch {
          structured = undefined;
        }
        // 415/422 也可能是网关或 FastAPI 请求 schema/部署契约错误，状态码本身
        // 不能给用户文档定罪；只认明确绑定 user_input/document 的格式损坏证据。
        const invalidInput = hasDocumentInputFailure(structured);
        throw new KbIngestError(
          invalidInput ? 'KB_DOCUMENT_INVALID' : 'KB_DOCLING_UNAVAILABLE',
          invalidInput ? 'terminal' : 'retryable',
          'parse',
          `docling convert ${res.status}: ${body.slice(0, 300)}`,
        );
      }
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch (err) {
        throw new KbIngestError(
          'KB_DOCLING_UNAVAILABLE',
          'retryable',
          'parse',
          'docling returned malformed JSON',
          err instanceof Error ? { cause: err } : undefined,
        );
      }
      if (!isRecord(parsed)) {
        throw new KbIngestError(
          'KB_DOCLING_UNAVAILABLE',
          'retryable',
          'parse',
          'docling returned a non-object response',
        );
      }
      const json = parsed as DoclingResponse;
      const rawMarkdown = json.document?.md_content;
      const markdown = typeof rawMarkdown === 'string' ? rawMarkdown : '';
      const pagesInfo = needJson ? extractPagesInfo(json.document?.json_content) : { pageImages: [] };
      if (markdown.length === 0 && opts?.allowEmptyMarkdown !== true) {
        const invalidInput = hasDocumentInputFailure(parsed);
        throw new KbIngestError(
          invalidInput ? 'KB_DOCUMENT_INVALID' : 'KB_DOCLING_UNAVAILABLE',
          invalidInput ? 'terminal' : 'retryable',
          'parse',
          `docling returned no markdown (status=${json.status ?? 'unknown'})`,
        );
      }
      return {
        markdown,
        ...(pagesInfo.pageCount !== undefined ? { pageCount: pagesInfo.pageCount } : {}),
        ...(opts?.includePageImages === true ? { pageImages: pagesInfo.pageImages } : {}),
      };
    };

    try {
      return await this.semaphore.withTenantSlot(workspaceId, run, signal);
    } catch (err) {
      if (err instanceof KbIngestError) throw err;
      throw new KbIngestError(
        'KB_DOCLING_UNAVAILABLE',
        'retryable',
        'parse',
        `docling unavailable: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? { cause: err } : undefined,
      );
    }
  }
}
