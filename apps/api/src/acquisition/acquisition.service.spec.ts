import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { AcquisitionService } from './acquisition.service';
import { cleanEntity, type RawSourceEntity } from './clean';
import type { SourceAdapterRegistry } from './source-adapter';

const SOURCE_ID = 'source-1';

function rawEntity(externalId: string, over: Partial<RawSourceEntity> = {}): RawSourceEntity {
  return {
    externalId,
    name: `Company ${externalId}`,
    website: `https://${externalId}.example`,
    country: 'DE',
    fields: {},
    ...over,
  };
}

function existingEntity(raw: RawSourceEntity, over: Record<string, unknown> = {}): Record<string, unknown> {
  const cleaned = cleanEntity(raw);
  if (!cleaned) throw new Error('test entity must be cleanable');
  return {
    id: `row-${raw.externalId}`,
    sourceId: SOURCE_ID,
    externalId: raw.externalId,
    contentHash: cleaned.contentHash,
    cleaned: cleaned.cleaned,
    withdrawnAt: null,
    missCount: 0,
    ...over,
  };
}

function makeHarness(args?: {
  raw?: RawSourceEntity[];
  existing?: Record<string, unknown>[];
  source?: Record<string, unknown> | null;
  adapterPresent?: boolean;
  fetchError?: unknown;
}) {
  const source =
    args?.source === null
      ? null
      : {
          id: SOURCE_ID,
          status: 'ACTIVE',
          providerKey: 'directory',
          sourceKey: 'directory:test',
          config: {},
          cadence: { everyMs: 60_000 },
          ...args?.source,
        };
  const adapterFetch = vi.fn(async () => {
    if (args?.fetchError !== undefined) throw args.fetchError;
    return args?.raw ?? [];
  });
  const sourceFetchCreate = vi.fn(async () => ({ id: 'fetch-1' }));
  const sourceFetchUpdate = vi.fn(async () => ({}));
  const sourceEntityCreateMany = vi.fn(async () => ({ count: 0 }));
  const sourceEntityUpdate = vi.fn(async () => ({}));
  const sourceEntityChangeCreateMany = vi.fn(async () => ({ count: 0 }));
  const monitoredSourceUpdate = vi.fn(async () => ({}));
  const prisma = {
    monitoredSource: { findUnique: vi.fn(async () => source), update: monitoredSourceUpdate },
    sourceFetch: { create: sourceFetchCreate, update: sourceFetchUpdate },
    sourceEntity: {
      findMany: vi.fn(async () => args?.existing ?? []),
      createMany: sourceEntityCreateMany,
      update: sourceEntityUpdate,
    },
    sourceEntityChange: { createMany: sourceEntityChangeCreateMany },
  } as unknown as PrismaService;
  const registry = {
    get: vi.fn(() =>
      args?.adapterPresent === false
        ? undefined
        : { providerKey: 'directory', fetch: adapterFetch },
    ),
  } as unknown as SourceAdapterRegistry;
  return {
    service: new AcquisitionService({ prisma, registry }),
    adapterFetch,
    sourceFetchCreate,
    sourceFetchUpdate,
    sourceEntityCreateMany,
    sourceEntityUpdate,
    sourceEntityChangeCreateMany,
    monitoredSourceUpdate,
  };
}

