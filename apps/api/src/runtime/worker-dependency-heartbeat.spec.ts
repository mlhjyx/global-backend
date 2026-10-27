import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startWorkerDependencyHeartbeat } from './worker-dependency-heartbeat';

type CheckResult = { status: 'ok' } | { status: 'failed'; code: string };

function harness(results: CheckResult[]) {
  const check = vi.fn<() => Promise<CheckResult>>();
  for (const result of results) check.mockResolvedValueOnce(result);
  check.mockResolvedValue({ status: 'ok' });
  const heartbeat = vi.fn(async () => undefined);
  const shutdown = vi.fn();
  const blocked = vi.fn();
  const start = () =>
    startWorkerDependencyHeartbeat({
      check,
      worker: { shutdown },
      leases: { heartbeat },
      taskQueue: 'understanding',
      onBlocked: blocked,
    });
  return { check, heartbeat, shutdown, blocked, start };
}

describe('startWorkerDependencyHeartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('drains after three consecutive failures, not after a single transient blip', async () => {
    const h = harness([
      { status: 'ok' },
      { status: 'failed', code: 'REDIS_UNAVAILABLE' },
      { status: 'failed', code: 'REDIS_UNAVAILABLE' },
      { status: 'failed', code: 'REDIS_UNAVAILABLE' },
    ]);
    const handle = await h.start();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.blocked).not.toHaveBeenCalled();
    expect(h.shutdown).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.blocked).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.blocked).toHaveBeenCalledWith('REDIS_UNAVAILABLE');
    expect(h.heartbeat).toHaveBeenCalledWith('WORKER', 'DRAINING', 'understanding');
    expect(h.shutdown).toHaveBeenCalledOnce();
    handle.stop();
  });

  it('forgets earlier failures once a check recovers', async () => {
    const h = harness([
      { status: 'ok' },
      { status: 'failed', code: 'REDIS_UNAVAILABLE' },
      { status: 'failed', code: 'REDIS_UNAVAILABLE' },
      { status: 'ok' },
      { status: 'failed', code: 'REDIS_UNAVAILABLE' },
      { status: 'failed', code: 'REDIS_UNAVAILABLE' },
    ]);
    const handle = await h.start();

    // Two failures, then a recovery, then two more failures: never three in a row.
    await vi.advanceTimersByTimeAsync(50_000);
    expect(h.blocked).not.toHaveBeenCalled();
    expect(h.shutdown).not.toHaveBeenCalled();
    handle.stop();
  });

  it('retries a transient failure at startup instead of refusing admission', async () => {
    const h = harness([
      { status: 'failed', code: 'SETTLEMENT_READBACK_UNAVAILABLE' },
      { status: 'ok' },
    ]);
    const started = h.start();
    await vi.advanceTimersByTimeAsync(1_000);
    const handle = await started;

    expect(handle.admitted).toBe(true);
    expect(h.blocked).not.toHaveBeenCalled();
    expect(h.shutdown).not.toHaveBeenCalled();
    handle.stop();
  });

  it('refuses admission only after three failed startup checks', async () => {
    const h = harness([
      { status: 'failed', code: 'SETTLEMENT_READBACK_UNAVAILABLE' },
      { status: 'failed', code: 'SETTLEMENT_READBACK_UNAVAILABLE' },
      { status: 'failed', code: 'SETTLEMENT_READBACK_UNAVAILABLE' },
    ]);
    const started = h.start();
    await vi.advanceTimersByTimeAsync(5_000);
    const handle = await started;

    expect(handle.admitted).toBe(false);
    expect(h.blocked).toHaveBeenCalledWith('SETTLEMENT_READBACK_UNAVAILABLE');
    expect(h.shutdown).toHaveBeenCalledOnce();
  });

  it('treats a thrown check as a failure, not as an immediate drain', async () => {
    const check = vi
      .fn<() => Promise<CheckResult>>()
      .mockRejectedValueOnce(new Error('probe timed out'))
      .mockResolvedValue({ status: 'ok' } as CheckResult);
    const heartbeat = vi.fn(async () => undefined);
    const shutdown = vi.fn();
    const blocked = vi.fn();
    const started = startWorkerDependencyHeartbeat({
      check,
      worker: { shutdown },
      leases: { heartbeat },
      taskQueue: 'understanding',
      onBlocked: blocked,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const handle = await started;

    expect(handle.admitted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(blocked).not.toHaveBeenCalled();
    handle.stop();
  });
});
