import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DIRECTORY_PUBLIC_B2B_LISTING_POLICY_DOMAIN,
  PUBLIC_WEB_COMPANY_SITE_POLICY_DOMAIN,
} from '../source-policy-scope';
import { directorySourcePolicyDecision } from '../directory-source-policy';
import type { CompanyDiscoveryQuery, DiscoveryOptions, ExecutionContext } from '../provider-contract';
import type { RawSourcePolicySnapshot } from '../raw-source-ingestion';

const mocks = vi.hoisted(() => ({ robots: vi.fn(async () => true), model: vi.fn() }));
vi.mock('../../adapters/robots', () => ({ isAllowedByRobots: mocks.robots }));
vi.mock('../../model-runtime/structured-task-runtime-bridge', () => ({ executeStructuredTaskWithRuntime: mocks.model }));
import { DirectoryDiscoveryProvider } from './directory.provider';
import { MAX_DIRECTORY_LISTING_PAGES } from '../execution-envelope';

const ctx: ExecutionContext = { workspaceId: 'd8417bb4-5257-46c0-b600-aeb1e89e429d', runId: 'policy-test' };
const query: CompanyDiscoveryQuery = { sourceClass: 'industry_data', filters: { country: 'DE' }, keywords: ['pumps'], limit: 10 };
function policy(domain: string, extra: Partial<RawSourcePolicySnapshot> = {}): RawSourcePolicySnapshot {
  return { id: domain, domain, retentionDays: 30, reviewStatus: 'APPROVED', allowedPurpose: ['discovery'], updatedAt: new Date('2026-11-20T00:00:00Z'), ...extra };
}
function harness(urls: string[]) {
  const invoke = vi.fn(async (tool: string, input: { url?: string }) => {
    if (tool === 'searxng.search') return { data: { results: urls.map(url => ({ url, title: 'Members directory' })) }, costCents: 0 };
    return { data: { url: input.url, text: '' }, costCents: 0 };
  });
  return { invoke, provider: new DirectoryDiscoveryProvider({ gateway: {} as never, broker: { invoke } as never }) };
}
function options(policies: RawSourcePolicySnapshot[]): DiscoveryOptions {
  return { sourcePolicyCheck: (url: string) => directorySourcePolicyDecision(url, policies) };
}
beforeEach(() => { vi.clearAllMocks(); mocks.robots.mockResolvedValue(true); });

describe('directory source admission matches raw policy semantics', () => {
  it('requires a real directory policy, without company-site fallback', () => {
    expect(directorySourcePolicyDecision('https://directory.example/members', [policy(PUBLIC_WEB_COMPANY_SITE_POLICY_DOMAIN)])).toEqual({ allowed: false, reasonCode: 'SOURCE_POLICY_MISSING' });
  });
  it('admits public B2B listing hosts via directory:public_b2b_listing while blocking deny-listed brokers and honoring site SUSPENDED', () => {
    const fallback = policy(DIRECTORY_PUBLIC_B2B_LISTING_POLICY_DOMAIN);
    expect(directorySourcePolicyDecision('https://www.italiasolare.eu/elenco-soci', [fallback])).toEqual({ allowed: true });
    for (const url of [
      'https://www.linkedin.com/company/acme',
      'https://zoominfo.com/c/acme',
      'https://www.europages.it/aziende/solare',
      'https://sub.paginegialle.it/ricerca/fotovoltaico',
      'https://www.kompass.com/z/it',
    ]) {
      expect(directorySourcePolicyDecision(url, [fallback])).toEqual({ allowed: false, reasonCode: 'SOURCE_POLICY_MISSING' });
    }
    expect(directorySourcePolicyDecision('https://italiasolare.eu/elenco-soci', [
      fallback,
      policy('italiasolare.eu', { reviewStatus: 'SUSPENDED' }),
    ])).toEqual({ allowed: false, reasonCode: 'SOURCE_POLICY_SUSPENDED' });
    expect(directorySourcePolicyDecision('https://italiasolare.eu/elenco-soci', [
      policy(DIRECTORY_PUBLIC_B2B_LISTING_POLICY_DOMAIN, { reviewStatus: 'SUSPENDED' }),
    ])).toEqual({ allowed: false, reasonCode: 'SOURCE_POLICY_SUSPENDED' });
  });
  it.each(['https://directory.example/members', 'https://www.directory.example/members', 'https://sub.directory.example/members'])('matches exact/parent and www policy: %s', url => {
    expect(directorySourcePolicyDecision(url, [policy('WWW.Directory.Example')])).toEqual({ allowed: true });
  });
  it('does not replace a more specific denied policy with an approved parent', () => {
    expect(directorySourcePolicyDecision('https://sub.directory.example/list', [policy('directory.example'), policy('sub.directory.example', { reviewStatus: 'SUSPENDED' })])).toEqual({ allowed: false, reasonCode: 'SOURCE_POLICY_SUSPENDED' });
  });
  it('preserves suspended spelling precedence regardless of row order', () => {
    const rows = [policy('directory.example'), policy('WWW.DIRECTORY.EXAMPLE', { reviewStatus: 'SUSPENDED' })];
    for (const list of [rows, [...rows].reverse()]) expect(directorySourcePolicyDecision('https://directory.example/list', list)).toEqual({ allowed: false, reasonCode: 'SOURCE_POLICY_SUSPENDED' });
  });
  it.each([[undefined], [[]], [['enrichment']], [['discovery', 3]]])('requires a valid discovery purpose: %j', purpose => {
    expect(directorySourcePolicyDecision('https://directory.example/list', [policy('directory.example', { allowedPurpose: purpose })])).toEqual({ allowed: false, reasonCode: 'SOURCE_POLICY_PURPOSE_NOT_ALLOWED' });
  });
  it.each(['file:///tmp/members', 'https://user:password@directory.example/members', 'https://directory.example:8443/members', 'not a URL'])('rejects invalid provenance: %s', url => {
    expect(directorySourcePolicyDecision(url, [policy('directory.example')])).toEqual({ allowed: false, reasonCode: 'INVALID_PROVENANCE' });
  });
});

