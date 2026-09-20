import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IMAGE_PIPELINE_VERSION, IMAGE_QUALITY_POLICY_VERSION, planImageVariants, type ImageInspection, type PlannedImageVariant, type RenderedImageVariant } from './image-pipeline';
import { buildVariantObjectKey, buildVariantAttemptObjectKey } from './object-key';

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

// Local ledger/storage fakes exercise the real producer methods; no object store or database is contacted.
const imageJob = {
  workspaceId: "22222222-2222-4222-8222-222222222222",
  siteId: "33333333-3333-4333-8333-333333333333",
  assetId: "44444444-4444-4444-8444-444444444444",
  sourceHash: "a".repeat(64),
  sourceObjectKey: "source",
  sourceMeta: {},
};
const producer = "77777777-7777-4777-8777-777777777777";
const inspection: ImageInspection = {
  decodedMime: "image/png",
  width: 400,
  height: 300,
  hasAlpha: true,
  hasExif: false,
  hasIcc: false,
  orientation: null,
  quality: {
    policyVersion: IMAGE_QUALITY_POLICY_VERSION,
    metrics: { entropy: 5, sharpness: 10, exposure: 100, noise: 1 },
    warnings: [],
  },
};
const imagePlans = planImageVariants({
  assetKind: "logo",
  assetContentHash: imageJob.sourceHash,
  inspection,
  focalPoint: null,
});
const imagePlan = imagePlans[0];
const digest = (data: Buffer) =>
  createHash("sha256").update(data).digest("hex");
const variantKey = (plan = imagePlan) =>
  buildVariantObjectKey(
    imageJob.workspaceId,
    imageJob.siteId,
    imageJob.assetId,
    plan.recipeHash,
    plan.recipe.output.format,
  );
const attemptKey = (plan = imagePlan) =>
  buildVariantAttemptObjectKey(
    imageJob.workspaceId,
    imageJob.siteId,
    imageJob.assetId,
    producer,
    plan.recipeHash,
    plan.recipe.output.format,
  );
