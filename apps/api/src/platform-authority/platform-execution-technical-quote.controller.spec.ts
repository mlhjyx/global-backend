import "reflect-metadata";

import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { Module, VersioningType } from "@nestjs/common";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { GlobalHttpExceptionFilter } from "../common/http-exception.filter";
import { loadVerifiedPlatformAuthorityPolicyAsset } from "./platform-authority-policy-asset";
import { PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1 } from "./platform-execution-contract";
import { resolveCurrentPlatformExecutionProviderSnapshotV1 } from "./platform-execution-provider-snapshot";
import { PlatformExecutionTechnicalQuoteController } from "./platform-execution-technical-quote.controller";
import { PlatformExecutionTechnicalQuoteReaderService } from "./platform-execution-technical-quote-reader";
import { PlatformExecutionTechnicalQuoteService } from "./platform-execution-technical-quote";
import {
  PLATFORM_TECHNICAL_QUOTE_READ_SCOPE,
  PlatformTechnicalQuoteServiceAuthenticationGuard,
  PlatformTechnicalQuoteServiceAuthenticationVerifier,
  UnavailablePlatformTechnicalQuoteServiceAuthenticationVerifier,
} from "./platform-technical-quote-service-auth";
import { PlatformAuthorityModule } from "./platform-authority.module";

const NOW = 1_788_472_800;
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

const allowVerifier = {
  readiness: () => Object.freeze({
    status: "ready",
    code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_READY",
  }),
  verify: async () => Object.freeze({
    authenticationMode: "SERVICE_ONLY" as const,
    principalId: "growthos-platform-authority",
    scopes: Object.freeze([PLATFORM_TECHNICAL_QUOTE_READ_SCOPE]),
  }),
} as PlatformTechnicalQuoteServiceAuthenticationVerifier;

const quoteReader = new PlatformExecutionTechnicalQuoteReaderService({
  quoteService: new PlatformExecutionTechnicalQuoteService({
    policyAsset: loadVerifiedPlatformAuthorityPolicyAsset(),
    technicalContract: PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1,
  }),
  now: () => new Date(NOW * 1_000),
  providerSnapshot: resolveCurrentPlatformExecutionProviderSnapshotV1,
});

@Module({
  controllers: [PlatformExecutionTechnicalQuoteController],
  providers: [
    PlatformTechnicalQuoteServiceAuthenticationGuard,
    {
      provide: PlatformTechnicalQuoteServiceAuthenticationVerifier,
      useValue: allowVerifier,
    },
    {
      provide: PlatformExecutionTechnicalQuoteReaderService,
      useValue: quoteReader,
    },
  ],
})
class QuoteReaderTestModule {}

