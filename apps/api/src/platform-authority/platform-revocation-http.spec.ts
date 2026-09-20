import "reflect-metadata";
import { Global, Logger, Module, VersioningType } from "@nestjs/common";
import { APP_GUARD, NestFactory, Reflector } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ThrottlerModule } from "@nestjs/throttler";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Response } from "express";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { compactVerify, createLocalJWKSet, decodeJwt } from "jose";
import { RuntimeAdmissionService } from "../runtime/runtime-admission";
import { RuntimeWorkAdmissionGuard } from "../runtime/runtime-work-admission.guard";
import { RuntimeReadinessService } from "../health/runtime-readiness.service";
import { RedisHttpThrottlerStorage } from "../common/redis-http-throttler.storage";
import { WsThrottlerGuard } from "../common/ws-throttler.guard";
import { GlobalHttpExceptionFilter } from "../common/http-exception.filter";
import { PlatformRevocationHttpModule } from "./platform-revocation-http.module";
import {
  PlatformRevocationRepository,
  type PlatformRevocationReceipt,
} from "./platform-revocation.repository";
import {
  PlatformFenceAckDeliveryRepository,
  type StoredFenceAck,
} from "./platform-fence-ack-delivery.repository";
import { PlatformRevocationTrustRuntime } from "./platform-revocation-trust.runtime";
import { installPlatformRevocationHttpBoundary } from "./platform-revocation-http.middleware";
import {
  PLATFORM_REVOCATION_HTTP_PATH as PATH,
  PLATFORM_FENCE_ACK_JWKS_PATH as JWKS,
} from "./platform-revocation-http.contract";
import {
  revocationFixture,
  tlsRequest,
} from "./platform-revocation-http.test-fixture";

