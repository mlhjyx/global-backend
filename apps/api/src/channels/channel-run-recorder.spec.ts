import { describe, expect, it, vi } from 'vitest';

import { recordChannelRunInTransaction } from './channel-run-recorder';

function makeTx(options: {
  existing?: { id: string } | null;
  channel?: Record<string, unknown> | null;
  /** 0 simulates a concurrent finalize that won the crawl_run_id unique key. */
  createManyCount?: number;
  reReadId?: string;
  priorWarning?: { id: string } | null;
} = {}) {
  const create = vi.fn(async () => ({ id: 'run-created' }));
  const createMany = vi.fn(async () => ({ count: options.createManyCount ?? 1 }));
  const update = vi.fn(async () => ({ id: options.existing?.id ?? 'run-updated' }));
  let reads = 0;
  const findUnique = vi.fn(async () => {
    if (options.existing) return options.existing;
    reads += 1;
    return reads === 1 ? null : { id: options.reReadId ?? 'run-created' };
  });
  const channelUpdate = vi.fn(async () => ({}));
  const channelFind = vi.fn(async () =>
    options.channel === undefined
      ? {
          failureStreak: 0,
          status: 'ENABLED',
          consecutiveFailures: 0,
          lastSuccessAt: null,
          createdAt: new Date('2026-10-01T00:00:00Z'),
        }
      : options.channel,
  );
  const eventCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'evt', ...data }));
  const eventFindFirst = vi.fn(async () => options.priorWarning ?? null);
  const tx = {
    sourceChannelRun: { findUnique, create, createMany, update },
    sourceChannel: { findUnique: channelFind, update: channelUpdate },
    sourceChannelHealthEvent: { create: eventCreate, findFirst: eventFindFirst },
  };
  return { tx, create, createMany, update, findUnique, channelUpdate, channelFind, eventCreate, eventFindFirst };
}

const RUN = {
  channelId: '11111111-1111-4111-8111-111111111111',
  crawlRunId: '22222222-2222-4222-8222-222222222222',
  status: 'SUCCEEDED' as const,
  pagesFetched: 3,
  recordsFound: 2,
  recordsMaterialized: 2,
  failures: 0,
};

const DAY = 86_400_000;

