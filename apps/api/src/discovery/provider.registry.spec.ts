import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscoveryProviderRegistry } from './provider.registry';

const originalSandboxFlag = process.env.DISCOVERY_ALLOW_SANDBOX;

function providerDb(enabled: string[] = []) {
  return {
    dataProvider: {
      findMany: vi.fn().mockResolvedValue(enabled.map((key) => ({ key }))),
      upsert: vi.fn().mockResolvedValue({}),
    },
    sourcePolicy: {
      upsert: vi.fn().mockResolvedValue({}),
    },
  };
}

afterEach(() => {
  if (originalSandboxFlag === undefined) delete process.env.DISCOVERY_ALLOW_SANDBOX;
  else process.env.DISCOVERY_ALLOW_SANDBOX = originalSandboxFlag;
  vi.restoreAllMocks();
});

describe('DiscoveryProviderRegistry construction and routing', () => {
  it('fails closed without a gateway while retaining deterministic and sandbox adapters', async () => {
    delete process.env.DISCOVERY_ALLOW_SANDBOX;
    const registry = new DiscoveryProviderRegistry();
    const db = providerDb([
      'wikidata',
      'openstreetmap',
      'trade_fair',
      'ted',
      'openfda',
      'sandbox',
      'smtp_self',
      'companies_house',
      'inpi_rne',
      'google_patents',
      'digital_footprint',
      'structured_harvest',
      'gleif',
    ]);

    await expect(registry.routeCompanyDiscovery(db as never, 'public_intelligence')).resolves.toEqual([
      expect.objectContaining({ key: 'ted' }),
      expect.objectContaining({ key: 'openfda' }),
      expect.objectContaining({ key: 'sandbox' }),
    ]);
    await expect(registry.routeCompanyDiscovery(db as never, 'company_registry')).resolves.toEqual([
      expect.objectContaining({ key: 'wikidata' }),
      expect.objectContaining({ key: 'sandbox' }),
    ]);
    const contacts = await registry.routeContactDiscovery(db as never);
    expect(contacts.map((provider) => provider.key)).toEqual([
      'companies_house',
      'inpi_rne',
      'google_patents',
      'sandbox',
    ]);
    expect((await registry.routeEmailVerification(db as never)).map((provider) => provider.key)).toEqual([
      'smtp_self',
      'sandbox',
    ]);
  });

  it('registers gateway-backed providers in their explicit precedence order', async () => {
    process.env.DISCOVERY_ALLOW_SANDBOX = 'false';
    const registry = new DiscoveryProviderRegistry({
      gateway: { provider: 'fake' } as never,
      broker: { invoke: vi.fn() } as never,
      acquisitionBroker: { invoke: vi.fn() } as never,
      runtimeTelemetry: { record: vi.fn() } as never,
      prisma: {} as never,
    });
    const db = providerDb([
      'public_web',
      'directory',
      'wikidata',
      'decision_maker',
      'companies_house',
      'smtp_self',
      'digital_footprint',
      'structured_harvest',
      'gleif',
    ]);

    const companies = await registry.routeCompanyDiscovery(db as never, 'public_intelligence');
    expect(companies.map((provider) => provider.key)).toEqual(['public_web']);
    expect((await registry.routeCompanyDiscovery(db as never, 'company_registry')).map((provider) => provider.key)).toEqual([
      'wikidata',
    ]);
    expect((await registry.routeCompanyDiscovery(db as never, 'industry_data')).map((provider) => provider.key)).toContain('directory');
    expect((await registry.routeContactDiscovery(db as never)).map((provider) => provider.key).slice(0, 2)).toEqual([
      'decision_maker',
      'public_web',
    ]);
    expect((await registry.routeEmailVerification(db as never)).map((provider) => provider.key).slice(0, 2)).toEqual([
      'smtp_self',
      'public_web',
    ]);
    expect((await registry.routeEnrichment(db as never)).map((provider) => provider.key)).toEqual([
      'wikidata',
      'gleif',
    ]);
    expect((await registry.routeSignalEnrichment(db as never)).map((provider) => provider.key)).toEqual([
      'digital_footprint',
      'structured_harvest',
    ]);
  });

  it('filters every route against the DB kill switch and re-reads it per decision', async () => {
    const registry = new DiscoveryProviderRegistry({ gateway: {} as never });
    const db = providerDb([]);

    await expect(registry.routeCompanyDiscovery(db as never, 'public_intelligence')).resolves.toEqual([]);
    await expect(registry.routeContactDiscovery(db as never)).resolves.toEqual([]);
    await expect(registry.routeEmailVerification(db as never)).resolves.toEqual([]);
    await expect(registry.routeEnrichment(db as never)).resolves.toEqual([]);
    await expect(registry.routeSignalEnrichment(db as never)).resolves.toEqual([]);
    expect(db.dataProvider.findMany).toHaveBeenCalledTimes(5);
    expect(db.dataProvider.findMany).toHaveBeenCalledWith({ where: { status: 'ENABLED' }, select: { key: true } });
  });
});

