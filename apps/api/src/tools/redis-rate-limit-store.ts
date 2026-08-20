import { randomUUID } from 'node:crypto';
import type { RateLimitSpec, RateLimitStore } from './rate-limiter';

export interface RedisScriptClient {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

export class RateLimitStoreUnavailableError extends Error {
  readonly code = 'RATE_LIMIT_STORE_UNAVAILABLE';

  constructor(reason = 'authoritative rate-limit store unavailable') {
    super(reason);
    this.name = 'RateLimitStoreUnavailableError';
  }
}

export class RateLimitAcquireTimeoutError extends Error {
  readonly code = 'RATE_LIMIT_ACQUIRE_TIMEOUT';

  constructor(public readonly toolId: string) {
    super(`rate-limit acquisition timed out for ${toolId}`);
    this.name = 'RateLimitAcquireTimeoutError';
  }
}

const REDIS_CONFIG_INVALID_MESSAGE = 'Redis rate-limit configuration invalid';
const REDIS_PROTOCOL_INVALID_MESSAGE = 'Redis rate-limit protocol response invalid';
const MAX_ACQUIRE_WAIT_MS = 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function isLoopbackRedisHost(hostname: string): boolean {
  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

/**
 * Validates the single Redis connection contract shared by managed readiness
 * and product composition. Credentials may be carried as URL userinfo, but the
 * value is never interpolated into an error. Remote plaintext, query options,
 * fragments, and non-numeric database paths are deliberately outside the
 * minimal managed-runtime contract.
 */
export function validateRedisConnectionUrl(value: string): string {
  const configured = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new RateLimitStoreUnavailableError(REDIS_CONFIG_INVALID_MESSAGE);
  }
  const databasePathValid =
    parsed.pathname === '' ||
    parsed.pathname === '/' ||
    (/^\/(?:0|[1-9][0-9]{0,4})$/u.test(parsed.pathname) && Number(parsed.pathname.slice(1)) <= 65_535);
  const transportValid =
    parsed.protocol === 'rediss:' ||
    (parsed.protocol === 'redis:' && isLoopbackRedisHost(parsed.hostname));
  if (
    !parsed.hostname ||
    !transportValid ||
    !databasePathValid ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new RateLimitStoreUnavailableError(REDIS_CONFIG_INVALID_MESSAGE);
  }
  return configured;
}

export class UnavailableRateLimitStore implements RateLimitStore {
  constructor(private readonly reason = 'authoritative rate-limit store unavailable') {}

  configure(): void {}

  async acquire(): Promise<() => Promise<void>> {
    throw new RateLimitStoreUnavailableError(this.reason);
  }

  async respectDomainDelay(): Promise<void> {
    throw new RateLimitStoreUnavailableError(this.reason);
  }
}

const ACQUIRE_SCRIPT = `
local now = redis.call('TIME')
local now_ms = now[1] * 1000 + math.floor(now[2] / 1000)
local rps = tonumber(ARGV[1])
local concurrency = tonumber(ARGV[2])
local lease_ms = tonumber(ARGV[3])
local lease_id = ARGV[4]
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now_ms)
local running = redis.call('ZCARD', KEYS[2])
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens') or rps)
local last_refill = tonumber(redis.call('HGET', KEYS[1], 'last_refill') or now_ms)
if now_ms > last_refill then
  tokens = math.min(rps, tokens + ((now_ms - last_refill) / 1000) * rps)
end
if tokens >= 1 and running < concurrency then
  tokens = tokens - 1
  redis.call('HSET', KEYS[1], 'tokens', tokens, 'last_refill', now_ms)
  redis.call('ZADD', KEYS[2], now_ms + lease_ms, lease_id)
  redis.call('PEXPIRE', KEYS[1], math.max(lease_ms * 2, 60000))
  redis.call('PEXPIRE', KEYS[2], math.max(lease_ms * 2, 60000))
  return {1, lease_id, 0}
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'last_refill', now_ms)
local token_wait = math.ceil((1 - math.min(tokens, 1)) * 1000 / rps)
local lease_wait = 50
if running >= concurrency then
  local first = redis.call('ZRANGE', KEYS[2], 0, 0, 'WITHSCORES')
  if first[2] then lease_wait = math.max(1, tonumber(first[2]) - now_ms) end
end
return {0, '', math.max(1, math.min(1000, math.max(token_wait, lease_wait)))}
`;

const RELEASE_SCRIPT = `return redis.call('ZREM', KEYS[1], ARGV[1])`;

const RENEW_SCRIPT = `
local now = redis.call('TIME')
local now_ms = now[1] * 1000 + math.floor(now[2] / 1000)
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[1], now_ms + tonumber(ARGV[2]), ARGV[1])
redis.call('PEXPIRE', KEYS[1], math.max(tonumber(ARGV[2]) * 2, 60000))
return 1
`;

const DOMAIN_DELAY_SCRIPT = `
local now = redis.call('TIME')
local now_ms = now[1] * 1000 + math.floor(now[2] / 1000)
local delay_ms = tonumber(ARGV[1])
local next_at = tonumber(redis.call('GET', KEYS[1]) or 0)
local assigned_at = math.max(now_ms, next_at)
redis.call('SET', KEYS[1], assigned_at + delay_ms, 'PX', math.max(delay_ms * 4, 60000))
return math.max(0, assigned_at - now_ms)
`;

function invalidProtocolResponse(message = REDIS_PROTOCOL_INVALID_MESSAGE): RateLimitStoreUnavailableError {
  return new RateLimitStoreUnavailableError(message);
}

function normalizeEvalArray(value: unknown, expectedLeaseId: string): [0 | 1, string, number] {
  if (!Array.isArray(value) || value.length !== 3) throw invalidProtocolResponse();
  const [allowed, grantedLeaseId, waitMs] = value;
  if (
    (allowed !== 0 && allowed !== 1) ||
    typeof grantedLeaseId !== 'string' ||
    typeof waitMs !== 'number' ||
    !Number.isSafeInteger(waitMs) ||
    waitMs < 0 ||
    waitMs > MAX_ACQUIRE_WAIT_MS
  ) {
    throw invalidProtocolResponse();
  }
  if (
    (allowed === 1 && (grantedLeaseId !== expectedLeaseId || waitMs !== 0)) ||
    (allowed === 0 && grantedLeaseId !== '')
  ) {
    throw invalidProtocolResponse();
  }
  return [allowed, grantedLeaseId, waitMs];
}

function normalizeTimerDelay(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_TIMER_DELAY_MS
  ) {
    throw invalidProtocolResponse('Redis domain-delay response invalid');
  }
  return value;
}

