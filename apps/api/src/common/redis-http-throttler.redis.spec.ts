import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer, type AddressInfo } from "node:http";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Module,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { ThrottlerModule, ThrottlerStorageService, SkipThrottle } from "@nestjs/throttler";
import Redis from "ioredis";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthGuard } from "../auth/auth.guard";
import { AuthModule } from "../auth/auth.module";
import { Ctx } from "../auth/ctx.decorator";
import type { RequestContext } from "../auth/request-context";
import { TokenVerifier, UnavailableTokenVerifier } from "../auth/token-verifier";
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
it("preserves authenticated-context/IP fallback and resolves verified Bearer workspaceId without mutating requestContext", async () => {
  const tracker = new InspectTracker([], {} as never, {} as never);
  expect(
    await tracker.tracker({
      requestContext: { workspaceId: "tenant-a" },
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

  const validVerifier: TokenVerifier = {
    async verify(token: string): Promise<RequestContext> {
      if (token === "token-tenant-a") {
        return {
          userId: "user-1",
          workspaceId: "tenant-a",
          roles: ["MEMBER"],
          scopes: [],
        };
      }
      throw new UnauthorizedException({
        error: { code: "TOKEN_INVALID", message: "invalid bearer token" },
      });
    },
  };
  const verifiedTracker = new InspectTracker(
    [],
    {} as never,
    {} as never,
    validVerifier,
  );
  const reqWithValidToken: Record<string, unknown> = {
    headers: { authorization: "Bearer token-tenant-a" },
    ip: "127.0.0.1",
  };
  expect(await verifiedTracker.tracker(reqWithValidToken)).toBe("ws:tenant-a");
  expect(reqWithValidToken.requestContext).toBeUndefined();

  expect(
    await verifiedTracker.tracker({
      headers: { authorization: "Bearer forged-token" },
      ip: "127.0.0.4",
    }),
  ).toBe("ip:127.0.0.4");

  const unavailableTracker = new InspectTracker(
    [],
    {} as never,
    {} as never,
    new UnavailableTokenVerifier(),
  );
  expect(
    await unavailableTracker.tracker({
      headers: { authorization: "Bearer token-tenant-a" },
      ip: "127.0.0.5",
    }),
  ).toBe("ip:127.0.0.5");
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

    it("isolates tenant rate-limit buckets behind 127.0.0.1 via AuthModule JwksTokenVerifier + AuthGuard + Redis", async () => {
      const wsA = "11111111-1111-4111-8111-111111111111";
      const wsB = "22222222-2222-4222-8222-222222222222";
      const { publicKey, privateKey } = await generateKeyPair("RS256");
      const jwk = { ...(await exportJWK(publicKey)), kid: "test-kid-1", alg: "RS256", use: "sig" };
      const jwksServer = createServer((_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ keys: [jwk] }));
      });
      await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
      const jwksPort = (jwksServer.address() as AddressInfo).port;
      const issuer = "https://auth.example.test";
      const audience = "global-api";

      const prevEnv = {
        AUTH_JWKS_URI: process.env.AUTH_JWKS_URI,
        AUTH_ISSUER: process.env.AUTH_ISSUER,
        AUTH_AUDIENCE: process.env.AUTH_AUDIENCE,
        AUTH_ROLE_SCOPE_MAP_JSON: process.env.AUTH_ROLE_SCOPE_MAP_JSON,
      };
      process.env.AUTH_JWKS_URI = `http://127.0.0.1:${jwksPort}/.well-known/jwks.json`;
      process.env.AUTH_ISSUER = issuer;
      process.env.AUTH_AUDIENCE = audience;
      process.env.AUTH_ROLE_SCOPE_MAP_JSON = JSON.stringify({ MEMBER: [] });

      async function signTenantJwt(workspaceId: string, sub: string) {
        return new SignJWT({ workspace_id: workspaceId, roles: ["MEMBER"] })
          .setProtectedHeader({ alg: "RS256", kid: "test-kid-1" })
          .setIssuer(issuer)
          .setAudience(audience)
          .setSubject(sub)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey);
      }

      @Injectable()
      class StubServiceTokenGuard implements CanActivate {
        canActivate(context: ExecutionContext): boolean {
          const req = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
          return req.headers["x-service-token"] === "svc-secret";
        }
      }

      @Controller()
      class IntegrationController {
        @Get("protected")
        @UseGuards(AuthGuard)
        readProtected(@Ctx() ctx: RequestContext) {
          return { workspaceId: ctx.workspaceId };
        }

        @Get("health/live")
        @SkipThrottle()
        live() {
          return { status: "ok" };
        }

        @Get("health/db")
        db() {
          return { status: "ok" };
        }

        @Get("internal/service")
        @UseGuards(StubServiceTokenGuard)
        service() {
          return { ok: true };
        }
      }

      @Module({
        imports: [
          AuthModule,
          ThrottlerModule.forRootAsync({
            useFactory: () =>
              httpThrottlerOptions({
                REDIS_URL: url,
                THROTTLE_LIMIT: "2",
                THROTTLE_TTL_MS: "5000",
              }),
          }),
        ],
        controllers: [IntegrationController],
        providers: [
          StubServiceTokenGuard,
          { provide: APP_GUARD, useClass: WsThrottlerGuard },
        ],
      })
      class IntegrationModule {}

      const instance = await NestFactory.create(IntegrationModule, { logger: false });
      instance.useGlobalFilters(new GlobalHttpExceptionFilter());
      await instance.listen(0, "127.0.0.1");
      try {
        const base = await instance.getUrl();
        const jwtA = await signTenantJwt(wsA, "u-a");
        const jwtB = await signTenantJwt(wsB, "u-b");

        // 1. Tenant A exhausts limit=2, hits 429 on 3rd request; Tenant B still gets 200 behind same 127.0.0.1.
        const a1 = await fetch(`${base}/protected`, { headers: { Authorization: `Bearer ${jwtA}` } });
        const a2 = await fetch(`${base}/protected`, { headers: { Authorization: `Bearer ${jwtA}` } });
        const a3 = await fetch(`${base}/protected`, { headers: { Authorization: `Bearer ${jwtA}` } });
        expect(a1.status).toBe(200);
        expect(a2.status).toBe(200);
        expect(a3.status).toBe(429);

        const b1 = await fetch(`${base}/protected`, { headers: { Authorization: `Bearer ${jwtB}` } });
        expect(b1.status).toBe(200);
        expect(await b1.json()).toEqual({ workspaceId: wsB });

        // 2. /health/live (@SkipThrottle) and /health/db (with bogus Bearer) still work.
        const liveRes = await fetch(`${base}/health/live`, { headers: { Authorization: "Bearer bogus" } });
        expect(liveRes.status).toBe(200);
        const dbRes = await fetch(`${base}/health/db`, { headers: { Authorization: "Bearer bogus" } });
        expect(dbRes.status).toBe(200);

        // 3. x-service-token endpoint falls back to IP (not blocked by TokenVerifier) and succeeds (200),
        //    and invalid JWT on AuthGuard endpoint falls back to IP, gets 401 TOKEN_INVALID, then hits 429 on IP limit.
        const svcRes = await fetch(`${base}/internal/service`, { headers: { "x-service-token": "svc-secret" } });
        expect(svcRes.status).toBe(200);

        for (let i = 0; i < 2; i++) {
          const badJwt = await fetch(`${base}/protected`, { headers: { Authorization: "Bearer not-a-jwt" } });
          expect(badJwt.status).toBe(401);
          expect(await badJwt.json()).toMatchObject({ error: { code: "TOKEN_INVALID" } });
        }
        const throttledBadJwt = await fetch(`${base}/protected`, { headers: { Authorization: "Bearer not-a-jwt" } });
        expect(throttledBadJwt.status).toBe(429);
      } finally {
        await instance.close();
        await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
        for (const [k, v] of Object.entries(prevEnv)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });
  },
);