describe('channel run recorder (finalize idempotency)', () => {
  it('writes crawl_run_id on the first record and applies the streak update', async () => {
    const { tx, create, createMany, channelUpdate } = makeTx();
    const recorded = await recordChannelRunInTransaction(tx as never, RUN);
    expect(create).not.toHaveBeenCalled();
    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          channelId: RUN.channelId,
          crawlRunId: RUN.crawlRunId,
          status: 'SUCCEEDED',
          pagesFetched: 3,
          recordsFound: 2,
          recordsMaterialized: 2,
          failures: 0,
          finishedAt: expect.any(Date),
        }),
      ],
      skipDuplicates: true,
    });
    expect(channelUpdate).toHaveBeenCalledOnce();
    expect(recorded).toEqual({ runId: 'run-created', autoDisabled: false, failureStreak: 0 });
  });

  it('success resets consecutiveFailures and stamps lastSuccessAt', async () => {
    const { tx, channelUpdate } = makeTx({
      channel: {
        failureStreak: 0,
        status: 'ENABLED',
        consecutiveFailures: 7,
        lastSuccessAt: new Date('2026-11-01T00:00:00Z'),
        createdAt: new Date('2026-10-01T00:00:00Z'),
      },
    });
    await recordChannelRunInTransaction(tx as never, RUN);
    const data = (channelUpdate.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data.consecutiveFailures).toBe(0);
    expect(data.lastSuccessAt).toBeInstanceOf(Date);
  });

  it('failure increments consecutiveFailures without touching lastSuccessAt', async () => {
    const lastSuccessAt = new Date('2026-11-01T00:00:00Z');
    const { tx, channelUpdate } = makeTx({
      channel: { failureStreak: 0, status: 'ENABLED', consecutiveFailures: 3, lastSuccessAt, createdAt: new Date('2026-10-01T00:00:00Z') },
    });
    await recordChannelRunInTransaction(tx as never, { ...RUN, status: 'FAILED', failures: 3 });
    const data = (channelUpdate.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data.consecutiveFailures).toBe(4);
    expect('lastSuccessAt' in data).toBe(false);
  });

  it('30 次且 7 天无成功 → 同事务 AUTO_DISABLED(AUTO_STREAK) + 事件', async () => {
    const now = Date.now();
    const { tx, channelUpdate, eventCreate } = makeTx({
      channel: {
        failureStreak: 0,
        status: 'ENABLED',
        consecutiveFailures: 29,
        lastSuccessAt: new Date(now - 8 * DAY),
        createdAt: new Date(now - 90 * DAY),
      },
    });
    const recorded = await recordChannelRunInTransaction(tx as never, { ...RUN, status: 'FAILED', failures: 1 });
    const data = (channelUpdate.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ status: 'AUTO_DISABLED', disabledReason: 'AUTO_STREAK', consecutiveFailures: 30 });
    expect(recorded.autoDisabled).toBe(true);
    expect(eventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ event: 'AUTO_DISABLED_30_7D' }),
    });
  });

  it('20 次且 4 天无成功 → WARNING 事件（无既有 warning 时）', async () => {
    const now = Date.now();
    const { tx, eventCreate } = makeTx({
      channel: {
        failureStreak: 0,
        status: 'ENABLED',
        consecutiveFailures: 19,
        lastSuccessAt: new Date(now - 5 * DAY),
        createdAt: new Date(now - 90 * DAY),
      },
    });
    await recordChannelRunInTransaction(tx as never, { ...RUN, status: 'FAILED', failures: 1 });
    expect(eventCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ event: 'WARNING_20_4D' }) });
  });

  it('converges a retried finalize onto the same row without touching the failure streak', async () => {
    const { tx, createMany, create, update, channelUpdate, eventCreate } = makeTx({
      existing: { id: 'run-existing' },
      channel: { failureStreak: 2, status: 'ENABLED', consecutiveFailures: 4, lastSuccessAt: null, createdAt: new Date('2026-10-01T00:00:00Z') },
    });
    const recorded = await recordChannelRunInTransaction(tx as never, {
      ...RUN,
      status: 'FAILED',
      pagesFetched: 1,
      failures: 1,
    });
    expect(create).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { crawlRunId: RUN.crawlRunId },
      data: expect.objectContaining({ status: 'FAILED', pagesFetched: 1, failures: 1 }),
    });
    expect(channelUpdate).not.toHaveBeenCalled();
    expect(eventCreate).not.toHaveBeenCalled();
    expect(recorded).toEqual({ runId: 'run-existing', autoDisabled: false, failureStreak: 2 });
  });

  it('absorbs a concurrent duplicate without aborting the transaction or advancing the streak', async () => {
    const { tx, create, createMany, update, channelUpdate } = makeTx({
      createManyCount: 0,
      reReadId: 'run-winner',
      channel: { failureStreak: 1, status: 'ENABLED', consecutiveFailures: 2, lastSuccessAt: null, createdAt: new Date('2026-10-01T00:00:00Z') },
    });
    const recorded = await recordChannelRunInTransaction(tx as never, RUN);
    // The insert was attempted with skipDuplicates; the winner's row is adopted.
    expect(createMany).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(channelUpdate).not.toHaveBeenCalled();
    expect(recorded).toEqual({ runId: 'run-winner', autoDisabled: false, failureStreak: 1 });
  });

  it('keeps the legacy create path for callers without a crawlRunId', async () => {
    const { tx, create, createMany, findUnique } = makeTx();
    const legacy = {
      channelId: RUN.channelId,
      status: RUN.status,
      pagesFetched: RUN.pagesFetched,
      recordsFound: RUN.recordsFound,
      recordsMaterialized: RUN.recordsMaterialized,
      failures: RUN.failures,
    };
    await recordChannelRunInTransaction(tx as never, legacy);
    expect(findUnique).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
    const data = create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect('crawlRunId' in data.data).toBe(false);
  });

  it('defensive: channel rows without the new columns still record (legacy fakes/shape)', async () => {
    const { tx, channelUpdate } = makeTx({ channel: { failureStreak: 0, status: 'ENABLED' } });
    await recordChannelRunInTransaction(tx as never, RUN);
    const data = (channelUpdate.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data.consecutiveFailures).toBe(0);
  });
});