describe('AcquisitionService', () => {
  it('skips inactive sources before creating a fetch or resolving an adapter', async () => {
    const h = makeHarness({ source: { status: 'PAUSED' } });

    await expect(h.service.acquire(SOURCE_ID)).resolves.toEqual({
      sourceId: SOURCE_ID,
      status: 'SKIPPED',
      total: 0,
      added: 0,
      updated: 0,
      removed: 0,
      unchanged: 0,
      reason: 'status=PAUSED',
    });
    expect(h.sourceFetchCreate).not.toHaveBeenCalled();
    expect(h.adapterFetch).not.toHaveBeenCalled();
  });

  it('fails closed when the source or its adapter is missing', async () => {
    const missingSource = makeHarness({ source: null });
    await expect(missingSource.service.acquire(SOURCE_ID)).rejects.toThrow(
      `monitored_source ${SOURCE_ID} not found`,
    );

    const missingAdapter = makeHarness({ adapterPresent: false });
    await expect(missingAdapter.service.acquire(SOURCE_ID)).rejects.toThrow(
      'no source adapter for providerKey=directory',
    );
    expect(missingAdapter.sourceFetchCreate).not.toHaveBeenCalled();
  });

  it('persists and returns only a digest when a source throws arbitrary text', async () => {
    const h = makeHarness({ fetchError: new Error('provider echoed Jane Doe and private body text') });

    const result = await h.service.acquire(SOURCE_ID);

    expect(result.status).toBe('FAILED');
    expect(result.reason).toMatch(/^ERROR_TEXT_SHA256:[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain('Jane Doe');
    expect(h.sourceFetchUpdate).toHaveBeenCalledWith({
      where: { id: 'fetch-1' },
      data: expect.objectContaining({ status: 'FAILED', error: result.reason, finishedAt: expect.any(Date) }),
    });
    expect(h.monitoredSourceUpdate).not.toHaveBeenCalled();
  });

  it('classifies added, resurrected, product, contact, generic, and unchanged rows', async () => {
    const unchanged = rawEntity('unchanged', { fields: { products: ['Pump'] } });
    const productBefore = rawEntity('product', { fields: { products: ['Old pump'] } });
    const productAfter = rawEntity('product', { fields: { products: ['New pump'] } });
    const contactBefore = rawEntity('contact', { fields: { email: 'sales@contact.example' } });
    const contactAfter = rawEntity('contact', { fields: { email: 'info@contact.example' } });
    const genericBefore = rawEntity('generic', { fields: { description: 'Before' } });
    const genericAfter = rawEntity('generic', { fields: { description: 'After' } });
    const resurrected = rawEntity('resurrected');
    const added = rawEntity('added');
    const h = makeHarness({
      raw: [
        unchanged,
        productAfter,
        contactAfter,
        genericAfter,
        resurrected,
        added,
        { ...added, name: 'Duplicate must lose' },
        rawEntity('invalid', { name: '   ' }),
      ],
      existing: [
        existingEntity(unchanged),
        existingEntity(productBefore),
        existingEntity(contactBefore),
        existingEntity(genericBefore),
        existingEntity(resurrected, { withdrawnAt: new Date('2026-01-01T00:00:00Z') }),
      ],
    });

    const result = await h.service.acquire(SOURCE_ID);

    expect(result).toMatchObject({ status: 'DONE', total: 6, added: 1, updated: 4, removed: 0, unchanged: 1 });
    expect(h.sourceEntityCreateMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ externalId: 'added', name: 'Company added' })],
      skipDuplicates: true,
    });
    const changeTypes = h.sourceEntityChangeCreateMany.mock.calls[0]?.[0].data.map(
      (change: { changeType: string }) => change.changeType,
    );
    expect(changeTypes).toEqual(['PRODUCTS_CHANGED', 'CONTACT_CHANGED', 'UPDATED', 'ADDED', 'ADDED']);
    expect(h.sourceEntityUpdate).toHaveBeenCalledWith({
      where: { id: 'row-unchanged' },
      data: { lastSeenAt: expect.any(Date), missCount: 0 },
    });
  });

  it('increments a first miss, removes at the shared threshold, and ignores already withdrawn rows', async () => {
    const h = makeHarness({
      raw: [],
      existing: [
        existingEntity(rawEntity('first-miss')),
        existingEntity(rawEntity('remove-now'), { missCount: 1 }),
        existingEntity(rawEntity('already-withdrawn'), {
          missCount: 2,
          withdrawnAt: new Date('2026-01-01T00:00:00Z'),
        }),
      ],
    });

    const result = await h.service.acquire(SOURCE_ID);

    expect(result).toMatchObject({ status: 'DONE', total: 0, removed: 1, unchanged: 0 });
    expect(h.sourceEntityUpdate).toHaveBeenCalledWith({
      where: { id: 'row-first-miss' },
      data: { missCount: 1 },
    });
    expect(h.sourceEntityUpdate).toHaveBeenCalledWith({
      where: { id: 'row-remove-now' },
      data: { withdrawnAt: expect.any(Date), missCount: 2 },
    });
    expect(h.sourceEntityUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'row-already-withdrawn' } }),
    );
    expect(h.sourceEntityChangeCreateMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ externalId: 'remove-now', changeType: 'REMOVED' })],
    });
  });

  it('does not accumulate misses when the adapter reaches the fetch limit', async () => {
    const h = makeHarness({
      raw: [rawEntity('visible')],
      existing: [existingEntity(rawEntity('outside-truncated-snapshot'))],
    });

    const result = await h.service.acquire(SOURCE_ID, { limit: 1 });

    expect(result).toMatchObject({ total: 1, added: 1, removed: 0 });
    expect(h.adapterFetch).toHaveBeenCalledWith(expect.objectContaining({ sourceKey: 'directory:test' }), 1);
    expect(h.sourceEntityUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'row-outside-truncated-snapshot' } }),
    );
  });

  it('completes an empty first snapshot without emitting entity changes', async () => {
    const h = makeHarness({ raw: [], existing: [] });

    const result = await h.service.acquire(SOURCE_ID);

    expect(result).toEqual({
      sourceId: SOURCE_ID,
      status: 'DONE',
      total: 0,
      added: 0,
      updated: 0,
      removed: 0,
      unchanged: 0,
    });
    expect(h.sourceEntityCreateMany).not.toHaveBeenCalled();
    expect(h.sourceEntityUpdate).not.toHaveBeenCalled();
    expect(h.sourceEntityChangeCreateMany).not.toHaveBeenCalled();
    expect(h.sourceFetchUpdate).toHaveBeenCalledWith({
      where: { id: 'fetch-1' },
      data: expect.objectContaining({ status: 'DONE', total: 0, finishedAt: expect.any(Date) }),
    });
    expect(h.monitoredSourceUpdate).toHaveBeenCalledWith({
      where: { id: SOURCE_ID },
      data: { lastFetchAt: expect.any(Date), nextFetchAt: expect.any(Date) },
    });
  });
});
