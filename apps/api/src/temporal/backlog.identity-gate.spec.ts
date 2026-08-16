import { describe, expect, it, vi } from 'vitest';
import { createBacklogActivities } from './backlog.activities';

describe('enrichBacklog identity gate', () => {
  it('passes ACTIVE identifiers retained on aliases to every root-company enricher', async () => {
    const enrichCompany = vi.fn(async () => ({ matched: false, confidence: 0, attributes: {}, costCents: 0 }));
    const tx = {
      $queryRaw: vi.fn(async () => [{ locked: true }]),
      canonicalCompany: {
        findMany: vi.fn(async () => [{
          id: 'root-1', name: 'Schneider Electric', domain: null, country: 'FR', region: null, attributes: {},
        }]),
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUnique: vi.fn(async () => ({
          id: 'root-1', name: 'Schneider Electric', domain: null, status: 'NEW', attributes: {},
        })),
      },
      organizationCanonicalMapping: {
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
          'canonicalCompanyId' in where
            ? [{ sourceCompanyId: 'alias-1', canonicalCompanyId: 'root-1' }]
            : [],
        ),
      },
      organizationIdentifier: {
        findMany: vi.fn(async () => [{
          companyId: 'alias-1', scheme: 'siren', jurisdiction: 'FR', normalizedValue: '803086586',
        }]),
      },
      organizationIdentityConflictParty: { count: vi.fn(async () => 0) },
      suppressionRecord: { findMany: vi.fn(async () => []) },
    };
    const deps = {
      prisma: {
        withWorkspace: async (_workspaceId: string, fn: (client: typeof tx) => unknown) => fn(tx),
        sourcePolicy: { findMany: async () => [] },
      },
      providers: { routeEnrichment: async () => [{ key: 'wikidata', enrichCompany }] },
      gateway: {},
      ownerDb: {},
    } as never;

    await createBacklogActivities(deps).enrichBacklog({ workspaceId: 'ws-1', limit: 1 });

    expect(enrichCompany).toHaveBeenCalledWith(
      expect.objectContaining({
        identifiers: [{ scheme: 'siren', jurisdiction: 'FR', value: '803086586' }],
      }),
      expect.any(Object),
    );
  });
});
