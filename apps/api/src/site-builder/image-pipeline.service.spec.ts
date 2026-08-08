import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import type { ImagePipelineRunner } from './image-pipeline-runner';
import { IMAGE_PIPELINE_VERSION, planImageVariants } from './image-pipeline';
import { ImagePipelineService } from './image-pipeline.service';
import type { StorageService } from './storage.service';

const NOW = '2026-08-08T12:00:00.000Z';

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

  it('refuses an empty explicit workset before looking up an upper bound', async () => {
    const service = serviceWithAssets(['asset-a']);

    await expect(service.processSiteImages({
      workspaceId: 'ws',
      siteId: 'site',
      assetIds: [],
    })).rejects.toThrow('explicit image batch must contain 1-2 asset ids');
  });

  it('returns a stable empty page when no eligible site image exists', async () => {
    await expect(
      serviceWithAssets([]).processSiteImages({ workspaceId: 'ws', siteId: 'site' }),
    ).resolves.toEqual({
      status: 'done',
      processed: 0,
      failed: 0,
      variants: 0,
      items: [],
      nextCursor: null,
      upperBound: null,
    });
  });

  it('processes an explicit workset without deriving a cursor or upper bound', async () => {
    const service = serviceWithAssets(['ignored-database-row']);
    vi.spyOn(service, 'processAsset').mockImplementation(async ({ assetId }) => ({
      assetId,
      status: 'done',
      variants: 1,
      reused: 1,
      qualityWarnings: [],
    }));

    await expect(service.processSiteImages({
      workspaceId: 'ws',
      siteId: 'site',
      assetIds: ['asset-explicit'],
    })).resolves.toMatchObject({
      status: 'done',
      processed: 1,
      nextCursor: null,
      upperBound: null,
      items: [expect.objectContaining({ assetId: 'asset-explicit' })],
    });
  });

  it('honours an explicit scan boundary and cursor without inventing a continuation', async () => {
    const service = serviceWithAssets(['asset-a', 'asset-b', 'asset-c']);
    vi.spyOn(service, 'processAsset').mockImplementation(async ({ assetId }) => ({
      assetId,
      status: 'done',
      variants: 1,
      reused: 0,
      qualityWarnings: [],
    }));

    await expect(service.processSiteImages({
      workspaceId: 'ws',
      siteId: 'site',
      afterAssetId: 'asset-a',
      upperBound: 'asset-b',
      limit: 2,
    })).resolves.toMatchObject({
      processed: 1,
      nextCursor: null,
      upperBound: 'asset-b',
      items: [expect.objectContaining({ assetId: 'asset-b' })],
    });
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

  it('sanitizes a non-Error failure into one bounded line', async () => {
    const service = serviceWithAssets(['bad']);
    vi.spyOn(service, 'processAsset').mockRejectedValue('provider\nrefused');

    await expect(service.processSiteImages({ workspaceId: 'ws', siteId: 'site' })).resolves.toMatchObject({
      status: 'degraded',
      items: [{ assetId: 'bad', status: 'failed', error: 'provider refused' }],
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

  it('fails before the first asset when cancellation has a non-Error reason', async () => {
    const service = serviceWithAssets(['never-started']);
    const processAsset = vi.spyOn(service, 'processAsset');
    const abort = new AbortController();
    abort.abort('operator stopped the job');

    await expect(
      service.processSiteImages({ workspaceId: 'ws', siteId: 'site' }, abort.signal),
    ).rejects.toThrow('image pipeline aborted');
    expect(processAsset).not.toHaveBeenCalled();
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

  it('does not reconcile an active lease, an invalid lease or an unrelated ledger state', async () => {
    const rows = [
      {
        id: 'active',
        recipeHash: 'a'.repeat(64),
        objectKey: `ws/ws/site/variants/asset/${'a'.repeat(64)}.webp`,
        status: 'processing',
        metadata: { reservation: { leaseUntil: new Date(Date.now() + 60_000).toISOString() } },
      },
      {
        id: 'invalid-lease',
        recipeHash: 'b'.repeat(64),
        objectKey: `ws/ws/site/variants/asset/${'b'.repeat(64)}.webp`,
        status: 'processing',
        metadata: { reservation: { leaseUntil: 'not-a-date' } },
      },
      {
        id: 'other',
        recipeHash: 'c'.repeat(64),
        objectKey: `ws/ws/site/variants/asset/${'c'.repeat(64)}.webp`,
        status: 'queued',
        metadata: {},
      },
    ];
    const tx = {
      asset: { findFirst: vi.fn(async () => ({ id: 'asset' })) },
      assetVariant: { findMany: vi.fn(async () => rows) },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_workspace: string, work: (client: typeof tx) => unknown) => work(tx)),
    };
    const storage = { delete: vi.fn(), head: vi.fn() };
    const service = privateService({ prisma, storage });

    await expect(service['reconcileAttemptKeys']({
      workspaceId: 'ws',
      siteId: 'site',
      assetId: 'asset',
      sourceHash: 'd'.repeat(64),
      sourceObjectKey: 'source',
    })).resolves.toBeUndefined();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('ignores a processing row whose lease metadata is absent', async () => {
    const recipeHash = 'a'.repeat(64);
    const tx = {
      asset: { findFirst: vi.fn(async () => ({ id: 'asset' })) },
      assetVariant: { findMany: vi.fn(async () => [{
        id: 'lease-missing',
        recipeHash,
        objectKey: `ws/ws/site/variants/asset/${recipeHash}.webp`,
        status: 'processing',
        metadata: {},
      }]) },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_workspace: string, work: (client: typeof tx) => unknown) => work(tx)),
    };
    const storage = { delete: vi.fn(), head: vi.fn() };

    await expect(privateService({ prisma, storage })['reconcileAttemptKeys']({
      workspaceId: 'ws', siteId: 'site', assetId: 'asset',
      sourceHash: 'd'.repeat(64), sourceObjectKey: 'source',
    })).resolves.toBeUndefined();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('fails reconciliation when the source asset changed before inspection', async () => {
    const tx = {
      asset: { findFirst: vi.fn(async () => null) },
      assetVariant: { findMany: vi.fn() },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_workspace: string, work: (client: typeof tx) => unknown) => work(tx)),
    };

    await expect(privateService({ prisma })['reconcileAttemptKeys']({
      workspaceId: 'ws',
      siteId: 'site',
      assetId: 'asset',
      sourceHash: 'd'.repeat(64),
      sourceObjectKey: 'source',
    })).rejects.toThrow('asset changed before image attempt reconciliation');
    expect(tx.assetVariant.findMany).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'non-canonical object extension',
      objectKey: `ws/ws/site/variants/asset/${'a'.repeat(64)}.gif`,
      attemptKey: undefined,
      error: 'canonical provenance conflicts',
    },
    {
      label: 'malformed producer token',
      objectKey: `ws/ws/site/variants/asset/${'a'.repeat(64)}.webp`,
      attemptKey: `ws/ws/site/variant-attempts/asset/not-a-uuid/${'a'.repeat(64)}.webp`,
      error: 'attempt provenance conflicts',
    },
  ])('rejects $label during reconciliation', async ({ objectKey, attemptKey, error }) => {
    const tx = {
      asset: { findFirst: vi.fn(async () => ({ id: 'asset' })) },
      assetVariant: {
        findMany: vi.fn(async () => [{
          id: 'row',
          recipeHash: 'a'.repeat(64),
          objectKey,
          status: 'failed',
          metadata: attemptKey ? { reservation: { attemptKey } } : {},
        }]),
      },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_workspace: string, work: (client: typeof tx) => unknown) => work(tx)),
    };

    await expect(privateService({ prisma })['reconcileAttemptKeys']({
      workspaceId: 'ws',
      siteId: 'site',
      assetId: 'asset',
      sourceHash: 'd'.repeat(64),
      sourceObjectKey: 'source',
    })).rejects.toThrow(error);
  });

  it('fails closed when a supposedly deleted attempt object remains visible', async () => {
    const recipeHash = 'a'.repeat(64);
    const attemptKey = `ws/ws/site/variant-attempts/asset/77777777-7777-4777-8777-777777777777/${recipeHash}.webp`;
    const tx = {
      asset: { findFirst: vi.fn(async () => ({ id: 'asset' })) },
      assetVariant: {
        findMany: vi.fn(async () => [{
          id: 'row',
          recipeHash,
          objectKey: `ws/ws/site/variants/asset/${recipeHash}.webp`,
          status: 'failed',
          metadata: { attemptKeys: [attemptKey] },
        }]),
      },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_workspace: string, work: (client: typeof tx) => unknown) => work(tx)),
    };
    const storage = {
      delete: vi.fn(async () => undefined),
      head: vi.fn(async () => ({ size: 1, contentType: 'image/webp' })),
    };

    await expect(privateService({ prisma, storage })['reconcileAttemptKeys']({
      workspaceId: 'ws',
      siteId: 'site',
      assetId: 'asset',
      sourceHash: 'd'.repeat(64),
      sourceObjectKey: 'source',
    })).rejects.toThrow('could not delete');
  });

  it('bounds the number of historical attempt objects considered for reconciliation', async () => {
    const recipeHash = 'a'.repeat(64);
    const attemptKeys = Array.from({ length: 129 }, (_unused, index) => {
      const suffix = index.toString(16).padStart(12, '0');
      return `ws/ws/site/variant-attempts/asset/77777777-7777-4777-8777-${suffix}/${recipeHash}.webp`;
    });
    const tx = {
      asset: { findFirst: vi.fn(async () => ({ id: 'asset' })) },
      assetVariant: { findMany: vi.fn(async () => [{
        id: 'row',
        recipeHash,
        objectKey: `ws/ws/site/variants/asset/${recipeHash}.webp`,
        status: 'failed',
        metadata: { attemptKeys },
      }]) },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_workspace: string, work: (client: typeof tx) => unknown) => work(tx)),
    };
    const storage = { delete: vi.fn(), head: vi.fn() };

    await expect(privateService({ prisma, storage })['reconcileAttemptKeys']({
      workspaceId: 'ws', siteId: 'site', assetId: 'asset',
      sourceHash: 'd'.repeat(64), sourceObjectKey: 'source',
    })).rejects.toThrow('reconciliation exceeds 128 objects');
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('stops ledger pruning if the asset disappears after object deletion', async () => {
    const recipeHash = 'a'.repeat(64);
    const attemptKey = `ws/ws/site/variant-attempts/asset/77777777-7777-4777-8777-777777777777/${recipeHash}.webp`;
    const tx = {
      $queryRaw: vi.fn(async () => []),
      asset: { findFirst: vi.fn(async () => ({ id: 'asset' })) },
      assetVariant: {
        findMany: vi.fn(async () => [{
          id: 'row', recipeHash,
          objectKey: `ws/ws/site/variants/asset/${recipeHash}.webp`,
          status: 'failed', metadata: { attemptKeys: [attemptKey] },
        }]),
        updateMany: vi.fn(),
      },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_workspace: string, work: (client: typeof tx) => unknown) => work(tx)),
    };
    const storage = {
      delete: vi.fn(async () => undefined),
      head: vi.fn(async () => null),
    };

    await expect(privateService({ prisma, storage })['reconcileAttemptKeys']({
      workspaceId: 'ws', siteId: 'site', assetId: 'asset',
      sourceHash: 'd'.repeat(64), sourceObjectKey: 'source',
    })).resolves.toBeUndefined();
    expect(tx.assetVariant.updateMany).not.toHaveBeenCalled();
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

function privateService(input: { prisma?: unknown; storage?: unknown } = {}) {
  return new ImagePipelineService(
    (input.prisma ?? {}) as PrismaService,
    (input.storage ?? {}) as StorageService,
    {} as ImagePipelineRunner,
  ) as unknown as Record<string, (...args: never[]) => unknown>;
}

function variantPlan(format: 'avif' | 'webp' | 'jpeg' | 'png' = 'webp') {
  const plan = planImageVariants({
    assetKind: format === 'png' ? 'logo' : 'product_image',
    assetContentHash: 'a'.repeat(64),
    inspection: {
      decodedMime: 'image/png',
      width: 320,
      height: 240,
      hasAlpha: format === 'png',
      hasExif: false,
      hasIcc: false,
      orientation: null,
      quality: {
        policyVersion: 'image-qa-m1c.1',
        metrics: { entropy: 1, sharpness: 1, exposure: 1, noise: 0 },
        warnings: [],
      },
    },
  }).find((candidate) => candidate.recipe.output.format === format);
  if (!plan) throw new Error(`missing ${format} fixture plan`);
  return plan;
}

function rendered(plan = variantPlan(), data = Buffer.from('image')) {
  const contentHash = createHash('sha256').update(data).digest('hex');
  return {
    data,
    info: {
      contentHash,
      sizeBytes: data.length,
      width: plan.recipe.output.width,
      height: plan.recipe.output.height,
      mime:
        plan.recipe.output.format === 'avif'
          ? 'image/avif'
          : plan.recipe.output.format === 'webp'
            ? 'image/webp'
            : plan.recipe.output.format === 'jpeg'
              ? 'image/jpeg'
              : 'image/png',
    },
  };
}

describe('ImagePipelineService rendered/object integrity branches', () => {
  it('accepts a complete rendered set and rejects count, recipe and identity drift independently', () => {
    const service = privateService();
    const plan = variantPlan();
    const output = rendered(plan);
    const map = new Map([[plan.recipeHash, output]]);

    expect(() => service['validateRendered']([plan], map)).not.toThrow();
    expect(() => service['validateRendered']([plan], new Map())).toThrow('incomplete');
    expect(() =>
      service['validateRendered']([{ ...plan, recipeHash: 'x'.repeat(64) }], map),
    ).toThrow('recipe identity drifted');

    for (const altered of [
      { ...output, info: { ...output.info, contentHash: '0'.repeat(64) } },
      { ...output, info: { ...output.info, sizeBytes: output.info.sizeBytes + 1 } },
      { ...output, info: { ...output.info, width: 99 } },
      { ...output, info: { ...output.info, height: 99 } },
    ]) {
      expect(() =>
        service['validateRendered']([plan], new Map([[plan.recipeHash, altered]])),
      ).toThrow('renderer output is invalid');
    }
  });

  it('reuses an exact object and rejects an existing conflicting object', async () => {
    const plan = variantPlan();
    const output = rendered(plan);
    const storage = {
      head: vi.fn(async () => ({ size: output.info.sizeBytes, contentType: output.info.mime })),
      hashObject: vi.fn(async () => ({ sha256: output.info.contentHash, size: output.info.sizeBytes })),
      putBuffer: vi.fn(),
    };
    const service = privateService({ storage });
    await expect(service['ensureObject']('key', output)).resolves.toBe(true);
    expect(storage.putBuffer).not.toHaveBeenCalled();

    storage.head.mockResolvedValue({ size: 999, contentType: output.info.mime });
    await expect(service['ensureObject']('key', output)).rejects.toThrow('conflicts');
  });

  it('writes and verifies a missing attempt object with and without lifecycle metadata', async () => {
    const output = rendered();
    for (const lifecycle of [undefined, 'variant-attempt'] as const) {
      const storage = {
        head: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ size: output.info.sizeBytes, contentType: output.info.mime }),
        hashObject: vi.fn(async () => ({ sha256: output.info.contentHash, size: output.info.sizeBytes })),
        putBuffer: vi.fn(async () => undefined),
      };
      const service = privateService({ storage });
      await expect(service['ensureObject']('key', output, undefined, lifecycle)).resolves.toBe(false);
      expect(storage.putBuffer).toHaveBeenCalledWith(
        'key',
        output.data,
        output.info.mime,
        undefined,
        lifecycle ? { lifecycle } : undefined,
      );
    }
  });

  it('recovers a lost PUT response only when authoritative bytes exist', async () => {
    const output = rendered();
    const absent = {
      head: vi.fn(async () => null),
      hashObject: vi.fn(),
      putBuffer: vi.fn(async () => { throw new Error('put unavailable'); }),
    };
    await expect(privateService({ storage: absent })['ensureObject']('key', output)).rejects.toThrow(
      'put unavailable',
    );

    const committed = {
      head: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ size: output.info.sizeBytes, contentType: output.info.mime })
        .mockResolvedValueOnce({ size: output.info.sizeBytes, contentType: output.info.mime }),
      hashObject: vi.fn(async () => ({ sha256: output.info.contentHash, size: output.info.sizeBytes })),
      putBuffer: vi.fn(async () => { throw new Error('response lost'); }),
    };
    await expect(privateService({ storage: committed })['ensureObject']('key', output)).resolves.toBe(false);
  });

  it('fails verification when final object metadata or hash does not match', async () => {
    const output = rendered();
    const storage = {
      head: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null),
      hashObject: vi.fn(async () => ({ sha256: 'wrong', size: 0 })),
      putBuffer: vi.fn(async () => undefined),
    };
    await expect(privateService({ storage })['ensureObject']('key', output)).rejects.toThrow(
      'verification failed',
    );
  });

  it('verifies ready objects across missing, identity mismatch and exact states', async () => {
    const output = rendered();
    const missing = privateService({ storage: { head: vi.fn(async () => null) } });
    await expect(missing['verifyReadyObject']('key', output)).rejects.toThrow('missing');

    const mismatch = privateService({
      storage: {
        head: vi.fn(async () => ({ size: 999, contentType: output.info.mime })),
        hashObject: vi.fn(async () => ({ sha256: output.info.contentHash, size: output.info.sizeBytes })),
      },
    });
    await expect(mismatch['verifyReadyObject']('key', output)).rejects.toThrow('identity mismatch');

    const exact = privateService({
      storage: {
        head: vi.fn(async () => ({ size: output.info.sizeBytes, contentType: output.info.mime })),
        hashObject: vi.fn(async () => ({ sha256: output.info.contentHash, size: output.info.sizeBytes })),
      },
    });
    await expect(exact['verifyReadyObject']('key', output)).resolves.toBeUndefined();
  });
});

