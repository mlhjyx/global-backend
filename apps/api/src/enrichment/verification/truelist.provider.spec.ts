import { describe, expect, it, vi } from 'vitest';
import { mapTruelistResponse, resolveTruelistConfig, TruelistProvider } from './truelist.provider';

/**
 * P1-05：Truelist（catch-all 解析席）适配器契约——假 HTTP fixture，零真实出网。
 * 契约按公开文档实现；真实 key 到位时以供应商响应校准映射。
 */
describe('resolveTruelistConfig：env 解析', () => {
  it('缺省值：无 key、官方 baseUrl、8s、$0.0014/条（1400 微美元）', () => {
    expect(resolveTruelistConfig({})).toEqual({
      apiKey: null,
      baseUrl: 'https://api.truelist.io',
      timeoutMs: 8_000,
      costMicrousd: 1_400,
    });
  });
});

describe('mapTruelistResponse：email_state → 四态', () => {
  it('ok → VALID；accept_all → CATCH_ALL_RISKY·true_catch_all', () => {
    expect(mapTruelistResponse({ emails: [{ email_state: 'ok', reason: 'ok' }] })).toMatchObject({
      state: 'VALID',
      catchAll: 'not_catch_all',
    });
    expect(mapTruelistResponse({ emails: [{ email_state: 'accept_all' }] })).toMatchObject({
      state: 'CATCH_ALL_RISKY',
      catchAllClass: 'true_catch_all',
    });
  });

  it('email_invalid → INVALID；is_disposable=true 覆盖任何态判 INVALID', () => {
    expect(mapTruelistResponse({ emails: [{ email_state: 'email_invalid' }] })).toMatchObject({
      state: 'INVALID',
    });
    expect(
      mapTruelistResponse({ emails: [{ email_state: 'ok', is_disposable: true }] }),
    ).toMatchObject({ state: 'INVALID', detail: 'disposable:yes' });
  });

  it('unknown → UNKNOWN（有效裁决 error=null）；error/畸形/未识别带 error', () => {
    expect(mapTruelistResponse({ emails: [{ email_state: 'unknown' }] })).toMatchObject({
      state: 'UNKNOWN',
      error: null,
    });
    expect(mapTruelistResponse({ error: 'unauthorized' })).toMatchObject({ error: 'unauthorized' });
    expect(mapTruelistResponse(null)).toMatchObject({ error: 'malformed_response' });
    expect(mapTruelistResponse({ emails: [{ email_state: 'weird' }] })).toMatchObject({
      error: 'unrecognized_state:weird',
    });
    expect(mapTruelistResponse({ emails: [] })).toMatchObject({ error: 'malformed_response' });
  });
});

describe('TruelistProvider：HTTP 契约（fixture）', () => {
  const config = { apiKey: 'tl-key', baseUrl: 'https://tl.example', timeoutMs: 5_000, costMicrousd: 1_400 };
  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('缺凭据：不调用 fetch，降级 UNKNOWN(provider_unconfigured)', async () => {
    const fetchImpl = vi.fn();
    const provider = new TruelistProvider({ ...config, apiKey: null }, fetchImpl as unknown as typeof fetch);
    await expect(provider.verify({ email: 'a@b.example' })).resolves.toMatchObject({
      state: 'UNKNOWN',
      error: 'provider_unconfigured',
      costMicrousd: 0,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('200 ok：VALID、计费 1400、Bearer 鉴权与 email 参数', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ emails: [{ email_state: 'ok', reason: 'ok' }] }));
    const provider = new TruelistProvider(config, fetchImpl as unknown as typeof fetch);
    await expect(provider.verify({ email: 'Info+tag@Acme.example' })).resolves.toMatchObject({
      providerKey: 'truelist',
      state: 'VALID',
      score: 95,
      costMicrousd: 1_400,
      error: null,
    });
    const requestUrl = fetchImpl.mock.calls[0]?.[0] as URL;
    expect(String(requestUrl)).toContain('/api/v1/verify_inline');
    expect(String(requestUrl)).toContain('email=Info%2Btag%40Acme.example');
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit)?.headers).toMatchObject({
      authorization: 'Bearer tl-key',
    });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('200 unknown：按次计费；429/5xx/畸形体不计费', async () => {
    const unk = new TruelistProvider(
      config,
      vi.fn(async () => jsonResponse({ emails: [{ email_state: 'unknown' }] })) as unknown as typeof fetch,
    );
    await expect(unk.verify({ email: 'a@b.example' })).resolves.toMatchObject({
      state: 'UNKNOWN',
      error: null,
      costMicrousd: 1_400,
    });
    const rate = new TruelistProvider(config, vi.fn(async () => jsonResponse({}, 429)) as unknown as typeof fetch);
    await expect(rate.verify({ email: 'a@b.example' })).resolves.toMatchObject({ error: 'rate_limited', costMicrousd: 0 });
    const malformed = new TruelistProvider(
      config,
      vi.fn(async () => new Response('not-json', { status: 200 })) as unknown as typeof fetch,
    );
    await expect(malformed.verify({ email: 'a@b.example' })).resolves.toMatchObject({
      error: 'malformed_response',
      costMicrousd: 0,
    });
  });
});
