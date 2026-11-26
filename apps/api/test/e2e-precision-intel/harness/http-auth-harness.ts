import "reflect-metadata";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type INestApplication,
  type Type,
  ValidationPipe,
  VersioningType,
} from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { AuthGuard } from "../../../src/auth/auth.guard";
import { AUTHORIZATION_SCOPES } from "../../../src/auth/scopes";
import { ScopesGuard } from "../../../src/auth/scopes.guard";
import { TokenVerifier } from "../../../src/auth/token-verifier";
import { GlobalHttpExceptionFilter } from "../../../src/common/http-exception.filter";

export interface JwksAuthServerOptions {
  readonly roleScopeMap?: Readonly<Record<string, readonly string[]>>;
  readonly issuer?: string;
  readonly audience?: string;
  readonly kid?: string;
}

export interface JwtClaimsInput {
  readonly workspaceId: string;
  readonly userId?: string;
  readonly roles?: readonly string[];
  readonly expiresIn?: string;
}

export interface JwksAuthServer {
  readonly jwksUri: string;
  readonly issuer: string;
  readonly audience: string;
  readonly kid: string;
  signJwt(claims: JwtClaimsInput): Promise<string>;
  close(): Promise<void>;
}

export interface HttpHarnessResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  json<T = unknown>(): T;
}

export interface NestHttpHarness {
  readonly app: INestApplication;
  readonly baseUrl: string;
  request(
    path: string,
    init?: RequestInit & {
      token?: string;
      grant?: string;
      json?: unknown;
    },
  ): Promise<HttpHarnessResponse>;
  close(): Promise<void>;
}

const DEFAULT_ROLE_SCOPE_MAP: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ADMIN: [...AUTHORIZATION_SCOPES],
  MEMBER: ["acquisition:read", "acquisition:write", "acquisition:review"],
  OPS: ["ops:read", "ops:write"],
  READONLY: ["acquisition:read"],
});

export function registerDesignParamTypes(
  target: object,
  paramTypes: readonly unknown[],
): void {
  Reflect.defineMetadata("design:paramtypes", [...paramTypes], target);
}

export async function startJwksAuthServer(
  options: JwksAuthServerOptions = {},
): Promise<JwksAuthServer> {
  const kid = options.kid ?? "e2e-kid-1";
  const issuer = options.issuer ?? "https://auth.e2e-precision-intel.example";
  const audience = options.audience ?? "global-api";
  const roleScopeMap = options.roleScopeMap ?? DEFAULT_ROLE_SCOPE_MAP;

  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };

  const server = createServer((req, res) => {
    if (req.url === "/.well-known/jwks.json") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const jwksUri = `http://127.0.0.1:${port}/.well-known/jwks.json`;

  const prevEnv = {
    AUTH_JWKS_URI: process.env.AUTH_JWKS_URI,
    AUTH_ISSUER: process.env.AUTH_ISSUER,
    AUTH_AUDIENCE: process.env.AUTH_AUDIENCE,
    AUTH_ROLE_SCOPE_MAP_JSON: process.env.AUTH_ROLE_SCOPE_MAP_JSON,
  };

  process.env.AUTH_JWKS_URI = jwksUri;
  process.env.AUTH_ISSUER = issuer;
  process.env.AUTH_AUDIENCE = audience;
  process.env.AUTH_ROLE_SCOPE_MAP_JSON = JSON.stringify(roleScopeMap);

  return {
    jwksUri,
    issuer,
    audience,
    kid,
    async signJwt(claims: JwtClaimsInput): Promise<string> {
      return new SignJWT({
        workspace_id: claims.workspaceId,
        roles: [...(claims.roles ?? ["ADMIN"])],
      })
        .setProtectedHeader({ alg: "RS256", kid })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject(claims.userId ?? "e2e-user-1")
        .setIssuedAt()
        .setExpirationTime(claims.expiresIn ?? "5m")
        .sign(privateKey);
    },
    async close(): Promise<void> {
      for (const [key, val] of Object.entries(prevEnv)) {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

export async function startNestHttpHarness<TModule>(
  ModuleClass: Type<TModule>,
  options: {
    readonly globalPrefix?: string;
    readonly version?: string;
  } = {},
): Promise<NestHttpHarness> {
  // Vitest esbuild transpilation omits emitDecoratorMetadata; ensure NestJS core guards resolve DI tokens.
  registerDesignParamTypes(AuthGuard, [TokenVerifier, Object]);
  registerDesignParamTypes(ScopesGuard, [Reflector]);

  const app = await NestFactory.create<NestExpressApplication>(ModuleClass, {
    logger: false,
  });
  app.set("query parser", "extended");
  app.setGlobalPrefix(options.globalPrefix ?? "api");
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: options.version ?? "1",
  });
  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true }),
  );
  app.useGlobalFilters(new GlobalHttpExceptionFilter());

  await app.listen(0, "127.0.0.1");
  const baseUrl = await app.getUrl();

  return {
    app,
    baseUrl,
    async request(
      path: string,
      init: RequestInit & { token?: string; grant?: string; json?: unknown } = {},
    ): Promise<HttpHarnessResponse> {
      const headers = new Headers(init.headers);
      if (init.token) {
        headers.set("Authorization", `Bearer ${init.token}`);
      }
      if (init.grant) {
        headers.set("X-Execution-Budget-Grant", init.grant);
      }
      let body = init.body;
      if (init.json !== undefined) {
        if (!headers.has("Content-Type")) {
          headers.set("Content-Type", "application/json");
        }
        body = JSON.stringify(init.json);
      }
      const targetUrl = path.startsWith("http")
        ? path
        : `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
      const res = await fetch(targetUrl, {
        ...init,
        headers,
        body,
      });
      const text = await res.text();
      return {
        status: res.status,
        headers: res.headers,
        text,
        json<T = unknown>(): T {
          return JSON.parse(text) as T;
        },
      };
    },
    async close(): Promise<void> {
      await app.close();
    },
  };
}

export interface InMemoryPrismaStub {
  readonly workspaceCalls: string[];
  readonly txStub: Record<string, unknown>;
  readonly [delegate: string]: unknown;
  withWorkspace<T>(workspaceId: string, fn: (tx: any) => Promise<T>): Promise<T>;
  $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T>;
}

export function createInMemoryPrismaStub(
  delegates: Record<string, unknown> = {},
): InMemoryPrismaStub {
  const workspaceCalls: string[] = [];
  const txStub: Record<string, unknown> = {
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
    ...delegates,
  };
  return {
    ...delegates,
    workspaceCalls,
    txStub,
    async withWorkspace<T>(
      workspaceId: string,
      fn: (tx: any) => Promise<T>,
    ): Promise<T> {
      workspaceCalls.push(workspaceId);
      return fn(txStub);
    },
    async $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      return fn(txStub);
    },
  };
}
