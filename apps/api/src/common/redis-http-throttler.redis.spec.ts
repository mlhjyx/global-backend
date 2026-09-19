import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Controller, Get, Module } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { ThrottlerModule, ThrottlerStorageService } from "@nestjs/throttler";
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RedisHttpThrottlerStorage,
  httpThrottlerOptions,
} from "./redis-http-throttler.storage";
import { WsThrottlerGuard } from "./ws-throttler.guard";
import { GlobalHttpExceptionFilter } from "./http-exception.filter";

@Controller("probe")
class ProbeController {
  @Get() read() {
    return { ok: true };
  }
}
async function app(env: Record<string, string | undefined>) {
  @Module({
    imports: [
      ThrottlerModule.forRootAsync({
        useFactory: () => httpThrottlerOptions(env),
      }),
    ],
    controllers: [ProbeController],
    providers: [{ provide: APP_GUARD, useClass: WsThrottlerGuard }],
  })
  class TestApp {}
  const value = await NestFactory.create(TestApp, { logger: false });
  value.useGlobalFilters(new GlobalHttpExceptionFilter());
  await value.listen(0, "127.0.0.1");
  return value;
}

it("returns bounded HTTP 503 through the real global guard when Redis is absent", async () => {
  const value = await app({});
  try {
    const response = await fetch(`${await value.getUrl()}/probe`, {
      headers: { Authorization: "Bearer unverified-workspace-token" },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { message: "HTTP_THROTTLE_UNAVAILABLE" },
    });
  } finally {
    await value.close();
  }
});

class InspectTracker extends WsThrottlerGuard {
  tracker(req: Record<string, unknown>) {
    return this.getTracker(req);
  }
}
it("preserves authenticated-context/IP fallback and ignores unverified JWT claims", async () => {
  const tracker = new InspectTracker([], {} as never, {} as never);
  expect(
    await tracker.tracker({
      ctx: { workspaceId: "tenant-a" },
      ip: "127.0.0.1",
    }),
  ).toBe("ws:tenant-a");
  expect(
    await tracker.tracker({
      headers: { authorization: "Bearer arbitrary" },
      ip: "127.0.0.2",
    }),
  ).toBe("ip:127.0.0.2");
  expect(
    await tracker.tracker({ socket: { remoteAddress: "127.0.0.3" } }),
  ).toBe("ip:127.0.0.3");
  expect(await tracker.tracker({})).toBe("ip:unknown");
});

