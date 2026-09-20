import type { ThrottlerStorage } from "@nestjs/throttler";
import { RedisHttpThrottlerStorage } from "../common/redis-http-throttler.storage";
import { revocationFailure } from "./platform-revocation-http.contract";

/** Shares the actual global Redis storage/atomic Lua implementation, with a
 * purpose-separated authenticated-issuer key. No in-memory fallback/refund. */
export class PlatformRevocationIssuerRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  constructor(
    private readonly storage: ThrottlerStorage,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    const integer = (value: string | undefined) =>
      value && /^[1-9][0-9]{0,9}$/.test(value) && Number(value) <= 2147483647
        ? Number(value)
        : 0;
    this.limit = integer(env.PLATFORM_REVOCATION_RATE_LIMIT);
    this.windowMs = integer(env.PLATFORM_REVOCATION_RATE_WINDOW_MS);
  }
  async allow(issuer: string): Promise<boolean> {
    if (
      !(this.storage instanceof RedisHttpThrottlerStorage) ||
      !this.limit ||
      !this.windowMs ||
      !issuer ||
      issuer.length > 2048
    )
      return revocationFailure();
    try {
      const result = await this.storage.increment(
        issuer,
        this.windowMs,
        this.limit,
        this.windowMs,
        "platform-revocation-authenticated-issuer-v1",
      );
      return !result.isBlocked;
    } catch {
      return revocationFailure();
    }
  }
}
