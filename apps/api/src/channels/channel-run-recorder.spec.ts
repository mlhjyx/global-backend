import { describe, expect, it, vi } from 'vitest';

import { recordChannelRunInTransaction } from './channel-run-recorder';

function makeTx(options: {
  existing?: { id: string } | null;
  channel?: { failureStreak: number; status: string } | null;
  /** 0 simulates a concurrent finalize that won the crawl_run_id unique key. */
  createManyCount?: number;
  reReadId?: string;
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
  const channelFind = vi.fn(async () => options.channel ?? { failureStreak: 0, status: 'ENABLED' });
  const tx = {
    sourceChannelRun: { findUnique, create, createMany, update },
    sourceChannel: { findUnique: channelFind, update: channelUpdate },
  };
  return { tx, create, createMany, update, findUnique, channelUpdate, channelFind };
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

  it('converges a retried finalize onto the same row without touching the failure streak', async () => {
    const { tx, createMany, create, update, channelUpdate } = makeTx({
      existing: { id: 'run-existing' },
      channel: { failureStreak: 2, status: 'ENABLED' },
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
    expect(recorded).toEqual({ runId: 'run-existing', autoDisabled: false, failureStreak: 2 });
  });

  it('absorbs a concurrent duplicate without aborting the transaction or advancing the streak', async () => {
    const { tx, create, createMany, update, channelUpdate } = makeTx({
      createManyCount: 0,
      reReadId: 'run-winner',
      channel: { failureStreak: 1, status: 'ENABLED' },
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
});
