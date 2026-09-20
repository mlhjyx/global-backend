import "reflect-metadata";
import { ServiceUnavailableException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RedisOptions } from "ioredis";
import {
  RedisHttpThrottlerStorage,
  httpThrottlerOptions,
  type HttpThrottleRedisConnection,
} from "./redis-http-throttler.storage";

function connection(result: unknown = [1, 60, 0, 0]) {
  return {
    status: "ready",
    connect: vi.fn(async () => undefined),
    eval: vi.fn(
      async (
        _script: string,
        _count: number,
        ..._args: Array<string | number>
      ) => result,
    ),
    disconnect: vi.fn(),
    on: vi.fn(),
  };
}
const env = { REDIS_URL: "redis://127.0.0.1:6379/0" };
const owned: RedisHttpThrottlerStorage[] = [];
function storage(client = connection(), input = env) {
  const factory = vi.fn(
    (_url: string, _options: RedisOptions) =>
      client as HttpThrottleRedisConnection,
  );
  const value = new RedisHttpThrottlerStorage(input, factory);
  owned.push(value);
  return { value, client, factory };
}
afterEach(() => {
  owned.splice(0).forEach((value) => value.onApplicationShutdown());
  vi.useRealTimers();
});

describe("Redis HTTP throttler storage contract", () => {
  it("passes millisecond policy to one atomic operation and maps second-based headers", async () => {
    const { value, client, factory } = storage(connection([301, 12, 1, 30]));
    expect(
      await value.increment("route-ip-hash", 60_000, 300, 30_000, "default"),
    ).toEqual({
      totalHits: 301,
      timeToExpire: 12,
      isBlocked: true,
      timeToBlockExpire: 30,
    });
    expect(client.eval).toHaveBeenCalledTimes(1);
    const args = client.eval.mock.calls[0] as unknown[];
    expect(args.slice(1, 2)).toEqual([2]);
    expect(args.slice(4, 7)).toEqual([60_000, 300, 30_000]);
    expect(String(args[2])).not.toContain("route-ip-hash");
    expect(String(args[2]).match(/\{([^}]+)\}/)?.[1]).toEqual(
      String(args[3]).match(/\{([^}]+)\}/)?.[1],
    );
    expect(factory).toHaveBeenCalledWith(
      env.REDIS_URL,
      expect.objectContaining({
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
        autoResendUnfulfilledCommands: false,
        commandTimeout: 500,
      }),
    );
    await value.increment("route-ip-hash", 60_000, 300, 30_000, "default");
    expect(factory).toHaveBeenCalledTimes(1);
  });
  it.each([
    undefined,
    "",
    "http://secret.invalid",
    "redis://host/0?password=secret",
    "redis://host/#x",
    "redis://host/-1",
  ])(
    "rejects invalid Redis configuration without creating a connection (%s)",
    async (url) => {
      const { value, factory } = storage(connection(), {
        REDIS_URL: url,
      } as typeof env);
      await expect(
        value.increment("key", 1000, 1, 1000, "default"),
      ).rejects.toMatchObject({
        status: 503,
        message: "HTTP_THROTTLE_UNAVAILABLE",
      });
      expect(factory).not.toHaveBeenCalled();
    },
  );
  it.each([
    [0, 1, 1000],
    [1000, 0, 1000],
    [1000, 1, -1],
    [Number.NaN, 1, 1000],
  ])("fails closed for invalid policy %j", async (ttl, limit, duration) => {
    const { value, client } = storage();
    await expect(
      value.increment("key", ttl, limit, duration, "default"),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(client.eval).not.toHaveBeenCalled();
  });
  it.each([
    null,
    [0, 60, 0, 0],
    [1, 60, 2, 0],
    [1, -1, 0, 0],
    [1, 60, 1, 0],
    [1.5, 60, 0, 0],
    [1, 60, 0, 0, "extra"],
  ])("rejects malformed Redis results %j", async (result) => {
    const { value } = storage(connection(result));
    await expect(
      value.increment("key", 60_000, 300, 60_000, "default"),
    ).rejects.toMatchObject({
      status: 503,
      message: "HTTP_THROTTLE_UNAVAILABLE",
    });
  });
  it("does not retry, refund or expose a secret-bearing Redis failure", async () => {
    const { value, client } = storage();
    client.eval.mockRejectedValue(
      new Error("redis://password@host sensitive command"),
    );
    await expect(
      value.increment("key", 1000, 1, 1000, "default"),
    ).rejects.toMatchObject({
      status: 503,
      message: "HTTP_THROTTLE_UNAVAILABLE",
    });
    expect(client.eval).toHaveBeenCalledTimes(1);
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });
  it("bounds hung connection/eval and shuts down without allowing late success", async () => {
    vi.useFakeTimers();
    const client = connection();
    client.eval.mockImplementation(() => new Promise(() => {}));
    const { value } = storage(client);
    const assertion = expect(
      value.increment("key", 1000, 1, 1000, "default"),
    ).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(501);
    await assertion;
    expect(client.disconnect).toHaveBeenCalledTimes(1);
    value.onApplicationShutdown();
    await expect(
      value.increment("key", 1000, 1, 1000, "default"),
    ).rejects.toMatchObject({ status: 503 });
  });
  it("uses verified TLS and single-flight connection creation", async () => {
    const client = connection();
    client.status = "wait";
    const { value, factory } = storage(client, {
      REDIS_URL: "rediss://host/0",
    });
    await Promise.all(
      [1, 2].map(() => value.increment("key", 1000, 2, 1000, "default")),
    );
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0][1]).toMatchObject({
      tls: { rejectUnauthorized: true },
    });
  });
  it("never opens a deferred connection after shutdown", async () => {
    const client = connection();
    client.status = "wait";
    const { value } = storage(client);
    const pending = value.increment("key", 1000, 1, 1000, "default");
    value.onApplicationShutdown();
    await expect(pending).rejects.toMatchObject({ status: 503 });
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.eval).not.toHaveBeenCalled();
  });
  it("keeps the existing default and environment limits in the sole product composition", () => {
    const options = httpThrottlerOptions({
      THROTTLE_TTL_MS: "2000",
      THROTTLE_LIMIT: "4",
    });
    expect(options.throttlers).toEqual([{ ttl: 2000, limit: 4 }]);
    expect(options.storage).toBeInstanceOf(RedisHttpThrottlerStorage);
    expect(httpThrottlerOptions({}).throttlers).toEqual([
      { ttl: 60_000, limit: 300 },
    ]);
  });
});
