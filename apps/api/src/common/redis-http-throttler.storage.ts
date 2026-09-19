import { ServiceUnavailableException } from "@nestjs/common";
import type { ThrottlerStorage } from "@nestjs/throttler";
import { createHash, randomUUID } from "node:crypto";
import Redis, { type RedisOptions } from "ioredis";

const DEADLINE_MS = 500;
const MAX_INTEGER = 2147483647;
// Nest 6.5 counts each hit for its own ttl, independently of the reset header.
// The limit+1 hit starts a block; blocked requests never extend it. On block
// expiry only this key's hits are reset (never another tracker's timers).
const INCREMENT = `
local hits = KEYS[1]
local state = KEYS[2]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local duration = tonumber(ARGV[3])
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local hitType = redis.call('TYPE', hits).ok
local stateType = redis.call('TYPE', state).ok
if (hitType ~= 'none' and hitType ~= 'zset') or (stateType ~= 'none' and stateType ~= 'hash') then
  return redis.error_reply('INVALID_THROTTLE_STATE')
end
if (hitType ~= 'none' and redis.call('PTTL', hits) < 0) or
   (stateType ~= 'none' and redis.call('PTTL', state) < 0) or
   (hitType ~= 'none' and stateType == 'none') then
  return redis.error_reply('INVALID_THROTTLE_TTL')
end
local resetAt = now + ttl
local blockedUntil = 0
if stateType ~= 'none' then
  local fields = redis.call('HMGET', state, 'resetAt', 'blockedUntil')
  resetAt = tonumber(fields[1])
  blockedUntil = tonumber(fields[2])
  if not resetAt or not blockedUntil or resetAt < 0 or blockedUntil < 0 then
    return redis.error_reply('INVALID_THROTTLE_STATE')
  end
end
if resetAt <= now then resetAt = now + ttl end
redis.call('ZREMRANGEBYSCORE', hits, '-inf', now)
if blockedUntil > 0 and blockedUntil <= now then
  redis.call('DEL', hits)
  blockedUntil = 0
end
local count = redis.call('ZCARD', hits)
if blockedUntil == 0 then
  redis.call('ZADD', hits, now + ttl, ARGV[4])
  count = count + 1
  if count > limit then blockedUntil = now + duration end
end
redis.call('HSET', state, 'resetAt', resetAt, 'blockedUntil', blockedUntil)
local last = redis.call('ZREVRANGE', hits, 0, 0, 'WITHSCORES')
local expires = math.max(resetAt, blockedUntil, tonumber(last[2]) or 0)
redis.call('PEXPIREAT', state, expires)
redis.call('PEXPIREAT', hits, expires)
return {count, math.ceil((resetAt - now) / 1000), blockedUntil > now and 1 or 0,
  math.max(0, math.ceil((blockedUntil - now) / 1000))}
`;
export interface HttpThrottleRedisConnection {
  readonly status: string;
  connect(): Promise<unknown>;
  eval(
    script: string,
    count: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
  disconnect(): void;
  on(event: "error", listener: () => void): unknown;
}
export class RedisHttpThrottlerStorage implements ThrottlerStorage {
  private readonly url: string | null;
  private record?: {
    client: HttpThrottleRedisConnection;
    ready: Promise<unknown>;
  };
  private destroyed = false;
  constructor(
    env: Record<string, string | undefined>,
    private readonly factory: (
      url: string,
      options: RedisOptions,
    ) => HttpThrottleRedisConnection = (url, options) =>
      new Redis(url, options),
  ) {
    this.url = redisUrl(env.REDIS_URL);
  }
  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    name: string,
  ) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let record: typeof this.record;
    const started = performance.now();
    try {
      if (
        this.destroyed ||
        !this.url ||
        !validPart(key) ||
        !validPart(name) ||
        ![ttl, limit, blockDuration].every(validInteger)
      )
        throw unavailable();
      record = this.connection();
      const active = record;
      const digest = createHash("sha256")
        .update(JSON.stringify([name, key]))
        .digest("hex");
      const prefix = `http-throttle:v1:{${digest}}`;
      const work = async () => {
        await active.ready;
        if (this.destroyed || this.record !== active) throw unavailable();
        return active.client.eval(
          INCREMENT,
          2,
          `${prefix}:hits`,
          `${prefix}:state`,
          ttl,
          limit,
          blockDuration,
          randomUUID(),
        );
      };
      const result = await Promise.race([
        work(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(unavailable()), DEADLINE_MS);
        }),
      ]);
      if (
        this.destroyed ||
        performance.now() - started >= DEADLINE_MS ||
        !validResult(result)
      )
        throw unavailable();
      return {
        totalHits: result[0],
        timeToExpire: result[1],
        isBlocked: result[2] === 1,
        timeToBlockExpire: result[3],
      };
    } catch {
      // The atomic write may have committed. Do not refund or automatically replay.
      if (record) this.close(record);
      throw unavailable();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  onApplicationShutdown(): void {
    this.destroyed = true;
    if (this.record) this.close(this.record);
  }
  private connection() {
    if (this.record && !["end", "close"].includes(this.record.client.status))
      return this.record;
    if (this.record) this.close(this.record);
    const client = this.factory(this.url!, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      reconnectOnError: () => false,
      autoResendUnfulfilledCommands: false,
      connectTimeout: DEADLINE_MS,
      commandTimeout: DEADLINE_MS,
      ...(this.url!.startsWith("rediss:")
        ? { tls: { rejectUnauthorized: true } }
        : {}),
    });
    // Never let ioredis print credentials or command contents on connection errors.
    client.on("error", () => {});
    const record = {
      client,
      ready:
        client.status === "ready"
          ? Promise.resolve()
          : Promise.resolve().then(() => {
              if (this.destroyed || this.record?.client !== client)
                throw unavailable();
              return client.connect();
            }),
    };
    this.record = record;
    return record;
  }
  private close(record: NonNullable<RedisHttpThrottlerStorage["record"]>) {
    if (this.record === record) this.record = undefined;
    try {
      record.client.disconnect();
    } catch {
      /* bounded unavailable, no diagnostics */
    }
  }
}
export function httpThrottlerOptions(env: Record<string, string | undefined>) {
  return {
    throttlers: [
      {
        ttl: Number(env.THROTTLE_TTL_MS) || 60_000,
        limit: Number(env.THROTTLE_LIMIT) || 300,
      },
    ],
    storage: new RedisHttpThrottlerStorage(env),
  };
}
function unavailable() {
  return new ServiceUnavailableException("HTTP_THROTTLE_UNAVAILABLE");
}
function validInteger(value: number) {
  return Number.isInteger(value) && value > 0 && value <= MAX_INTEGER;
}
function validPart(value: string) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 16384
  );
}
function validResult(
  value: unknown,
): value is [number, number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every(
      (item) => Number.isSafeInteger(item) && item >= 0 && item <= MAX_INTEGER,
    ) &&
    value[1] > 0 &&
    (value[2] === 0 || value[2] === 1) &&
    (value[2] === 1 ? value[3] > 0 : value[3] === 0 && value[0] > 0)
  );
}
function redisUrl(value: string | undefined): string | null {
  try {
    if (
      !value ||
      value.length > 16384 ||
      /\s/.test(value) ||
      [...value].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      return null;
    const url = new URL(value);
    return ["redis:", "rediss:"].includes(url.protocol) &&
      url.hostname &&
      !url.hash &&
      !url.search &&
      /^\/(?:0|[1-9][0-9]{0,9})?$/.test(url.pathname || "/") &&
      Number(url.pathname.slice(1)) <= MAX_INTEGER
      ? value
      : null;
  } catch {
    return null;
  }
}
