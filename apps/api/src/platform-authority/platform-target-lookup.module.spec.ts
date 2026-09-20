import "reflect-metadata";
import Redis from "ioredis";
import { Global, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeAdmissionService } from "../runtime/runtime-admission";
import { RuntimeReadinessContributorRegistry } from "../runtime/runtime-readiness-registry";
import { EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE } from "../execution-budget/execution-budget-authority.repository";
import { PlatformTargetReaderJwksVerifier } from "./platform-target-reader-jwks-verifier";
import { PlatformTargetLookupRepository } from "./platform-target-lookup.repository";
import { PlatformTargetLookupRedisRuntime } from "./platform-target-lookup-redis.runtime";
import { PlatformTargetLookupService } from "./platform-target-lookup.service";
import { AppModule } from "../app.module";
import { MODULE_METADATA } from "@nestjs/common/constants";
import {
  PlatformTargetLookupModule,
  PlatformTargetLookupReadinessContributor,
  PLATFORM_TARGET_LOOKUP_READINESS,
} from "./platform-target-lookup.module";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
function setup(monotonicNow: () => number = () => 100) {
  const registry = new RuntimeReadinessContributorRegistry();
  const verifier = { readiness: vi.fn(async () => true) };
  const repository = { readiness: vi.fn(async () => true) };
  const redis = { readiness: vi.fn(async () => true) };
  const admission = { current: vi.fn(() => ({ admitted: true })) };
  const contributor = new PlatformTargetLookupReadinessContributor({
    registry,
    verifier,
    repository,
    redis,
    admission,
    monotonicNow,
  });
  contributor.onModuleInit();
  return { registry, verifier, repository, redis, admission, contributor };
}
describe("target lookup production module and independent capability readiness", () => {
  it("is installed in the single product composition root", () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule)).toContain(
      PlatformTargetLookupModule,
    );
  });
  it("requires all three real capability boundaries under one deadline", async () => {
    const s = setup();
    expect(await s.registry.check(PLATFORM_TARGET_LOOKUP_READINESS)).toEqual({
      status: "ok",
    });
    for (const probe of [s.verifier, s.repository, s.redis])
      expect(probe.readiness).toHaveBeenCalledWith(2100);
    s.contributor.onModuleDestroy();
    expect(
      await s.registry.check(PLATFORM_TARGET_LOOKUP_READINESS),
    ).toMatchObject({ status: "failed" });
  });
  it.each(["verifier", "repository", "redis"] as const)(
    "does not mask an unavailable %s",
    async (name) => {
      const s = setup();
      s[name].readiness.mockResolvedValue(false);
      expect(await s.registry.check(PLATFORM_TARGET_LOOKUP_READINESS)).toEqual({
        status: "failed",
        code: "PLATFORM_AUTHORITY_TARGET_LOOKUP_UNAVAILABLE",
      });
    },
  );
  it("does not probe dependencies when release admission is closed", async () => {
    const s = setup();
    s.admission.current.mockReturnValue({ admitted: false });
    expect(
      await s.registry.check(PLATFORM_TARGET_LOOKUP_READINESS),
    ).toMatchObject({ status: "failed" });
    expect(s.verifier.readiness).not.toHaveBeenCalled();
    expect(s.repository.readiness).not.toHaveBeenCalled();
    expect(s.redis.readiness).not.toHaveBeenCalled();
  });
  it.each([NaN, Infinity, -1])(
    "rejects an invalid readiness clock %s",
    async (value) => {
      const s = setup(() => value);
      expect(
        await s.registry.check(PLATFORM_TARGET_LOOKUP_READINESS),
      ).toMatchObject({ status: "failed" });
      expect(s.verifier.readiness).not.toHaveBeenCalled();
    },
  );
  it("does not expose probe exceptions or accept truthy readiness", async () => {
    const s = setup();
    s.verifier.readiness.mockImplementation(async () => {
      throw new Error("private-probe-canary");
    });
    expect(await s.registry.check(PLATFORM_TARGET_LOOKUP_READINESS)).toEqual({
      status: "failed",
      code: "PLATFORM_AUTHORITY_TARGET_LOOKUP_UNAVAILABLE",
    });
    s.verifier.readiness.mockResolvedValue("ready" as unknown as boolean);
    expect(
      await s.registry.check(PLATFORM_TARGET_LOOKUP_READINESS),
    ).toMatchObject({ status: "failed" });
  });
  it("rejects a clock reversal or closing admission after asynchronous probes", async () => {
    let calls = 0;
    const reversed = setup(() => (++calls === 1 ? 100 : 99));
    expect(
      await reversed.registry.check(PLATFORM_TARGET_LOOKUP_READINESS),
    ).toMatchObject({ status: "failed" });
    const s = setup();
    s.redis.readiness.mockImplementation(async () => {
      s.admission.current.mockReturnValue({ admitted: false });
      return true;
    });
    expect(
      await s.registry.check(PLATFORM_TARGET_LOOKUP_READINESS),
    ).toMatchObject({ status: "failed" });
  });
  it("bounds stalled probes without converting a late success into readiness", async () => {
    vi.useFakeTimers();
    const s = setup();
    let finish: ((value: boolean) => void) | undefined;
    s.repository.readiness.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const check = s.registry.check(PLATFORM_TARGET_LOOKUP_READINESS);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await check).toMatchObject({ status: "failed" });
    finish?.(true);
    await Promise.resolve();
    s.contributor.onModuleDestroy();
  });
  it("connects the guarded production service to supplied runtime boundaries", async () => {
    const registry = new RuntimeReadinessContributorRegistry();
    const admission = { current: () => ({ admitted: true }) };
    @Global()
    @Module({
      providers: [
        { provide: RuntimeReadinessContributorRegistry, useValue: registry },
        { provide: RuntimeAdmissionService, useValue: admission },
      ],
      exports: [RuntimeReadinessContributorRegistry, RuntimeAdmissionService],
    })
    class RuntimeDependencies {}
    const identity = {
      authenticationMode: "SERVICE_ONLY",
      issuer: "https://growthos.example",
      subject: "growthos:reader",
      targetIssuer: "https://growthos.example",
      scope: "platform-authority.target.read",
    };
    const verifier = {
      verify: vi.fn(async () => identity),
      readiness: async () => true,
    };
    const repository = {
      lookup: vi.fn(async () => true),
      readiness: async () => true,
    };
    const redis = {
      allow: vi.fn(async () => true),
      readiness: async () => true,
    };
    vi.stubEnv("EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL", "");
    @Module({
      imports: [
        RuntimeDependencies,
        {
          module: PlatformTargetLookupModule,
          providers: [
            {
              provide: EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE,
              useValue: null,
            },
            { provide: PlatformTargetReaderJwksVerifier, useValue: verifier },
            { provide: PlatformTargetLookupRepository, useValue: repository },
            { provide: PlatformTargetLookupRedisRuntime, useValue: redis },
          ],
        },
      ],
    })
    class TestRoot {}
    const module = await NestFactory.createApplicationContext(TestRoot, {
      logger: false,
      abortOnError: false,
    });
    try {
      await module.init();
      const request = {
        target_issuer: identity.targetIssuer,
        target_jti: "22222222-2222-4222-8222-222222222222",
        schedule_id: "acq-sweep",
        workflow_run_id: "33333333-3333-4333-8333-333333333333",
        nonce: "a".repeat(32),
      };
      const result = await module.get(PlatformTargetLookupService).read({
        method: "POST",
        originalUrl: "/api/v1/platform-authority/target-lookup",
        rawHeaders: [
          "content-type",
          "application/json",
          "authorization",
          "Bearer synthetic.payload.signature",
        ],
        rawBody: Buffer.from(JSON.stringify(request)),
      });
      expect(result).toMatchObject({ ...request, found: true });
      expect(repository.lookup).toHaveBeenCalledTimes(1);
      expect(await registry.check(PLATFORM_TARGET_LOOKUP_READINESS)).toEqual({
        status: "ok",
      });
    } finally {
      await module.close();
    }
  });
  it("passes configured resources through the registered production Redis factory", async () => {
    vi.stubEnv("REDIS_URL", "redis://127.0.0.1:16379/0");
    vi.stubEnv("PLATFORM_AUTHORITY_TARGET_LOOKUP_RATE_LIMIT", "3");
    vi.stubEnv("PLATFORM_AUTHORITY_TARGET_LOOKUP_RATE_WINDOW_MS", "1000");
    // Replace only the socket boundary; exercise the registered factory and
    // real runtime configuration, deadline and limiter handling.
    vi.spyOn(Redis.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(Redis.prototype, "ping").mockResolvedValue("PONG");
    vi.spyOn(Redis.prototype, "eval").mockResolvedValue(1);
    vi.spyOn(Redis.prototype, "disconnect").mockImplementation(() => {});
    const providers = Reflect.getMetadata(
      "providers",
      PlatformTargetLookupModule,
    );
    const provider = providers.find(
      (entry: { provide?: unknown }) =>
        entry.provide === PlatformTargetLookupRedisRuntime,
    );
    const runtime: PlatformTargetLookupRedisRuntime = provider.useFactory();
    try {
      expect(await runtime.readiness(performance.now() + 2000)).toBe(true);
      expect(
        await runtime.allow(
          { issuer: "https://growthos.example", subject: "growthos:reader" },
          performance.now() + 2000,
        ),
      ).toBe(true);
    } finally {
      runtime.onModuleDestroy();
      vi.restoreAllMocks();
    }
  });
  it("constructs real unavailable boundaries for missing configuration without a synthetic fallback", async () => {
    for (const name of [
      "EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL",
      "REDIS_URL",
      "PLATFORM_AUTHORITY_TARGET_LOOKUP_RATE_LIMIT",
      "PLATFORM_AUTHORITY_TARGET_LOOKUP_RATE_WINDOW_MS",
      "PLATFORM_AUTHORITY_TARGET_READER_JWKS_URI",
      "PLATFORM_AUTHORITY_TARGET_READER_ISSUER",
      "PLATFORM_AUTHORITY_TARGET_READER_SUBJECT",
      "PLATFORM_AUTHORITY_TARGET_READER_TARGET_ISSUER",
    ])
      vi.stubEnv(name, "");
    const registry = new RuntimeReadinessContributorRegistry();
    @Global()
    @Module({
      providers: [
        { provide: RuntimeReadinessContributorRegistry, useValue: registry },
        {
          provide: RuntimeAdmissionService,
          useValue: { current: () => ({ admitted: false }) },
        },
      ],
      exports: [RuntimeReadinessContributorRegistry, RuntimeAdmissionService],
    })
    class ClosedRuntime {}
    @Module({ imports: [ClosedRuntime, PlatformTargetLookupModule] })
    class DiagnosticRoot {}
    const app = await NestFactory.createApplicationContext(DiagnosticRoot, {
      logger: false,
      abortOnError: false,
    });
    try {
      const deadline = performance.now() + 2000;
      expect(
        await app.get(PlatformTargetReaderJwksVerifier).readiness(deadline),
      ).toBe(false);
      expect(
        await app.get(PlatformTargetLookupRepository).readiness(deadline),
      ).toBe(false);
      expect(
        await app.get(PlatformTargetLookupRedisRuntime).readiness(deadline),
      ).toBe(false);
      expect(
        await registry.check(PLATFORM_TARGET_LOOKUP_READINESS),
      ).toMatchObject({ status: "failed" });
      await expect(
        app.get(PlatformTargetLookupService).read({} as never),
      ).rejects.toThrow("PLATFORM_AUTHORITY_TARGET_LOOKUP_UNAVAILABLE");
    } finally {
      await app.close();
    }
  });
});
