import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { TenantProjectionService } from './tenant-projection.service';

describe('TenantProjectionService identity evidence', () => {
  it('persists explicit legal-name evidence on a new grounded-domain canonical', async () => {
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'canonical-1', ...data }));
    const tx = {
      suppressionRecord: { findMany: vi.fn(async () => []) },
      canonicalCompany: {
        findUnique: vi.fn(async () => null),
        findMany: vi.fn(async () => []),
        create,
        update: vi.fn(),
      },
      identityLink: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})) },
      fieldEvidence: { create: vi.fn(async () => ({})) },
    } as unknown as Prisma.TransactionClient;
    const prisma = {
      monitoredSource: {
        findUnique: vi.fn(async () => ({
          id: 'source-1',
          sourceKey: 'synthetic-source',
          providerKey: 'public_web',
        })),
      },
      sourceEntity: {
        findMany: vi.fn(async () => [
          {
            id: 'entity-1',
            name: 'Rheinland Pumpensysteme GmbH',
            domain: 'www.rheinland-pumpen.de',
            country: 'DE',
            cleaned: { legal_name: 'Rheinland Pumpensysteme GmbH' },
            lastSeenAt: new Date('2026-08-07T00:00:00.000Z'),
          },
        ]),
      },
      withWorkspace: async <T>(
        _workspaceId: string,
        fn: (client: Prisma.TransactionClient) => Promise<T>,
      ): Promise<T> => fn(tx),
    };

    const service = new TenantProjectionService({ prisma } as never);
    await expect(service.projectSource('workspace-1', 'source-1')).resolves.toMatchObject({
      projected: 1,
      status: 'DONE',
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          attributes: expect.objectContaining({
            legal_name: 'Rheinland Pumpensysteme GmbH',
            identity_resolution: expect.objectContaining({ decision: 'AUTO_LINK' }),
          }),
        }),
      }),
    );
  });
});
