import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import type { ImagePipelineRunner } from './image-pipeline-runner';
import { ImagePipelineService } from './image-pipeline.service';
import type { StorageService } from './storage.service';

function serviceWithAssets(ids: string[]): ImagePipelineService {
  const raw = vi.fn()
    .mockResolvedValueOnce([{ snapshot: '10:20:' }])
    .mockImplementation(async (query: { values?: unknown[] }) => {
      const take = query.values?.findLast((value) => typeof value === 'number');
      return ids.slice(0, typeof take === 'number' ? take : ids.length).map((id) => ({ id }));
    });
  const prisma = {
    withWorkspace: vi.fn(async (_workspaceId, fn) =>
      fn({
        $queryRaw: raw,
        asset: {
          findFirst: vi.fn(async () => ids.length ? { id: ids.at(-1)! } : null),
          findMany: vi.fn(async (args: { where?: { id?: { gt?: string; lte?: string } }; take?: number }) =>
            ids
              .filter((id) => !args.where?.id?.gt || id > args.where.id.gt)
              .filter((id) => !args.where?.id?.lte || id <= args.where.id.lte)
              .slice(0, args.take ?? ids.length)
              .map((id) => ({ id }))),
        },
      }),
    ),
  } as unknown as PrismaService;
  return new ImagePipelineService(
    prisma,
    {} as StorageService,
    {} as ImagePipelineRunner,
  );
}

describe('ImagePipelineService site-level isolation', () => {
  it('freezes at most 512 ids and reports overflow before any Sharp activity starts', async () => {
    const ids = Array.from({ length: 513 }, (_, index) => `asset-${String(index).padStart(4, '0')}`);
    await expect(serviceWithAssets(ids).listSiteImageIds({ workspaceId: 'ws', siteId: 'site' })).resolves.toMatchObject({
      assetIds: ids.slice(0, 512),
      truncated: true,
    });
  });

  it('bounds one activity to two assets and returns a stable cursor', async () => {
    const service = serviceWithAssets(['asset-a', 'asset-b', 'asset-c']);
    vi.spyOn(service, 'processAsset').mockImplementation(async ({ assetId }) => ({
      assetId,
      status: 'done',
      variants: 3,
      reused: 0,
      qualityWarnings: [],
    }));

    await expect(service.processSiteImages({ workspaceId: 'ws', siteId: 'site', limit: 2 })).resolves.toMatchObject({
      processed: 2,
      variants: 6,
      nextCursor: 'asset-b',
      upperBound: 'asset-c',
    });
  });

  it('refuses an explicit workset slice larger than the per-activity image bound', async () => {
    const service = serviceWithAssets(['asset-a']);
    await expect(service.processSiteImages({
      workspaceId: 'ws',
      siteId: 'site',
      assetIds: ['asset-a', 'asset-b', 'asset-c'],
      limit: 2,
    })).rejects.toThrow('explicit image batch must contain 1-2 asset ids');
  });

  it('keeps processing sibling images after one ordinary image failure', async () => {
    const service = serviceWithAssets(['bad', 'good']);
    vi.spyOn(service, 'processAsset').mockImplementation(async ({ assetId }) => {
      if (assetId === 'bad') throw new Error('decoder rejected input');
      return {
        assetId,
        status: 'done',
        variants: 15,
        reused: 0,
        qualityWarnings: [],
      };
    });

    await expect(service.processSiteImages({ workspaceId: 'ws', siteId: 'site' })).resolves.toMatchObject({
      status: 'degraded',
      processed: 1,
      failed: 1,
      variants: 15,
    });
  });

  it('never converts cancellation into an ordinary degraded image result', async () => {
    const service = serviceWithAssets(['cancelled']);
    const abort = new AbortController();
    const cancellation = Object.assign(new Error('cancelled'), { name: 'CancelledFailure' });
    vi.spyOn(service, 'processAsset').mockImplementation(async () => {
      abort.abort(cancellation);
      throw cancellation;
    });

    await expect(
      service.processSiteImages({ workspaceId: 'ws', siteId: 'site' }, abort.signal),
    ).rejects.toBe(cancellation);
  });
});