function renderedVariant(plan = imagePlan): RenderedImageVariant {
  const data = Buffer.from("synthetic encoded bytes");
  const mimes = {
    avif: "image/avif",
    webp: "image/webp",
    jpeg: "image/jpeg",
    png: "image/png",
  } as const;
  return {
    data,
    info: {
      contentHash: digest(data),
      sizeBytes: data.length,
      width: plan.recipe.output.width,
      height: plan.recipe.output.height,
      mime: mimes[plan.recipe.output.format],
    },
  };
}
function variantRow(plan = imagePlan) {
  const output = renderedVariant(plan);
  return {
    id: "row-1",
    assetId: imageJob.assetId,
    recipeHash: plan.recipeHash,
    objectKey: variantKey(plan),
    pipelineVersion: IMAGE_PIPELINE_VERSION,
    variantType: plan.recipe.output.role,
    width: plan.recipe.output.width,
    height: plan.recipe.output.height,
    mime: output.info.mime,
    contentHash: output.info.contentHash as string | null,
    sizeBytes: output.info.sizeBytes as number | null,
    status: "ready",
    metadata: {} as Record<string, unknown>,
  };
}
type ImageInternals = Pick<ImagePipelineService, 'processAsset' | 'processSiteImages'> & {
  ensureObject: ImagePipelineService['ensureObject'];
  verifyReadyObject: ImagePipelineService['verifyReadyObject'];
  validateRendered: ImagePipelineService['validateRendered'];
  tryReuseReadySet: ImagePipelineService['tryReuseReadySet'];
  reserveVariantSet: ImagePipelineService['reserveVariantSet'];
  renewReservation: ImagePipelineService['renewReservation'];
  failReservation: ImagePipelineService['failReservation'];
  clearAttemptKey: ImagePipelineService['clearAttemptKey'];
  promoteAttempt: ImagePipelineService['promoteAttempt'];
  materializeAndFinalize: ImagePipelineService['materializeAndFinalize'];
  reconcileAttemptKeys: ImagePipelineService['reconcileAttemptKeys'];
};
function imageFixture() {
  const source = Buffer.from("synthetic source");
  const asset = {
    id: imageJob.assetId,
    kind: "logo",
    mime: "image/png",
    contentHash: digest(source),
    sizeBytes: source.length,
    objectKey: "source",
    meta: {},
  };
  const output = renderedVariant();
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: imageJob.assetId }]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    asset: {
      findFirst: vi.fn().mockResolvedValue(asset),
      update: vi.fn().mockResolvedValue(asset),
    },
    assetVariant: {
      findMany: vi.fn().mockResolvedValue([variantRow()]),
      findFirst: vi.fn().mockResolvedValue(variantRow()),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const storage = {
    getBufferBounded: vi.fn().mockResolvedValue(source),
    head: vi
      .fn()
      .mockResolvedValue({
        size: output.info.sizeBytes,
        contentType: output.info.mime,
      }),
    hashObject: vi
      .fn()
      .mockResolvedValue({
        size: output.info.sizeBytes,
        sha256: output.info.contentHash,
      }),
    putBuffer: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    copy: vi.fn().mockResolvedValue(undefined),
  };
  const runner = {
    inspect: vi.fn().mockResolvedValue(inspection),
    render: vi
      .fn()
      .mockResolvedValue(new Map([[imagePlan.recipeHash, output]])),
  };
  const prisma = {
    withWorkspace: vi.fn(
      async (_workspace: string, fn: (client: typeof tx) => unknown) => fn(tx),
    ),
  };
  const service = new ImagePipelineService(
    prisma as unknown as PrismaService,
    storage as unknown as StorageService,
    runner as unknown as ImagePipelineRunner,
  );
  return {
    service,
    internals: service as unknown as ImageInternals,
    tx,
    storage,
    runner,
    prisma,
    asset,
    source,
    output,
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ImagePipelineService object identity and ambiguous writes", () => {
  it("reuses verified bytes without another PUT", async () => {
    const f = imageFixture();
    expect(await f.internals.ensureObject("key", f.output)).toBe(true);
    expect(f.storage.putBuffer).not.toHaveBeenCalled();
    await expect(
      f.internals.verifyReadyObject("key", f.output),
    ).resolves.toBeUndefined();
  });
  it.each(["size", "mime", "hash", "hashed-size"] as const)(
    "rejects existing %s mismatch instead of overwriting",
    async (mismatch) => {
      const f = imageFixture();
      if (mismatch === "size")
        f.storage.head.mockResolvedValue({
          size: 999,
          contentType: f.output.info.mime,
        });
      if (mismatch === "mime")
        f.storage.head.mockResolvedValue({
          size: f.output.info.sizeBytes,
          contentType: "text/plain",
        });
      if (mismatch === "hash")
        f.storage.hashObject.mockResolvedValue({
          size: f.output.info.sizeBytes,
          sha256: "wrong",
        });
      if (mismatch === "hashed-size")
        f.storage.hashObject.mockResolvedValue({
          size: 999,
          sha256: f.output.info.contentHash,
        });
      await expect(f.internals.ensureObject("key", f.output)).rejects.toThrow(
        "conflicts",
      );
      await expect(
        f.internals.verifyReadyObject("key", f.output),
      ).rejects.toThrow("identity mismatch");
      expect(f.storage.putBuffer).not.toHaveBeenCalled();
    },
  );
  it("writes new attempt bytes with lifecycle tagging and verifies the result", async () => {
    const f = imageFixture();
    f.storage.head.mockResolvedValueOnce(null);
    expect(
      await f.internals.ensureObject(
        "attempt",
        f.output,
        undefined,
        "variant-attempt",
      ),
    ).toBe(false);
    expect(f.storage.putBuffer).toHaveBeenCalledWith(
      "attempt",
      f.output.data,
      f.output.info.mime,
      undefined,
      { lifecycle: "variant-attempt" },
    );
  });
  it("recovers a lost PUT response only after authoritative bytes exist", async () => {
    const f = imageFixture();
    f.storage.head.mockResolvedValueOnce(null);
    f.storage.putBuffer.mockRejectedValue(new Error("response lost"));
    expect(await f.internals.ensureObject("key", f.output)).toBe(false);
  });
  it("propagates PUT failure when readback shows no object", async () => {
    const f = imageFixture();
    const error = new Error("write failed");
    f.storage.head.mockResolvedValue(null);
    f.storage.putBuffer.mockRejectedValue(error);
    await expect(f.internals.ensureObject("key", f.output)).rejects.toBe(error);
  });
  it.each(["missing", "size", "mime", "hash", "hashed-size"] as const)(
    "rejects new object %s verification failure",
    async (mismatch) => {
      const f = imageFixture();
      f.storage.head.mockResolvedValueOnce(null);
      if (mismatch === "missing") f.storage.head.mockResolvedValue(null);
      if (mismatch === "size")
        f.storage.head.mockResolvedValue({
          size: 999,
          contentType: f.output.info.mime,
        });
      if (mismatch === "mime")
        f.storage.head.mockResolvedValue({
          size: f.output.info.sizeBytes,
          contentType: "text/plain",
        });
      if (mismatch === "hash")
        f.storage.hashObject.mockResolvedValue({
          size: f.output.info.sizeBytes,
          sha256: "wrong",
        });
      if (mismatch === "hashed-size")
        f.storage.hashObject.mockResolvedValue({
          size: 999,
          sha256: f.output.info.contentHash,
        });
      await expect(f.internals.ensureObject("key", f.output)).rejects.toThrow(
        "verification failed",
      );
    },
  );
});

