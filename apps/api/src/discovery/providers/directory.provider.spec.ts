import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractSameSiteLinks } from '../../adapters/site-links';
import { isAllowedByRobots } from '../../adapters/robots';
import { executeStructuredTaskWithRuntime } from '../../model-runtime/structured-task-runtime-bridge';
import { buildDirectorySearches, DirectoryDiscoveryProvider } from './directory.provider';

vi.mock('../../adapters/robots', () => ({ isAllowedByRobots: vi.fn() }));
vi.mock('../../adapters/site-links', () => ({ extractSameSiteLinks: vi.fn() }));
vi.mock('../../model-runtime/structured-task-runtime-bridge', () => ({
  executeStructuredTaskWithRuntime: vi.fn(),
}));

const ctx = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  runId: 'run-1',
  correlationId: 'discovery-1',
};

const query = {
  sourceClass: 'industry_data' as const,
  filters: { industry: ['industrial pumps'], region: 'Germany' },
  keywords: ['centrifugal pump'],
};

function searchResult(results: Array<{ url: string; title: string }>) {
  return { data: { results }, costCents: 0 };
}

function crawlResult(text: string) {
  return { data: { url: 'https://association.example/members', text }, costCents: 0 };
}

describe('DirectoryDiscoveryProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAllowedByRobots).mockResolvedValue(true);
    vi.mocked(extractSameSiteLinks).mockReturnValue([]);
  });

  it('builds bounded, deduplicated multilingual directory searches from scalar or array filters', () => {
    expect(buildDirectorySearches(query)).toEqual([
      'industrial pumps centrifugal pump members directory Germany',
      'industrial pumps centrifugal pump member companies Germany',
      'industrial pumps centrifugal pump Mitgliederverzeichnis Germany',
      'industrial pumps centrifugal pump Mitglieder Germany',
    ]);
    expect(buildDirectorySearches({
      sourceClass: 'industry_data',
      filters: { sub_industry: 'valves', country: ['DE'] },
      keywords: [],
    })).toHaveLength(4);
    expect(buildDirectorySearches({
      sourceClass: 'industry_data',
      filters: {},
      keywords: [],
    })[0]).toContain('manufacturing');
  });

  it('fails closed without the execution broker', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const provider = new DirectoryDiscoveryProvider({ gateway: {} as any });
    await expect(provider.discoverCompanies(query, ctx)).resolves.toEqual({ records: [], costCents: 0 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('broker unavailable'));
    log.mockRestore();
  });

  it('filters blocked/noise/non-listing search hits before crawling', async () => {
    const broker = {
      invoke: vi.fn(async (tool: string) => {
        expect(tool).toBe('searxng.search');
        return searchResult([
          { url: 'https://blocked.example/members', title: 'Members' },
          { url: 'https://linkedin.com/company/pump', title: 'Members' },
          { url: 'https://association.example/products', title: 'Products' },
        ]);
      }),
    };
    const provider = new DirectoryDiscoveryProvider({ gateway: {} as any, broker: broker as any });

    await expect(provider.discoverCompanies(query, ctx, { blockedDomains: ['BLOCKED.EXAMPLE'] })).resolves.toEqual({
      records: [],
      costCents: 0,
    });
    expect(broker.invoke).toHaveBeenCalledTimes(4);
  });

  it('extracts paginated directories, normalizes companies, and deduplicates by domain or name', async () => {
    const broker = {
      invoke: vi.fn(async (tool: string, input: { url?: string }) => {
        if (tool === 'searxng.search') {
          return searchResult([
            { url: 'https://association.example/members', title: 'Member companies' },
            { url: 'https://association.example/members', title: 'duplicate' },
          ]);
        }
        return crawlResult(`${'directory company listing '.repeat(12)} [next](?page=2) ${input.url}`);
      }),
    };
    vi.mocked(extractSameSiteLinks).mockReturnValue(['https://association.example/members?page=2']);
    vi.mocked(executeStructuredTaskWithRuntime)
      .mockResolvedValueOnce({ data: {
        is_directory: true,
        list_kind: 'association',
        has_next_page: true,
        companies: [
          { name: ' Pump GmbH ', website: 'https://pump.example/products', location: 'Berlin', detail_url: '/pump' },
          { name: 'No Site Ltd', location: 'London' },
          { name: 'Noise', website: 'https://linkedin.com/company/noise' },
          { name: '   ', website: 'https://blank.example' },
        ],
      } } as any)
      .mockResolvedValueOnce({ data: {
        is_directory: true,
        has_next_page: false,
        companies: [
          { name: 'Pump duplicate', website: 'https://pump.example' },
          { name: 'No Site Ltd' },
          { name: 'Valve AG', website: 'https://valve.example' },
        ],
      } } as any);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const provider = new DirectoryDiscoveryProvider({
      gateway: {} as any,
      broker: broker as any,
      runtimeTelemetry: {} as any,
    });

    const result = await provider.discoverCompanies(query, ctx);

    expect(result.records).toHaveLength(3);
    expect(result.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        externalId: 'directory:pump.example',
        name: 'Pump GmbH',
        domain: 'pump.example',
        attributes: expect.objectContaining({
          source_kind: 'association',
          source_directory: 'association.example',
          listing_location: 'Berlin',
          detail_url: '/pump',
          source_class: 'industry_data',
        }),
      }),
      expect.objectContaining({
        externalId: 'directory:association.example:no-site-ltd',
        name: 'No Site Ltd',
        domain: undefined,
      }),
      expect.objectContaining({ externalId: 'directory:valve.example', name: 'Valve AG' }),
    ]));
    expect(result.records[0]?.provenance.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(broker.invoke).toHaveBeenCalledWith(
      'crawl4ai.fetch',
      { url: 'https://association.example/members', maxChars: 60_000 },
      expect.objectContaining({ purpose: ['discovery', 'enrichment'] }),
    );
    log.mockRestore();
  });

  it('isolates rejected listing workers and obeys robots', async () => {
    const broker = {
      invoke: vi.fn(async (tool: string) => {
        if (tool === 'searxng.search') {
          return searchResult([
            { url: 'https://one.example/members', title: 'Members' },
            { url: 'https://two.example/members', title: 'Members' },
          ]);
        }
        throw new Error('crawl should not run');
      }),
    };
    vi.mocked(isAllowedByRobots)
      .mockRejectedValueOnce(new Error('robots unavailable'))
      .mockResolvedValue(false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const provider = new DirectoryDiscoveryProvider({ gateway: {} as any, broker: broker as any });

    await expect(provider.discoverCompanies(query, ctx)).resolves.toEqual({ records: [], costCents: 0 });
    log.mockRestore();
  });

  it('stops a listing on crawl failure, short content, non-directory output, or a missing next link', async () => {
    for (const mode of ['crawl-error', 'short', 'not-directory', 'no-next'] as const) {
      const broker = {
        invoke: vi.fn(async (tool: string) => {
          if (tool === 'searxng.search') {
            return searchResult([{ url: 'https://association.example/members', title: 'Members' }]);
          }
          if (mode === 'crawl-error') throw new Error('private crawl response');
          return crawlResult(mode === 'short' ? 'tiny' : 'directory '.repeat(40));
        }),
      };
      vi.mocked(executeStructuredTaskWithRuntime).mockReset();
      if (mode === 'not-directory') {
        vi.mocked(executeStructuredTaskWithRuntime).mockResolvedValue({ data: { is_directory: false, companies: [] } } as any);
      } else if (mode === 'no-next') {
        vi.mocked(executeStructuredTaskWithRuntime).mockResolvedValue({ data: {
          is_directory: true,
          has_next_page: true,
          companies: [{ name: 'One GmbH' }],
        } } as any);
        vi.mocked(extractSameSiteLinks).mockReturnValue([]);
      }
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const provider = new DirectoryDiscoveryProvider({ gateway: {} as any, broker: broker as any });
      const result = await provider.discoverCompanies(query, ctx);
      expect(result.records).toHaveLength(mode === 'no-next' ? 1 : 0);
      if (mode === 'crawl-error') {
        expect(JSON.stringify(log.mock.calls)).toMatch(/ERROR_TEXT_SHA256:/);
        expect(JSON.stringify(log.mock.calls)).not.toContain('private crawl response');
      }
      log.mockRestore();
    }
  });

  it('reduces model extraction failures to a diagnostic token', async () => {
    const broker = {
      invoke: vi.fn(async (tool: string) =>
        tool === 'searxng.search'
          ? searchResult([{ url: 'https://association.example/members', title: 'Members' }])
          : crawlResult('directory '.repeat(40))),
    };
    vi.mocked(executeStructuredTaskWithRuntime).mockRejectedValue(new Error('private model output'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const provider = new DirectoryDiscoveryProvider({ gateway: {} as any, broker: broker as any });

    await expect(provider.discoverCompanies(query, ctx)).resolves.toEqual({ records: [], costCents: 0 });
    expect(JSON.stringify(log.mock.calls)).toMatch(/ERROR_TEXT_SHA256:/);
    expect(JSON.stringify(log.mock.calls)).not.toContain('private model output');
    log.mockRestore();
  });
});
