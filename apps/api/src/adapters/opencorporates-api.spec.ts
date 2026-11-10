import { describe, expect, it, vi } from 'vitest';
import {
  OPENCORPORATES_ATTRIBUTION,
  OPENCORPORATES_LICENSE,
  jurisdictionCodeForCountry,
  mapCompany,
  searchOpenCorporatesCompanies,
} from './opencorporates-api';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const RAW_COMPANY = {
  name: 'Müller Pumpen GmbH',
  company_number: 'HRB 12345',
  jurisdiction_code: 'de',
  current_status: 'Active',
  company_type: 'Private Limited Company',
  incorporation_date: '2001-04-12',
  registered_address_in_full: 'Musterstraße 1, 80331 München',
  opencorporates_url: 'https://opencorporates.com/companies/de/HRB12345',
  officers: [{ name: 'Max Mustermann', position: 'Managing Director' }],
};

describe('mapCompany（只映射公司字段）', () => {
  it('maps the company fields and strips the wrapped object', () => {
    expect(mapCompany(RAW_COMPANY)).toEqual({
      name: 'Müller Pumpen GmbH',
      companyNumber: 'HRB 12345',
      jurisdictionCode: 'de',
      status: 'Active',
      companyType: 'Private Limited Company',
      incorporationDate: '2001-04-12',
      dissolutionDate: undefined,
      registeredAddress: 'Musterstraße 1, 80331 München',
      opencorporatesUrl: 'https://opencorporates.com/companies/de/HRB12345',
    });
  });

  it('never maps officer or other personal-data fields', () => {
    const mapped = JSON.stringify(mapCompany(RAW_COMPANY)).toLowerCase();
    expect(mapped).not.toContain('officer');
    expect(mapped).not.toContain('mustermann');
  });

  it('returns null when a primary key field is missing', () => {
    expect(mapCompany({ company_number: '1', jurisdiction_code: 'de' })).toBeNull();
    expect(mapCompany({ name: 'X', jurisdiction_code: 'de' })).toBeNull();
    expect(mapCompany({ name: 'X', company_number: '1' })).toBeNull();
    expect(mapCompany(null)).toBeNull();
    expect(mapCompany([])).toBeNull();
  });
});

describe('jurisdictionCodeForCountry', () => {
  it('maps alpha-2 countries to their lower-case jurisdiction code', () => {
    expect(jurisdictionCodeForCountry('DE')).toBe('de');
    expect(jurisdictionCodeForCountry('fr')).toBe('fr');
    expect(jurisdictionCodeForCountry('gb')).toBe('gb');
  });

  it('refuses the US, which has no single country-level jurisdiction', () => {
    expect(jurisdictionCodeForCountry('us')).toBeUndefined();
    expect(jurisdictionCodeForCountry('USA')).toBeUndefined();
    expect(jurisdictionCodeForCountry('d')).toBeUndefined();
  });
});

describe('searchOpenCorporatesCompanies', () => {
  it('builds the search URL with query, jurisdiction, bounded page size and the token', async () => {
    const fetchImpl = vi.fn(async (url: URL | string) => {
      expect(String(url)).toContain('https://api.opencorporates.com/v0.4/companies/search');
      const parsed = new URL(String(url));
      expect(parsed.searchParams.get('q')).toBe('Pumpen');
      expect(parsed.searchParams.get('jurisdiction_code')).toBe('de');
      expect(parsed.searchParams.get('per_page')).toBe('30');
      expect(parsed.searchParams.get('api_token')).toBe('secret-token');
      return jsonResponse({ results: { companies: [{ company: RAW_COMPANY }] } });
    });
    const hits = await searchOpenCorporatesCompanies(
      { query: 'Pumpen', countryCode: 'de' },
      'secret-token',
      undefined,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.name).toBe('Müller Pumpen GmbH');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('caps the page size at 30 and prefers an explicit jurisdiction code', async () => {
    const fetchImpl = vi.fn(async (url: URL | string) => {
      const parsed = new URL(String(url));
      expect(parsed.searchParams.get('jurisdiction_code')).toBe('us_de');
      expect(parsed.searchParams.get('per_page')).toBe('30');
      return jsonResponse({ results: { companies: [] } });
    });
    await searchOpenCorporatesCompanies(
      { query: 'Pumpen', countryCode: 'de', jurisdictionCode: 'us_de', limit: 999 },
      'tok',
      undefined,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
  });

  it('fails closed without a query, a token or a resolvable jurisdiction', async () => {
    const fetchImpl = vi.fn();
    const deps = { fetchImpl: fetchImpl as unknown as typeof fetch };
    await expect(searchOpenCorporatesCompanies({ query: ' ' }, 'tok', undefined, deps))
      .rejects.toThrow(/query required/);
    await expect(searchOpenCorporatesCompanies({ query: 'X', countryCode: 'de' }, ' ', undefined, deps))
      .rejects.toThrow(/token required/);
    await expect(searchOpenCorporatesCompanies({ query: 'X', countryCode: 'us' }, 'tok', undefined, deps))
      .rejects.toThrow(/jurisdiction required/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws on a non-2xx answer (401/403 never retried)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'invalid token' }, 401));
    await expect(
      searchOpenCorporatesCompanies({ query: 'X', countryCode: 'de' }, 'tok', undefined, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/opencorporates 401/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('retries 429 with backoff and then succeeds', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response('rate limited', { status: 429 });
      return jsonResponse({ results: { companies: [{ company: RAW_COMPANY }] } });
    });
    const sleepImpl = vi.fn(async () => {});
    const hits = await searchOpenCorporatesCompanies(
      { query: 'Pumpen', countryCode: 'de' },
      'tok',
      undefined,
      { fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl },
    );
    expect(calls).toBe(2);
    expect(sleepImpl).toHaveBeenCalled();
    expect(hits).toHaveLength(1);
  });

  it('publishes the ODbL license tokens used by the provider records', () => {
    expect(OPENCORPORATES_LICENSE).toBe('ODbL-1.0');
    expect(OPENCORPORATES_ATTRIBUTION).toContain('OpenCorporates');
    expect(OPENCORPORATES_ATTRIBUTION).toContain('Open Database License');
  });
});
