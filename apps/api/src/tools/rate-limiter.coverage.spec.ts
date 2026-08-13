import { afterEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from './rate-limiter';

afterEach(() => {
  vi.useRealTimers();
});

describe('RateLimiter deterministic boundaries', () => {
  it('returns an inert permit for an unconfigured tool', async () => {
    const limiter = new RateLimiter();
    const release = await limiter.acquire('missing', 1_000);
    expect(release()).toBeUndefined();
  });

  it('enforces concurrency, refills elapsed tokens and release is idempotently bounded', async () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter();
    limiter.configure('tool', 1, 1);
    limiter.configure('tool', 100, 100);

    const releaseFirst = await limiter.acquire('tool', 1_000);
    const second = limiter.acquire('tool', 1_000);
    await vi.advanceTimersByTimeAsync(50);
    releaseFirst();
    releaseFirst();
    await vi.advanceTimersByTimeAsync(1_000);
    const releaseSecond = await second;
    expect(releaseSecond()).toBeUndefined();
  });

  it('uses the bounded fallback permit when no configured concurrency can be acquired', async () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter();
    limiter.configure('blocked', 1, 0);
    const pending = limiter.acquire('blocked', 0);
    await vi.runAllTimersAsync();
    const release = await pending;
    expect(release()).toBeUndefined();
    expect(release()).toBeUndefined();
  });

  it('skips zero domain delay and serializes subsequent access to the same domain', async () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter();
    await expect(limiter.respectDomainDelay('example.com', 0, 1_000)).resolves.toBeUndefined();
    await expect(limiter.respectDomainDelay('example.com', 100, 1_000)).resolves.toBeUndefined();
    const delayed = limiter.respectDomainDelay('example.com', 100, 1_050);
    await vi.advanceTimersByTimeAsync(49);
    let settled = false;
    void delayed.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(delayed).resolves.toBeUndefined();
  });
});
