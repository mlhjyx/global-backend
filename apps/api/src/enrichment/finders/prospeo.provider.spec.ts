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
  it('缺省值：无 key、api.prospeo.io、8s、19800 微美元', () => {
    expect(resolveProspeoConfig({})).toEqual({
      apiKey: null,
      baseUrl: 'https://api.prospeo.io',
      timeoutMs: 8_000,
      costMicrousd: 19_800,
    });
  });
});

describe('parseProspeoResponse：error 族响应', () => {
  it('error:false + response.email → 命中；email 缺失 → 无结果', () => {
    expect(parseProspeoResponse({ error: false, response: { email: 'a@acme.example' } })).toMatchObject({
      ok: true,
      email: 'a@acme.example',
    });
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
  it('命中：X-KEY 头、full_name/domain/company_name 进 body，hit 带成本', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(200, { error: false, response: { email: 'J.Mueller@Acme.Example' } }),
    );
    const provider = new ProspeoProvider(resolveProspeoConfig({ PROSPEO_API_KEY: 'key-1' }), fetchImpl);
    expect(await provider.findEmail(INPUT)).toMatchObject({
      status: 'hit',
      costMicrousd: 19_800,
      hit: { email: 'j.mueller@acme.example' },
    });
    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://api.prospeo.io/email-finder');
    expect((init.headers as Record<string, string>)['x-key']).toBe('key-1');
    expect(JSON.parse(init.body as string)).toEqual({
      full_name: 'Jürgen Müller',
      domain: 'acme.example',
      company_name: 'Acme GmbH',
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

  it('HTTP 429/401 与缺凭据', async () => {
    const limited = new ProspeoProvider(
      resolveProspeoConfig({ PROSPEO_API_KEY: 'k' }),
      vi.fn(async () => jsonResponse(429, {})),
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
});
