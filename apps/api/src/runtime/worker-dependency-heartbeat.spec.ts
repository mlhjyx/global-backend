import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startWorkerDependencyHeartbeat } from './worker-dependency-heartbeat';

type CheckResult =
  | { status: 'ok' }
  | { status: 'failed'; code: string; drainImmediately?: true };

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
      // Healthy loop: these cases exercise failure counting, not the lag guard.
      loopLag: async () => 0,
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

  it('drains at once for a failure that marks itself immediate, such as a lost authority capability', async () => {
    const h = harness([
      { status: 'ok' },
      {
        status: 'failed',
        code: 'PLATFORM_BUDGET_AUTHORITY_NOT_READY',
        drainImmediately: true,
      },
    ]);
    const handle = await h.start();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.blocked).toHaveBeenCalledWith('PLATFORM_BUDGET_AUTHORITY_NOT_READY');
    expect(h.shutdown).toHaveBeenCalledOnce();
    handle.stop();
  });

  it('emits one structured drain event carrying the reason and failure count', async () => {
    const log = vi.fn<(line: string) => void>();
    const started = startWorkerDependencyHeartbeat({
      check: vi
        .fn<() => Promise<CheckResult>>()
        .mockResolvedValue({
          status: 'failed',
          code: 'PLATFORM_BUDGET_AUTHORITY_NOT_READY',
          drainImmediately: true,
        } as CheckResult),
      worker: { shutdown: vi.fn() },
      leases: { heartbeat: vi.fn(async () => undefined) },
      taskQueue: 'understanding',
      onBlocked: vi.fn(),
      log,
      loopLag: async () => 0,
    });
    const handle = await started;

    expect(handle.admitted).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    const event = JSON.parse(log.mock.calls[0]![0]);
    expect(event).toMatchObject({
      event: 'worker_dependency_drain',
      role: 'WORKER',
      taskQueue: 'understanding',
      code: 'PLATFORM_BUDGET_AUTHORITY_NOT_READY',
      consecutiveFailures: 1,
    });
    expect(typeof event.at).toBe('string');
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
      loopLag: async () => 0,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const handle = await started;

    expect(handle.admitted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(blocked).not.toHaveBeenCalled();
    handle.stop();
  });

  it('skips probe rounds while the event loop lags instead of counting the failure', async () => {
    // 2026-11-04: an extraction burst starved the loop past the probe's own abort
    // window three ticks in a row; the worker drained on a live gateway and the
    // in-flight discovery run hung until the container was restarted.
    const check = vi
      .fn<() => Promise<CheckResult>>()
      .mockResolvedValueOnce({ status: 'ok' } as CheckResult)
      .mockResolvedValue({
        status: 'failed',
        code: 'MODEL_GATEWAY_UNAVAILABLE',
      } as CheckResult);
    const lag = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(3_000)
      .mockResolvedValueOnce(3_000)
      .mockResolvedValueOnce(3_000)
      .mockResolvedValue(0);
    const heartbeat = vi.fn(async () => undefined);
    const shutdown = vi.fn();
    const blocked = vi.fn();
    const started = startWorkerDependencyHeartbeat({
      check,
      worker: { shutdown },
      leases: { heartbeat },
      taskQueue: 'understanding',
      onBlocked: blocked,
      loopLag: lag,
    });
    const handle = await started;
    expect(handle.admitted).toBe(true);

    // Three ticks under load: the probe never runs, nothing is counted.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(check).toHaveBeenCalledTimes(1);
    expect(blocked).not.toHaveBeenCalled();

    // The loop recovers; three real failures now drain.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(blocked).toHaveBeenCalledWith('MODEL_GATEWAY_UNAVAILABLE');
    expect(shutdown).toHaveBeenCalledOnce();
    handle.stop();
  });
});
