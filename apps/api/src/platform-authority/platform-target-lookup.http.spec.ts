import "reflect-metadata";
import { Module, VersioningType, HttpException } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from "@nestjs/swagger";
import type { AddressInfo } from "node:net";
import type { Request } from "express";
import Ajv from "ajv";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PlatformTargetLookupController } from "./platform-target-lookup.controller";
import { PlatformTargetLookupGuard } from "./platform-target-lookup.guard";
import { PlatformTargetLookupService } from "./platform-target-lookup.service";
import { PlatformTargetReaderDeniedError } from "./platform-target-reader-jwks-verifier";
import { READ_ONLY_CONTROL_PLANE_METADATA } from "../runtime/read-only-control-plane.decorator";
import { GlobalHttpExceptionFilter } from "../common/http-exception.filter";

const PATH = "/api/v1/platform-authority/target-lookup";
const SYNTHETIC_COMPACT_JWS = "test.header.signature";
const request = {
  target_issuer: "https://growthos.example/",
  target_jti: "22222222-2222-4222-8222-222222222222",
  schedule_id: "acq-sweep",
  workflow_run_id: "33333333-3333-4333-8333-333333333333",
  nonce: "0123456789abcdef0123456789abcdef",
};
const identity = Object.freeze({
  authenticationMode: "SERVICE_ONLY" as const,
  issuer: "https://identity.example/",
  subject: "growthos:control-plane",
  targetIssuer: request.target_issuer,
  scope: "platform-authority.target.read" as const,
});
const verifier = {
  verify: vi.fn(async (_compact: string, _deadline: number) => identity),
};
const repository = {
  lookup: vi.fn(async (_request: unknown, _deadline: number) => true),
};
const limiter = {
  allow: vi.fn(async (_identity: unknown, _deadline: number) => true),
};
let admitted = true;
const service = new PlatformTargetLookupService({
  verifier,
  repository,
  limiter,
  admitted: () => admitted,
  now: () => new Date(1788830000000),
});
const read = vi.spyOn(service, "read");

@Module({
  controllers: [PlatformTargetLookupController],
  providers: [
    PlatformTargetLookupGuard,
    { provide: PlatformTargetLookupService, useValue: service },
  ],
})
class TargetLookupHttpTestModule {}

