import "reflect-metadata";

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Global, Module, VersioningType } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { GlobalHttpExceptionFilter } from "../common/http-exception.filter";
import { RuntimeReadinessContributorRegistry } from "../runtime/runtime-readiness-registry";
import { PlatformAuthorityModule } from "./platform-authority.module";
import {
  PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_READINESS_CONTRIBUTOR,
  PLATFORM_TECHNICAL_QUOTE_READER_PRINCIPAL,
  PLATFORM_TECHNICAL_QUOTE_READ_SCOPE,
} from "./platform-technical-quote-service-auth";

const ISSUER = "http://127.0.0.1:18081/";
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

@Global()
@Module({
  providers: [RuntimeReadinessContributorRegistry],
  exports: [RuntimeReadinessContributorRegistry],
})
class QuoteReadinessTestModule {}

@Module({ imports: [QuoteReadinessTestModule, PlatformAuthorityModule] })
class ProductQuoteAuthenticationTestModule {}

describe("Platform quote product JWKS composition", () => {
  let app: NestExpressApplication;
  let jwksServer: Server;
  let privateKey: KeyLike;
  let jwksUri: string;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    const publicJwk = {
      ...(await exportJWK(pair.publicKey)),
      alg: "RS256",
      use: "sig",
      kid: "identity-current",
    };
    jwksServer = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/jwk-set+json" });
      response.end(JSON.stringify({ keys: [publicJwk] }));
    });
    await new Promise<void>((resolve) =>
      jwksServer.listen(0, "127.0.0.1", resolve),
    );
    const address = jwksServer.address() as AddressInfo;
    jwksUri = `http://127.0.0.1:${address.port}/.well-known/jwks.json`;

    vi.stubEnv("APP_ENVIRONMENT", "test");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("PLATFORM_TECHNICAL_QUOTE_AUTH_JWKS_URI", jwksUri);
    vi.stubEnv("PLATFORM_TECHNICAL_QUOTE_AUTH_ISSUER", ISSUER);

    app = await NestFactory.create<NestExpressApplication>(
      ProductQuoteAuthenticationTestModule,
      { logger: false, rawBody: true },
    );
    app.setGlobalPrefix("api");
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
    app.useGlobalFilters(new GlobalHttpExceptionFilter());
    await app.listen(0, "127.0.0.1");
  });

  afterAll(async () => {
    await app?.close();
    await new Promise<void>((resolve, reject) =>
      jwksServer?.close((error) => (error ? reject(error) : resolve())),
    );
    vi.unstubAllEnvs();
  });

  async function token(profile: "service" | "user"): Promise<string> {
    const now = Math.floor(Date.now() / 1_000);
    const claims =
      profile === "service"
        ? {
            iss: ISSUER,
            aud: "global-backend:platform-technical-quote",
            sub: PLATFORM_TECHNICAL_QUOTE_READER_PRINCIPAL,
            scope: PLATFORM_TECHNICAL_QUOTE_READ_SCOPE,
            jti: "aaaaaaaa-1111-4111-8111-111111111111",
            iat: now,
            nbf: now,
            exp: now + 300,
          }
        : {
            iss: ISSUER,
            aud: "global-backend",
            sub: "22222222-2222-4222-8222-222222222222",
            workspace_id: "33333333-3333-4333-8333-333333333333",
            roles: ["ADMIN"],
            jti: "bbbbbbbb-1111-4111-8111-111111111111",
            iat: now,
            nbf: now,
            exp: now + 300,
          };
    return new SignJWT(claims)
      .setProtectedHeader({
        alg: "RS256",
        kid: "identity-current",
        typ:
          profile === "service"
            ? "platform-technical-quote-access+jwt"
            : "global-backend-access+jwt",
      })
      .sign(privateKey);
  }

  async function post(tokenValue: string): Promise<Response> {
    const address = app.getHttpServer().address() as AddressInfo;
    return fetch(
      `http://127.0.0.1:${address.port}/api/v1/platform-authority/technical-quote`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenValue}`,
          "content-type": "application/json",
        },
        body: VALID_BODY,
      },
    );
  }

  it("verifies a real service token and executes only the pure quote reader", async () => {
    const response = await post(await token("service"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { schema_version: "platform-execution-technical-quote/v1" },
    });
    await expect(
      app
        .get(RuntimeReadinessContributorRegistry)
        .check(PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_READINESS_CONTRIBUTOR),
    ).resolves.toEqual({ status: "ok" });
  });

  it("rejects an ordinary identity token signed by the same keyring", async () => {
    const response = await post(await token("user"));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_DENIED",
        message: "platform technical quote service authentication failed",
      },
    });
  });
});
