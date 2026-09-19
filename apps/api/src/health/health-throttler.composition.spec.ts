import "reflect-metadata";
import { createServer, type AddressInfo } from "node:net";
import { Controller, Get, Module, Post, VersioningType } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { describe, expect, it, vi } from "vitest";
import { HealthController } from "./health.controller";
import { RuntimeReadinessService } from "./runtime-readiness.service";
import { RuntimeReleaseIdentityService } from "../runtime/runtime-release-identity";
import { RuntimeAdmissionService } from "../runtime/runtime-admission";
import { RuntimeWorkAdmissionGuard } from "../runtime/runtime-work-admission.guard";
import { PrismaService } from "../prisma/prisma.service";
import { httpThrottlerOptions } from "../common/redis-http-throttler.storage";
import { WsThrottlerGuard } from "../common/ws-throttler.guard";
import { GlobalHttpExceptionFilter } from "../common/http-exception.filter";

@Controller("ordinary-work")
class OrdinaryWorkController {
  @Get() read() {
    return { shouldNotReach: true };
  }
  @Post() create() {
    return { shouldNotReach: true };
  }
}

describe("health diagnostics through the actual global guard chain", () => {
  it("keeps cheap cached probes accessible when Redis rejects connections while business and DB probes fail closed", async () => {
    let redisConnections = 0;
    const unavailableRedis = createServer((socket) => {
      redisConnections++;
      socket.destroy();
    });
    await new Promise<void>((resolve) =>
      unavailableRedis.listen(0, "127.0.0.1", resolve),
    );
    const redisPort = (unavailableRedis.address() as AddressInfo).port;
    const report = {
      status: "not_ready",
      service: "global-api",
      ts: "2026-09-19T00:00:00.000Z",
      capabilities: {},
      components: { redis: { status: "failed", code: "REDIS_UNAVAILABLE" } },
    };
    const readiness = {
      current: vi.fn(() => report),
      check: vi.fn(() => {
        throw new Error(
          "diagnostics must not synchronously probe dependencies",
        );
      }),
    };
    const build = {
      attested: false,
      code: "RUNTIME_RELEASE_IDENTITY_UNAVAILABLE",
    };
    const prisma = { $queryRaw: vi.fn(async () => [{ ok: 1 }]) };
    @Module({
      imports: [
        ThrottlerModule.forRootAsync({
          useFactory: () =>
            httpThrottlerOptions({
              REDIS_URL: `redis://127.0.0.1:${redisPort}/0`,
            }),
        }),
      ],
      controllers: [HealthController, OrdinaryWorkController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: RuntimeReadinessService, useValue: readiness },
        {
          provide: RuntimeReleaseIdentityService,
          useValue: { current: () => build },
        },
        {
          provide: RuntimeAdmissionService,
          useValue: { current: () => ({ admitted: false }) },
        },
        // Match the production order: the distributed throttler runs first.
        { provide: APP_GUARD, useClass: WsThrottlerGuard },
        { provide: APP_GUARD, useClass: RuntimeWorkAdmissionGuard },
      ],
    })
    class HealthTestModule {}
    const app = await NestFactory.create(HealthTestModule, { logger: false });
    app.setGlobalPrefix("api");
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
    app.useGlobalFilters(new GlobalHttpExceptionFilter());
    try {
      await app.listen(0, "127.0.0.1");
      const base = `${await app.getUrl()}/api/v1`;
      for (const route of ["health", "health/live"]) {
        const response = await fetch(`${base}/${route}`);
        expect(response.status, route).toBe(200);
        expect(await response.json()).toMatchObject({
          status: "ok",
          service: "global-api",
        });
      }
      const identity = await fetch(`${base}/health/build`);
      expect(identity.status).toBe(200);
      expect(await identity.json()).toEqual({
        status: "ok",
        service: "global-api",
        build,
      });
      const ready = await fetch(`${base}/health/ready`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual(report);
      expect(readiness.check).not.toHaveBeenCalled();
      expect(redisConnections).toBe(0);
      for (const [route, method] of [
        ["ordinary-work", "GET"],
        ["ordinary-work", "POST"],
        ["health/db", "GET"],
      ]) {
        const response = await fetch(`${base}/${route}`, { method });
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
          error: { message: "HTTP_THROTTLE_UNAVAILABLE" },
        });
      }
      expect(redisConnections).toBeGreaterThan(0);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    } finally {
      await app.close();
      await new Promise<void>((resolve) =>
        unavailableRedis.close(() => resolve()),
      );
    }
  });
});
