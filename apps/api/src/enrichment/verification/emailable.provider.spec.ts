import { describe, expect, it, vi } from 'vitest';
import { EmailableProvider, mapEmailableResponse, resolveEmailableConfig } from './emailable.provider';

/**
 * P1-04：Emailable（第二票）适配器契约——假 HTTP fixture，零真实出网。
 */
describe('resolveEmailableConfig：env 解析', () => {
  it('缺省值：无 key、官方 baseUrl、8s、$0.0076/条（7600 微美元）', () => {
    expect(resolveEmailableConfig({})).toEqual({
      apiKey: null,
      baseUrl: 'https://api.emailable.com',
      timeoutMs: 8_000,
      costMicrousd: 7_600,
    });
  });

  it('非法 env 回退默认；空白 key 归一为 null', () => {
    expect(
      resolveEmailableConfig({
        EMAILABLE_API_KEY: '  ',
        EMAILABLE_TIMEOUT_MS: 'abc',
        EMAILABLE_COST_MICROUSD: '0',
        EMAILABLE_BASE_URL: 'https://em.example/',
      }),
    ).toEqual({ apiKey: null, baseUrl: 'https://em.example', timeoutMs: 8_000, costMicrousd: 7_600 });
  });
});

describe('mapEmailableResponse：供应商 state → 四态', () => {
  it('deliverable（accept_all=false）→ VALID；accept_all=true → CATCH_ALL_RISKY·true_catch_all；缺字段 → inconclusive', () => {
    expect(mapEmailableResponse({ state: 'deliverable', accept_all: false, score: 99 })).toMatchObject({
      state: 'VALID',
      catchAll: 'not_catch_all',
      providerScore: 99,
    });
    expect(mapEmailableResponse({ state: 'deliverable', accept_all: true })).toMatchObject({
      state: 'CATCH_ALL_RISKY',
      catchAllClass: 'true_catch_all',
    });
    expect(mapEmailableResponse({ state: 'deliverable' })).toMatchObject({
      state: 'CATCH_ALL_RISKY',
      catchAllClass: 'inconclusive',
    });
  });

  it('undeliverable / disposable → INVALID', () => {
    expect(mapEmailableResponse({ state: 'undeliverable', reason: 'rejected_email' })).toMatchObject({
      state: 'INVALID',
      detail: 'undeliverable:rejected_email',
    });
    expect(mapEmailableResponse({ state: 'disposable' })).toMatchObject({ state: 'INVALID' });
  });

  it('risky：accept_all=true → CATCH_ALL_RISKY；否则 UNKNOWN（不是地址级证据）', () => {
    expect(mapEmailableResponse({ state: 'risky', accept_all: true })).toMatchObject({
      state: 'CATCH_ALL_RISKY',
      catchAllClass: 'true_catch_all',
    });
    expect(mapEmailableResponse({ state: 'risky', accept_all: false })).toMatchObject({
      state: 'UNKNOWN',
      error: null,
    });
  });

  it('unknown → UNKNOWN（有效裁决、error=null）；畸形/未识别/未成功 → UNKNOWN + error', () => {
    expect(mapEmailableResponse({ state: 'unknown' })).toMatchObject({ state: 'UNKNOWN', error: null });
    expect(mapEmailableResponse(null)).toMatchObject({ error: 'malformed_response' });
    expect(mapEmailableResponse({ state: 'weird' })).toMatchObject({ error: 'unrecognized_state:weird' });
    expect(mapEmailableResponse({ success: false, message: 'bad key' })).toMatchObject({
      state: 'UNKNOWN',
      error: 'bad key',
    });
  });
});

describe('EmailableProvider：HTTP 契约（fixture）', () => {
  const config = { apiKey: 'em-key', baseUrl: 'https://em.example', timeoutMs: 5_000, costMicrousd: 7_600 };
  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('缺凭据：不调用 fetch，降级 UNKNOWN(provider_unconfigured)', async () => {
    const fetchImpl = vi.fn();
    const provider = new EmailableProvider({ ...config, apiKey: null }, fetchImpl as unknown as typeof fetch);
    await expect(provider.verify({ email: 'a@b.example' })).resolves.toMatchObject({
      state: 'UNKNOWN',
      error: 'provider_unconfigured',
      costMicrousd: 0,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('200 deliverable：VALID、计费 7600、请求带 email/api_key 与 abort signal', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ state: 'deliverable', accept_all: false, score: 98 }));
    const provider = new EmailableProvider(config, fetchImpl as unknown as typeof fetch);
    const result = await provider.verify({ email: 'Info+tag@Acme.example' });
    expect(result).toMatchObject({ providerKey: 'emailable', state: 'VALID', score: 95, costMicrousd: 7_600, error: null });
    expect(result.detail).toContain('score=98');
    const requestUrl = fetchImpl.mock.calls[0]?.[0] as URL;
    expect(String(requestUrl)).toContain('email=Info%2Btag%40Acme.example');
    expect(String(requestUrl)).toContain('api_key=em-key');
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('200 unknown：有效裁决按次计费（error=null）', async () => {
    const provider = new EmailableProvider(
      config,
      vi.fn(async () => jsonResponse({ state: 'unknown' })) as unknown as typeof fetch,
    );
    await expect(provider.verify({ email: 'a@b.example' })).resolves.toMatchObject({
      state: 'UNKNOWN',
      error: null,
      costMicrousd: 7_600,
    });
  });

  it('429/5xx/超时/畸形体 → UNKNOWN 且不计费，不抛', async () => {
    const rate = new EmailableProvider(config, vi.fn(async () => jsonResponse({}, 429)) as unknown as typeof fetch);
    await expect(rate.verify({ email: 'a@b.example' })).resolves.toMatchObject({ error: 'rate_limited', costMicrousd: 0 });
    const server = new EmailableProvider(config, vi.fn(async () => jsonResponse({}, 503)) as unknown as typeof fetch);
    await expect(server.verify({ email: 'a@b.example' })).resolves.toMatchObject({ error: 'http_503', costMicrousd: 0 });
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const timedOut = new EmailableProvider(
      config,
      vi.fn(async () => {
        throw timeout;
      }) as unknown as typeof fetch,
    );
    await expect(timedOut.verify({ email: 'a@b.example' })).resolves.toMatchObject({ error: 'timeout' });
    const malformed = new EmailableProvider(
      config,
      vi.fn(async () => new Response('not-json', { status: 200 })) as unknown as typeof fetch,
    );
    await expect(malformed.verify({ email: 'a@b.example' })).resolves.toMatchObject({
      error: 'malformed_response',
      costMicrousd: 0,
    });
  });
});