describe("formal revocation Nest composition over real HTTPS and signatures", () => {
  let fixture: Awaited<ReturnType<typeof revocationFixture>>,
    app: NestExpressApplication,
    origin: string,
    ca: Buffer;
  let receipt: PlatformRevocationReceipt | null = null,
    saved: StoredFenceAck | null = null,
    response: Response | undefined;
  const state = {
    admitted: true,
    blocked: false,
    redisDown: false,
    loseResponse: false,
    generations: 0,
    issuerHits: 0,
  };
  const readiness = { current: vi.fn(() => ({ status: "not_ready" })) };
  const admission = { current: () => ({ admitted: state.admitted }) };
  let apply: ReturnType<typeof vi.spyOn>,
    store: ReturnType<typeof vi.spyOn>,
    log: ReturnType<typeof vi.spyOn>;
  beforeAll(async () => {
    fixture = await revocationFixture();
    ca = readFileSync(fixture.certificate);
    for (const [name, value] of Object.entries(fixture.env))
      vi.stubEnv(name, value);
    vi.stubEnv("EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL", "");
    // Test-only Redis connection port. The actual global Redis storage/Lua client
    // and issuer namespace are exercised; a real Redis server is a separate gate.
    const issuerKey = createHash("sha256")
      .update(
        JSON.stringify([
          "platform-revocation-authenticated-issuer-v1",
          fixture.env.EXECUTION_BUDGET_GRANT_ISSUER,
        ]),
      )
      .digest("hex");
    const storage = new RedisHttpThrottlerStorage(
      { REDIS_URL: "redis://127.0.0.1:1" },
      () => ({
        status: "ready",
        connect: async () => {},
        disconnect() {},
        on() {},
        async eval(_script, _count, key) {
          if (state.redisDown) throw new Error("private redis diagnostic");
          const issuer = String(key).includes(issuerKey);
          if (issuer) state.issuerHits++;
          return issuer && state.blocked ? [11, 60, 1, 60] : [1, 60, 0, 0];
        },
      }),
    );
    @Global()
    @Module({
      providers: [
        { provide: RuntimeAdmissionService, useValue: admission },
        { provide: RuntimeReadinessService, useValue: readiness },
      ],
      exports: [RuntimeAdmissionService, RuntimeReadinessService],
    })
    class AdmissionPorts {}
    @Module({
      imports: [
        AdmissionPorts,
        ThrottlerModule.forRoot({
          throttlers: [{ limit: 300, ttl: 60000 }],
          storage,
        }),
        PlatformRevocationHttpModule,
      ],
      providers: [
        { provide: APP_GUARD, useClass: WsThrottlerGuard },
        {
          provide: APP_GUARD,
          inject: [RuntimeAdmissionService, RuntimeReadinessService, Reflector],
          useFactory: (
            own: RuntimeAdmissionService,
            aggregate: RuntimeReadinessService,
            reflector: Reflector,
          ) => new RuntimeWorkAdmissionGuard(own, aggregate, reflector),
        },
      ],
    })
    class TestApp {}
    app = await NestFactory.create<NestExpressApplication>(TestApp, {
      logger: false,
      rawBody: true,
      httpsOptions: { key: readFileSync(fixture.key), cert: ca },
    });
    installPlatformRevocationHttpBoundary(app);
    app.use((_req: unknown, res: Response, next: () => void) => {
      response = res;
      next();
    });
    app.setGlobalPrefix("api");
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
    app.useGlobalFilters(new GlobalHttpExceptionFilter());
    apply = vi
      .spyOn(app.get(PlatformRevocationRepository), "apply")
      .mockImplementation(async (command) => {
        if (receipt) return { ...receipt, replay: true };
        if (command.expired) throw new Error("PLATFORM_REVOCATION_EXPIRED");
        state.generations++;
        return (receipt = {
          receiptId: "44444444-4444-4444-8444-444444444444",
          generation: "1",
          committedAt: new Date(),
          inFlightAttempts: "0",
          replay: false,
        });
      });
    vi.spyOn(
      app.get(PlatformFenceAckDeliveryRepository),
      "read",
    ).mockImplementation(async () => saved);
    store = vi
      .spyOn(app.get(PlatformFenceAckDeliveryRepository), "store")
      .mockImplementation(async (value) => {
        saved ??= value;
        if (state.loseResponse) {
          response!.destroy();
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        return saved;
      });
    log = vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    await app.listen(0, "127.0.0.1");
    origin = `https://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  }, 20000);
  afterAll(async () => {
    vi.useRealTimers();
    await app?.close();
    await fixture?.close();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    vi.useRealTimers();
    receipt = null;
    saved = null;
    state.admitted = true;
    state.blocked = false;
    state.redisDown = false;
    state.loseResponse = false;
    state.generations = 0;
    state.issuerHits = 0;
    vi.clearAllMocks();
  });
  it("serves exact durable ACK despite aggregate-notready and publishes only independent ACK public keys", async () => {
    const reply = await tlsRequest(origin + PATH, ca, fixture.command());
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("application/jose");
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(reply.body).not.toMatch(/^\{/);
    expect(state.generations).toBe(1);
    expect(state.issuerHits).toBe(1);
    expect(readiness.current).not.toHaveBeenCalled();
    const keys = await tlsRequest(origin + JWKS, ca, undefined, {}, "GET");
    expect(keys.status).toBe(200);
    const publicKeys = JSON.parse(keys.body);
    expect(publicKeys.keys.map((k: { kid: string }) => k.kid)).toEqual([
      "ack-key",
    ]);
    expect(Object.keys(publicKeys.keys[0]).sort()).toEqual([
      "alg",
      "e",
      "kid",
      "kty",
      "n",
      "use",
    ]);
    await compactVerify(reply.body, createLocalJWKSet(publicKeys), {
      algorithms: ["RS256"],
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(reply.body);
  });
  it("replays the original expired ACK bytes after actual response loss without another fence", async () => {
    state.loseResponse = true;
    await expect(
      tlsRequest(origin + PATH, ca, fixture.command()),
    ).rejects.toThrow();
    expect(saved).not.toBeNull();
    const material = (
      await app
        .get(PlatformRevocationTrustRuntime)
        .open(new AbortController().signal)
    ).material;
    const original = material.cipher.decrypt(saved!, saved!);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((fixture.claims.exp + 1) * 1000);
    state.loseResponse = false;
    const replay = await tlsRequest(origin + PATH, ca, fixture.command());
    expect(replay.status).toBe(200);
    expect(replay.body).toBe(original);
    expect(decodeJwt(replay.body).exp).toBeLessThanOrEqual(Date.now() / 1000);
    expect(state.generations).toBe(1);
    expect(store).toHaveBeenCalledTimes(1);
  });
  it("rejects user/budget/ACK families, own-admission failure and issuer rate-limit before mutation", async () => {
    for (const type of [
      "JWT",
      "execution-budget-grant+jwt",
      "platform-authority-fence-ack+jwt",
      "platform-capability+jwt",
    ]) {
      const result = await tlsRequest(
        origin + PATH,
        ca,
        fixture.command(fixture.claims, type),
      );
      expect(result.status).toBe(401);
    }
    expect(state.issuerHits).toBe(0);
    expect(apply).not.toHaveBeenCalled();
    state.admitted = false;
    const closed = await tlsRequest(origin + PATH, ca, fixture.command(), {
      "X-Recovery-Control-Plane": "true",
    });
    expect(closed.status).toBe(503);
    expect(closed.headers["cache-control"]).toBe("no-store");
    expect(apply).not.toHaveBeenCalled();
    expect(JSON.parse(closed.body)).toEqual({
      error: {
        code: "PLATFORM_REVOCATION_UNAVAILABLE",
        message: "platform revocation request cannot be completed",
      },
    });
    state.admitted = true;
    state.blocked = true;
    expect(
      (await tlsRequest(origin + PATH, ca, fixture.command())).status,
    ).toBe(429);
    expect(apply).not.toHaveBeenCalled();
  });
  it("rejects malformed representation/parser limits with no-store before verification, and fails closed on Redis", async () => {
    for (const [body, headers] of [
      ["x".repeat(16385), {}],
      [fixture.command(), { "Content-Type": "application/json" }],
      [fixture.command(), { "Content-Encoding": "gzip" }],
      [fixture.command() + "\n", {}],
    ] as const) {
      const reply = await tlsRequest(origin + PATH, ca, body, headers);
      expect(reply.status).toBe(400);
      expect(reply.headers["cache-control"]).toBe("no-store");
      expect(reply.body).not.toContain(body);
    }
    expect(apply).not.toHaveBeenCalled();
    state.redisDown = true;
    const reply = await tlsRequest(origin + PATH, ca, fixture.command());
    expect(reply.status).toBe(503);
    expect(reply.headers["cache-control"]).toBe("no-store");
  });
  it("never emits keys or applies a fence when actual cross-family independence fails", async () => {
    const original = fixture.documents.get("/identity");
    fixture.documents.set("/identity", {
      keys: [
        {
          ...fixture.pairs.ack.publicKey.export({ format: "jwk" }),
          kid: "identity-key",
          use: "sig",
          alg: "RS256",
        },
      ],
    });
    try {
      expect(
        (await tlsRequest(origin + PATH, ca, fixture.command())).status,
      ).toBe(503);
      expect(
        (await tlsRequest(origin + JWKS, ca, undefined, {}, "GET")).status,
      ).toBe(503);
      expect(apply).not.toHaveBeenCalled();
    } finally {
      fixture.documents.set("/identity", original);
    }
  });
  it("keeps the authenticated finite replay errors distinct from generic409 and unavailable", async () => {
    for (const [code, status] of [
      ["PLATFORM_REVOCATION_EXPIRED", 409],
      ["PLATFORM_REVOCATION_REUSED", 409],
      ["PLATFORM_REVOCATION_SEQUENCE_CONFLICT", 409],
      ["PLATFORM_REVOCATION_SCOPE_MISMATCH", 403],
      ["private DB failure", 503],
    ] as const) {
      apply.mockRejectedValueOnce(new Error(code));
      const reply = await tlsRequest(origin + PATH, ca, fixture.command());
      expect(reply.status).toBe(status);
      expect(JSON.parse(reply.body)).toEqual({
        error: {
          code: status === 503 ? "PLATFORM_REVOCATION_UNAVAILABLE" : code,
          message: "platform revocation request cannot be completed",
        },
      });
    }
    expect(store).not.toHaveBeenCalled();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((fixture.claims.exp + 1) * 1000);
    const expired = await tlsRequest(origin + PATH, ca, fixture.command());
    expect(expired.status).toBe(409);
    expect(JSON.parse(expired.body).error.code).toBe(
      "PLATFORM_REVOCATION_EXPIRED",
    );
    expect(state.generations).toBe(0);
  });
  it("exposes the fixed signed-body OpenAPI operation instead of a user bearer or read-only mutation", () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    const operation = document.paths[PATH]?.post;
    expect(operation?.operationId).toBe(
      "receivePlatformAuthorityRevocation_v1",
    );
    expect(operation?.["x-service-authentication"]).toMatchObject({
      kind: "signed-jws-request-body",
      user_token_fallback: false,
    });
    expect(operation?.["x-maximum-deadline-milliseconds"]).toBe(25000);
  });
});