describe("ImagePipelineService ready-ledger reuse", () => {
  it("requires no persistence for an empty planned set", async () => {
    const f = imageFixture();
    expect(await f.internals.tryReuseReadySet(imageJob, [])).toBe(true);
    expect(f.prisma.withWorkspace).not.toHaveBeenCalled();
  });
  it.each([
    "asset",
    "rows",
    "recipe",
    "key",
    "role",
    "width",
    "height",
    "hash",
    "size",
  ] as const)(
    "refuses reuse when %s provenance is missing or mismatched",
    async (field) => {
      const f = imageFixture();
      const row = variantRow();
      if (field === "asset") f.tx.asset.findFirst.mockResolvedValue(null);
      if (field === "rows") f.tx.assetVariant.findMany.mockResolvedValue([]);
      if (field === "recipe") row.recipeHash = "b".repeat(64);
      if (field === "key") row.objectKey = "wrong";
      if (field === "role") row.variantType = "hero";
      if (field === "width") row.width += 1;
      if (field === "height") row.height += 1;
      if (field === "hash") row.contentHash = null;
      if (field === "size") row.sizeBytes = null;
      if (field !== "rows") f.tx.assetVariant.findMany.mockResolvedValue([row]);
      expect(await f.internals.tryReuseReadySet(imageJob, [imagePlan])).toBe(
        false,
      );
      expect(f.tx.asset.update).not.toHaveBeenCalled();
    },
  );
  it.each(["missing", "size", "mime", "hash", "hashed-size"] as const)(
    "refuses storage %s drift before publishing a manifest",
    async (field) => {
      const f = imageFixture();
      if (field === "missing") f.storage.head.mockResolvedValue(null);
      if (field === "size")
        f.storage.head.mockResolvedValue({
          size: 999,
          contentType: f.output.info.mime,
        });
      if (field === "mime")
        f.storage.head.mockResolvedValue({
          size: f.output.info.sizeBytes,
          contentType: "text/plain",
        });
      if (field === "hash")
        f.storage.hashObject.mockResolvedValue({
          size: f.output.info.sizeBytes,
          sha256: "wrong",
        });
      if (field === "hashed-size")
        f.storage.hashObject.mockResolvedValue({
          size: 999,
          sha256: f.output.info.contentHash,
        });
      expect(await f.internals.tryReuseReadySet(imageJob, [imagePlan])).toBe(
        false,
      );
      expect(f.tx.asset.update).not.toHaveBeenCalled();
    },
  );
  it.each(["lock", "count", "recipe", "id", "hash", "size", "key"] as const)(
    "refuses reuse if %s changes between readback and the final lock",
    async (field) => {
      const f = imageFixture();
      const fresh = variantRow();
      if (field === "lock") f.tx.$queryRaw.mockResolvedValue([]);
      if (field === "recipe") fresh.recipeHash = "b".repeat(64);
      if (field === "id") fresh.id = "replacement";
      if (field === "hash") fresh.contentHash = "changed";
      if (field === "size") fresh.sizeBytes = 999;
      if (field === "key") fresh.objectKey = "changed";
      f.tx.assetVariant.findMany
        .mockResolvedValueOnce([variantRow()])
        .mockResolvedValueOnce(field === "count" ? [] : [fresh]);
      expect(await f.internals.tryReuseReadySet(imageJob, [imagePlan])).toBe(
        false,
      );
      expect(f.tx.asset.update).not.toHaveBeenCalled();
    },
  );
  it("publishes a derived manifest only after storage and locked ledger agree", async () => {
    const f = imageFixture();
    expect(await f.internals.tryReuseReadySet(imageJob, [imagePlan])).toBe(
      true,
    );
    expect(f.tx.asset.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: imageJob.assetId } }),
    );
    expect(f.storage.putBuffer).not.toHaveBeenCalled();
  });
});

