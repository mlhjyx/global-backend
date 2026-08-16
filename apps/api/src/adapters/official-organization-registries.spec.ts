import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseFrenchResponse,
  parseNppesResponse,
  parseRorResponse,
  fetchSecSubmissionOrganization,
  normalizeRorId,
  normalizeCik,
  searchSecCompanyDirectory,
  searchFrenchOrganizations,
  searchNppesOrganizations,
  searchRorOrganizations,
  validNpi,
} from './official-organization-registries';
import type {
  PublicHttpDependencies,
  PublicHttpRequestOptions,
  PublicHttpResponse,
} from './guarded-http';

function response(body: string, url: string, headers: Record<string, string> = {}): PublicHttpResponse {
  const bytes = Buffer.from(body);
  return {
    status: 200,
    ok: true,
    headers: { 'content-type': 'application/json', ...headers },
    body: bytes,
    text: body,
    finalUrl: url,
  };
}

type PublicHttpRequest = (
  raw: string,
  options?: PublicHttpRequestOptions,
  dependencies?: PublicHttpDependencies,
) => Promise<PublicHttpResponse>;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('ROR official organization adapter', () => {
  const item = {
    id: 'https://ror.org/052gg0110',
    status: 'active',
    names: [{ value: 'University of Oxford', types: ['ror_display'] }],
    locations: [{ geonames_details: { country_code: 'GB' } }],
    types: ['education', 'funder'],
    domains: ['ox.ac.uk', 'localhost', '127.0.0.1'],
    links: [{ type: 'website', value: 'https://untrusted.example/path' }],
    relationships: [{ type: 'related', label: 'MUST_NOT_SURVIVE' }],
  };

  it('validates the official checksum and structurally excludes links and relationships', () => {
    expect(normalizeRorId('HTTPS://ROR.ORG/052GG0110')).toBe('https://ror.org/052gg0110');
    expect(normalizeRorId('052gg0111')).toBeNull();
    expect(parseRorResponse({ items: [item] })).toEqual([{
      rorId: 'https://ror.org/052gg0110',
      name: 'University of Oxford',
      country: 'GB',
      reportedDomains: ['ox.ac.uk'],
      types: ['education', 'funder'],
    }]);
    expect(JSON.stringify(parseRorResponse({ items: [item] }))).not.toContain('MUST_NOT_SURVIVE');
  });

  it('uses bounded official paging and returns truthful continuation metadata', async () => {
    const body = JSON.stringify({ items: [item], number_of_results: 21 });
    const requestMock = vi.fn<PublicHttpRequest>(async (raw) => response(body, raw));
    const result = await searchRorOrganizations(
      { query: 'Oxford', country: 'GB', types: ['education'], limit: 20, page: 1 },
      undefined,
      { request: requestMock },
    );
    const requested = new URL(String(requestMock.mock.calls[0]?.[0]));
    expect(requested.searchParams.get('query')).toBe('Oxford');
    expect(requested.searchParams.get('filter')).toBe('country.country_code:GB,types:education');
    expect(requested.searchParams.get('page')).toBe('1');
    expect(result).toMatchObject({ total: 21, nextCursor: '2', provenance: { parserVersion: 'ror-v2.1/2' } });
  });

  it('fails closed on inactive rows, unknown types and invalid query scope', async () => {
    expect(() => parseRorResponse({ items: [{ ...item, status: 'withdrawn' }] })).toThrow('ROR_SCHEMA_CHANGED');
    expect(() => parseRorResponse({ items: [{ ...item, types: ['person'] }] })).toThrow('ROR_SCHEMA_CHANGED');
    await expect(searchRorOrganizations({
      query: 'Oxford', country: 'Britain', types: ['education'], limit: 1,
    }, undefined, {
      request: vi.fn(),
    })).rejects.toThrow('ROR_COUNTRY_INVALID');
    await expect(searchRorOrganizations({
      query: 'Oxford', country: 'GB', types: ['education', 'funder'], limit: 1,
    }, undefined, { request: vi.fn() })).rejects.toThrow('ROR_TYPE_INVALID');
    const missingCountryRequest = vi.fn();
    await expect(searchRorOrganizations({
      query: 'Oxford', country: '', types: ['education'], limit: 1,
    }, undefined, { request: missingCountryRequest })).rejects.toThrow('ROR_COUNTRY_INVALID');
    expect(missingCountryRequest).not.toHaveBeenCalled();
    const missingTypeRequest = vi.fn();
    await expect(searchRorOrganizations({
      query: 'Oxford', country: 'GB', types: [], limit: 1,
    }, undefined, { request: missingTypeRequest })).rejects.toThrow('ROR_TYPE_INVALID');
    expect(missingTypeRequest).not.toHaveBeenCalled();
    const duplicateTypeRequest = vi.fn();
    await expect(searchRorOrganizations({
      query: 'Oxford', country: 'GB', types: ['education', 'education'], limit: 1,
    }, undefined, { request: duplicateTypeRequest })).rejects.toThrow('ROR_TYPE_INVALID');
    expect(duplicateTypeRequest).not.toHaveBeenCalled();
  });
});

