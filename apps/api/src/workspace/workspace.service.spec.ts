import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../auth/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import { WorkspaceService } from './workspace.service';

const CTX: RequestContext = {
  workspaceId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000002',
  roles: ['MEMBER'],
  scopes: ['acquisition:read', 'acquisition:write'],
};

describe('WorkspaceService', () => {
  it('upserts lazily-provisioned workspace name inside withWorkspace', async () => {
    const now = new Date('2026-11-26T00:00:00.000Z');
    const upsert = vi.fn(async () => ({
      id: CTX.workspaceId,
      name: 'Acme Industrial Ltd.',
      createdAt: now,
      updatedAt: now,
    }));
    const prisma = {
      withWorkspace: vi.fn(async (_ws: string, cb: (tx: unknown) => unknown) =>
        cb({ workspace: { upsert } }),
      ),
    } as unknown as PrismaService;

    const service = new WorkspaceService(prisma);
    const result = await service.update(CTX, { name: 'Acme Industrial Ltd.' });

    expect(prisma.withWorkspace).toHaveBeenCalledWith(
      CTX.workspaceId,
      expect.any(Function),
    );
    expect(upsert).toHaveBeenCalledWith({
      where: { id: CTX.workspaceId },
      update: { name: 'Acme Industrial Ltd.' },
      create: { id: CTX.workspaceId, name: 'Acme Industrial Ltd.' },
    });
    expect(result).toEqual({
      id: CTX.workspaceId,
      name: 'Acme Industrial Ltd.',
      createdAt: now,
      updatedAt: now,
    });
  });

  it('aggregates all 9 direct tables + SECURITY DEFINER artifact summary RPC inside a single withWorkspace transaction and converts BigInt cleanly', async () => {
    const tx = {
      companyProfile: {
        groupBy: vi.fn(async () => [
          { status: 'DRAFT', _count: { _all: 1 } },
          { status: 'ENRICHING', _count: { _all: 2 } },
          { status: 'REVIEW', _count: { _all: 3 } },
          { status: 'ACTIVE', _count: { _all: 4 } },
        ]),
      },
      sellerDocument: {
        groupBy: vi.fn(async () => [
          { status: 'ready', _count: { _all: 5 }, _sum: { sizeBytes: 5000n } },
          { status: 'pending_upload', _count: { _all: 2 }, _sum: { sizeBytes: 1200n } },
          { status: 'committing', _count: { _all: 1 }, _sum: { sizeBytes: 300n } },
          { status: 'queued', _count: { _all: 1 }, _sum: { sizeBytes: 400n } },
          { status: 'processing', _count: { _all: 1 }, _sum: { sizeBytes: 500n } },
          { status: 'failed_terminal', _count: { _all: 1 }, _sum: { sizeBytes: 100n } },
          { status: 'rejected', _count: { _all: 2 }, _sum: { sizeBytes: 200n } },
        ]),
      },
      icpDefinition: {
        count: vi.fn(async () => 6),
      },
      discoveryRun: {
        groupBy: vi.fn(async () => [
          { status: 'RUNNING', _count: { _all: 1 } },
          { status: 'QUICK', _count: { _all: 1 } },
          { status: 'DONE', _count: { _all: 3 } },
          { status: 'PARTIAL', _count: { _all: 1 } },
          { status: 'FAILED', _count: { _all: 2 } },
          { status: 'CANCELLED', _count: { _all: 1 } },
        ]),
      },
      canonicalCompany: {
        groupBy: vi.fn(async () => [
          { status: 'NEW', _count: { _all: 10 } },
          { status: 'ENRICHED', _count: { _all: 20 } },
          { status: 'SUPPRESSED', _count: { _all: 5 } },
        ]),
      },
      canonicalContact: {
        count: vi.fn(async () => 42),
      },
      asset: {
        aggregate: vi.fn(async () => ({ _count: { _all: 7 }, _sum: { sizeBytes: 9000 } })),
      },
      assetVariant: {
        aggregate: vi.fn(async () => ({ _count: { _all: 14 }, _sum: { sizeBytes: 4500 } })),
      },
      siteRelease: {
        groupBy: vi.fn(async () => [
          { status: 'candidate', _count: { _all: 1 } },
          { status: 'ready', _count: { _all: 3 } },
          { status: 'failed', _count: { _all: 1 } },
        ]),
      },
      $queryRaw: vi.fn(async () => [
        {
          total_count: 12n,
          total_bytes: 80_000n,
          personal_count: 4n,
          personal_bytes: 25_000n,
        },
      ]),
    };

    const prisma = {
      withWorkspace: vi.fn(async (_ws: string, cb: (client: typeof tx) => unknown) => cb(tx)),
    } as unknown as PrismaService;

    const service = new WorkspaceService(prisma);
    const summary = await service.usageSummary(CTX);

    expect(prisma.withWorkspace).toHaveBeenCalledTimes(1);
    expect(tx.companyProfile.groupBy).toHaveBeenCalledWith({
      by: ['status'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    expect(tx.sellerDocument.groupBy).toHaveBeenCalledWith({
      by: ['status'],
      where: { deletedAt: null },
      _count: { _all: true },
      _sum: { sizeBytes: true },
    });
    expect(tx.asset.aggregate).toHaveBeenCalledWith({
      where: { deletedAt: null },
      _count: { _all: true },
      _sum: { sizeBytes: true },
    });
    expect(tx.siteRelease.groupBy).toHaveBeenCalledWith({
      by: ['status'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    expect(summary).toEqual({
      workspaceId: CTX.workspaceId,
      companies: { total: 10, draft: 1, enriching: 2, review: 3, active: 4 },
      sellerDocuments: {
        total: 13,
        ready: 5,
        pendingUpload: 2,
        processing: 3,
        failed: 3,
        totalBytes: 7700,
        readyBytes: 5000,
        pendingUploadBytes: 1200,
        quota: {
          maxPerWorkspace: 500,
          maxPerCompany: 200,
          maxBytesPerWorkspace: 2 * 1024 * 1024 * 1024,
        },
      },
      icps: { total: 6 },
      discoveryRuns: { total: 9, running: 2, completed: 4, failed: 3 },
      canonicalCompanies: { total: 35, suppressed: 5 },
      canonicalContacts: { total: 42 },
      siteAssets: { total: 7, totalBytes: 9000, variants: 14, variantBytes: 4500 },
      siteReleases: { total: 5, ready: 3 },
      operationArtifacts: {
        total: 12,
        totalBytes: 80_000,
        personalDataCount: 4,
        personalDataBytes: 25_000,
      },
    });
    expect(() => JSON.stringify(summary)).not.toThrow();
  });

  it('returns zeroed usage counts safely on an empty workspace', async () => {
    const tx = {
      companyProfile: { groupBy: vi.fn(async () => []) },
      sellerDocument: { groupBy: vi.fn(async () => []) },
      icpDefinition: { count: vi.fn(async () => 0) },
      discoveryRun: { groupBy: vi.fn(async () => []) },
      canonicalCompany: { groupBy: vi.fn(async () => []) },
      canonicalContact: { count: vi.fn(async () => 0) },
      asset: { aggregate: vi.fn(async () => ({ _count: { _all: 0 }, _sum: { sizeBytes: null } })) },
      assetVariant: { aggregate: vi.fn(async () => ({ _count: { _all: 0 }, _sum: { sizeBytes: null } })) },
      siteRelease: { groupBy: vi.fn(async () => []) },
      $queryRaw: vi.fn(async () => []),
    };
    const prisma = {
      withWorkspace: vi.fn(async (_ws: string, cb: (client: typeof tx) => unknown) => cb(tx)),
    } as unknown as PrismaService;
    const summary = await new WorkspaceService(prisma).usageSummary(CTX);
    expect(summary.companies).toEqual({ total: 0, draft: 0, enriching: 0, review: 0, active: 0 });
    expect(summary.sellerDocuments.totalBytes).toBe(0);
    expect(summary.operationArtifacts).toEqual({
      total: 0,
      totalBytes: 0,
      personalDataCount: 0,
      personalDataBytes: 0,
    });
  });
});
