import { describe, expect, it, vi } from 'vitest';
import { assetCleanupPayload, parseAssetCleanupCommand } from './asset-cleanup.contract';
import { createAssetCleanupActivities } from './asset-cleanup.activities';

const EVENT = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const SITE = '33333333-3333-4333-8333-333333333333';
const ASSET = '44444444-4444-4444-8444-444444444444';
const PARENT = '55555555-5555-4555-8555-555555555555';
const CHILD = '66666666-6666-4666-8666-666666666666';
const SOURCE_HASH = 'a'.repeat(64);
const PARENT_RECIPE = 'b'.repeat(64);
const CHILD_RECIPE = 'c'.repeat(64);

function command() {
  return parseAssetCleanupCommand({
    eventId: EVENT,
    workspaceId: WS,
    siteId: SITE,
    assetId: ASSET,
    objectClass: 'canonical',
    reason: 'asset_deleted',
    canonical: {
      objectKey: `ws/${WS}/${SITE}/product_image/${SOURCE_HASH}.jpg`,
      contentHash: SOURCE_HASH,
    },
    variants: [
      {
        id: PARENT,
        objectKey: `ws/${WS}/${SITE}/variants/${ASSET}/${PARENT_RECIPE}.webp`,
        contentHash: 'd'.repeat(64),
        recipeHash: PARENT_RECIPE,
        sourceVariantId: null,
        status: 'ready',
      },
      {
        id: CHILD,
        objectKey: `ws/${WS}/${SITE}/variants/${ASSET}/${CHILD_RECIPE}.avif`,
        contentHash: 'e'.repeat(64),
        recipeHash: CHILD_RECIPE,
        sourceVariantId: PARENT,
        status: 'ready',
      },
    ],
  });
}

describe('MF0-B canonical cleanup activity', () => {
  it('deletes leaf-to-root then canonical, settles rows, and makes old-event replay a no-op', async () => {
    const cmd = command();
    if (cmd.objectClass !== 'canonical') throw new Error('test command mismatch');
    const variants = cmd.variants.map((variant) => ({ ...variant }));
    const asset = {
      id: ASSET,
      siteId: SITE,
      objectKey: cmd.canonical.objectKey,
      contentHash: cmd.canonical.contentHash,
      processingStatus: 'deleted',
      deletedAt: new Date(),
      cleanupEventId: EVENT,
      cleanupCompletedAt: null as Date | null,
    };
    const tx = {
      outboxEvent: {
        findUnique: vi.fn(async () => ({
          eventId: EVENT,
          workspaceId: WS,
          eventType: 'AssetObjectCleanupRequested',
          schemaVersion: 2,
          aggregateType: 'Asset',
          aggregateId: ASSET,
          payload: assetCleanupPayload(cmd),
        })),
      },
      asset: {
        findUnique: vi.fn(async () => asset),
        findFirst: vi.fn(async () => null),
        updateMany: vi.fn(async () => {
          asset.cleanupCompletedAt = new Date();
          return { count: 1 };
        }),
      },
      assetVariant: {
        findMany: vi.fn(async () => variants),
        findFirst: vi.fn(async () => null),
        deleteMany: vi.fn(async ({ where }: { where: { id: string } }) => {
          const index = variants.findIndex((variant) => variant.id === where.id);
          if (index < 0) return { count: 0 };
          variants.splice(index, 1);
          return { count: 1 };
        }),
      },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId: string, fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    const objects = new Set([cmd.canonical.objectKey, ...cmd.variants.map((variant) => variant.objectKey)]);
    const deletes: string[] = [];
    const storage = {
      delete: vi.fn(async (key: string) => {
        deletes.push(key);
        objects.delete(key);
      }),
      head: vi.fn(async (key: string) => (objects.has(key) ? { size: 1 } : null)),
    };
    const activities = createAssetCleanupActivities({
      prisma: prisma as never,
      storage: storage as never,
    });

    await activities.cleanupCanonicalAssetObjects(cmd);
    expect(deletes).toEqual([cmd.variants[1].objectKey, cmd.variants[0].objectKey, cmd.canonical.objectKey]);
    await expect(activities.settleCanonicalAssetCleanup(cmd)).resolves.toMatchObject({
      settled: true,
      variantsDeleted: 2,
    });
    expect(variants).toEqual([]);
    expect(asset.cleanupCompletedAt).toBeInstanceOf(Date);

    deletes.length = 0;
    await expect(activities.cleanupCanonicalAssetObjects(cmd)).resolves.toMatchObject({
      alreadySettled: true,
    });
    expect(deletes).toEqual([]);

    // Simulate a lost first settle response followed by legitimate same-hash reuse. A retry must
    // observe durable settlement before HEAD and must not reject or touch the replacement object.
    objects.add(cmd.canonical.objectKey);
    storage.head.mockClear();
    await expect(activities.settleCanonicalAssetCleanup(cmd)).resolves.toMatchObject({
      settled: true,
      variantsDeleted: 0,
    });
    expect(storage.head).not.toHaveBeenCalled();
    expect(objects.has(cmd.canonical.objectKey)).toBe(true);
  });
});
