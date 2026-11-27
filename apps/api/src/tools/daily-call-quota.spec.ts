import { describe, expect, it, vi } from 'vitest';
import { isExecutionControlError } from '../execution-budget/execution-control-error';
import {
  DEFAULT_GOOGLE_PLACES_DAILY_CALL_LIMIT,
  DailyCallQuotaExceededError,
  MAX_GOOGLE_PLACES_DAILY_CALL_LIMIT,
  createDailyCallQuotaLimiter,
  createInMemoryDailyCallQuotaStore,
  resolveDailyCallLimit,
  resolveGooglePlacesDailyCallLimit,
} from './daily-call-quota';

describe('daily call quota (fail-closed UTC day cap)', () => {
  it('parses valid limits, clamps above hard ceiling, allows explicit 0, and falls back on malformed values', () => {
    expect(resolveDailyCallLimit(undefined)).toBe(DEFAULT_GOOGLE_PLACES_DAILY_CALL_LIMIT);
    expect(resolveDailyCallLimit('0')).toBe(0);
    expect(resolveDailyCallLimit('150')).toBe(150);
    expect(resolveDailyCallLimit('999999')).toBe(MAX_GOOGLE_PLACES_DAILY_CALL_LIMIT);
    for (const bad of ['-1', '1.5', '1e3', '100abc', 'unlimited']) {
      expect(resolveDailyCallLimit(bad), bad).toBe(DEFAULT_GOOGLE_PLACES_DAILY_CALL_LIMIT);
    }
    expect(
      resolveGooglePlacesDailyCallLimit({ GOOGLE_PLACES_DAILY_CALL_LIMIT: '350' } as NodeJS.ProcessEnv),
    ).toBe(350);
  });

  it('enforces the daily limit per UTC day and resets on the next UTC date', async () => {
    let currentTime = new Date('2026-11-27T23:59:50.000Z');
    const limiter = createDailyCallQuotaLimiter({
      scope: 'google_places.discover',
      resolveLimit: () => 2,
      now: () => currentTime,
    });

    expect(await limiter.consume()).toEqual({
      allowed: true,
      count: 1,
      limit: 2,
      day: '2026-11-27',
    });
    expect(await limiter.consume()).toEqual({
      allowed: true,
      count: 2,
      limit: 2,
      day: '2026-11-27',
    });
    expect(await limiter.consume()).toEqual({
      allowed: false,
      count: 2,
      limit: 2,
      day: '2026-11-27',
    });

    currentTime = new Date('2026-11-28T00:00:01.000Z');
    expect(await limiter.consume()).toEqual({
      allowed: true,
      count: 1,
      limit: 2,
      day: '2026-11-28',
    });
  });

  it('blocks immediately when limit is 0 and supports custom shared stores', async () => {
    const zeroLimiter = createDailyCallQuotaLimiter({
      scope: 'google_places.discover',
      resolveLimit: () => 0,
      now: () => new Date('2026-11-27T10:00:00.000Z'),
    });
    expect(await zeroLimiter.consume()).toEqual({
      allowed: false,
      count: 0,
      limit: 0,
      day: '2026-11-27',
    });

    const consume = vi.fn(async () => ({ allowed: false, count: 200 }));
    const redisBacked = createDailyCallQuotaLimiter({
      scope: 'google_places.discover',
      resolveLimit: () => 200,
      store: { consume },
      now: () => new Date('2026-11-27T10:00:00.000Z'),
    });
    const res = await redisBacked.consume();
    expect(res.allowed).toBe(false);
    expect(consume).toHaveBeenCalledWith(
      'daily_quota:google_places.discover:2026-11-27',
      200,
      90_000,
    );

    const err = new DailyCallQuotaExceededError('GOOGLE_PLACES_DAILY_LIMIT_EXCEEDED', res);
    expect(err.code).toBe('GOOGLE_PLACES_DAILY_LIMIT_EXCEEDED');
    expect(err.message).toContain('200');
    expect(err.message).toContain('2026-11-27');
    expect(isExecutionControlError(err)).toBe(false);
  });

  it('prunes old UTC day buckets in memory so map size stays bounded', async () => {
    const store = createInMemoryDailyCallQuotaStore();
    for (let day = 1; day <= 12; day += 1) {
      const outcome = await store.consume(`daily_quota:test:2026-11-${String(day).padStart(2, '0')}`, 5, 90_000);
      expect(outcome).toEqual({ allowed: true, count: 1 });
    }
  });
});
