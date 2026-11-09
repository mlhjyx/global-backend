import { describe, expect, it, vi } from 'vitest';
import { parsePdlResponse, PdlProvider, resolvePdlConfig } from './pdl.provider';
import type { FindEmailInput } from './email-enrichment-provider';

/**
 * P1-09：People Data Labs person/enrich 适配器契约——假 HTTP fixture，零真实出网。
 * 覆盖 required=emails 计费口径（无记录/无邮箱都不扣）、404=miss、邮箱类型优先、
 * 429/401/域不一致。
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

describe('resolvePdlConfig', () => {
  it('缺省值：无 key、api.peopledatalabs.com（官方域）、8s、280000 微美元', () => {
    expect(resolvePdlConfig({})).toEqual({
      apiKey: null,
      baseUrl: 'https://api.peopledatalabs.com',
      timeoutMs: 8_000,
      costMicrousd: 280_000,
    });
  });
});

describe('parsePdlResponse', () => {
  it('优先 current_professional 类型；无邮箱/无 data → 无结果', () => {
    expect(
      parsePdlResponse({
        status: 200,
        data: {
          emails: [
            { address: 'old@old.example', type: 'previous_professional' },
            { address: 'a@acme.example', type: 'current_professional' },
          ],
        },
      }),
    ).toMatchObject({ ok: true, email: 'a@acme.example', emailType: 'current_professional' });
    expect(parsePdlResponse({ status: 200, data: { emails: [] } })).toMatchObject({
      ok: true,
      email: null,
    });
    expect(parsePdlResponse({ status: 404 })).toMatchObject({ ok: true, email: null });
    expect(parsePdlResponse({ status: 200 })).toMatchObject({ ok: false, errorCode: 'malformed_response' });
  });
});

describe('PdlProvider.findEmail', () => {
  it('命中：GET 带 name/company/required=emails，hit 成本 280000', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL) =>
      jsonResponse(200, {
        status: 200,
        data: { emails: [{ address: 'J.Mueller@Acme.Example', type: 'current_professional' }] },
      }),
    );
    const provider = new PdlProvider(resolvePdlConfig({ PDL_API_KEY: 'k' }), fetchImpl);
    expect(await provider.findEmail(INPUT)).toMatchObject({
      status: 'hit',
      costMicrousd: 280_000,
      hit: { email: 'j.mueller@acme.example' },
    });
    const url = fetchImpl.mock.calls[0]?.[0] as URL;
    expect(url.origin + url.pathname).toBe('https://api.peopledatalabs.com/v5/person/enrich');
    expect(url.searchParams.get('name')).toBe('Jürgen Müller');
    expect(url.searchParams.get('company')).toBe('Acme GmbH');
    expect(url.searchParams.get('required')).toBe('emails');
  });

  it('404 无记录 → miss 不计费；记录存在但无邮箱 → miss 不计费（required=emails 口径）', async () => {
    const notFound = new PdlProvider(
      resolvePdlConfig({ PDL_API_KEY: 'k' }),
      vi.fn(async () => jsonResponse(404, { status: 404 })),
    );
    expect(await notFound.findEmail(INPUT)).toMatchObject({
      status: 'miss',
      costMicrousd: 0,
      detail: 'pdl_not_found',
    });
    const noEmail = new PdlProvider(
      resolvePdlConfig({ PDL_API_KEY: 'k' }),
      vi.fn(async () => jsonResponse(200, { status: 200, data: { emails: [] } })),
    );
    expect(await noEmail.findEmail(INPUT)).toMatchObject({
      status: 'miss',
      costMicrousd: 0,
      detail: 'pdl_no_email',
    });
  });

  it('429 可重试 / 401 不可重试 / 域不一致 invalid_payload / 缺凭据不发请求', async () => {
    for (const [status, errorCode, retryable] of [
      [429, 'rate_limited', true],
      [401, 'unauthorized', false],
    ] as const) {
      const provider = new PdlProvider(
        resolvePdlConfig({ PDL_API_KEY: 'k' }),
        vi.fn(async () => jsonResponse(status, {})),
      );
      expect(await provider.findEmail(INPUT)).toMatchObject({
        status: 'error',
        errorCode,
        retryable,
        costMicrousd: 0,
      });
    }
    const wrongDomain = new PdlProvider(
      resolvePdlConfig({ PDL_API_KEY: 'k' }),
      vi.fn(async () =>
        jsonResponse(200, { status: 200, data: { emails: [{ address: 'x@other.example' }] } }),
      ),
    );
    expect(await wrongDomain.findEmail(INPUT)).toMatchObject({
      status: 'error',
      errorCode: 'invalid_payload',
      costMicrousd: 0,
    });
    const fetchImpl = vi.fn();
    const unconfigured = new PdlProvider(resolvePdlConfig({}), fetchImpl);
    expect(await unconfigured.findEmail(INPUT)).toMatchObject({
      status: 'error',
      errorCode: 'provider_unconfigured',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
