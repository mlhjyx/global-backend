import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { waitForWorkerQueueAdmission } from './worker-queue-admission';

describe('waitForWorkerQueueAdmission', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('rechecks a mixed release queue after the old lease becomes stale', async () => {
    const inspectWorkerQueue = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'failed' as const,
        code: 'WORKER_MIXED_RELEASE_IDENTITY',
      })
      .mockResolvedValueOnce({ status: 'ok' as const });
    const sleep = vi.fn(async () => undefined);
    const blocked = vi.fn();

    await waitForWorkerQueueAdmission({
      leases: { inspectWorkerQueue },
      taskQueue: 'understanding',
      sleep,
      onBlocked: blocked,
    });

    expect(inspectWorkerQueue).toHaveBeenCalledTimes(2);
    expect(inspectWorkerQueue).toHaveBeenNthCalledWith(1, 'understanding', {
      requireReady: false,
    });
    expect(sleep).toHaveBeenCalledWith(30_000);
    expect(blocked).toHaveBeenCalledWith('WORKER_MIXED_RELEASE_IDENTITY');
  });

  it('uses the bounded default retry delay when no test scheduler is injected', async () => {
    const inspectWorkerQueue = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'failed' as const,
        code: 'WORKER_MIXED_RELEASE_IDENTITY',
      })
      .mockResolvedValueOnce({ status: 'ok' as const });
    const admission = waitForWorkerQueueAdmission({
      leases: { inspectWorkerQueue },
      taskQueue: 'understanding',
      onBlocked: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await admission;
    expect(inspectWorkerQueue).toHaveBeenCalledTimes(2);
  });
});
