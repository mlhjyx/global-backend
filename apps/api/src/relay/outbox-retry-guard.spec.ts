import { describe, expect, it, vi } from 'vitest';
import { OutboxDispatchBackoff, tryWithOutboxAdvisoryLock } from './outbox-retry-guard';

describe('OutboxRelay Ring-1 P0 guards (HOL backoff + advisory lock)', () => {
  it('cools down failing eventIds exponentially and frees them after expiry so newer events are not starved', () => {
    const backoff = new OutboxDispatchBackoff(5_000, 60_000, 100);
    const t0 = 1_000_000;
    expect(backoff.recordFailure('ev-1', t0)).toBe(t0 + 5_000);
    expect(backoff.coolingEventIds(t0 + 1_000)).toEqual(['ev-1']);
    expect(backoff.coolingEventIds(t0 + 5_000)).toEqual([]);

    expect(backoff.recordFailure('ev-2', t0)).toBe(t0 + 5_000);
    expect(backoff.recordFailure('ev-2', t0 + 100)).toBe(t0 + 10_100);
    backoff.clear('ev-2');
    expect(backoff.coolingEventIds(t0 + 200)).toEqual([]);
  });

  it('caps tracked entries to avoid unbounded memory growth under sustained failures', () => {
    const backoff = new OutboxDispatchBackoff(5_000, 60_000, 3);
    const t0 = 1_000_000;
    backoff.recordFailure('ev-1', t0);
    backoff.recordFailure('ev-2', t0);
    backoff.recordFailure('ev-3', t0);
    backoff.recordFailure('ev-4', t0);
    expect(backoff.coolingEventIds(t0 + 100)).toEqual(['ev-2', 'ev-3', 'ev-4']);
  });

  it('skips tick when PG advisory lock is held by another replica and releases when acquired', async () => {
    const fn = vi.fn(async () => undefined);
    const busyDb = { $queryRaw: vi.fn(async () => [{ locked: false }]) };
    expect(await tryWithOutboxAdvisoryLock(busyDb, fn, true)).toBe(false);
    expect(fn).not.toHaveBeenCalled();

    const freeDb = { $queryRaw: vi.fn(async () => [{ locked: true }]) };
    expect(await tryWithOutboxAdvisoryLock(freeDb, fn, true)).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(freeDb.$queryRaw).toHaveBeenCalledTimes(2);
  });
});
