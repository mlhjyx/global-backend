import { resolveMx } from 'node:dns/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractPublicContacts } from '../../adapters/contact-extractor';
import { extractSameSiteLinks } from '../../adapters/site-links';
import { isAllowedByRobots } from '../../adapters/robots';
import { executeStructuredTaskWithRuntime } from '../../model-runtime/structured-task-runtime-bridge';
import {
  buildPublicContacts,
  buildSearchQueries,
  PublicWebDiscoveryProvider,
} from './public-web.provider';

vi.mock('node:dns/promises', () => ({ resolveMx: vi.fn() }));
vi.mock('../../adapters/robots', () => ({ isAllowedByRobots: vi.fn() }));
vi.mock('../../adapters/site-links', () => ({ extractSameSiteLinks: vi.fn() }));
vi.mock('../../adapters/contact-extractor', () => ({ extractPublicContacts: vi.fn() }));
vi.mock('../../model-runtime/structured-task-runtime-bridge', () => ({
  executeStructuredTaskWithRuntime: vi.fn(),
}));

const ctx = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  runId: 'run-1',
  correlationId: 'discovery-1',
};
const query = {
  sourceClass: 'public_intelligence' as const,
  filters: { industry: ['industrial pumps'], country: ['DE', 'AT'] },
  keywords: ['centrifugal', 'chemical', 'supplier'],
};

function search(results: Array<{ url: string; title: string }>) {
  return { data: { results }, costCents: 0 };
}
function crawl(text: string) {
  return { data: { url: 'https://pump.example/', text }, costCents: 0 };
}

