import { Injectable } from '@nestjs/common';
import { KbIngestError } from './kb-errors';

const CONVERT_TIMEOUT_MS = 300_000; // 首次调用会下载布局模型，放宽

interface DoclingResponse {
  document?: { md_content?: string };
  status?: string;
  errors?: unknown[];
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

  async convertToMarkdown(filename: string, data: Buffer): Promise<{ markdown: string }> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/convert/source`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          options: { to_formats: ['md'] },
          sources: [{ kind: 'file', base64_string: data.toString('base64'), filename }],
        }),
        signal: AbortSignal.timeout(CONVERT_TIMEOUT_MS),
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
      const invalidInput = [400, 415, 422].includes(res.status);
      throw new KbIngestError(
        invalidInput ? 'KB_DOCUMENT_INVALID' : 'KB_DOCLING_UNAVAILABLE',
        invalidInput ? 'terminal' : 'retryable',
        'parse',
        `docling convert ${res.status}: ${body.slice(0, 300)}`,
      );
    }
    let json: DoclingResponse;
    try {
      json = (await res.json()) as DoclingResponse;
    } catch (err) {
      throw new KbIngestError(
        'KB_DOCLING_UNAVAILABLE',
        'retryable',
        'parse',
        'docling returned malformed JSON',
        err instanceof Error ? { cause: err } : undefined,
      );
    }
    const markdown = json.document?.md_content;
    if (typeof markdown !== 'string' || markdown.length === 0) {
      throw new KbIngestError(
        'KB_DOCUMENT_INVALID',
        'terminal',
        'parse',
        `docling returned no markdown (status=${json.status ?? 'unknown'})`,
      );
    }
    return { markdown };
  }
}
