import { describe, expect, it, vi } from 'vitest';
import { reconcileParkedCanonicalCleanups } from './asset-cleanup.reconcile';

const WS = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const ASSET = '33333333-3333-4333-8333-333333333333';
const LEGACY_EVENT = '44444444-4444-4444-8444-444444444444';
const HASH = 'a'.repeat(64);
const KEY = `ws/${WS}/${SITE}/product_image/${HASH}.jpg`;

function harness(usages: unknown[] = []) {
  const successors: Record<string, unknown>[] = [];
  const asset = {
    id: ASSET,
    workspaceId: WS,
    siteId: SITE,
    objectKey: KEY,
    contentHash: HASH,
    processingStatus: 'deleted',
    deletedAt: new Date(),
    cleanupEventId: null as string | null,
    cleanupCompletedAt: null,
  };
  const legacy = {
    id: 1n,
    eventId: LEGACY_EVENT,
    workspaceId: WS,
    aggregateId: ASSET,
    payload: {
      assetId: ASSET,
      siteId: SITE,
      objectKey: KEY,
      objectClass: 'canonical',
      reason: 'asset_deleted',
      blockedUntil: 'site_spec_asset_reference_scanner',
    },
  };
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: ASSET }]),
    asset: {
      findUnique: vi.fn(async () => asset),
      updateMany: vi.fn(async ({ data }: { data: { cleanupEventId: string } }) => {
        asset.cleanupEventId = data.cleanupEventId;
        return { count: 1 };
      }),
    },
    assetVariant: { findMany: vi.fn(async () => []) },
    outboxEvent: {
      findMany: vi.fn(async () => successors.slice(0, 2)),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        successors.push(data);
        return data;
      }),
    },
  };
  return {
    asset,
    successors,
    tx,
    ownerDb: {
      outboxEvent: { findMany: vi.fn(async () => [legacy]) },
      $transaction: vi.fn(async (fn: (client: unknown) => unknown) =>
        fn({
          $queryRaw: vi.fn(async () => [{ locked: true }]),
          outboxEvent: { findMany: vi.fn(async () => [legacy]) },
          asset: { count: vi.fn(async () => 0) },
        }),
      ),
    },
    prisma: {
      withWorkspace: vi.fn(async (_workspaceId: string, fn: (client: typeof tx) => unknown) => fn(tx)),
    },
    scanner: { scan: vi.fn(async () => usages) },
  };
}

describe('legacy parked canonical cleanup reconciliation', () => {
  it('is dry-run by default and reports references without mutating provenance', async () => {
    const dry = harness();
    const result = await reconcileParkedCanonicalCleanups(dry as never);
    expect(result.counts.eligible).toBe(1);
    expect(dry.successors).toEqual([]);
    expect(dry.asset.cleanupEventId).toBeNull();

    const referenced = harness([{ fieldPath: '/brand/logoAssetId' }]);
    const blocked = await reconcileParkedCanonicalCleanups(referenced as never, { apply: true });
    expect(blocked.counts.referenced).toBe(1);
    expect(blocked.items[0]).toMatchObject({ usageCount: 1 });
    expect(referenced.successors).toEqual([]);
  });

  it('creates a causally linked v2 successor once and binds the tombstone to its event', async () => {
    const h = harness();
    const first = await reconcileParkedCanonicalCleanups(h as never, {
      apply: true,
    });
    expect(first.counts.eligible).toBe(1);
    expect(h.successors).toHaveLength(1);
    expect(h.successors[0]).toMatchObject({
      schemaVersion: 2,
      causationId: LEGACY_EVENT,
      aggregateId: ASSET,
      payload: { objectClass: 'canonical', variants: [] },
    });
    expect(h.asset.cleanupEventId).toBe(h.successors[0].eventId);

    const second = await reconcileParkedCanonicalCleanups(h as never, {
      apply: true,
    });
    expect(second.counts.already_reconciled).toBe(1);
    expect(h.successors).toHaveLength(1);
  });

  it('refuses a concurrent reconciliation before enumerating tenant data', async () => {
    const h = harness();
    h.ownerDb.$transaction = vi.fn(async (fn: (client: unknown) => unknown) =>
      fn({
        $queryRaw: vi.fn(async () => [{ locked: false }]),
        outboxEvent: { findMany: vi.fn() },
        asset: { count: vi.fn() },
      }),
    );
    await expect(reconcileParkedCanonicalCleanups(h as never)).rejects.toThrow('already running');
    expect(h.prisma.withWorkspace).not.toHaveBeenCalled();
  });

  it('fails closed when more than one successor claims the same legacy event', async () => {
    const h = harness();
    h.successors.push({ eventId: '55555555-5555-4555-8555-555555555555' });
    h.successors.push({ eventId: '66666666-6666-4666-8666-666666666666' });
    const result = await reconcileParkedCanonicalCleanups(h as never, { apply: true });
    expect(result.counts.inconsistent).toBe(1);
    expect(h.tx.outboxEvent.create).not.toHaveBeenCalled();
  });
});
