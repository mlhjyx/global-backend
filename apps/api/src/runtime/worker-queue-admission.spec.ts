import { describe, expect, it, vi } from 'vitest';

import { waitForWorkerQueueAdmission } from './worker-queue-admission';

describe('waitForWorkerQueueAdmission', () => {
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
});
