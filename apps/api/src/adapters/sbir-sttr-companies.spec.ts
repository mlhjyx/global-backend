import { describe, expect, it, vi } from 'vitest';
import {
  parseSbirSttrCompanyResponse,
  searchSbirSttrCompanies,
} from './sbir-sttr-companies';
import type { PublicHttpRequestOptions, PublicHttpResponse } from './guarded-http';

const company = {
  firm_nid: 12345,
  company_name: 'LUNA INNOVATIONS INC',
  sbir_url: 'https://www.sbir.gov/portfolio/12345',
  uei: 'ABC123DEF456',
  duns: '123456789',
  address1: 'MUST_NOT_SURVIVE',
  address2: 'SUITE 9',
  city: 'Roanoke',
  state: 'VA',
  zip: '24011',
  company_url: 'https://example.test/private-path',
  hubzone_owned: 'Y',
  socially_economically_disadvantaged: 'N',
  woman_owned: 'Y',
  number_awards: 42,
  unknown: 'SECRET_UNKNOWN_FIELD',
};

function response(value: unknown, finalUrl: string): PublicHttpResponse {
  const body = Buffer.from(JSON.stringify(value));
  return {
    status: 200,
    ok: true,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body,
    text: body.toString(),
    finalUrl,
  };
}

describe('SBIR/STTR company directory adapter', () => {
  it('projects only bounded organization-level fields and drops address, demographic, and unknown fields', () => {
    const records = parseSbirSttrCompanyResponse([
      company,
      { ...company, firm_nid: 'bad' },
      { ...company, firm_nid: 12346, company_name: '' },
    ], 10);
    expect(records).toEqual([{
      sourceId: '12345',
      companyName: 'LUNA INNOVATIONS INC',
      officialProfileUrl: 'https://www.sbir.gov/portfolio/12345',
      uei: 'ABC123DEF456',
      state: 'VA',
      awardCount: 42,
    }]);
    expect(JSON.stringify(records)).not.toMatch(
      /MUST_NOT_SURVIVE|SUITE 9|Roanoke|24011|duns|hubzone|disadvantaged|woman_owned|company_url|SECRET_UNKNOWN_FIELD/iu,
    );
  });

  it('uses the documented exact-name Company API with a bounded first-50 window', async () => {
    const request = vi.fn(async (raw: string, options?: PublicHttpRequestOptions) => {
      const url = new URL(raw);
      expect(url.origin).toBe('https://api.www.sbir.gov');
      expect(url.pathname).toBe('/public/api/firm');
      expect([...url.searchParams.entries()]).toEqual([
        ['name', 'LUNA INNOVATIONS INC'],
        ['rows', '2'],
        ['start', '0'],
        ['format', 'json'],
        ['sort', 'name'],
      ]);
      expect(options).toMatchObject({ maxRedirects: 0, maxBytes: 1024 * 1024 });
      return response([company, {
        ...company,
        firm_nid: 12346,
        company_name: 'LUNA INNOVATIONS INC HOLDINGS',
      }], raw);
    });
    const page = await searchSbirSttrCompanies(
      { query: 'LUNA INNOVATIONS INC', start: 0, limit: 2 },
      undefined,
      { request: request as never },
    );
    expect(page.records).toEqual([expect.objectContaining({ sourceId: '12345' })]);
    expect(page.nextCursor).toBe('2');
    expect(page.provenance.sourceUrl).not.toMatch(/key|token|secret/iu);
  });

  it('hashes only the safe projection so discarded upstream fields do not create replay drift', async () => {
    const makeRequest = (address1: string) => vi.fn(async (raw: string) => response([
      { ...company, address1 },
    ], raw));
    const first = await searchSbirSttrCompanies(
      { query: 'LUNA INNOVATIONS INC', start: 0, limit: 2 }, undefined,
      { request: makeRequest('FIRST PRIVATE ADDRESS') as never },
    );
    const second = await searchSbirSttrCompanies(
      { query: 'LUNA INNOVATIONS INC', start: 0, limit: 2 }, undefined,
      { request: makeRequest('SECOND PRIVATE ADDRESS') as never },
    );
    expect(first.provenance.contentHash).toBe(second.provenance.contentHash);
  });

  it('fails before egress for broad terms or pagination outside the bounded window', async () => {
    const request = vi.fn();
    for (const input of [
      { query: 'all', start: 0, limit: 2 },
      { query: 'innovation, technology', start: 0, limit: 2 },
      { query: 'LUNA INNOVATIONS INC', start: -1, limit: 2 },
      { query: 'LUNA INNOVATIONS INC', start: 49, limit: 2 },
      { query: 'LUNA INNOVATIONS INC', start: 0, limit: 11 },
    ]) {
      await expect(searchSbirSttrCompanies(input, undefined, { request }))
        .rejects.toThrow(/SBIR_(?:EXACT_QUERY_REQUIRED|PAGE_INVALID)/u);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('fails closed on a maintenance page or an unknown JSON envelope', async () => {
    const html = vi.fn(async (raw: string) => ({
      ...response({}, raw),
      headers: { 'content-type': 'text/html' },
    }));
    await expect(searchSbirSttrCompanies(
      { query: 'LUNA INNOVATIONS INC', start: 0, limit: 2 }, undefined,
      { request: html as never },
    )).rejects.toThrow('SBIR_CONTENT_TYPE_INVALID');

    const envelope = vi.fn(async (raw: string) => response({ records: [company] }, raw));
    await expect(searchSbirSttrCompanies(
      { query: 'LUNA INNOVATIONS INC', start: 0, limit: 2 }, undefined,
      { request: envelope as never },
    )).rejects.toThrow('SBIR_SCHEMA_CHANGED');
  });
});
