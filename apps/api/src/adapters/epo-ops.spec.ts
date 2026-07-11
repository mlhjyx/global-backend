import { describe, expect, it, vi } from 'vitest';
import {
  buildApplicantCql,
  extractApplicants,
  extractInventors,
  extractPublicationYear,
  parseSearchResult,
  EpoOpsClient,
} from './epo-ops';

// ── 合成 OPS biblio-search JSON（SIEMENS/DE 假数据；exercise 单/数组 + epodoc/original + residence 泄漏防护）──
const OPS_JSON = {
  'ops:world-patent-data': {
    'ops:biblio-search': {
      '@total-result-count': '2',
      'ops:search-result': {
        'exchange-documents': [
          {
            'exchange-document': {
              '@country': 'EP',
              '@doc-number': '1000000',
              'bibliographic-data': {
                'publication-reference': {
                  'document-id': [
                    { '@document-id-type': 'docdb', date: { $: '20230115' } },
                  ],
                },
                parties: {
                  applicants: {
                    applicant: [
                      { '@sequence': '1', '@data-format': 'epodoc', 'applicant-name': { name: { $: 'SIEMENS AG' } }, residence: { country: { $: 'DE' } } },
                      { '@sequence': '1', '@data-format': 'original', 'applicant-name': { name: { $: 'Siemens Aktiengesellschaft' } } },
                    ],
                  },
                  inventors: {
                    inventor: [
                      // 🔴 epodoc 条带 residence + address —— 断言绝不泄漏进结果
                      { '@sequence': '1', '@data-format': 'epodoc', 'inventor-name': { name: { $: 'MUELLER HANS' } }, residence: { country: { $: 'DE' } }, address: { city: { $: 'Munich' } } },
                      { '@sequence': '1', '@data-format': 'original', 'inventor-name': { name: { $: 'Müller, Hans' } } },
                      { '@sequence': '2', '@data-format': 'epodoc', 'inventor-name': { name: { $: 'SCHMIDT ANNA' } } },
                      { '@sequence': '2', '@data-format': 'original', 'inventor-name': { name: { $: 'Schmidt, Anna' } } },
                    ],
                  },
                },
              },
            },
          },
          {
            // 第二篇：全用**单对象**（非数组）——测 asArray 双向兼容
            'exchange-document': {
              'bibliographic-data': {
                'publication-reference': { 'document-id': { '@document-id-type': 'docdb', date: { $: '20220601' } } },
                parties: {
                  applicants: { applicant: { '@sequence': '1', '@data-format': 'epodoc', 'applicant-name': { name: { $: 'SIEMENS AG' } }, residence: { country: { $: 'DE' } } } },
                  inventors: { inventor: { '@sequence': '1', '@data-format': 'original', 'inventor-name': { name: { $: 'Klaus Weber' } } } },
                },
              },
            },
          },
        ],
      },
    },
  },
};

/** 从 fixture 取第一篇的 parties（供 extract* 单测）。 */
function partiesOfDoc0(): Record<string, unknown> {
  const doc0 = OPS_JSON['ops:world-patent-data']['ops:biblio-search']['ops:search-result']['exchange-documents'][0]['exchange-document'];
  return (doc0['bibliographic-data'] as Record<string, unknown>).parties as Record<string, unknown>;
}

describe('EPO · buildApplicantCql（纯）', () => {
  it('pa + pd 年区间', () => {
    expect(buildApplicantCql('Siemens', 2021, 2026)).toBe('pa="Siemens" and pd within "2021 2026"');
  });
  it('🔴 去引号防 CQL 注入', () => {
    expect(buildApplicantCql('Ac"me" and pn=US', 2021, 2026)).toBe('pa="Ac me  and pn=US" and pd within "2021 2026"');
  });
});

describe('EPO · extractApplicants', () => {
  it('epodoc 归一名 + residence 国别（按 sequence 归组）', () => {
    expect(extractApplicants(partiesOfDoc0())).toEqual([{ name: 'SIEMENS AG', country: 'DE' }]);
  });
});

describe('EPO · extractInventors（🔴 数据最小化）', () => {
  it('original 语序名 + 按 sequence 去重（2 位发明人）', () => {
    expect(extractInventors(partiesOfDoc0())).toEqual([{ name: 'Müller, Hans' }, { name: 'Schmidt, Anna' }]);
  });

  it('🔴 结果每个 inventor 只含 name 键，绝不含 residence/address/city', () => {
    const invs = extractInventors(partiesOfDoc0());
    for (const inv of invs) expect(Object.keys(inv)).toEqual(['name']);
    expect(JSON.stringify(invs)).not.toMatch(/residence|address|Munich|"DE"|country/i);
  });
});