function processingRow() {
  return {
    ...variantRow(),
    status: "processing",
    metadata: {
      reservation: {
        token: producer,
        attemptKey: attemptKey(),
        leaseUntil: new Date(Date.now() - 1_000).toISOString(),
        attempt: 1,
      },
      attemptKeys: [attemptKey()],
    } as Record<string, unknown>,
  };
}
describe("ImagePipelineService reservation ownership", () => {
  it("creates a new fenced reservation with bounded attempt metadata", async () => {
    const f = imageFixture();
    f.tx.assetVariant.findMany.mockResolvedValue([]);
    expect(
      await f.internals.reserveVariantSet(
        { ...imageJob, sourceMeta: { hasPerson: false } },
        inspection,
        [imagePlan],
        producer,
      ),
    ).toBe(true);
    expect(f.tx.assetVariant.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "processing",
        objectKey: variantKey(),
        metadata: expect.objectContaining({
          hasPerson: false,
          reservation: expect.objectContaining({
            token: producer,
            attempt: 1,
            attemptKey: attemptKey(),
          }),
        }),
      }),
    });
  });
  it("rejects reservation after source identity changes under the asset lock", async () => {
    const f = imageFixture();
    f.tx.$queryRaw.mockResolvedValue([]);
    await expect(
      f.internals.reserveVariantSet(
        imageJob,
        inspection,
        [imagePlan],
        producer,
      ),
    ).rejects.toThrow("asset changed");
    expect(f.tx.assetVariant.create).not.toHaveBeenCalled();
  });
  it("rejects variant budget overflow before creating another object", async () => {
    const f = imageFixture();
    f.tx.assetVariant.findMany.mockResolvedValue(
      Array.from({ length: 120 }, (_, i) => ({
        ...variantRow(),
        recipeHash: `old-${i}`,
      })),
    );
    await expect(
      f.internals.reserveVariantSet(
        imageJob,
        inspection,
        [imagePlan],
        producer,
      ),
    ).rejects.toThrow("variant budget exceeded");
  });
  it.each([
    { token: undefined, leaseUntil: "bad" },
    { token: "other", leaseUntil: "bad" },
    { token: "other" },
  ])("rejects malformed foreign processing leases", async (reservation) => {
    const f = imageFixture();
    f.tx.assetVariant.findMany.mockResolvedValue([
      { ...processingRow(), metadata: { reservation } },
    ]);
    await expect(
      f.internals.reserveVariantSet(
        imageJob,
        inspection,
        [imagePlan],
        producer,
      ),
    ).rejects.toThrow("invalid processing lease");
  });
  it("waits for a live competing producer before any mutation", async () => {
    const f = imageFixture();
    f.tx.assetVariant.findMany.mockResolvedValue([
      {
        ...processingRow(),
        metadata: {
          reservation: {
            token: "other",
            leaseUntil: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      },
    ]);
    expect(
      await f.internals.reserveVariantSet(
        imageJob,
        inspection,
        [imagePlan],
        producer,
      ),
    ).toBe(false);
    expect(f.tx.assetVariant.update).not.toHaveBeenCalled();
    expect(f.tx.assetVariant.create).not.toHaveBeenCalled();
  });
  it.each([1, "unknown"])(
    "takes over an expired lease preserving attempt-key recovery with previous attempt %s",
    async (attempt) => {
      const f = imageFixture();
      f.tx.assetVariant.findMany.mockResolvedValue([
        {
          ...processingRow(),
          metadata: {
            reservation: {
              token: "old",
              leaseUntil: new Date(0).toISOString(),
              attempt,
            },
          },
        },
      ]);
      expect(
        await f.internals.reserveVariantSet(
          imageJob,
          inspection,
          [imagePlan],
          producer,
        ),
      ).toBe(true);
      expect(
        f.tx.assetVariant.update.mock.calls[0][0].data.metadata.reservation,
      ).toMatchObject({ token: producer, attempt: attempt === 1 ? 2 : 1 });
    },
  );
  it.each(["key", "version", "role", "mime", "width", "height"] as const)(
    "rejects existing %s provenance instead of repurposing a ready row",
    async (field) => {
      const f = imageFixture();
      const row = variantRow();
      if (field === "key") row.objectKey = "wrong";
      if (field === "version")
        row.pipelineVersion = "old" as typeof IMAGE_PIPELINE_VERSION;
      if (field === "role") row.variantType = "hero";
      if (field === "mime") row.mime = "image/png";
      if (field === "width") row.width++;
      if (field === "height") row.height++;
      f.tx.assetVariant.findMany.mockResolvedValue([row]);
      await expect(
        f.internals.reserveVariantSet(
          imageJob,
          inspection,
          [imagePlan],
          producer,
        ),
      ).rejects.toThrow("provenance conflicts");
    },
  );
  it("does not reserve ready rows again", async () => {
    const f = imageFixture();
    expect(
      await f.internals.reserveVariantSet(
        imageJob,
        inspection,
        [imagePlan],
        producer,
      ),
    ).toBe(true);
    expect(f.tx.assetVariant.update).not.toHaveBeenCalled();
    expect(f.tx.assetVariant.create).not.toHaveBeenCalled();
  });
  it("rejects unbounded unreconciled attempt keys", async () => {
    const f = imageFixture();
    f.tx.assetVariant.findMany.mockResolvedValue([
      {
        ...processingRow(),
        status: "failed",
        metadata: {
          attemptKeys: Array.from({ length: 8 }, (_, i) => `old-${i}`),
        },
      },
    ]);
    await expect(
      f.internals.reserveVariantSet(
        imageJob,
        inspection,
        [imagePlan],
        producer,
      ),
    ).rejects.toThrow("attempt-key budget exceeded");
  });
  it("rejects aggregate cleanup-object overflow even below the variant budget", async () => {
    const f = imageFixture();
    f.tx.assetVariant.findMany.mockResolvedValue([
      {
        ...processingRow(),
        status: "failed",
        metadata: {
          attemptKeys: Array.from({ length: 127 }, (_, i) => `old-${i}`),
        },
      },
    ]);
    await expect(
      f.internals.reserveVariantSet(
        imageJob,
        inspection,
        [imagePlan],
        producer,
      ),
    ).rejects.toThrow("cleanup object budget exceeded");
  });
  it.each(["lock", "count", "fenced", "cas"])(
    "fails lease renewal closed on %s loss",
    async (failure) => {
      const f = imageFixture();
      f.tx.assetVariant.findMany.mockResolvedValue([processingRow()]);
      if (failure === "lock") f.tx.$queryRaw.mockResolvedValue([]);
      if (failure === "count") f.tx.assetVariant.findMany.mockResolvedValue([]);
      if (failure === "fenced")
        f.tx.assetVariant.findMany.mockResolvedValue([
          { ...processingRow(), metadata: { reservation: { token: "other" } } },
        ]);
      if (failure === "cas")
        f.tx.assetVariant.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        f.internals.renewReservation(
          imageJob,
          [imagePlan],
          imagePlan.recipeHash,
          producer,
        ),
      ).rejects.toThrow();
    },
  );
  it("renews only the owned processing row and skips already-ready rows", async () => {
    const f = imageFixture();
    f.tx.assetVariant.findMany.mockResolvedValue([processingRow()]);
    expect(
      await f.internals.renewReservation(
        imageJob,
        [imagePlan],
        imagePlan.recipeHash,
        producer,
      ),
    ).toBe(true);
    expect(f.tx.assetVariant.updateMany.mock.calls[0][0].where).toMatchObject({
      status: "processing",
      metadata: { path: ["reservation", "token"], equals: producer },
    });
    f.tx.assetVariant.findMany.mockResolvedValue([variantRow()]);
    expect(
      await f.internals.renewReservation(
        imageJob,
        [imagePlan],
        imagePlan.recipeHash,
        producer,
      ),
    ).toBe(false);
  });
  it("failure compensation cannot fail a competing producer reservation", async () => {
    const f = imageFixture();
    f.tx.assetVariant.findMany.mockResolvedValue([
      processingRow(),
      {
        ...processingRow(),
        id: "other",
        metadata: { reservation: { token: "other" } },
      },
    ]);
    await f.internals.failReservation(
      imageJob,
      [imagePlan],
      producer,
      "synthetic failure",
    );
    expect(f.tx.assetVariant.updateMany).toHaveBeenCalledTimes(1);
    expect(f.tx.assetVariant.updateMany.mock.calls[0][0].where).toMatchObject({
      id: "row-1",
      metadata: { path: ["reservation", "token"], equals: producer },
    });
  });
});

