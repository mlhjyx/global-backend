import { describe, expect, it, vi } from 'vitest';
import {
  HunterProvider,
  parseHunterDomainSearch,
  parseHunterEmailFinder,
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
  it('缺省值：无 key、官方 baseUrl、15s 超时、1700 微美元；非法值回退', () => {
    expect(resolveHunterConfig({})).toEqual({
      apiKey: null,
      baseUrl: 'https://api.hunter.io',
      timeoutMs: 15_000,
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
      timeoutMs: 15_000,
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

describe('HunterProvider.findEmail：HTTP 契约（/v2/email-finder）', () => {
  const emailFinderBody = {
    data: {
      first_name: 'Jürgen',
      last_name: 'Müller',
      email: 'Jurgen.Mueller@acme.example',
      score: 95,
      domain: 'acme.example',
      accept_all: true,
      position: 'Head of Procurement',
      verification: { status: 'accept_all' },
    },
  };

  it('parseHunterEmailFinder：解析单人命中、null miss 与 invalid 过滤', () => {
    expect(parseHunterEmailFinder(emailFinderBody)).toMatchObject({
      ok: true,
      acceptAll: true,
      verificationStatus: 'accept_all',
      position: 'Head of Procurement',
      missReason: null,
      match: { email: 'Jurgen.Mueller@acme.example', confidence: 95 },
    });
    expect(parseHunterEmailFinder({ data: { email: null } })).toMatchObject({
      ok: true,
      match: null,
      missReason: 'no_match',
    });
    expect(
      parseHunterEmailFinder({ data: { email: 'dead@acme.example', verification: { status: 'invalid' } } }),
    ).toMatchObject({
      ok: true,
      match: null,
      missReason: 'invalid_verification',
    });
  });

  it('命中：请求 /v2/email-finder 带 domain/first_name/last_name/api_key，返回 hit + accept_all + 成本，邮箱小写', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL) =>
      jsonResponse(200, emailFinderBody),
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
        pattern: null,
      },
    });
    const url = fetchImpl.mock.calls[0]?.[0] as URL;
    expect(url.origin + url.pathname).toBe('https://api.hunter.io/v2/email-finder');
    expect(url.searchParams.get('domain')).toBe('acme.example');
    expect(url.searchParams.get('first_name')).toBe('jurgen');
    expect(url.searchParams.get('last_name')).toBe('muller');
    expect(url.searchParams.get('api_key')).toBe('key-1');
  });

  it('无结果（200 但 data.email=null）→ miss，成本 0', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        data: { email: null, accept_all: null, score: 0 },
      }),
    );
    const provider = new HunterProvider(resolveHunterConfig({ HUNTER_API_KEY: 'k' }), fetchImpl);
    expect(await provider.findEmail(INPUT)).toMatchObject({
      status: 'miss',
      costMicrousd: 0,
      detail: 'hunter_no_match',
    });
  });

  it('确定性 4xx（400/404/422/451 合法 Hunter errors 载荷）→ miss（成本 0）；鉴权/计费/畸形体仍为 error', async () => {
    for (const [status, id] of [
      [400, 'wrong_params'],
      [400, 'invalid_full_name'],
      [400, 'invalid_domain'],
      [404, 'not_found'],
      [422, 'unprocessable_entity'],
      [451, 'claimed_email'],
    ] as const) {
      const provider = new HunterProvider(
        resolveHunterConfig({ HUNTER_API_KEY: 'k' }),
        vi.fn(async () => jsonResponse(status, { errors: [{ id, code: status, details: 'deterministic miss' }] })),
      );
      expect(await provider.findEmail(INPUT)).toMatchObject({
        status: 'miss',
        costMicrousd: 0,
        detail: `hunter_http_${status}_${id}`,
      });
    }

    for (const [status, body] of [
      [400, { errors: [{ id: 'insufficient_credits', code: 400, details: 'No credits left' }] }],
      [400, { errors: [{ id: 'invalid_api_key', code: 401, details: 'Bad key' }] }],
      [400, { errors: [{ id: 'too_many_requests', code: 429, details: 'Rate limited' }] }],
      [400, {}],
      [404, { message: 'nginx not found' }],
    ] as const) {
      const provider = new HunterProvider(
        resolveHunterConfig({ HUNTER_API_KEY: 'k' }),
        vi.fn(async () => jsonResponse(status, body)),
      );
      expect(await provider.findEmail(INPUT)).toMatchObject({
        status: 'error',
        retryable: false,
        costMicrousd: 0,
      });
    }

    const htmlError = new HunterProvider(
      resolveHunterConfig({ HUNTER_API_KEY: 'k' }),
      vi.fn(async () => new Response('<html>Bad Request</html>', { status: 400 })),
    );
    expect(await htmlError.findEmail(INPUT)).toMatchObject({
      status: 'error',
      errorCode: 'provider_http_error',
      retryable: false,
      costMicrousd: 0,
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

  it('支持同集团跨国别 TLD 邮箱（如 enpal.com → @enpal.de、memodo.it → @memodo.de），仍拒绝无关域', async () => {
    for (const [domain, email] of [
      ['enpal.com', 'mario.kohle@enpal.de'],
      ['memodo.it', 'tobias.michl@memodo.de'],
      ['centroplan.com', 'niklas.reinartz@centroplan.de'],
    ] as const) {
      const provider = new HunterProvider(
        resolveHunterConfig({ HUNTER_API_KEY: 'k' }),
        vi.fn(async () => jsonResponse(200, { data: { email, score: 92, accept_all: false } })),
      );
      expect(await provider.findEmail({ ...INPUT, domain })).toMatchObject({
        status: 'hit',
        hit: { email },
        costMicrousd: 1_700,
      });
    }
  });

  it('供应商返回域不一致/畸形邮箱 → invalid_payload（不计费、下一家）', async () => {
    const provider = new HunterProvider(
      resolveHunterConfig({ HUNTER_API_KEY: 'k' }),
      vi.fn(async () =>
        jsonResponse(200, {
          data: {
            email: 'jurgen@other.example',
            score: 88,
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
