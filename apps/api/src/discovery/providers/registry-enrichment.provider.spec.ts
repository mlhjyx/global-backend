import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TradeFairDiscoveryProvider } from './trade-fair.provider';
import { WikidataEnrichmentProvider } from './wikidata-enrich.provider';

const ctx = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  runId: 'run-1',
  correlationId: 'company-1',
};

function wdClaim(value: unknown) {
  return { mainsnak: { datavalue: { value } } };
}

describe('TradeFairDiscoveryProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fails closed without a broker or when no fair matches', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const noBroker = new TradeFairDiscoveryProvider();
    await expect(noBroker.discoverCompanies({
      sourceClass: 'industry_data',
      filters: {},
      keywords: ['sheet metal'],
      limit: 20,
    }, ctx)).resolves.toEqual({ records: [], costCents: 0 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('broker unavailable'));

    const broker = { invoke: vi.fn() };
    const provider = new TradeFairDiscoveryProvider({ broker: broker as any });
    await expect(provider.discoverCompanies({
      sourceClass: 'industry_data',
      filters: { industry: [] },
      keywords: ['industrial pumps'],
      limit: 20,
    }, ctx)).resolves.toEqual({ records: [], costCents: 0 });
    expect(broker.invoke).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('maps bounded fair records, filters blocked domains, and preserves public facts', async () => {
    const broker = {
      invoke: vi.fn(async () => ({ data: { exhibitors: [
        {
          externalId: 'e1',
          companyName: 'Metal GmbH',
          website: 'https://www.metal.example/catalog',
          email: 'info@metal.example',
          phone: '+493012345678',
          country: 'Germany',
          stand: 'A1',
          description: 'sheet metal systems',
          products: ['laser'],
          hiring: true,
        },
        {
          externalId: 'e2',
          companyName: 'Blocked GmbH',
          website: 'https://blocked.example',
          products: [],
        },
        {
          externalId: 'e3',
          companyName: 'No Site GmbH',
          products: [],
        },
        {
          externalId: 'e4',
          companyName: 'Duplicate Metal',
          website: 'https://metal.example',
          products: [],
        },
      ] }, costCents: 0 })),
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const provider = new TradeFairDiscoveryProvider({ broker: broker as any });

    const result = await provider.discoverCompanies({
      sourceClass: 'industry_data',
      filters: { industry: 'sheet metal', sub_industry: ['laser'], region: 'Europe' },
      keywords: ['forming'],
      limit: 10,
    }, ctx, { blockedDomains: ['BLOCKED.EXAMPLE'] });

    expect(result.records).toHaveLength(2);
    expect(result.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        externalId: 'euroblech-2026:e1',
        domain: 'metal.example',
        attributes: expect.objectContaining({
          public_email: 'info@metal.example',
          public_phone: '+493012345678',
          stand: 'A1',
          products: ['laser'],
          hiring_signal: true,
          source_fair: 'euroblech-2026',
        }),
      }),
      expect.objectContaining({
        externalId: 'euroblech-2026:e3',
        domain: undefined,
        attributes: expect.objectContaining({
          public_email: null,
          public_phone: null,
          stand: null,
          description: null,
          hiring_signal: false,
        }),
      }),
    ]));
    expect(result.records[0]?.provenance.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(broker.invoke).toHaveBeenCalledWith(
      'tradefair.algolia',
      expect.objectContaining({ limit: 50 }),
      ctx,
    );
    log.mockRestore();
  });

  it('isolates a rejected fair call and logs only a diagnostic token', async () => {
    const broker = { invoke: vi.fn(async () => { throw new Error('private fair response'); }) };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const provider = new TradeFairDiscoveryProvider({ broker: broker as any });

    await expect(provider.discoverCompanies({
      sourceClass: 'industry_data',
      filters: { industry: 'sheet metal' },
      keywords: [],
      limit: 900,
    }, ctx)).resolves.toEqual({ records: [], costCents: 0 });
    expect(broker.invoke).toHaveBeenCalledWith(
      'tradefair.algolia',
      expect.objectContaining({ limit: 400 }),
      expect.anything(),
    );
    expect(JSON.stringify(log.mock.calls)).toMatch(/ERROR_TEXT_SHA256:/);
    expect(JSON.stringify(log.mock.calls)).not.toContain('private fair response');
    log.mockRestore();
  });
});

