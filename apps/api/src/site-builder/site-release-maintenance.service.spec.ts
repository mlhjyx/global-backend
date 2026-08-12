import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SiteReleaseMaintenanceService } from './site-release-maintenance.service';

const NOW = new Date('2026-08-08T12:00:00.000Z');
const OLD = new Date('2026-07-01T00:00:00.000Z');

function release(over: Record<string, unknown> = {}) {
  return {
    id: 'release-1',
    siteId: 'site-1',
    siteVersionId: 'version-1',
    releaseNumber: 1,
    status: 'failed',
    createdAt: OLD,
    readyAt: null,
    leaseUntil: OLD,
    gcLeaseUntil: null,
    artifactPrefix: 'releases/site-1/release-1',
    ...over,
  };
}

function harness(candidate = release()) {
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    siteRelease: {
      findUnique: vi.fn(async () => candidate),
      count: vi.fn(async () => 2),
      update: vi.fn(async () => candidate),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    site: { findUnique: vi.fn(async () => ({ activeVersionId: null })) },
  };
  const ownerDb = {
    siteRelease: { findMany: vi.fn(async () => [candidate]) },
    $transaction: vi.fn(async (work: (value: typeof tx) => unknown) => work(tx)),
  };
  const storage = { deletePrefix: vi.fn(async () => undefined) };
  return {
    tx,
    ownerDb,
    storage,
    service: new SiteReleaseMaintenanceService(ownerDb as never, storage, () => NOW),
  };
}

beforeEach(() => {
  process.env.SITE_RELEASE_GC_ENABLED = 'true';
});
afterEach(() => {
  delete process.env.SITE_RELEASE_GC_ENABLED;
});

describe('SiteReleaseMaintenanceService', () => {
  it('does nothing while the irreversible GC gate is disabled', async () => {
    delete process.env.SITE_RELEASE_GC_ENABLED;
    const { service, ownerDb } = harness();
    await expect(service.sweep()).resolves.toEqual({ examined: 0, deleted: 0 });
    expect(ownerDb.siteRelease.findMany).not.toHaveBeenCalled();
  });

  it('claims, deletes and settles an eligible failed release under fencing', async () => {
    const { service, ownerDb, tx, storage } = harness();
    await expect(service.sweep(500)).resolves.toEqual({ examined: 1, deleted: 1 });
    expect(ownerDb.siteRelease.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 }),
    );
    expect(storage.deletePrefix).toHaveBeenCalledWith('releases/site-1/release-1/');
    expect(tx.siteRelease.updateMany).toHaveBeenCalledTimes(2);
  });

  it('marks an expired candidate failed before claiming it', async () => {
    const candidate = release({ status: 'candidate', leaseUntil: OLD });
    const { service, tx } = harness(candidate);
    await expect(service.sweep(0)).resolves.toEqual({ examined: 1, deleted: 1 });
    expect(tx.siteRelease.update).toHaveBeenCalledWith({
      where: { id: 'release-1' },
      data: { status: 'failed', error: 'abandoned candidate retention expired' },
    });
  });

  it.each([
    ['missing row', null, null],
    ['active version', release(), { activeVersionId: 'version-1' }],
    ['fresh candidate lease', release({ status: 'candidate', leaseUntil: new Date('2026-08-08T13:00:00Z') }), null],
  ])('skips %s without deleting storage', async (_name, candidate, site) => {
    const h = harness(candidate ?? release());
    h.tx.siteRelease.findUnique.mockResolvedValue(candidate as never);
    if (site) h.tx.site.findUnique.mockResolvedValue(site);
    await expect(h.service.sweep()).resolves.toEqual({ examined: 1, deleted: 0 });
    expect(h.storage.deletePrefix).not.toHaveBeenCalled();
  });

  it('resumes an expired deleting lease without rerunning eligibility checks', async () => {
    const candidate = release({ status: 'deleting', gcLeaseUntil: OLD });
    const { service, tx, storage } = harness(candidate);
    await expect(service.sweep()).resolves.toEqual({ examined: 1, deleted: 1 });
    expect(tx.siteRelease.count).not.toHaveBeenCalled();
    expect(storage.deletePrefix).toHaveBeenCalledTimes(1);
  });

  it('skips a lost claim and fails closed when settle fencing is lost', async () => {
    const lost = harness();
    lost.tx.siteRelease.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(lost.service.sweep()).resolves.toEqual({ examined: 1, deleted: 0 });
    expect(lost.storage.deletePrefix).not.toHaveBeenCalled();

    const fenced = harness();
    fenced.tx.siteRelease.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    await expect(fenced.service.sweep()).rejects.toThrow('SITE_RELEASE_GC_SETTLE_FENCED');
  });
});

