import { Injectable } from '@nestjs/common';
import { KbIngestError } from './kb-errors';

const CONVERT_TIMEOUT_MS = 300_000; // 首次调用会下载布局模型，放宽

interface DoclingResponse {
  document?: { md_content?: string };
  status?: string;
  errors?: unknown[];
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
  private readonly baseUrl = (process.env.DOCLING_URL ?? 'http://localhost:5001').replace(
    /\/$/,
    '',
  );

  async convertToMarkdown(
    filename: string,
    data: Buffer,
    signal?: AbortSignal,
  ): Promise<{ markdown: string }> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/convert/source`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          options: { to_formats: ['md'] },
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
    const markdown = json.document?.md_content;
    if (typeof markdown !== 'string' || markdown.length === 0) {
      const invalidInput = hasDocumentInputFailure(parsed);
      throw new KbIngestError(
        invalidInput ? 'KB_DOCUMENT_INVALID' : 'KB_DOCLING_UNAVAILABLE',
        invalidInput ? 'terminal' : 'retryable',
        'parse',
        `docling returned no markdown (status=${json.status ?? 'unknown'})`,
      );
    }
    return { markdown };
  }
}