describe("PlatformExecutionTechnicalQuoteController", () => {
  let app: NestExpressApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(
      QuoteReaderTestModule,
      { logger: false, rawBody: true },
    );
    app.setGlobalPrefix("api");
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
    app.useGlobalFilters(new GlobalHttpExceptionFilter());
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  async function post(
    body: string | Uint8Array,
    contentType = "application/json",
    extraHeaders: Readonly<Record<string, string>> = {},
  ) {
    return fetch(`${baseUrl}/api/v1/platform-authority/technical-quote`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": contentType, ...extraHeaders },
      body: body as BodyInit,
    });
  }

  it("serves one bounded quote with no redirect or credential echo", async () => {
    const response = await post(VALID_BODY);
    const bytes = Buffer.from(await response.arrayBuffer());
    const payload = JSON.parse(bytes.toString("utf8")) as {
      data: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(bytes.length).toBeLessThanOrEqual(16 * 1024);
    expect(payload.data).toMatchObject({
      schema_version: "platform-execution-technical-quote/v1",
      schedule_id: "acq-sweep",
      workflow_run_id: "11111111-1111-4111-8111-111111111111",
      required_cap_per_run_microusd: "1",
    });
    expect(bytes.toString("utf8")).not.toMatch(
      /bearer|service_credential|access_token|refresh_token|raw_jws/i,
    );
  });

  it.each([
    ["duplicate key", VALID_BODY.replace(
      '"purpose":"platform.acquisition"',
      '"purpose":"platform.sanctions","purpose":"platform.acquisition"',
    ), "application/json"],
    ["content type parameter", VALID_BODY, "application/json; charset=utf-8"],
    ["unknown amount", VALID_BODY.replace(/}$/, ',"cap_microusd":"1"}'), "application/json"],
    ["body over 16 KiB", VALID_BODY.replace(
      /}$/,
      `,"padding":"${"x".repeat(16_384)}"}`,
    ), "application/json"],
    ["malformed JSON", '{"schema_version":', "application/json"],
    ["trailing non-whitespace bytes", `${VALID_BODY}x`, "application/json"],
  ])("rejects a raw %s before quote calculation", async (_label, body, type) => {
    const response = await post(body, type);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "PLATFORM_EXECUTION_BUDGET_QUOTE_INVALID",
        message: "platform technical quote request is invalid",
      },
    });
  });

  it("rejects query credentials at the dedicated service guard", async () => {
    const response = await fetch(
      `${baseUrl}/api/v1/platform-authority/technical-quote?token=forbidden`,
      {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json" },
        body: VALID_BODY,
      },
    );
    expect(response.status).toBe(401);
    expect(JSON.stringify(await response.json())).not.toContain("forbidden");
  });

  it("redacts parser diagnostics even when a query is present", async () => {
    const response = await fetch(
      `${baseUrl}/api/v1/platform-authority/technical-quote?token=forbidden`,
      {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json" },
        body: '{"schema_version":',
      },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "PLATFORM_EXECUTION_BUDGET_QUOTE_INVALID",
        message: "platform technical quote request is invalid",
      },
    });
  });

  it.each([
    [
      "gzip content encoding",
      gzipSync(Buffer.from(VALID_BODY, "utf8")),
      "application/json",
      { "content-encoding": "gzip" },
    ],
    [
      "unsupported content encoding",
      VALID_BODY,
      "application/json",
      { "content-encoding": "compress" },
    ],
    [
      "non-UTF-8 charset",
      VALID_BODY,
      "application/json; charset=iso-8859-1",
      {},
    ],
    [
      "global parser size overflow",
      `{"padding":"${"x".repeat(110_000)}"}`,
      "application/json",
      {},
    ],
  ] as const)(
    "rejects %s as one raw-wire error without invoking the quote service",
    async (_label, body, contentType, headers) => {
      const read = vi.spyOn(quoteReader, "read");
      try {
        const response = await post(body, contentType, headers);
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
          error: {
            code: "PLATFORM_EXECUTION_BUDGET_QUOTE_INVALID",
            message: "platform technical quote request is invalid",
          },
        });
        expect(read).not.toHaveBeenCalled();
      } finally {
        read.mockRestore();
      }
    },
  );

  it("composes only an unavailable service verifier in the product module", async () => {
    const [moduleSource, mainSource, appModuleSource] = await Promise.all([
      readFile(new URL("./platform-authority.module.ts", import.meta.url), "utf8"),
      readFile(new URL("../main.ts", import.meta.url), "utf8"),
      readFile(new URL("../app.module.ts", import.meta.url), "utf8"),
    ]);
    expect(moduleSource).not.toMatch(
      /AuthModule|AuthGuard|TokenVerifier|JWKS|workspace|api.?key|dev.?token|unsigned|fallback/i,
    );
    expect(moduleSource).not.toMatch(/process\.env/);
    expect(mainSource).toMatch(
      /NestFactory\.create<NestExpressApplication>\(AppModule,\s*\{\s*rawBody:\s*true,?\s*\}\)/,
    );
    expect(appModuleSource).toContain("PlatformAuthorityModule");

    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      PlatformAuthorityModule,
    ) as readonly unknown[];
    const verifierProvider = providers.find(
      (provider): provider is {
        provide: typeof PlatformTechnicalQuoteServiceAuthenticationVerifier;
        useClass: typeof UnavailablePlatformTechnicalQuoteServiceAuthenticationVerifier;
      } =>
        typeof provider === "object" &&
        provider !== null &&
        "provide" in provider &&
        provider.provide === PlatformTechnicalQuoteServiceAuthenticationVerifier,
    );
    expect(verifierProvider?.useClass).toBe(
      UnavailablePlatformTechnicalQuoteServiceAuthenticationVerifier,
    );
    expect(new verifierProvider!.useClass().readiness()).toEqual({
      status: "not_ready",
      code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_UNAVAILABLE",
    });
  });
});
