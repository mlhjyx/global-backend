import { describe, expect, it } from 'vitest';
import {
  ChannelManifestError,
  canonicalJson,
  configToManifest,
  deriveAllowedHosts,
  hostAllowed,
  manifestSha256,
  parseChannelManifest,
} from './channel-manifest';
import { CHANNEL_MANIFEST_VERSION } from '@global/contracts';

/** 章节 §6.3.3 示例 1：Companies House（HTTP Basic + page 分页）。 */
const COMPANIES_HOUSE = {
  meta: {
    name: 'Companies House 公司搜索',
    version: 1,
    category: 'directory',
    docsUrl: 'https://developer.company-information.service.gov.uk/',
  },
  transport: {
    baseUrl: 'https://api.company-information.service.gov.uk',
    method: 'GET',
    responseType: 'json',
    allowedHosts: ['api.company-information.service.gov.uk'],
    timeoutMs: 15000,
  },
  auth: {
    type: 'basic',
    usernameRef: 'channel/companies-house/api-key',
    passwordRef: 'channel/companies-house/empty-password',
  },
  pagination: {
    type: 'page',
    pageParam: 'page',
    startPage: 1,
    maxPages: 20,
    sizeParam: 'items_per_page',
    pageSize: 100,
  },
  rateLimit: { rps: 2, burst: 4, concurrency: 1, dailyRequests: 500, respectRetryAfter: true },
  records: { itemsPath: '$.items' },
  fieldMapping: {
    name: '$.title',
    website: '$.links.self',
    country: '$.registered_office_address.country',
  },
  transforms: { trim: true, websiteHttps: false },
  governance: {
    license: 'OGL-3.0',
    tosUrl: 'https://developer.company-information.service.gov.uk/developer-guidelines',
    robotsPolicy: 'B',
    personalData: false,
    allowedPurpose: ['discovery', 'enrichment'],
  },
  healthcheck: { path: '/search/companies?q=test&items_per_page=1', expectStatus: 200, maxLatencyMs: 5000 },
};

/** 章节 §6.3.3 示例 3：SAM.gov（apiKey 查询参数 + offset 分页）。 */
const SAMGOV = {
  meta: { name: 'SAM.gov opportunities', version: 1, category: 'tender' },
  transport: {
    baseUrl: 'https://api.sam.gov',
    method: 'GET',
    responseType: 'json',
    allowedHosts: ['api.sam.gov'],
    queryDefaults: { limit: '1000' },
  },
  auth: { type: 'apiKey', secretRef: 'channel/samgov/api-key', in: 'query', name: 'api_key' },
  pagination: { type: 'offset', offsetParam: 'offset', limitParam: 'limit', pageSize: 1000, maxPages: 10 },
  rateLimit: { rps: 0.5, concurrency: 1, dailyRequests: 10, respectRetryAfter: false },
  records: { itemsPath: '$.opportunitiesData' },
  fieldMapping: { name: '$.title', country: '$.placeOfPerformance.country', industry: '$.naicsCode' },
  governance: {
    license: 'public-domain',
    tosUrl: 'https://open.gsa.gov/terms-and-conditions',
    robotsPolicy: 'B',
    personalData: false,
    allowedPurpose: ['discovery', 'intent'],
  },
};

function issuePaths(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ChannelManifestError) return error.issues.map((issue) => issue.path);
    throw error;
  }
  throw new Error('expected ChannelManifestError');
}