describe('SEC EDGAR official organization adapters', () => {
  const userAgent = 'GlobalBackend Acquisition ops@globalbackend.dev';
  const tickers = {
    fields: ['cik', 'name', 'ticker', 'exchange'],
    data: [
      [123, 'ACME CORPORATION', 'ACME', 'Nasdaq'],
      [456, 'ACME CORPORATION HOLDINGS', 'ACMH', 'NYSE'],
      [789, 'BETA INDUSTRIES', 'BETA', 'NYSE'],
      [987, 'PENDING EXCHANGE FILER', 'PNDG', null],
    ],
  };

  it('normalizes only strict non-zero 1-10 digit CIK values', () => {
    expect(normalizeCik('1')).toBe('0000000001');
    expect(normalizeCik('0000000123')).toBe('0000000123');
    for (const value of ['', '0', '0000000000', 'CIK 123', 'CIK: ----123', '12-3', '12345678901', '１２３']) {
      expect(normalizeCik(value), value).toBeNull();
    }
  });

  it('uses the server-owned User-Agent and returns only an exact ticker or normalized-name match', async () => {
    vi.stubEnv('SEC_EDGAR_USER_AGENT', userAgent);
    const body = JSON.stringify(tickers);
    const requestMock = vi.fn<PublicHttpRequest>(async (raw, options) => {
      expect(options?.headers?.['User-Agent']).toBe(userAgent);
      return response(body, raw);
    });

    const byName = await searchSecCompanyDirectory(
      { query: '  acme   corporation ', limit: 5, userAgent: 'Forged victim@example.test' } as never,
      undefined,
      { request: requestMock },
    );
    const byTicker = await searchSecCompanyDirectory(
      { query: 'beta', limit: 1 },
      undefined,
      { request: requestMock },
    );
    const byCik = await searchSecCompanyDirectory(
      { query: '123', limit: 1 },
      undefined,
      { request: requestMock },
    );

    expect(byName.records).toEqual([{
      cik: '0000000123', name: 'ACME CORPORATION', ticker: 'ACME', exchange: 'Nasdaq',
    }]);
    expect(byTicker.records).toEqual([{
      cik: '0000000789', name: 'BETA INDUSTRIES', ticker: 'BETA', exchange: 'NYSE',
    }]);
    expect(byCik.records).toEqual([]);
    expect(requestMock).toHaveBeenCalledTimes(3);
  });

  it('safely decodes a bounded gzip SEC directory response before hashing and parsing', async () => {
    vi.stubEnv('SEC_EDGAR_USER_AGENT', userAgent);
    const body = JSON.stringify(tickers);
    const compressed = gzipSync(body);
    const sourceUrl = 'https://www.sec.gov/files/company_tickers_exchange.json';
    const requestMock = vi.fn<PublicHttpRequest>(async () => ({
      ...response('', sourceUrl),
      body: compressed,
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': String(compressed.byteLength),
      },
    }));

    const result = await searchSecCompanyDirectory(
      { query: 'AAPL', limit: 1 },
      undefined,
      { request: requestMock },
    );

    expect(result.records).toEqual([]);
    expect(result.provenance.contentHash).toBe(createHash('sha256').update(body).digest('hex'));
  });

  it('rejects an absent server User-Agent and limits outside 1..5 before any request', async () => {
    const requestMock = vi.fn<PublicHttpRequest>();
    await expect(searchSecCompanyDirectory({ query: 'ACME', limit: 1 }, undefined, { request: requestMock }))
      .rejects.toThrow('SEC_EDGAR_USER_AGENT_REQUIRED');
    vi.stubEnv('SEC_EDGAR_USER_AGENT', userAgent);
    for (const limit of [0, 6, -1, 1.5, Number.NaN]) {
      await expect(searchSecCompanyDirectory({ query: 'ACME', limit }, undefined, { request: requestMock }))
        .rejects.toThrow('SEC_EDGAR_LIMIT_INVALID');
    }
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('rejects a placeholder SEC contact domain before any request', async () => {
    const requestMock = vi.fn<PublicHttpRequest>();
    for (const placeholder of [
      'GlobalBackend Acquisition ops@example.test',
      'GlobalBackend Acquisition ops@example.com',
      'GlobalBackend Acquisition ops@contact.invalid',
    ]) {
      vi.stubEnv('SEC_EDGAR_USER_AGENT', placeholder);
      await expect(searchSecCompanyDirectory(
        { query: 'ACME', limit: 1 },
        undefined,
        { request: requestMock },
      )).rejects.toThrow('SEC_EDGAR_USER_AGENT_REQUIRED');
    }
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('retains an exact directory filer when SEC publishes a null exchange', async () => {
    vi.stubEnv('SEC_EDGAR_USER_AGENT', userAgent);
    const requestMock = vi.fn<PublicHttpRequest>(async (raw) => response(JSON.stringify(tickers), raw));

    const result = await searchSecCompanyDirectory(
      { query: 'PNDG', limit: 1 },
      undefined,
      { request: requestMock },
    );

    expect(result.records).toEqual([{
      cik: '0000000987', name: 'PENDING EXCHANGE FILER', ticker: 'PNDG', exchange: undefined,
    }]);
  });

  it('uses submissions only to verify an operating directory candidate and structurally drops filing and personal fields', async () => {
    vi.stubEnv('SEC_EDGAR_USER_AGENT', userAgent);
    const wireBody = JSON.stringify({
      cik: '0000000123',
      name: 'ACME CORPORATION',
      entityType: 'operating',
      tickers: ['ACME'],
      exchanges: ['Nasdaq'],
      sicDescription: 'Industrial Machinery',
      stateOfIncorporation: 'DE',
      filings: { recent: { form: ['10-K'], primaryDocument: ['secret.htm'] } },
      formerNames: [{ name: 'PERSON_NAME_MUST_NOT_SURVIVE' }],
      addresses: { business: { street1: 'STREET_MUST_NOT_SURVIVE' } },
      ein: '12-3456789',
      phone: '555-0100',
      website: 'https://untrusted.example',
      investorWebsite: 'https://investor.example',
    });
    const requestMock = vi.fn<PublicHttpRequest>(async (raw, options) => {
      expect(raw).toBe('https://data.sec.gov/submissions/CIK0000000123.json');
      expect(options?.headers?.['User-Agent']).toBe(userAgent);
      return response(wireBody, raw);
    });

    const result = await fetchSecSubmissionOrganization(
      { cik: '123', expectedName: 'ACME CORPORATION' },
      undefined,
      { request: requestMock },
    );

    expect(result.records).toEqual([{
      cik: '0000000123',
      name: 'ACME CORPORATION',
      entityType: 'operating',
    }]);
    expect(JSON.stringify(result)).not.toMatch(/10-K|secret\.htm|PERSON_NAME|STREET_MUST|12-3456789|555-0100|untrusted|investor|ticker|exchange|sicDescription|stateOfIncorporation/iu);
  });

  it('rejects a non-operating, mismatched or unbound submissions record', async () => {
    vi.stubEnv('SEC_EDGAR_USER_AGENT', userAgent);
    const requestMock = vi.fn<PublicHttpRequest>(async (raw) => response(JSON.stringify({
      cik: '0000000123', name: 'ACME CORPORATION', entityType: 'other', tickers: [], exchanges: [],
    }), raw));

    await expect(fetchSecSubmissionOrganization(
      { cik: '123', expectedName: 'ACME CORPORATION' }, undefined, { request: requestMock },
    )).rejects.toThrow(/SEC_EDGAR_(?:ENTITY_TYPE_INVALID|SCHEMA_CHANGED)/u);
    await expect(fetchSecSubmissionOrganization(
      { cik: '123', expectedName: '' }, undefined, { request: requestMock },
    )).rejects.toThrow(/SEC_EDGAR_(?:EXPECTED_NAME_REQUIRED|DIRECTORY_CANDIDATE_REQUIRED)/u);

    const operatingRequest = vi.fn<PublicHttpRequest>(async (raw) => response(JSON.stringify({
      cik: '0000000123', name: 'DIFFERENT CORPORATION', entityType: 'operating', tickers: [], exchanges: [],
    }), raw));
    await expect(fetchSecSubmissionOrganization(
      { cik: '123', expectedName: 'ACME CORPORATION' }, undefined, { request: operatingRequest },
    )).rejects.toThrow('SEC_EDGAR_DIRECTORY_BINDING_MISMATCH');
  });
});

describe('France official organization adapter', () => {
  it('admits legal-name organizations, accepts La Poste and structurally removes person fields', () => {
    const records = parseFrenchResponse({ results: [
      {
        siren: '356000000',
        nom_raison_sociale: 'LA POSTE',
        nom_complet: 'PERSON_SHOULD_NOT_SURVIVE',
        dirigeants: [{ nom: 'DIRECTOR_SHOULD_NOT_SURVIVE', email: 'director@example.test' }],
        siege: {
          activite_principale: '53.10Z',
          libelle_commune: 'PARIS',
          code_postal: '75015',
          adresse: 'STREET_SHOULD_NOT_SURVIVE',
        },
      },
      { siren: '562082909', nom_complet: 'SOLE_TRADER_SHOULD_NOT_SURVIVE', siege: {} },
    ] });

    expect(records).toEqual([{
      siren: '356000000',
      name: 'LA POSTE',
      activityCode: '53.10Z',
      city: 'PARIS',
      postalCode: '75015',
    }]);
    expect(JSON.stringify(records)).not.toMatch(/PERSON_SHOULD|DIRECTOR_SHOULD|director@example|STREET_SHOULD/iu);
  });

  it('returns bounded real-response provenance instead of a synthetic record fingerprint', async () => {
    const wireBody = JSON.stringify({ results: [{
      siren: '356000000',
      nom_raison_sociale: 'LA POSTE',
      dirigeants: [{ nom: 'HASHED_BUT_NOT_RETAINED' }],
      siege: {},
    }] });
    const sourceUrl = 'https://recherche-entreprises.api.gouv.fr/search?q=la+poste&page=1&per_page=10';
    const requestMock = vi.fn<PublicHttpRequest>(async () => response(wireBody, sourceUrl));

    const result = await searchFrenchOrganizations(
      { query: 'la poste', limit: 10 },
      undefined,
      { request: requestMock },
    );

    expect(result.records).toEqual([{ siren: '356000000', name: 'LA POSTE' }]);
    expect(result.provenance).toMatchObject({
      sourceUrl,
      contentHash: createHash('sha256').update(wireBody).digest('hex'),
      parserVersion: 'recherche-entreprises/1',
    });
    expect(Number.isNaN(new Date(result.provenance.fetchedAt).getTime())).toBe(false);
    expect(JSON.stringify(result)).not.toContain('HASHED_BUT_NOT_RETAINED');
    expect(requestMock).toHaveBeenCalledWith(
      expect.stringContaining('recherche-entreprises.api.gouv.fr/search'),
      expect.objectContaining({ maxRedirects: 0 }),
      expect.objectContaining({ authorizeExternalAction: expect.any(Function) }),
    );
  });

  it('fails closed on an invalid organization SIREN', () => {
    expect(() => parseFrenchResponse({ results: [{
      siren: '356000001',
      nom_raison_sociale: 'Invalid Organization',
      siege: {},
    }] })).toThrow('FR_COMPANY_SCHEMA_CHANGED');
    expect(() => parseFrenchResponse({ results: [{
      siren: 'FR-356000000',
      nom_raison_sociale: 'Decorated Identifier',
      siege: {},
    }] })).toThrow('FR_COMPANY_SCHEMA_CHANGED');
  });
});

describe('NPPES organization adapter', () => {
  it('admits only checksum-valid NPI-2 records and drops authorized-official PII', () => {
    expect(validNpi('1234567893')).toBe(true);
    const records = parseNppesResponse({ results: [
      {
        number: '1234567893',
        enumeration_type: 'NPI-1',
        basic: { first_name: 'PERSON_SHOULD_NOT_SURVIVE' },
        addresses: [],
        taxonomies: [],
      },
      {
        number: '1234567893',
        enumeration_type: 'NPI-2',
        basic: {
          organization_name: 'Example Clinic',
          status: 'A',
          authorized_official_first_name: 'OFFICIAL_SHOULD_NOT_SURVIVE',
          authorized_official_telephone_number: 'PHONE_SHOULD_NOT_SURVIVE',
        },
        addresses: [{
          address_purpose: 'LOCATION',
          city: 'BALTIMORE',
          state: 'MD',
          address_1: 'STREET_SHOULD_NOT_SURVIVE',
          telephone_number: 'PHONE_SHOULD_NOT_SURVIVE',
        }],
        taxonomies: [{ desc: 'Clinic/Center' }],
      },
    ] });

    expect(records).toEqual([{
      npi: '1234567893',
      name: 'Example Clinic',
      status: 'A',
      city: 'BALTIMORE',
      state: 'MD',
      taxonomyDescriptions: ['Clinic/Center'],
    }]);
    expect(JSON.stringify(records)).not.toMatch(/PERSON_SHOULD|OFFICIAL_SHOULD|PHONE_SHOULD|STREET_SHOULD/iu);
    expect(() => parseNppesResponse({ results: [{
      number: '1234567890',
      enumeration_type: 'NPI-2',
      basic: { organization_name: 'Bad Clinic' },
      addresses: [],
      taxonomies: [],
    }] })).toThrow('NPPES_SCHEMA_CHANGED');
  });

  it('uses NPI-2 on the wire and retains only a response-body hash as provenance', async () => {
    const wireBody = JSON.stringify({ results: [{
      number: '1234567893',
      enumeration_type: 'NPI-2',
      basic: {
        organization_name: 'Example Clinic',
        authorized_official_last_name: 'SECRET_NAME',
      },
      addresses: [],
      taxonomies: [],
    }] });
    const sourceUrl = 'https://npiregistry.cms.hhs.gov/api/?version=2.1&enumeration_type=NPI-2&number=1234567893&limit=1';
    const requestMock = vi.fn<PublicHttpRequest>(async () => response(wireBody, sourceUrl));

    const result = await searchNppesOrganizations(
      { npi: '1234567893', limit: 1 },
      undefined,
      { request: requestMock },
    );

    expect(result.records).toEqual([expect.objectContaining({ npi: '1234567893', name: 'Example Clinic' })]);
    expect(result.provenance.contentHash).toBe(createHash('sha256').update(wireBody).digest('hex'));
    expect(JSON.stringify(result)).not.toContain('SECRET_NAME');
    const requestedUrl = new URL(String(requestMock.mock.calls[0]?.[0]));
    expect(requestedUrl.searchParams.get('version')).toBe('2.1');
    expect(requestedUrl.searchParams.get('enumeration_type')).toBe('NPI-2');
    expect(requestedUrl.searchParams.get('number')).toBe('1234567893');
  });

  it('routes the wire through guarded HTTP with DNS/IP pinning and per-action reauthorization', async () => {
    const wireBody = JSON.stringify({ results: [] });
    const beforeRequest = vi.fn(async () => undefined);
    const rawFetch = vi.fn(() => {
      throw new Error('global fetch must not be used');
    });
    vi.stubGlobal('fetch', rawFetch);
    const requestMock = vi.fn<PublicHttpRequest>(async (raw, options, dependencies) => {
      expect(raw).toMatch(/^https:\/\/npiregistry\.cms\.hhs\.gov\/api\/\?/u);
      expect(options).toMatchObject({
        method: 'GET',
        maxRedirects: 0,
        maxBytes: 2 * 1024 * 1024,
        timeoutMs: 20_000,
      });
      await expect(dependencies?.authorizeExternalAction?.()).resolves.toBe(true);
      return response(wireBody, raw);
    });

    await searchNppesOrganizations(
      { organizationName: 'clinic', limit: 10 },
      beforeRequest,
      { request: requestMock },
    );

    expect(requestMock).toHaveBeenCalledOnce();
    expect(beforeRequest).toHaveBeenCalledOnce();
    expect(rawFetch).not.toHaveBeenCalled();
  });

  it('fails closed if a wire seam reports a final URL outside the fixed official endpoint', async () => {
    const requestMock = vi.fn<PublicHttpRequest>(async () => response(
      JSON.stringify({ results: [] }),
      'https://metadata.example/latest',
    ));

    await expect(searchNppesOrganizations(
      { organizationName: 'clinic', limit: 10 },
      undefined,
      { request: requestMock },
    )).rejects.toThrow('NPPES_FINAL_URL_INVALID');
  });

  it('fails closed when an exact NPI query returns a different organization identifier', async () => {
    const requestMock = vi.fn<PublicHttpRequest>(async (raw) => response(
      JSON.stringify({ results: [{
        number: '1245319599',
        enumeration_type: 'NPI-2',
        basic: { organization_name: 'Wrong Clinic' },
        addresses: [],
        taxonomies: [],
      }] }),
      raw,
    ));

    await expect(searchNppesOrganizations(
      { npi: '1234567893', limit: 1 },
      undefined,
      { request: requestMock },
    ))
      .rejects.toThrow('NPPES_EXACT_ID_MISMATCH');
  });

  it('fails closed before parsing a response whose declared size exceeds the bound', async () => {
    const requestMock = vi.fn<PublicHttpRequest>(async (raw) => response(
      JSON.stringify({ results: [] }),
      raw,
      { 'content-length': String(2 * 1024 * 1024 + 1) },
    ));

    await expect(searchNppesOrganizations(
      { organizationName: 'test', limit: 10 },
      undefined,
      { request: requestMock },
    ))
      .rejects.toThrow('NPPES_RESPONSE_TOO_LARGE');
  });

  it('rejects invalid NPI and state criteria before making a network request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(searchNppesOrganizations({ npi: '1234567890', limit: 10 }))
      .rejects.toThrow('NPPES_NPI_INVALID');
    await expect(searchNppesOrganizations({ organizationName: 'clinic', state: 'Maryland', limit: 10 }))
      .rejects.toThrow('NPPES_STATE_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
