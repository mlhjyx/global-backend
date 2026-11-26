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
    workspaceId?: string,
  ): Promise<{ markdown: string }> {
    const run = async (): Promise<{ markdown: string }> => {
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
