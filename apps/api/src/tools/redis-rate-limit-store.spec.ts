import { describe, expect, it, vi } from 'vitest';
import {
  RateLimitAcquireTimeoutError,
  RateLimitStoreUnavailableError,
  RedisRateLimitStore,
  UnavailableRateLimitStore,
  validateRedisConnectionUrl,
  type RedisScriptClient,
} from './redis-rate-limit-store';

function clientWith(results: unknown[]): RedisScriptClient & { eval: ReturnType<typeof vi.fn> } {
  return {
    eval: vi.fn(async () => results.shift()),
  };
}

function grantingClient(
  subsequentResults: unknown[],
): RedisScriptClient & { eval: ReturnType<typeof vi.fn> } {
  let acquired = false;
  return {
    eval: vi.fn(async (...args: Array<unknown>) => {
      if (!acquired) {
        acquired = true;
        return [1, args.at(-1), 0];
      }
      const result = subsequentResults.shift();
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

describe('validateRedisConnectionUrl', () => {
  it.each([
    'redis://127.0.0.1:6379/0',
    'redis://localhost:6379',
    'redis://[::1]:6379/1',
    'rediss://cache.example.test:6380/0',
    'rediss://user:secret@cache.example.test:6380/15',
  ])('accepts TLS Redis or a loopback plaintext URL: %s', (url) => {
    expect(validateRedisConnectionUrl(` ${url} `)).toBe(url);
  });

  it.each([
    'redis://cache.example.test:6379/0',
    'http://127.0.0.1:6379',
    'rediss://cache.example.test:6380/0?family=4',
    'rediss://cache.example.test:6380/0#fragment',
    'rediss://cache.example.test:6380/not-a-db',
    'rediss:///0',
  ])('rejects an unsafe or non-minimal Redis URL without echoing it: %s', (url) => {
    let thrown: unknown;
    try {
      validateRedisConnectionUrl(url);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RateLimitStoreUnavailableError);
    expect(thrown).toMatchObject({ code: 'RATE_LIMIT_STORE_UNAVAILABLE' });
    expect(String((thrown as Error).message)).not.toContain(url);
  });
});

describe('RedisRateLimitStore', () => {
  it('uses one atomic Redis decision and releases the exact lease', async () => {
    const client = grantingClient([1]);
    const store = new RedisRateLimitStore(client, {
      namespace: 'test',
      sleep: async () => undefined,
      leaseMs: 30_000,
      acquireTimeoutMs: 100,
    });

    store.configure('crawl4ai.fetch', 2, 3);
    const release = await store.acquire('crawl4ai.fetch');
    expect(client.eval).toHaveBeenCalledTimes(1);
    const grantedLeaseId = String(client.eval.mock.calls[0]?.at(-1));
    await release();
    expect(client.eval).toHaveBeenCalledTimes(2);
    expect(client.eval.mock.calls[1]?.join(' ')).toContain(grantedLeaseId);
  });

  it('fails closed after the bounded wait instead of eventually allowing', async () => {
    const client = clientWith([[0, '', 500], [0, '', 500]]);
    let now = 0;
    const store = new RedisRateLimitStore(client, {
      namespace: 'test',
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
      acquireTimeoutMs: 100,
    });

    store.configure('searxng.search', 1, 1);
    await expect(store.acquire('searxng.search')).rejects.toBeInstanceOf(
      RateLimitAcquireTimeoutError,
    );
  });

  it('serializes domain delays using Redis rather than process memory', async () => {
    const client = clientWith([125]);
    const sleep = vi.fn(async () => undefined);
    const store = new RedisRateLimitStore(client, { namespace: 'test', sleep });
    await store.respectDomainDelay('example.com', 2_000);
    expect(sleep).toHaveBeenCalledWith(125);
  });

  it('validates configuration and treats Redis failures as unavailable', async () => {
    const leakedUrl = 'rediss://user:super-secret@redis.internal:6380/0';
    const client: RedisScriptClient = { eval: vi.fn(async () => { throw new Error(`offline ${leakedUrl}`); }) };
    const store = new RedisRateLimitStore(client);
    expect(() => store.configure('bad', 0, 1)).toThrow(TypeError);
    store.configure('searxng.search', 1, 1);
    const failed = store.acquire('searxng.search');
    await expect(failed).rejects.toMatchObject({
      code: 'RATE_LIMIT_STORE_UNAVAILABLE',
      message: 'Redis rate-limit acquire unavailable',
    });
    await expect(failed).rejects.not.toThrow(leakedUrl);
    await expect(store.acquire('missing')).rejects.toMatchObject({ code: 'RATE_LIMIT_STORE_UNAVAILABLE' });
  });

  it.each([
    [['bad']],
    [[2, '', 0]],
    [['1', '', 0]],
    [[1, 'attacker-selected-lease', 0]],
    [[0, 'unexpected-lease', 1]],
    [[0, '', -1]],
    [[0, '', 1.5]],
    [[0, '', 1_001]],
    [[0, '', Number.MAX_SAFE_INTEGER + 1]],
  ])('rejects a malformed or forged Redis acquire decision: %j', async (response) => {
    const store = new RedisRateLimitStore(clientWith(response));
    store.configure('searxng.search', 1, 1);
    await expect(store.acquire('searxng.search')).rejects.toMatchObject({
      code: 'RATE_LIMIT_STORE_UNAVAILABLE',
      message: 'Redis rate-limit protocol response invalid',
    });
  });

  it('rejects malformed domain inputs and responses', async () => {
    const store = new RedisRateLimitStore(clientWith([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]));
    await expect(store.respectDomainDelay('bad domain', 10)).rejects.toBeInstanceOf(TypeError);
    await expect(store.respectDomainDelay('example.com', 10)).resolves.toBeUndefined();
    await expect(store.respectDomainDelay('example.com', 10)).rejects.toMatchObject({ code: 'RATE_LIMIT_STORE_UNAVAILABLE' });
    await expect(store.respectDomainDelay('example.com', 10)).rejects.toMatchObject({ code: 'RATE_LIMIT_STORE_UNAVAILABLE' });
    await expect(store.respectDomainDelay('example.com', 10)).rejects.toMatchObject({ code: 'RATE_LIMIT_STORE_UNAVAILABLE' });
  });

  it('makes release idempotent within the process', async () => {
    const client = grantingClient([1]);
    const store = new RedisRateLimitStore(client);
    store.configure('crawl4ai.fetch', 1, 1);
    const release = await store.acquire('crawl4ai.fetch');
    await release();
    await release();
    expect(client.eval).toHaveBeenCalledTimes(2);
  });

  it('renews a live concurrency lease until the caller releases it', async () => {
    vi.useFakeTimers();
    try {
      const client = grantingClient([1, 1]);
      const store = new RedisRateLimitStore(client, { leaseMs: 3_000 });
      store.configure('crawl4ai.fetch', 1, 1);

      const release = await store.acquire('crawl4ai.fetch');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(client.eval).toHaveBeenCalledTimes(2);
      const grantedLeaseId = String(client.eval.mock.calls[0]?.at(-1));
      expect(client.eval.mock.calls[1]?.join(' ')).toContain(grantedLeaseId);
      await release();
      expect(client.eval).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a lost renewal with a stable redacted error after releasing the lease', async () => {
    vi.useFakeTimers();
    try {
      const client = grantingClient([0, 1]);
      const store = new RedisRateLimitStore(client, { leaseMs: 3_000 });
      store.configure('crawl4ai.fetch', 1, 1);

      const release = await store.acquire('crawl4ai.fetch');
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(release()).rejects.toMatchObject({
        code: 'RATE_LIMIT_STORE_UNAVAILABLE',
        message: 'Redis rate-limit concurrency lease lost',
      });
      expect(client.eval).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('redacts renewal transport errors and still attempts exact release', async () => {
    vi.useFakeTimers();
    try {
      const leakedUrl = 'rediss://user:renew-secret@redis.internal:6380/0';
      const client = grantingClient([new Error(leakedUrl), 1]);
      const store = new RedisRateLimitStore(client, { leaseMs: 3_000 });
      store.configure('crawl4ai.fetch', 1, 1);

      const release = await store.acquire('crawl4ai.fetch');
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(release()).rejects.toMatchObject({
        code: 'RATE_LIMIT_STORE_UNAVAILABLE',
        message: 'Redis rate-limit renewal unavailable',
      });
      expect(client.eval).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([2, '1', null])('rejects a malformed renewal response: %j', async (response) => {
    vi.useFakeTimers();
    try {
      const client = grantingClient([response, 1]);
      const store = new RedisRateLimitStore(client, { leaseMs: 3_000 });
      store.configure('crawl4ai.fetch', 1, 1);

      const release = await store.acquire('crawl4ai.fetch');
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(release()).rejects.toMatchObject({
        code: 'RATE_LIMIT_STORE_UNAVAILABLE',
        message: 'Redis rate-limit renewal response invalid',
      });
      expect(client.eval).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([0, 2, '1', null])('rejects a non-acknowledging release response: %j', async (response) => {
    const client = grantingClient([response]);
    const store = new RedisRateLimitStore(client);
    store.configure('crawl4ai.fetch', 1, 1);
    const release = await store.acquire('crawl4ai.fetch');
    await expect(release()).rejects.toMatchObject({
      code: 'RATE_LIMIT_STORE_UNAVAILABLE',
      message: 'Redis rate-limit release response invalid',
    });
  });

  it('redacts release transport errors', async () => {
    const secretUrl = 'rediss://user:release-secret@redis.internal:6380/0';
    const client = grantingClient([]);
    const store = new RedisRateLimitStore(client);
    store.configure('crawl4ai.fetch', 1, 1);
    const release = await store.acquire('crawl4ai.fetch');
    client.eval.mockRejectedValueOnce(new Error(secretUrl));
    await expect(release()).rejects.toMatchObject({
      code: 'RATE_LIMIT_STORE_UNAVAILABLE',
      message: 'Redis rate-limit release unavailable',
    });
    await expect(release()).resolves.toBeUndefined();
  });

  it('redacts domain-delay transport errors', async () => {
    const secretUrl = 'rediss://user:delay-secret@redis.internal:6380/0';
    const client: RedisScriptClient = { eval: vi.fn(async () => { throw new Error(secretUrl); }) };
    const store = new RedisRateLimitStore(client);
    await expect(store.respectDomainDelay('example.com', 10)).rejects.toMatchObject({
      code: 'RATE_LIMIT_STORE_UNAVAILABLE',
      message: 'Redis domain-delay reservation unavailable',
    });
  });
});

describe('UnavailableRateLimitStore', () => {
  it('rejects acquisition when Redis is not configured', async () => {
    const store = new UnavailableRateLimitStore('redis not configured');
    await expect(store.acquire('searxng.search')).rejects.toMatchObject({
      code: 'RATE_LIMIT_STORE_UNAVAILABLE',
    });
  });

  it('also rejects domain-delay admission', async () => {
    const store = new UnavailableRateLimitStore();
    await expect(store.respectDomainDelay('example.com', 10)).rejects.toMatchObject({
      code: 'RATE_LIMIT_STORE_UNAVAILABLE',
    });
  });
});
