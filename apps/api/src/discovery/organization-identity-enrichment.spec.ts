import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { bindOrganizationEnrichmentIdentifiers } from './organization-identity-enrichment';

const LEI = '529900T8BM49AURSDO55';

function baseTx(overrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: vi.fn(async () => [{ locked: true }]),
    $executeRaw: vi.fn(async () => 1),
    organizationCanonicalMapping: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    organizationIdentifier: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
    },
    organizationIdentityConflict: {
      upsert: vi.fn(async () => ({ id: 'conflict-1', status: 'OPEN' })),
    },
    organizationIdentityConflictParty: {
      createMany: vi.fn(async () => ({ count: 0 })),
    },
    ...overrides,
  } as unknown as Prisma.TransactionClient;
}

describe('enrichment identifiers -> Identity v2', () => {
  it('binds a validated GLEIF LEI to the existing root company', async () => {
    const tx = baseTx();
    await expect(bindOrganizationEnrichmentIdentifiers(tx, {
      workspaceId: 'ws-1',
      companyId: 'co-1',
      claims: [{ providerKey: 'gleif', confidence: 0.99, identifiers: [{ scheme: 'lei', value: LEI }] }],
    })).resolves.toEqual({ kind: 'bound', identifierCount: 1 });

    expect(tx.organizationIdentifier.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: 'ws-1',
        companyId: 'co-1',
        scheme: 'lei',
        jurisdiction: 'GLOBAL',
        normalizedValue: LEI,
        authorityProviderKey: 'gleif',
        rawRecordId: null,
      }),
    });
  });

  it('keeps enrichment source provenance on a newly admitted identifier', async () => {
    const tx = baseTx();
    const provenance = {
      sourceUrl: 'https://search.gleif.org/#/record/example',
      fetchedAt: '2026-08-13T00:00:00.000Z',
      contentHash: 'a'.repeat(64),
      parserVersion: 'gleif/v1',
    };
    await bindOrganizationEnrichmentIdentifiers(tx, {
      workspaceId: 'ws-1',
      companyId: 'co-1',
      claims: [{
        providerKey: 'gleif',
        confidence: 0.99,
        identifiers: [{ scheme: 'lei', value: LEI }],
        provenance,
      }],
    });
    expect(tx.organizationIdentifier.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ provenance }),
    });
  });

  it('normalizes legacy URL-shaped domains before deciding cross-root conflict', async () => {
    const tx = baseTx({
      $queryRaw: vi.fn(async () => [{ id: 'co-2', domain: 'https://www.Acme.example/about' }]),
      canonicalCompany: {
        findMany: vi.fn(async () => []),
      },
    });
    await expect(bindOrganizationEnrichmentIdentifiers(tx, {
      workspaceId: 'ws-1',
      companyId: 'co-1',
      claims: [{ providerKey: 'wikidata', confidence: 0.99, identifiers: [{ scheme: 'domain', value: 'acme.example' }] }],
    })).resolves.toEqual({ kind: 'conflict', conflictId: 'conflict-1' });
    expect(tx.organizationIdentifier.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        conflictId: 'conflict-1',
        status: 'PENDING_CONFLICT',
        normalizedValue: 'acme.example',
      }),
    });
  });

  it('creates an auditable conflict and does not rebind when the LEI belongs to another root', async () => {
    const tx = baseTx({
      organizationIdentifier: {
        findMany: vi.fn(async () => [{ id: 'id-1', scheme: 'lei', jurisdiction: 'GLOBAL', normalizedValue: LEI, companyId: 'co-2' }]),
        findFirst: vi.fn(async () => null),
        create: vi.fn(async () => ({})),
        update: vi.fn(async () => ({})),
      },
    });

    await expect(bindOrganizationEnrichmentIdentifiers(tx, {
      workspaceId: 'ws-1',
      companyId: 'co-1',
      claims: [{ providerKey: 'gleif', confidence: 1, identifiers: [{ scheme: 'lei', value: LEI }] }],
    })).resolves.toEqual({ kind: 'conflict', conflictId: 'conflict-1' });

    expect(tx.organizationIdentifier.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        conflictId: 'conflict-1',
        status: 'PENDING_CONFLICT',
        normalizedValue: LEI,
      }),
    });
    expect(tx.organizationIdentityConflictParty.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ companyId: 'co-1' }),
        expect.objectContaining({ companyId: 'co-2' }),
      ],
      skipDuplicates: true,
    });
  });

  it('fails closed when a provider asserts a scheme outside its authority profile', async () => {
    const tx = baseTx();
    await expect(bindOrganizationEnrichmentIdentifiers(tx, {
      workspaceId: 'ws-1',
      companyId: 'co-1',
      claims: [{ providerKey: 'openfda', confidence: 1, identifiers: [{ scheme: 'lei', value: LEI }] }],
    })).rejects.toMatchObject({ code: 'IDENTITY_IDENTIFIER_NOT_AUTHORIZED' });
    expect(tx.organizationIdentifier.create).not.toHaveBeenCalled();
  });

  it('opens a conflict instead of attaching a second singleton LEI to the same company', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { scheme: 'lei', jurisdiction: 'GLOBAL', normalizedValue: '5493001KJTIIGC8Y1R12' },
      ]);
    const tx = baseTx({
      organizationIdentifier: {
        findMany,
        findFirst: vi.fn(async () => null),
        create: vi.fn(async () => ({})),
        update: vi.fn(async () => ({})),
      },
    });

    await expect(bindOrganizationEnrichmentIdentifiers(tx, {
      workspaceId: 'ws-1',
      companyId: 'co-1',
      claims: [{ providerKey: 'gleif', confidence: 1, identifiers: [{ scheme: 'lei', value: LEI }] }],
    })).resolves.toEqual({ kind: 'conflict', conflictId: 'conflict-1' });
    expect(tx.organizationIdentifier.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        companyId: 'co-1',
        conflictId: 'conflict-1',
        normalizedValue: LEI,
        status: 'PENDING_CONFLICT',
      }),
    });
  });

  it('does not duplicate a pending enrichment claim when the same conflict facts repeat', async () => {
    const create = vi.fn(async () => ({}));
    const tx = baseTx({
      $queryRaw: vi.fn(async () => [{ id: 'co-2', domain: 'other.example' }]),
      canonicalCompany: { findMany: vi.fn(async () => []) },
      organizationIdentifier: {
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async ({ where }: any) =>
          where.conflictId === 'conflict-1'
            ? { id: 'pending-1', status: 'PENDING_CONFLICT' }
            : null),
        create,
        update: vi.fn(async () => ({})),
      },
    });

    await expect(bindOrganizationEnrichmentIdentifiers(tx, {
      workspaceId: 'ws-1',
      companyId: 'co-1',
      claims: [{ providerKey: 'wikidata', confidence: 1, identifiers: [{ scheme: 'domain', value: 'other.example' }] }],
    })).resolves.toEqual({ kind: 'conflict', conflictId: 'conflict-1' });
    expect(create).not.toHaveBeenCalled();
  });

  it('accepts the reviewed domain claim on retry after the conflicting companies were merged', async () => {
    const create = vi.fn(async () => ({}));
    const tx = baseTx({
      $queryRaw: vi.fn(async () => []),
      organizationCanonicalMapping: {
        findFirst: vi.fn(async ({ where }: any) =>
          where.sourceCompanyId === 'alias-1' ? { canonicalCompanyId: 'root-1' } : null),
        findMany: vi.fn(async () => [{ sourceCompanyId: 'alias-1' }]),
      },
      canonicalCompany: {
        findMany: vi.fn(async () => [
          { id: 'root-1', domain: 'root.example' },
          { id: 'alias-1', domain: 'alias.example' },
        ]),
      },
      organizationIdentifier: {
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async () => null),
        create,
        update: vi.fn(async () => ({})),
      },
    });

    await expect(bindOrganizationEnrichmentIdentifiers(tx, {
      workspaceId: 'ws-1',
      companyId: 'alias-1',
      claims: [{ providerKey: 'wikidata', confidence: 1, identifiers: [{ scheme: 'domain', value: 'alias.example' }] }],
    })).resolves.toEqual({ kind: 'bound', identifierCount: 1 });
    expect(tx.organizationIdentityConflict.upsert).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ companyId: 'root-1', normalizedValue: 'alias.example' }),
    });
  });
});