describe("ImagePipelineService promotion and finalization", () => {
  it.each([
    "lock",
    "missing",
    "ready-hash",
    "ready-size",
    "status",
    "token",
    "attempt",
    "cas",
  ] as const)("rejects promotion on %s loss", async (failure) => {
    const f = imageFixture();
    const row = processingRow();
    if (failure === "lock") f.tx.$queryRaw.mockResolvedValue([]);
    if (failure === "ready-hash") {
      row.status = "ready";
      row.contentHash = "wrong";
    }
    if (failure === "ready-size") {
      row.status = "ready";
      row.sizeBytes = 999;
    }
    if (failure === "status") row.status = "failed";
    if (failure === "token")
      row.metadata = {
        reservation: { token: "other", attemptKey: attemptKey() },
      };
    if (failure === "attempt")
      row.metadata = { reservation: { token: producer, attemptKey: "other" } };
    f.tx.assetVariant.findFirst.mockResolvedValue(
      failure === "missing" ? null : row,
    );
    if (failure === "cas")
      f.tx.assetVariant.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      f.internals.promoteAttempt(
        imageJob,
        inspection,
        imagePlan,
        f.output,
        producer,
        attemptKey(),
        variantKey(),
      ),
    ).rejects.toThrow();
    if (failure !== "cas")
      expect(f.tx.assetVariant.updateMany).not.toHaveBeenCalled();
  });
  it("accepts an already-ready identical row without copying again", async () => {
    const f = imageFixture();
    await f.internals.promoteAttempt(
      imageJob,
      inspection,
      imagePlan,
      f.output,
      producer,
      attemptKey(),
      variantKey(),
    );
    expect(f.storage.copy).not.toHaveBeenCalled();
    expect(f.tx.assetVariant.updateMany).not.toHaveBeenCalled();
  });
  it.each(["existing", "copy", "lost-response"] as const)(
    "promotes verified %s bytes with reservation-token CAS",
    async (mode) => {
      const f = imageFixture();
      f.tx.assetVariant.findFirst.mockResolvedValue(processingRow());
      if (mode !== "existing") f.storage.head.mockResolvedValueOnce(null);
      if (mode === "lost-response")
        f.storage.copy.mockRejectedValue(new Error("response lost"));
      await f.internals.promoteAttempt(
        imageJob,
        inspection,
        imagePlan,
        f.output,
        producer,
        attemptKey(),
        variantKey(),
      );
      expect(f.tx.assetVariant.updateMany).toHaveBeenCalledWith({
        where: {
          id: "row-1",
          status: "processing",
          metadata: { path: ["reservation", "token"], equals: producer },
        },
        data: expect.objectContaining({
          status: "ready",
          contentHash: f.output.info.contentHash,
          metadata: expect.objectContaining({ attemptKeys: [attemptKey()] }),
        }),
      });
    },
  );
  it("propagates a failed copy if canonical readback is absent", async () => {
    const f = imageFixture();
    f.tx.assetVariant.findFirst.mockResolvedValue(processingRow());
    f.storage.head.mockResolvedValue(null);
    const failure = new Error("copy failed");
    f.storage.copy.mockRejectedValue(failure);
    await expect(
      f.internals.promoteAttempt(
        imageJob,
        inspection,
        imagePlan,
        f.output,
        producer,
        attemptKey(),
        variantKey(),
      ),
    ).rejects.toBe(failure);
  });
  it.each(["missing", "size", "mime", "hash", "hashed-size"] as const)(
    "refuses marking ready after promotion %s mismatch",
    async (field) => {
      const f = imageFixture();
      f.tx.assetVariant.findFirst.mockResolvedValue(processingRow());
      if (field === "missing") f.storage.head.mockResolvedValue(null);
      if (field === "size")
        f.storage.head.mockResolvedValue({
          size: 999,
          contentType: f.output.info.mime,
        });
      if (field === "mime")
        f.storage.head.mockResolvedValue({
          size: f.output.info.sizeBytes,
          contentType: "text/plain",
        });
      if (field === "hash")
        f.storage.hashObject.mockResolvedValue({
          size: f.output.info.sizeBytes,
          sha256: "wrong",
        });
      if (field === "hashed-size")
        f.storage.hashObject.mockResolvedValue({
          size: 999,
          sha256: f.output.info.contentHash,
        });
      await expect(
        f.internals.promoteAttempt(
          imageJob,
          inspection,
          imagePlan,
          f.output,
          producer,
          attemptKey(),
          variantKey(),
        ),
      ).rejects.toThrow("verification failed");
      expect(f.tx.assetVariant.updateMany).not.toHaveBeenCalled();
    },
  );
  it.each(["lock", "row", "key"])(
    "does not prune attempt metadata when %s ownership is absent",
    async (missing) => {
      const f = imageFixture();
      if (missing === "lock") f.tx.$queryRaw.mockResolvedValue([]);
      if (missing === "row")
        f.tx.assetVariant.findFirst.mockResolvedValue(null);
      await f.internals.clearAttemptKey(
        imageJob,
        imagePlan.recipeHash,
        attemptKey(),
      );
      expect(f.tx.assetVariant.updateMany).not.toHaveBeenCalled();
    },
  );
  it.each([false, true])(
    "prunes only the absent attempt key, keepSibling=%s",
    async (keepSibling) => {
      const f = imageFixture();
      f.tx.assetVariant.findFirst.mockResolvedValue({
        ...variantRow(),
        metadata: {
          marker: "keep",
          attemptKeys: [attemptKey(), ...(keepSibling ? ["sibling"] : [])],
        },
      });
      await f.internals.clearAttemptKey(
        imageJob,
        imagePlan.recipeHash,
        attemptKey(),
      );
      expect(
        f.tx.assetVariant.updateMany.mock.calls[0][0].data.metadata,
      ).toEqual({
        marker: "keep",
        ...(keepSibling ? { attemptKeys: ["sibling"] } : {}),
      });
    },
  );
  it("finalizes reused canonical variants without touching attempt storage", async () => {
    const f = imageFixture();
    expect(
      await f.internals.materializeAndFinalize(
        imageJob,
        inspection,
        [imagePlan],
        new Map([[imagePlan.recipeHash, f.output]]),
        producer,
      ),
    ).toEqual({ reused: 1 });
    expect(f.storage.putBuffer).not.toHaveBeenCalled();
    expect(f.tx.asset.update).toHaveBeenCalledOnce();
  });
  it.each(["deleted", "remains", "delete-failure"] as const)(
    "finalizes new bytes and preserves cleanup ownership when attempt %s",
    async (state) => {
      const f = imageFixture();
      vi.spyOn(f.internals, "renewReservation").mockResolvedValue(true);
      vi.spyOn(f.internals, "ensureObject").mockResolvedValue(false);
      vi.spyOn(f.internals, "promoteAttempt").mockResolvedValue(undefined);
      const clear = vi
        .spyOn(f.internals, "clearAttemptKey")
        .mockResolvedValue(undefined);
      if (state === "deleted") f.storage.head.mockResolvedValue(null);
      if (state === "delete-failure")
        f.storage.delete.mockRejectedValue(
          new Error("synthetic delete failure"),
        );
      expect(
        await f.internals.materializeAndFinalize(
          imageJob,
          inspection,
          [imagePlan],
          new Map([[imagePlan.recipeHash, f.output]]),
          producer,
        ),
      ).toEqual({ reused: 0 });
      expect(clear).toHaveBeenCalledTimes(state === "deleted" ? 1 : 0);
      expect(f.tx.asset.update).toHaveBeenCalledOnce();
    },
  );
  it.each([
    "lock",
    "count",
    "recipe",
    "key",
    "version",
    "hash",
    "size",
    "status",
    "final-count",
  ] as const)(
    "never publishes a manifest after final %s drift",
    async (field) => {
      const f = imageFixture();
      vi.spyOn(f.internals, "renewReservation").mockResolvedValue(false);
      const row = variantRow();
      if (field === "lock") f.tx.$queryRaw.mockResolvedValue([]);
      if (field === "recipe") row.recipeHash = "b".repeat(64);
      if (field === "key") row.objectKey = "wrong";
      if (field === "version")
        row.pipelineVersion = "old" as typeof IMAGE_PIPELINE_VERSION;
      if (field === "hash") row.contentHash = "wrong";
      if (field === "size") row.sizeBytes = 999;
      if (field === "status") row.status = "processing";
      f.tx.assetVariant.findMany
        .mockResolvedValueOnce(field === "count" ? [] : [row])
        .mockResolvedValueOnce(field === "final-count" ? [] : [row]);
      await expect(
        f.internals.materializeAndFinalize(
          imageJob,
          inspection,
          [imagePlan],
          new Map([[imagePlan.recipeHash, f.output]]),
          producer,
        ),
      ).rejects.toThrow();
      expect(f.tx.asset.update).not.toHaveBeenCalled();
    },
  );
});

