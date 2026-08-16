import { describe, expect, it, vi } from 'vitest';
import { createDiscoveryActivities } from './discovery.activities';

function harness(existing?: { status: string; completedAt: Date | null; stats: Record<string, unknown> }) {
  const update = vi.fn(async () => ({}));
  const updateMany = vi.fn(async () => ({ count: existing ? 0 : 1 }));
  const planUpdate = vi.fn(async () => ({}));
  const eventCreate = vi.fn(async () => ({}));
  const storedContributions: Array<Record<string, unknown>> = [];
  const contributionCreateMany = vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
    let count = 0;
    for (const row of data) {
      const exists = storedContributions.some(
        (candidate) => candidate.runId === row.runId && candidate.providerKey === row.providerKey,
      );
      if (!exists) {
        storedContributions.push(row);
        count += 1;
      }
    }
    return { count };
  });
  const contributionFindMany = vi.fn(async () => storedContributions);
  const tx = {
    discoveryRun: {
      update,
      updateMany,
      findUnique: vi.fn(async () => existing ?? null),
    },
    discoveryQueryPlan: { update: planUpdate },
    outboxEvent: { create: eventCreate },
    providerQualityRunContribution: {
      createMany: contributionCreateMany,
      findMany: contributionFindMany,
    },
  };
  const prisma = {
    withWorkspace: async <T>(_workspaceId: string, fn: (client: typeof tx) => Promise<T>): Promise<T> => fn(tx),
  };
  const activities = createDiscoveryActivities({ prisma, providers: {}, gateway: {} } as never);
  return {
    activities,
    update,
    updateMany,
    planUpdate,
    eventCreate,
    contributionCreateMany,
    contributionFindMany,
  };
}

const input = {
  workspaceId: 'ws-1',
  runId: 'run-1',
  planId: 'plan-1',
  icpId: 'icp-1',
  stats: { failure: { stage: 'canonicalize_run', errorType: 'Error', errorCode: null } },
} as const;

describe('finalizeRun terminal transition', () => {
  it('atomically marks a running run FAILED without executing the plan or requesting qualification', async () => {
    const h = harness();

    await h.activities.finalizeRun({ ...input, status: 'FAILED' });

    expect(h.updateMany).toHaveBeenCalledWith({
      where: { id: input.runId, status: 'RUNNING', completedAt: null },
      data: expect.objectContaining({ status: 'FAILED', stats: input.stats, completedAt: expect.any(Date) }),
    });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.planUpdate).not.toHaveBeenCalled();
    expect(h.eventCreate).toHaveBeenCalledTimes(1);
    expect(h.eventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventType: 'DiscoveryRunCompleted' }),
    });
  });

  it('is idempotent when the same terminal result is retried after commit', async () => {
    const h = harness({
      status: 'FAILED',
      completedAt: new Date('2026-08-12T00:00:00.000Z'),
      stats: input.stats,
    });

    await h.activities.finalizeRun({ ...input, status: 'FAILED' });

    expect(h.eventCreate).not.toHaveBeenCalled();
    expect(h.planUpdate).not.toHaveBeenCalled();
    expect(h.contributionCreateMany).not.toHaveBeenCalled();
    expect(h.contributionFindMany).toHaveBeenCalledOnce();
  });

  it('fails closed when a terminal retry carries different stats', async () => {
    const h = harness({
      status: 'FAILED',
      completedAt: new Date('2026-08-12T00:00:00.000Z'),
      stats: input.stats,
    });

    await expect(
      h.activities.finalizeRun({
        ...input,
        stats: { failure: { stage: 'qualify_fit', errorType: 'Error', errorCode: null } },
        status: 'FAILED',
      }),
    ).rejects.toThrow('terminal stats conflict');

    expect(h.contributionFindMany).not.toHaveBeenCalled();
  });

  it('persists provider contributions before publishing completion in the same transaction', async () => {
    const h = harness();
    const stats = {
      perProvider: {
        wikidata: {
          attemptedCount: 1,
          successCount: 1,
          zeroResultCount: 0,
          failureCount: 0,
          rawCount: 2,
          quarantinedCount: 0,
          rejectedCount: 0,
          duplicateCount: 0,
        },
      },
      identityQuality: {
        wikidata: { acceptedRows: 2, domainRows: 1, authorityIdentifierRows: 2, boundRows: 2, conflictRows: 0 },
      },
    };

    await h.activities.finalizeRun({ ...input, stats, status: 'PARTIAL' });

    expect(h.contributionCreateMany).toHaveBeenCalledWith(expect.objectContaining({
      skipDuplicates: true,
      data: [expect.objectContaining({ providerKey: 'wikidata', runId: input.runId })],
    }));
    expect(h.contributionCreateMany.mock.invocationCallOrder[0]).toBeLessThan(h.eventCreate.mock.invocationCallOrder[0]);
  });
});
