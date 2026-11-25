import "reflect-metadata";
import { createServer, type AddressInfo } from "node:http";
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
import { MODULE_METADATA } from "@nestjs/common/constants";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { SkipThrottle, ThrottlerModule } from "@nestjs/throttler";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { AuthGuard } from "../auth/auth.guard";
import { AuthModule } from "../auth/auth.module";
import { Ctx } from "../auth/ctx.decorator";
import type { RequestContext } from "../auth/request-context";
import { TokenVerifier } from "../auth/token-verifier";
import { candidateWorkspaceAllowed } from "../runtime/development-candidate";
import { GlobalHttpExceptionFilter } from "./http-exception.filter";
import {
  WS_THROTTLER_WORKSPACE_RESOLVER,
  WsThrottlerGuard,
  type WsThrottlerWorkspaceResolver,
} from "./ws-throttler.guard";

describe("WsThrottlerGuard end-to-end HTTP tenant isolation & fail-open routing", () => {
  it("isolates tenants behind 127.0.0.1, preserves /health/* & service-token routes, and passes invalid JWTs to AuthGuard 401 before IP 429", async () => {
    const wsA = "11111111-1111-4111-8111-111111111111";
    const wsB = "22222222-2222-4222-8222-222222222222";
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "ws-guard-spec-kid", alg: "RS256", use: "sig" };
    const jwksServer = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
    const jwksPort = (jwksServer.address() as AddressInfo).port;
    const issuer = "https://auth.ws-guard-spec.test";
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
        .setProtectedHeader({ alg: "RS256", kid: "ws-guard-spec-kid" })
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
        if (req.headers["x-service-token"] !== "svc-secret") {
          throw new UnauthorizedException({
            error: { code: "SERVICE_TOKEN_INVALID", message: "invalid service token" },
          });
        }
        return true;
      }
    }

    @Injectable()
    class StubServiceBearerGuard implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        const req = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
        if (req.headers["authorization"] !== "Bearer service-specific-jwt") {
          throw new UnauthorizedException({
            error: { code: "SERVICE_BEARER_INVALID", message: "invalid service bearer" },
          });
        }
        return true;
      }
    }

    @Controller()
    class TestRoutesController {
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

      @Get("internal/service-header")
      @UseGuards(StubServiceTokenGuard)
      serviceHeader() {
        return { ok: true };
      }

      @Get("internal/service-bearer")
      @UseGuards(StubServiceBearerGuard)
      serviceBearer() {
        return { ok: true };
      }
    }

    @Module({
      imports: [
        AuthModule,
        ThrottlerModule.forRoot({
          throttlers: [{ ttl: 60_000, limit: 2 }],
        }),
      ],
      controllers: [TestRoutesController],
      providers: [
        StubServiceTokenGuard,
        StubServiceBearerGuard,
        {
          provide: WS_THROTTLER_WORKSPACE_RESOLVER,
          inject: [TokenVerifier],
          useFactory:
            (tokenVerifier: TokenVerifier): WsThrottlerWorkspaceResolver =>
            async (token: string): Promise<string | undefined> => {
              const verified = await tokenVerifier.verify(token);
              return typeof verified.workspaceId === "string" &&
                verified.workspaceId.length > 0 &&
                candidateWorkspaceAllowed(verified.workspaceId)
                ? verified.workspaceId
                : undefined;
            },
        },
        { provide: APP_GUARD, useClass: WsThrottlerGuard },
      ],
    })
    class TestHttpModule {}

    const app = await NestFactory.create(TestHttpModule, { logger: false });
    app.useGlobalFilters(new GlobalHttpExceptionFilter());
    await app.listen(0, "127.0.0.1");
    try {
      const base = await app.getUrl();
      const jwtA = await signTenantJwt(wsA, "u-a");
      const jwtB = await signTenantJwt(wsB, "u-b");

      // 1. Two tenants behind 127.0.0.1 get independent buckets (limit=2).
      expect((await fetch(`${base}/protected`, { headers: { Authorization: `Bearer ${jwtA}` } })).status).toBe(200);
      expect((await fetch(`${base}/protected`, { headers: { Authorization: `Bearer ${jwtA}` } })).status).toBe(200);
      expect((await fetch(`${base}/protected`, { headers: { Authorization: `Bearer ${jwtA}` } })).status).toBe(429);

      const tenantB1 = await fetch(`${base}/protected`, { headers: { Authorization: `Bearer ${jwtB}` } });
      expect(tenantB1.status).toBe(200);
      expect(await tenantB1.json()).toEqual({ workspaceId: wsB });

      // 2. /health/live (@SkipThrottle) bypasses throttling entirely; /health/db works even with bogus Bearer.
      for (let i = 0; i < 4; i++) {
        const live = await fetch(`${base}/health/live`, { headers: { Authorization: "Bearer bogus" } });
        expect(live.status).toBe(200);
      }

      // /health/db and /internal/service-header fall back to IP and succeed (200) even with bogus Bearer.
      const dbRes = await fetch(`${base}/health/db`, { headers: { Authorization: "Bearer bogus" } });
      expect(dbRes.status).toBe(200);

      const svcHeaderRes = await fetch(`${base}/internal/service-header`, {
        headers: { "x-service-token": "svc-secret" },
      });
      expect(svcHeaderRes.status).toBe(200);

      // Invalid JWT on /protected falls back to IP: first 2 hits reach AuthGuard (401 TOKEN_INVALID), 3rd hits 429.
      for (let i = 0; i < 2; i++) {
        const badRes = await fetch(`${base}/protected`, {
          headers: { Authorization: "Bearer invalid-jwt" },
        });
        expect(badRes.status).toBe(401);
        expect(await badRes.json()).toMatchObject({ error: { code: "TOKEN_INVALID" } });
      }
      const ipThrottled = await fetch(`${base}/protected`, {
        headers: { Authorization: "Bearer invalid-jwt" },
      });
      expect(ipThrottled.status).toBe(429);
    } finally {
      await app.close();
      await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("lets invalid Bearer JWT reach AuthGuard for 401 TOKEN_INVALID before IP limit is exceeded, and lets service-Bearer reach its guard", async () => {
    const { publicKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "ws-guard-spec-kid-2", alg: "RS256", use: "sig" };
    const jwksServer = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
    const jwksPort = (jwksServer.address() as AddressInfo).port;

    const prevEnv = {
      AUTH_JWKS_URI: process.env.AUTH_JWKS_URI,
      AUTH_ISSUER: process.env.AUTH_ISSUER,
      AUTH_AUDIENCE: process.env.AUTH_AUDIENCE,
      AUTH_ROLE_SCOPE_MAP_JSON: process.env.AUTH_ROLE_SCOPE_MAP_JSON,
    };
    process.env.AUTH_JWKS_URI = `http://127.0.0.1:${jwksPort}/.well-known/jwks.json`;
    process.env.AUTH_ISSUER = "https://auth.ws-guard-spec-2.test";
    process.env.AUTH_AUDIENCE = "global-api";
    process.env.AUTH_ROLE_SCOPE_MAP_JSON = JSON.stringify({ MEMBER: [] });

    @Injectable()
    class StubServiceBearerGuard implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        const req = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
        return req.headers["authorization"] === "Bearer service-specific-jwt";
      }
    }

    @Controller()
    class TestRoutes2Controller {
      @Get("protected")
      @UseGuards(AuthGuard)
      readProtected(@Ctx() ctx: RequestContext) {
        return { workspaceId: ctx.workspaceId };
      }

      @Get("internal/service-bearer")
      @UseGuards(StubServiceBearerGuard)
      serviceBearer() {
        return { ok: true };
      }
    }

    @Module({
      imports: [
        AuthModule,
        ThrottlerModule.forRoot({
          throttlers: [{ ttl: 60_000, limit: 2 }],
        }),
      ],
      controllers: [TestRoutes2Controller],
      providers: [
        StubServiceBearerGuard,
        {
          provide: WS_THROTTLER_WORKSPACE_RESOLVER,
          inject: [TokenVerifier],
          useFactory:
            (tokenVerifier: TokenVerifier): WsThrottlerWorkspaceResolver =>
            async (token: string): Promise<string | undefined> => {
              const verified = await tokenVerifier.verify(token);
              return typeof verified.workspaceId === "string" &&
                verified.workspaceId.length > 0 &&
                candidateWorkspaceAllowed(verified.workspaceId)
                ? verified.workspaceId
                : undefined;
            },
        },
        { provide: APP_GUARD, useClass: WsThrottlerGuard },
      ],
    })
    class TestHttp2Module {}

    const app = await NestFactory.create(TestHttp2Module, { logger: false });
    app.useGlobalFilters(new GlobalHttpExceptionFilter());
    await app.listen(0, "127.0.0.1");
    try {
      const base = await app.getUrl();

      // Service-Bearer fails JwksTokenVerifier, fails open to IP in WsThrottlerGuard, and passes StubServiceBearerGuard (200).
      const svcBearerRes = await fetch(`${base}/internal/service-bearer`, {
        headers: { Authorization: "Bearer service-specific-jwt" },
      });
      expect(svcBearerRes.status).toBe(200);

      // Invalid user JWT fails open to IP in WsThrottlerGuard, hits AuthGuard and returns 401 TOKEN_INVALID (x2),
      // then 3rd IP request to /protected exceeds limit=2 -> 429.
      for (let i = 0; i < 2; i++) {
        const invalidRes = await fetch(`${base}/protected`, {
          headers: { Authorization: "Bearer not-a-valid-jwt" },
        });
        expect(invalidRes.status).toBe(401);
        expect(await invalidRes.json()).toMatchObject({
          error: { code: "TOKEN_INVALID" },
        });
      }

      const throttledRes = await fetch(`${base}/protected`, {
        headers: { Authorization: "Bearer not-a-valid-jwt" },
      });
      expect(throttledRes.status).toBe(429);
    } finally {
      await app.close();
      await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("wires WS_THROTTLER_WORKSPACE_RESOLVER in AppModule with TokenVerifier + candidateWorkspaceAllowed", async () => {
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      AppModule,
    ) as readonly {
      provide?: unknown;
      inject?: unknown[];
      useFactory?: (tokenVerifier: TokenVerifier) => WsThrottlerWorkspaceResolver;
    }[];

    const resolverProvider = providers.find(
      (provider) => provider.provide === WS_THROTTLER_WORKSPACE_RESOLVER,
    );
    expect(resolverProvider).toBeDefined();
    expect(resolverProvider?.inject).toEqual([TokenVerifier]);
    expect(typeof resolverProvider?.useFactory).toBe("function");

    const wsAllowed = "33333333-3333-4333-8333-333333333333";
    const stubVerifier: TokenVerifier = {
      async verify(token: string): Promise<RequestContext> {
        if (token === "valid-token") {
          return {
            userId: "user-1",
            workspaceId: wsAllowed,
            roles: ["MEMBER"],
            scopes: [],
          };
        }
        if (token === "empty-ws-token") {
          return {
            userId: "user-1",
            workspaceId: "",
            roles: ["MEMBER"],
            scopes: [],
          };
        }
        throw new UnauthorizedException({
          error: { code: "TOKEN_INVALID", message: "invalid bearer token" },
        });
      },
    };

    const resolver = resolverProvider!.useFactory!(stubVerifier);

    // 1. Admitted workspace resolves to workspaceId
    await expect(resolver("valid-token")).resolves.toBe(wsAllowed);

    // 2. Unadmitted candidate workspace returns undefined
    const prevCandidateId = process.env.RUNTIME_CANDIDATE_INSTANCE_ID;
    process.env.RUNTIME_CANDIDATE_INSTANCE_ID = "candidate-unadmitted";
    try {
      await expect(resolver("valid-token")).resolves.toBeUndefined();
    } finally {
      if (prevCandidateId === undefined) {
        delete process.env.RUNTIME_CANDIDATE_INSTANCE_ID;
      } else {
        process.env.RUNTIME_CANDIDATE_INSTANCE_ID = prevCandidateId;
      }
    }

    // 3. Empty workspaceId returns undefined
    await expect(resolver("empty-ws-token")).resolves.toBeUndefined();

    // 4. Invalid token rejects so WsThrottlerGuard fails open to IP
    await expect(resolver("invalid-token")).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
