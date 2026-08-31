import { describe, expect, it, vi } from 'vitest';
import { DiscoveryService } from './discovery.service';

const ctx = { workspaceId: 'ws-1', userId: 'user-1', roles: [] } as never;
const authority = {
  consumeWorkspaceGrant: vi.fn(async () => ({
    authorityId: '20000000-0000-4000-8000-000000000002',
    scopeKey: 'ws-1',
    accountKey: 'discovery.run:company:company-synthetic:request',
    purpose: 'discovery.run',
    subjectType: 'company',
    subjectId: 'company-synthetic',
  })),
};

function serviceWithTx(tx: unknown, providers: unknown = {}): DiscoveryService {
  const prisma = {
    withWorkspace: async <T>(_workspaceId: string, callback: (client: unknown) => Promise<T>): Promise<T> =>
      callback(tx),
  };
  return new DiscoveryService(prisma as never, providers as never, authority as never);
}

describe('DiscoveryService synthetic provenance read quarantine', () => {
  it('scans past a full synthetic batch to return the next product companies in the same page', async () => {
    const syntheticRows = [
      { id: 'company-synthetic-1', createdAt: new Date('2026-01-05T00:00:00Z') },
      { id: 'company-synthetic-2', createdAt: new Date('2026-01-04T00:00:00Z') },
      { id: 'company-synthetic-3', createdAt: new Date('2026-01-03T00:00:00Z') },
    ];
    const productRows = [
      { id: 'company-real-1', createdAt: new Date('2026-01-02T00:00:00Z') },
      { id: 'company-real-2', createdAt: new Date('2026-01-01T00:00:00Z') },
    ];
    const tx = {
      canonicalCompany: {
        findMany: vi.fn(async (query: { cursor?: { id: string } }) =>
          query.cursor?.id === 'company-synthetic-3' ? productRows : syntheticRows,
        ),
      },
      fieldEvidence: {
        findMany: vi.fn(async (query: { where: { entityId: { in: string[] } } }) =>
          query.where.entityId.in[0]?.startsWith('company-synthetic')
            ? syntheticRows.map((row) => ({
                entityId: row.id,
                providerKey: 'sandbox',
                license: 'fixture',
              }))
            : [],
        ),
      },
    };

    await expect(serviceWithTx(tx).listCanonicalCompanies(ctx, { limit: 2 })).resolves.toEqual({
      data: productRows,
      nextCursor: null,
      hasMore: false,
    });
    expect(tx.canonicalCompany.findMany).toHaveBeenCalledTimes(2);
  });

  it('fills the product page across an interleaved synthetic company and proves exhaustion', async () => {
    const rows = [
      { id: 'company-real', name: 'Real Co', createdAt: new Date('2026-01-02T00:00:00Z') },
      { id: 'company-synthetic', name: 'Synthetic Co', createdAt: new Date('2026-01-01T00:00:00Z') },
      { id: 'company-next', name: 'Next Co', createdAt: new Date('2025-12-31T00:00:00Z') },
    ];
    const tx = {
      canonicalCompany: {
        findMany: vi.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce([]),
      },
      fieldEvidence: {
        findMany: vi.fn(async () => [
          { entityId: 'company-synthetic', providerKey: 'public_web', license: 'fixture' },
        ]),
      },
    };

    await expect(serviceWithTx(tx).listCanonicalCompanies(ctx, { limit: 2 })).resolves.toEqual({
      data: [rows[0], rows[2]],
      nextCursor: null,
      hasMore: false,
    });
    expect(tx.fieldEvidence.findMany).toHaveBeenCalledWith({
      where: {
        entityType: 'company',
        entityId: { in: ['company-real', 'company-synthetic', 'company-next'] },
      },
      select: { entityId: true, providerKey: true, license: true },
    });
    expect(tx.canonicalCompany.findMany).toHaveBeenCalledTimes(2);
  });

  it('marks a direct read of historical sandbox evidence as quarantined without deleting the row', async () => {
    const tx = {
      canonicalCompany: {
        findUnique: vi.fn(async () => ({ id: 'company-synthetic', name: 'Synthetic Co', contacts: [] })),
      },
      fieldEvidence: {
        findMany: vi.fn(async () => [
          { entityId: 'company-synthetic', providerKey: 'sandbox', license: 'sandbox' },
        ]),
      },
    };

    await expect(serviceWithTx(tx).getCanonicalCompany(ctx, 'company-synthetic')).rejects.toMatchObject({
      response: { error: { code: 'SYNTHETIC_PROVENANCE_QUARANTINED' } },
    });
    expect(tx.canonicalCompany.findUnique).toHaveBeenCalledOnce();
  });

  it('quarantines a clean company detail when an included contact has synthetic provenance', async () => {
    const tx = {
      canonicalCompany: {
        findUnique: vi.fn(async () => ({
          id: 'company-real',
          name: 'Real Co',
          contacts: [{ id: 'contact-synthetic', contactPoints: [] }],
        })),
      },
      fieldEvidence: {
        findMany: vi.fn(async () => [
          { entityId: 'contact-synthetic', providerKey: 'fake', license: 'synthetic' },
        ]),
      },
    };

    await expect(serviceWithTx(tx).getCanonicalCompany(ctx, 'company-real')).rejects.toMatchObject({
      response: { error: { code: 'SYNTHETIC_PROVENANCE_QUARANTINED' } },
    });
    expect(tx.fieldEvidence.findMany).toHaveBeenCalledWith({
      where: { entityId: { in: ['company-real', 'contact-synthetic'] } },
      orderBy: { fetchedAt: 'desc' },
    });
  });

  it('blocks historical sandbox companies before contact provider routing or external work', async () => {
    const routeContactDiscovery = vi.fn(async () => {
      throw new Error('provider routing must not occur');
    });
    const tx = {
      canonicalCompany: {
        findUnique: vi.fn(async () => ({
          id: 'company-synthetic',
          name: 'Synthetic Co',
          domain: 'synthetic.example',
          dedupeKey: 'd:synthetic.example',
          status: 'NEW',
        })),
      },
      fieldEvidence: {
        findMany: vi.fn(async () => [{ providerKey: 'stub', license: 'synthetic' }]),
      },
      suppressionRecord: { findMany: vi.fn(async () => []) },
    };

    await expect(
      serviceWithTx(tx, { routeContactDiscovery }).discoverContacts(
        ctx,
        'company-synthetic',
        { lawfulBasis: { basis: 'legitimate_interest', ref: 'LIA-42' } },
      ),
    ).rejects.toMatchObject({
      response: { error: { code: 'SYNTHETIC_PROVENANCE_QUARANTINED' } },
    });
    expect(routeContactDiscovery).not.toHaveBeenCalled();
    expect(tx.fieldEvidence.findMany).toHaveBeenCalledWith({
      where: { entityType: 'company', entityId: 'company-synthetic' },
      select: { providerKey: true, license: true },
    });
  });
});

describe('DiscoveryService technical execution envelope', () => {
  it.each([
    ['contact', { maxContacts: 26 }],
    ['probe', { maxProbe: 9 }],
  ])('rejects an internal email-guess request above the %s cap before grant consumption or database work', async (_kind, opts) => {
    const consumeWorkspaceGrant = vi.fn();
    const withWorkspace = vi.fn();
    const service = new DiscoveryService(
      { withWorkspace } as never,
      {} as never,
      { consumeWorkspaceGrant } as never,
    );

    await expect(
      service.guessEmailsForCompany(ctx, 'company-1', opts),
    ).rejects.toMatchObject({
      response: { error: { code: 'EXECUTION_BUDGET_ENVELOPE_EXCEEDED' } },
    });
    expect(consumeWorkspaceGrant).not.toHaveBeenCalled();
    expect(withWorkspace).not.toHaveBeenCalled();
  });
});
