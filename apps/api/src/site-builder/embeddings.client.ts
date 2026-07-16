import { Injectable } from '@nestjs/common';
import { KbIngestError } from './kb-errors';

const EMBED_TIMEOUT_MS = 120_000; // CPU 推理留足余量
const DEFAULT_DIM = 1024; // BGE-M3（D14）

interface EmbeddingsResponse {
  data?: { index?: number; embedding?: number[] }[];
}

/**
 * 自托管 embedding 客户端（D14：BGE-M3，OpenAI 兼容 /embeddings 端点，数据不出域）。
 * 维度硬校验：错维度绝不落库（混向量空间是静默毒药）。
 */
@Injectable()
export class EmbeddingsClient {
  readonly model = process.env.EMBEDDINGS_MODEL ?? 'bge-m3';
  /** 行级 embed_version：换模型/量化档按版本重嵌，不混空间（02 §12）。 */
  readonly version = process.env.EMBEDDINGS_VERSION ?? 'bge-m3:2026-07';
  readonly dim = Number(process.env.EMBEDDINGS_DIM) || DEFAULT_DIM;
  private readonly baseUrl = (process.env.EMBEDDINGS_URL ?? 'http://localhost:11434/v1').replace(
    /\/$/,
    '',
  );

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
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
      throw new KbIngestError(
        'KB_EMBEDDING_UNAVAILABLE',
        'retryable',
        'embedding',
        `embeddings endpoint ${res.status}: ${body.slice(0, 300)}`,
      );
    }
    let json: EmbeddingsResponse;
    try {
      json = (await res.json()) as EmbeddingsResponse;
    } catch (err) {
      throw new KbIngestError(
        'KB_EMBEDDING_INVALID_RESPONSE',
        'retryable',
        'embedding',
        'embeddings endpoint returned malformed JSON',
        err instanceof Error ? { cause: err } : undefined,
      );
    }
    const data = json.data ?? [];
    if (data.length !== texts.length) {
      throw new KbIngestError(
        'KB_EMBEDDING_INVALID_RESPONSE',
        'retryable',
        'embedding',
        `embeddings count mismatch: sent ${texts.length}, got ${data.length}`,
      );
    }
    const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
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
      // 有限性守卫（复审 LOW）：NaN/Infinity 会在 ::vector cast 处炸出难读错误，前移
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
  }
}
