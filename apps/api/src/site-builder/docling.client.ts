import { Injectable } from '@nestjs/common';

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
    const res = await fetch(`${this.baseUrl}/v1/convert/source`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        options: { to_formats: ['md'] },
        sources: [{ kind: 'file', base64_string: data.toString('base64'), filename }],
      }),
      signal: AbortSignal.timeout(CONVERT_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`docling convert ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as DoclingResponse;
    const markdown = json.document?.md_content;
    if (typeof markdown !== 'string' || markdown.length === 0) {
      throw new Error(`docling returned no markdown (status=${json.status ?? 'unknown'})`);
    }
    return { markdown };
  }
}
