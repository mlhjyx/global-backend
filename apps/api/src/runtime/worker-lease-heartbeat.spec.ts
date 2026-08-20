import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startWorkerLeaseHeartbeat } from './worker-lease-heartbeat';

describe('startWorkerLeaseHeartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not permit polling when the initial READY lease cannot be published', async () => {
    const shutdown = vi.fn();
    await expect(
      startWorkerLeaseHeartbeat({
        leases: {
          heartbeat: vi.fn(async () => {
            throw new Error('writer unavailable');
          }),
        },
        worker: { shutdown },
        taskQueue: 'understanding',
      }),
    ).rejects.toThrow('writer unavailable');
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('marks draining and shuts the worker down after a running lease is lost', async () => {
    const heartbeat = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('lease lost'))
      .mockResolvedValueOnce(undefined);
    const shutdown = vi.fn();
    const onLeaseLost = vi.fn();
    const handle = await startWorkerLeaseHeartbeat({
      leases: { heartbeat },
      worker: { shutdown },
      taskQueue: 'understanding',
      onLeaseLost,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(heartbeat).toHaveBeenNthCalledWith(3, 'WORKER', 'DRAINING', 'understanding');
    expect(onLeaseLost).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(heartbeat).toHaveBeenCalledTimes(3);
    handle.stop();
  });
});
