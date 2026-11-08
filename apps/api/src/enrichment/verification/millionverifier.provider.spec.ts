import { describe, expect, it, vi } from 'vitest';
import {
  mapMillionVerifierResponse,
  MillionVerifierProvider,
  resolveMillionVerifierConfig,
} from './millionverifier.provider';

/**
 * P1-04：MillionVerifier 适配器的契约测试——假 HTTP fixture，零真实出网。
 * 覆盖 200/429/5xx/超时/畸形体/缺凭据与 accept_all 优先规则。
 */
describe('resolveMillionVerifierConfig：env 解析', () => {
  it('缺省值：无 key、官方 baseUrl、8s 超时、$0.00178/条（1780 微美元）', () => {
    expect(resolveMillionVerifierConfig({})).toEqual({
      apiKey: null,
      baseUrl: 'https://api.millionverifier.com',
      timeoutMs: 8_000,
      costMicrousd: 1_780,
    });
  });

  it('非法 env（abc/0/负数）回退默认', () => {
    expect(
      resolveMillionVerifierConfig({
        MILLIONVERIFIER_API_KEY: 'k',
        MILLIONVERIFIER_TIMEOUT_MS: 'abc',
        MILLIONVERIFIER_COST_MICROUSD: '0',
      }),
    ).toMatchObject({ timeoutMs: 8_000, costMicrousd: 1_780 });
    expect(
      resolveMillionVerifierConfig({
        MILLIONVERIFIER_API_KEY: 'k',
        MILLIONVERIFIER_TIMEOUT_MS: '-5',
        MILLIONVERIFIER_COST_MICROUSD: '-1',
      }),
    ).toMatchObject({ timeoutMs: 8_000, costMicrousd: 1_780 });
  });

  it('env 覆盖与空白 key 归一为 null', () => {
    expect(
      resolveMillionVerifierConfig({
        MILLIONVERIFIER_API_KEY: '  ',
        MILLIONVERIFIER_BASE_URL: 'https://mv.example/',
        MILLIONVERIFIER_TIMEOUT_MS: '3000',
        MILLIONVERIFIER_COST_MICROUSD: '2000',
      }),
    ).toEqual({
      apiKey: null,
      baseUrl: 'https://mv.example',
      timeoutMs: 3_000,
      costMicrousd: 2_000,
    });
  });
});

describe('mapMillionVerifierResponse：供应商结果 → 四态', () => {
  it('ok（accept_all=false）→ VALID；ok + accept_all=true 必须降为 CATCH_ALL_RISKY', () => {
    expect(mapMillionVerifierResponse({ result: 'ok', subresult: 'ok.mailbox', accept_all: false })).toMatchObject({
      state: 'VALID',
      catchAll: 'not_catch_all',
      catchAllClass: 'not_catch_all',
      acceptAll: false,
    });
    expect(mapMillionVerifierResponse({ result: 'ok', accept_all: true })).toMatchObject({
      state: 'CATCH_ALL_RISKY',
      catchAll: 'catch_all',
      catchAllClass: 'true_catch_all',
    });
    // 缺 accept_all 字段（老契约/畸形体）：保守进 catch-all 层，不得判 VALID。
    expect(mapMillionVerifierResponse({ result: 'ok' })).toMatchObject({
      state: 'CATCH_ALL_RISKY',
      catchAll: 'inconclusive',
      catchAllClass: 'inconclusive',
    });
  });

  it('invalid/disposable → INVALID；catch_all → CATCH_ALL_RISKY·true_catch_all', () => {
    expect(mapMillionVerifierResponse({ result: 'invalid', subresult: 'invalid.mailbox' })).toMatchObject({
      state: 'INVALID',
    });
    expect(mapMillionVerifierResponse({ result: 'disposable' })).toMatchObject({ state: 'INVALID' });
    expect(mapMillionVerifierResponse({ result: 'catch_all' })).toMatchObject({
      state: 'CATCH_ALL_RISKY',
      catchAllClass: 'true_catch_all',
    });
  });

  it('unknown 是有效裁决（error=null、计费）；error/未成功/畸形体才是供应商错误', () => {
    expect(mapMillionVerifierResponse({ result: 'unknown' })).toMatchObject({
      state: 'UNKNOWN',
      error: null,
    });
    expect(mapMillionVerifierResponse({ result: 'error', error: 'timeout' })).toMatchObject({
      state: 'UNKNOWN',
      error: 'timeout',
    });
    expect(mapMillionVerifierResponse({ result: 'error' })).toMatchObject({
      state: 'UNKNOWN',
      error: 'provider_reported_error',
    });
    expect(mapMillionVerifierResponse({ success: false, error: 'bad key' })).toMatchObject({
      state: 'UNKNOWN',
      error: 'bad key',
    });
    expect(mapMillionVerifierResponse(null)).toMatchObject({ state: 'UNKNOWN', error: 'malformed_response' });
    expect(mapMillionVerifierResponse('ok')).toMatchObject({ state: 'UNKNOWN', error: 'malformed_response' });
    expect(mapMillionVerifierResponse({ result: 'maybe' })).toMatchObject({
      state: 'UNKNOWN',
      error: 'unrecognized_result:maybe',
    });
  });
});

