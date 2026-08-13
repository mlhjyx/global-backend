import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  robots: vi.fn(),
  crawlHtml: vi.fn(),
  wikidataSearch: vi.fn(),
  wikidataGet: vi.fn(),
  leiSearch: vi.fn(),
  directParent: vi.fn(),
  ultimateParent: vi.fn(),
  tedAwards: vi.fn(),
  tedContracts: vi.fn(),
  fdaRegistrations: vi.fn(),
  fdaClearances: vi.fn(),
  chSearch: vi.fn(),
  chOfficers: vi.fn(),
  inpi: vi.fn(),
  patents: vi.fn(),
  algolia: vi.fn(),
  sam: vi.fn(),
}));

vi.mock('../adapters/robots', () => ({ isAllowedByRobots: mocks.robots }));
vi.mock('../adapters/web-crawler', () => ({ crawlHtml: mocks.crawlHtml }));
vi.mock('../adapters/wikidata', () => ({
  wikidataSearchEntity: mocks.wikidataSearch,
  wikidataGetEntities: mocks.wikidataGet,
}));
vi.mock('../adapters/gleif', () => ({
  searchLeiRecords: mocks.leiSearch,
  getDirectParent: mocks.directParent,
  getUltimateParent: mocks.ultimateParent,
}));
vi.mock('../adapters/ted-api', () => ({
  searchAwardNotices: mocks.tedAwards,
  searchContractNotices: mocks.tedContracts,
}));
vi.mock('../adapters/openfda-api', () => ({
  searchRegistrations: mocks.fdaRegistrations,
  search510kClearances: mocks.fdaClearances,
}));
vi.mock('../adapters/companies-house', () => ({ searchCompanies: mocks.chSearch, listOfficers: mocks.chOfficers }));
vi.mock('../adapters/inpi-rne', () => ({ searchCompaniesWithDirigeants: mocks.inpi }));
vi.mock('../adapters/bigquery-patents', () => ({ bigqueryPatents: { searchPatentsByAssignee: mocks.patents } }));
vi.mock('../adapters/trade-fair-algolia', () => ({ queryAlgoliaExhibitors: mocks.algolia }));
vi.mock('../adapters/sam-api', () => ({ fetchSourcesSought: mocks.sam }));

import {
  crawl4aiRenderTool,
  wikidataEntityTool,
  gleifFetchTool,
  tedSearchTool,
  openFdaSearchTool,
  companiesHouseSearchTool,
  inpiRneSearchTool,
  googlePatentsSearchTool,
  tradeFairAlgoliaTool,
  mapYourShowFetchTool,
  samgovSearchTool,
  sanctionsDownloadTool,
  DEFAULT_SANCTIONS_UA,
  registerSourceTools,
} from './source-tools';

const ctx = { workspaceId: 'ws-1', authorizeExternalAction: vi.fn(async () => true) };

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

afterEach(() => vi.unstubAllGlobals());