describe("ImagePipelineService source and renderer gates", () => {
  it.each([
    "absent",
    "hash-absent",
    "kind",
    "mime",
    "empty",
    "oversize",
    "length",
    "hash",
  ] as const)("rejects source %s failure before rendering", async (failure) => {
    const f = imageFixture();
    const asset = { ...f.asset };
    if (failure === "hash-absent") asset.contentHash = "";
    if (failure === "kind") asset.kind = "doc";
    if (failure === "mime") asset.mime = "application/pdf";
    if (failure === "empty") asset.sizeBytes = 0;
    if (failure === "oversize") asset.sizeBytes = 20 * 1024 * 1024 + 1;
    if (failure === "length") asset.sizeBytes += 1;
    if (failure === "hash") asset.contentHash = "wrong";
    f.tx.asset.findFirst.mockResolvedValue(failure === "absent" ? null : asset);
    await expect(f.service.processAsset(imageJob)).rejects.toThrow();
    expect(f.runner.render).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { x: 0.5, y: 0.5 },
    { x: -1, y: 0.5 },
    { x: 2, y: 0.5 },
    { x: 0.5, y: -1 },
    { x: 0.5, y: 2 },
    { x: 0.5 },
  ])(
    "returns a verified reusable set with bounded focal-point metadata %j",
    async (focalPoint) => {
      const f = imageFixture();
      f.asset.meta = { focalPoint } as typeof f.asset.meta;
      vi.spyOn(f.internals, "tryReuseReadySet").mockResolvedValue(true);
      const result = await f.service.processAsset(imageJob);
      expect(result.status).toBe("done");
      expect(result.reused).toBe(result.variants);
      expect(f.runner.render).not.toHaveBeenCalled();
    },
  );
  it("persists rendered variants through the producer path after reservation", async () => {
    const f = imageFixture();
    vi.spyOn(f.internals, "tryReuseReadySet").mockResolvedValue(false);
    vi.spyOn(f.internals, "reconcileAttemptKeys").mockResolvedValue(undefined);
    vi.spyOn(f.internals, "reserveVariantSet").mockResolvedValue(true);
    f.runner.render.mockImplementation(
      async (_source, plans: PlannedImageVariant[]) =>
        new Map(plans.map((plan) => [plan.recipeHash, renderedVariant(plan)])),
    );
    const finalize = vi
      .spyOn(f.internals, "materializeAndFinalize")
      .mockResolvedValue({ reused: 0 });
    expect(await f.service.processAsset(imageJob)).toMatchObject({
      status: "done",
      reused: 0,
    });
    expect(finalize).toHaveBeenCalledOnce();
  });
  it("marks only its reservation failed when rendering rejects", async () => {
    const f = imageFixture();
    const failure = new Error("decoder failure");
    vi.spyOn(f.internals, "tryReuseReadySet").mockResolvedValue(false);
    vi.spyOn(f.internals, "reconcileAttemptKeys").mockResolvedValue(undefined);
    vi.spyOn(f.internals, "reserveVariantSet").mockResolvedValue(true);
    const fail = vi
      .spyOn(f.internals, "failReservation")
      .mockResolvedValue(undefined);
    f.runner.render.mockRejectedValue(failure);
    await expect(f.service.processAsset(imageJob)).rejects.toBe(failure);
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: imageJob.assetId }),
      expect.any(Array),
      expect.any(String),
      "decoder failure",
    );
  });
  it.each([
    "count",
    "recipe",
    "missing",
    "hash",
    "bytes",
    "width",
    "height",
  ] as const)("rejects a renderer %s violation", (field) => {
    const f = imageFixture();
    const output = renderedVariant();
    const plan = { ...imagePlan };
    if (field === "recipe") plan.recipeHash = "b".repeat(64);
    if (field === "hash") output.info.contentHash = "wrong";
    if (field === "bytes") output.info.sizeBytes++;
    if (field === "width") output.info.width++;
    if (field === "height") output.info.height++;
    const results =
      field === "count"
        ? new Map<string, RenderedImageVariant>()
        : new Map([[field === "missing" ? "other" : plan.recipeHash, output]]);
    expect(() => f.internals.validateRendered([plan], results)).toThrow();
  });
  it("returns an empty summary without running the renderer on an empty site", async () => {
    expect(
      await serviceWithAssets([]).processSiteImages({
        workspaceId: "ws",
        siteId: "site",
      }),
    ).toMatchObject({ status: "done", processed: 0, nextCursor: null });
  });
  it("processes an explicit frozen workset without discovering extra assets", async () => {
    const f = imageFixture();
    vi.spyOn(f.service, "processAsset").mockResolvedValue({
      assetId: "a",
      status: "done",
      variants: 1,
      reused: 0,
      qualityWarnings: [],
    });
    expect(
      await f.service.processSiteImages({ ...imageJob, assetIds: ["a"] }),
    ).toMatchObject({ processed: 1, nextCursor: null });
    expect(f.prisma.withWorkspace).not.toHaveBeenCalled();
  });
  it("preserves a non-Error cancellation reason as the stable abort error", async () => {
    const f = imageFixture();
    const abort = new AbortController();
    abort.abort("cancelled");
    await expect(
      f.service.processSiteImages(
        { ...imageJob, assetIds: ["a"] },
        abort.signal,
      ),
    ).rejects.toThrow("image pipeline aborted");
    await expect(
      f.internals.ensureObject("key", f.output, abort.signal),
    ).rejects.toThrow("image pipeline aborted");
  });
});
