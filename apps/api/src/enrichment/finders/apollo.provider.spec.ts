import { describe, expect, it, vi } from 'vitest';
import { ApolloProvider, parseApolloResponse, resolveApolloConfig } from './apollo.provider';
import type { FindEmailInput } from './email-enrichment-provider';

/**
 * P1-09：Apollo people/match 适配器契约——假 HTTP fixture，零真实出网。
 * 覆盖 email_status→confidence 折算、无记录不计费、单名不花配额、429/401/域不一致。
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

describe('resolveApolloConfig', () => {
  it('缺省值：无 key、api.apollo.io、8s、25000 微美元', () => {
    expect(resolveApolloConfig({})).toEqual({
      apiKey: null,
      baseUrl: 'https://api.apollo.io',
      timeoutMs: 8_000,
      costMicrousd: 25_000,
    });
  });
});

describe('parseApolloResponse', () => {
  it('verified/guessed → 命中并折算 confidence；person 缺失 → 合法 miss', () => {
    expect(
      parseApolloResponse({ person: { email: 'a@acme.example', email_status: 'verified' } }),
    ).toMatchObject({ ok: true, email: 'a@acme.example', confidence: 95 });
    expect(
      parseApolloResponse({ person: { email: 'a@acme.example', email_status: 'guessed' } }),
    ).toMatchObject({ ok: true, confidence: 50 });
    expect(parseApolloResponse({ person: null })).toMatchObject({ ok: true, email: null });
    expect(parseApolloResponse({})).toMatchObject({ ok: true, email: null });
  });

  it('非对象/畸形 person → malformed_response', () => {
    expect(parseApolloResponse('nope')).toMatchObject({ ok: false });
    expect(parseApolloResponse({ person: 42 })).toMatchObject({ ok: false, errorCode: 'malformed_response' });
  });
});

describe('ApolloProvider.findEmail', () => {
  it('命中：POST body 带姓名/域/公司名，hit 成本 25000', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(200, { person: { email: 'J.Mueller@Acme.Example', email_status: 'verified' } }),
    );
    const provider = new ApolloProvider(resolveApolloConfig({ APOLLO_API_KEY: 'k' }), fetchImpl);
    expect(await provider.findEmail(INPUT)).toMatchObject({
      status: 'hit',
      costMicrousd: 25_000,
      hit: { email: 'j.mueller@acme.example', providerConfidence: 95 },
    });
    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://api.apollo.io/api/v1/people/match');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('k');
    expect(JSON.parse(init.body as string)).toMatchObject({
      first_name: 'Jürgen',
      last_name: 'Müller',
      domain: 'acme.example',
      organization_name: 'Acme GmbH',
    });
  });

  it('无记录 → miss 成本 0；单名输入不花配额', async () => {
    const provider = new ApolloProvider(
      resolveApolloConfig({ APOLLO_API_KEY: 'k' }),
      vi.fn(async () => jsonResponse(200, { person: null })),
    );
    expect(await provider.findEmail(INPUT)).toMatchObject({ status: 'miss', costMicrousd: 0 });
    const fetchImpl = vi.fn();
    const single = new ApolloProvider(resolveApolloConfig({ APOLLO_API_KEY: 'k' }), fetchImpl);
    expect(await single.findEmail({ ...INPUT, fullName: 'Cher' })).toMatchObject({
      status: 'miss',
      detail: 'apollo_name_not_parseable',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('429 可重试 / 401 不可重试 / 域不一致 invalid_payload / 缺凭据不发请求', async () => {
    for (const [status, errorCode, retryable] of [
      [429, 'rate_limited', true],
      [401, 'unauthorized', false],
    ] as const) {
      const provider = new ApolloProvider(
        resolveApolloConfig({ APOLLO_API_KEY: 'k' }),
        vi.fn(async () => jsonResponse(status, {})),
      );
      expect(await provider.findEmail(INPUT)).toMatchObject({
        status: 'error',
        errorCode,
        retryable,
        costMicrousd: 0,
      });
    }
    const wrongDomain = new ApolloProvider(
      resolveApolloConfig({ APOLLO_API_KEY: 'k' }),
      vi.fn(async () => jsonResponse(200, { person: { email: 'x@other.example', email_status: 'verified' } })),
    );
    expect(await wrongDomain.findEmail(INPUT)).toMatchObject({
      status: 'error',
      errorCode: 'invalid_payload',
      costMicrousd: 0,
    });
    const fetchImpl = vi.fn();
    const unconfigured = new ApolloProvider(resolveApolloConfig({}), fetchImpl);
    expect(await unconfigured.findEmail(INPUT)).toMatchObject({
      status: 'error',
      errorCode: 'provider_unconfigured',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
