import { describe, expect, it } from 'vitest';
import {
  computeTenantToolShare,
  DEFAULT_TENANT_TOOL_SHARE_RATIO,
  RateLimitAcquireTimeoutError,
  RedisRateLimitStore,
  tenantToolLimitNamespace,
  type RedisScriptClient,
} from './redis-rate-limit-store';

/**
 * In-memory emulator of the Lua token-bucket + concurrency-lease scripts used
 * by `RedisRateLimitStore`, faithfully tracking `{ns:tool}:bucket` & `:leases`
 * so two-tier unit tests prove zero tenant-lease leak on global contention.
 */
class InMemoryRateLimitRedis implements RedisScriptClient {
  private readonly buckets = new Map<string, { tokens: number; lastRefill: number }>();
  private readonly leases = new Map<string, Map<string, number>>();
  private clockMs = 1_700_000_000_000;

  advance(ms: number): void {
    this.clockMs += ms;
  }

  async eval(
    script: string,
    numKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown> {
    const keys = args.slice(0, numKeys).map(String);
    const argv = args.slice(numKeys).map(String);

    if (numKeys === 1 && script.includes('ZREM')) {
      const leasesKey = keys[0]!;
      const leaseId = argv[0]!;
      const map = this.leases.get(leasesKey);
      if (!map || !map.has(leaseId)) return 0;
      map.delete(leaseId);
      return 1;
    }

    if (numKeys === 1 && script.includes('ZSCORE')) {
      const leasesKey = keys[0]!;
      const leaseId = argv[0]!;
      const leaseMs = Number(argv[1]);
      const map = this.leases.get(leasesKey);
      if (!map || !map.has(leaseId)) return 0;
      map.set(leaseId, this.clockMs + leaseMs);
      return 1;
    }

    const [bucketKey, leasesKey] = keys as [string, string];
    const rps = Number(argv[0]);
    const concurrency = Number(argv[1]);
    const leaseMs = Number(argv[2]);
    const leaseId = argv[3]!;

    const leaseMap = this.leases.get(leasesKey) ?? new Map<string, number>();
    for (const [id, exp] of leaseMap.entries()) {
      if (exp <= this.clockMs) leaseMap.delete(id);
    }
    this.leases.set(leasesKey, leaseMap);

    const state = this.buckets.get(bucketKey) ?? { tokens: rps, lastRefill: this.clockMs };
    if (this.clockMs > state.lastRefill) {
      state.tokens = Math.min(rps, state.tokens + ((this.clockMs - state.lastRefill) / 1000) * rps);
      state.lastRefill = this.clockMs;
    }

    if (state.tokens >= 1 && leaseMap.size < concurrency) {
      state.tokens -= 1;
      this.buckets.set(bucketKey, state);
      leaseMap.set(leaseId, this.clockMs + leaseMs);
      return [1, leaseId, 0];
    }

    this.buckets.set(bucketKey, state);
    return [0, '', 50];
  }

  activeLeases(namespace: string, toolId: string): number {
    return this.leases.get(`{${namespace}:${toolId}}:leases`)?.size ?? 0;
  }
}

describe('RedisRateLimitStore two-tier tenant isolation (M10-PR2 Block 1)', () => {
  it('computes per-tenant share <= 40% of global limit and always at least 1', () => {
    expect(DEFAULT_TENANT_TOOL_SHARE_RATIO).toBe(0.4);
    expect(computeTenantToolShare({ rps: 10, concurrency: 10 })).toEqual({ rps: 4, concurrency: 4 });
    expect(computeTenantToolShare({ rps: 10, concurrency: 5 })).toEqual({ rps: 4, concurrency: 2 });
    expect(computeTenantToolShare({ rps: 2, concurrency: 2 })).toEqual({ rps: 1, concurrency: 1 });
    expect(computeTenantToolShare({ rps: 1, concurrency: 1 })).toEqual({ rps: 1, concurrency: 1 });
    expect(computeTenantToolShare({ rps: 100, concurrency: 100 }, 0.25)).toEqual({
      rps: 25,
      concurrency: 25,
    });
  });

  it('caps noisy neighbor A at 40% concurrency while allowing neighbor B to acquire freely', async () => {
    const redis = new InMemoryRateLimitRedis();
    let now = 1_700_000_000_000;
    const store = new RedisRateLimitStore(redis, {
      tenantShareRatio: 0.4,
      acquireTimeoutMs: 30,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    // Global concurrency = 5 -> per-tenant cap = floor(5 * 0.4) = 2
    store.configure('crawl4ai.fetch', 50, 5);

    const releaseA1 = await store.acquire('crawl4ai.fetch', now, 'ws-alpha');
    const releaseA2 = await store.acquire('crawl4ai.fetch', now, 'ws-alpha');

    // 3rd concurrent request from ws-alpha hits its 40% tenant ceiling (2/5)
    await expect(
      store.acquire('crawl4ai.fetch', now, 'ws-alpha'),
    ).rejects.toBeInstanceOf(RateLimitAcquireTimeoutError);

    // Neighbor ws-beta still acquires 2 slots freely without starvation
    const releaseB1 = await store.acquire('crawl4ai.fetch', now, 'ws-beta');
    const releaseB2 = await store.acquire('crawl4ai.fetch', now, 'ws-beta');

    expect(redis.activeLeases(tenantToolLimitNamespace('ws-alpha'), 'crawl4ai.fetch')).toBe(2);
    expect(redis.activeLeases(tenantToolLimitNamespace('ws-beta'), 'crawl4ai.fetch')).toBe(2);
    expect(redis.activeLeases('global:tool-limit', 'crawl4ai.fetch')).toBe(4);

    // Idempotent double release clears both tenant and global leases cleanly
    await releaseA1();
    await releaseA1();
    expect(redis.activeLeases(tenantToolLimitNamespace('ws-alpha'), 'crawl4ai.fetch')).toBe(1);
    expect(redis.activeLeases('global:tool-limit', 'crawl4ai.fetch')).toBe(3);

    await releaseA2();
    await releaseB1();
    await releaseB2();
    expect(redis.activeLeases('global:tool-limit', 'crawl4ai.fetch')).toBe(0);
  });

  it('rolls back tenant lease without leaking when global bucket rejects', async () => {
    const redis = new InMemoryRateLimitRedis();
    let now = 1_700_000_000_000;
    const store = new RedisRateLimitStore(redis, {
      tenantShareRatio: 0.4,
      acquireTimeoutMs: 30,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    // Global concurrency = 2, tenant cap = max(1, floor(2 * 0.4)) = 1
    store.configure('searxng.search', 50, 2);

    const releaseA = await store.acquire('searxng.search', now, 'ws-a');
    const releaseB = await store.acquire('searxng.search', now, 'ws-b');

    // Global pool is now 2/2 full -> ws-c acquires tenant slot then times out on global
    await expect(
      store.acquire('searxng.search', now, 'ws-c'),
    ).rejects.toBeInstanceOf(RateLimitAcquireTimeoutError);

    // Tenant lease for ws-c MUST be rolled back to 0 so ws-c is never self-blocked
    expect(redis.activeLeases(tenantToolLimitNamespace('ws-c'), 'searxng.search')).toBe(0);
    expect(redis.activeLeases('global:tool-limit', 'searxng.search')).toBe(2);

    await releaseA();
    await releaseB();
  });

  it('skips tenant bucket for platform/empty workspaceId and preserves global-only semantics', async () => {
    const redis = new InMemoryRateLimitRedis();
    const store = new RedisRateLimitStore(redis, { tenantShareRatio: 0.4, acquireTimeoutMs: 30 });
    store.configure('platform.tool', 50, 3);

    const p1 = await store.acquire('platform.tool', Date.now(), 'platform');
    const p2 = await store.acquire('platform.tool', Date.now(), undefined);
    const p3 = await store.acquire('platform.tool', Date.now(), 'platform');
    expect(redis.activeLeases('global:tool-limit', 'platform.tool')).toBe(3);

    await p1();
    await p2();
    await p3();
    expect(redis.activeLeases('global:tool-limit', 'platform.tool')).toBe(0);
  });
});
