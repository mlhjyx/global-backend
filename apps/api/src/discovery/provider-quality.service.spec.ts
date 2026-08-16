import { describe, expect, it, vi } from 'vitest';
import { ProviderQualityService } from './provider-quality.service';

const ctx = { userId: 'u-1', workspaceId: 'ws-a', roles: ['owner'] };
const counts = { _all: 2, attemptedCount: 2, successCount: 2, zeroResultCount: 2, failureCount: 2, failedRunCount: 2, processedCount: 2, rawCount: 2, acceptedCount: 2, boundCount: 2, domainCount: 2, authorityCount: 2, conflictCount: 2, duplicateCount: 2 };

describe('ProviderQualityService', () => {
  it('uses attempted runs and processed rows as truthful denominators', async () => {
    const groupBy = vi.fn(async () => [{
      providerKey: 'wikidata',
      _count: counts,
      _sum: { attemptedCount: 3, successCount: 2, zeroResultCount: 1, failureCount: 1, failedRunCount: 1, processedCount: 20, rawCount: 5, acceptedCount: 4, boundCount: 3, domainCount: 3, authorityCount: 4, conflictCount: 1, duplicateCount: 15 },
    }]);
    const prisma = { withWorkspace: vi.fn(async (_workspaceId, fn) => fn({ providerQualityRunContribution: { groupBy } })) };
    const result = await new ProviderQualityService(prisma as never, () => new Date('2026-08-13T00:00:00.000Z')).rank(ctx, { windowDays: 30, minRuns: 2, metric: 'duplicate_rate' });

    expect(result.providers[0]).toMatchObject({
      attemptedRuns: 2,
      failedRuns: 1,
      metrics: { processed: 20, duplicates: 15, attempts: 3, failures: 1 },
      rates: { failure: 0.5, duplicate: 0.75 },
      rank: 1,
    });
  });

  it('reports a fully duplicate run as 100%, never null or above 100%', async () => {
    const groupBy = async () => [{
      providerKey: 'p', _count: Object.fromEntries(Object.keys(counts).map((key) => [key, 1])),
      _sum: { attemptedCount: 1, successCount: 1, zeroResultCount: 0, failureCount: 0, failedRunCount: 0, processedCount: 8, rawCount: 0, acceptedCount: 0, boundCount: 0, domainCount: 0, authorityCount: 0, conflictCount: 0, duplicateCount: 8 },
    }];
    const prisma = { withWorkspace: async (_workspaceId, fn) => fn({ providerQualityRunContribution: { groupBy } }) };
    const result = await new ProviderQualityService(prisma as never).rank(ctx, { windowDays: 7, minRuns: 1, metric: 'duplicate_rate' });
    expect(result.providers[0].rates.duplicate).toBe(1);
  });

  it('keeps optional identity totals unknown when any run lacks them', async () => {
    const groupBy = async () => [{
      providerKey: 'p', _count: { ...counts, acceptedCount: 1, boundCount: 1, domainCount: 1, authorityCount: 1, conflictCount: 1 },
      _sum: { attemptedCount: 2, successCount: 2, zeroResultCount: 0, failureCount: 0, failedRunCount: 0, processedCount: 2, rawCount: 2, acceptedCount: 1, boundCount: 1, domainCount: 1, authorityCount: 1, conflictCount: 0, duplicateCount: 0 },
    }];
    const prisma = { withWorkspace: async (_workspaceId, fn) => fn({ providerQualityRunContribution: { groupBy } }) };
    const result = await new ProviderQualityService(prisma as never).rank(ctx, { windowDays: 7, minRuns: 1, metric: 'bound_rate' });
    expect(result.providers[0].metrics.accepted).toBeNull();
    expect(result.providers[0].rates.bound).toBeNull();
    expect(result.providers[0].rank).toBeNull();
  });
});