describe('channel-manifest/v1 校验', () => {
  it('接受章节示例 1/3 并应用默认值', () => {
    const house = parseChannelManifest(COMPANIES_HOUSE);
    expect(house.transport.allowedHosts).toEqual(['api.company-information.service.gov.uk']);
    expect(house.transport.method).toBe('GET');
    expect(house.auth?.type).toBe('basic');
    const sam = parseChannelManifest(SAMGOV);
    expect(sam.pagination?.type).toBe('offset');
    expect(sam.auth?.type).toBe('apiKey');
  });

  it('允许省略 auth/allowedHosts（默认 none 与 baseUrl 域）', () => {
    const manifest = parseChannelManifest({
      meta: { name: 'X', version: 1, category: 'other' },
      transport: { baseUrl: 'https://api.example.com', responseType: 'json' },
      records: { itemsPath: '$.data' },
      fieldMapping: { name: '$.name' },
    });
    expect(manifest.auth).toEqual({ type: 'none' });
    expect(manifest.transport.allowedHosts).toEqual(['api.example.com']);
    expect(manifest.pagination).toEqual({ type: 'none' });
    expect(manifest.transport.method).toBe('GET');
  });

  it('schema 校验：缺 records（json 形态）/未知顶层键/非法 URL 均报实例路径', () => {
    expect(issuePaths(() => parseChannelManifest({ meta: { name: 'X', version: 1, category: 'other' }, transport: { baseUrl: 'https://a.example', responseType: 'json' } }))).toContain('/records');
    const extra = structuredClone(SAMGOV) as Record<string, unknown>;
    extra.scripts = { run: 'rm -rf /' };
    expect(issuePaths(() => parseChannelManifest(extra)).some((path) => path.startsWith('/'))).toBe(true);
    const http = structuredClone(SAMGOV) as { transport: { baseUrl: string } };
    http.transport.baseUrl = 'http://api.sam.gov';
    expect(issuePaths(() => parseChannelManifest(http))).toContain('/transport/baseUrl');
  });

  it('语义校验：baseUrl 域必须命中 allowedHosts（含子域通配）', () => {
    const bad = structuredClone(COMPANIES_HOUSE) as { transport: { allowedHosts: string[] } };
    bad.transport.allowedHosts = ['other.example.com'];
    expect(issuePaths(() => parseChannelManifest(bad))).toContain('/transport/allowedHosts');
    const wildcard = structuredClone(COMPANIES_HOUSE) as { transport: { allowedHosts: string[] } };
    wildcard.transport.allowedHosts = ['*.company-information.service.gov.uk'];
    expect(() => parseChannelManifest(wildcard)).not.toThrow();
  });

  it('语义校验：headers 禁止 Authorization/Cookie/X-Api-Key（认证必须走 auth）', () => {
    for (const name of ['Authorization', 'cookie', 'X-Api-Key', 'Proxy-Authorization']) {
      const bad = structuredClone(SAMGOV) as { transport: Record<string, unknown> };
      bad.transport.headers = { [name]: 'leak' };
      expect(issuePaths(() => parseChannelManifest(bad))).toContain(`/transport/headers/${name}`);
    }
  });

  it('语义校验：联系人字段只允许 detail.enabled=true', () => {
    const bad = structuredClone(SAMGOV) as { fieldMapping: Record<string, string> };
    bad.fieldMapping.email = '$.email';
    expect(issuePaths(() => parseChannelManifest(bad))).toContain('/fieldMapping/email');
    const withDetail = structuredClone(SAMGOV) as { fieldMapping: Record<string, string>; records: Record<string, unknown> };
    withDetail.fieldMapping.email = '$.email';
    withDetail.records.detail = { enabled: true, urlPath: '$.url' };
    expect(() => parseChannelManifest(withDetail)).not.toThrow();
  });

  it('语义校验：robotsPolicy=C 直接拒绝保存', () => {
    const bad = structuredClone(SAMGOV) as { governance: { robotsPolicy: string } };
    bad.governance.robotsPolicy = 'C';
    expect(issuePaths(() => parseChannelManifest(bad))).toContain('/governance/robotsPolicy');
  });

  it('语义校验：JSONPath 只允许受控子集', () => {
    const bad = structuredClone(SAMGOV) as { records: { itemsPath: string } };
    bad.records.itemsPath = '$.items[?(@.x)]';
    expect(issuePaths(() => parseChannelManifest(bad))).toContain('/records/itemsPath');
  });

  it('语义校验：apiKey/bearer 注入 query 必须给名字；header 类型必须有名字', () => {
    const queryNoName = structuredClone(SAMGOV) as { auth: Record<string, unknown> };
    delete queryNoName.auth.name;
    expect(issuePaths(() => parseChannelManifest(queryNoName))).toContain('/auth/name');
    const headerNoName = structuredClone(SAMGOV) as { auth: Record<string, unknown> };
    headerNoName.auth = { type: 'header', secretRef: 'channel/samgov/api-key' };
    expect(issuePaths(() => parseChannelManifest(headerNoName))).toContain('/auth/name');
  });

  it('采集 auth 引用（slot 与 ref），供密钥状态展示', () => {
    expect(parseChannelManifest(COMPANIES_HOUSE).auth).toMatchObject({ type: 'basic' });
    const house = parseChannelManifest(COMPANIES_HOUSE);
    expect(house.auth && house.auth.type === 'basic' ? [house.auth.usernameRef, house.auth.passwordRef] : []).toEqual([
      'channel/companies-house/api-key',
      'channel/companies-house/empty-password',
    ]);
  });

  it('canonicalJson/manifestSha256：键序无关、内容相关', () => {
    const a = { b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } };
    const b = { a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(manifestSha256(a)).toBe(manifestSha256(b));
    expect(manifestSha256(a)).toMatch(/^[0-9a-f]{64}$/u);
    expect(manifestSha256(a)).not.toBe(manifestSha256({ ...a, b: 2 }));
    expect(CHANNEL_MANIFEST_VERSION).toBe('channel-manifest/v1');
  });

  it('hostAllowed：精确与 *.通配', () => {
    expect(hostAllowed('api.example.com', ['api.example.com'])).toBe(true);
    expect(hostAllowed('a.example.com', ['*.example.com'])).toBe(true);
    expect(hostAllowed('example.com', ['*.example.com'])).toBe(false);
    expect(hostAllowed('evil-example.com', ['*.example.com'])).toBe(false);
    expect(deriveAllowedHosts(parseChannelManifest(SAMGOV))).toEqual(['api.sam.gov']);
  });

  it('configToManifest：17 行历史 crawl config 语义不变', () => {
    const manifest = configToManifest('crawl', {
      list: {
        url: 'https://expo.example/exhibitors?page={page}',
        maxPages: 5,
        itemSelector: '.card',
        itemUrlSelector: 'a::attr(href)',
      },
      detail: { enabled: true, fields: { name: 'h1', website: 'a.site::attr(href)' } },
    });
    expect(manifest).not.toBeNull();
    expect(manifest!.transport.baseUrl).toBe('https://expo.example');
    expect(manifest!.transport.responseType).toBe('html');
    expect(manifest!.crawl!.list.itemSelector).toBe('.card');
    expect(manifest!.crawl!.list.maxPages).toBe(5);
    expect(manifest!.pagination).toMatchObject({ type: 'page', pageParam: 'page', startPage: 1 });
    // 转换产物必须能通过同一校验器（过渡期双解析）。
    expect(() => parseChannelManifest(manifest)).not.toThrow();
  });

  it('configToManifest：legacy api/import 无 manifest 语义，返回 null', () => {
    expect(configToManifest('api', { adapter: 'x' })).toBeNull();
    expect(configToManifest('import', {})).toBeNull();
    expect(configToManifest('crawl', { garbage: true })).toBeNull();
  });
});