describe("Nest target lookup adapter over the real bounded core", () => {
  let app: NestExpressApplication;
  let origin: string;
  let document: OpenAPIObject;
  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(
      TargetLookupHttpTestModule,
      { logger: false, rawBody: true },
    );
    app.setGlobalPrefix("api");
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
    app.useGlobalFilters(new GlobalHttpExceptionFilter());
    document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .addBearerAuth(
          { type: "http", scheme: "bearer", bearerFormat: "JWT" },
          "platformAuthorityTargetReader",
        )
        .build(),
    );
    await app.listen(0, "127.0.0.1");
    origin =
      "http://127.0.0.1:" + (app.getHttpServer().address() as AddressInfo).port;
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    admitted = true;
    verifier.verify.mockResolvedValue(identity);
    repository.lookup.mockResolvedValue(true);
    limiter.allow.mockResolvedValue(true);
  });
  const post = (
    body = JSON.stringify(request),
    headers: Record<string, string> = { Authorization: "Bearer " + SYNTHETIC_COMPACT_JWS },
    suffix = "",
  ) =>
    fetch(origin + PATH + suffix, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", ...headers },
      body,
    });

  it("executes the guarded pipeline once and returns a closed no-store observation root, not a data wrapper", async () => {
    const response = await post();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBeNull();
    expect(body).toEqual({
      schema_version: "platform-authority-target-observation/v1",
      ...request,
      found: true,
      observed_at: 1788830000,
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(verifier.verify).toHaveBeenCalledTimes(1);
    expect(limiter.allow).toHaveBeenCalledTimes(1);
    expect(repository.lookup).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(body)).not.toContain(SYNTHETIC_COMPACT_JWS);
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(4096);
    expect(
      Reflect.getMetadata(
        READ_ONLY_CONTROL_PLANE_METADATA,
        PlatformTargetLookupController.prototype.read,
      ),
    ).toBe(true);
  });

  it("does not turn a router GET 404 into a committed target absence observation", async () => {
    const response = await fetch(origin + PATH, {
      method: "GET",
      redirect: "manual",
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: {
        code: "PLATFORM_AUTHORITY_TARGET_LOOKUP_UNAVAILABLE",
        message: "platform target lookup is unavailable",
      },
    });
    expect(read).not.toHaveBeenCalled();
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(limiter.allow).not.toHaveBeenCalled();
    expect(repository.lookup).not.toHaveBeenCalled();
  });

  it("sanitizes malformed JSON before the guard with no-store and no database work", async () => {
    const response = await post('{"nonce":"must-not-leak",');
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: {
        code: "PLATFORM_AUTHORITY_TARGET_LOOKUP_INVALID",
        message: "platform target lookup request is invalid",
      },
    });
    expect(read).not.toHaveBeenCalled();
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(limiter.allow).not.toHaveBeenCalled();
    expect(repository.lookup).not.toHaveBeenCalled();
  });

  it.each([
    ["missing bearer", 401, "PLATFORM_TARGET_READER_DENIED"],
    ["invalid signature", 401, "PLATFORM_TARGET_READER_DENIED"],
    [
      "wrong issuer scope",
      403,
      "PLATFORM_AUTHORITY_TARGET_LOOKUP_SCOPE_MISMATCH",
    ],
    ["extra request field", 400, "PLATFORM_AUTHORITY_TARGET_LOOKUP_INVALID"],
    [
      "duplicate decoded field",
      400,
      "PLATFORM_AUTHORITY_TARGET_LOOKUP_INVALID",
    ],
    ["cookie credential", 400, "PLATFORM_AUTHORITY_TARGET_LOOKUP_INVALID"],
    ["query string", 400, "PLATFORM_AUTHORITY_TARGET_LOOKUP_INVALID"],
    ["not found", 404, "PLATFORM_AUTHORITY_TARGET_LOOKUP_NOT_FOUND"],
    ["rate limit", 429, "PLATFORM_AUTHORITY_TARGET_LOOKUP_RATE_LIMITED"],
    [
      "admission unavailable",
      503,
      "PLATFORM_AUTHORITY_TARGET_LOOKUP_UNAVAILABLE",
    ],
    [
      "verifier unavailable",
      503,
      "PLATFORM_AUTHORITY_TARGET_LOOKUP_UNAVAILABLE",
    ],
    [
      "repository unavailable",
      503,
      "PLATFORM_AUTHORITY_TARGET_LOOKUP_UNAVAILABLE",
    ],
    [
      "limiter unavailable",
      503,
      "PLATFORM_AUTHORITY_TARGET_LOOKUP_UNAVAILABLE",
    ],
  ] as const)(
    "maps %s to %s without private diagnostics or unintended DB access",
    async (scenario, status, code) => {
      let body = JSON.stringify(request);
      let headers: Record<string, string> = {
        Authorization: "Bearer " + SYNTHETIC_COMPACT_JWS,
      };
      let suffix = "";
      if (scenario === "missing bearer") headers = {};
      if (scenario === "invalid signature")
        verifier.verify.mockRejectedValue(
          new PlatformTargetReaderDeniedError(),
        );
      if (scenario === "wrong issuer scope")
        body = JSON.stringify({
          ...request,
          target_issuer: "https://other.example/",
        });
      if (scenario === "extra request field")
        body = JSON.stringify({ ...request, workspace_id: "secret-tenant" });
      if (scenario === "duplicate decoded field")
        body = body.replace('"nonce":', '"n\\u006fnce":"wrong","nonce":');
      if (scenario === "cookie credential")
        headers.Cookie = "session=must-not-leak";
      if (scenario === "query string") suffix = "?nonce=must-not-leak";
      if (scenario === "not found") repository.lookup.mockResolvedValue(false);
      if (scenario === "rate limit") limiter.allow.mockResolvedValue(false);
      if (scenario === "admission unavailable") admitted = false;
      if (scenario === "verifier unavailable")
        verifier.verify.mockRejectedValue(new Error("must-not-leak:" + SYNTHETIC_COMPACT_JWS));
      if (scenario === "repository unavailable")
        repository.lookup.mockRejectedValue(
          new Error("must-not-leak:private SQL"),
        );
      if (scenario === "limiter unavailable")
        limiter.allow.mockRejectedValue(
          new Error("must-not-leak:private Redis"),
        );
      const response = await post(body, headers, suffix);
      const result = await response.json();
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(Object.keys(result)).toEqual(["error"]);
      expect(Object.keys(result.error).sort()).toEqual(["code", "message"]);
      expect(result.error.code).toBe(code);
      expect(JSON.stringify(result)).not.toMatch(
        /must-not-leak|test\.header\.signature|secret-tenant|22222222|private SQL|cause/,
      );
      if (scenario !== "not found" && scenario !== "repository unavailable")
        expect(repository.lookup).not.toHaveBeenCalled();
      else expect(repository.lookup).toHaveBeenCalledTimes(1);
    },
  );

  it("cannot bypass the guard by calling the controller with ordinary request properties", () => {
    const controller = new PlatformTargetLookupController();
    let error: unknown;
    try {
      controller.read({
        body: request,
        observation: { ...request, found: true },
      } as unknown as Request);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(503);
    expect((error as HttpException).getResponse()).toEqual({
      error: {
        code: "PLATFORM_AUTHORITY_TARGET_LOOKUP_UNAVAILABLE",
        message: "platform target lookup is unavailable",
      },
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("publishes the dedicated operation/security and closed schemas that reject broadened payloads", () => {
    const operation = document.paths[PATH]!.post!;
    expect(operation.operationId).toBe("platformAuthorityTargetLookup_v1");
    expect(operation.security).toEqual([{ platformAuthorityTargetReader: [] }]);
    expect(operation["x-required-service-scope"]).toBe(
      "platform-authority.target.read",
    );
    expect(operation["x-service-authentication"]).toMatchObject({
      algorithm: "RS256",
      type: "platform-authority-target-reader+jwt",
      audience: "global-backend:platform-authority-target-read",
      scope: "platform-authority.target.read",
      identity_token_fallback: false,
      workspace_token_fallback: false,
      unsigned_fallback: false,
    });
    const body = operation.requestBody as {
      required: boolean;
      content: Record<string, { schema: object }>;
    };
    expect(body.required).toBe(true);
    const response = operation.responses["200"] as {
      content: Record<string, { schema: object }>;
    };
    const ajv = new Ajv({ strict: false, validateFormats: false });
    const validateRequest = ajv.compile(
      body.content["application/json"]!.schema,
    );
    const validateResponse = ajv.compile(
      response.content["application/json"]!.schema,
    );
    expect(validateRequest(request)).toBe(true);
    expect(validateRequest({ ...request, workspace_id: "tenant" })).toBe(false);
    expect(validateRequest({ ...request, nonce: "A".repeat(32) })).toBe(false);
    const observed = {
      schema_version: "platform-authority-target-observation/v1",
      ...request,
      found: true,
      observed_at: 1788830000,
    };
    expect(validateResponse(observed)).toBe(true);
    expect(validateResponse({ ...observed, found: false })).toBe(false);
    expect(validateResponse({ data: observed })).toBe(false);
    expect(Object.keys(operation.responses).sort()).toEqual([
      "200",
      "400",
      "401",
      "403",
      "404",
      "429",
      "503",
    ]);
  });
});
