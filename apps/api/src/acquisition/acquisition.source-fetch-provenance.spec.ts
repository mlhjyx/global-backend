import { describe, expect, it, vi } from 'vitest';
import { AcquisitionService } from './acquisition.service';
import { cleanEntity } from './clean';

function harness(existing: Record<string, unknown>[] = []) {
  const creates: any[] = [];
  const updates: any[] = [];
  const prisma = {
    monitoredSource: {
      findUnique: vi.fn(async () => ({
        id: 'source-1',
        sourceKey: 'fair:test',
        providerKey: 'trade_fair',
        status: 'ACTIVE',
        config: {},
        cadence: null,
      })),
      update: vi.fn(),
    },
    sourceFetch: {
      create: vi.fn(async () => ({ id: 'fetch-current' })),
      update: vi.fn(),
    },
    sourceEntity: {
      findMany: vi.fn(async () => existing),
      createMany: vi.fn(async ({ data }: any) => {
        creates.push(...data);
        return { count: data.length };
      }),
      update: vi.fn(async (args: any) => {
        updates.push(args);
        return args;
      }),
    },
    sourceEntityChange: { createMany: vi.fn() },
  };
  const registry = {
    get: vi.fn(() => ({
      fetch: vi.fn(async () => [
        { externalId: 'new', name: 'New Co' },
        { externalId: 'same', name: 'Same Co' },
        { externalId: 'changed', name: 'Changed Co' },
      ]),
    })),
  };
  return { service: new AcquisitionService({ prisma: prisma as never, registry: registry as never }), creates, updates };
}

describe('AcquisitionService source fetch provenance', () => {
  it('writes the exact fetch id for added, changed and unchanged entities', async () => {
    const sameHash = cleanEntity({ externalId: 'same', name: 'Same Co' })!.contentHash;
    const h = harness([
      {
        id: 'same-id', externalId: 'same', name: 'Same Co', domain: null, country: null,
        cleaned: {}, contentHash: sameHash, withdrawnAt: null, missCount: 0,
      },
      {
        id: 'changed-id', externalId: 'changed', name: 'Old Co', domain: null, country: null,
        cleaned: {}, contentHash: 'different', withdrawnAt: null, missCount: 0,
      },
    ]);

    await h.service.acquire('source-1');

    expect(h.creates[0].lastSeenFetchId).toBe('fetch-current');
    expect(h.updates.filter((call) => ['same-id', 'changed-id'].includes(call.where.id)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ where: { id: 'same-id' }, data: expect.objectContaining({ lastSeenFetchId: 'fetch-current' }) }),
        expect.objectContaining({ where: { id: 'changed-id' }, data: expect.objectContaining({ lastSeenFetchId: 'fetch-current' }) }),
      ]));
  });
});