describe('ImagePipelineService attempt convergence', () => {
  it('fails closed when a ready ledger row has lost its canonical object', async () => {
    const storage = {
      head: vi.fn(async () => null),
      hashObject: vi.fn(),
      putBuffer: vi.fn(),
    };
    const service = new ImagePipelineService(
      {} as PrismaService,
      storage as unknown as StorageService,
      {} as ImagePipelineRunner,
    );
    const verify = service as unknown as {
      verifyReadyObject(
        key: string,
        rendered: { data: Buffer; info: { contentHash: string; sizeBytes: number; width: number; height: number; mime: 'image/webp' } },
      ): Promise<void>;
    };
    await expect(verify.verifyReadyObject('canonical-key', {
      data: Buffer.from('x'),
      info: { contentHash: 'a'.repeat(64), sizeBytes: 1, width: 1, height: 1, mime: 'image/webp' },
    })).rejects.toThrow(/storage integrity error/);
    expect(storage.putBuffer).not.toHaveBeenCalled();
  });

  it('deletes and prunes eight failed attempt keys so a later reservation cannot self-lock', async () => {
    const workspaceId = '22222222-2222-4222-8222-222222222222';
    const siteId = '33333333-3333-4333-8333-333333333333';
    const assetId = '44444444-4444-4444-8444-444444444444';
    const recipeHash = 'a'.repeat(64);
    const rowId = '55555555-5555-4555-8555-555555555555';
    const keys = Array.from({ length: 8 }, (_unused, index) => {
      const token = `77777777-7777-4777-8777-${String(index).padStart(12, '0')}`;
      return `ws/${workspaceId}/${siteId}/variant-attempts/${assetId}/${token}/${recipeHash}.webp`;
    });
    let metadata: Record<string, unknown> = {
      attemptKeys: keys,
      reservation: { token: 'old', attemptKey: keys[7], attempt: 8 },
    };
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: assetId }]),
      asset: { findFirst: vi.fn(async () => ({ id: assetId })) },
      assetVariant: {
        findMany: vi.fn(async () => [{
          id: rowId,
          recipeHash,
          objectKey: `ws/${workspaceId}/${siteId}/variants/${assetId}/${recipeHash}.webp`,
          status: 'failed',
          metadata,
        }]),
        updateMany: vi.fn(async ({ data }: { data: { metadata: Record<string, unknown> } }) => {
          metadata = data.metadata;
          return { count: 1 };
        }),
      },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_workspace: string, fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    const storage = {
      delete: vi.fn(async () => undefined),
      head: vi.fn(async () => null),
    };
    const service = new ImagePipelineService(
      prisma as unknown as PrismaService,
      storage as unknown as StorageService,
      {} as ImagePipelineRunner,
    );
    const reconcile = service as unknown as {
      reconcileAttemptKeys(
        input: { workspaceId: string; siteId: string; assetId: string; sourceHash: string; sourceObjectKey: string },
      ): Promise<void>;
    };
    await reconcile.reconcileAttemptKeys(
      { workspaceId, siteId, assetId, sourceHash: 'b'.repeat(64), sourceObjectKey: 'source' },
    );
    expect(storage.delete).toHaveBeenCalledTimes(8);
    expect(metadata).not.toHaveProperty('attemptKeys');
    expect(metadata).not.toHaveProperty('reservation');
  });

  it('rejects a new reservation whose frozen cleanup plan would exceed 128 total objects', async () => {
    const existing = Array.from({ length: 90 }, (_unused, index) => ({
      id: `existing-${index}`,
      recipeHash: `e${String(index).padStart(63, '0')}`,
      status: 'ready',
      metadata: null,
    }));
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: 'asset' }]),
      assetVariant: { findMany: vi.fn(async () => existing) },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_workspace: string, fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    const service = new ImagePipelineService(
      prisma as unknown as PrismaService,
      {} as StorageService,
      {} as ImagePipelineRunner,
    );
    const plans = Array.from({ length: 30 }, (_unused, index) => ({
      recipeHash: `f${String(index).padStart(63, '0')}`,
      recipe: { output: { format: 'webp' } },
    }));
    const reserve = service as unknown as {
      reserveVariantSet(input: Record<string, unknown>, inspection: unknown, plans: unknown[], token: string): Promise<boolean>;
    };
    await expect(reserve.reserveVariantSet({
      workspaceId: 'ws', siteId: 'site', assetId: 'asset', sourceHash: 'a'.repeat(64),
      sourceObjectKey: 'source', sourceMeta: {},
    }, {}, plans, '77777777-7777-4777-8777-777777777777')).rejects.toThrow(
      /cleanup object budget exceeded \(151>128\)/,
    );
  });

  it('waits for an active producer before applying the hypothetical next-attempt budget', async () => {
    const plans = Array.from({ length: 30 }, (_unused, index) => ({
      recipeHash: `f${String(index).padStart(63, '0')}`,
      recipe: { output: { format: 'webp' } },
    }));
    const active = plans.map((plan, index) => ({
      id: `active-${index}`,
      recipeHash: plan.recipeHash,
      status: 'processing',
      metadata: {
        attemptKeys: [`attempt-${index}`],
        reservation: {
          token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          leaseUntil: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    }));
    const historical = Array.from({ length: 60 }, (_unused, index) => ({
      id: `history-${index}`,
      recipeHash: `e${String(index).padStart(63, '0')}`,
      status: 'ready',
      metadata: null,
    }));
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: 'asset' }]),
      assetVariant: { findMany: vi.fn(async () => [...historical, ...active]) },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_workspace: string, fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    const service = new ImagePipelineService(
      prisma as unknown as PrismaService,
      {} as StorageService,
      {} as ImagePipelineRunner,
    );
    const reserve = service as unknown as {
      reserveVariantSet(input: Record<string, unknown>, inspection: unknown, plans: unknown[], token: string): Promise<boolean>;
    };
    await expect(reserve.reserveVariantSet({
      workspaceId: 'ws', siteId: 'site', assetId: 'asset', sourceHash: 'a'.repeat(64),
      sourceObjectKey: 'source', sourceMeta: {},
    }, {}, plans, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).resolves.toBe(false);
  });
});
