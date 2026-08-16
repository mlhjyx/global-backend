import { describe, expect, it, vi } from 'vitest';
import { SbirSttrCompanyDiscoveryProvider } from './sbir-sttr.provider';

const CTX = { workspaceId: 'workspace-1', runId: 'run-1' };
const PROVENANCE = {
  sourceUrl: 'https://api.www.sbir.gov/public/api/firm?name=LUNA+INNOVATIONS+INC&rows=10&start=0&format=json&sort=name',
  fetchedAt: '2026-08-16T00:00:00.000Z',
  contentHash: 'a'.repeat(64),
  parserVersion: 'sbir-sttr-company-v1/1',
};
const company = {
  sourceId: '12345',
  companyName: 'LUNA INNOVATIONS INC',
  officialProfileUrl: 'https://www.sbir.gov/portfolio/12345',
  uei: 'ABC123DEF456',
  state: 'VA',
  awardCount: 42,
};

function query(filters: Record<string, unknown>) {
  return { sourceClass: 'public_intelligence' as const, filters, keywords: [], limit: 10 };
}

describe('SBIR/STTR company discovery provider', () => {
  it('requires exact hint, US scope, and one explicit organization name before Broker invocation', async () => {
    const broker = { invoke: vi.fn() };
    const provider = new SbirSttrCompanyDiscoveryProvider({ broker: broker as never });
    for (const filters of [
      { country: 'US', organization_name: 'LUNA INNOVATIONS INC' },
      { source_hint: ['sbir_sttr_companies'], country: 'US', organization_name: 'LUNA INNOVATIONS INC' },
    ]) {
      await expect(provider.discoverCompanies(query(filters), CTX)).resolves.toEqual({ records: [], costCents: 0 });
    }
    await expect(provider.discoverCompanies(query({
      source_hint: 'sbir_sttr_companies', country: 'CA', organization_name: 'LUNA INNOVATIONS INC',
    }), CTX)).rejects.toThrow('SBIR_COUNTRY_SCOPE_INVALID');
    await expect(provider.discoverCompanies(query({
      source_hint: 'sbir_sttr_companies', country: 'US', organization_name: 'all',
    }), CTX)).rejects.toThrow('SBIR_EXACT_QUERY_REQUIRED');
    await expect(provider.discoverCompanies({ ...query({
      source_hint: 'sbir_sttr_companies', country: 'US', organization_name: 'LUNA INNOVATIONS INC',
    }), sourceClass: 'company_registry' }, CTX)).resolves.toEqual({ records: [], costCents: 0 });
    expect(broker.invoke).not.toHaveBeenCalled();
  });

  it('maps only historical company-directory facts without promoting UEI, DUNS, or website identity', async () => {
    const broker = { invoke: vi.fn(async () => ({
      data: { companies: [company] }, costCents: 0, provenance: PROVENANCE,
    })) };
    const result = await new SbirSttrCompanyDiscoveryProvider({ broker: broker as never }).discoverCompanies(query({
      source_hint: 'sbir_sttr_companies', country: 'US', organization_name: 'LUNA INNOVATIONS INC',
    }), CTX);
    expect(broker.invoke).toHaveBeenCalledWith('sbir-sttr-companies.search', {
      query: 'LUNA INNOVATIONS INC', start: 0, limit: 10,
    }, expect.objectContaining({ purpose: 'discovery' }));
    expect(result.records).toEqual([expect.objectContaining({
      externalId: 'sbir-sttr-company:12345',
      name: 'LUNA INNOVATIONS INC',
      country: 'US',
      region: 'VA',
      license: 'SOURCE_SPECIFIC',
      provenance: PROVENANCE,
    })]);
    expect(result.records[0]).not.toHaveProperty('identifier');
    expect(result.records[0]).not.toHaveProperty('identifiers');
    expect(result.records[0]).not.toHaveProperty('domain');
    expect(Object.keys(result.records[0]?.attributes?.sbir_sttr_company as Record<string, unknown>))
      .not.toEqual(expect.arrayContaining([
        'address1', 'address2', 'city', 'zip', 'phone', 'email', 'duns',
        'hubzone_owned', 'woman_owned', 'socially_economically_disadvantaged',
      ]));
  });

  it('rejects substring matches and broker rows with malformed organization facts', async () => {
    for (const item of [
      { ...company, companyName: 'LUNA INNOVATIONS INC HOLDINGS' },
      { ...company, sourceId: 'bad/id' },
      { ...company, state: 'Virginia' },
      { ...company, uei: 'not-a-uei' },
      { ...company, awardCount: -1 },
    ]) {
      const broker = { invoke: vi.fn(async () => ({
        data: { companies: [item] }, costCents: 0, provenance: PROVENANCE,
      })) };
      await expect(new SbirSttrCompanyDiscoveryProvider({ broker: broker as never }).discoverCompanies(query({
        source_hint: 'sbir_sttr_companies', country: 'US', organization_name: 'LUNA INNOVATIONS INC',
      }), CTX)).rejects.toThrow('SBIR_BROKER_RESULT_INVALID');
    }
    const invalidEnvelope = { invoke: vi.fn(async () => ({
      data: { companies: 'not-an-array' }, costCents: 0, provenance: PROVENANCE,
    })) };
    await expect(new SbirSttrCompanyDiscoveryProvider({ broker: invalidEnvelope as never }).discoverCompanies(query({
      source_hint: 'sbir_sttr_companies', country: 'US', organization_name: 'LUNA INNOVATIONS INC',
    }), CTX)).rejects.toThrow('SBIR_BROKER_RESULT_INVALID');
  });

  it('binds pagination and provenance to the exact organization scope', async () => {
    const broker = { invoke: vi.fn(async () => ({
      data: { companies: [company], nextCursor: '10' }, costCents: 0, provenance: PROVENANCE,
    })) };
    const scoped = query({ source_hint: 'sbir_sttr_companies', country: 'US', organization_name: 'LUNA INNOVATIONS INC' });
    const provider = new SbirSttrCompanyDiscoveryProvider({ broker: broker as never });
    const first = await provider.discoverCompanies(scoped, CTX);
    expect(first.nextCursor).toBeTruthy();

    await expect(provider.discoverCompanies(query({
      source_hint: 'sbir_sttr_companies', country: 'US', organization_name: 'OTHER COMPANY LLC',
    }), CTX, { cursor: first.nextCursor })).rejects.toThrow('SBIR_CURSOR_INVALID');

    for (const sourceUrl of [
      PROVENANCE.sourceUrl.replace('start=0', 'start=10'),
      PROVENANCE.sourceUrl.replace('LUNA+INNOVATIONS+INC', 'OTHER'),
      `${PROVENANCE.sourceUrl}&extra=1`,
      'not-a-url',
    ]) {
      const bad = { invoke: vi.fn(async () => ({
        data: { companies: [company] }, costCents: 0, provenance: { ...PROVENANCE, sourceUrl },
      })) };
      await expect(new SbirSttrCompanyDiscoveryProvider({ broker: bad as never }).discoverCompanies(scoped, CTX))
        .rejects.toThrow('SBIR_PROVENANCE_REQUIRED');
    }
  });
});