export class RedisRateLimitStore implements RateLimitStore {
  private readonly specs = new Map<string, RateLimitSpec>();
  private readonly namespace: string;
  private readonly leaseMs: number;
  private readonly acquireTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly client: RedisScriptClient,
    options?: {
      namespace?: string;
      leaseMs?: number;
      acquireTimeoutMs?: number;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
    },
  ) {
    this.namespace = options?.namespace ?? 'global:tool-limit';
    this.leaseMs = options?.leaseMs ?? 30_000;
    this.acquireTimeoutMs = options?.acquireTimeoutMs ?? 30_000;
    this.sleep = options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))));
    this.now = options?.now ?? Date.now;
  }

  configure(toolId: string, rps: number, concurrency: number): void {
    if (!Number.isFinite(rps) || rps <= 0 || !Number.isInteger(concurrency) || concurrency <= 0) {
      throw new TypeError(`invalid rate-limit configuration for ${toolId}`);
    }
    this.specs.set(toolId, { rps, concurrency });
  }

  async acquire(toolId: string, _nowMs?: number): Promise<() => Promise<void>> {
    const spec = this.specs.get(toolId);
    if (!spec) throw new RateLimitStoreUnavailableError(`rate-limit configuration missing for ${toolId}`);
    const started = this.now();
    const tag = `{${this.namespace}:${toolId}}`;
    const bucketKey = `${tag}:bucket`;
    const leasesKey = `${tag}:leases`;
    while (this.now() - started <= this.acquireTimeoutMs) {
      const leaseId = randomUUID();
      let response: unknown;
      try {
        response = await this.client.eval(
          ACQUIRE_SCRIPT,
          2,
          bucketKey,
          leasesKey,
          spec.rps,
          spec.concurrency,
          this.leaseMs,
          leaseId,
        );
      } catch {
        throw new RateLimitStoreUnavailableError('Redis rate-limit acquire unavailable');
      }
      const [allowed, grantedLeaseId, waitMs] = normalizeEvalArray(response, leaseId);
      if (allowed === 1 && grantedLeaseId) {
        let released = false;
        let renewalError: RateLimitStoreUnavailableError | undefined;
        let renewalInFlight: Promise<void> | undefined;
        const renewalIntervalMs = Math.max(1_000, Math.floor(this.leaseMs / 3));
        const renewalTimer = setInterval(() => {
          if (released || renewalError || renewalInFlight) return;
          renewalInFlight = this.client
            .eval(RENEW_SCRIPT, 1, leasesKey, grantedLeaseId, this.leaseMs)
            .then((renewed) => {
              if (renewed === 0) throw new RateLimitStoreUnavailableError('Redis rate-limit concurrency lease lost');
              if (renewed !== 1) throw invalidProtocolResponse('Redis rate-limit renewal response invalid');
            })
            .catch((error: unknown) => {
              renewalError =
                error instanceof RateLimitStoreUnavailableError
                  ? error
                  : new RateLimitStoreUnavailableError('Redis rate-limit renewal unavailable');
            })
            .finally(() => {
              renewalInFlight = undefined;
            });
        }, renewalIntervalMs);
        renewalTimer.unref?.();
        return async () => {
          if (released) return;
          released = true;
          clearInterval(renewalTimer);
          await renewalInFlight;
          let releasedLease: unknown;
          try {
            releasedLease = await this.client.eval(RELEASE_SCRIPT, 1, leasesKey, grantedLeaseId);
          } catch {
            throw new RateLimitStoreUnavailableError('Redis rate-limit release unavailable');
          }
          if (releasedLease !== 1) throw invalidProtocolResponse('Redis rate-limit release response invalid');
          if (renewalError) throw renewalError;
        };
      }
      if (this.now() - started + waitMs > this.acquireTimeoutMs) break;
      await this.sleep(Math.max(1, waitMs));
    }
    throw new RateLimitAcquireTimeoutError(toolId);
  }

  async respectDomainDelay(domain: string, delayMs: number): Promise<void> {
    if (!delayMs) return;
    if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw new TypeError('delayMs must be a non-negative integer');
    const normalized = domain.trim().toLowerCase();
    if (!normalized || normalized.length > 253 || !/^[a-z0-9.-]+$/u.test(normalized)) {
      throw new TypeError('invalid rate-limit domain');
    }
    let wait: unknown;
    try {
      wait = await this.client.eval(DOMAIN_DELAY_SCRIPT, 1, `${this.namespace}:domain:${normalized}`, delayMs);
    } catch {
      throw new RateLimitStoreUnavailableError('Redis domain-delay reservation unavailable');
    }
    const waitMs = normalizeTimerDelay(wait);
    if (waitMs > 0) await this.sleep(waitMs);
  }
}
