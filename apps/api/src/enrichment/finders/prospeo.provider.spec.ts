import { describe, expect, it, vi } from 'vitest';
import { parseProspeoResponse, ProspeoProvider, resolveProspeoConfig } from './prospeo.provider';
import type { FindEmailInput } from './email-enrichment-provider';

/**
 * P1-07：Prospeo 适配器契约——假 HTTP fixture，零真实出网。
 * 覆盖 error:false/error:true 两族响应、NO_MATCH 不计费、限流/欠费的可重试性区分。
 */
const INPUT: FindEmailInput = {
  workspaceId: 'ws-1',
  contactId: 'contact-1',
  fullName: 'Jürgen Müller',
  domain: 'acme.example',
  companyName: 'Acme GmbH',
  accountKey: 'account-1',
};

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('resolveProspeoConfig：env 解析', () => {
  it('缺省值：无 key、api.prospeo.io、15s、19800 微美元', () => {
    expect(resolveProspeoConfig({})).toEqual({
      apiKey: null,
      baseUrl: 'https://api.prospeo.io',
      timeoutMs: 15_000,
      costMicrousd: 19_800,
    });
  });
});

describe('parseProspeoResponse：error 族响应', () => {
  it('error:false + person.email（v2）或 response.email（兼容）→ 命中；缺失 → 无结果', () => {
    expect(
      parseProspeoResponse({
        error: false,
        person: { email: { email: 'a@acme.example', status: 'VERIFIED', revealed: true } },
      }),
    ).toMatchObject({
      ok: true,
      email: 'a@acme.example',
      confidence: 95,
    });
    expect(parseProspeoResponse({ error: false, response: { email: 'a@acme.example' } })).toMatchObject({
      ok: true,
      email: 'a@acme.example',
    });
    expect(parseProspeoResponse({ error: false, person: { email: {} } })).toMatchObject({ ok: true, email: null });
    expect(parseProspeoResponse({ error: false, response: {} })).toMatchObject({ ok: true, email: null });
  });

  it('NO_MATCH / INVALID_DATAPOINTS 是合法 miss；限流可重试、欠费/坏 key 不可重试', () => {
    expect(parseProspeoResponse({ error: true, error_code: 'NO_MATCH' })).toMatchObject({
      ok: true,
      email: null,
    });
    expect(parseProspeoResponse({ error: true, error_code: 'INVALID_DATAPOINTS' })).toMatchObject({
      ok: true,
      email: null,
    });
    expect(parseProspeoResponse({ error: true, error_code: 'RATE_LIMITED' })).toMatchObject({
      ok: false,
      errorCode: 'rate_limited',
      retryable: true,
    });
    expect(parseProspeoResponse({ error: true, error_code: 'INTERNAL_ERROR' })).toMatchObject({
      ok: false,
      retryable: true,
    });
    expect(parseProspeoResponse({ error: true, error_code: 'INSUFFICIENT_CREDITS' })).toMatchObject({
      ok: false,
      errorCode: 'insufficient_credits',
      retryable: false,
    });
  });

  it('error 标志缺失/非对象 → malformed_response', () => {
    expect(parseProspeoResponse({ response: { email: 'a@acme.example' } })).toMatchObject({
      ok: false,
      errorCode: 'malformed_response',
    });
    expect(parseProspeoResponse(undefined)).toMatchObject({ ok: false });
  });
});

