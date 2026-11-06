import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WORKER_EXIT_DEADLINE_MS,
  WORKER_SHUTDOWN_FORCE,
  WORKER_SHUTDOWN_GRACE,
  WORKER_SHUTDOWN_OPTIONS,
  armWorkerExitDeadline,
} from './worker-shutdown-policy';

describe('worker shutdown policy', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps the documented bounds', () => {
    expect(WORKER_SHUTDOWN_GRACE).toBe('30s');
    expect(WORKER_SHUTDOWN_FORCE).toBe('60s');
    expect(WORKER_EXIT_DEADLINE_MS).toBe(15_000);
    // Both workers spread this into Worker.create; pinning the shape keeps a
    // refactor from silently dropping the bound.
    expect(WORKER_SHUTDOWN_OPTIONS).toEqual({
      shutdownGraceTime: '30s',
      shutdownForceTime: '60s',
    });
  });

  it('exits after the deadline when cleanup has not finished', () => {
    // 2026-11-05: a drained platform-worker kept running for an hour without
    // polling because nothing bounded the shutdown cleanup.
    vi.useFakeTimers();
    const exit = vi.fn<(code: number) => void>();

    armWorkerExitDeadline(15_000, exit);

    vi.advanceTimersByTime(14_999);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('does nothing once the cleanup completed and cleared the deadline', () => {
    vi.useFakeTimers();
    const exit = vi.fn<(code: number) => void>();
    const handle = armWorkerExitDeadline(15_000, exit);

    handle.clear();
    vi.advanceTimersByTime(60_000);
    expect(exit).not.toHaveBeenCalled();
  });
});
