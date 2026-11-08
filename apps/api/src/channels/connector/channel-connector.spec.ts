import { describe, expect, it } from 'vitest';
import { parseChannelManifest } from './channel-manifest';
import { ChannelCircuitBreaker } from './circuit-breaker';
import { ManifestChannelConnector } from './channel-connector';
import { ChannelRuntimeError } from './errors';
import type { ChannelHttpClient, ChannelHttpRequest, ChannelHttpResponse } from './http-transport';
import { ChannelSecretUnavailableError, type ChannelSecretResolver } from './secret-resolver';

const SECRET = 'top-secret-key-value';

const resolver: ChannelSecretResolver = {
  async resolve(ref: string) {
    if (ref === 'channel/acme/api-key') return { value: SECRET, version: 3, provider: 'file' };
    throw new ChannelSecretUnavailableError(ref);
  },
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): ChannelHttpResponse {
  return {
    status,
    headers,
    bodyText: JSON.stringify(body),
    finalUrl: 'https://api.example.com/items',
    durationMs: 5,
  };
}

class FakeHttp implements ChannelHttpClient {
  readonly calls: ChannelHttpRequest[] = [];
  constructor(private readonly handler: (request: ChannelHttpRequest, callIndex: number) => Promise<ChannelHttpResponse> | ChannelHttpResponse) {}
  async request(request: ChannelHttpRequest): Promise<ChannelHttpResponse> {
    this.calls.push(request);
    return this.handler(request, this.calls.length - 1);
  }
}

function makeManifest(overrides: Record<string, unknown> = {}) {
  return parseChannelManifest({
    meta: { name: 'Test', version: 1, category: 'directory' },
    transport: { baseUrl: 'https://api.example.com', responseType: 'json', allowedHosts: ['api.example.com'] },
    auth: { type: 'apiKey', secretRef: 'channel/acme/api-key', in: 'header' },
    pagination: { type: 'page', pageParam: 'page', startPage: 1, maxPages: 2 },
    rateLimit: { rps: 50, burst: 2, perDomainDelayMs: 0 },
    records: { itemsPath: '$.items' },
    fieldMapping: { name: '$.name', website: '$.url' },
    transforms: { trim: true, websiteHttps: true },
    ...overrides,
  });
}

function connector(http: ChannelHttpClient, breaker?: ChannelCircuitBreaker) {
  return new ManifestChannelConnector({
    http,
    secrets: resolver,
    ...(breaker ? { breaker } : {}),
    sleep: async () => undefined,
    now: () => Date.parse('2026-11-09T00:00:00Z'),
  });
}