describe('ImagePipelineService private lease and metadata contracts', () => {
  const job = {
    workspaceId: 'ws',
    siteId: 'site',
    assetId: 'asset',
    sourceMeta: { hasPerson: true },
  };

  it('maps every output format and includes only present metadata branches', () => {
    const service = privateService();
    expect(
      (['avif', 'webp', 'jpeg', 'png'] as const).map((format) =>
        service['outputMime'](variantPlan(format)),
      ),
    ).toEqual(['image/avif', 'image/webp', 'image/jpeg', 'image/png']);
    const plan = variantPlan();
    const inspection = { quality: { warnings: [] } };
    expect(
      service['variantMetadata'](
        job,
        inspection,
        plan,
        { token: 'token', leaseUntil: NOW, attempt: 1, attemptKey: 'attempt' },
        ['attempt'],
      ),
    ).toMatchObject({ hasPerson: true, reservation: { token: 'token' }, attemptKeys: ['attempt'] });
    expect(
      service['variantMetadata'](
        { ...job, sourceMeta: { hasPerson: 'yes' } },
        inspection,
        plan,
      ),
    ).not.toHaveProperty('hasPerson');
  });

  it('builds a frozen initial processing reservation', () => {
    const service = privateService();
    const plan = variantPlan('jpeg');
    const data = service['reservationData'](
      job,
      { quality: { warnings: [] } },
      plan,
      'canonical-key',
      '77777777-7777-4777-8777-777777777777',
      new Date(NOW),
    ) as Record<string, unknown>;
    expect(data).toMatchObject({
      status: 'processing',
      mime: 'image/jpeg',
      objectKey: 'canonical-key',
      contentHash: null,
      metadata: expect.objectContaining({
        reservation: expect.objectContaining({ attempt: 1 }),
        attemptKeys: expect.any(Array),
      }),
    });
  });

  it('clears only a currently referenced ready attempt key', async () => {
    const attemptKey = 'attempt-1';
    const row = { id: 'variant-1', metadata: { attemptKeys: [attemptKey, 'keep'] } };
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: 'asset' }]),
      assetVariant: {
        findFirst: vi.fn(async () => row),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    const prisma = { withWorkspace: vi.fn(async (_ws: string, work: (x: typeof tx) => unknown) => work(tx)) };
    const service = privateService({ prisma });
    await service['clearAttemptKey'](job, 'recipe', attemptKey);
    expect(tx.assetVariant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { metadata: { attemptKeys: ['keep'] } } }),
    );

    tx.$queryRaw.mockResolvedValue([]);
    await service['clearAttemptKey'](job, 'recipe', attemptKey);
    tx.$queryRaw.mockResolvedValue([{ id: 'asset' }]);
    tx.assetVariant.findFirst.mockResolvedValue(null);
    await service['clearAttemptKey'](job, 'recipe', attemptKey);
    tx.assetVariant.findFirst.mockResolvedValue({ id: 'variant-1', metadata: {} });
    await service['clearAttemptKey'](job, 'recipe', attemptKey);
    expect(tx.assetVariant.updateMany).toHaveBeenCalledTimes(1);
  });

  it('renews owned leases, skips ready rows and reports whether the current recipe needs promotion', async () => {
    const plan = variantPlan();
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: 'asset' }]),
      assetVariant: {
        findMany: vi.fn(async () => [
          { id: 'ready', recipeHash: 'ready', status: 'ready', metadata: {} },
          {
            id: 'current',
            recipeHash: plan.recipeHash,
            status: 'processing',
            metadata: { reservation: { token: 'producer' } },
          },
        ]),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    const prisma = { withWorkspace: vi.fn(async (_ws: string, work: (x: typeof tx) => unknown) => work(tx)) };
    const service = privateService({ prisma });
    await expect(
      service['renewReservation'](job, [{ ...plan, recipeHash: 'ready' }, plan], plan.recipeHash, 'producer'),
    ).resolves.toBe(true);
    await expect(
      service['renewReservation'](job, [{ ...plan, recipeHash: 'ready' }, plan], 'missing', 'producer'),
    ).resolves.toBe(false);
  });

  it('fails lease renewal for changed assets, incomplete sets, fencing and lost CAS', async () => {
    const plan = variantPlan();
    const tx = {
      $queryRaw: vi.fn(async () => []),
      assetVariant: { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 1 })) },
    };
    const prisma = { withWorkspace: vi.fn(async (_ws: string, work: (x: typeof tx) => unknown) => work(tx)) };
    const service = privateService({ prisma });
    await expect(service['renewReservation'](job, [plan], plan.recipeHash, 'producer')).rejects.toThrow(
      'no longer writable',
    );
    tx.$queryRaw.mockResolvedValue([{ id: 'asset' }]);
    await expect(service['renewReservation'](job, [plan], plan.recipeHash, 'producer')).rejects.toThrow(
      'set is incomplete',
    );
    tx.assetVariant.findMany.mockResolvedValue([
      { id: 'v', recipeHash: plan.recipeHash, status: 'processing', metadata: { reservation: { token: 'other' } } },
    ]);
    await expect(service['renewReservation'](job, [plan], plan.recipeHash, 'producer')).rejects.toThrow('fenced');
    tx.assetVariant.findMany.mockResolvedValue([
      { id: 'v', recipeHash: plan.recipeHash, status: 'processing', metadata: { reservation: { token: 'producer' } } },
    ]);
    tx.assetVariant.updateMany.mockResolvedValue({ count: 0 });
    await expect(service['renewReservation'](job, [plan], plan.recipeHash, 'producer')).rejects.toThrow(
      'lease renewal lost',
    );
  });

  it('fails only processing rows owned by the producer token', async () => {
    const plan = variantPlan();
    const tx = {
      $queryRaw: vi.fn(async () => []),
      assetVariant: {
        findMany: vi.fn(async () => [
          { id: 'owned', metadata: { reservation: { token: 'producer' } } },
          { id: 'other', metadata: { reservation: { token: 'other' } } },
        ]),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    const prisma = { withWorkspace: vi.fn(async (_ws: string, work: (x: typeof tx) => unknown) => work(tx)) };
    const service = privateService({ prisma });
    await service['failReservation'](job, [plan], 'producer', 'reason');
    expect(tx.assetVariant.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.assetVariant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'failed', error: 'IMAGE_VARIANT_ATTEMPT_FAILED: reason' } }),
    );
  });
});

