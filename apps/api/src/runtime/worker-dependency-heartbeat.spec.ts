import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startWorkerDependencyHeartbeat } from './worker-dependency-heartbeat';

describe('startWorkerDependencyHeartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('drains and stops polling when a dependency becomes unavailable after startup', async () => {
    const check = vi
      .fn<() => Promise<{ status: 'ok' } | { status: 'failed'; code: string }>>()
      .mockResolvedValueOnce({ status: 'ok' })
      .mockResolvedValueOnce({ status: 'failed', code: 'REDIS_UNAVAILABLE' });
    const heartbeat = vi.fn(async () => undefined);
    const shutdown = vi.fn();
    const blocked = vi.fn();
    const handle = await startWorkerDependencyHeartbeat({
      check,
      worker: { shutdown },
      leases: { heartbeat },
      taskQueue: 'understanding',
      onBlocked: blocked,
    });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(blocked).toHaveBeenCalledWith('REDIS_UNAVAILABLE');
    expect(heartbeat).toHaveBeenCalledWith('WORKER', 'DRAINING', 'understanding');
    expect(shutdown).toHaveBeenCalledOnce();
    handle.stop();
  });
});
