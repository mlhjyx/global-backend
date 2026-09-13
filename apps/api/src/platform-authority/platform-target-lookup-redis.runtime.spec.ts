import { describe, expect, it, vi } from "vitest";
import type { RedisOptions } from "ioredis";
import { PlatformTargetLookupRedisRuntime } from "./platform-target-lookup-redis.runtime";
const env = {
  REDIS_URL: "redis://user:private-password@127.0.0.1:6379/0",
  PLATFORM_AUTHORITY_TARGET_LOOKUP_RATE_LIMIT: "3",
  PLATFORM_AUTHORITY_TARGET_LOOKUP_RATE_WINDOW_MS: "3000",
};
const identity = {
  issuer: "https://growthos.example",
  subject: "control-plane",
};
const unavailable = "PLATFORM_AUTHORITY_TARGET_LOOKUP_UNAVAILABLE";
function setup() {
  const client = {
    connect: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue("PONG"),
    eval: vi.fn().mockResolvedValue(1),
    disconnect: vi.fn(),
    on: vi.fn(),
  };
  const factory = vi.fn(() => client);
  return { client, factory };
}
describe("lookup Redis runtime", () => {
  it("requires certificate validation for rediss and contains disconnect/clock failures", async () => {
    const { client, factory } = setup();
    client.disconnect.mockImplementation(() => {
      throw new Error("private close diagnostic");
    });
    const runtime = new PlatformTargetLookupRedisRuntime(
      { ...env, REDIS_URL: "rediss://redis.example/0" },
      factory,
      () => 100,
    );
    expect(await runtime.readiness(600)).toBe(true);
    expect(
      (factory.mock.calls[0] as unknown as [string, RedisOptions])[1].tls,
    ).toEqual({ rejectUnauthorized: true });
    const badClock = new PlatformTargetLookupRedisRuntime(env, factory, () => {
      throw new Error("private clock");
    });
    await expect(badClock.allow(identity, 600)).rejects.toThrow(unavailable);
  });
  it.each([0, 1])(
    "connects explicitly and uses actual limiter with result %s",
    async (value) => {
      const { client, factory } = setup();
      client.eval.mockResolvedValue(value);
      const runtime = new PlatformTargetLookupRedisRuntime(
        env,
        factory,
        () => 100,
      );
      expect(await runtime.allow(identity, 600)).toBe(value === 1);
      expect(client.connect).toHaveBeenCalledTimes(1);
      expect(client.disconnect).toHaveBeenCalledTimes(1);
      const options = (
        factory.mock.calls[0] as unknown as [string, RedisOptions]
      )[1];
      expect(options).toMatchObject({
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
        connectTimeout: 500,
        commandTimeout: 500,
        autoResendUnfulfilledCommands: false,
      });
      expect(options.retryStrategy?.(1)).toBe(null);
      expect(options.reconnectOnError?.(new Error("transport"))).toBe(false);
      expect(client.on).toHaveBeenCalledWith("error", expect.any(Function));
      expect(client.eval.mock.calls[0].slice(1)).toEqual([
        1,
        expect.stringMatching(/^platform-target-lookup:rate:v1:[a-f0-9]{64}$/),
        3,
        3000,
      ]);
    },
  );
  it("readiness uses connect PING and read-only script, not business limit state", async () => {
    const { client, factory } = setup();
    const runtime = new PlatformTargetLookupRedisRuntime(
      env,
      factory,
      () => 100,
    );
    expect(await runtime.readiness(600)).toBe(true);
    expect(client.ping).toHaveBeenCalledTimes(1);
    expect(client.eval).toHaveBeenCalledWith("return 1", 0);
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });
  it.each([
    {},
    { ...env, REDIS_URL: "http://host" },
    { ...env, REDIS_URL: "redis://host#secret" },
    { ...env, REDIS_URL: "redis://host?foo=bar" },
    { ...env, REDIS_URL: " redis://host" },
    { ...env, REDIS_URL: "redis://host/arbitrary" },
    { ...env, PLATFORM_AUTHORITY_TARGET_LOOKUP_RATE_LIMIT: "03" },
    { ...env, PLATFORM_AUTHORITY_TARGET_LOOKUP_RATE_LIMIT: "0" },
    { ...env, PLATFORM_AUTHORITY_TARGET_LOOKUP_RATE_LIMIT: "2147483648" },
    { ...env, PLATFORM_AUTHORITY_TARGET_LOOKUP_RATE_WINDOW_MS: "1.5" },
    { ...env, PLATFORM_AUTHORITY_TARGET_LOOKUP_RATE_WINDOW_MS: undefined },
  ])("stays diagnostic with invalid configuration %#", async (config) => {
    const { factory } = setup();
    const runtime = new PlatformTargetLookupRedisRuntime(
      config,
      factory,
      () => 100,
    );
    expect(await runtime.readiness(600)).toBe(false);
    await expect(runtime.allow(identity, 600)).rejects.toThrow(unavailable);
    expect(factory).not.toHaveBeenCalled();
  });
  it.each([0, 100, NaN, Infinity, 2101])(
    "does not create clients for invalid deadline %s",
    async (deadline) => {
      const { factory } = setup();
      const runtime = new PlatformTargetLookupRedisRuntime(
        env,
        factory,
        () => 100,
      );
      expect(await runtime.readiness(deadline)).toBe(false);
      expect(factory).not.toHaveBeenCalled();
    },
  );
  it("does not evaluate after late connect and closes it", async () => {
    let now = 100;
    const { client, factory } = setup();
    client.connect.mockImplementation(async () => {
      now = 600;
    });
    const runtime = new PlatformTargetLookupRedisRuntime(
      env,
      factory,
      () => now,
    );
    await expect(runtime.allow(identity, 600)).rejects.toThrow(unavailable);
    expect(client.eval).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });
  it("bounds hung connect and suppresses a later continuation", async () => {
    const { client, factory } = setup();
    let release!: () => void;
    client.connect.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const runtime = new PlatformTargetLookupRedisRuntime(env, factory);
    await expect(
      runtime.allow(identity, performance.now() + 25),
    ).rejects.toThrow(unavailable);
    release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(client.eval).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });
  it.each(["connect", "ping", "eval"])(
    "sanitizes %s errors and closes clients",
    async (operation) => {
      const { client, factory } = setup();
      client[operation as "connect"].mockRejectedValue(
        new Error("private-password"),
      );
      const runtime = new PlatformTargetLookupRedisRuntime(
        env,
        factory,
        () => 100,
      );
      expect(await runtime.readiness(600)).toBe(false);
      expect(client.disconnect).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["PONG?", 1, null])(
    "rejects malformed ping %s without script",
    async (result) => {
      const { client, factory } = setup();
      client.ping.mockResolvedValue(result);
      expect(
        await new PlatformTargetLookupRedisRuntime(
          env,
          factory,
          () => 100,
        ).readiness(600),
      ).toBe(false);
      expect(client.eval).not.toHaveBeenCalled();
    },
  );
  it.each(["1", true, 0])(
    "rejects malformed readiness script %s",
    async (result) => {
      const { client, factory } = setup();
      client.eval.mockResolvedValue(result);
      expect(
        await new PlatformTargetLookupRedisRuntime(
          env,
          factory,
          () => 100,
        ).readiness(600),
      ).toBe(false);
    },
  );
  it("shuts down active calls and prevents new clients", async () => {
    const { client, factory } = setup();
    client.connect.mockImplementation(() => new Promise(() => {}));
    const runtime = new PlatformTargetLookupRedisRuntime(
      env,
      factory,
      () => 100,
    );
    const pending = runtime.allow(identity, 600);
    runtime.onModuleDestroy();
    await expect(pending).rejects.toThrow(unavailable);
    expect(client.disconnect).toHaveBeenCalledTimes(1);
    expect(await runtime.readiness(600)).toBe(false);
    expect(factory).toHaveBeenCalledTimes(1);
  });
  it("does not reuse a client or an allowance across requests", async () => {
    const { factory, client } = setup();
    const runtime = new PlatformTargetLookupRedisRuntime(
      env,
      factory,
      () => 100,
    );
    await runtime.allow(identity, 600);
    await runtime.allow(identity, 600);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(client.disconnect).toHaveBeenCalledTimes(2);
  });
});
