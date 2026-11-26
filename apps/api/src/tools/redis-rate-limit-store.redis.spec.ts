import { describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import {
  RateLimitAcquireTimeoutError,
  RedisRateLimitStore,
  tenantToolLimitNamespace,
} from './redis-rate-limit-store';

const TEST_REDIS_URL = process.env.TEST_REDIS_URL?.trim();

describe.skipIf(!TEST_REDIS_URL)(
  'RedisRateLimitStore real isolated Redis integration (M10-PR2 Block 1)',
  () => {
    it('enforces 40% tenant concurrency share, global rollback, and 200mb maxmemory on real Redis', async () => {
      const client = new Redis(TEST_REDIS_URL!);
      try {
        await client.flushdb();
        const maxmem = (await client.config('GET', 'maxmemory')) as string[];
        expect(Number(maxmem[1])).toBe(200 * 1024 * 1024);

        const store = new RedisRateLimitStore(client, {
          tenantShareRatio: 0.4,
          acquireTimeoutMs: 120,
        });
        // Global concurrency = 5 -> per-tenant cap = floor(5 * 0.4) = 2
        store.configure('crawl4ai.fetch', 50, 5);

        const a1 = await store.acquire('crawl4ai.fetch', Date.now(), 'ws-noisy');
        const a2 = await store.acquire('crawl4ai.fetch', Date.now(), 'ws-noisy');
        await expect(
          store.acquire('crawl4ai.fetch', Date.now(), 'ws-noisy'),
        ).rejects.toBeInstanceOf(RateLimitAcquireTimeoutError);

        // Neighbor acquires freely while noisy tenant is capped
        const b1 = await store.acquire('crawl4ai.fetch', Date.now(), 'ws-neighbor');
        const b2 = await store.acquire('crawl4ai.fetch', Date.now(), 'ws-neighbor');
        const c1 = await store.acquire('crawl4ai.fetch', Date.now(), 'ws-third');

        // Global bucket is now at 5/5 -> ws-fourth fails global and MUST roll back its tenant lease
        await expect(
          store.acquire('crawl4ai.fetch', Date.now(), 'ws-fourth'),
        ).rejects.toBeInstanceOf(RateLimitAcquireTimeoutError);

        const fourthLeases = await client.zcard(
          `{${tenantToolLimitNamespace('ws-fourth')}:crawl4ai.fetch}:leases`,
        );
        expect(fourthLeases).toBe(0);

        await a1();
        await a2();
        await b1();
        await b2();
        await c1();

        expect(await client.zcard('{global:tool-limit:crawl4ai.fetch}:leases')).toBe(0);
      } finally {
        await client.quit();
      }
    });
  },
);
