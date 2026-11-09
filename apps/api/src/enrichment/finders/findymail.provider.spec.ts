import { describe, expect, it, vi } from 'vitest';
import { FindymailProvider, parseFindymailResponse, resolveFindymailConfig } from './findymail.provider';
import type { FindEmailInput } from './email-enrichment-provider';

/**
 * P1-07：Findymail 适配器契约——假 HTTP fixture，零真实出网。
 * 覆盖顶层/嵌套两种响应形状、显式无结果不计费、429/401/畸形体与域不一致降级。
 */
const INPUT: FindEmailInput = {
  workspaceId: 'ws-1',
  contactId: 'contact-1',
  fullName: 'Jürgen Müller',
  domain: 'acme.example',
  accountKey: 'account-1',
};

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('resolveFindymailConfig：env 解析', () => {
  it('缺省值：无 key、app.findymail.com、8s、19800 微美元；空白 key 归一为 null', () => {
    expect(resolveFindymailConfig({})).toEqual({
      apiKey: null,
      baseUrl: 'https://app.findymail.com',
      timeoutMs: 8_000,
      costMicrousd: 19_800,
    });
    expect(resolveFindymailConfig({ FINDYMAIL_API_KEY: '   ' })).toMatchObject({ apiKey: null });
  });
});

describe('parseFindymailResponse：响应形状', () => {
  it('顶层 email / 嵌套 contact.email 均可；显式 null 为 miss', () => {
    expect(parseFindymailResponse({ email: 'A@Acme.Example', status: 'valid' })).toMatchObject({
      ok: true,
      email: 'A@Acme.Example',
      extra: { provider: 'findymail', status: 'valid' },
    });
    expect(parseFindymailResponse({ contact: { email: 'b@acme.example' } })).toMatchObject({
      ok: true,
      email: 'b@acme.example',
    });
    expect(parseFindymailResponse({ email: null })).toMatchObject({ ok: true, email: null });
  });

  it('字段缺失/非对象 → malformed_response', () => {
    expect(parseFindymailResponse({})).toMatchObject({ ok: false, errorCode: 'malformed_response' });
    expect(parseFindymailResponse('nope')).toMatchObject({ ok: false });
  });
});

describe('FindymailProvider.findEmail：HTTP 契约', () => {
  it('命中：POST body/凭据正确，hit 带成本，邮箱小写', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(200, { email: 'Juergen.Mueller@Acme.Example' }),
    );
    const provider = new FindymailProvider(
      resolveFindymailConfig({ FINDYMAIL_API_KEY: 'key-1' }),
      fetchImpl,
    );
    expect(await provider.findEmail(INPUT)).toMatchObject({
      status: 'hit',
      costMicrousd: 19_800,
      hit: { email: 'juergen.mueller@acme.example' },
    });
    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://app.findymail.com/api/search');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer key-1');
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'Jürgen Müller',
      domain: 'acme.example',
    });
  });

  it('显式无结果 → miss，成本 0（pay-on-valid）', async () => {
    const provider = new FindymailProvider(
      resolveFindymailConfig({ FINDYMAIL_API_KEY: 'k' }),
      vi.fn(async () => jsonResponse(200, { email: null })),
    );
    expect(await provider.findEmail(INPUT)).toMatchObject({
      status: 'miss',
      costMicrousd: 0,
      detail: 'findymail_no_match',
    });
  });

  it('429 可重试 / 401 不可重试 / 域不一致 invalid_payload / 畸形体 malformed_response', async () => {
    const cases: Array<[() => Response, string, boolean]> = [
      [() => jsonResponse(429, {}), 'rate_limited', true],
      [() => jsonResponse(403, {}), 'unauthorized', false],
      [() => jsonResponse(200, { email: 'x@other.example' }), 'invalid_payload', false],
      [() => jsonResponse(200, {}), 'malformed_response', false],
    ];
    for (const [makeResponse, errorCode, retryable] of cases) {
      const provider = new FindymailProvider(
        resolveFindymailConfig({ FINDYMAIL_API_KEY: 'k' }),
        vi.fn(async () => makeResponse()),
      );
      expect(await provider.findEmail(INPUT)).toMatchObject({
        status: 'error',
        errorCode,
        retryable,
        costMicrousd: 0,
      });
    }
  });

  it('缺凭据 → provider_unconfigured 且不发请求', async () => {
    const fetchImpl = vi.fn();
    const provider = new FindymailProvider(resolveFindymailConfig({}), fetchImpl);
    expect(await provider.findEmail(INPUT)).toMatchObject({
      status: 'error',
      errorCode: 'provider_unconfigured',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
