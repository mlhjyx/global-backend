import { describe, expect, it, vi } from 'vitest';
import {
  AssetCleanupCommand,
  createAssetCleanupActivities,
} from './asset-cleanup.activities';

const WS = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const ASSET = '33333333-3333-4333-8333-333333333333';
const EVENT = '44444444-4444-4444-8444-444444444444';
const KEY = `ws/${WS}/${SITE}/uploads/${ASSET}`;

function command(overrides: Partial<AssetCleanupCommand> = {}): AssetCleanupCommand {
  return {
    eventId: EVENT,
    workspaceId: WS,
    siteId: SITE,
    assetId: ASSET,
    objectKey: KEY,
    objectClass: 'staging',
    reason: 'commit_succeeded',
    notBefore: '2026-07-17T08:15:00.000Z',
    ...overrides,
  };
}

function harness(
  asset: Record<string, unknown> | null,
  event: Record<string, unknown> | null = {
    eventId: EVENT,
    workspaceId: WS,
    eventType: 'AssetObjectCleanupRequested',
    schemaVersion: 1,
    aggregateType: 'Asset',
    aggregateId: ASSET,
    payload: {
      assetId: ASSET,
      siteId: SITE,
      objectKey: KEY,
      objectClass: 'staging',
      reason: 'commit_succeeded',
      notBefore: '2026-07-17T08:15:00.000Z',
    },
  },
) {
  const tx = {
    asset: {
      findUnique: vi.fn(async () => asset),
      findFirst: vi.fn(async () => null),
    },
    outboxEvent: { findUnique: vi.fn(async () => event) },
  };
  const prisma = {
    withWorkspace: vi.fn(async (_workspaceId: string, fn: (client: typeof tx) => unknown) =>
      fn(tx),
    ),
  };
  const storage = {
    delete: vi.fn(async () => undefined),
    head: vi.fn(async () => null),
  };
  return {
    tx,
    prisma,
    storage,
    activities: createAssetCleanupActivities({ prisma: prisma as never, storage: storage as never }),
  };
}

