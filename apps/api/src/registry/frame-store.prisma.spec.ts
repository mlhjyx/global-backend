import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { FrameLoadPlan } from './frame-loader';
import type { NormalizedRegistryEntity } from './frame-normalize';
import { PrismaRegistryFrameStore, RegistryLoadConflictError } from './frame-store.prisma';

function entity(regNumber: string): NormalizedRegistryEntity {
  return {
    scheme: 'au_abn',
    regNumber,
    country: 'AU',
    name: `Solar Corp ${regNumber} Pty Ltd`,
    nameNorm: `solar corp ${regNumber}`,
    legalForm: 'pty_ltd',
    status: 'ACTIVE',
    addressJson: null,
    city: null,
    postalCode: '2000',
    region: 'NSW',
    nace: '43.21',
    naceVersion: 'AU-ABN-KW',
    employeeBand: null,
    vatId: null,
    lei: null,
    website: null,
    identifiers: null,
    attributes: { entityType: 'PRV' },
    contentHash: regNumber.padEnd(64, 'a').slice(0, 64),
  };
}

function emptyPlan(overrides: Partial<FrameLoadPlan> = {}): FrameLoadPlan {
  return {
    adds: [],
    updates: [],
    touches: [],
    misses: [],
    withdrawals: [],
    reappeared: [],
    changes: [],
    stats: { added: 0, updated: 0, unchanged: 0, missing: 0, withdrawn: 0, reappeared: 0 },
    ...overrides,
  };
}

describe('PrismaRegistryFrameStore.applyPlan batching', () => {
  const ctx = {
    snapshotId: 'snap-1',
    frameId: 'frame-1',
    now: new Date('2026-11-27T00:00:00Z'),
  };

  it('uses chunked createMany fast-path for fresh adds and skips row-by-row upserts', async () => {
    const createMany = vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
    const upsert = vi.fn();
    const changeCreateMany = vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
    const tx = {
      registryEntity: { createMany, upsert, updateMany: vi.fn(async () => ({ count: 1 })) },
      registryEntityChange: { createMany: changeCreateMany },
    };
    const prisma = {
      $transaction: async (fn: (client: typeof tx) => Promise<void>) => fn(tx),
    } as unknown as PrismaClient;

    const store = new PrismaRegistryFrameStore(prisma);
    const adds = Array.from({ length: 2_005 }, (_, i) => entity(String(100000 + i)));
    await store.applyPlan(
      emptyPlan({
        adds,
        changes: adds.map((item) => ({
          scheme: item.scheme,
          regNumber: item.regNumber,
          changeType: 'ADDED' as const,
          fieldDiffs: null,
          contentHash: item.contentHash,
        })),
      }),
      ctx,
    );

    expect(createMany).toHaveBeenCalledTimes(2);
    expect(upsert).not.toHaveBeenCalled();
    expect(changeCreateMany).toHaveBeenCalledTimes(2);
  });

  it('falls back to per-row upsert only when createMany skips duplicate business keys', async () => {
    const createMany = vi.fn(async () => ({ count: 1 }));
    const upsert = vi.fn(async () => ({}));
    const tx = {
      registryEntity: { createMany, upsert, updateMany: vi.fn(async () => ({ count: 1 })) },
      registryEntityChange: { createMany: vi.fn(async () => ({ count: 0 })) },
    };
    const prisma = {
      $transaction: async (fn: (client: typeof tx) => Promise<void>) => fn(tx),
    } as unknown as PrismaClient;

    const store = new PrismaRegistryFrameStore(prisma);
    await store.applyPlan(emptyPlan({ adds: [entity('1'), entity('2')] }), ctx);

    expect(createMany).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it('throws RegistryLoadConflictError when optimistic contentHash check misses', async () => {
    const tx = {
      registryEntity: {
        createMany: vi.fn(async () => ({ count: 0 })),
        upsert: vi.fn(),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      registryEntityChange: { createMany: vi.fn(async () => ({ count: 0 })) },
    };
    const prisma = {
      $transaction: async (fn: (client: typeof tx) => Promise<void>) => fn(tx),
    } as unknown as PrismaClient;

    const store = new PrismaRegistryFrameStore(prisma);
    await expect(
      store.applyPlan(
        emptyPlan({
          updates: [
            {
              id: 'entity-1',
              entity: entity('1'),
              previousContentHash: '0'.repeat(64),
              fieldDiffs: [{ field: 'name', before: 'Old', after: 'New' }],
            },
          ],
        }),
        ctx,
      ),
    ).rejects.toThrow(RegistryLoadConflictError);
  });
});
