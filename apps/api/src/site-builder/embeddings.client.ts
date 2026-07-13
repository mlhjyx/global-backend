import { Injectable } from '@nestjs/common';

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
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`embeddings endpoint ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as EmbeddingsResponse;
    const data = json.data ?? [];
    if (data.length !== texts.length) {
      throw new Error(`embeddings count mismatch: sent ${texts.length}, got ${data.length}`);
    }
    const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return sorted.map((row, i) => {
      const vec = row.embedding;
      if (!Array.isArray(vec) || vec.length !== this.dim) {
        throw new Error(
          `embedding dim mismatch at ${i}: expected ${this.dim}, got ${vec?.length ?? 'none'}`,
        );
      }
      return vec;
    });
  }
}
