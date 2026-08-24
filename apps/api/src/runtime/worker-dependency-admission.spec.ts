import { describe, expect, it, vi } from 'vitest';
import {
  selectWorkerDependencyAdmissionBeforeAuthorityCutover,
  waitForWorkerDependencyAdmission,
} from './worker-dependency-admission';

describe('waitForWorkerDependencyAdmission', () => {
  it('keeps additive authority observations out of Worker polling admission before cutover', () => {
    expect(
      selectWorkerDependencyAdmissionBeforeAuthorityCutover({
        hardChecks: [{ status: 'ok' }, { status: 'ok' }],
        authorityCapabilities: [
          {
            status: 'failed',
            code: 'PLATFORM_BUDGET_AUTHORITY_UNAVAILABLE',
          },
        ],
      }),
    ).toEqual({ status: 'ok' });

    expect(
      selectWorkerDependencyAdmissionBeforeAuthorityCutover({
        hardChecks: [
          { status: 'ok' },
          { status: 'failed', code: 'REDIS_UNAVAILABLE' },
        ],
        authorityCapabilities: [{ status: 'ok' }],
      }),
    ).toEqual({ status: 'failed', code: 'REDIS_UNAVAILABLE' });
  });

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

  it('treats a rejected probe as transiently unproven instead of terminating the worker', async () => {
    const check = vi
      .fn<() => Promise<{ status: 'ok' }>>()
      .mockRejectedValueOnce(new Error('transport unavailable'))
      .mockResolvedValueOnce({ status: 'ok' });
    const onBlocked = vi.fn();
    const sleep = vi.fn(async () => undefined);

    await expect(
      waitForWorkerDependencyAdmission({ check, onBlocked, sleep, retryMs: 1 }),
    ).resolves.toBeUndefined();

    expect(onBlocked).toHaveBeenCalledWith('WORKER_DEPENDENCY_UNAVAILABLE');
    expect(sleep).toHaveBeenCalledWith(1);
    expect(check).toHaveBeenCalledTimes(2);
  });
});
