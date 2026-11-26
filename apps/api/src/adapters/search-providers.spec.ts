import { describe, expect, it, vi } from 'vitest';
import {
  exaFindSimilar,
  exaSearch,
  googlePlacesSearchText,
  parseExaPeopleHit,
  sanitizeSearchProviderUrl,
  serperSearch,
} from './search-providers';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('search-providers adapters (Serper / Exa / Google Places)', () => {
  it('filters google.com/goto redirects and junk hosts from search URLs', () => {
    expect(
      sanitizeSearchProviderUrl('https://www.google.com/goto?url=https://spam.example/'),
    ).toBeNull();
    expect(
      sanitizeSearchProviderUrl('https://google.de/url?q=https://example.de/'),
    ).toBeNull();
    expect(
      sanitizeSearchProviderUrl('https://webcache.googleusercontent.com/search?q=cache:abc'),
    ).toBeNull();
    expect(
      sanitizeSearchProviderUrl('https://user:pass@solar-epc.de/'),
    ).toBeNull();
    expect(sanitizeSearchProviderUrl('https://solar-epc.de/products')).toBe(
      'https://solar-epc.de/products',
    );
  });

  it('serperSearch posts X-API-KEY, strips redirects/snippets, and calls beforeRequest', async () => {
    const beforeRequest = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        organic: [
          {
            link: 'https://www.google.com/goto?url=https://redirect.example/',
            title: 'Redirect noise',
          },
          {
            link: 'https://energiaviva.it/fotovoltaico',
            title: 'Energia Viva S.r.l. - Fotovoltaico',
            snippet: 'Personal name John Doe should never leave adapter',
          },
        ],
      }),
    ) as unknown as typeof fetch;

    const result = await serperSearch(
      { query: 'fotovoltaico EPC Italia', num: 10, gl: 'IT', hl: 'it' },
      { apiKey: 'test-serper-key', fetchImpl, beforeRequest },
    );

    expect(beforeRequest).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://google.serper.dev/search',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: expect.objectContaining({ 'X-API-KEY': 'test-serper-key' }),
      }),
    );
    expect(result).toEqual({
      billed: true,
      hits: [{ url: 'https://energiaviva.it/fotovoltaico', title: 'Energia Viva S.r.l. - Fotovoltaico' }],
    });
  });

  it('exaSearch and exaFindSimilar return only sanitized url + title', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            { url: 'https://solargrid.de/', title: 'SolarGrid GmbH', text: 'raw text' },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            { url: 'https://helios-epc.es/', title: 'Helios EPC S.L.' },
          ],
        }),
      ) as unknown as typeof fetch;

    const searched = await exaSearch(
      { query: 'commercial solar EPC Germany', numResults: 5 },
      { apiKey: 'test-exa-key', fetchImpl },
    );
    expect(searched.hits).toEqual([{ url: 'https://solargrid.de/', title: 'SolarGrid GmbH' }]);

    const similar = await exaFindSimilar(
      { url: 'https://solargrid.de/', numResults: 5 },
      { apiKey: 'test-exa-key', fetchImpl },
    );
    expect(similar.hits).toEqual([{ url: 'https://helios-epc.es/', title: 'Helios EPC S.L.' }]);
  });

  it('googlePlacesSearchText requests minimal field mask (D4 §3.2.3) and parses countryCode', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        places: [
          {
            id: 'ChIJ123456',
            displayName: { text: 'Solartechnik München GmbH' },
            websiteUri: 'https://solartechnik-muenchen.de/',
            addressComponents: [
              { shortText: 'DE', types: ['country', 'political'] },
            ],
          },
        ],
      }),
    ) as unknown as typeof fetch;

    const result = await googlePlacesSearchText(
      { textQuery: 'Photovoltaik Großhandel München', regionCode: 'DE', languageCode: 'de' },
      { apiKey: 'test-maps-key', fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://places.googleapis.com/v1/places:searchText',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Goog-Api-Key': 'test-maps-key',
          'X-Goog-FieldMask': 'places.id,places.displayName,places.websiteUri,places.addressComponents',
        }),
      }),
    );
    expect(result).toEqual({
      billed: true,
      places: [
        {
          placeId: 'ChIJ123456',
          name: 'Solartechnik München GmbH',
          websiteUri: 'https://solartechnik-muenchen.de/',
          countryCode: 'DE',
        },
      ],
    });
  });

  it('throws auth error without retrying on HTTP 401', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401)) as unknown as typeof fetch;
    await expect(
      serperSearch({ query: 'solar' }, { apiKey: 'bad-key', fetchImpl }),
    ).rejects.toThrow('SERPER_SEARCH_API_KEY_REJECTED');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('exaSearch in people mode omits excludeDomains (avoiding HTTP 400) and parses entities/author hits', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      expect(sent.category).toBe('people');
      expect(sent).not.toHaveProperty('excludeDomains');
      return jsonResponse({
        results: [
          {
            url: 'https://exa.ai/library/person/abc-123',
            title: 'Marco Rossi | Exa',
            entities: [
              {
                properties: {
                  name: 'Marco Rossi',
                  role: 'Responsabile Acquisti',
                  company: 'Coenergia Srl',
                  linkedinUrl: 'https://it.linkedin.com/in/marco-rossi-pv',
                },
              },
            ],
          },
          {
            url: 'https://www.linkedin.com/in/elena-conti',
            title: 'Elena Conti - Exa',
            author: 'Elena Conti',
            entities: [{ properties: { title: 'Direttore Tecnico', organization: { name: 'ReFeel EPC' } } }],
          },
          {
            url: 'https://www.linkedin.com/in/luca-bianchi',
            title: 'Luca Bianchi - Head of Purchasing - Memodo GmbH | LinkedIn',
          },
        ],
      });
    }) as unknown as typeof fetch;

    const result = await exaSearch(
      {
        query: 'Coenergia Srl Responsabile Acquisti',
        category: 'people',
        excludeDomains: ['facebook.com'],
        numResults: 5,
      },
      { apiKey: 'test-exa-key', fetchImpl },
    );

    expect(result).toEqual({
      billed: true,
      hits: [
        {
          url: 'https://it.linkedin.com/in/marco-rossi-pv',
          title: 'Marco Rossi - Responsabile Acquisti - Coenergia Srl',
        },
        {
          url: 'https://www.linkedin.com/in/elena-conti',
          title: 'Elena Conti - Direttore Tecnico - ReFeel EPC',
        },
        {
          url: 'https://www.linkedin.com/in/luca-bianchi',
          title: 'Luca Bianchi - Head of Purchasing - Memodo GmbH | LinkedIn',
        },
      ],
    });
    expect(
      parseExaPeopleHit({ url: 'https://www.linkedin.com/in/paolo', author: 'Paolo Verdi' }),
    ).toEqual({ url: 'https://www.linkedin.com/in/paolo', title: 'Paolo Verdi' });
  });

  it('serperSearch preserves snippet only when includeSnippet=true, and exaSearch requests contents.highlights in people mode', async () => {
    const serperFetch = vi.fn(async () =>
      jsonResponse({
        organic: [
          {
            link: 'https://it.linkedin.com/in/kieran-nolan-bbb26167',
            title: 'Kieran Nolan | LinkedIn',
            snippet: 'Purchasing Manager at Tavia Energy S.r.l. since 2020-2026',
          },
        ],
      }),
    ) as unknown as typeof fetch;

    const withSnippet = await serperSearch(
      { query: 'site:linkedin.com/in "Tavia Energy"', includeSnippet: true },
      { apiKey: 'test-serper-key', fetchImpl: serperFetch },
    );
    expect(withSnippet.hits).toEqual([
      {
        url: 'https://it.linkedin.com/in/kieran-nolan-bbb26167',
        title: 'Kieran Nolan | LinkedIn',
        snippet: 'Purchasing Manager at Tavia Energy S.r.l. since 2020-2026',
      },
    ]);

    const exaFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      expect(sent.contents).toEqual({ highlights: { maxCharacters: 720 } });
      return jsonResponse({
        results: [
          {
            url: 'https://it.linkedin.com/in/miralevinnovacrest',
            title: 'Mira Levin | LinkedIn',
            highlights: ['Novacrest S.r.l. — Responsabile Commerciale', 'Solar EPC Italy', 'H3', 'H4'],
          },
        ],
      });
    }) as unknown as typeof fetch;

    const exaPeople = await exaSearch(
      { query: 'Novacrest Srl', category: 'people', numResults: 5 },
      { apiKey: 'test-exa-key', fetchImpl: exaFetch },
    );
    expect(exaPeople.hits).toEqual([
      {
        url: 'https://it.linkedin.com/in/miralevinnovacrest',
        title: 'Mira Levin | LinkedIn',
        highlights: ['Novacrest S.r.l. — Responsabile Commerciale', 'Solar EPC Italy', 'H3'],
      },
    ]);
  });

  it('does not promote unrequested Exa text, biographies or summaries to attribution evidence', () => {
    expect(parseExaPeopleHit({
      url: 'https://www.linkedin.com/in/lexi-novel',
      title: 'Lexi Novel | LinkedIn',
      text: 'Raw profile body with unrequested details',
      summary: 'An unsolicited biography',
      highlights: ['Purchasing Manager at Sunforge'],
      entities: [{ properties: { bio: 'Full biography', summary: 'Entity summary' } }],
    })).toEqual({
      url: 'https://www.linkedin.com/in/lexi-novel',
      title: 'Lexi Novel | LinkedIn',
      highlights: ['Purchasing Manager at Sunforge'],
    });
  });
});
