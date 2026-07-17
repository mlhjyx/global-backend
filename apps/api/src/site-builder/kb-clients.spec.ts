import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DoclingClient } from './docling.client';
import { EmbeddingsClient } from './embeddings.client';
import { KbIngestError } from './kb-errors';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('R2-A2 typed KB dependency errors', () => {
  beforeEach(() => {
    vi.stubEnv('EMBEDDINGS_API_KEY', 'embedding-test-token');
  });

  it('embedding 默认复用统一 New API 地址，但只使用专用 Bearer token 和本机别名', async () => {
    vi.stubEnv('MODEL_GATEWAY_URL', 'http://new-api.internal:3000/v1');
    vi.stubEnv('MODEL_GATEWAY_KEY', 'gateway-test-token');
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ index: 0, embedding: Array(1024).fill(0.1) }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(new EmbeddingsClient().embed(['hello'])).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://new-api.internal:3000/v1/embeddings',
      expect.objectContaining({
        headers: {
          authorization: 'Bearer embedding-test-token',
          'content-type': 'application/json',
        },
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toMatchObject({
      model: 'site-builder-bge-m3-local',
    });
  });

  it('embedding 专用地址和 Key 可显式覆盖统一网关配置', async () => {
    vi.stubEnv('MODEL_GATEWAY_URL', 'http://new-api.internal:3000/v1');
    vi.stubEnv('MODEL_GATEWAY_KEY', 'gateway-test-token');
    vi.stubEnv('EMBEDDINGS_URL', 'http://embedding-proxy.internal/v1/');
    vi.stubEnv('EMBEDDINGS_API_KEY', 'embedding-test-token');
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ index: 0, embedding: Array(1024).fill(0.1) }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(new EmbeddingsClient().embed(['hello'])).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://embedding-proxy.internal/v1/embeddings',
      expect.objectContaining({
        headers: {
          authorization: 'Bearer embedding-test-token',
          'content-type': 'application/json',
        },
      }),
    );
  });

  it('embedding 专用 Key 为空时 fail-closed，不把 KB 内容交给通用网关 token', async () => {
    vi.stubEnv('MODEL_GATEWAY_URL', 'http://new-api.internal:3000/v1');
    vi.stubEnv('MODEL_GATEWAY_KEY', 'gateway-test-token');
    vi.stubEnv('EMBEDDINGS_API_KEY', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(new EmbeddingsClient().embed(['raw tenant KB'])).rejects.toMatchObject({
      code: 'KB_EMBEDDING_CONFIGURATION_INVALID',
      disposition: 'terminal',
      stage: 'embedding',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('embedding 忽略任意模型覆盖，始终请求本机专用别名', async () => {
    vi.stubEnv('EMBEDDINGS_MODEL', 'bge-m3');
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ index: 0, embedding: Array(1024).fill(0.1) }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new EmbeddingsClient().embed(['hello']);

    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toMatchObject({
      model: 'site-builder-bge-m3-local',
    });
  });

  it('break-glass 只允许精确本机 Ollama 地址，无 token 时使用上游 bge-m3', async () => {
    vi.stubEnv('EMBEDDINGS_URL', 'http://127.0.0.1:11434/v1');
    vi.stubEnv('EMBEDDINGS_API_KEY', '');
    vi.stubEnv('EMBEDDINGS_MODEL', 'remote-model-must-be-ignored');
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ index: 0, embedding: Array(1024).fill(0.1) }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new EmbeddingsClient().embed(['break glass']);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/v1/embeddings',
      expect.objectContaining({ headers: { 'content-type': 'application/json' } }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toMatchObject({
      model: 'bge-m3',
    });
  });

  it('非 allowlist 的直连地址即使叫 Ollama 也必须有专用 token', async () => {
    vi.stubEnv('EMBEDDINGS_URL', 'http://ollama.remote.example:11434/v1');
    vi.stubEnv('EMBEDDINGS_API_KEY', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(new EmbeddingsClient().embed(['must not leave host'])).rejects.toMatchObject({
      code: 'KB_EMBEDDING_CONFIGURATION_INVALID',
      disposition: 'terminal',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Docling 泛 400 不足以证明文档损坏，按 dependency retryable 处理', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('gateway rejected request', { status: 400 })),
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

  it('Docling 结构化 user_input 格式错误可证明文档损坏，分类为 terminal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: 'failure',
              errors: [{ component_type: 'user_input', error_message: 'Data format error' }],
            }),
            {
            status: 200,
            headers: { 'content-type': 'application/json' },
            },
          ),
      ),
    );

    const error = await new DoclingClient()
      .convertToMarkdown('bad.pdf', Buffer.from('bad'))
      .catch((err) => err);

    expect(error).toMatchObject({
      code: 'KB_DOCUMENT_INVALID',
      disposition: 'terminal',
      stage: 'parse',
    });
  });

  it('Docling 422 可能是请求 schema 漂移，不能仅凭状态码永久终结文档', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('any body', { status: 422 })),
    );

    const error = await new DoclingClient()
      .convertToMarkdown('bad.pdf', Buffer.from('bad'))
      .catch((err) => err);

    expect(error).toBeInstanceOf(KbIngestError);
    expect(error).toMatchObject({
      code: 'KB_DOCLING_UNAVAILABLE',
      disposition: 'retryable',
      stage: 'parse',
    });
  });

  it('Docling 200 内部失败且无 markdown 时仍是 dependency retryable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: 'failure',
              errors: [{ component_type: 'backend', error_message: 'inference timeout' }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
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

  it.each([
    ['重复 index', [0, 0]],
    ['越界且缺失 index', [0, 2]],
    ['非整数 index', [0, 1.5]],
  ])('embedding 拒绝%s，不能把向量静默映射到错误文本', async (_label, indexes) => {
    vi.stubEnv('EMBEDDINGS_DIM', '2');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: indexes.map((index) => ({ index, embedding: [index, index] })),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    const error = await new EmbeddingsClient().embed(['first', 'second']).catch((err) => err);

    expect(error).toMatchObject({
      code: 'KB_EMBEDDING_INVALID_RESPONSE',
      disposition: 'retryable',
      stage: 'embedding',
    });
  });

  it.each([
    ['Docling null 根响应', 'docling', null],
    ['embedding null 根响应', 'embedding', null],
    ['embedding null row', 'embedding', { data: [null] }],
  ])('%s 统一产生 typed dependency error，而不是原生 TypeError', async (_label, kind, body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    const error =
      kind === 'docling'
        ? await new DoclingClient()
            .convertToMarkdown('catalog.pdf', Buffer.from('pdf'))
            .catch((err) => err)
        : await new EmbeddingsClient().embed(['text']).catch((err) => err);

    expect(error).toBeInstanceOf(KbIngestError);
    expect(error).toMatchObject({ disposition: 'retryable' });
  });

  it('外部取消信号会实际中止 Docling fetch，并保持 retryable typed error', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      ),
    );

    const pending = new DoclingClient()
      .convertToMarkdown('catalog.pdf', Buffer.from('pdf'), controller.signal)
      .catch((err) => err);
    controller.abort(new Error('temporal activity cancelled'));

    await expect(pending).resolves.toMatchObject({
      code: 'KB_DOCLING_UNAVAILABLE',
      disposition: 'retryable',
      stage: 'parse',
    });
  });
});