describe('WikidataEnrichmentProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fails closed without a broker and on search/claims failures or empty candidates', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(new WikidataEnrichmentProvider().enrichCompany({ name: 'Pump GmbH' }, ctx)).resolves.toMatchObject({ matched: false });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('broker unavailable'));
    warn.mockRestore();

    for (const mode of ['search-error', 'empty', 'claims-error', 'no-company'] as const) {
      const broker = {
        invoke: vi.fn(async (_tool: string, input: { op: string }) => {
          if (input.op === 'search') {
            if (mode === 'search-error') throw new Error('search failed');
            return { data: { search: mode === 'empty' ? [] : [{ qid: 'Q1', label: 'Pump GmbH' }] }, costCents: 0 };
          }
          if (mode === 'claims-error') throw new Error('claims failed');
          return { data: { entities: mode === 'no-company' ? { Q1: { labels: { en: { value: 'Pump GmbH' } } } } : {} }, costCents: 0 };
        }),
      };
      const provider = new WikidataEnrichmentProvider({ broker: broker as any });
      await expect(provider.enrichCompany({ name: 'Pump GmbH' }, ctx)).resolves.toMatchObject({ matched: false });
    }
  });

  it('rejects weak or ambiguous company identity candidates', async () => {
    for (const candidates of [
      [{ qid: 'Q1', label: 'Completely Different Holdings' }],
      [{ qid: 'Q1', label: 'Pump Industrial' }, { qid: 'Q2', label: 'Pump Industries' }],
    ]) {
      const entities = Object.fromEntries(candidates.map((candidate) => [candidate.qid, {
        labels: { en: { value: candidate.label } },
        claims: { P31: [wdClaim({ id: 'Q4830453' })] },
      }]));
      const broker = {
        invoke: vi.fn(async (_tool: string, input: { op: string }) => ({
          data: input.op === 'search' ? { search: candidates } : { entities },
          costCents: 0,
        })),
      };
      const provider = new WikidataEnrichmentProvider({ broker: broker as any });
      await expect(provider.enrichCompany({ name: 'Pump' }, ctx)).resolves.toMatchObject({ matched: false });
    }
  });

  it('returns traced company facts with referenced labels and prunes absent facts', async () => {
    const entity = {
      labels: { en: { value: 'Pump GmbH' } },
      claims: {
        P31: [wdClaim({ id: 'Q4830453' })],
        P452: [wdClaim({ id: 'QIND' })],
        P1056: [wdClaim({ id: 'QPRODUCT' })],
        P856: [wdClaim('https://www.pump.example/catalog')],
        P1128: [wdClaim({ amount: '+42' })],
        P749: [wdClaim({ id: 'QPARENT' })],
        P17: [wdClaim({ id: 'QCOUNTRY' })],
      },
    };
    const labels = {
      QIND: { labels: { en: { value: 'Pump industry' } } },
      QPRODUCT: { labels: { en: { value: 'Centrifugal pump' } } },
      QPARENT: { labels: {} },
      QCOUNTRY: { labels: { en: { value: 'Germany' } } },
    };
    const broker = {
      invoke: vi.fn(async (_tool: string, input: { op: string; props?: string }) => {
        if (input.op === 'search') return { data: { search: [{ qid: 'Q1', label: 'Pump GmbH' }] }, costCents: 0 };
        return { data: { entities: input.props === 'labels' ? labels : { Q1: entity } }, costCents: 0 };
      }),
    };
    const provider = new WikidataEnrichmentProvider({ broker: broker as any });

    const result = await provider.enrichCompany({ name: 'Pump GmbH' }, ctx);

    expect(result).toMatchObject({
      matched: true,
      confidence: 1,
      attributes: {
        qid: 'Q1',
        label: 'Pump GmbH',
        website: 'pump.example',
        industries: ['Pump industry'],
        products: ['Centrifugal pump'],
        employees: 42,
        parent_name: 'QPARENT',
        parent_qid: 'QPARENT',
        country: 'Germany',
        match_confidence: 1,
      },
      costCents: 0,
    });
    expect(result.provenance?.sourceUrl).toBe('https://www.wikidata.org/wiki/Q1');
    expect(result.provenance?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('degrades when referenced labels fail and drops an invalid website', async () => {
    let gets = 0;
    const broker = {
      invoke: vi.fn(async (_tool: string, input: { op: string }) => {
        if (input.op === 'search') return { data: { search: [{ qid: 'Q1', label: 'Pump GmbH' }] }, costCents: 0 };
        gets += 1;
        if (gets > 1) throw new Error('labels unavailable');
        return { data: { entities: { Q1: {
          labels: { en: { value: 'Pump GmbH' } },
          claims: {
            P31: [wdClaim({ id: 'Q4830453' })],
            P452: [wdClaim({ id: 'QIND' })],
            P856: [wdClaim('not a valid website')],
          },
        } } }, costCents: 0 };
      }),
    };
    const provider = new WikidataEnrichmentProvider({ broker: broker as any });
    const result = await provider.enrichCompany({ name: 'Pump GmbH' }, ctx);
    expect(result).toMatchObject({
      matched: true,
      attributes: { qid: 'Q1' },
    });
    expect(result.attributes).not.toHaveProperty('website');
    expect(result.attributes).not.toHaveProperty('industries');
  });
});
