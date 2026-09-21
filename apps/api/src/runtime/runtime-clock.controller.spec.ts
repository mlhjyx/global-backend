import "reflect-metadata";
import { Global, Module, VersioningType } from "@nestjs/common";
import { APP_GUARD, NestFactory, Reflector } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { RuntimeClockModule } from "./runtime-clock.module";
import { RuntimeAdmissionService } from "./runtime-admission";
import { RuntimeReleaseIdentityService } from "./runtime-release-identity";
import { AppModule } from "../app.module";
import { RuntimeWorkAdmissionGuard } from "./runtime-work-admission.guard";
import { RuntimeReadinessService } from "../health/runtime-readiness.service";
import { MODULE_METADATA } from "@nestjs/common/constants";
import {
  revocationFixture,
  tlsRequest,
} from "../platform-authority/platform-revocation-http.test-fixture";

let fixture: Awaited<ReturnType<typeof revocationFixture>>,
  app: NestExpressApplication,
  origin: string,
  ca: Buffer;
let admitted = true;
const aggregate = {
  current: vi.fn(() => {
    throw new Error(
      "aggregate readiness must not be read for clock observations",
    );
  }),
};
beforeAll(async () => {
  fixture = await revocationFixture();
  ca = readFileSync(fixture.certificate);
  @Global()
  @Module({
    providers: [
      {
        provide: RuntimeAdmissionService,
        useValue: { current: () => ({ admitted }) },
      },
      {
        provide: RuntimeReleaseIdentityService,
        useValue: {
          current: () => ({
            attested: true,
            build_sha: "1".repeat(40),
            image_digest: `sha256:${"2".repeat(64)}`,
            artifact_digest: `sha256:${"3".repeat(64)}`,
          }),
        },
      },
      { provide: RuntimeReadinessService, useValue: aggregate },
    ],
    exports: [
      RuntimeAdmissionService,
      RuntimeReleaseIdentityService,
      RuntimeReadinessService,
    ],
  })
  class TestPorts {}
  @Module({
    imports: [TestPorts, RuntimeClockModule],
    providers: [
      {
        provide: APP_GUARD,
        inject: [RuntimeAdmissionService, RuntimeReadinessService, Reflector],
        useFactory: (
          own: RuntimeAdmissionService,
          readiness: RuntimeReadinessService,
          reflector: Reflector,
        ) => new RuntimeWorkAdmissionGuard(own, readiness, reflector),
      },
    ],
  })
  class TestApp {}
  app = await NestFactory.create<NestExpressApplication>(TestApp, {
    logger: false,
    httpsOptions: { key: readFileSync(fixture.key), cert: ca },
  });
  app.setGlobalPrefix("api");
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
  await app.listen(0, "127.0.0.1");
  origin = `https://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
}, 15000);
afterAll(async () => {
  await app?.close();
  await fixture?.close();
});
it("serves actual local time with exact identity/nonce/no-store over verified HTTPS", async () => {
  const before = Date.now(),
    nonce = "a".repeat(32);
  const result = await tlsRequest(
    `${origin}/api/v1/health/clock?nonce=${nonce}`,
    ca,
    undefined,
    {},
    "GET",
  );
  expect(result.status).toBe(200);
  expect(result.headers["cache-control"]).toBe("no-store");
  const body = JSON.parse(result.body);
  expect(Object.keys(body).sort()).toEqual([
    "artifactDigest",
    "buildSha",
    "imageDigest",
    "nonce",
    "observedAt",
    "schemaVersion",
  ]);
  expect(body.nonce).toBe(nonce);
  expect(body.observedAt).toBeGreaterThanOrEqual(before);
  expect(body.observedAt).toBeLessThanOrEqual(Date.now());
  expect(body.artifactDigest).toBe(`sha256:${"3".repeat(64)}`);
});
it("rejects extra query, POST, and missing own admission without consulting aggregate readiness", async () => {
  expect(
    (
      await tlsRequest(
        `${origin}/api/v1/health/clock?nonce=${"a".repeat(32)}&extra=1`,
        ca,
        undefined,
        {},
        "GET",
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await tlsRequest(
        `${origin}/api/v1/health/clock`,
        ca,
        undefined,
        {},
        "POST",
      )
    ).status,
  ).toBe(404);
  admitted = false;
  expect(
    (
      await tlsRequest(
        `${origin}/api/v1/health/clock?nonce=${"a".repeat(32)}`,
        ca,
        undefined,
        {},
        "GET",
      )
    ).status,
  ).toBe(503);
  admitted = true;
  expect(aggregate.current).not.toHaveBeenCalled();
});
it("registers the clock module exactly once in the actual product AppModule", () => {
  const imports = Reflect.getMetadata(
    MODULE_METADATA.IMPORTS,
    AppModule,
  ) as unknown[];
  expect(imports.filter((item) => item === RuntimeClockModule)).toHaveLength(1);
});
it("publishes code-first exact closed schema without a mutation exemption", () => {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().build(),
  );
  expect(document.paths["/api/v1/health/clock"]?.get?.operationId).toBe(
    "readRuntimeClock_v1",
  );
  expect(document.paths["/api/v1/health/clock"]?.post).toBeUndefined();
});