describe('通用 HTTP 连接器运行时', () => {
  it('page 分页跑满两页，认证注入且密钥不出现在结果/计划里', async () => {
    const http = new FakeHttp((_request, index) =>
      jsonResponse({ items: [{ name: index === 0 ? ' Acme GmbH ' : 'Beta', url: 'http://beta.example', email: 'SALES@EXAMPLE.COM' }] }),
    );
    const result = await connector(http).run(makeManifest(), { maxRequests: 10 });
    expect(result.status).toBe('SUCCEEDED');
    expect(result.pagesFetched).toBe(2);
    expect(result.requests).toBe(2);
    expect(result.records).toHaveLength(2);
    expect(result.records[0]!.fields.name).toBe('Acme GmbH');
    expect(result.records[1]!.fields.website).toBe('https://beta.example');
    expect(result.fieldFillRates.name).toBe(1);
    expect(http.calls[0]!.headers.Authorization).toBe(SECRET);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.errorCode).toBeNull();
  });

  it('query 认证参数在 sourceUrl 中脱敏（密钥绝不进样本/落库）', async () => {
    const http = new FakeHttp(() => ({
      status: 200,
      headers: {},
      bodyText: JSON.stringify({ items: [{ name: 'A' }] }),
      finalUrl: `https://api.example.com/items?api_key=${SECRET}&page=1`,
      durationMs: 1,
    }));
    const manifest = makeManifest({
      auth: { type: 'apiKey', secretRef: 'channel/acme/api-key', in: 'query', name: 'api_key' },
      pagination: { type: 'none' },
    });
    const result = await connector(http).run(manifest, { maxRequests: 5 });
    expect(result.records[0]!.sourceUrl).toBe('https://api.example.com/items?page=1');
    expect(JSON.stringify(result)).not.toContain(SECRET);
    // 认证参数确实被注入到实际请求 URL 上（出网仍带密钥）。
    expect(http.calls[0]!.url).toContain(`api_key=${SECRET}`);
  });

  it('offset/cursor 之外的预算截断：maxRequests=1 且多页 → PARTIAL/truncated', async () => {
    const http = new FakeHttp(() => jsonResponse({ items: [{ name: 'A' }] }));
    const result = await connector(http).run(makeManifest(), { maxRequests: 1 });
    expect(result.status).toBe('PARTIAL');
    expect(result.truncated).toBe(true);
    expect(result.pagesFetched).toBe(1);
    expect(result.requests).toBe(1);
  });

  it('401 不可重试：FAILED + CHANNEL_AUTH_INVALID，只发一次请求', async () => {
    const http = new FakeHttp(() => jsonResponse({ error: 'unauthorized' }, 401));
    const result = await connector(http).run(makeManifest(), { maxRequests: 10 });
    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('CHANNEL_AUTH_INVALID');
    expect(result.http4xx).toBe(1);
    expect(result.requests).toBe(1);
  });

  it('429 带 Retry-After 重试后成功', async () => {
    const http = new FakeHttp((_request, index) =>
      index === 0 ? jsonResponse({}, 429, { 'retry-after': '0' }) : jsonResponse({ items: [{ name: 'A' }] }),
    );
    const result = await connector(http).run(makeManifest({ pagination: { type: 'none' } }), { maxRequests: 10 });
    expect(result.status).toBe('SUCCEEDED');
    expect(result.http429).toBe(1);
    expect(result.requests).toBe(2);
  });

  it('5xx 三次尝试耗尽：FAILED + CHANNEL_UPSTREAM_5XX', async () => {
    const http = new FakeHttp(() => jsonResponse({}, 503));
    const result = await connector(http).run(makeManifest(), { maxRequests: 10 });
    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('CHANNEL_UPSTREAM_5XX');
    expect(result.http5xx).toBe(3);
    expect(http.calls).toHaveLength(3);
  });

  it('超时异常按可重试处理，耗尽后 CHANNEL_TIMEOUT', async () => {
    const http = new FakeHttp(() => Promise.reject(new ChannelRuntimeError('CHANNEL_TIMEOUT', 'timeout')));
    const result = await connector(http).run(makeManifest(), { maxRequests: 10 });
    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('CHANNEL_TIMEOUT');
    expect(http.calls).toHaveLength(3);
  });

  it('itemsPath 不是数组 → CHANNEL_SCHEMA_MISMATCH；JSON 坏体 → CHANNEL_PARSE_ERROR', async () => {
    const mismatch = await connector(new FakeHttp(() => jsonResponse({ data: [] }))).run(makeManifest(), { maxRequests: 5 });
    expect(mismatch.status).toBe('FAILED');
    expect(mismatch.errorCode).toBe('CHANNEL_SCHEMA_MISMATCH');
    const badJson = await connector(
      new FakeHttp(() => ({ status: 200, headers: {}, bodyText: '{oops', finalUrl: 'https://api.example.com/x', durationMs: 1 })),
    ).run(makeManifest(), { maxRequests: 5 });
    expect(badJson.errorCode).toBe('CHANNEL_PARSE_ERROR');
  });

  it('预打开的熔断器直接在出网前拒绝（零请求）', async () => {
    const http = new FakeHttp(() => jsonResponse({ items: [] }));
    const now = Date.parse('2026-11-09T00:00:00Z');
    const breaker = new ChannelCircuitBreaker(
      { circuit: 'open', consecutiveFailures: 5, openedUntil: new Date(now + 120_000).toISOString(), lastErrorCode: '500', openMs: 300_000 },
      {},
      () => now,
    );
    const result = await connector(http, breaker).run(makeManifest(), { maxRequests: 5 });
    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('CHANNEL_CIRCUIT_OPEN');
    expect(http.calls).toHaveLength(0);
  });

  it('连续失败打开熔断并出现在 transitions', async () => {
    const now = Date.parse('2026-11-09T00:00:00Z');
    const breaker = new ChannelCircuitBreaker(null, {}, () => now);
    for (let i = 0; i < 4; i += 1) breaker.recordFailure('500');
    const http = new FakeHttp(() => jsonResponse({}, 503));
    const result = await connector(http, breaker).run(makeManifest({ pagination: { type: 'none' } }), { maxRequests: 5 });
    expect(result.transitions).toEqual([expect.objectContaining({ event: 'CIRCUIT_OPEN' })]);
    expect(result.circuitState).toBe('open');
    expect(result.errorCode).toBe('CHANNEL_UPSTREAM_5XX');
  });

  it('密钥缺失 fail-closed：CHANNEL_SECRET_UNAVAILABLE 且零请求', async () => {
    const http = new FakeHttp(() => jsonResponse({ items: [] }));
    const manifest = makeManifest({ auth: { type: 'apiKey', secretRef: 'channel/acme/other', in: 'header' } });
    const result = await connector(http).run(manifest, { maxRequests: 5 });
    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('CHANNEL_SECRET_UNAVAILABLE');
    expect(http.calls).toHaveLength(0);
  });

  it('detail 详情页抽取 v1 不执行 → CHANNEL_DETAIL_UNSUPPORTED', async () => {
    const http = new FakeHttp(() => jsonResponse({ items: [] }));
    const manifest = makeManifest({ records: { itemsPath: '$.items', detail: { enabled: true, urlPath: '$.url' } } });
    const result = await connector(http).run(manifest, { maxRequests: 5 });
    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('CHANNEL_DETAIL_UNSUPPORTED');
    expect(http.calls).toHaveLength(0);
  });
});
