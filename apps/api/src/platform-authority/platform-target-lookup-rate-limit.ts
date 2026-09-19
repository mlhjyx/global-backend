import { createHash } from "node:crypto";

const UNAVAILABLE = "PLATFORM_AUTHORITY_TARGET_LOOKUP_UNAVAILABLE";
const MAX_RESOURCE_INTEGER = 2147483647;
const SCRIPT = `
local value = redis.call('GET', KEYS[1])
if value then
  if not string.match(value, '^%d+$') then return redis.error_reply('INVALID_COUNTER') end
  if redis.call('PTTL', KEYS[1]) < 0 then return redis.error_reply('INVALID_TTL') end
  local count = tonumber(value)
  if not count or count < 1 then return redis.error_reply('INVALID_COUNTER') end
  if count >= tonumber(ARGV[1]) then return 0 end
end
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return 1
`;

export interface PlatformTargetLookupRateLimiter {
  allow(
    identity: { issuer: string; subject: string },
    deadlineAtMs: number,
  ): Promise<boolean>;
}
export interface PlatformTargetLookupRedisClient {
  eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
}
export class RedisPlatformTargetLookupRateLimiter implements PlatformTargetLookupRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly monotonicNow: () => number;
  constructor(
    private readonly client: PlatformTargetLookupRedisClient | null,
    options: { limit: number; windowMs: number; monotonicNow?: () => number },
  ) {
    this.limit = resource(options?.limit);
    this.windowMs = resource(options?.windowMs);
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }
  async allow(
    identity: { issuer: string; subject: string },
    deadlineAtMs: number,
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!this.client || !identity) return unavailable();
      const tuple = [
        identityPart(identity.issuer),
        identityPart(identity.subject),
      ];
      const now = this.monotonicNow();
      const remaining = deadlineAtMs - now;
      if (
        !Number.isFinite(now) ||
        !Number.isFinite(remaining) ||
        remaining < 1 ||
        remaining > 2000
      )
        return unavailable();
      const key = `platform-target-lookup:rate:v1:${createHash("sha256").update(JSON.stringify(tuple)).digest("hex")}`;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(UNAVAILABLE)),
          Math.floor(remaining),
        );
      });
      // An unknown ACK may have counted. Never refund, retry, or fall back locally.
      const result = await Promise.race([
        this.client.eval(SCRIPT, 1, key, this.limit, this.windowMs),
        timeout,
      ]);
      const observed = this.monotonicNow();
      if (
        !Number.isFinite(observed) ||
        observed >= deadlineAtMs ||
        observed < now ||
        (result !== 0 && result !== 1)
      )
        return unavailable();
      return result === 1;
    } catch {
      throw new Error(UNAVAILABLE);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
function unavailable(): never {
  throw new Error(UNAVAILABLE);
}
function resource(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_RESOURCE_INTEGER)
    return unavailable();
  return value;
}
function identityPart(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    Buffer.byteLength(value, "utf8") > 16384
  )
    return unavailable();
  return value;
}
