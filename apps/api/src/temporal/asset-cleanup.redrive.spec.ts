import { describe, expect, it } from 'vitest';
import {
  AssetCleanupRedriveEvent,
  assertAssetCleanupRedrivable,
  validateAssetCleanupRedriveEvent,
  queueAssetCleanupRedrive,
} from './asset-cleanup.redrive';
import { vi } from 'vitest';

const EVENT: AssetCleanupRedriveEvent = {
  eventId: '44444444-4444-4444-8444-444444444444',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  eventType: 'AssetObjectCleanupRequested',
  schemaVersion: 1,
  aggregateType: 'Asset',
  aggregateId: '33333333-3333-4333-8333-333333333333',
  payload: {
    assetId: '33333333-3333-4333-8333-333333333333',
    siteId: '22222222-2222-4222-8222-222222222222',
    objectKey:
      'ws/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/uploads/33333333-3333-4333-8333-333333333333',
    objectClass: 'staging',
    reason: 'commit_succeeded',
    notBefore: '2026-07-17T08:15:00.000Z',
  },
  publishedAt: new Date(),
  parkedAt: null,
};

const CANONICAL_EVENT: AssetCleanupRedriveEvent = {
  ...EVENT,
  schemaVersion: 2,
  payload: {
    variants: [
      {
        status: 'ready',
        sourceVariantId: null,
        recipeHash: 'b'.repeat(64),
        contentHash: 'c'.repeat(64),
        objectKey:
          'ws/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/variants/33333333-3333-4333-8333-333333333333/' +
          `${'b'.repeat(64)}.webp`,
        id: '55555555-5555-4555-8555-555555555555',
      },
    ],
    reason: 'asset_deleted',
    objectClass: 'canonical',
    canonical: {
      contentHash: 'a'.repeat(64),
      objectKey:
        'ws/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/assets/' +
        `${'a'.repeat(64)}.png`,
    },
    siteId: '22222222-2222-4222-8222-222222222222',
    assetId: '33333333-3333-4333-8333-333333333333',
  },
};

describe('asset cleanup redrive safety gate', () => {
  it('accepts only an exact staging Outbox command', () => {
    expect(validateAssetCleanupRedriveEvent(EVENT)).toMatchObject({
      eventId: EVENT.eventId,
      objectClass: 'staging',
    });
  });

  it('accepts an exact canonical jsonb payload independent of nested object key order', () => {
    expect(validateAssetCleanupRedriveEvent(CANONICAL_EVENT)).toMatchObject({
      eventId: CANONICAL_EVENT.eventId,
      objectClass: 'canonical',
    });
  });

  it.each([
    [
      'canonical',
      {
        ...(EVENT.payload as object),
        objectClass: 'canonical',
        blockedUntil: 'scanner',
      },
    ],
    ['extra field', { ...(EVENT.payload as object), unexpected: true }],
    ['wrong key', { ...(EVENT.payload as object), objectKey: 'ws/other/uploads/object' }],
  ])('rejects %s payloads', (_name, payload) => {
    expect(() => validateAssetCleanupRedriveEvent({ ...EVENT, payload })).toThrow();
  });

  it.each(['NOT_FOUND', 'FAILED', 'CANCELLED', 'TERMINATED', 'TIMED_OUT'] as const)(
    'allows %s for explicit operator redrive',
    (status) => expect(() => assertAssetCleanupRedrivable(status)).not.toThrow(),
  );

  it.each(['RUNNING', 'COMPLETED', 'CONTINUED_AS_NEW', 'PAUSED', 'UNKNOWN'] as const)(
    'rejects %s to prevent duplicate or destructive execution',
    (status) => expect(() => assertAssetCleanupRedrivable(status)).toThrow(),
  );
});

describe('asset cleanup redrive transaction', () => {
  function harness(locked = true, event: AssetCleanupRedriveEvent = EVENT) {
    const tx = {
      $queryRaw: vi.fn(async () => [{ locked }]),
      outboxEvent: {
        findUnique: vi.fn(async () => ({ id: 9n, ...event })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId: string, fn: (value: typeof tx) => unknown) => fn(tx)),
    };
    return { tx, prisma };
  }

  it('serializes, revalidates and CAS-resets a FAILED event', async () => {
    const h = harness();
    const out = await queueAssetCleanupRedrive({
      prisma: h.prisma as never,
      workspaceId: EVENT.workspaceId,
      eventId: EVENT.eventId,
      executionStatus: async () => 'FAILED',
    });
    expect(out.previousStatus).toBe('FAILED');
    expect(h.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(h.tx.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 9n,
        publishedAt: EVENT.publishedAt,
        parkedAt: EVENT.parkedAt,
      }),
      data: { publishedAt: null, parkedAt: null },
    });
  });

  it('refuses concurrent operators before mutation', async () => {
    const h = harness(false);
    await expect(
      queueAssetCleanupRedrive({
        prisma: h.prisma as never,
        workspaceId: EVENT.workspaceId,
        eventId: EVENT.eventId,
        executionStatus: async () => 'FAILED',
      }),
    ).rejects.toThrow('already being operated');
    expect(h.tx.outboxEvent.updateMany).not.toHaveBeenCalled();
  });

  it('refuses an event that is already pending relay', async () => {
    const h = harness(true, { ...EVENT, publishedAt: null, parkedAt: null });
    await expect(
      queueAssetCleanupRedrive({
        prisma: h.prisma as never,
        workspaceId: EVENT.workspaceId,
        eventId: EVENT.eventId,
        executionStatus: async () => 'FAILED',
      }),
    ).rejects.toThrow('already queued for relay');
    expect(h.tx.outboxEvent.updateMany).not.toHaveBeenCalled();
  });
});
