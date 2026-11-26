import { Injectable } from '@nestjs/common';
import { KbIngestError } from './kb-errors';
import {
  positiveIntEnv,
  TenantConcurrencySemaphore,
} from '../runtime/tenant-concurrency-semaphore';

export type EmbeddingsBackendMode = 'local' | 'managed_api';

export function resolveEmbeddingsBackendMode(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingsBackendMode {
  return env.EMBEDDINGS_BACKEND?.trim().toLowerCase() === 'managed_api'
    ? 'managed_api'
    : 'local';
}

function isManagedEmbeddingEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
      return false;
    }
    if (url.protocol === 'https:') return true;
    return (
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]', 'new-api'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

const EMBED_TIMEOUT_MS = 120_000; // CPU 推理留足余量
const DEFAULT_DIM = 1024; // BGE-M3（D14）
export const LOCAL_EMBEDDING_MODEL_ALIAS = 'site-builder-bge-m3-local';

interface EmbeddingsResponse {
  data?: { index?: number; embedding?: number[] }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstNonBlank(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

type LocalEmbeddingEndpointKind = 'gateway' | 'ollama';

function localEmbeddingEndpointKind(baseUrl: string): LocalEmbeddingEndpointKind | undefined {
  try {
    const url = new URL(baseUrl);
    const commonSafeUrl =
      url.protocol === 'http:' &&
      url.pathname.replace(/\/$/, '') === '/v1' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '';
    if (!commonSafeUrl) return undefined;
    if (
      (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.port === '3001') ||
      (url.hostname === 'new-api' && url.port === '3000')
    ) {
      return 'gateway';
    }
    if (
      ['localhost', '127.0.0.1', '[::1]', 'embeddings'].includes(url.hostname) &&
      url.port === '11434'
    ) {
      return 'ollama';
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function requestSignal(external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(EMBED_TIMEOUT_MS);
  return external ? AbortSignal.any([external, timeout]) : timeout;
}

/**
 * 自托管 embedding 客户端（D14：BGE-M3，经统一 New API 的 OpenAI 兼容
 * /embeddings 端点访问；模型仍在本机运行，数据不出域）。
 * 维度硬校验：错维度绝不落库（混向量空间是静默毒药）。
 */
@Injectable()
export class EmbeddingsClient {
  readonly backendMode: EmbeddingsBackendMode = resolveEmbeddingsBackendMode(process.env);
  /** 行级 embed_version：换模型/量化档按版本重嵌，不混空间（02 §12）。 */
  readonly version = process.env.EMBEDDINGS_VERSION ?? 'bge-m3:2026-07';
  readonly dim = Number(process.env.EMBEDDINGS_DIM) || DEFAULT_DIM;
  private readonly baseUrl = (
    firstNonBlank(process.env.EMBEDDINGS_URL, process.env.MODEL_GATEWAY_URL) ??
    'http://localhost:3001/v1'
  ).replace(/\/$/, '');
  private readonly endpointKind = localEmbeddingEndpointKind(this.baseUrl);
  private readonly managedEndpointValid = isManagedEmbeddingEndpoint(this.baseUrl);
  private readonly localBreakGlass =
    this.backendMode === 'local' && this.endpointKind === 'ollama';
  // local 模式固定私有别名（忽略 EMBEDDINGS_MODEL）；仅显式启用 EMBEDDINGS_BACKEND=managed_api
  // 时允许通过 EMBEDDINGS_MODEL 指向 new-api/托管嵌入模型。
  readonly model =
    this.backendMode === 'managed_api'
      ? (firstNonBlank(process.env.EMBEDDINGS_MODEL) ?? LOCAL_EMBEDDING_MODEL_ALIAS)
      : this.localBreakGlass
        ? 'bge-m3'
        : LOCAL_EMBEDDING_MODEL_ALIAS;
  private readonly apiKey =
    this.backendMode === 'managed_api'
      ? firstNonBlank(process.env.EMBEDDINGS_API_KEY, process.env.MODEL_GATEWAY_KEY)
      : firstNonBlank(process.env.EMBEDDINGS_API_KEY);
  private readonly semaphore = new TenantConcurrencySemaphore({
    name: 'embeddings',
    perTenantLimit: positiveIntEnv(process.env, 'EMBEDDINGS_MAX_CONCURRENT_PER_TENANT', 3, 16),
    globalLimit: positiveIntEnv(process.env, 'EMBEDDINGS_MAX_CONCURRENT_GLOBAL', 10, 64),
    acquireTimeoutMs: EMBED_TIMEOUT_MS,
  });

  async embed(
    texts: string[],
    signal?: AbortSignal,
    workspaceId?: string,
  ): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (this.backendMode === 'local') {
      if (!this.endpointKind) {
        throw new KbIngestError(
          'KB_EMBEDDING_CONFIGURATION_INVALID',
          'terminal',
          'embedding',
          'EMBEDDINGS_URL must be the approved local New API or Ollama endpoint',
        );
      }
      if (!this.localBreakGlass && !this.apiKey) {
        throw new KbIngestError(
          'KB_EMBEDDING_CONFIGURATION_INVALID',
          'terminal',
          'embedding',
          'EMBEDDINGS_API_KEY must be a dedicated New API token limited to site-builder-bge-m3-local',
        );
      }
    } else {
      if (!this.managedEndpointValid) {
        throw new KbIngestError(
          'KB_EMBEDDING_CONFIGURATION_INVALID',
          'terminal',
          'embedding',
          'EMBEDDINGS_URL must be a valid https:// or internal new-api endpoint in managed_api mode',
        );
      }
      if (!this.apiKey) {
        throw new KbIngestError(
          'KB_EMBEDDING_CONFIGURATION_INVALID',
          'terminal',
          'embedding',
          'EMBEDDINGS_API_KEY or MODEL_GATEWAY_KEY is required in managed_api mode',
        );
      }
    }
    try {
      return await this.semaphore.withTenantSlot(
        workspaceId,
        async () => {
          let res: Response;
          try {
            if (signal?.aborted) {
              throw signal.reason instanceof Error ? signal.reason : new Error('Aborted');
            }
            res = await fetch(`${this.baseUrl}/embeddings`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
              ...(workspaceId?.trim() ? { 'X-Workspace-Id': workspaceId.trim() } : {}),
            },
            body: JSON.stringify({ model: this.model, input: texts }),
            signal: requestSignal(signal),
          });
        } catch (err) {
          throw new KbIngestError(
            'KB_EMBEDDING_UNAVAILABLE',
            'retryable',
            'embedding',
            `embeddings unavailable: ${err instanceof Error ? err.message : String(err)}`,
            err instanceof Error ? { cause: err } : undefined,
          );
        }
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          const configurationError = res.status === 401 || res.status === 403;
          throw new KbIngestError(
            configurationError
              ? 'KB_EMBEDDING_CONFIGURATION_INVALID'
              : 'KB_EMBEDDING_UNAVAILABLE',
            configurationError ? 'terminal' : 'retryable',
            'embedding',
            `embeddings endpoint ${res.status}: ${body.slice(0, 300)}`,
          );
        }
        let parsed: unknown;
        try {
          parsed = await res.json();
        } catch (err) {
          throw new KbIngestError(
            'KB_EMBEDDING_INVALID_RESPONSE',
            'retryable',
            'embedding',
            'embeddings endpoint returned malformed JSON',
            err instanceof Error ? { cause: err } : undefined,
          );
        }
        if (!isRecord(parsed) || !Array.isArray(parsed.data) || !parsed.data.every(isRecord)) {
          throw new KbIngestError(
            'KB_EMBEDDING_INVALID_RESPONSE',
            'retryable',
            'embedding',
            'embeddings endpoint returned an invalid response shape',
          );
        }
        const data = parsed.data as NonNullable<EmbeddingsResponse['data']>;
        if (data.length !== texts.length) {
          throw new KbIngestError(
            'KB_EMBEDDING_INVALID_RESPONSE',
            'retryable',
            'embedding',
            `embeddings count mismatch: sent ${texts.length}, got ${data.length}`,
          );
        }
        const indexes = new Set<number>();
        for (const row of data) {
          const index = row.index;
          if (
            typeof index !== 'number' ||
            !Number.isInteger(index) ||
            index < 0 ||
            index >= texts.length ||
            indexes.has(index)
          ) {
            throw new KbIngestError(
              'KB_EMBEDDING_INVALID_RESPONSE',
              'retryable',
              'embedding',
              `embeddings indexes must uniquely cover 0..${texts.length - 1}`,
            );
          }
          indexes.add(index);
        }
        const sorted = [...data].sort((a, b) => (a.index as number) - (b.index as number));
        return sorted.map((row, i) => {
          const vec = row.embedding;
          if (!Array.isArray(vec) || vec.length !== this.dim) {
            throw new KbIngestError(
              'KB_EMBEDDING_INVALID_RESPONSE',
              'retryable',
              'embedding',
              `embedding dim mismatch at ${i}: expected ${this.dim}, got ${vec?.length ?? 'none'}`,
            );
          }
          if (!vec.every(Number.isFinite)) {
            throw new KbIngestError(
              'KB_EMBEDDING_INVALID_RESPONSE',
              'retryable',
              'embedding',
              `embedding contains non-finite values at ${i}`,
            );
          }
          return vec;
        });
        },
        signal,
      );
    } catch (err) {
      if (err instanceof KbIngestError) throw err;
      throw new KbIngestError(
        'KB_EMBEDDING_UNAVAILABLE',
        'retryable',
        'embedding',
        `embeddings unavailable: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? { cause: err } : undefined,
      );
    }
  }
}
