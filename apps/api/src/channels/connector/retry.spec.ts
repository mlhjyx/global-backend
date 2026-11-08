import { describe, expect, it } from 'vitest';
import { backoffDelayMs, isRetryableStatus, parseRetryAfterMs, runWithRetries } from './retry';

describe('退避与重试（AWS 原则：只重试瞬时错误、有上限、带抖动）', () => {
  it('isRetryableStatus：429/5xx 可重试，4xx 其它不可', () => {
    for (const status of [429, 500, 502, 503, 504]) expect(isRetryableStatus(status), String(status)).toBe(true);
    for (const status of [400, 401, 403, 404, 409, 422]) expect(isRetryableStatus(status), String(status)).toBe(false);
  });

  it('parseRetryAfterMs：秒数与 HTTP date 都支持，异常返回 null', () => {
    const now = Date.parse('2026-11-09T00:00:00Z');
    expect(parseRetryAfterMs('2', now)).toBe(2000);
    expect(parseRetryAfterMs('0', now)).toBe(0);
    expect(parseRetryAfterMs(new Date(now + 5000).toUTCString(), now)).toBe(5000);
    expect(parseRetryAfterMs('later', now)).toBeNull();
    expect(parseRetryAfterMs(undefined, now)).toBeNull();
  });

  it('backoffDelayMs：指数增长、30s 上限、抖动 ≤250ms', () => {
    expect(backoffDelayMs(1, { random: () => 0 })).toBe(1000);
    expect(backoffDelayMs(2, { random: () => 0 })).toBe(2000);
    expect(backoffDelayMs(3, { random: () => 0 })).toBe(4000);
    expect(backoffDelayMs(10, { random: () => 0 })).toBe(30_000);
    expect(backoffDelayMs(1, { random: () => 1 })).toBe(1250);
  });

  it('runWithRetries：最多 3 次尝试、累计等待上限、Retry-After 优先', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const result = await runWithRetries(
      async () => {
        attempts += 1;
        if (attempts === 1) return { status: 429 } as const;
        if (attempts === 2) return { status: 429, retryAfterMs: 0 } as const;
        return { status: 200 } as const;
      },
      {
        policy: { maxAttempts: 3, totalWaitCapMs: 60_000, respectRetryAfter: true },
        isRetryable: (result) => isRetryableStatus(result.status),
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        retryAfterOf: (result) => ('retryAfterMs' in result ? result.retryAfterMs : null),
        random: () => 0,
      },
    );
    expect(result.status).toBe(200);
    expect(attempts).toBe(3);
    // 第一次无 Retry-After → 指数退避 1000ms；第二次带 Retry-After: 0 → 不等待。
    expect(sleeps).toEqual([1000, 0]);
  });

  it('runWithRetries：不可重试结果立即返回；等待预算耗尽即停', async () => {
    let attempts = 0;
    const denied = await runWithRetries(
      async () => {
        attempts += 1;
        return { status: 401 } as const;
      },
      {
        policy: { maxAttempts: 3, totalWaitCapMs: 60_000, respectRetryAfter: true },
        isRetryable: (result) => isRetryableStatus(result.status),
        sleep: async () => undefined,
      },
    );
    expect(denied.status).toBe(401);
    expect(attempts).toBe(1);

    const capped = await runWithRetries(
      async () => ({ status: 503 }) as const,
      {
        policy: { maxAttempts: 10, totalWaitCapMs: 2500, respectRetryAfter: false },
        isRetryable: (result) => isRetryableStatus(result.status),
        sleep: async () => undefined,
        random: () => 0,
      },
    );
    expect(capped.status).toBe(503);
  });
});