describe('ImagePipelineService processAsset orchestration', () => {
  const input = { workspaceId: 'ws', siteId: 'site', assetId: 'asset' };
  const source = Buffer.from('committed-image');
  const hash = createHash('sha256').update(source).digest('hex');
  const inspection = {
    decodedMime: 'image/png' as const,
    width: 320,
    height: 240,
    hasAlpha: false,
    hasExif: false,
    hasIcc: false,
    orientation: null,
    quality: {
      policyVersion: 'image-qa-m1c.1' as const,
      metrics: { entropy: 1, sharpness: 1, exposure: 1, noise: 0 },
      warnings: ['blurry' as const],
    },
  };

  function orchestration(over: Record<string, unknown> = {}) {
    const asset = {
      id: 'asset',
      kind: 'product_image',
      mime: 'image/png',
      sizeBytes: source.length,
      contentHash: hash,
      objectKey: 'source-key',
      meta: {},
      ...over,
    };
    const tx = { asset: { findFirst: vi.fn(async () => asset) } };
    const prisma = { withWorkspace: vi.fn(async (_ws: string, work: (x: typeof tx) => unknown) => work(tx)) };
    const storage = { getBufferBounded: vi.fn(async () => source) };
    const runner = {
      inspect: vi.fn(async () => inspection),
      render: vi.fn(async (_bytes: Buffer, plans: ReturnType<typeof planImageVariants>) =>
        new Map(plans.map((plan) => [plan.recipeHash, rendered(plan)]))),
    };
    const service = new ImagePipelineService(prisma as never, storage as never, runner as never);
    return { asset, tx, prisma, storage, runner, service };
  }

  it.each([
    ['missing asset', null, 'not found'],
    ['missing hash', { contentHash: null }, 'not found'],
    ['wrong kind', { kind: 'doc' }, 'not a processable image'],
    ['wrong mime', { mime: 'application/pdf' }, 'not a processable image'],
    ['empty bytes policy', { sizeBytes: 0 }, 'byte policy'],
    ['oversized bytes policy', { sizeBytes: 21 * 1024 * 1024 }, 'byte policy'],
  ])('rejects %s before rendering', async (_name, override, message) => {
    const h = orchestration((override ?? {}) as Record<string, unknown>);
    if (override === null) h.tx.asset.findFirst.mockResolvedValue(null as never);
    await expect(h.service.processAsset(input)).rejects.toThrow(message);
    expect(h.runner.render).not.toHaveBeenCalled();
  });

  it('rejects source length and hash identity drift before inspection', async () => {
    const wrongLength = orchestration();
    wrongLength.storage.getBufferBounded.mockResolvedValue(Buffer.from('x'));
    await expect(wrongLength.service.processAsset(input)).rejects.toThrow('committed identity');
    const wrongHash = orchestration({ contentHash: '0'.repeat(64) });
    await expect(wrongHash.service.processAsset(input)).rejects.toThrow('committed identity');
  });

  it('returns a complete reuse result and accepts only bounded focal points', async () => {
    for (const meta of [
      { focalPoint: { x: 0.25, y: 0.75 } },
      { focalPoint: { x: -1, y: 2 } },
      { focalPoint: null },
    ]) {
      const h = orchestration({ meta });
      const reuse = vi.spyOn(h.service as never, 'tryReuseReadySet').mockResolvedValue(true);
      const result = await h.service.processAsset(input);
      expect(result).toMatchObject({ status: 'done', reused: result.variants, qualityWarnings: ['blurry'] });
      const plans = reuse.mock.calls[0]?.[1] as ReturnType<typeof planImageVariants>;
      const focal = plans[0]?.recipe.output.focalPoint;
      expect(focal).toEqual(meta.focalPoint?.x === 0.25 ? meta.focalPoint : null);
    }
  });

  it('reconciles, reserves, renders, validates and finalizes a new variant set', async () => {
    const h = orchestration();
    vi.spyOn(h.service as never, 'tryReuseReadySet').mockResolvedValue(false);
    const reconcile = vi.spyOn(h.service as never, 'reconcileAttemptKeys').mockResolvedValue(undefined);
    vi.spyOn(h.service as never, 'reserveVariantSet').mockResolvedValue(true);
    const finalize = vi.spyOn(h.service as never, 'materializeAndFinalize').mockResolvedValue({ reused: 2 });
    const result = await h.service.processAsset(input);
    expect(result).toMatchObject({ status: 'done', reused: 2, qualityWarnings: ['blurry'] });
    expect(reconcile).toHaveBeenCalled();
    expect(h.runner.render).toHaveBeenCalled();
    expect(finalize).toHaveBeenCalled();
  });

  it('waits behind a producer then reuses its ready set', async () => {
    const h = orchestration();
    const reuse = vi
      .spyOn(h.service as never, 'tryReuseReadySet')
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    vi.spyOn(h.service as never, 'reconcileAttemptKeys').mockResolvedValue(undefined);
    vi.spyOn(h.service as never, 'reserveVariantSet').mockResolvedValue(false);
    await expect(h.service.processAsset(input)).resolves.toMatchObject({ status: 'done' });
    expect(reuse).toHaveBeenCalledTimes(2);
    expect(h.runner.render).not.toHaveBeenCalled();
  });

  it('marks an owned reservation failed when rendering fails', async () => {
    const h = orchestration();
    vi.spyOn(h.service as never, 'tryReuseReadySet').mockResolvedValue(false);
    vi.spyOn(h.service as never, 'reconcileAttemptKeys').mockResolvedValue(undefined);
    vi.spyOn(h.service as never, 'reserveVariantSet').mockResolvedValue(true);
    h.runner.render.mockRejectedValue(new Error('render failed\nwith detail'));
    const fail = vi.spyOn(h.service as never, 'failReservation').mockResolvedValue(undefined);
    await expect(h.service.processAsset(input)).rejects.toThrow('render failed');
    expect(fail).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.any(String), 'render failed with detail');
  });
});

