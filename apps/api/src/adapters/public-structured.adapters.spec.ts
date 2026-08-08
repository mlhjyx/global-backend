import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDirectParent, getUltimateParent, searchLeiRecords } from './gleif';
import { queryAlgoliaExhibitors } from './trade-fair-algolia';
import { searxSearch, searxSearchPaged } from './searxng';
import {
  discoverCompaniesByIndustry,
  parseCompanyFacts,
  referencedQids,
  runSparql,
  wikidataGetEntities,
  wikidataSearchEntity,
  type RawEntity,
} from './wikidata';

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function claim(value: unknown, when?: string) {
  return {
    mainsnak: { datavalue: { value } },
    ...(when
      ? { qualifiers: { P585: [{ datavalue: { value: { time: when } } }] } }
      : {}),
  };
}

describe('public structured adapters', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  describe('SearXNG', () => {
    it('serializes optional query controls and normalizes missing response collections', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(response({ results: [{ url: 'https://a.example', title: 'A' }] }));

      const result = await searxSearch({
        q: 'industrial pumps',
        categories: ['general', 'news'],
        engines: ['wikidata'],
        language: 'de',
        timeRange: 'month',
        pageno: 2,
        safesearch: 2,
      }, 50);

      expect(result).toEqual({
        results: [{ url: 'https://a.example', title: 'A' }],
        suggestions: [],
        infoboxes: [],
        numberOfResults: 1,
      });
      const called = new URL(String(vi.mocked(fetch).mock.calls[0]?.[0]));
      expect(called.searchParams.get('categories')).toBe('general,news');
      expect(called.searchParams.get('engines')).toBe('wikidata');
      expect(called.searchParams.get('language')).toBe('de');
      expect(called.searchParams.get('time_range')).toBe('month');
      expect(called.searchParams.get('pageno')).toBe('2');
      expect(called.searchParams.get('safesearch')).toBe('2');
    });

    it('uses defaults and honors explicit aggregate values', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(response({
        results: [],
        suggestions: ['pump'],
        infoboxes: [{ id: 1 }],
        numberOfResults: 42,
      }));
      await expect(searxSearch({ q: 'pump' })).resolves.toMatchObject({ numberOfResults: 42 });
      const called = new URL(String(vi.mocked(fetch).mock.calls[0]?.[0]));
      expect(called.searchParams.get('language')).toBe('en');
      expect(called.searchParams.has('pageno')).toBe(false);
      expect(called.searchParams.get('safesearch')).toBe('0');
    });

    it('deduplicates pages and stops on an empty page or a failed page', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(response({ results: [
          { url: 'https://a.example', title: 'A' },
          { url: 'https://b.example', title: 'B' },
        ] }))
        .mockResolvedValueOnce(response({ results: [
          { url: 'https://b.example', title: 'B duplicate' },
          { url: 'https://c.example', title: 'C' },
        ] }))
        .mockResolvedValueOnce(response({ results: [] }));
      await expect(searxSearchPaged({ q: 'pump' }, 5)).resolves.toEqual([
        { url: 'https://a.example', title: 'A' },
        { url: 'https://b.example', title: 'B' },
        { url: 'https://c.example', title: 'C' },
      ]);

      vi.mocked(fetch)
        .mockResolvedValueOnce(response({ results: [{ url: 'https://a.example', title: 'A' }] }))
        .mockRejectedValueOnce(new Error('network'));
      await expect(searxSearchPaged({ q: 'pump' }, 3)).resolves.toEqual([
        { url: 'https://a.example', title: 'A' },
      ]);
    });

    it('does not disclose an upstream error body', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(response('token=searx-secret jane@example.com', { status: 502 }));
      const error = await searxSearch({ q: 'pump' }).catch((caught) => caught as Error);
      expect(error.message).toContain('searxng 502');
      expect(error.message).toMatch(/ERROR_TEXT_SHA256:[0-9a-f]{64}/);
      expect(error.message).not.toContain('searx-secret');
      expect(error.message).not.toContain('jane@example.com');
    });
  });

  describe('GLEIF', () => {
    it('maps valid LEI records, omits invalid rows, and clamps the limit', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(response({
        data: [
          {
            attributes: {
              lei: 'LEI-1',
              entity: {
                legalName: { name: 'Pump GmbH' },
                legalForm: { id: 'HRB' },
                status: 'ACTIVE',
                legalAddress: { city: 'Berlin', country: 'DE' },
              },
              registration: { status: 'ISSUED' },
            },
            relationships: {
              'direct-parent': { links: { 'relationship-record': '/parent' } },
              'ultimate-parent': { links: { 'relationship-record': '/ultimate' } },
            },
          },
          { attributes: { lei: 'MISSING-NAME' } },
        ],
      }));

      await expect(searchLeiRecords({ name: 'Pump', country: 'de', limit: 500 })).resolves.toEqual([
        {
          lei: 'LEI-1',
          legalName: 'Pump GmbH',
          legalFormId: 'HRB',
          entityStatus: 'ACTIVE',
          registrationStatus: 'ISSUED',
          country: 'DE',
          city: 'Berlin',
          hasDirectParent: true,
          hasUltimateParent: true,
        },
      ]);
      const called = new URL(String(vi.mocked(fetch).mock.calls[0]?.[0]));
      expect(called.searchParams.get('filter[entity.legalAddress.country]')).toBe('DE');
      expect(called.searchParams.get('page[size]')).toBe('50');
    });

    it('uses search defaults and maps missing optional relationship fields', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(response({ data: [{
        attributes: { lei: 'LEI-2', entity: { legalName: { name: 'Bare AG' } } },
      }] }));
      await expect(searchLeiRecords({ name: 'Bare' })).resolves.toEqual([
        expect.objectContaining({
          lei: 'LEI-2',
          legalName: 'Bare AG',
          legalFormId: undefined,
          hasDirectParent: false,
          hasUltimateParent: false,
        }),
      ]);
    });

    it('treats absent parents as normal and maps direct/ultimate parent facts', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(response('', { status: 404 }))
        .mockResolvedValueOnce(response({ data: {
          attributes: {
            lei: 'PARENT-1',
            entity: { legalName: { name: 'Parent SE' }, legalAddress: { country: 'DE' } },
          },
        } }))
        .mockResolvedValueOnce(response({ data: null }));
      await expect(getDirectParent('LEI/unsafe')).resolves.toBeNull();
      await expect(getUltimateParent('LEI-1')).resolves.toEqual({
        lei: 'PARENT-1',
        legalName: 'Parent SE',
        country: 'DE',
      });
      await expect(getUltimateParent('LEI-2')).resolves.toBeNull();
      expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain('LEI%2Funsafe');
    });

    it('does not disclose search or parent upstream error bodies', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(response('token=gleif-secret jane@example.com', { status: 400 }))
        .mockResolvedValueOnce(response('token=parent-secret jane@example.com', { status: 400 }));
      for (const action of [
        () => searchLeiRecords({ name: 'Pump' }),
        () => getDirectParent('LEI-1'),
      ]) {
        const error = await action().catch((caught) => caught as Error);
        expect(error.message).toMatch(/ERROR_TEXT_SHA256:[0-9a-f]{64}/);
        expect(error.message).not.toContain('secret');
        expect(error.message).not.toContain('jane@example.com');
      }
    });
  });

  describe('Algolia trade fairs', () => {
    const cfg = {
      appId: 'APP',
      apiKey: ['public', 'search', 'fixture'].join('-'),
      indexName: 'fair/index',
      eventEditionId: 'edition-1',
    };

    it('maps, deduplicates, paginates, caps fields, and detects hiring', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(response({
          nbPages: 2,
          hits: [
            {
              objectID: '1',
              companyName: ' Pump GmbH ',
              website: 'https://pump.example',
              email: 'info@pump.example',
              phone: '123',
              countryName: 'Germany',
              standReference: 'A1',
              exhibitorDescription: 'x'.repeat(600),
              products: Array.from({ length: 14 }, (_, index) => ({ name: index === 2 ? '' : `P${index}` })),
              exhibitorFilters: { jobs: { lvl0: ['Hiring now'] } },
            },
            { id: '2', exhibitorName: 'Second', products: [] },
            { objectID: 'invalid', companyName: '   ' },
          ],
        }))
        .mockResolvedValueOnce(response({ nbPages: 2, hits: [
          { objectID: '1', companyName: 'Duplicate' },
          { objectID: '3', companyName: 'Third' },
        ] }));

      const rows = await queryAlgoliaExhibitors(cfg, 10);

      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({
        externalId: '1',
        companyName: 'Pump GmbH',
        hiring: true,
      });
      expect(rows[0]?.description).toHaveLength(500);
      expect(rows[0]?.products).toHaveLength(12);
      expect(rows[1]).toMatchObject({ externalId: '2', companyName: 'Second', hiring: undefined });
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
      expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain('fair%2Findex');
    });

    it('uses locale defaults, stops on an empty first page, and enforces the result limit', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(response({ nbPages: 4, hits: [
          { objectID: '1', companyName: 'First' },
          { objectID: '2', companyName: 'Second' },
        ] }))
        .mockResolvedValueOnce(response({ hits: [] }));
      await expect(queryAlgoliaExhibitors({ ...cfg, locale: 'de-de' }, 1)).resolves.toHaveLength(1);
      await expect(queryAlgoliaExhibitors(cfg, 4)).resolves.toEqual([]);
    });

    it('does not disclose an upstream error body', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(response('token=algolia-secret jane@example.com', { status: 403 }));
      const error = await queryAlgoliaExhibitors(cfg).catch((caught) => caught as Error);
      expect(error.message).toMatch(/ERROR_TEXT_SHA256:[0-9a-f]{64}/);
      expect(error.message).not.toContain('algolia-secret');
      expect(error.message).not.toContain('jane@example.com');
    });
  });

  describe('Wikidata', () => {
    it('skips empty industry input and maps valid SPARQL bindings', async () => {
      await expect(discoverCompaniesByIndustry({ industryQids: [] })).resolves.toEqual([]);
      expect(fetch).not.toHaveBeenCalled();

      vi.mocked(fetch).mockResolvedValueOnce(response({ results: { bindings: [
        {
          company: { type: 'uri', value: 'http://www.wikidata.org/entity/Q1' },
          companyLabel: { type: 'literal', value: 'Pump GmbH' },
          website: { type: 'literal', value: 'https://pump.example' },
          employees: { type: 'literal', value: '42' },
          countryCode: { type: 'literal', value: 'DE' },
          coord: { type: 'literal', value: 'Point(13.4 52.5)' },
        },
        { company: { type: 'uri', value: 'http://www.wikidata.org/entity/Q2' }, companyLabel: { type: 'literal', value: 'Q2' } },
        { companyLabel: { type: 'literal', value: 'No URI' } },
      ] } }));
      await expect(discoverCompaniesByIndustry({
        industryQids: ['Q123'],
        countryQid: 'Q183',
        requireWebsite: false,
        limit: 500,
      })).resolves.toEqual([{
        qid: 'Q1',
        name: 'Pump GmbH',
        website: 'https://pump.example',
        employees: 42,
        countryCode: 'DE',
        latitude: 52.5,
        longitude: 13.4,
      }]);
      const query = decodeURIComponent(String(vi.mocked(fetch).mock.calls[0]?.[0]));
      expect(query).toContain('OPTIONAL { ?company wdt:P856 ?website }');
      expect(query).toContain('?company wdt:P17 wd:Q183');
      expect(query).toContain('LIMIT 200');
    });

    it('builds required-website queries and normalizes absent SPARQL results', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(response({}));
      await expect(discoverCompaniesByIndustry({ industryQids: ['Q1'] })).resolves.toEqual([]);
      const query = decodeURIComponent(String(vi.mocked(fetch).mock.calls[0]?.[0]));
      expect(query).toContain('?company wdt:P856 ?website');
    });

    it('searches entities, drops incomplete rows, and batches entity fetches', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(response({ search: [
          { id: 'Q1', label: 'Pump', description: 'company' },
          { id: '', label: 'Bad' },
          { id: 'Q2' },
        ] }))
        .mockResolvedValueOnce(response({ entities: { Q1: { labels: { en: { value: 'Pump' } } } } }));
      await expect(wikidataSearchEntity('Pump & Valve', 200)).resolves.toEqual([
        { qid: 'Q1', label: 'Pump', description: 'company' },
      ]);
      await expect(wikidataGetEntities(['Q1'], 'labels')).resolves.toHaveProperty('Q1');
      expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain('limit=20');
      await expect(wikidataGetEntities([])).resolves.toEqual({});
    });

    it('parses rich and sparse company facts and referenced QIDs', () => {
      const entity: RawEntity = {
        labels: { en: { value: 'Pump GmbH' } },
        claims: {
          P31: [claim({ id: 'Q4830453' })],
          P452: [claim({ id: 'QIND' }), claim({ id: 'QUNKNOWN' })],
          P1056: [claim({ id: 'QPRODUCT' })],
          P1128: [claim({ amount: '+20' }, '+2024-01-01T00:00:00Z'), claim({ amount: '+25' }, '+2025-01-01T00:00:00Z'), claim({})],
          P571: [claim({ time: '+1999-01-01T00:00:00Z' })],
          P749: [claim({ id: 'QPARENT' })],
          P355: [claim({ id: 'QSUB1' }), claim({ id: 'QSUB2' })],
          P1278: [claim('LEI-1')],
          P946: [claim('ISIN-1')],
          P856: [claim('https://pump.example')],
          P17: [claim({ id: 'QCOUNTRY' })],
          P159: [claim({ id: 'QCITY' })],
          P414: [claim({ id: 'QEXCHANGE' })],
        },
      };
      const labels = {
        QIND: 'pump industry',
        QPRODUCT: 'centrifugal pump',
        QPARENT: 'Parent SE',
        QCOUNTRY: 'Germany',
        QCITY: 'Berlin',
        QEXCHANGE: 'Frankfurt',
      };
      expect(parseCompanyFacts('Q1', entity, labels)).toEqual({
        qid: 'Q1',
        label: 'Pump GmbH',
        isCompany: true,
        website: 'https://pump.example',
        industries: ['pump industry'],
        products: ['centrifugal pump'],
        employees: 25,
        inceptionYear: 1999,
        parentQid: 'QPARENT',
        parentName: 'Parent SE',
        subsidiaryCount: 2,
        lei: 'LEI-1',
        isin: 'ISIN-1',
        countryQid: 'QCOUNTRY',
        countryName: 'Germany',
        headquartersName: 'Berlin',
        stockExchangeName: 'Frankfurt',
      });
      expect(new Set(referencedQids(entity))).toEqual(new Set([
        'QIND', 'QUNKNOWN', 'QPRODUCT', 'QPARENT', 'QCOUNTRY', 'QCITY', 'QEXCHANGE',
      ]));
      expect(parseCompanyFacts('QEMPTY', {}, {})).toMatchObject({
        label: 'QEMPTY',
        isCompany: false,
        industries: [],
        products: [],
        employees: undefined,
        inceptionYear: undefined,
        subsidiaryCount: undefined,
      });
    });

    it.each([
      ['sparql', () => runSparql('SELECT * WHERE {}')],
      ['search', () => wikidataSearchEntity('Pump')],
      ['entities', () => wikidataGetEntities(['Q1'])],
    ])('does not disclose a %s upstream error body', async (_kind, action) => {
      vi.mocked(fetch).mockResolvedValueOnce(response('token=wikidata-secret jane@example.com', { status: 502 }));
      const error = await action().catch((caught) => caught as Error);
      expect(error.message).toMatch(/ERROR_TEXT_SHA256:[0-9a-f]{64}/);
      expect(error.message).not.toContain('wikidata-secret');
      expect(error.message).not.toContain('jane@example.com');
    });
  });
});
