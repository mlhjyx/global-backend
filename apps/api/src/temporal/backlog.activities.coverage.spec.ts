import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBacklogActivities } from './backlog.activities';
import { IntentProjectionService } from '../intent/intent-projection.service';

type Company = {
  id: string;
  name: string;
  domain: string | null;
  country: string | null;
  region: string | null;
  attributes: Record<string, unknown> | null;
  status?: string;
};

const company = (id: string, overrides: Partial<Company> = {}): Company => ({
  id,
  name: id.toUpperCase(),
  domain: `${id}.example`,
  country: 'DE',
  region: null,
  attributes: {},
  status: 'NEW',
  ...overrides,
});

function dependencies(input: {
  companies?: Company[];
  enrichers?: unknown[];
  suspended?: string[];
  existingWatchKeys?: string[];
}) {
  const companies = input.companies ?? [];
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const tx = {
    $queryRaw: vi.fn(async () => [{ locked: true }]),
    canonicalCompany: {
      findMany: vi.fn(async ({ take }: { take?: number }) => companies.slice(0, take ?? companies.length)),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => companies.find((c) => c.id === where.id) ?? null),
      updateMany,
      update: vi.fn(async () => ({})),
    },
    suppressionRecord: { findMany: vi.fn(async () => []) },
    fieldEvidence: { create: vi.fn(async () => ({})) },
  };
  const prisma = {
    withWorkspace: async <T>(_workspaceId: string, fn: (client: typeof tx) => Promise<T>): Promise<T> => fn(tx),
    sourcePolicy: {
      findMany: vi.fn(async () => (input.suspended ?? []).map((domain) => ({ domain }))),
    },
    monitoredSource: {
      findMany: vi.fn(async () => (input.existingWatchKeys ?? []).map((sourceKey) => ({ sourceKey }))),
    },
  };
  const providers = {
    routeEnrichment: vi.fn(async () => input.enrichers ?? []),
  };
  const ownerDb = {
    icpDefinition: {
      findMany: vi.fn(async () => [
        { id: 'icp-1', workspaceId: 'ws-1' },
        { id: 'icp-2', workspaceId: 'ws-2' },
      ]),
    },
  };
  return {
    deps: { prisma, providers, ownerDb, gateway: {} } as never,
    tx,
    prisma,
    providers,
    updateMany,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('backlog activities coverage — bounded target, enrichment, and watch branches', () => {
  it('lists every ACTIVE ICP in owner ordering', async () => {
    const { deps } = dependencies({});
    await expect(createBacklogActivities(deps).listBacklogTargets()).resolves.toEqual({
      targets: [
        { workspaceId: 'ws-1', icpId: 'icp-1' },
        { workspaceId: 'ws-2', icpId: 'icp-2' },
      ],
    });
  });

  it('returns an exact empty enrichment page when no provider is enabled', async () => {
    const { deps } = dependencies({ companies: [company('c1')] });
    await expect(createBacklogActivities(deps).enrichBacklog({ workspaceId: 'ws-1' })).resolves.toEqual({
      scanned: 0,
      attempted: 0,
      matched: 0,
      nextCursor: null,
    });
  });

  it('skips existing namespaces, isolates provider failure, stamps the whole scanned page, and advances the cursor', async () => {
    const failing = { key: 'gleif', enrichCompany: vi.fn(async () => { throw new Error('provider unavailable'); }) };
    const miss = { key: 'wikidata', enrichCompany: vi.fn(async () => ({ matched: false })) };
    const companies = [
      company('c1', { attributes: { gleif: { lei: 'x' }, wikidata: { qid: 'Q1' } } }),
      company('c2'),
    ];
    const { deps, updateMany } = dependencies({ companies, enrichers: [failing, miss] });

    const result = await createBacklogActivities(deps).enrichBacklog({ workspaceId: 'ws-1', limit: 2 });

    expect(result).toEqual({ scanned: 2, attempted: 1, matched: 0, nextCursor: 'c2' });
    expect(failing.enrichCompany).toHaveBeenCalledOnce();
    expect(miss.enrichCompany).toHaveBeenCalledOnce();
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: { in: ['c1', 'c2'] } },
      data: { lastEnrichedAt: expect.any(Date) },
    });
  });

  it('handles empty watch pages without platform lookup or writes', async () => {
    const { deps, prisma, updateMany } = dependencies({});
    const result = await createBacklogActivities(deps).registerWatchesBacklog({ workspaceId: 'ws-1' });
    expect(result).toEqual({ scanned: 0, registered: 0, nextCursor: null });
    expect(prisma.monitoredSource.findMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('skips missing/existing/suspended domains, isolates one registration failure, and stamps all candidates', async () => {
    const register = vi
      .spyOn(IntentProjectionService.prototype, 'registerWatch')
      .mockResolvedValueOnce({ sourceId: 'source-1', created: true })
      .mockRejectedValueOnce(new Error('sitemap unavailable'));
    const companies = [
      company('missing', { domain: null }),
      company('existing', { domain: 'existing.example' }),
      company('suspended', { domain: 'suspended.example' }),
      company('success', { domain: 'success.example' }),
      company('failure', { domain: 'failure.example' }),
    ];
    const { deps, updateMany } = dependencies({
      companies,
      suspended: ['suspended.example'],
      existingWatchKeys: ['web_watch:existing.example'],
    });

    const result = await createBacklogActivities(deps).registerWatchesBacklog({ workspaceId: 'ws-1', limit: 5 });

    expect(register).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ scanned: 5, registered: 1, nextCursor: 'failure' });
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: { in: companies.map((c) => c.id) } },
      data: { lastWatchAt: expect.any(Date) },
    });
  });
});
