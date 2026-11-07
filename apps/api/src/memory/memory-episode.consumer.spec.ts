import { describe, expect, it } from 'vitest';
import { MemoryConsumerConfig } from './memory.contracts';
import { MemoryEpisodeConsumer } from './memory-episode.consumer';

const PLAN_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const ICP_ID = '33333333-3333-4333-8333-333333333333';
const EVENT_ID = '44444444-4444-4444-8444-444444444444';
const WORKSPACE_ID = '55555555-5555-4555-8555-555555555555';
const RUN_COMPLETED_AT = new Date('2026-11-08T10:00:00.000Z');

interface StoredEpisode {
  workspaceId: string;
  workflowType: string;
  runId: string;
  phase: string;
  occurredAt: Date;
  sourceEventId: string;
}

class FakeStore {
  readonly runs = new Map<
    string,
    { id: string; icpId: string; completedAt: Date | null }
  >();
  readonly episodes = new Map<string, StoredEpisode>();

  readonly discoveryRun = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      this.runs.has(where.id) ? { id: where.id } : null,
    findMany: async ({
      where,
    }: {
      where: {
        icpId: string;
        completedAt: { lte: Date; gte: Date };
      };
    }) =>
      [...this.runs.values()]
        .filter(
          (run) =>
            run.icpId === where.icpId &&
            run.completedAt !== null &&
            run.completedAt <= where.completedAt.lte &&
            run.completedAt >= where.completedAt.gte,
        )
        .map((run) => ({ id: run.id })),
  };

  readonly memRunEpisode = {
    findMany: async ({
      where,
    }: {
      where: { workflowType: string; phase: string; runId: { in: string[] } };
    }) =>
      [...this.episodes.values()]
        .filter(
          (episode) =>
            episode.workflowType === where.workflowType &&
            episode.phase === where.phase &&
            where.runId.in.includes(episode.runId),
        )
        .map((episode) => ({ runId: episode.runId })),
    createMany: async ({
      data,
    }: {
      data: StoredEpisode[];
      skipDuplicates?: boolean;
    }) => {
      let count = 0;
      for (const row of data) {
        const key = `${row.workspaceId}|${row.workflowType}|${row.runId}|${row.phase}`;
        if (this.episodes.has(key)) continue;
        this.episodes.set(key, row);
        count += 1;
      }
      return { count };
    },
  };
}

class FakePrisma {
  constructor(private readonly store: FakeStore) {}
  async withWorkspace<T>(
    workspaceId: string,
    fn: (tx: FakeStore) => Promise<T>,
  ): Promise<T> {
    expect(workspaceId).toBe(WORKSPACE_ID);
    return fn(this.store);
  }
}

class FakeOwner {
  constructor(private readonly events: unknown[]) {}
  readonly outboxEvent = {
    findMany: async ({
      where,
    }: {
      where: { eventType: { in: string[] }; occurredAt: { gte: Date } };
    }) =>
      this.events.filter((raw) => {
        const row = raw as {
          eventType: string;
          occurredAt: Date;
        };
        return (
          where.eventType.in.includes(row.eventType) &&
          row.occurredAt >= where.occurredAt.gte
        );
      }),
  };
  async $disconnect(): Promise<void> {}
}

function event(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 1n,
    eventId: EVENT_ID,
    workspaceId: WORKSPACE_ID,
    eventType: 'DiscoveryRunCompleted',
    schemaVersion: 1,
    producer: 'global-backend',
    correlationId: null,
    causationId: null,
    aggregateId: RUN_ID,
    payload: {
      planId: PLAN_ID,
      status: 'DONE',
      stats: { perSource: { searxng: { records: 3 } } },
      cost: 1.23,
      costBasis: 'usage_ledger-runid/v1',
    },
    occurredAt: RUN_COMPLETED_AT,
    privacyClassification: 'CONFIDENTIAL',
    ...overrides,
  };
}

function leadsScored(
  occurredAt = new Date('2026-11-08T10:10:00.000Z'),
): Record<string, unknown> {
  return event({
    id: 2n,
    eventId: '66666666-6666-4666-8666-666666666666',
    eventType: 'LeadsScored',
    aggregateId: ICP_ID,
    payload: { scored: 12, queues: { recommended: 3 } },
    occurredAt,
  });
}

