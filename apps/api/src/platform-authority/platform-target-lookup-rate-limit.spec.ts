import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { RedisPlatformTargetLookupRateLimiter } from "./platform-target-lookup-rate-limit";

const identity = {
  issuer: "https://growthos.example",
  subject: "control-plane",
};
const unavailable = "PLATFORM_AUTHORITY_TARGET_LOOKUP_UNAVAILABLE";
const options = { limit: 3, windowMs: 3000, monotonicNow: () => 100 };
describe("platform target lookup Redis limiter", () => {
  it.each([0, 1])(
    "maps only exact Redis result %s and sends bounded resource arguments",
    async (value) => {
      const evalCall = vi.fn().mockResolvedValue(value);
      const limiter = new RedisPlatformTargetLookupRateLimiter(
        { eval: evalCall },
        options,
      );
      expect(await limiter.allow(identity, 500)).toBe(value === 1);
      expect(evalCall).toHaveBeenCalledTimes(1);
      const [, count, key, limit, window] = evalCall.mock.calls[0];
      expect(count).toBe(1);
      expect(limit).toBe(3);
      expect(window).toBe(3000);
      expect(key).toMatch(/^platform-target-lookup:rate:v1:[0-9a-f]{64}$/);
      expect(key).not.toContain(identity.issuer);
      expect(key).not.toContain(identity.subject);
    },
  );
  it("keeps tuple boundaries and identities distinct with one stable hash per tuple", async () => {
    const evalCall = vi.fn().mockResolvedValue(1);
    const limiter = new RedisPlatformTargetLookupRateLimiter(
      { eval: evalCall },
      options,
    );
    for (const value of [
      identity,
      identity,
      { issuer: "a:b", subject: "c" },
      { issuer: "a", subject: "b:c" },
    ])
      await limiter.allow(value, 500);
    const keys = evalCall.mock.calls.map((call) => call[2]);
    expect(keys[0]).toBe(keys[1]);
    expect(new Set(keys).size).toBe(3);
  });
  it.each([undefined, null, 0, -1, 1.5, NaN, Infinity, 2147483648])(
    "rejects malformed resource configuration %s",
    async (value) => {
      for (const name of ["limit", "windowMs"]) {
        const evalCall = vi.fn().mockResolvedValue(1);
        expect(
          () =>
            new RedisPlatformTargetLookupRateLimiter({ eval: evalCall }, {
              ...options,
              [name]: value,
            } as never),
        ).toThrow(unavailable);
        expect(evalCall).not.toHaveBeenCalled();
      }
    },
  );
  it.each([
    null,
    {},
    { issuer: "", subject: "x" },
    { issuer: "x", subject: "" },
    { issuer: "x", subject: "x".repeat(16385) },
  ])("rejects invalid identity %# without Redis", async (value) => {
    const evalCall = vi.fn().mockResolvedValue(1);
    await expect(
      new RedisPlatformTargetLookupRateLimiter(
        { eval: evalCall },
        options,
      ).allow(value as never, 500),
    ).rejects.toThrow(unavailable);
    expect(evalCall).not.toHaveBeenCalled();
  });
  it.each([100, 0, NaN, Infinity, 2101])(
    "rejects invalid deadline %s before Redis",
    async (deadline) => {
      const evalCall = vi.fn().mockResolvedValue(1);
      await expect(
        new RedisPlatformTargetLookupRateLimiter(
          { eval: evalCall },
          options,
        ).allow(identity, deadline),
      ).rejects.toThrow(unavailable);
      expect(evalCall).not.toHaveBeenCalled();
    },
  );
  it.each(["1", true, 2, -1, null, [], {}])(
    "rejects unknown Redis response %# without retry",
    async (result) => {
      const evalCall = vi.fn().mockResolvedValue(result);
      await expect(
        new RedisPlatformTargetLookupRateLimiter(
          { eval: evalCall },
          options,
        ).allow(identity, 500),
      ).rejects.toThrow(unavailable);
      expect(evalCall).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects missing Redis and sanitizes transport diagnostics", async () => {
    await expect(
      new RedisPlatformTargetLookupRateLimiter(null, options).allow(
        identity,
        500,
      ),
    ).rejects.toThrow(unavailable);
    const evalCall = vi
      .fn()
      .mockRejectedValue(new Error("private Redis credential"));
    const error = await new RedisPlatformTargetLookupRateLimiter(
      { eval: evalCall },
      options,
    )
      .allow(identity, 500)
      .catch((e) => e);
    expect(error.message).toBe(unavailable);
    expect(error).not.toHaveProperty("cause");
    expect(evalCall).toHaveBeenCalledTimes(1);
  });
  it("discards late Redis ACKs and never retries or refunds", async () => {
    let now = 100;
    const evalCall = vi.fn(async () => {
      now = 500;
      return 1;
    });
    await expect(
      new RedisPlatformTargetLookupRateLimiter(
        { eval: evalCall },
        { ...options, monotonicNow: () => now },
      ).allow(identity, 500),
    ).rejects.toThrow(unavailable);
    expect(evalCall).toHaveBeenCalledTimes(1);
  });
  it("bounds a never-resolving Redis call by the original deadline", async () => {
    const evalCall = vi.fn(() => new Promise(() => {}));
    const limiter = new RedisPlatformTargetLookupRateLimiter(
      { eval: evalCall },
      { limit: 3, windowMs: 3000 },
    );
    const started = performance.now();
    await expect(limiter.allow(identity, started + 25)).rejects.toThrow(
      unavailable,
    );
    expect(performance.now() - started).toBeLessThan(1000);
    expect(evalCall).toHaveBeenCalledTimes(1);
  });
});