describe('ImagePipelineService ready-set reuse validation', () => {
  const reuseWorkspaceId = '11111111-1111-4111-8111-111111111111';
  const reuseSiteId = '22222222-2222-4222-8222-222222222222';
  const reuseAssetId = '33333333-3333-4333-8333-333333333333';
  const input = {
    workspaceId: reuseWorkspaceId, siteId: reuseSiteId, assetId: reuseAssetId,
    sourceHash: 'a'.repeat(64), sourceObjectKey: 'source',
  };
  const plan = variantPlan();
  const expectedKey = `ws/${reuseWorkspaceId}/${reuseSiteId}/variants/${reuseAssetId}/${plan.recipeHash}.webp`;
  const baseRow = {
    id: 'variant-1', recipeHash: plan.recipeHash, objectKey: expectedKey,
    variantType: plan.recipe.output.role, width: plan.recipe.output.width,
    height: plan.recipe.output.height, contentHash: 'b'.repeat(64), sizeBytes: 5,
    mime: 'image/webp', pipelineVersion: 'pipeline', status: 'ready', metadata: {},
  };

  function reuseHarness(row: Record<string, unknown> | null = baseRow) {
    let phase = 0;
    const tx = {
      asset: { findFirst: vi.fn(async () => ({ id: 'asset' })), update: vi.fn(async () => ({})) },
      assetVariant: { findMany: vi.fn(async () => row ? [row] : []) },
      $queryRaw: vi.fn(async () => [{ id: 'asset' }]),
    };
    const prisma = {
      withWorkspace: vi.fn(async (_ws: string, work: (x: typeof tx) => unknown) => {
        phase += 1;
        return work(tx);
      }),
    };
    const storage = {
      head: vi.fn(async () => ({ size: 5, contentType: 'image/webp' })),
      hashObject: vi.fn(async () => ({ sha256: 'b'.repeat(64), size: 5 })),
    };
    return { tx, prisma, storage, service: privateService({ prisma, storage }), phase: () => phase };
  }

  it('short-circuits an empty plan and missing snapshot', async () => {
    const empty = reuseHarness();
    await expect(empty.service['tryReuseReadySet'](input, [])).resolves.toBe(true);
    expect(empty.prisma.withWorkspace).not.toHaveBeenCalled();
    const missing = reuseHarness();
    missing.tx.asset.findFirst.mockResolvedValue(null);
    await expect(missing.service['tryReuseReadySet'](input, [plan])).resolves.toBe(false);
  });

  it.each([
    ['missing row', null],
    ['wrong key', { ...baseRow, objectKey: 'wrong' }],
    ['wrong role', { ...baseRow, variantType: 'hero' }],
    ['wrong width', { ...baseRow, width: 999 }],
    ['wrong height', { ...baseRow, height: 999 }],
    ['null hash', { ...baseRow, contentHash: null }],
    ['null size', { ...baseRow, sizeBytes: null }],
  ])('rejects snapshot %s', async (_name, row) => {
    const h = reuseHarness(row as never);
    await expect(h.service['tryReuseReadySet'](input, [plan])).resolves.toBe(false);
  });

  it('rejects storage metadata and content hash drift', async () => {
    const missing = reuseHarness();
    missing.storage.head.mockResolvedValue(null as never);
    await expect(missing.service['tryReuseReadySet'](input, [plan])).resolves.toBe(false);
    const headMismatch = reuseHarness();
    headMismatch.storage.head.mockResolvedValue({ size: 6, contentType: 'image/webp' });
    await expect(headMismatch.service['tryReuseReadySet'](input, [plan])).resolves.toBe(false);
    const hashMismatch = reuseHarness();
    hashMismatch.storage.hashObject.mockResolvedValue({ sha256: 'c'.repeat(64), size: 5 });
    await expect(hashMismatch.service['tryReuseReadySet'](input, [plan])).resolves.toBe(false);
  });

  it('revalidates under the asset lock and writes the derived manifest', async () => {
    const h = reuseHarness();
    await expect(h.service['tryReuseReadySet'](input, [plan])).resolves.toBe(true);
    expect(h.tx.asset.update).toHaveBeenCalled();

    const lostAsset = reuseHarness();
    lostAsset.tx.$queryRaw.mockResolvedValue([]);
    await expect(lostAsset.service['tryReuseReadySet'](input, [plan])).resolves.toBe(false);

    const stale = reuseHarness();
    stale.tx.assetVariant.findMany
      .mockResolvedValueOnce([baseRow])
      .mockResolvedValueOnce([{ ...baseRow, id: 'changed' }]);
    await expect(stale.service['tryReuseReadySet'](input, [plan])).resolves.toBe(false);
  });
});