describe('MillionVerifierProvider：HTTP 契约（fixture，无真实出网）', () => {
  const config = {
    apiKey: 'test-key',
    baseUrl: 'https://mv.example',
    timeoutMs: 5_000,
    costMicrousd: 1_780,
  };

  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  it('缺凭据：不调用 fetch，诚实降级 UNKNOWN(provider_unconfigured)', async () => {
    const fetchImpl = vi.fn();
    const provider = new MillionVerifierProvider(
      { ...config, apiKey: null },
      fetchImpl as unknown as typeof fetch,
    );
    expect(provider.isConfigured()).toBe(false);
    await expect(provider.verify({ email: 'info@acme.example' })).resolves.toMatchObject({
      state: 'UNKNOWN',
      error: 'provider_unconfigured',
      costMicrousd: 0,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('200 ok：映射 VALID、计费 1780 微美元，请求带 api/email/timeout', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ result: 'ok', accept_all: false, success: true }));
    const provider = new MillionVerifierProvider(config, fetchImpl as unknown as typeof fetch);
    expect(provider.isConfigured()).toBe(true);
    const result = await provider.verify({ email: 'Info+tag@Acme.example' });
    expect(result).toMatchObject({
      providerKey: 'millionverifier',
      state: 'VALID',
      score: 95,
      costMicrousd: 1_780,
      error: null,
    });
    const requestUrl = fetchImpl.mock.calls[0]?.[0] as URL;
    expect(String(requestUrl)).toContain('api=test-key');
    expect(String(requestUrl)).toContain('email=Info%2Btag%40Acme.example');
    // 供应商 timeout 提示与客户端 abort 窗口对齐（本 fixture 配置 5s）。
    expect(String(requestUrl)).toContain('timeout=5');
    // abort 信号真的挂到了请求上（8s 超时承诺不允许只写在注释里）。
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('429 → UNKNOWN(rate_limited) 且不计费；5xx → UNKNOWN(http_5xx)', async () => {
    const rateLimited = new MillionVerifierProvider(
      config,
      vi.fn(async () => jsonResponse({ error: 'rate limited' }, 429)) as unknown as typeof fetch,
    );
    await expect(rateLimited.verify({ email: 'a@b.example' })).resolves.toMatchObject({
      state: 'UNKNOWN',
      error: 'rate_limited',
      costMicrousd: 0,
    });
    const serverError = new MillionVerifierProvider(
      config,
      vi.fn(async () => jsonResponse({}, 503)) as unknown as typeof fetch,
    );
    await expect(serverError.verify({ email: 'a@b.example' })).resolves.toMatchObject({
      state: 'UNKNOWN',
      error: 'http_503',
      costMicrousd: 0,
    });
  });

  it('超时/网络错误 → UNKNOWN(timeout/network_error)，不抛异常', async () => {
    const timeoutError = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const timedOut = new MillionVerifierProvider(
      config,
      vi.fn(async () => {
        throw timeoutError;
      }) as unknown as typeof fetch,
    );
    await expect(timedOut.verify({ email: 'a@b.example' })).resolves.toMatchObject({
      state: 'UNKNOWN',
      error: 'timeout',
    });
    const network = new MillionVerifierProvider(
      config,
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }) as unknown as typeof fetch,
    );
    await expect(network.verify({ email: 'a@b.example' })).resolves.toMatchObject({
      state: 'UNKNOWN',
      error: 'network_error',
    });
  });

  it('200 + result=unknown：有效裁决按次计费（1780 微美元），error 为空', async () => {
    const provider = new MillionVerifierProvider(
      config,
      vi.fn(async () => jsonResponse({ result: 'unknown', success: true })) as unknown as typeof fetch,
    );
    await expect(provider.verify({ email: 'a@b.example' })).resolves.toMatchObject({
      state: 'UNKNOWN',
      error: null,
      costMicrousd: 1_780,
    });
  });

  it('200 + catch_all：基础分 60（与 scoreEmailPoint 同一口径）', async () => {
    const provider = new MillionVerifierProvider(
      config,
      vi.fn(async () => jsonResponse({ result: 'catch_all', success: true })) as unknown as typeof fetch,
    );
    await expect(provider.verify({ email: 'a@b.example' })).resolves.toMatchObject({
      state: 'CATCH_ALL_RISKY',
      score: 60,
      costMicrousd: 1_780,
    });
  });

  it('畸形 JSON 体 → UNKNOWN(malformed_response)，不计费', async () => {
    const provider = new MillionVerifierProvider(
      config,
      vi.fn(async () => new Response('not-json', { status: 200 })) as unknown as typeof fetch,
    );
    await expect(provider.verify({ email: 'a@b.example' })).resolves.toMatchObject({
      state: 'UNKNOWN',
      error: 'malformed_response',
      costMicrousd: 0,
    });
  });
});