// Existing suite convention: opt-in, random owned container, no DB URL, no egress.
describe.skipIf(
  process.env.PLATFORM_TARGET_LOOKUP_REDIS_DISPOSABLE_TEST !== "1",
)("lookup limiter on disposable Redis", () => {
  const container = `codex-lookup-redis-${randomUUID()}`;
  const execute = promisify(execFile);
  let created = false;
  const docker = async (...args: string[]) =>
    (
      await execute("docker", args, { timeout: 10000, maxBuffer: 65536 })
    ).stdout.trim();
  const command = (...args: string[]) =>
    docker("exec", container, "redis-cli", "--raw", ...args);
  beforeAll(async () => {
    await docker("image", "inspect", "redis:7-alpine");
    await docker(
      "run",
      "--pull=never",
      "--rm",
      "-d",
      "--name",
      container,
      "--network=none",
      "--tmpfs",
      "/data",
      "redis:7-alpine",
      "redis-server",
      "--save",
      "",
      "--appendonly",
      "no",
    );
    created = true;
    for (let n = 0; n < 30; n++) {
      try {
        if ((await command("PING")) === "PONG") return;
      } catch {
        /* Startup only; no product retry. */
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("DISPOSABLE_REDIS_NOT_READY");
  });
  afterAll(async () => {
    if (created) await docker("stop", container);
  });
  it("atomically caps concurrent requests, keeps a fixed TTL, and restores capacity only after expiry", async () => {
    let key = "";
    const client = {
      eval: async (
        script: string,
        numberOfKeys: number,
        ...args: Array<string | number>
      ) => {
        key = String(args[0]);
        const value = await command(
          "EVAL",
          script,
          String(numberOfKeys),
          ...args.map(String),
        );
        if (!/^[01]$/.test(value))
          throw new Error("DISPOSABLE_REDIS_RESULT_INVALID");
        return Number(value);
      },
    };
    const limiter = new RedisPlatformTargetLookupRateLimiter(client, {
      limit: 3,
      windowMs: 3000,
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        limiter.allow(identity, performance.now() + 2000),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(3);
    const ttl = Number(await command("PTTL", key));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(3000);
    expect(await limiter.allow(identity, performance.now() + 2000)).toBe(false);
    expect(Number(await command("PTTL", key))).toBeLessThan(ttl);
    await new Promise((resolve) => setTimeout(resolve, 3050));
    expect(await limiter.allow(identity, performance.now() + 2000)).toBe(true);
    await command("PERSIST", key);
    await expect(
      limiter.allow(identity, performance.now() + 2000),
    ).rejects.toThrow(unavailable);
  }, 10000);
});