describe('ProspeoProvider.findEmail：HTTP 契约', () => {
  it('命中：走新版 /enrich-person + only_verified_email:true + X-KEY 头，hit 带成本与 SMTP 置信度', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(200, {
        error: false,
        person: { email: { email: 'J.Mueller@Acme.Example', status: 'VERIFIED', revealed: true } },
      }),
    );
    const provider = new ProspeoProvider(resolveProspeoConfig({ PROSPEO_API_KEY: 'key-1' }), fetchImpl);
    expect(await provider.findEmail(INPUT)).toMatchObject({
      status: 'hit',
      costMicrousd: 19_800,
      hit: { email: 'j.mueller@acme.example', providerConfidence: 95 },
    });
    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://api.prospeo.io/enrich-person');
    expect((init.headers as Record<string, string>)['x-key']).toBe('key-1');
    expect(JSON.parse(init.body as string)).toEqual({
      data: {
        full_name: 'Jürgen Müller',
        first_name: 'Jürgen',
        last_name: 'Müller',
        company_website: 'acme.example',
        company_name: 'Acme GmbH',
      },
      only_verified_email: true,
    });
  });

  it('NO_MATCH → miss 成本 0；RATE_LIMITED → 可重试；域不一致 → invalid_payload', async () => {
    const miss = new ProspeoProvider(
      resolveProspeoConfig({ PROSPEO_API_KEY: 'k' }),
      vi.fn(async () => jsonResponse(200, { error: true, error_code: 'NO_MATCH' })),
    );
    expect(await miss.findEmail(INPUT)).toMatchObject({
      status: 'miss',
      costMicrousd: 0,
      detail: 'prospeo_no_match',
    });
    const limited = new ProspeoProvider(
      resolveProspeoConfig({ PROSPEO_API_KEY: 'k' }),
      vi.fn(async () => jsonResponse(200, { error: true, error_code: 'RATE_LIMITED' })),
    );
    expect(await limited.findEmail(INPUT)).toMatchObject({
      status: 'error',
      errorCode: 'rate_limited',
      retryable: true,
      costMicrousd: 0,
    });
    const wrongDomain = new ProspeoProvider(
      resolveProspeoConfig({ PROSPEO_API_KEY: 'k' }),
      vi.fn(async () =>
        jsonResponse(200, { error: false, response: { email: 'x@other.example' } }),
      ),
    );
    expect(await wrongDomain.findEmail(INPUT)).toMatchObject({
      status: 'error',
      errorCode: 'invalid_payload',
      retryable: false,
    });
  });

  it('HTTP 400/404/422 携带 NO_MATCH / INVALID_DATAPOINTS → 合法 miss；鉴权/欠费/废弃/畸形体仍为 error', async () => {
    for (const [status, errorCode] of [
      [400, 'NO_MATCH'],
      [400, 'INVALID_DATAPOINTS'],
      [404, 'NO_MATCH'],
      [422, 'INVALID_DATAPOINTS'],
    ] as const) {
      const provider = new ProspeoProvider(
        resolveProspeoConfig({ PROSPEO_API_KEY: 'k' }),
        vi.fn(async () => jsonResponse(status, { error: true, error_code: errorCode })),
      );
      expect(await provider.findEmail(INPUT)).toMatchObject({
        status: 'miss',
        costMicrousd: 0,
      });
    }

    const noCredits = new ProspeoProvider(
      resolveProspeoConfig({ PROSPEO_API_KEY: 'k' }),
      vi.fn(async () => jsonResponse(400, { error: true, error_code: 'INSUFFICIENT_CREDITS' })),
    );
    expect(await noCredits.findEmail(INPUT)).toMatchObject({
      status: 'error',
      errorCode: 'insufficient_credits',
      retryable: false,
      costMicrousd: 0,
    });

    const deprecated = new ProspeoProvider(
      resolveProspeoConfig({ PROSPEO_API_KEY: 'k' }),
      vi.fn(async () => jsonResponse(400, { error: true, error_code: 'DEPRECATED' })),
    );
    expect(await deprecated.findEmail(INPUT)).toMatchObject({
      status: 'error',
      errorCode: 'deprecated',
      retryable: false,
      costMicrousd: 0,
    });

    for (const badResponse of [
      new Response('<html>Bad Request</html>', { status: 400 }),
      jsonResponse(400, {}),
      jsonResponse(400, { error: false, person: { email: { email: 'a@acme.example', status: 'VERIFIED' } } }),
    ]) {
      const provider = new ProspeoProvider(
        resolveProspeoConfig({ PROSPEO_API_KEY: 'k' }),
        vi.fn(async () => badResponse),
      );
      expect(await provider.findEmail(INPUT)).toMatchObject({
        status: 'error',
        errorCode: 'provider_http_error',
        retryable: false,
        costMicrousd: 0,
      });
    }
  });

  it('HTTP 429/401 与缺凭据', async () => {
    const limited = new ProspeoProvider(
      resolveProspeoConfig({ PROSPEO_API_KEY: 'k' }),
      vi.fn(async () => jsonResponse(429, {})),
      vi.fn(async () => undefined),
    );
    expect(await limited.findEmail(INPUT)).toMatchObject({
      status: 'error',
      errorCode: 'rate_limited',
      retryable: true,
    });
    const unauthorized = new ProspeoProvider(
      resolveProspeoConfig({ PROSPEO_API_KEY: 'k' }),
      vi.fn(async () => jsonResponse(401, {})),
    );
    expect(await unauthorized.findEmail(INPUT)).toMatchObject({
      status: 'error',
      errorCode: 'unauthorized',
      retryable: false,
    });
    const fetchImpl = vi.fn();
    const unconfigured = new ProspeoProvider(resolveProspeoConfig({}), fetchImpl);
    expect(await unconfigured.findEmail(INPUT)).toMatchObject({
      status: 'error',
      errorCode: 'provider_unconfigured',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('supports QPS pacing, bounded 429 retry with Retry-After, and corporate-group email domains', async () => {
    const sleeps: number[] = [];
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return new Response('{}', { status: 429, headers: { 'retry-after': '1' } });
      }
      return jsonResponse(200, {
        error: false,
        person: { email: { email: 'm.rossi@coesa.it', status: 'VERIFIED', revealed: true } },
      });
    });
    const cfg = resolveProspeoConfig({ PROSPEO_API_KEY: 'k', PROSPEO_MIN_INTERVAL_MS: '600' });
    expect(cfg.minIntervalMs).toBe(600);
    const provider = new ProspeoProvider(cfg, fetchImpl, async (ms) => {
      sleeps.push(ms);
    });
    const res = await provider.findEmail({
      ...INPUT,
      fullName: 'Marco Rossi',
      domain: 'coesaenergy.it',
      companyName: 'Coesa Energy S.r.l.',
    });
    expect(res).toMatchObject({
      status: 'hit',
      hit: { email: 'm.rossi@coesa.it', providerConfidence: 95 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleeps).toContain(1000);
  });
});
