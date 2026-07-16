import { afterEach, describe, expect, it, vi } from 'vitest';
import { DoclingClient } from './docling.client';
import { EmbeddingsClient } from './embeddings.client';
import { KbIngestError } from './kb-errors';

afterEach(() => vi.unstubAllGlobals());

describe('R2-A2 typed KB dependency errors', () => {
  it('Docling 422 明确分类为文档 terminal，不解析错误文本', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('any body', { status: 422 })),
    );

    const error = await new DoclingClient()
      .convertToMarkdown('bad.pdf', Buffer.from('bad'))
      .catch((err) => err);

    expect(error).toBeInstanceOf(KbIngestError);
    expect(error).toMatchObject({
      code: 'KB_DOCUMENT_INVALID',
      disposition: 'terminal',
      stage: 'parse',
    });
  });

  it('Docling 503 明确分类为 dependency retryable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('different wording', { status: 503 })),
    );

    const error = await new DoclingClient()
      .convertToMarkdown('catalog.pdf', Buffer.from('pdf'))
      .catch((err) => err);

    expect(error).toMatchObject({
      code: 'KB_DOCLING_UNAVAILABLE',
      disposition: 'retryable',
      stage: 'parse',
    });
  });

  it('embedding 错维度是 typed invalid response，仍可重试而非终结文档', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1] }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    const error = await new EmbeddingsClient().embed(['hello']).catch((err) => err);

    expect(error).toMatchObject({
      code: 'KB_EMBEDDING_INVALID_RESPONSE',
      disposition: 'retryable',
      stage: 'embedding',
    });
  });
});
