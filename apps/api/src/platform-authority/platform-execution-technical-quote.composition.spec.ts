import "reflect-metadata";

import type { AddressInfo } from "node:net";
import {
  Controller,
  Module,
  Post,
  VersioningType,
} from "@nestjs/common";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ThrottlerModule } from "@nestjs/throttler";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppModule } from "../app.module";
import { GlobalHttpExceptionFilter } from "../common/http-exception.filter";
import { WsThrottlerGuard } from "../common/ws-throttler.guard";
import { RuntimeAdmissionService } from "../runtime/runtime-admission";
import { RuntimeReadinessService } from "../health/runtime-readiness.service";
import { RuntimeWorkAdmissionGuard } from "../runtime/runtime-work-admission.guard";
import { PlatformExecutionTechnicalQuoteController } from "./platform-execution-technical-quote.controller";
import { PlatformExecutionTechnicalQuoteReaderService } from "./platform-execution-technical-quote-reader";
import {
  PLATFORM_TECHNICAL_QUOTE_READ_SCOPE,
  PlatformTechnicalQuoteServiceAuthenticationGuard,
  PlatformTechnicalQuoteServiceAuthenticationVerifier,
  UnavailablePlatformTechnicalQuoteServiceAuthenticationVerifier,
} from "./platform-technical-quote-service-auth";

const VALID_BODY = JSON.stringify({
  schema_version: "platform-execution-technical-quote-request/v1",
  purpose: "platform.acquisition",
  temporal_namespace: "platform-automation",
  schedule_id: "acq-sweep",
  workflow_type: "acquisitionSweepWorkflow",
  workflow_id: "platform-acquisition-acq-sweep-20260904t100000z",
  workflow_run_id: "11111111-1111-4111-8111-111111111111",
  schedule_request_sha256:
    "5e960ccef72129aa32bdd9464c9d7b546e5ed6dd7a639caad46df77edea3448e",
});

const closedQuoteRead = vi.fn();

@Controller("ordinary-mutation")
class OrdinaryMutationController {
  @Post()
  mutate(): Readonly<{ accepted: true }> {
    return Object.freeze({ accepted: true });
  }
}

@Module({
  controllers: [
    PlatformExecutionTechnicalQuoteController,
    OrdinaryMutationController,
  ],
  providers: [
    {
      provide: RuntimeAdmissionService,
      useValue: { current: () => ({ admitted: false }) },
    },
    {
      provide: RuntimeReadinessService,
      useValue: { current: () => ({ status: "not_ready" }) },
    },
    {
      provide: APP_GUARD,
      useClass: RuntimeWorkAdmissionGuard,
    },
    PlatformTechnicalQuoteServiceAuthenticationGuard,
    {
      provide: PlatformTechnicalQuoteServiceAuthenticationVerifier,
      useClass: UnavailablePlatformTechnicalQuoteServiceAuthenticationVerifier,
    },
    {
      provide: PlatformExecutionTechnicalQuoteReaderService,
      useValue: { read: closedQuoteRead },
    },
  ],
})
class ClosedAdmissionTestModule {}

const rateLimitedQuoteRead = vi.fn(() => ({
  schema_version: "platform-execution-technical-quote/v1",
}));

@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1 }]),
  ],
  controllers: [PlatformExecutionTechnicalQuoteController],
  providers: [
    { provide: APP_GUARD, useClass: WsThrottlerGuard },
    PlatformTechnicalQuoteServiceAuthenticationGuard,
    {
      provide: PlatformTechnicalQuoteServiceAuthenticationVerifier,
      useValue: {
        readiness: () => ({
          status: "ready",
          code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_READY",
        }),
        verify: async () => ({
          authenticationMode: "SERVICE_ONLY",
          principalId: "growthos-platform-authority",
          scopes: [PLATFORM_TECHNICAL_QUOTE_READ_SCOPE],
        }),
      },
    },
    {
      provide: PlatformExecutionTechnicalQuoteReaderService,
      useValue: { read: rateLimitedQuoteRead },
    },
  ],
})
class RateLimitTestModule {}

async function start(
  module: Parameters<typeof NestFactory.create>[0],
): Promise<Readonly<{ app: NestExpressApplication; baseUrl: string }>> {
  const app = await NestFactory.create<NestExpressApplication>(module, {
    logger: false,
    rawBody: true,
  });
  app.setGlobalPrefix("api");
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
  app.useGlobalFilters(new GlobalHttpExceptionFilter());
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as AddressInfo;
  return Object.freeze({ app, baseUrl: `http://127.0.0.1:${address.port}` });
}

async function post(baseUrl: string, path: string, headers = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", ...headers },
    body: path.includes("technical-quote") ? VALID_BODY : "{}",
  });
}

describe("Platform technical quote full guard composition", () => {
  let closed: Awaited<ReturnType<typeof start>>;
  let limited: Awaited<ReturnType<typeof start>>;

  beforeAll(async () => {
    closed = await start(ClosedAdmissionTestModule);
    limited = await start(RateLimitTestModule);
  });

  afterAll(async () => {
    await Promise.all([closed?.app.close(), limited?.app.close()]);
  });

  it("bypasses only generic work admission and still fails at dedicated auth", async () => {
    const response = await post(
      closed.baseUrl,
      "/api/v1/platform-authority/technical-quote",
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_UNAVAILABLE",
        message: "platform technical quote authentication is unavailable",
      },
    });
    expect(closedQuoteRead).not.toHaveBeenCalled();
  });

  it("does not let request headers bypass ordinary mutation admission", async () => {
    const response = await post(
      closed.baseUrl,
      "/api/v1/ordinary-mutation",
      { "x-read-only-control-plane": "true" },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "RUNTIME_ADMISSION_CLOSED" },
    });
  });

  it("preserves global throttle order and returns the documented stable 429", async () => {
    const path = "/api/v1/platform-authority/technical-quote";
    expect((await post(limited.baseUrl, path)).status).toBe(200);
    const response = await post(limited.baseUrl, path);
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "PLATFORM_TECHNICAL_QUOTE_RATE_LIMITED",
        message: "platform technical quote rate limit exceeded",
      },
    });
    expect(rateLimitedQuoteRead).toHaveBeenCalledOnce();
  });

  it("keeps global throttle before work admission in the real AppModule", () => {
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      AppModule,
    ) as readonly { provide?: unknown; useClass?: unknown }[];
    expect(
      providers
        .filter((provider) => provider.provide === APP_GUARD)
        .map((provider) => provider.useClass),
    ).toEqual([WsThrottlerGuard, RuntimeWorkAdmissionGuard]);
  });
});
