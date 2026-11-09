import { describe, expect, it, vi } from 'vitest';
import {
  mapZeroBounceResponse,
  resolveZeroBounceConfig,
  ZeroBounceProvider,
} from './zerobounce.provider';

/**
 * P1-05：ZeroBounce（仲裁席）适配器契约——假 HTTP fixture，零真实出网。
 */
describe('resolveZeroBounceConfig：env 解析', () => {
  it('缺省值：无 key、官方 baseUrl、8s、$0.0099/条（9900 微美元）', () => {
    expect(resolveZeroBounceConfig({})).toEqual({
      apiKey: null,
      baseUrl: 'https://api.zerobounce.net',
      timeoutMs: 8_000,
      costMicrousd: 9_900,
    });
  });

  it('非法 env 回退默认；空白 key 归一为 null', () => {
    expect(
      resolveZeroBounceConfig({
        ZEROBOUNCE_API_KEY: '  ',
        ZEROBOUNCE_TIMEOUT_MS: 'abc',
        ZEROBOUNCE_COST_MICROUSD: '0',
        ZEROBOUNCE_BASE_URL: 'https://zb.example/',
      }),
    ).toEqual({ apiKey: null, baseUrl: 'https://zb.example', timeoutMs: 8_000, costMicrousd: 9_900 });
  });
});

describe('mapZeroBounceResponse：status → 四态', () => {
  it('valid → VALID；catch-all → CATCH_ALL_RISKY·true_catch_all', () => {
    expect(mapZeroBounceResponse({ status: 'valid', sub_status: '' })).toMatchObject({
      state: 'VALID',
      catchAll: 'not_catch_all',
    });
    expect(mapZeroBounceResponse({ status: 'catch-all' })).toMatchObject({
      state: 'CATCH_ALL_RISKY',
      catchAllClass: 'true_catch_all',
    });
  });

  it('invalid / spamtrap / abuse / do_not_mail → INVALID', () => {
    for (const status of ['invalid', 'spamtrap', 'abuse', 'do_not_mail']) {
      expect(mapZeroBounceResponse({ status })).toMatchObject({ state: 'INVALID' });
    }
  });

  it('unknown → UNKNOWN（有效裁决 error=null）；error 字段 → UNKNOWN + error；畸形/未识别带 error', () => {
    expect(mapZeroBounceResponse({ status: 'unknown' })).toMatchObject({ state: 'UNKNOWN', error: null });
    expect(mapZeroBounceResponse({ error: 'invalid api key' })).toMatchObject({
      state: 'UNKNOWN',
      error: 'invalid api key',
    });
    expect(mapZeroBounceResponse(null)).toMatchObject({ error: 'malformed_response' });
    expect(mapZeroBounceResponse({ status: 'weird' })).toMatchObject({
      error: 'unrecognized_status:weird',
    });
  });
});

describe('ZeroBounceProvider：HTTP 契约（fixture）', () => {
  const config = { apiKey: 'zb-key', baseUrl: 'https://zb.example', timeoutMs: 5_000, costMicrousd: 9_900 };
  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('缺凭据：不调用 fetch，降级 UNKNOWN(provider_unconfigured)', async () => {
    const fetchImpl = vi.fn();
    const provider = new ZeroBounceProvider({ ...config, apiKey: null }, fetchImpl as unknown as typeof fetch);
    await expect(provider.verify({ email: 'a@b.example' })).resolves.toMatchObject({
      state: 'UNKNOWN',
      error: 'provider_unconfigured',
      costMicrousd: 0,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('200 valid：VALID、计费 9900、请求带 api_key/email 与 abort signal', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: 'valid', sub_status: 'mailbox_exists' }));
    const provider = new ZeroBounceProvider(config, fetchImpl as unknown as typeof fetch);
    const result = await provider.verify({ email: 'Info+tag@Acme.example' });
    expect(result).toMatchObject({ providerKey: 'zerobounce', state: 'VALID', score: 95, costMicrousd: 9_900, error: null });
    expect(result.detail).toContain('sub=mailbox_exists');
    const requestUrl = fetchImpl.mock.calls[0]?.[0] as URL;
    expect(String(requestUrl)).toContain('api_key=zb-key');
    expect(String(requestUrl)).toContain('email=Info%2Btag%40Acme.example');
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('200 unknown：有效裁决按次计费；catch-all 基础分 60', async () => {
    const unknownProvider = new ZeroBounceProvider(
      config,
      vi.fn(async () => jsonResponse({ status: 'unknown' })) as unknown as typeof fetch,
    );
    await expect(unknownProvider.verify({ email: 'a@b.example' })).resolves.toMatchObject({
      state: 'UNKNOWN',
      error: null,
      costMicrousd: 9_900,
    });
    const catchAll = new ZeroBounceProvider(
      config,
      vi.fn(async () => jsonResponse({ status: 'catch-all' })) as unknown as typeof fetch,
    );
    await expect(catchAll.verify({ email: 'a@b.example' })).resolves.toMatchObject({
      state: 'CATCH_ALL_RISKY',
      score: 60,
    });
  });

  it('429/5xx/超时/畸形体 → UNKNOWN 且不计费', async () => {
    const rate = new ZeroBounceProvider(config, vi.fn(async () => jsonResponse({}, 429)) as unknown as typeof fetch);
    await expect(rate.verify({ email: 'a@b.example' })).resolves.toMatchObject({ error: 'rate_limited', costMicrousd: 0 });
    const server = new ZeroBounceProvider(config, vi.fn(async () => jsonResponse({}, 503)) as unknown as typeof fetch);
    await expect(server.verify({ email: 'a@b.example' })).resolves.toMatchObject({ error: 'http_503', costMicrousd: 0 });
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const timedOut = new ZeroBounceProvider(
      config,
      vi.fn(async () => {
        throw timeout;
      }) as unknown as typeof fetch,
    );
    await expect(timedOut.verify({ email: 'a@b.example' })).resolves.toMatchObject({ error: 'timeout' });
    const malformed = new ZeroBounceProvider(
      config,
      vi.fn(async () => new Response('not-json', { status: 200 })) as unknown as typeof fetch,
    );
    await expect(malformed.verify({ email: 'a@b.example' })).resolves.toMatchObject({
      error: 'malformed_response',
      costMicrousd: 0,
    });
  });
});
