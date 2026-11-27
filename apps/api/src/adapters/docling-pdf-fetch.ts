import { createHash } from 'node:crypto';
import {
  decodeJsonBytes,
  readFetchResponseBodyBounded,
} from './bounded-fetch-response';
import { requestPublicHttp } from './guarded-http';
import {
  isPdfDocumentUrl,
  isPdfMagicBytes,
  isPdfMediaType,
  pdfFilenameFromUrl,
} from './pdf-url-guard';
import {
  positiveIntEnv,
  TenantConcurrencySemaphore,
} from '../runtime/tenant-concurrency-semaphore';

export const DOCLING_PDF_PARSER_VERSION = 'docling-pdf/1' as const;
const DOCLING_PDF_TIMEOUT_MS = 60_000;
const DOCLING_PDF_RESPONSE_MAX_BYTES = 5_000_000;
const PDF_HTTP_DOWNLOAD_TIMEOUT_MS = 30_000;
const PDF_HTTP_MAX_BYTES = 10 * 1024 * 1024;
const PDF_HTTP_MAX_REDIRECTS = 5;
const DEFAULT_PDF_PAGE_RANGE: readonly [number, number] = [1, 15];
const PDF_FETCH_UA =
  'Mozilla/5.0 (compatible; GlobalBot/1.0; +https://global-backend.example/bot)';

export interface PdfExtractionInput {
  readonly url: string;
  readonly filename: string;
  readonly bytes: Buffer;
  readonly workspaceId?: string;
  readonly pageRange?: readonly [number, number];
}

export type PdfMarkdownExtractor = (
  input: PdfExtractionInput,
) => Promise<string | null>;

export interface PdfMarkdownPage {
  readonly markdown: string;
  readonly title: string | null;
  readonly contentHash: string;
  readonly parserVersion: typeof DOCLING_PDF_PARSER_VERSION;
}

/**
 * Sentinel error thrown when an HTTP-first fetch confirmed the target is a PDF
 * but Docling extraction returned empty/unavailable. Callers MUST treat this as
 * a clean degraded empty result instead of falling back to Crawl4AI Chromium `/md`
 * (which otherwise throws HTTP 502 on `.pdf` documents).
 */
export class PdfNotRenderableError extends Error {
  constructor(public readonly url: string) {
    super('pdf_not_renderable_in_browser');
    this.name = 'PdfNotRenderableError';
  }
}

let doclingPdfSemaphore: TenantConcurrencySemaphore | undefined;

function getDoclingPdfSemaphore(): TenantConcurrencySemaphore {
  doclingPdfSemaphore ??= new TenantConcurrencySemaphore({
    name: 'docling-pdf-fetch',
    perTenantLimit: positiveIntEnv(process.env, 'DOCLING_MAX_CONCURRENT_PER_TENANT', 2, 16),
    globalLimit: positiveIntEnv(process.env, 'DOCLING_MAX_CONCURRENT_GLOBAL', 6, 64),
    acquireTimeoutMs: DOCLING_PDF_TIMEOUT_MS,
  });
  return doclingPdfSemaphore;
}

export function isDoclingPdfFetchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.DOCLING_PDF_FETCH ?? 'on').trim().toLowerCase() !== 'off';
}

export function isPdfHttpResponse(
  url: string,
  contentType: string | null | undefined,
  body?: Buffer,
): boolean {
  return isPdfMediaType(contentType) || isPdfMagicBytes(body) || isPdfDocumentUrl(url);
}

function resolveDoclingEndpoint(env: NodeJS.ProcessEnv): { baseUrl: string; apiKey: string } {
  const managed = env.DOCLING_BACKEND?.trim().toLowerCase() === 'managed_api';
  const baseUrl = (
    (managed ? env.DOCLING_MANAGED_URL?.trim() || env.DOCLING_URL?.trim() : env.DOCLING_URL?.trim()) ||
    'http://localhost:5001'
  ).replace(/\/$/u, '');
  const apiKey = managed
    ? env.DOCLING_API_KEY?.trim() || env.MODEL_GATEWAY_KEY?.trim() || ''
    : env.DOCLING_API_KEY?.trim() || '';
  return { baseUrl, apiKey };
}

/**
 * Converts downloaded PDF bytes to Markdown via the self-hosted/managed Docling service
 * (capped to the first 15 pages by default to protect Docling memory on large trade-fair PDFs).
 * Never throws into discovery: returns `null` when Docling is disabled, unavailable, or empty.
 */