describe('source tools governed adapter wrappers', () => {
  it('honors robots and only crawls an allowed page with provenance', async () => {
    mocks.robots.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mocks.crawlHtml.mockResolvedValue({ url: 'https://example.test', html: '<h1>ok</h1>', headers: {} });
    await expect(crawl4aiRenderTool.execute({ url: 'https://example.test' }, ctx)).resolves.toEqual({
      data: { url: 'https://example.test', html: '', headers: {}, robotsBlocked: true },
      costCents: 0,
    });
    const allowed = await crawl4aiRenderTool.execute({ url: 'https://example.test' }, ctx);
    expect(allowed).toMatchObject({ costCents: 1, provenance: { sourceUrl: 'https://example.test', parserVersion: 'crawl4ai/1' } });
    expect(mocks.crawlHtml).toHaveBeenCalledOnce();
  });

  it('routes every multi-operation structured wrapper to the exact adapter branch', async () => {
    mocks.wikidataSearch.mockResolvedValue([{ qid: 'Q1' }]);
    mocks.wikidataGet.mockResolvedValue({ Q1: { id: 'Q1' } });
    mocks.leiSearch.mockResolvedValue([{ lei: 'L1' }]);
    mocks.directParent.mockResolvedValue({ lei: 'P1' });
    mocks.ultimateParent.mockResolvedValue(null);
    mocks.tedAwards.mockResolvedValue([{ noticeId: 'A1' }]);
    mocks.tedContracts.mockResolvedValue([{ noticeId: 'C1' }]);
    mocks.fdaRegistrations.mockResolvedValue([{ registrationNumber: 'R1' }]);
    mocks.fdaClearances.mockResolvedValue([{ kNumber: 'K1' }]);
    mocks.chSearch.mockResolvedValue([{ companyNumber: '1' }]);
    mocks.chOfficers.mockResolvedValue([{ name: 'Director' }]);

    await expect(wikidataEntityTool.execute({ op: 'search', name: 'Acme' }, ctx)).resolves.toMatchObject({ data: { search: [{ qid: 'Q1' }] } });
    await expect(wikidataEntityTool.execute({ op: 'get', qids: ['Q1'] }, ctx)).resolves.toMatchObject({ data: { entities: { Q1: { id: 'Q1' } } } });
    await expect(gleifFetchTool.execute({ op: 'search', name: 'Acme' }, ctx)).resolves.toMatchObject({ data: { records: [{ lei: 'L1' }] } });
    await expect(gleifFetchTool.execute({ op: 'directParent', lei: 'L1' }, ctx)).resolves.toMatchObject({ data: { parent: { lei: 'P1' } } });
    await expect(gleifFetchTool.execute({ op: 'ultimateParent', lei: 'L1' }, ctx)).resolves.toMatchObject({ data: { parent: null } });
    await expect(tedSearchTool.execute({ kind: 'award', params: {} }, ctx)).resolves.toMatchObject({ data: { awards: [{ noticeId: 'A1' }] } });
    await expect(tedSearchTool.execute({ kind: 'contract', params: {} }, ctx)).resolves.toMatchObject({ data: { notices: [{ noticeId: 'C1' }] } });
    await expect(tedSearchTool.execute({ kind: 'other', params: {} } as never, ctx)).rejects.toThrow('unsupported kind');
    await expect(openFdaSearchTool.execute({ kind: 'registration', params: {} }, ctx)).resolves.toMatchObject({ data: { establishments: [{ registrationNumber: 'R1' }] } });
    await expect(openFdaSearchTool.execute({ kind: '510k', params: {} }, ctx)).resolves.toMatchObject({ data: { clearances: [{ kNumber: 'K1' }] } });
    await expect(openFdaSearchTool.execute({ kind: 'other', params: {} } as never, ctx)).rejects.toThrow('unsupported kind');
    await expect(companiesHouseSearchTool.execute({ op: 'search', query: 'Acme' }, ctx)).resolves.toMatchObject({ data: { companies: [{ companyNumber: '1' }] } });
    await expect(companiesHouseSearchTool.execute({ op: 'officers', companyNumber: '1' }, ctx)).resolves.toMatchObject({ data: { officers: [{ name: 'Director' }] } });
  });

  it('wraps the single-operation registry, patent, fair, and SAM adapters', async () => {
    mocks.inpi.mockResolvedValue([{ siren: '1' }]);
    mocks.patents.mockResolvedValue([{ publicationNumber: 'P1' }]);
    mocks.algolia.mockResolvedValue([{ id: 'E1' }]);
    mocks.sam.mockResolvedValue([{ noticeId: 'S1' }]);
    await expect(inpiRneSearchTool.execute({ op: 'search', query: 'Acme' }, ctx)).resolves.toMatchObject({ data: { companies: [{ siren: '1' }] } });
    await expect(googlePatentsSearchTool.execute({ applicant: 'Acme', fromYear: 2020, toYear: 2026 }, ctx)).resolves.toMatchObject({ data: { patents: [{ publicationNumber: 'P1' }] } });
    await expect(tradeFairAlgoliaTool.execute({ cfg: { appId: 'a', apiKey: 'k', indexName: 'i', eventEditionId: 'e' } }, ctx)).resolves.toMatchObject({ data: { exhibitors: [{ id: 'E1' }] } });
    await expect(samgovSearchTool.execute({ params: {} }, ctx)).resolves.toMatchObject({ data: { notices: [{ noticeId: 'S1' }] } });
  });

  it('bounds direct JSON/XML fetch wrappers and uses the sanctions default user agent', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ DATA: { results: { exhibitor: { hit: [{ fields: { exhid_l: '1' } }] } } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response('denied client_secret=hidden', { status: 503 }))
      .mockResolvedValueOnce(new Response('<xml/>', { status: 200, headers: { 'content-type': 'application/xml', 'last-modified': 'Wed, 12 Aug 2026 00:00:00 GMT' } }))
      .mockResolvedValueOnce(new Response('no', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(mapYourShowFetchTool.execute({ host: 'fair.mapyourshow.com' }, ctx)).resolves.toMatchObject({ data: { hits: [{ fields: { exhid_l: '1' } }] } });
    await expect(mapYourShowFetchTool.execute({ host: 'fair.mapyourshow.com', limit: 2 }, ctx)).rejects.not.toThrow('client_secret');
    const downloaded = await sanctionsDownloadTool.execute({ url: 'https://ofac.example/list.xml' }, ctx);
    expect(downloaded).toMatchObject({ data: { body: '<xml/>', contentType: 'application/xml' }, provenance: { parserVersion: 'sanctions-download/1' } });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ headers: { 'user-agent': DEFAULT_SANCTIONS_UA } });
    await expect(sanctionsDownloadTool.execute({ url: 'https://ofac.example/list.xml', userAgent: 'custom' }, ctx)).rejects.toThrow('HTTP 403');
  });

  it('registers every governed source tool exactly once', () => {
    const register = vi.fn();
    const registry = { register };
    expect(registerSourceTools(registry as never)).toBe(registry);
    expect(register).toHaveBeenCalledTimes(13);
    expect(new Set(register.mock.calls.map(([tool]) => tool.id)).size).toBe(13);
  });
});
