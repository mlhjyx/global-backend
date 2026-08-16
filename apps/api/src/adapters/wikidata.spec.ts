import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverCompaniesByIndustry } from './wikidata';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Wikidata structured company discovery', () => {
  it('requests LEI facts, orders results deterministically and parses strong identifiers', async () => {
    const fetchMock = vi.fn(async (rawUrl: string | URL | Request) => {
      const url = new URL(String(rawUrl));
      const query = url.searchParams.get('query') ?? '';
      expect(query).toContain('OPTIONAL { ?company wdt:P1278 ?lei }');
      expect(query).toContain('?company wdt:P17 ?country . FILTER(?country = wd:Q183)');
      expect(query).toContain('OPTIONAL { ?country wdt:P297 ?countryCode }');
      expect(query).not.toContain('?company wdt:P17 wd:Q183');
      expect(query).toMatch(/ORDER BY STR\(\?company\) STR\(\?website\) STR\(\?lei\)\s+LIMIT 2/u);
      return new Response(
        JSON.stringify({
          results: {
            bindings: [
              {
                company: { type: 'uri', value: 'http://www.wikidata.org/entity/Q123' },
                companyLabel: { type: 'literal', value: 'Acme GmbH' },
                website: { type: 'uri', value: 'https://www.acme.example/' },
                employees: { type: 'literal', value: '120' },
                countryCode: { type: 'literal', value: 'de' },
                lei: { type: 'literal', value: '529900T8BM49AURSDO55' },
                coord: { type: 'literal', value: 'Point(8.6821 50.1109)' },
              },
              {
                company: { type: 'uri', value: 'http://www.wikidata.org/entity/Q123' },
                companyLabel: { type: 'literal', value: 'Acme GmbH' },
                website: { type: 'uri', value: 'https://www.z-acme.example/' },
                countryCode: { type: 'literal', value: 'DE' },
              },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/sparql-results+json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      discoverCompaniesByIndustry({ industryQids: ['Q19541171'], countryQid: 'Q183', limit: 2 }),
    ).resolves.toEqual([
      {
        qid: 'Q123',
        name: 'Acme GmbH',
        website: 'https://www.acme.example/',
        employees: 120,
        countryCode: 'DE',
        lei: '529900T8BM49AURSDO55',
        latitude: 50.1109,
        longitude: 8.6821,
      },
    ]);
  });

  it('drops malformed entity identifiers at the provider boundary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            results: {
              bindings: [
                {
                  company: { type: 'uri', value: 'https://evil.example/not-a-qid' },
                  companyLabel: { type: 'literal', value: 'Not a Wikidata entity' },
                },
              ],
            },
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(discoverCompaniesByIndustry({ industryQids: ['Q19541171'] })).resolves.toEqual([]);
  });

  it('fails closed when the SPARQL schema drifts or the body exceeds the byte cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ results: {} }), { status: 200 })));
    await expect(discoverCompaniesByIndustry({ industryQids: ['Q19541171'] }))
      .rejects.toThrow(/schema changed/u);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'content-length': String(4 * 1024 * 1024 + 1) },
    })));
    await expect(discoverCompaniesByIndustry({ industryQids: ['Q19541171'] }))
      .rejects.toThrow(/too large/u);
  });
});