export async function extractPdfMarkdownWithDocling(
  input: PdfExtractionInput,
  env: NodeJS.ProcessEnv = process.env,
  semaphore: TenantConcurrencySemaphore = getDoclingPdfSemaphore(),
): Promise<string | null> {
  if (!isDoclingPdfFetchEnabled(env) || input.bytes.byteLength === 0) return null;
  const { baseUrl, apiKey } = resolveDoclingEndpoint(env);
  const pageRange = input.pageRange ?? DEFAULT_PDF_PAGE_RANGE;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...(input.workspaceId?.trim() ? { 'X-Workspace-Id': input.workspaceId.trim() } : {}),
  };
  const body = JSON.stringify({
    options: { to_formats: ['md'], page_range: [pageRange[0], pageRange[1]] },
    sources: [
      {
        kind: 'file',
        base64_string: input.bytes.toString('base64'),
        filename: input.filename,
      },
    ],
  });

  try {
    return await semaphore.withTenantSlot(input.workspaceId, async () => {
      const res = await fetch(`${baseUrl}/v1/convert/source`, {
        method: 'POST',
        redirect: 'error',
        headers,
        body,
        signal: AbortSignal.timeout(DOCLING_PDF_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const responseBytes = await readFetchResponseBodyBounded(
        res,
        DOCLING_PDF_RESPONSE_MAX_BYTES,
        'DOCLING_PDF_RESPONSE_TOO_LARGE',
      );
      const parsed = decodeJsonBytes<{ document?: { md_content?: unknown } }>(
        responseBytes,
        'DOCLING_PDF_RESPONSE_INVALID',
      );
      const markdown = typeof parsed.document?.md_content === 'string'
        ? parsed.document.md_content.trim()
        : '';
      return markdown.length > 0 ? markdown : null;
    });
  } catch {
    return null;
  }
}

export function buildPdfMarkdownPage(markdown: string, filename: string): PdfMarkdownPage {
  return {
    markdown,
    title: filename,
    contentHash: createHash('sha256').update(markdown, 'utf8').digest('hex'),
    parserVersion: DOCLING_PDF_PARSER_VERSION,
  };
}

export interface FetchPdfViaDoclingOptions {
  readonly workspaceId?: string;
  readonly extractPdf?: PdfMarkdownExtractor;
  readonly checkRedirectAllowed?: (finalUrl: string) => Promise<boolean>;
  readonly onRobotsRedirectBlocked?: (finalUrl: string) => never;
  readonly hooks?: {
    authorizeExternalAction?: () => Promise<boolean>;
    beforePhysicalWire?: () => Promise<void>;
  };
}

function isCrossOrigin(initialUrl: string, finalUrl: string | undefined): boolean {
  if (!finalUrl) return false;
  try {
    return new URL(initialUrl).origin !== new URL(finalUrl).origin;
  } catch {
    return true;
  }
}

/**
 * Downloads a public PDF URL through guarded SSRF-pinned HTTP and extracts Markdown via Docling.
 * Fatal egress/authorization/robots errors propagate fail-closed; network/HTTP/Docling failures
 * return `null` so callers settle cleanly instead of invoking headless Chromium (`crawler 502`).
 */
export async function fetchPdfViaDocling(
  url: string,
  options: FetchPdfViaDoclingOptions = {},
): Promise<PdfMarkdownPage | null> {
  const res = await requestPublicHttp(
    url,
    {
      method: 'GET',
      headers: {
        'User-Agent': PDF_FETCH_UA,
        Accept: 'application/pdf,application/octet-stream;q=0.8,*/*;q=0.1',
      },
      timeoutMs: PDF_HTTP_DOWNLOAD_TIMEOUT_MS,
      maxBytes: PDF_HTTP_MAX_BYTES,
      maxRedirects: PDF_HTTP_MAX_REDIRECTS,
    },
    options.hooks
      ? {
          authorizeExternalAction: options.hooks.authorizeExternalAction,
          beforePhysicalWire: options.hooks.beforePhysicalWire,
        }
      : undefined,
  );
  if (
    options.checkRedirectAllowed &&
    isCrossOrigin(url, res.finalUrl) &&
    !(await options.checkRedirectAllowed(res.finalUrl))
  ) {
    if (options.onRobotsRedirectBlocked) options.onRobotsRedirectBlocked(res.finalUrl);
    return null;
  }
  if (res.status < 200 || res.status >= 300 || res.body.byteLength === 0) return null;
  const contentType = res.headers['content-type'] ?? null;
  if (!isPdfHttpResponse(res.finalUrl || url, contentType, res.body)) return null;
  const filename = pdfFilenameFromUrl(res.finalUrl || url);
  const extract = options.extractPdf ?? extractPdfMarkdownWithDocling;
  const markdown = await extract({
    url: res.finalUrl || url,
    filename,
    bytes: res.body,
    workspaceId: options.workspaceId,
  });
  return markdown ? buildPdfMarkdownPage(markdown, filename) : null;
}