const enabled: MemoryConsumerConfig = {
  enabled: true,
  pollMs: 60_000,
  lookbackDays: 14,
  batchSize: 100,
};

function build(events: unknown[], store = new FakeStore()) {
  const consumer = new MemoryEpisodeConsumer(
    new FakePrisma(store) as never,
    new FakeOwner(events) as never,
    enabled,
  );
  return { consumer, store };
}

describe('MemoryEpisodeConsumer', () => {
  it('writes run_completed exactly once across repeated scans', async () => {
    const store = new FakeStore();
    store.runs.set(RUN_ID, {
      id: RUN_ID,
      icpId: ICP_ID,
      completedAt: RUN_COMPLETED_AT,
    });
    const { consumer } = build([event()], store);

    const first = await consumer.runOnce(new Date('2026-11-08T11:00:00Z'));
    const second = await consumer.runOnce(new Date('2026-11-08T11:01:00Z'));

    expect(first).toEqual({ scanned: 1, inserted: 1, failed: 0 });
    expect(second).toEqual({ scanned: 1, inserted: 0, failed: 0 });
    expect(store.episodes.size).toBe(1);
  });

  it('writes results_backfilled only when phase one exists, once', async () => {
    const store = new FakeStore();
    store.runs.set(RUN_ID, {
      id: RUN_ID,
      icpId: ICP_ID,
      completedAt: RUN_COMPLETED_AT,
    });
    const { consumer } = build([event(), leadsScored()], store);

    const first = await consumer.runOnce(new Date('2026-11-08T11:00:00Z'));
    const second = await consumer.runOnce(new Date('2026-11-08T11:01:00Z'));

    expect(first.inserted).toBe(2);
    expect(second.inserted).toBe(0);
    const phases = [...store.episodes.values()].map((row) => row.phase).sort();
    expect(phases).toEqual(['results_backfilled', 'run_completed']);
  });

  it('does not backfill results without a run_completed episode', async () => {
    const store = new FakeStore();
    store.runs.set(RUN_ID, {
      id: RUN_ID,
      icpId: ICP_ID,
      completedAt: RUN_COMPLETED_AT,
    });
    const { consumer } = build([leadsScored()], store);
    const result = await consumer.runOnce(new Date('2026-11-08T11:00:00Z'));
    expect(result.inserted).toBe(0);
    expect(store.episodes.size).toBe(0);
  });

  it('ignores runs outside the lookback window', async () => {
    const store = new FakeStore();
    store.runs.set(RUN_ID, {
      id: RUN_ID,
      icpId: ICP_ID,
      completedAt: new Date('2026-10-01T10:00:00.000Z'),
    });
    const { consumer } = build(
      [
        event({
          occurredAt: new Date('2026-10-01T10:00:00.000Z'),
        }),
        leadsScored(new Date('2026-11-08T10:10:00.000Z')),
      ],
      store,
    );
    const result = await consumer.runOnce(new Date('2026-11-08T11:00:00Z'));
    // The October run_completed event is outside the scan window; the fresh
    // LeadsScored is scanned but its run is older than the backfill window.
    expect(result.scanned).toBe(1);
    expect(result.inserted).toBe(0);
  });

  it('counts a malformed payload as failed without writing a partial row', async () => {
    const store = new FakeStore();
    store.runs.set(RUN_ID, {
      id: RUN_ID,
      icpId: ICP_ID,
      completedAt: RUN_COMPLETED_AT,
    });
    const { consumer } = build(
      [event({ payload: { planId: 'bad' } })],
      store,
    );
    const result = await consumer.runOnce(new Date('2026-11-08T11:00:00Z'));
    expect(result).toEqual({ scanned: 1, inserted: 0, failed: 1 });
    expect(store.episodes.size).toBe(0);
  });

  it('stays off unless enabled', () => {
    const consumer = new MemoryEpisodeConsumer(
      new FakePrisma(new FakeStore()) as never,
      new FakeOwner([]) as never,
      { ...enabled, enabled: false },
    );
    consumer.onModuleInit();
    expect((consumer as unknown as { timer?: unknown }).timer).toBeUndefined();
  });
});