describe('ImagePipelineService reservation and promotion fencing', () => {
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  const siteId = '22222222-2222-4222-8222-222222222222';
  const assetId = '33333333-3333-4333-8333-333333333333';
  const producer = '77777777-7777-4777-8777-777777777777';
  const job = {
    workspaceId, siteId, assetId, sourceHash: 'a'.repeat(64), sourceObjectKey: 'source', sourceMeta: {},
  };
  const inspection = {
    quality: { warnings: [] },
  };
  const plan = variantPlan();
  const key = `ws/${workspaceId}/${siteId}/variants/${assetId}/${plan.recipeHash}.webp`;
  const attemptKey = `ws/${workspaceId}/${siteId}/variant-attempts/${assetId}/${producer}/${plan.recipeHash}.webp`;

  function reserveHarness(existing: Record<string, unknown>[] = []) {
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: assetId }]),
      $executeRaw: vi.fn(async () => 1),
      assetVariant: {
        findMany: vi.fn(async () => existing),
        create: vi.fn(async () => ({})),
        update: vi.fn(async () => ({})),
      },
    };
    const prisma = { withWorkspace: vi.fn(async (_ws: string, work: (x: typeof tx) => unknown) => work(tx)) };
    return { tx, service: privateService({ prisma }) };
  }

  function existing(over: Record<string, unknown> = {}) {
    return {
      id: 'variant-1', recipeHash: plan.recipeHash, objectKey: key,
      pipelineVersion: IMAGE_PIPELINE_VERSION, variantType: plan.recipe.output.role,
      mime: 'image/webp', width: plan.recipe.output.width, height: plan.recipe.output.height,
      status: 'failed', metadata: {}, ...over,
    };
  }

  it('creates a new reservation and leaves an exact ready variant untouched', async () => {
    const fresh = reserveHarness();
    await expect(fresh.service['reserveVariantSet'](job, inspection, [plan], producer)).resolves.toBe(true);
    expect(fresh.tx.assetVariant.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'processing', objectKey: key }) }),
    );

    const ready = reserveHarness([existing({ status: 'ready' })]);
    await expect(ready.service['reserveVariantSet'](job, inspection, [plan], producer)).resolves.toBe(true);
    expect(ready.tx.assetVariant.create).not.toHaveBeenCalled();
    expect(ready.tx.assetVariant.update).not.toHaveBeenCalled();
  });

  it('renews failed/expired rows and increments only a valid integer attempt counter', async () => {
    for (const [attempt, expected] of [[2, 3], ['bad', 1]] as const) {
      const h = reserveHarness([
        existing({ metadata: { reservation: { attempt }, attemptKeys: [] } }),
      ]);
      await expect(h.service['reserveVariantSet'](job, inspection, [plan], producer)).resolves.toBe(true);
      expect(h.tx.assetVariant.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            metadata: expect.objectContaining({ reservation: expect.objectContaining({ attempt: expected }) }),
          }),
        }),
      );
    }
  });

  it('waits for another valid live producer and rejects malformed leases', async () => {
    const future = reserveHarness([
      existing({
        status: 'processing',
        metadata: { reservation: { token: 'other', leaseUntil: new Date(Date.now() + 60_000).toISOString() } },
      }),
    ]);
    await expect(future.service['reserveVariantSet'](job, inspection, [plan], producer)).resolves.toBe(false);

    for (const reservation of [{}, { token: 'other', leaseUntil: 'not-a-date' }]) {
      const malformed = reserveHarness([existing({ status: 'processing', metadata: { reservation } })]);
      await expect(malformed.service['reserveVariantSet'](job, inspection, [plan], producer)).rejects.toThrow(
        'invalid processing lease',
      );
    }
  });

  it('rejects changed assets, variant-count overflow and every existing provenance mismatch', async () => {
    const changed = reserveHarness();
    changed.tx.$queryRaw.mockResolvedValue([]);
    await expect(changed.service['reserveVariantSet'](job, inspection, [plan], producer)).rejects.toThrow(
      'asset changed',
    );

    const overflowRows = Array.from({ length: 120 }, (_, index) => ({
      ...existing(), id: `v-${index}`, recipeHash: `${index}`.padStart(64, '0'), status: 'ready',
    }));
    await expect(
      reserveHarness(overflowRows).service['reserveVariantSet'](job, inspection, [plan], producer),
    ).rejects.toThrow('variant budget exceeded');

    for (const mutation of [
      { objectKey: 'wrong' },
      { pipelineVersion: 'old' },
      { variantType: 'hero' },
      { mime: 'image/png' },
      { width: 999 },
      { height: 999 },
    ]) {
      await expect(
        reserveHarness([existing(mutation)]).service['reserveVariantSet'](job, inspection, [plan], producer),
      ).rejects.toThrow('provenance conflicts');
    }
  });

  it('rejects a ninth durable attempt key', async () => {
    const keys = Array.from({ length: 8 }, (_, index) => {
      const token = `88888888-8888-4888-8888-${String(index).padStart(12, '0')}`;
      return `ws/${workspaceId}/${siteId}/variant-attempts/${assetId}/${token}/${plan.recipeHash}.webp`;
    });
    const h = reserveHarness([existing({ metadata: { attemptKeys: keys } })]);
    await expect(h.service['reserveVariantSet'](job, inspection, [plan], producer)).rejects.toThrow(
      'attempt-key budget exceeded',
    );
  });

  function promotionHarness(row: Record<string, unknown> | null = existing({
    status: 'processing',
    metadata: { reservation: { token: producer, attemptKey }, attemptKeys: [attemptKey] },
  })) {
    const output = rendered(plan);
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: assetId }]),
      $executeRaw: vi.fn(async () => 1),
      assetVariant: {
        findFirst: vi.fn(async () => row),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    const prisma = { withWorkspace: vi.fn(async (_ws: string, work: (x: typeof tx) => unknown) => work(tx)) };
    const storage = {
      head: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ size: output.info.sizeBytes, contentType: output.info.mime }),
      copy: vi.fn(async () => undefined),
      hashObject: vi.fn(async () => ({ sha256: output.info.contentHash, size: output.info.sizeBytes })),
    };
    return { output, tx, storage, service: privateService({ prisma, storage }) };
  }

  it('copies, verifies and CAS-promotes an owned attempt', async () => {
    const h = promotionHarness();
    await expect(
      h.service['promoteAttempt'](job, inspection, plan, h.output, producer, attemptKey, key),
    ).resolves.toBeUndefined();
    expect(h.storage.copy).toHaveBeenCalledWith(attemptKey, key, undefined);
    expect(h.tx.assetVariant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ready' }) }),
    );
  });

  it('accepts an already-ready exact row but rejects changed identity', async () => {
    const exact = promotionHarness(existing({
      status: 'ready', contentHash: rendered(plan).info.contentHash, sizeBytes: rendered(plan).info.sizeBytes,
    }));
    await expect(
      exact.service['promoteAttempt'](job, inspection, plan, exact.output, producer, attemptKey, key),
    ).resolves.toBeUndefined();
    const mismatch = promotionHarness(existing({ status: 'ready', contentHash: '0'.repeat(64), sizeBytes: 1 }));
    await expect(
      mismatch.service['promoteAttempt'](job, inspection, plan, mismatch.output, producer, attemptKey, key),
    ).rejects.toThrow('ready variant identity conflicts');
  });

  it('rejects missing locks, rows and each reservation fencing mismatch', async () => {
    const locked = promotionHarness();
    locked.tx.$queryRaw.mockResolvedValue([]);
    await expect(
      locked.service['promoteAttempt'](job, inspection, plan, locked.output, producer, attemptKey, key),
    ).rejects.toThrow('asset changed');

    const missing = promotionHarness(null);
    await expect(
      missing.service['promoteAttempt'](job, inspection, plan, missing.output, producer, attemptKey, key),
    ).rejects.toThrow('reservation is missing');

    for (const row of [
      existing({ status: 'failed', metadata: { reservation: { token: producer, attemptKey } } }),
      existing({ status: 'processing', metadata: { reservation: { token: 'other', attemptKey } } }),
      existing({ status: 'processing', metadata: { reservation: { token: producer, attemptKey: 'other' } } }),
    ]) {
      const fenced = promotionHarness(row);
      await expect(
        fenced.service['promoteAttempt'](job, inspection, plan, fenced.output, producer, attemptKey, key),
      ).rejects.toThrow('promotion was fenced');
    }
  });

  it('recovers a committed copy response loss and rejects absent or mismatched final bytes', async () => {
    const recovered = promotionHarness();
    recovered.storage.copy.mockRejectedValue(new Error('copy response lost'));
    await expect(
      recovered.service['promoteAttempt'](job, inspection, plan, recovered.output, producer, attemptKey, key),
    ).resolves.toBeUndefined();

    const absent = promotionHarness();
    absent.storage.copy.mockRejectedValue(new Error('copy failed'));
    absent.storage.head.mockReset().mockResolvedValue(null);
    await expect(
      absent.service['promoteAttempt'](job, inspection, plan, absent.output, producer, attemptKey, key),
    ).rejects.toThrow('copy failed');

    const invalid = promotionHarness();
    invalid.storage.head.mockReset().mockResolvedValue({ size: 999, contentType: invalid.output.info.mime });
    await expect(
      invalid.service['promoteAttempt'](job, inspection, plan, invalid.output, producer, attemptKey, key),
    ).rejects.toThrow('promotion verification failed');
  });

  it('fails closed when promotion CAS loses fencing', async () => {
    const h = promotionHarness();
    h.tx.assetVariant.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      h.service['promoteAttempt'](job, inspection, plan, h.output, producer, attemptKey, key),
    ).rejects.toThrow('promotion CAS lost');
  });
});