describe.skipIf(process.env.RUN_HTTP_THROTTLE_REDIS_TEST !== "1")(
  "disposable Redis HTTP throttler",
  () => {
    const execute = promisify(execFile);
    const container = `http-throttle-test-${randomUUID()}`;
    const storages: RedisHttpThrottlerStorage[] = [];
    let created = false;
    let url: string;
    let client: Redis;
    async function docker(...args: string[]) {
      return (
        await execute("docker", ["--context", "default", ...args], {
          timeout: 30_000,
        })
      ).stdout.trim();
    }
    function storage() {
      const value = new RedisHttpThrottlerStorage({ REDIS_URL: url });
      storages.push(value);
      return value;
    }
    beforeAll(async () => {
      await docker(
        "run",
        "--rm",
        "-d",
        "--name",
        container,
        "--publish",
        "127.0.0.1::6379",
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
      let ready = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          ready =
            (await docker("exec", container, "redis-cli", "PING")) === "PONG";
          if (ready) break;
        } catch {
          /* Wait only for this disposable test server to start. */
        }
        await delay(50);
      }
      if (!ready) throw new Error("DISPOSABLE_REDIS_NOT_READY");
      const port = await docker("port", container, "6379/tcp");
      if (!/^127\.0\.0\.1:\d+$/.test(port))
        throw new Error("DISPOSABLE_REDIS_PORT_INVALID");
      url = `redis://${port}/0`;
      client = new Redis(url, {
        lazyConnect: true,
        retryStrategy: () => null,
        connectTimeout: 1000,
      });
      client.on("error", () => {});
      await client.connect();
      expect(await client.ping()).toBe("PONG");
    }, 40_000);
    afterAll(async () => {
      storages.forEach((value) => value.onApplicationShutdown());
      client?.disconnect();
      if (created) await docker("stop", container);
    }, 40_000);

    it("shares one atomic limit across independent instances and never extends a block", async () => {
      const first = storage();
      const second = storage();
      const key = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 30 }, (_, index) =>
          (index % 2 ? first : second).increment(key, 200, 5, 600, "default"),
        ),
      );
      expect(results.filter((value) => !value.isBlocked)).toHaveLength(5);
      expect(
        results
          .filter((value) => value.isBlocked)
          .every((value) => value.totalHits === 6),
      ).toBe(true);
      await delay(300);
      const blocked = await first.increment(key, 200, 5, 600, "default");
      expect(blocked).toMatchObject({
        totalHits: 0,
        isBlocked: true,
        timeToBlockExpire: 1,
      });
      await delay(350);
      expect(await second.increment(key, 200, 5, 600, "default")).toMatchObject(
        { totalHits: 1, isBlocked: false, timeToBlockExpire: 0 },
      );
    });

    it("expires individual hits rather than resetting all hits at a fixed window boundary", async () => {
      const value = storage();
      const key = randomUUID();
      const reference = new ThrottlerStorageService();
      try {
        expect(
          (await value.increment(key, 600, 4, 600, "default")).totalHits,
        ).toBe(
          (await reference.increment(key, 600, 4, 600, "default")).totalHits,
        );
        await delay(400);
        expect(
          (await value.increment(key, 600, 4, 600, "default")).totalHits,
        ).toBe(
          (await reference.increment(key, 600, 4, 600, "default")).totalHits,
        );
        await delay(350);
        expect(
          (await value.increment(key, 600, 4, 600, "default")).totalHits,
        ).toBe(2);
        expect(
          (await reference.increment(key, 600, 4, 600, "default")).totalHits,
        ).toBe(2);
      } finally {
        reference.onApplicationShutdown();
      }
    });

    it("resets only an expired blocked key and isolates throttler names", async () => {
      const value = storage();
      const a = randomUUID();
      const b = randomUUID();
      await value.increment(a, 2000, 1, 100, "default");
      expect(
        (await value.increment(a, 2000, 1, 100, "default")).isBlocked,
      ).toBe(true);
      await value.increment(b, 2000, 3, 100, "default");
      expect((await value.increment(a, 2000, 1, 100, "other")).isBlocked).toBe(
        false,
      );
      await delay(150);
      expect(
        (await value.increment(a, 2000, 1, 100, "default")).totalHits,
      ).toBe(1);
      expect(
        (await value.increment(b, 2000, 3, 100, "default")).totalHits,
      ).toBe(2);
    });
    it("survives process replacement and fails closed on corrupt non-expiring Redis state", async () => {
      const key = randomUUID();
      const first = storage();
      await first.increment(key, 2000, 3, 1000, "default");
      first.onApplicationShutdown();
      const replacement = storage();
      expect(
        (await replacement.increment(key, 2000, 3, 1000, "default")).totalHits,
      ).toBe(2);
      const digest = createHash("sha256")
        .update(JSON.stringify(["default", key]))
        .digest("hex");
      await client.persist(`http-throttle:v1:{${digest}}:state`);
      await expect(
        replacement.increment(key, 2000, 3, 1000, "default"),
      ).rejects.toMatchObject({ status: 503 });
    });

    it("preserves HTTP headers and enforces one route/IP limit across two Nest apps", async () => {
      const env = {
        REDIS_URL: url,
        THROTTLE_LIMIT: "2",
        THROTTLE_TTL_MS: "1000",
      };
      const first = await app(env);
      const second = await app(env);
      try {
        const responses = await Promise.all(
          [first, second, first, second].map(async (value) =>
            fetch(`${await value.getUrl()}/probe`),
          ),
        );
        expect(
          responses.filter((response) => response.status === 200),
        ).toHaveLength(2);
        expect(
          responses.filter((response) => response.status === 429),
        ).toHaveLength(2);
        expect(
          responses
            .find((response) => response.status === 200)
            ?.headers.get("x-ratelimit-limit"),
        ).toBe("2");
        expect(
          responses
            .find((response) => response.status === 429)
            ?.headers.get("retry-after"),
        ).toBe("1");
      } finally {
        await first.close();
        await second.close();
      }
    });
  },
);
