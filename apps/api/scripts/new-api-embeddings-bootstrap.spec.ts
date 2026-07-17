import { describe, expect, it, vi } from 'vitest';
import {
  LOCAL_EMBEDDING_CHANNEL_NAME,
  LOCAL_EMBEDDING_MODEL_ALIAS,
  mergeEmbeddingEnv,
  provisionLocalEmbeddingGateway,
} from '../src/site-builder/new-api-embeddings-bootstrap';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('New API local embedding bootstrap', () => {
  it('只更新 embedding 配置并保留通用网关配置', () => {
    const output = mergeEmbeddingEnv(
      [
        'MODEL_GATEWAY_KEY=general-secret',
        'EMBEDDINGS_URL=http://localhost:11434/v1',
        'EMBEDDINGS_MODEL=bge-m3',
        'EMBEDDINGS_DIM=1024',
      ].join('\n'),
      { apiKey: 'sk-dedicated-secret' },
      'http://localhost:3001/v1',
    );

    expect(output).toContain('MODEL_GATEWAY_KEY=general-secret');
    expect(output).toContain('EMBEDDINGS_URL=http://localhost:3001/v1');
    expect(output).toContain('EMBEDDINGS_API_KEY=sk-dedicated-secret');
    expect(output).toContain(`EMBEDDINGS_MODEL=${LOCAL_EMBEDDING_MODEL_ALIAS}`);
    expect(output).not.toContain('EMBEDDINGS_MODEL=bge-m3\n');
  });

  it('幂等创建本机别名通道、模型受限令牌，并完成真 endpoint 形状检查', async () => {
    const channels: Record<string, unknown>[] = [];
    const tokens: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/channel/?')) {
        return json({ success: true, data: { items: channels, total: channels.length } });
      }
      if (url.endsWith('/api/channel/') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        channels.push({ id: 7, status: 1, ...body.channel });
        return json({ success: true });
      }
      if (url.includes('/api/token/?')) {
        return json({ success: true, data: { items: tokens, total: tokens.length } });
      }
      if (url.endsWith('/api/token/') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        tokens.push({ id: 2, status: 1, ...body });
        return json({ success: true });
      }
      if (url.endsWith('/api/token/2/key') && init?.method === 'POST') {
        return json({ success: true, data: { key: 'dedicated-secret' } });
      }
      if (url.endsWith('/v1/models')) {
        return json({
          object: 'list',
          data: [{ id: LOCAL_EMBEDDING_MODEL_ALIAS, object: 'model' }],
        });
      }
      if (url.endsWith('/v1/embeddings')) {
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe(LOCAL_EMBEDDING_MODEL_ALIAS);
        return json({ data: [{ index: 0, embedding: Array(1024).fill(0.1) }] });
      }
      throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
    });

    const result = await provisionLocalEmbeddingGateway(
      {
        adminBaseUrl: 'http://new-api:3000',
        adminAccessToken: 'admin-secret',
        adminUserId: 1,
      },
      fetchMock,
    );

    expect(result).toMatchObject({
      channelId: 7,
      tokenId: 2,
      apiKey: 'sk-dedicated-secret',
      createdChannel: true,
      createdToken: true,
      vectorDimension: 1024,
    });
    expect(channels[0]).toMatchObject({
      name: LOCAL_EMBEDDING_CHANNEL_NAME,
      base_url: 'http://embeddings:11434',
      models: LOCAL_EMBEDDING_MODEL_ALIAS,
      model_mapping: JSON.stringify({ [LOCAL_EMBEDDING_MODEL_ALIAS]: 'bge-m3' }),
    });
    expect(tokens[0]).toMatchObject({
      model_limits_enabled: true,
      model_limits: LOCAL_EMBEDDING_MODEL_ALIAS,
      cross_group_retry: false,
    });
  });

  it('发现第二条同别名或远程上游时失败关闭，不静默挑一路', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/channel/?')) {
        return json({
          success: true,
          data: {
            total: 2,
            items: [
              {
                id: 7,
                name: LOCAL_EMBEDDING_CHANNEL_NAME,
                status: 1,
                type: 1,
                base_url: 'http://embeddings:11434',
                models: LOCAL_EMBEDDING_MODEL_ALIAS,
                group: 'default',
                model_mapping: JSON.stringify({ [LOCAL_EMBEDDING_MODEL_ALIAS]: 'bge-m3' }),
              },
              {
                id: 8,
                name: 'remote collision',
                status: 1,
                type: 1,
                base_url: 'https://remote.example',
                models: LOCAL_EMBEDDING_MODEL_ALIAS,
                group: 'default',
                model_mapping: '',
              },
            ],
          },
        });
      }
      throw new Error(`unexpected request ${url}`);
    });

    await expect(
      provisionLocalEmbeddingGateway(
        {
          adminBaseUrl: 'http://new-api:3000',
          adminAccessToken: 'admin-secret',
          adminUserId: 1,
        },
        fetchMock,
      ),
    ).rejects.toThrow(/exactly one local channel/i);
  });

  it('专用令牌若还能看到其他模型则拒绝就绪', async () => {
    const channel = {
      id: 7,
      name: LOCAL_EMBEDDING_CHANNEL_NAME,
      status: 1,
      type: 1,
      base_url: 'http://embeddings:11434',
      models: LOCAL_EMBEDDING_MODEL_ALIAS,
      group: 'default',
      model_mapping: JSON.stringify({ [LOCAL_EMBEDDING_MODEL_ALIAS]: 'bge-m3' }),
    };
    const token = {
      id: 2,
      name: 'Site Builder Local Embeddings',
      status: 1,
      expired_time: -1,
      unlimited_quota: true,
      model_limits_enabled: true,
      model_limits: LOCAL_EMBEDDING_MODEL_ALIAS,
      group: '',
      cross_group_retry: false,
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/channel/?')) {
        return json({ success: true, data: { items: [channel], total: 1 } });
      }
      if (url.includes('/api/token/?')) {
        return json({ success: true, data: { items: [token], total: 1 } });
      }
      if (url.endsWith('/api/token/2/key')) {
        return json({ success: true, data: { key: 'dedicated-secret' } });
      }
      if (url.endsWith('/v1/models')) {
        return json({
          data: [{ id: LOCAL_EMBEDDING_MODEL_ALIAS }, { id: 'gpt-5.6-terra' }],
        });
      }
      throw new Error(`unexpected request ${url}`);
    });

    await expect(
      provisionLocalEmbeddingGateway(
        {
          adminBaseUrl: 'http://new-api:3000',
          adminAccessToken: 'admin-secret',
          adminUserId: 1,
        },
        fetchMock,
      ),
    ).rejects.toThrow(/must expose only/i);
  });
});
