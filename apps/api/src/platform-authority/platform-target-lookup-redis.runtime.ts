import Redis, { type RedisOptions } from "ioredis";
import {
  RedisPlatformTargetLookupRateLimiter,
  type PlatformTargetLookupRateLimiter,
  type PlatformTargetLookupRedisClient,
} from "./platform-target-lookup-rate-limit";
const UNAVAILABLE = "PLATFORM_AUTHORITY_TARGET_LOOKUP_UNAVAILABLE";
function unavailable(): never {
  throw new Error(UNAVAILABLE);
}
function integer(value: string | undefined): number {
  if (!value || !/^[1-9][0-9]{0,9}$/.test(value) || Number(value) > 2147483647)
    return unavailable();
  return Number(value);
}
function configuration(env: Record<string, string | undefined>) {
  try {
    const url = env.REDIS_URL;
    if (
      !url ||
      url.length > 16384 ||
      /\s/.test(url) ||
      [...url].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      return null;
    const parsed = new URL(url);
    if (
      !["redis:", "rediss:"].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.hash ||
      parsed.search ||
      !/^\/(?:0|[1-9][0-9]{0,9})?$/.test(parsed.pathname || "/") ||
      Number(parsed.pathname.slice(1)) > 2147483647
    )
      return null;
    return {
      url,
      secure: parsed.protocol === "rediss:",
      limit: integer(env.PLATFORM_AUTHORITY_TARGET_LOOKUP_RATE_LIMIT),
      windowMs: integer(env.PLATFORM_AUTHORITY_TARGET_LOOKUP_RATE_WINDOW_MS),
    };
  } catch {
    return null;
  }
}
export interface LookupRedisConnection extends PlatformTargetLookupRedisClient {
  connect(): Promise<unknown>;
  ping(): Promise<unknown>;
  disconnect(): void;
  on(event: "error", listener: () => void): unknown;
}
export type LookupRedisFactory = (
  url: string,
  options: RedisOptions,
) => LookupRedisConnection;
const defaultFactory: LookupRedisFactory = (url, options) =>
  new Redis(url, options);
export class PlatformTargetLookupRedisRuntime implements PlatformTargetLookupRateLimiter {
  private readonly config: ReturnType<typeof configuration>;
  private readonly active = new Set<{ stop: () => void }>();
  private destroyed = false;
  constructor(
    env: Record<string, string | undefined>,
    private readonly factory: LookupRedisFactory = defaultFactory,
    private readonly monotonicNow: () => number = () => performance.now(),
  ) {
    this.config = configuration(env);
  }
  async allow(
    identity: { issuer: string; subject: string },
    deadlineAtMs: number,
  ): Promise<boolean> {
    return this.withConnection(deadlineAtMs, (client) =>
      new RedisPlatformTargetLookupRateLimiter(client, {
        limit: this.config!.limit,
        windowMs: this.config!.windowMs,
        monotonicNow: this.monotonicNow,
      }).allow(identity, deadlineAtMs),
    );
  }
  async readiness(deadlineAtMs: number): Promise<boolean> {
    try {
      return await this.withConnection(deadlineAtMs, async (client, guard) => {
        if ((await client.ping()) !== "PONG") return unavailable();
        guard();
        return (await client.eval("return 1", 0)) === 1;
      });
    } catch {
      return false;
    }
  }
  onModuleDestroy(): void {
    this.destroyed = true;
    for (const handle of this.active) handle.stop();
  }
  private async withConnection(
    deadline: number,
    operation: (
      client: LookupRedisConnection,
      guard: () => void,
    ) => Promise<boolean>,
  ): Promise<boolean> {
    let client: LookupRedisConnection | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let handle: { stop: () => void } | undefined;
    let finished = false;
    let disconnected = false;
    let initial = Number.NaN;
    const guard = () => {
      const now = this.monotonicNow();
      const remaining = deadline - now;
      if (
        finished ||
        this.destroyed ||
        !this.config ||
        !Number.isFinite(initial) ||
        !Number.isFinite(now) ||
        now < initial ||
        !Number.isFinite(remaining) ||
        remaining < 1 ||
        remaining > 2000
      )
        return unavailable();
      return Math.floor(remaining);
    };
    const close = () => {
      if (!disconnected && client) {
        disconnected = true;
        try {
          client.disconnect();
        } catch {
          /* No secret-bearing close diagnostics. */
        }
      }
    };
    try {
      initial = this.monotonicNow();
      const budget = guard();
      client = this.factory(this.config!.url, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
        reconnectOnError: () => false,
        autoResendUnfulfilledCommands: false,
        connectTimeout: budget,
        commandTimeout: budget,
        ...(this.config!.secure ? { tls: { rejectUnauthorized: true } } : {}),
      });
      // ioredis otherwise prints unhandled connection diagnostics, including URLs.
      client.on("error", () => {});
      const stopped = new Promise<never>((_resolve, reject) => {
        handle = {
          stop: () => {
            finished = true;
            close();
            reject(new Error(UNAVAILABLE));
          },
        };
        this.active.add(handle);
        timer = setTimeout(handle.stop, guard());
      });
      const connected = client;
      const work = async () => {
        guard();
        await connected.connect();
        guard();
        const result = await operation(connected, guard);
        guard();
        return result;
      };
      const result = await Promise.race([work(), stopped]);
      guard();
      return result;
    } catch {
      throw new Error(UNAVAILABLE);
    } finally {
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      if (handle) this.active.delete(handle);
      close();
    }
  }
}