describe('EPO · extractPublicationYear', () => {
  it('YYYYMMDD → year', () => {
    expect(extractPublicationYear({ 'publication-reference': { 'document-id': { date: { $: '20230115' } } } })).toBe(2023);
  });
  it('缺 date → undefined', () => {
    expect(extractPublicationYear({})).toBeUndefined();
  });
});

describe('EPO · parseSearchResult（全解析 + 单/数组混合）', () => {
  const out = parseSearchResult(OPS_JSON);

  it('两篇专利各出 applicants + inventors + year', () => {
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      applicants: [{ name: 'SIEMENS AG', country: 'DE' }],
      inventors: [{ name: 'Müller, Hans' }, { name: 'Schmidt, Anna' }],
      publicationYear: 2023,
    });
    // 第二篇全单对象形态照样解析
    expect(out[1].inventors).toEqual([{ name: 'Klaus Weber' }]);
    expect(out[1].publicationYear).toBe(2022);
  });

  it('🔴 整体序列化：发明人侧无 residence/address/city 泄漏', () => {
    const allInventors = out.flatMap((p) => p.inventors);
    expect(JSON.stringify(allInventors)).not.toMatch(/residence|address|Munich|country/i);
  });

  it('空/畸形 JSON → []（防御式，不抛）', () => {
    expect(parseSearchResult({})).toEqual([]);
    expect(parseSearchResult(null)).toEqual([]);
    expect(parseSearchResult({ 'ops:world-patent-data': {} })).toEqual([]);
  });
});

// ── OAuth token 管理 + 检索（注入假 fetch/creds/clock）──────────────────────────

function tokenResponse(token: string, expiresIn = '1200'): Response {
  return new Response(JSON.stringify({ access_token: token, token_type: 'BearerToken', expires_in: expiresIn }), { status: 200 });
}

describe('EPO · getToken（Basic auth + 缓存 + 过期刷新）', () => {
  it('Basic base64(key:secret) + grant_type body；缓存复用；过期重取', async () => {
    let clock = 1_000_000;
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('K:S').toString('base64')}`);
      expect(init?.body).toBe('grant_type=client_credentials');
      return tokenResponse('TOK1');
    }) as unknown as typeof fetch;

    const client = new EpoOpsClient({ fetchImpl, consumerKey: 'K', consumerSecret: 'S', now: () => clock });
    expect(await client.getToken()).toBe('TOK1');
    expect(await client.getToken()).toBe('TOK1'); // 缓存命中，不重取
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    clock += 1_200_000; // 过期（TTL 1200s，含 60s 安全边界）
    await client.getToken();
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2); // 重取
  });

  it('无 creds → 抛（provider fail-safe 捕获）', async () => {
    const client = new EpoOpsClient({ fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch, consumerKey: '', consumerSecret: '' });
    await expect(client.getToken()).rejects.toThrow(/EPO_OPS_CONSUMER/);
  });
});

describe('EPO · searchPatentsByApplicant（token→search；401 刷新重试）', () => {
  it('先鉴权取 token → search 带 Bearer + CQL；解析命中', async () => {
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/auth/accesstoken')) return tokenResponse('TOKX');
      expect(u).toContain('/published-data/search/biblio');
      expect(decodeURIComponent(u)).toContain('pa="Siemens"');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer TOKX');
      return new Response(JSON.stringify(OPS_JSON), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new EpoOpsClient({ fetchImpl, consumerKey: 'K', consumerSecret: 'S' });
    const out = await client.searchPatentsByApplicant('Siemens', { fromYear: 2021, toYear: 2026 });
    expect(out).toHaveLength(2);
    expect(out[0].inventors).toEqual([{ name: 'Müller, Hans' }, { name: 'Schmidt, Anna' }]);
  });

  it('401 → 刷新 token 重试一次后成功', async () => {
    let searchCalls = 0;
    const fetchImpl = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/auth/accesstoken')) return tokenResponse(`TOK${searchCalls}`);
      searchCalls += 1;
      if (searchCalls === 1) return new Response('unauthorized', { status: 401 });
      return new Response(JSON.stringify(OPS_JSON), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new EpoOpsClient({ fetchImpl, consumerKey: 'K', consumerSecret: 'S' });
    const out = await client.searchPatentsByApplicant('Siemens', { fromYear: 2021, toYear: 2026 });
    expect(out).toHaveLength(2);
    expect(searchCalls).toBe(2); // 401 后重试
  });

  it('404 → []（无命中不抛）', async () => {
    const fetchImpl = (async (url: unknown) =>
      String(url).includes('/auth/') ? tokenResponse('T') : new Response('', { status: 404 })) as unknown as typeof fetch;
    const client = new EpoOpsClient({ fetchImpl, consumerKey: 'K', consumerSecret: 'S' });
    expect(await client.searchPatentsByApplicant('X', { fromYear: 2021, toYear: 2026 })).toEqual([]);
  });
});
