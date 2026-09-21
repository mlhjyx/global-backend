import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Global, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { readFileSync } from "node:fs";
import { PlatformAuthorityModule } from "./platform-authority.module";
import { PlatformCapabilityContributor } from "./platform-capability-contributor";
import { capabilityRuntimeFixture } from "./platform-capability-runtime.test-fixture";
import { RuntimeReadinessContributorRegistry } from "../runtime/runtime-readiness-registry";
import { RuntimeAdmissionService } from "../runtime/runtime-admission";
import { RuntimeReleaseIdentityService } from "../runtime/runtime-release-identity";
import { startCapabilityRuntime } from "./platform-capability-runtime";

describe("same capability lifecycle in API and platform Worker", () => {
  let fixture: Awaited<ReturnType<typeof capabilityRuntimeFixture>>;
  beforeAll(async () => {
    fixture = await capabilityRuntimeFixture();
  }, 15000);
  afterAll(async () => fixture?.close());
  it("registers the lifecycle provider in the actual API module", () => {
    expect(
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, PlatformAuthorityModule),
    ).toContain(PlatformCapabilityContributor);
  });
  it("starts the shared reader before platform capability admission and owns cleanup", () => {
    const source = readFileSync(
      new URL("../temporal/platform-worker.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("startCapabilityRuntime");
    const start = source.indexOf("capability = startCapabilityRuntime(");
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(
      source.indexOf(
        "await waitForWorkerDependencyAdmission({ check, onBlocked: blocked })",
      ),
    );
    expect(source).toContain("capability?.stop()");
  });
  it("boots the actual API module and an independent Worker factory against real TLS with no aggregate readiness provider", async () => {
    for (const [key, value] of Object.entries(fixture.env))
      vi.stubEnv(key, value);
    const apiRegistry = new RuntimeReadinessContributorRegistry(),
      workerRegistry = new RuntimeReadinessContributorRegistry();
    let ownAdmission = true;
    @Global()
    @Module({
      providers: [
        { provide: RuntimeReadinessContributorRegistry, useValue: apiRegistry },
        {
          provide: RuntimeAdmissionService,
          useValue: { current: () => ({ admitted: ownAdmission }) },
        },
        {
          provide: RuntimeReleaseIdentityService,
          useValue: { current: () => fixture.identity },
        },
      ],
      exports: [
        RuntimeReadinessContributorRegistry,
        RuntimeAdmissionService,
        RuntimeReleaseIdentityService,
      ],
    })
    class Ports {}
    @Module({ imports: [Ports, PlatformAuthorityModule] })
    class Api {}
    const app = await NestFactory.createApplicationContext(Api, {
      logger: false,
    });
    const worker = startCapabilityRuntime({
      registry: workerRegistry,
      identity: fixture.identity,
      admitted: () => true,
      env: fixture.env,
    });
    try {
      app.get(PlatformCapabilityContributor).onModuleInit(); // repeat init does not duplicate registration or bootstrap
      await worker.refresh();
      const deadline = performance.now() + 3000;
      while (
        (await apiRegistry.check("platform_acq_sweep_issuer")).status !==
          "ok" &&
        performance.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(
        (await apiRegistry.check("platform_acq_sweep_issuer")).status,
      ).toBe("ok");
      expect(
        (await workerRegistry.check("platform_acq_sweep_issuer")).status,
      ).toBe("ok");
      expect(fixture.state.mints).toBe(2);
      ownAdmission = false;
      expect(
        (await apiRegistry.check("platform_acq_sweep_issuer")).status,
      ).toBe("failed");
      expect(
        (await workerRegistry.check("platform_acq_sweep_issuer")).status,
      ).toBe("ok");
    } finally {
      worker.stop();
      await app.close();
      vi.unstubAllEnvs();
    }
    expect((await apiRegistry.check("platform_acq_sweep_issuer")).code).toBe(
      "READINESS_CONTRIBUTOR_MISSING",
    );
    expect((await workerRegistry.check("platform_acq_sweep_issuer")).code).toBe(
      "READINESS_CONTRIBUTOR_MISSING",
    );
  });
});
