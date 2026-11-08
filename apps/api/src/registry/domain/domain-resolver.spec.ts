import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOISE_DOMAINS,
  MultiRouteDomainResolver,
  brandToken,
  canonicalDomain,
  type CertificateTransparencyProvider,
  type CommonCrawlIndexProvider,
  type DomainSearchProvider,
} from './domain-resolver';

class FakeSearchProvider implements DomainSearchProvider {
  calls: Array<{ q: string; country?: string }> = [];

  constructor(
    readonly key: string,
    private readonly hits: Array<{ url: string; rank: number }>,
    private readonly fail = false,
  ) {}

  async search(input: { q: string; country?: string }) {
    this.calls.push(input);
    if (this.fail) throw new Error('provider down');
    return this.hits;
  }
}

const ctProvider = (domains: string[]): CertificateTransparencyProvider => ({
  key: 'crt_sh_fixture',
  async lookupDomainToken() {
    return domains;
  },
});

const ccProvider = (hosts: string[]): CommonCrawlIndexProvider => ({
  key: 'cc_index_fixture',
  async lookupHosts() {
    return hosts;
  },
});

describe('canonicalDomain', () => {
  it('normalizes urls and hosts, rejects ip/invalid values', () => {
    expect(canonicalDomain('https://www.Muster-Pumpen.de/kontakt?x=1')).toBe('muster-pumpen.de');
    expect(canonicalDomain('muster-pumpen.de:443')).toBe('muster-pumpen.de');
    expect(canonicalDomain('192.168.1.1')).toBeNull();
    expect(canonicalDomain('localhost')).toBeNull();
    expect(canonicalDomain('not a domain')).toBeNull();
  });
});

describe('brandToken', () => {
  it('picks the longest normalized token and strips legal suffixes', () => {
    expect(brandToken('Muster Pumpen GmbH')).toBe('muster');
    expect(brandToken('AG der Ventile')).toBe('ventile');
    expect(brandToken('AG KG')).toBeNull();
  });
});

describe('MultiRouteDomainResolver (fixtures, no network)', () => {
  it('merges the three routes, dedupes, and ranks source_field < search < ct < cc', async () => {
    const resolver = new MultiRouteDomainResolver({
      searchProviders: [
        new FakeSearchProvider('brave_fixture', [
          { url: 'https://www.muster-pumpen.de/', rank: 1 },
          { url: 'https://de.linkedin.com/company/muster-pumpen', rank: 2 },
          { url: 'https://www.muster-pumpen.de/kontakt', rank: 3 },
        ]),
        new FakeSearchProvider('serper_fixture', [{ url: 'https://muster-pumpen.de', rank: 1 }]),
      ],
      ctProviders: [ctProvider(['shop.muster-pumpen.de', 'muster-pumpen.de'])],
      ccProviders: [ccProvider(['muster-pumpen.de', 'pumpen-portal.example'])],
    });
    const result = await resolver.resolve({
      name: 'Muster Pumpen GmbH',
      country: 'DE',
      city: 'München',
      website: 'https://muster-pumpen.de',
    });
    expect(result.status).toBe('CANDIDATES');
    expect(result.candidates.map((candidate) => candidate.domain)).toEqual([
      'muster-pumpen.de',
      'shop.muster-pumpen.de',
      'pumpen-portal.example',
    ]);
    const sourceField = result.candidates[0]!;
    expect(sourceField.route).toBe('source_field');
    // 四路（搜索 ×2、CT、CC）与自带 website 同域：合并进源字段候选，其余路记 alsoSeenIn。
    expect(sourceField.evidence.alsoSeenIn).toEqual([
      'brave_fixture',
      'cc_index_fixture',
      'crt_sh_fixture',
      'serper_fixture',
    ]);
  });

  it('filters noise domains (directories, social, aggregators)', async () => {
    const resolver = new MultiRouteDomainResolver({
      searchProviders: [
        new FakeSearchProvider('mojeek_fixture', [
          { url: 'https://www.linkedin.com/company/x', rank: 1 },
          { url: 'https://www.gelbeseiten.de/firma/x', rank: 2 },
          { url: 'https://xing.com/x', rank: 3 },
        ]),
      ],
    });
    const result = await resolver.resolve({ name: 'Beispiel Ventile GmbH', country: 'DE' });
    expect(result).toEqual({ candidates: [], status: 'NOT_FOUND', notFoundReason: 'NO_HITS' });
  });

  it('reports NO_PROVIDERS when nothing is configured and no website field exists', async () => {
    const resolver = new MultiRouteDomainResolver({});
    const result = await resolver.resolve({ name: 'Beispiel Ventile GmbH' });
    expect(result.status).toBe('NOT_FOUND');
    expect(result.notFoundReason).toBe('NO_PROVIDERS');
  });

  it('survives a single provider failure (candidate generation is degradable)', async () => {
    const resolver = new MultiRouteDomainResolver({
      searchProviders: [
        new FakeSearchProvider('down_fixture', [], true),
        new FakeSearchProvider('up_fixture', [{ url: 'https://muster-pumpen.de', rank: 1 }]),
      ],
    });
    const result = await resolver.resolve({ name: 'Muster Pumpen GmbH' });
    expect(result.status).toBe('CANDIDATES');
    expect(result.candidates[0]!.evidence.provider).toBe('up_fixture');
  });

  it('caps candidates and keeps the configured noise list free of duplicates', () => {
    expect(new Set(DEFAULT_NOISE_DOMAINS).size).toBe(DEFAULT_NOISE_DOMAINS.length);
  });
});