describe('DiscoveryProviderRegistry seed', () => {
  it('seeds deterministic provider defaults without requiring the optional policy table', async () => {
    process.env.DISCOVERY_ALLOW_SANDBOX = 'false';
    const registry = new DiscoveryProviderRegistry({ gateway: {} as never });
    const db = providerDb();

    await registry.seed({ dataProvider: db.dataProvider } as never);

    const creates = db.dataProvider.upsert.mock.calls.map(([input]) => input.create);
    expect(creates.map((row) => row.key)).toEqual(expect.arrayContaining([
      'public_web',
      'wikidata',
      'openstreetmap',
      'gleif',
      'directory',
      'trade_fair',
      'ted',
      'openfda',
      'digital_footprint',
      'structured_harvest',
      'smtp_self',
      'decision_maker',
      'companies_house',
      'inpi_rne',
      'google_patents',
      'samgov',
      'web_watch',
      'email_guess',
    ]));
    expect(creates.find((row) => row.key === 'google_patents')?.status).toBe('DISABLED');
    expect(creates.find((row) => row.key === 'samgov')?.status).toBe('DISABLED');
    expect(creates.find((row) => row.key === 'email_guess')?.status).toBe('DISABLED');
    expect(creates.some((row) => row.key === 'sandbox')).toBe(false);
  });

  it('seeds all source-policy governance rows and the opt-in sandbox provider', async () => {
    process.env.DISCOVERY_ALLOW_SANDBOX = 'true';
    const registry = new DiscoveryProviderRegistry({ gateway: {} as never });
    const db = providerDb();

    await registry.seed(db as never);

    const providerKeys = db.dataProvider.upsert.mock.calls.map(([input]) => input.where.key);
    const policyDomains = db.sourcePolicy.upsert.mock.calls.map(([input]) => input.where.domain);
    expect(providerKeys).toContain('sandbox');
    expect(policyDomains).toEqual(expect.arrayContaining([
      'api.ted.europa.eu',
      'api.fda.gov',
      'query.wikidata.org',
      'www.wikidata.org',
      'overpass-api.de',
      'api.gleif.org',
      'algolia.net',
      'mapyourshow.com',
      'api.company-information.service.gov.uk',
      'recherche-entreprises.api.gouv.fr',
      'bigquery.googleapis.com',
      'sam.gov',
    ]));
    expect(db.sourcePolicy.upsert.mock.calls.every(([input]) => Object.keys(input.update).length === 0)).toBe(true);
  });

  it('is replay-safe: a second seed emits the exact same upsert payloads', async () => {
    process.env.DISCOVERY_ALLOW_SANDBOX = 'false';
    const registry = new DiscoveryProviderRegistry({ gateway: {} as never });
    const db = providerDb();

    await registry.seed(db as never);
    const firstProviderPayloads = db.dataProvider.upsert.mock.calls.map(([input]) => structuredClone(input));
    const firstPolicyPayloads = db.sourcePolicy.upsert.mock.calls.map(([input]) => structuredClone(input));
    db.dataProvider.upsert.mockClear();
    db.sourcePolicy.upsert.mockClear();

    await registry.seed(db as never);

    expect(db.dataProvider.upsert.mock.calls.map(([input]) => input)).toEqual(firstProviderPayloads);
    expect(db.sourcePolicy.upsert.mock.calls.map(([input]) => input)).toEqual(firstPolicyPayloads);
  });
});