describe('directory preflight runs before crawl and model extraction', () => {
  it('fails closed without trusted source policy context', async () => {
    const h = harness(['https://directory.example/members']);
    const result = await h.provider.discoverCompanies(query, ctx);
    expect(h.invoke).not.toHaveBeenCalled();
    expect(mocks.robots).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
    expect(result.outcome?.reasonCode).toBe('SOURCE_POLICY_CONTEXT_MISSING');
  });
  it.each([
    [[], 'SOURCE_POLICY_MISSING'],
    [[policy('directory.example', { reviewStatus: 'SUSPENDED' })], 'SOURCE_POLICY_SUSPENDED'],
    [[policy('directory.example', { allowedPurpose: ['enrichment'] })], 'SOURCE_POLICY_PURPOSE_NOT_ALLOWED'],
  ] as const)('does not crawl or extract denied listings (%s)', async (rows, reason) => {
    const h = harness(['https://directory.example/members']);
    const result = await h.provider.discoverCompanies(query, ctx, options([...rows]));
    expect(h.invoke.mock.calls.every(([tool]) => tool === 'searxng.search')).toBe(true);
    expect(mocks.robots).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
    expect(result.records).toEqual([]);
    expect(result.outcome?.reasonCode).toBe(reason);
    expect(result.lineage?.recordCount).toBe(0);
  });
  it('applies the page cap after policy admission, so denied hits do not consume it', async () => {
    const urls = Array.from({ length: MAX_DIRECTORY_LISTING_PAGES }, (_, i) => `https://denied${i}.example/members`);
    urls.push('https://approved.example/members');
    const h = harness(urls);
    await h.provider.discoverCompanies(query, ctx, options([policy('approved.example')]));
    expect(h.invoke.mock.calls.filter(([tool]) => tool === 'crawl4ai.fetch').map(([, input]) => input.url)).toEqual(['https://approved.example/members']);
  });
  it('does not call a genuine admitted empty listing a policy-only failure', async () => {
    const h = harness(['https://unapproved.example/members', 'https://approved.example/members']);
    const result = await h.provider.discoverCompanies(query, ctx, options([policy('approved.example')]));
    expect(h.invoke.mock.calls.some(([tool]) => tool === 'crawl4ai.fetch')).toBe(true);
    expect(result.records).toEqual([]);
    expect(result.outcome).toBeUndefined();
  });
  it('checks policy again immediately before fetching a selected page', async () => {
    const h = harness(['https://directory.example/members']);
    const check = vi.fn().mockReturnValueOnce({ allowed: true }).mockReturnValue({ allowed: false, reasonCode: 'SOURCE_POLICY_SUSPENDED' });
    const result = await h.provider.discoverCompanies(query, ctx, { sourcePolicyCheck: check });
    expect(h.invoke.mock.calls.some(([tool]) => tool === 'crawl4ai.fetch')).toBe(false);
    expect(result.outcome?.reasonCode).toBe('SOURCE_POLICY_SUSPENDED');
  });
  it('keeps the requested listing URL for pagination when a persisted anchor is only the origin', async () => {
    const start = 'https://approved.example/Members/List';
    const h = harness([start]);
    h.invoke.mockImplementation(async (tool: string, _input: { url?: string }) => tool === 'searxng.search'
      ? { data: { results: [{ url: start, title: 'Members directory' }] }, costCents: 0 }
      : { data: { url: 'https://approved.example/', text: '[next](page/2)\n' + 'Directory companies '.repeat(30) }, costCents: 0 });
    mocks.model.mockResolvedValueOnce({ data: { is_directory: true, companies: [{ name: 'One', website: 'https://one.example' }], has_next_page: true } })
      .mockResolvedValueOnce({ data: { is_directory: true, companies: [{ name: 'Two', website: 'https://two.example' }], has_next_page: false } });
    const result = await h.provider.discoverCompanies(query, ctx, options([policy('approved.example')]));
    expect(h.invoke.mock.calls.filter(([tool]) => tool === 'crawl4ai.fetch').map(([, input]) => input.url)).toEqual([start, 'https://approved.example/Members/page/2']);
    expect(result.records[0]?.provenance?.sourceUrl).toBe(start);
  });
  it('does not relabel a requested listing as another approved publisher', async () => {
    const h = harness(['https://approved.example/members']);
    h.invoke.mockImplementation(async (tool: string) => tool === 'searxng.search'
      ? { data: { results: [{ url: 'https://approved.example/members', title: 'Members directory' }] }, costCents: 0 }
      : { data: { url: 'https://other-approved.example/members', text: 'Directory companies '.repeat(30) }, costCents: 0 });
    const result = await h.provider.discoverCompanies(query, ctx, options([policy('approved.example'), policy('other-approved.example')]));
    expect(mocks.model).not.toHaveBeenCalled();
    expect(result.outcome?.reasonCode).toBe('INVALID_PROVENANCE');
  });
  it('exports only stable denial reasons, never a checker free-text message', async () => {
    const h = harness(['https://directory.example/members']);
    const result = await h.provider.discoverCompanies(query, ctx, { sourcePolicyCheck: () => ({ allowed: false, reasonCode: 'private diagnostic: do not echo this' }) });
    expect(result.outcome?.reasonCode).toBe('SOURCE_POLICY_CONTEXT_MISSING');
    expect(JSON.stringify(result)).not.toContain('private diagnostic');
  });
  it('checks a reported different source URL before model extraction', async () => {
    const h = harness(['https://approved.example/members']);
    h.invoke.mockImplementation(async (tool: string) => tool === 'searxng.search'
      ? { data: { results: [{ url: 'https://approved.example/members', title: 'Members directory' }] }, costCents: 0 }
      : { data: { url: 'https://unapproved.example/members', text: 'Directory companies '.repeat(30) }, costCents: 0 });
    const result = await h.provider.discoverCompanies(query, ctx, options([policy('approved.example')]));
    expect(mocks.model).not.toHaveBeenCalled();
    expect(result.outcome?.reasonCode).toBe('SOURCE_POLICY_MISSING');
  });

  it('routes approved PV association seed directories through policy admission, strips noise, backfills country, and deduplicates across directories', async () => {
    const pvQuery: CompanyDiscoveryQuery = {
      sourceClass: 'industry_data',
      filters: { country: 'DE', industry: 'photovoltaic' },
      keywords: ['solar'],
      limit: 20,
    };
    const invoke = vi.fn(async (tool: string, input: { url?: string }) => {
      if (tool === 'searxng.search') return { data: { results: [] }, costCents: 0 };
      return { data: { url: input.url, text: 'Solar association member directory listing '.repeat(20) }, costCents: 0 };
    });
    const provider = new DirectoryDiscoveryProvider({ gateway: {} as never, broker: { invoke } as never });
    mocks.model
      .mockResolvedValueOnce({
        data: {
          is_directory: true,
          companies: [
            { name: 'BSW-Solar', website: 'https://www.solarwirtschaft.de/' },
            { name: 'Gold Sponsor', website: 'https://example-sponsor.de' },
            { name: '1. BayWa r.e. AG (Gold Member)' },
            { name: 'Axitec Energy GmbH', website: 'https://www.axitecsolar.com/?utm_source=bsw' },
          ],
          has_next_page: false,
        },
      })
      .mockResolvedValueOnce({
        data: {
          is_directory: true,
          companies: [
            { name: 'BayWa r.e.', website: 'https://baywa-re.com/?ref=bne' },
            { name: 'Impressum' },
          ],
          has_next_page: false,
        },
      });

    // Only admit BSW-Solar & bne; keep BVES explicitly SUSPENDED so it is never crawled.
    const result = await provider.discoverCompanies(
      pvQuery,
      ctx,
      options([
        policy('solarwirtschaft.de'),
        policy('bne-online.de'),
        policy('bves.de', { reviewStatus: 'SUSPENDED' }),
      ]),
    );

    const crawledUrls = invoke.mock.calls
      .filter(([tool]) => tool === 'crawl4ai.fetch')
      .map(([, input]) => input.url);
    expect(crawledUrls).toEqual([
      'https://www.solarwirtschaft.de/unsere-mitglieder/mitgliedersuche/',
      'https://www.bne-online.de/verband/unsere-mitglieder/',
    ]);
    expect(result.records.map((r) => ({ name: r.name, domain: r.domain, country: r.country }))).toEqual([
      { name: 'BayWa r.e.', domain: 'baywa-re.com', country: 'DE' },
      { name: 'Axitec Energy GmbH', domain: 'axitecsolar.com', country: 'DE' },
    ]);
  });
});