describe('asset cleanup activity', () => {
  it('deletes a committed staging object and is idempotent when repeated', async () => {
    const h = harness({
      id: ASSET,
      siteId: SITE,
      objectKey: `ws/${WS}/${SITE}/doc/${'a'.repeat(64)}.pdf`,
      processingStatus: 'ready',
      contentHash: 'a'.repeat(64),
      deletedAt: null,
    });

    await expect(h.activities.cleanupStagingAssetObject(command())).resolves.toEqual({
      eventId: EVENT,
      objectKey: KEY,
      deleted: true,
    });
    await expect(h.activities.cleanupStagingAssetObject(command())).resolves.toEqual({
      eventId: EVENT,
      objectKey: KEY,
      deleted: true,
    });

    expect(h.prisma.withWorkspace).toHaveBeenCalledWith(WS, expect.any(Function));
    expect(h.storage.delete).toHaveBeenCalledTimes(2);
    expect(h.storage.delete).toHaveBeenNthCalledWith(1, KEY, expect.any(AbortSignal));
    expect(h.storage.head).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['canonical object class', { objectClass: 'canonical' }],
    ['foreign workspace in key', { objectKey: `ws/${SITE}/${WS}/uploads/${ASSET}` }],
    ['wrong asset in key', { objectKey: `ws/${WS}/${SITE}/uploads/${EVENT}` }],
    ['non-UUID asset', { assetId: '../escape' }],
    ['invalid notBefore', { notBefore: 'tomorrow' }],
  ])('rejects %s before storage I/O', async (_name, overrides) => {
    const h = harness(null);

    await expect(
      h.activities.cleanupStagingAssetObject(command(overrides as Partial<AssetCleanupCommand>)),
    ).rejects.toMatchObject({ nonRetryable: true });
    expect(h.storage.delete).not.toHaveBeenCalled();
  });

  it('fails closed when the Asset provenance does not exist in app_user workspace scope', async () => {
    const h = harness(null);

    await expect(h.activities.cleanupStagingAssetObject(command())).rejects.toMatchObject({
      nonRetryable: true,
      type: 'ASSET_CLEANUP_PROVENANCE_INVALID',
    });
    expect(h.storage.delete).not.toHaveBeenCalled();
  });

  it('fails closed when the durable Outbox provenance is missing or differs from the workflow input', async () => {
    const asset = {
      id: ASSET,
      siteId: SITE,
      objectKey: `ws/${WS}/${SITE}/doc/${'a'.repeat(64)}.pdf`,
      processingStatus: 'ready',
      contentHash: 'a'.repeat(64),
      deletedAt: null,
    };
    const missing = harness(asset, null);
    await expect(missing.activities.cleanupStagingAssetObject(command())).rejects.toMatchObject({
      nonRetryable: true,
      type: 'ASSET_CLEANUP_PROVENANCE_INVALID',
    });
    expect(missing.storage.delete).not.toHaveBeenCalled();

    const forged = harness(asset, {
      eventId: EVENT,
      workspaceId: WS,
      eventType: 'AssetObjectCleanupRequested',
      schemaVersion: 1,
      aggregateType: 'Asset',
      aggregateId: ASSET,
      payload: { ...command(), eventId: undefined, workspaceId: undefined, objectKey: `${KEY}-other` },
    });
    await expect(forged.activities.cleanupStagingAssetObject(command())).rejects.toMatchObject({
      nonRetryable: true,
      type: 'ASSET_CLEANUP_PROVENANCE_INVALID',
    });
    expect(forged.storage.delete).not.toHaveBeenCalled();
  });

  it('fails closed while the staging key is still owned by an active upload', async () => {
    const h = harness({
      id: ASSET,
      siteId: SITE,
      objectKey: KEY,
      processingStatus: 'committing',
      deletedAt: null,
    });

    await expect(h.activities.cleanupStagingAssetObject(command())).rejects.toMatchObject({
      nonRetryable: true,
      type: 'ASSET_CLEANUP_PROVENANCE_INVALID',
    });
    expect(h.storage.delete).not.toHaveBeenCalled();
  });

  it('allows terminal staging provenance only when reason and state agree', async () => {
    const h = harness({
      id: ASSET,
      siteId: SITE,
      objectKey: KEY,
      processingStatus: 'duplicate',
      deletedAt: null,
    });

    const duplicateEvent = {
      eventId: EVENT,
      workspaceId: WS,
      eventType: 'AssetObjectCleanupRequested',
      schemaVersion: 1,
      aggregateType: 'Asset',
      aggregateId: ASSET,
      payload: {
        assetId: ASSET,
        siteId: SITE,
        objectKey: KEY,
        objectClass: 'staging',
        reason: 'duplicate',
        notBefore: '2026-07-17T08:15:00.000Z',
      },
    };
    const duplicate = harness(
      {
        id: ASSET,
        siteId: SITE,
        objectKey: KEY,
        processingStatus: 'duplicate',
        deletedAt: null,
      },
      duplicateEvent,
    );
    await expect(
      duplicate.activities.cleanupStagingAssetObject(command({ reason: 'duplicate' })),
    ).resolves.toMatchObject({ deleted: true });
    await expect(
      h.activities.cleanupStagingAssetObject(command({ reason: 'rejected' })),
    ).rejects.toMatchObject({ nonRetryable: true });
  });

  it('retries when delete returns but the object is still present', async () => {
    const h = harness({
      id: ASSET,
      siteId: SITE,
      objectKey: `ws/${WS}/${SITE}/doc/${'a'.repeat(64)}.pdf`,
      processingStatus: 'ready',
      contentHash: 'a'.repeat(64),
      deletedAt: null,
    });
    h.storage.head.mockResolvedValue({ size: 1 });

    await expect(h.activities.cleanupStagingAssetObject(command())).rejects.toThrow(
      'staging object still exists after delete',
    );
  });
});
