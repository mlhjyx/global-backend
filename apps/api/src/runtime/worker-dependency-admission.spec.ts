import { describe, expect, it, vi } from 'vitest';
import { waitForWorkerDependencyAdmission } from './worker-dependency-admission';

describe('waitForWorkerDependencyAdmission', () => {
  it('keeps polling disabled and retries a transient managed dependency until it becomes ready', async () => {
    const check = vi
      .fn<() => Promise<{ status: 'ok' } | { status: 'failed'; code: string }>>()
      .mockResolvedValueOnce({ status: 'failed', code: 'REDIS_UNAVAILABLE' })
      .mockResolvedValueOnce({ status: 'ok' });
    const onBlocked = vi.fn();
    const sleep = vi.fn(async () => undefined);

    await waitForWorkerDependencyAdmission({ check, onBlocked, sleep, retryMs: 1 });

    expect(onBlocked).toHaveBeenCalledWith('REDIS_UNAVAILABLE');
    expect(sleep).toHaveBeenCalledWith(1);
    expect(check).toHaveBeenCalledTimes(2);
  });
});