describe('PublicWebDiscoveryProvider runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAllowedByRobots).mockResolvedValue(true);
    vi.mocked(extractSameSiteLinks).mockReturnValue([]);
    vi.mocked(extractPublicContacts).mockReturnValue([]);
  });

  it('builds two bounded searches from scalar/array filters and deterministic fallbacks', () => {
    expect(buildSearchQueries(query)).toEqual([
      'industrial pumps centrifugal chemical manufacturer company DE',
      'supplier supplier AT',
    ]);
    expect(buildSearchQueries({ sourceClass: 'public_intelligence', filters: { sub_industry: 'valves', region: 'EU' }, keywords: [] }))
      .toEqual(['valves manufacturer company EU', 'valves supplier']);
    expect(buildSearchQueries({ sourceClass: 'public_intelligence', filters: {}, keywords: [] }))
      .toEqual(['manufacturer company', 'manufacturing supplier']);
  });

  it('fails closed without a broker', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const provider = new PublicWebDiscoveryProvider({ gateway: {} as any });
    await expect(provider.discoverCompanies(query, ctx)).resolves.toEqual({ records: [], costCents: 0 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('broker unavailable'));
    log.mockRestore();
  });

  it('filters noise, blocked, and duplicate domains before mining', async () => {
    const broker = {
      invoke: vi.fn(async (tool: string) => {
        if (tool === 'searxng.search') {
          return search([
            { url: 'https://linkedin.com/company/pump', title: 'noise' },
            { url: 'https://blocked.example', title: 'blocked' },
            { url: 'https://pump.example/products', title: 'Pump' },
            { url: 'https://pump.example/about', title: 'duplicate domain' },
          ]);
        }
        return crawl('company public text '.repeat(20));
      }),
    };
    vi.mocked(executeStructuredTaskWithRuntime).mockResolvedValue({ data: {
      is_company_site: true,
      name: ' Pump GmbH ',
      country: 'DE',
      industry: 'Pumps',
      employee_count: 42,
      products: ['centrifugal pump'],
      keywords: ['industrial'],
      evidence: 'manufacturer statement',
      confidence: 0.9,
    } } as any);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const provider = new PublicWebDiscoveryProvider({ gateway: {} as any, broker: broker as any, runtimeTelemetry: {} as any });

    const result = await provider.discoverCompanies(query, ctx, { blockedDomains: ['BLOCKED.EXAMPLE'] });

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      externalId: 'pump.example',
      name: 'Pump GmbH',
      domain: 'pump.example',
      country: 'DE',
      industry: 'Pumps',
      employeeCount: 42,
      attributes: {
        products: ['centrifugal pump'],
        keywords: ['industrial'],
        extraction_evidence: 'manufacturer statement',
        extraction_confidence: 0.9,
        source_class: 'public_intelligence',
      },
    });
    expect(result.records[0]?.provenance.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(broker.invoke).toHaveBeenCalledWith(
      'crawl4ai.fetch',
      { url: 'https://pump.example/' },
      expect.objectContaining({ purpose: ['discovery', 'enrichment'] }),
    );
    log.mockRestore();
  });

  it('isolates robots, crawl, short-page, non-company, and rejected model branches', async () => {
    for (const mode of ['robots', 'crawl', 'short', 'not-company', 'model-reject'] as const) {
      vi.mocked(isAllowedByRobots).mockReset().mockResolvedValue(mode !== 'robots');
      vi.mocked(executeStructuredTaskWithRuntime).mockReset();
      if (mode === 'not-company') {
        vi.mocked(executeStructuredTaskWithRuntime).mockResolvedValue({ data: { is_company_site: false } } as any);
      } else if (mode === 'model-reject') {
        vi.mocked(executeStructuredTaskWithRuntime).mockRejectedValue(new Error('model failed'));
      }
      const broker = {
        invoke: vi.fn(async (tool: string) => {
          if (tool === 'searxng.search') return search([{ url: 'https://pump.example', title: 'Pump' }]);
          if (mode === 'crawl') throw new Error('private crawl response');
          return crawl(mode === 'short' ? 'tiny' : 'company text '.repeat(30));
        }),
      };
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const provider = new PublicWebDiscoveryProvider({ gateway: {} as any, broker: broker as any });
      await expect(provider.discoverCompanies(query, ctx)).resolves.toEqual({ records: [], costCents: 0 });
      if (mode === 'crawl') {
        expect(JSON.stringify(log.mock.calls)).toMatch(/ERROR_TEXT_SHA256:/);
        expect(JSON.stringify(log.mock.calls)).not.toContain('private crawl response');
      }
      log.mockRestore();
    }
  });

  it('maps absent optional extraction fields without manufacturing facts', async () => {
    const broker = {
      invoke: vi.fn(async (tool: string) =>
        tool === 'searxng.search'
          ? search([{ url: 'https://pump.example', title: 'Pump' }])
          : crawl('company text '.repeat(30))),
    };
    vi.mocked(executeStructuredTaskWithRuntime).mockResolvedValue({ data: {
      is_company_site: true,
      name: 'Bare Pump',
      employee_count: null,
    } } as any);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const provider = new PublicWebDiscoveryProvider({ gateway: {} as any, broker: broker as any });
    const result = await provider.discoverCompanies(query, ctx);
    expect(result.records[0]).toMatchObject({
      country: undefined,
      industry: undefined,
      employeeCount: undefined,
      attributes: {
        products: [],
        keywords: [],
        extraction_evidence: null,
        extraction_confidence: null,
      },
    });
    log.mockRestore();
  });

  it('fails contact discovery closed for missing domain, broker, or robots permission', async () => {
    const noBroker = new PublicWebDiscoveryProvider({ gateway: {} as any });
    await expect(noBroker.discoverContacts({ name: 'No domain' }, ctx)).resolves.toEqual({ contacts: [], costCents: 0 });
    await expect(noBroker.discoverContacts({ name: 'Pump', domain: 'pump.example' }, ctx)).resolves.toEqual({ contacts: [], costCents: 0 });

    vi.mocked(isAllowedByRobots).mockResolvedValueOnce(false);
    const broker = { invoke: vi.fn() };
    const provider = new PublicWebDiscoveryProvider({ gateway: {} as any, broker: broker as any });
    await expect(provider.discoverContacts({ name: 'Pump', domain: 'pump.example' }, ctx)).resolves.toEqual({ contacts: [], costCents: 0 });
    expect(broker.invoke).not.toHaveBeenCalled();
  });

  it('crawls bounded contact pages, tolerates a child failure, and maps public contacts', async () => {
    const broker = {
      invoke: vi.fn(async (_tool: string, input: { url: string }) => {
        if (input.url.endsWith('/kontakt')) throw new Error('child failed');
        return crawl('home with public contacts');
      }),
    };
    vi.mocked(extractSameSiteLinks).mockReturnValue([
      'https://pump.example/contact',
      'https://pump.example/kontakt',
      'https://pump.example/products',
    ]);
    vi.mocked(extractPublicContacts).mockReturnValue([
      { type: 'email', value: 'jane.doe@pump.example', sourceUrl: 'https://pump.example/contact' },
      { type: 'email', value: 'info@pump.example', sourceUrl: 'https://pump.example/contact' },
      { type: 'phone', value: '+493012345678', sourceUrl: 'https://pump.example/contact' },
    ] as any);
    const provider = new PublicWebDiscoveryProvider({ gateway: {} as any, broker: broker as any });

    const result = await provider.discoverContacts({ name: 'Pump', domain: 'pump.example' }, ctx);

    expect(result.contacts).toHaveLength(2);
    expect(result.contacts[0]).toMatchObject({
      fullName: 'Jane Doe',
      personalData: true,
      sourcePage: 'https://pump.example/',
      phone: '+493012345678',
    });
    expect(result.contacts[1]).toMatchObject({
      fullName: '公开联系点 (info@)',
      title: 'switchboard',
      department: 'general',
      phone: undefined,
    });
  });

  it('returns no contacts when the home crawl fails', async () => {
    const provider = new PublicWebDiscoveryProvider({
      gateway: {} as any,
      broker: { invoke: vi.fn(async () => { throw new Error('home unavailable'); }) } as any,
    });
    await expect(provider.discoverContacts({ name: 'Pump', domain: 'pump.example' }, ctx)).resolves.toEqual({
      contacts: [],
      costCents: 0,
    });
  });

  it('verifies only syntax and MX reachability without claiming mailbox validity', async () => {
    const provider = new PublicWebDiscoveryProvider({ gateway: {} as any });
    await expect(provider.verifyEmail('bad')).resolves.toEqual({ status: 'INVALID', detail: 'syntax', costCents: 0 });
    vi.mocked(resolveMx).mockResolvedValueOnce([]);
    await expect(provider.verifyEmail('info@pump.example')).resolves.toEqual({ status: 'INVALID', detail: 'no MX records', costCents: 0 });
    vi.mocked(resolveMx).mockResolvedValueOnce([{ exchange: 'mx.pump.example', priority: 10 }]);
    await expect(provider.verifyEmail('info@pump.example')).resolves.toMatchObject({
      status: 'RISKY',
      detail: 'MX present (mx.pump.example); mailbox unverified',
    });
    vi.mocked(resolveMx).mockRejectedValueOnce(new Error('dns failed'));
    await expect(provider.verifyEmail('info@pump.example')).resolves.toEqual({ status: 'INVALID', detail: 'DNS lookup failed', costCents: 0 });
  });

  it('caps public contacts and handles unusual local-parts defensively', () => {
    const contacts = buildPublicContacts(
      'pump.example',
      [
        { value: 'single@pump.example' },
        { value: 'first_last@pump.example' },
        { value: 'two@pump.example' },
        { value: 'three@pump.example' },
        { value: 'four@pump.example' },
        { value: 'five@pump.example' },
      ],
      undefined,
    );
    expect(contacts).toHaveLength(5);
    expect(contacts[0]).toMatchObject({ title: 'switchboard', phone: undefined });
    expect(contacts[1]).toMatchObject({ fullName: 'First Last', personalData: true });
  });
});
