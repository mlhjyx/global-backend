import { describe, expect, it, vi } from 'vitest';
import {
  HunterProvider,
  parseHunterDomainSearch,
  resolveHunterConfig,
} from './hunter.provider';
import type { FindEmailInput } from './email-enrichment-provider';

/**
 * P1-07：Hunter domain-search 适配器契约——假 HTTP fixture，零真实出网。
 * 覆盖按姓名的结构化匹配、pattern/accept_all 透传、无结果不计费、
 * 429/401/5xx/畸形体/非法返回值的降级路径与缺凭据行为。
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

const domainSearchBody = {
  data: {
    domain: 'acme.example',
    accept_all: true,
    pattern: '{first}.{last}',
    emails: [
      {
        value: 'info@acme.example',
        type: 'generic',
        confidence: 99,
        first_name: null,
        last_name: null,
      },
      {
        value: 'Juergen.Mueller@acme.example',
        type: 'personal',
        confidence: 91,
        first_name: 'Jürgen',
        last_name: 'Müller',
      },
      {
        value: 'jurgen.mueller@acme.example',
        type: 'personal',
        confidence: 95,
        first_name: 'Jurgen',
        last_name: 'Muller',
      },
    ],
  },
  meta: { results: 3 },
};

describe('resolveHunterConfig：env 解析', () => {
  it('缺省值：无 key、官方 baseUrl、8s 超时、1700 微美元；非法值回退', () => {
    expect(resolveHunterConfig({})).toEqual({
      apiKey: null,
      baseUrl: 'https://api.hunter.io',
      timeoutMs: 8_000,
      costMicrousd: 1_700,
    });
    expect(
      resolveHunterConfig({
        HUNTER_API_KEY: '  ',
        HUNTER_BASE_URL: 'https://hunter.example/',
        HUNTER_TIMEOUT_MS: 'abc',
        HUNTER_COST_MICROUSD: '-3',
      }),
    ).toEqual({
      apiKey: null,
      baseUrl: 'https://hunter.example',
      timeoutMs: 8_000,
      costMicrousd: 1_700,
    });
  });
});

describe('parseHunterDomainSearch：供应商响应 → 人-邮箱匹配', () => {
  it('按姓名的归一匹配取 confidence 最高；pattern/accept_all 透传', () => {
    const parsed = parseHunterDomainSearch(domainSearchBody, { fullName: INPUT.fullName });
    expect(parsed).toMatchObject({
      ok: true,
      acceptAll: true,
      pattern: '{first}.{last}',
      candidateCount: 3,
      missReason: null,
      match: { email: 'jurgen.mueller@acme.example', confidence: 95 },
    });
  });

  it('无同名条目 → miss（no_name_match）；单名输入 → name_not_parseable', () => {
    expect(parseHunterDomainSearch(domainSearchBody, { fullName: 'Wei Chen' })).toMatchObject({
      ok: true,
      match: null,
      missReason: 'no_name_match',
    });
    expect(parseHunterDomainSearch(domainSearchBody, { fullName: 'Cher' })).toMatchObject({
      ok: true,
      match: null,
      missReason: 'name_not_parseable',
    });
  });

  it('畸形体 → error（malformed_response），不猜', () => {
    expect(parseHunterDomainSearch(null, { fullName: INPUT.fullName })).toMatchObject({ ok: false });
    expect(parseHunterDomainSearch({}, { fullName: INPUT.fullName })).toMatchObject({
      ok: false,
      errorCode: 'malformed_response',
    });
  });
});

describe('HunterProvider.findEmail：HTTP 契约', () => {
  it('命中：请求带 domain/api_key，返回 hit + accept_all + pattern + 成本，邮箱小写', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL) =>
      jsonResponse(200, domainSearchBody),
    );
    const provider = new HunterProvider(resolveHunterConfig({ HUNTER_API_KEY: 'key-1' }), fetchImpl);
    const outcome = await provider.findEmail(INPUT);
    expect(outcome).toMatchObject({
      status: 'hit',
      costMicrousd: 1_700,
      hit: {
        email: 'jurgen.mueller@acme.example',
        providerConfidence: 95,
        acceptAll: true,
        pattern: '{first}.{last}',
      },
    });
    const url = fetchImpl.mock.calls[0]?.[0] as URL;
    expect(url.origin + url.pathname).toBe('https://api.hunter.io/v2/domain-search');
    expect(url.searchParams.get('domain')).toBe('acme.example');
    expect(url.searchParams.get('api_key')).toBe('key-1');
  });

  it('无结果（200 但无同名）→ miss，成本 0', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        data: { accept_all: null, pattern: null, emails: [{ value: 'x@acme.example', first_name: 'A', last_name: 'B' }] },
      }),
    );
    const provider = new HunterProvider(resolveHunterConfig({ HUNTER_API_KEY: 'k' }), fetchImpl);
    expect(await provider.findEmail(INPUT)).toMatchObject({
      status: 'miss',
      costMicrousd: 0,
      detail: 'hunter_no_name_match',
    });
  });

  it('429 → 可重试；401 → 不可重试；5xx → 可重试；均不计费', async () => {
    const cases: Array<[number, string, boolean]> = [
      [429, 'rate_limited', true],
      [401, 'unauthorized', false],
      [503, 'provider_5xx', true],
    ];
    for (const [status, errorCode, retryable] of cases) {
      const provider = new HunterProvider(
        resolveHunterConfig({ HUNTER_API_KEY: 'k' }),
        vi.fn(async () => jsonResponse(status, {})),
      );
      expect(await provider.findEmail(INPUT)).toMatchObject({
        status: 'error',
        errorCode,
        retryable,
        costMicrousd: 0,
      });
    }
  });

  it('供应商返回域不一致/畸形邮箱 → invalid_payload（不计费、下一家）', async () => {
    const provider = new HunterProvider(
      resolveHunterConfig({ HUNTER_API_KEY: 'k' }),
      vi.fn(async () =>
        jsonResponse(200, {
          data: {
            emails: [{ value: 'jurgen@other.example', first_name: 'Jürgen', last_name: 'Müller' }],
          },
        }),
      ),
    );
    expect(await provider.findEmail(INPUT)).toMatchObject({
      status: 'error',
      errorCode: 'invalid_payload',
      retryable: false,
      costMicrousd: 0,
    });
  });

  it('网络错误 → 可重试；缺凭据 → provider_unconfigured 且不发请求', async () => {
    const network = new HunterProvider(
      resolveHunterConfig({ HUNTER_API_KEY: 'k' }),
      vi.fn(async () => {
        throw new TypeError('boom');
      }),
    );
    expect(await network.findEmail(INPUT)).toMatchObject({
      status: 'error',
      errorCode: 'network_error',
      retryable: true,
    });
    const fetchImpl = vi.fn();
    const unconfigured = new HunterProvider(resolveHunterConfig({}), fetchImpl);
    expect(await unconfigured.findEmail(INPUT)).toMatchObject({
      status: 'error',
      errorCode: 'provider_unconfigured',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
