import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTenantGatewayHeaders,
  parseTenantGatewayKeyMap,
  resolveTenantGatewayApiKey,
} from './tenant-gateway-routing';
import {
  resolveTenantDailyCostThresholdUsd,
  TenantDailyCostAnomalyError,
  TenantDailyCostBreaker,
  type TenantDailyCostAlertEvent,
} from './tenant-daily-cost-breaker';
import { OpenAICompatibleProvider } from './providers/openai-compatible.provider';
import { ModelProviderRegistry } from './model-provider.registry';
import { ModelRouter } from './model-router';
import { RouterModelGateway } from './router-model-gateway';
import { TenantConcurrencySemaphore } from '../runtime/tenant-concurrency-semaphore';
import { crawlUrl } from '../adapters/web-crawler';
import { searxSearch } from '../adapters/searxng';
import { DoclingClient } from '../site-builder/docling.client';
import { EmbeddingsClient } from '../site-builder/embeddings.client';

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('M10-PR2 Block 3: global-new-api tenant attribution, daily cost breaker, and client semaphores', () => {
  it('routes X-Workspace-Id and optional per-tenant sub-keys on OpenAI and Anthropic requests', async () => {
    const keyMap = parseTenantGatewayKeyMap(JSON.stringify({ [WS_A]: 'sk-tenant-a-subkey' }));
    expect(resolveTenantGatewayApiKey('sk-default', keyMap, WS_A)).toBe('sk-tenant-a-subkey');
    expect(resolveTenantGatewayApiKey('sk-default', keyMap, WS_B)).toBe('sk-default');
    expect(() => parseTenantGatewayKeyMap('{invalid')).toThrow('MODEL_GATEWAY_TENANT_KEYS_JSON_INVALID');
    expect(() => parseTenantGatewayKeyMap(JSON.stringify({ [WS_A]: 'bad\nkey' }))).toThrow(
      'MODEL_GATEWAY_TENANT_KEY_TOKEN_INVALID',
    );

    expect(
      buildTenantGatewayHeaders({
        defaultApiKey: 'sk-default',
        tenantKeys: keyMap,
        workspaceId: WS_A,
        authHeader: 'x-api-key',
        extra: { 'anthropic-version': '2023-06-01' },
      }),
    ).toEqual({
      'Content-Type': 'application/json',
      'x-api-key': 'sk-tenant-a-subkey',
      'anthropic-version': '2023-06-01',
      'X-Workspace-Id': WS_A,
    });

    const capturedHeaders: Record<string, string>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init?: RequestInit) => {
        capturedHeaders.push(init?.headers as Record<string, string>);
        return new Response(
          JSON.stringify({
            model: 'deepseek-v4-flash',
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const provider = new OpenAICompatibleProvider({
      id: 'gateway',
      baseUrl: 'http://new-api:3000/v1',
      apiKey: 'sk-default',
      tenantApiKeys: keyMap,
      model: 'deepseek-v4-flash',
    });

    await provider.generateText(
      { task: 'company_understanding.extract_claims', prompt: 'hi' },
      { workspaceId: WS_A },
    );
    await provider.generateText(
      { task: 'company_understanding.extract_claims', prompt: 'hi' },
      { workspaceId: WS_B },
    );

    expect(capturedHeaders[0]).toMatchObject({
      Authorization: 'Bearer sk-tenant-a-subkey',
      'X-Workspace-Id': WS_A,
    });
    expect(capturedHeaders[1]).toMatchObject({
      Authorization: 'Bearer sk-default',
      'X-Workspace-Id': WS_B,
    });
  });

  it('trips per-tenant daily USD anomaly breaker, emits alert once per UTC day, and blocks RouterModelGateway before dispatch', async () => {
    expect(resolveTenantDailyCostThresholdUsd({ TENANT_DAILY_COST_ANOMALY_USD: 'off' })).toBeNull();
    expect(resolveTenantDailyCostThresholdUsd({ TENANT_DAILY_COST_ANOMALY_USD: '12.5' })).toBe(12.5);

    const spendByWorkspace = new Map<string, number>([
      [WS_A, 10.5],
      [WS_B, 1.0],
    ]);
    const alerts: TenantDailyCostAlertEvent[] = [];
    const breaker = new TenantDailyCostBreaker({
      reader: {
        readDailySpendUsd: async (ws) => spendByWorkspace.get(ws) ?? 0,
      },
      thresholdUsd: 10,
      cacheTtlMs: 60_000,
      onAlert: (ev) => {
        alerts.push(ev);
      },
    });

    await expect(breaker.assertAllowed(WS_A, 'discovery.judge')).rejects.toBeInstanceOf(
      TenantDailyCostAnomalyError,
    );
    await expect(breaker.assertAllowed(WS_A, 'discovery.judge')).rejects.toBeInstanceOf(
      TenantDailyCostAnomalyError,
    );
    // Alert emitted once per workspace per UTC day
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      eventType: 'TenantDailyCostAnomalyTripped',
      workspaceId: WS_A,
      dailySpendUsd: 10.5,
      thresholdUsd: 10,
    });

    // Neighbor WS_B is unaffected until observed spend crosses threshold
    await expect(breaker.assertAllowed(WS_B, 'discovery.judge')).resolves.toBeUndefined();
    breaker.recordObservedSpend(WS_B, 9.5);
    await expect(breaker.assertAllowed(WS_B, 'discovery.judge')).rejects.toBeInstanceOf(
      TenantDailyCostAnomalyError,
    );

    // Wired into RouterModelGateway: blocks before provider call
    const generateText = vi.fn();
    const registry = new ModelProviderRegistry();
    registry.register({
      id: 'mock',
      supports: () => true,
      health: async () => ({ ok: true, latencyMs: 1 }),
      generateText,
      generateStructured: vi.fn(),
      reviewVision: vi.fn(),
      embed: vi.fn(),
    });
    const gateway = new RouterModelGateway(
      new ModelRouter(registry),
      undefined,
      undefined,
      breaker,
    );
    gateway.legacyBudgetMode = 'bypass';
    await expect(
      gateway.generateText(
        { task: 'company_understanding.extract_claims', prompt: 'test' },
        { workspaceId: WS_A },
      ),
    ).rejects.toBeInstanceOf(TenantDailyCostAnomalyError);
    expect(generateText).not.toHaveBeenCalled();
  });

  it('enforces per-tenant concurrency semaphores on crawl4ai and searxng without starving neighbors', async () => {
    const crawlSem = new TenantConcurrencySemaphore({
      name: 'crawl4ai-test',
      perTenantLimit: 1,
      globalLimit: 4,
    });
    let releaseA1!: () => void;
    let a1Entered!: () => void;
    const a1Gate = new Promise<void>((r) => {
      a1Entered = r;
    });
    let callIdx = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const myIdx = ++callIdx;
        if (myIdx === 1) {
          a1Entered();
          await new Promise<void>((r) => {
            releaseA1 = r;
          });
        }
        return new Response(JSON.stringify({ markdown: `page-${myIdx}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    const resolveUrl = async (raw: string) => ({ url: new URL(raw), address: '93.184.216.34' });
    const a1 = crawlUrl('https://a1.example/', undefined, resolveUrl, undefined, undefined, WS_A, crawlSem);
    await a1Gate;

    let a2Done = false;
    const a2 = crawlUrl('https://a2.example/', undefined, resolveUrl, undefined, undefined, WS_A, crawlSem).then((r) => {
      a2Done = true;
      return r;
    });
    // WS_B finishes immediately while WS_A's 2nd crawl waits for slot 1
    const b1 = await crawlUrl('https://b1.example/', undefined, resolveUrl, undefined, undefined, WS_B, crawlSem);
    expect(b1.text).toBe('page-2');
    expect(a2Done).toBe(false);

    releaseA1();
    expect((await a1).text).toBe('page-1');
    expect((await a2).text).toBe('page-3');

    // SearXNG semaphore also isolates tenants
    const searxSem = new TenantConcurrencySemaphore({
      name: 'searx-test',
      perTenantLimit: 1,
      globalLimit: 2,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ results: [{ url: 'https://r.example', title: 'R' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const res = await searxSearch({ q: 'pumps' }, 5_000, WS_A, searxSem);
    expect(res.results).toHaveLength(1);
  });

  it('supports optional managed_api switch for DoclingClient and EmbeddingsClient while forwarding X-Workspace-Id', async () => {
    vi.stubEnv('DOCLING_BACKEND', 'managed_api');
    vi.stubEnv('DOCLING_MANAGED_URL', 'https://docling-managed.example/api');
    vi.stubEnv('DOCLING_API_KEY', 'sk-docling-managed');
    vi.stubEnv('EMBEDDINGS_BACKEND', 'managed_api');
    vi.stubEnv('EMBEDDINGS_URL', 'https://gateway.example/v1');
    vi.stubEnv('EMBEDDINGS_API_KEY', 'sk-embed-managed');
    vi.stubEnv('EMBEDDINGS_MODEL', 'text-embedding-3-large');
    vi.stubEnv('EMBEDDINGS_DIM', '3');

    const fetchMock = vi.fn(async (url: string | URL) => {
      const target = String(url);
      if (target.includes('/v1/convert/source')) {
        return new Response(JSON.stringify({ document: { md_content: '# Parsed' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const docling = new DoclingClient();
    expect(docling.backendMode).toBe('managed_api');
    const converted = await docling.convertToMarkdown('spec.pdf', Buffer.from('pdf'), undefined, WS_A);
    expect(converted.markdown).toBe('# Parsed');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://docling-managed.example/api/v1/convert/source');
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      authorization: 'Bearer sk-docling-managed',
      'X-Workspace-Id': WS_A,
    });

    const embeddings = new EmbeddingsClient();
    expect(embeddings.backendMode).toBe('managed_api');
    expect(embeddings.model).toBe('text-embedding-3-large');
    const vectors = await embeddings.embed(['hello'], undefined, WS_B);
    expect(vectors).toEqual([[0.1, 0.2, 0.3]]);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://gateway.example/v1/embeddings');
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).toMatchObject({
      authorization: 'Bearer sk-embed-managed',
      'X-Workspace-Id': WS_B,
    });
  });
});
