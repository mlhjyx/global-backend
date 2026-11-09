import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Module, UnauthorizedException, VersioningType } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from "@nestjs/swagger";
import { AuthGuard } from "../auth/auth.guard";
import { ScopesGuard } from "../auth/scopes.guard";
import { TokenVerifier } from "../auth/token-verifier";
import { ROLES_TO_SCOPES_POLICY } from "../auth/scopes";
import type { AuthorizationScope } from "../auth/scopes";
import type { PrismaService } from "../prisma/prisma.service";
import { ChannelProbeService } from "./channel-probe.service";
import { ChannelsController } from "./channels.controller";
import { ChannelService } from "./channel.service";

const WS = "11111111-1111-4111-8111-111111111111";
const CHANNEL = "aaaaaaaa-0000-4000-8000-000000000001";

/** 每个到达服务层的调用都会 +1；403/401 路径必须保持为 0。 */
let serviceCalls = 0;

function channelRow() {
  return {
    id: CHANNEL,
    name: "import-pump",
    mode: "import",
    category: "directory",
    status: "DISABLED",
    config: {},
    license: null,
    tosUrl: null,
    robotsPolicy: null,
    owner: null,
    failureStreak: 0,
    lastRunAt: null,
    createdAt: new Date("2026-11-04T00:00:00Z").toISOString(),
    updatedAt: new Date("2026-11-04T00:00:00Z").toISOString(),
  };
}

function counted<T>(value: T): () => Promise<T> {
  return async () => {
    serviceCalls += 1;
    return value;
  };
}

const service = {
  listChannels: counted([channelRow()]),
  listAvailable: counted([{ ...channelRow(), enabled: false }]),
  createChannel: counted(channelRow()),
  patchChannel: counted(channelRow()),
  getChannel: counted({ ...channelRow(), manifest: null, auth: null }),
  requestCrawl: counted({ requested: true }),
  listChannelRecords: counted({ channelId: CHANNEL, counts: { PENDING: 0, APPROVED: 0, REJECTED: 0 }, records: [] }),
  reviewChannelRecords: counted({
    channelId: CHANNEL,
    reviewed: 1,
    verdict: "APPROVED",
    counts: { PENDING: 0, APPROVED: 1, REJECTED: 0 },
    autoDisabled: false,
  }),
  enableChannel: counted({ channelId: CHANNEL, enabled: true }),
  disableChannel: counted({ channelId: CHANNEL, enabled: false }),
  previewImport: counted({ totalRows: 0 }),
  importBuyers: counted({ batchId: CHANNEL, materialized: 0 }),
  listImportedBuyers: counted([]),
} as unknown as ChannelService;

const probes = {
  probeChannel: counted({
    probeId: CHANNEL,
    status: "SUCCEEDED",
    recordsFound: 1,
    pagesFetched: 1,
    fieldFillRates: {},
    sample: [],
    errorCode: null,
    durationMs: 1,
    circuit: "closed",
    probeRequired: false,
  }),
} as unknown as ChannelProbeService;

const verifier = {
  verify: async (token: string) => {
    if (!["tenant-admin", "ops"].includes(token)) {
      throw new UnauthorizedException();
    }
    return {
      workspaceId: WS,
      userId: token === "ops" ? "ops-user" : "tenant-user",
      roles: [token],
    };
  },
};

const policy = {
  resolve: (roles: readonly string[]): AuthorizationScope[] =>
    roles.includes("ops")
      ? ["ops:read", "ops:write"]
      : ["acquisition:read", "acquisition:write"],
};

// Vitest transpilation omits emitted constructor types; these are the actual types.
Reflect.defineMetadata("design:paramtypes", [ChannelService, ChannelProbeService], ChannelsController);
Reflect.defineMetadata("design:paramtypes", [TokenVerifier, Object], AuthGuard);
Reflect.defineMetadata("design:paramtypes", [Reflector], ScopesGuard);
@Module({
  controllers: [ChannelsController],
  providers: [
    { provide: ChannelService, useValue: service },
    { provide: ChannelProbeService, useValue: probes },
    { provide: TokenVerifier, useValue: verifier },
    { provide: ROLES_TO_SCOPES_POLICY, useValue: policy },
    { provide: AuthGuard, useValue: new AuthGuard(verifier, policy) },
    { provide: ScopesGuard, useValue: new ScopesGuard(new Reflector()) },
  ],
})
class ChannelsAuthzTestModule {}

describe("channel data-source ownership HTTP contract (P3)", () => {
  let app: NestExpressApplication;
  let origin: string;
  let openapi: OpenAPIObject;
  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(
      ChannelsAuthzTestModule,
      { logger: false, abortOnError: false },
    );
    app.setGlobalPrefix("api");
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
    openapi = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth().build(),
    );
    await app.listen(0, "127.0.0.1");
    origin = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    serviceCalls = 0;
  });

  const call = (
    method: string,
    path: string,
    token?: string,
    body?: unknown,
  ) =>
    fetch(`${origin}/api/v1${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  /** 平台渠道治理：只有运营身份可达，租户管理员必须 403 且不触达服务层。 */
  const platformEndpoints = [
    ["GET", "/source-channels", undefined],
    ["POST", "/source-channels", { name: "x", mode: "import", category: "directory", config: {} }],
    ["PATCH", `/source-channels/${CHANNEL}`, { name: "y" }],
    ["POST", `/source-channels/${CHANNEL}/preview` as string, undefined],
    ["POST", `/source-channels/${CHANNEL}/run`, undefined],
    ["GET", `/source-channels/${CHANNEL}/records` as string, undefined],
    ["GET", `/source-channels/${CHANNEL}`, undefined],
    ["POST", `/source-channels/${CHANNEL}/test`, undefined],
    ["POST", `/source-channels/${CHANNEL}/records/review`, { recordIds: [CHANNEL], verdict: "APPROVED" }],
  ] as const;

  it.each(platformEndpoints)(
    "denies a tenant admin on %s %s before any service call",
    async (method, path, body) => {
      const response = await call(method, path, "tenant-admin", body);
      expect(response.status).toBe(403);
      expect(serviceCalls).toBe(0);
    },
  );

  it.each(platformEndpoints)(
    "allows the ops identity on %s %s",
    async (method, path, body) => {
      const response = await call(method, path, "ops", body);
      expect(response.status).toBeLessThan(300);
      expect(serviceCalls).toBe(1);
    },
  );

  it("denies anonymous access on every platform endpoint", async () => {
    for (const [method, path, body] of platformEndpoints) {
      const response = await call(method, path, undefined, body);
      expect(response.status).toBe(401);
    }
    expect(serviceCalls).toBe(0);
  });

  /** 租户面：启用/停用与私有导入仍归租户管理员，ops 身份反而无权。 */
  const tenantEndpoints = [
    ["POST", `/source-channels/${CHANNEL}/enable`, undefined],
    ["DELETE", `/source-channels/${CHANNEL}/enable`, undefined],
    ["POST", "/imported-buyers/preview", { csv: "name\nAcme" }],
    ["POST", "/imported-buyers", { csv: "name\nAcme" }],
    ["GET", "/source-channels/available", undefined],
  ] as const;

  it.each(tenantEndpoints)(
    "keeps %s %s reachable for the tenant admin",
    async (method, path, body) => {
      const response = await call(method, path, "tenant-admin", body);
      expect(response.status).toBeLessThan(300);
      expect(serviceCalls).toBe(1);
    },
  );

  it.each(tenantEndpoints)(
    "denies the ops identity on tenant endpoint %s %s",
    async (method, path, body) => {
      const response = await call(method, path, "ops", body);
      expect(response.status).toBe(403);
      expect(serviceCalls).toBe(0);
    },
  );

  it("ships the import template with a suggested mapping for the tenant admin (P3 import contract)", async () => {
    const response = await call("GET", "/source-channels/import-template", "tenant-admin");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { columns: string[]; mapping: Record<string, string> };
    };
    expect(body.data.columns).toEqual(["company", "website", "country", "industry"]);
    expect(body.data.mapping).toEqual({
      name: "company",
      website: "website",
      country: "country",
      industry: "industry",
    });
    expect(serviceCalls).toBe(0);
  });

  it("exports the ownership split in the code-first contract", () => {
    const scopes = (path: string, method: "get" | "post" | "patch" | "delete") =>
      openapi.paths[path]?.[method]?.["x-required-scopes"];
    expect(scopes("/api/v1/source-channels", "get")).toEqual(["ops:read"]);
    expect(scopes("/api/v1/source-channels", "post")).toEqual(["ops:write"]);
    expect(scopes("/api/v1/source-channels/{channelId}", "patch")).toEqual([
      "ops:write",
    ]);
    expect(scopes("/api/v1/source-channels/{channelId}/preview", "post")).toEqual([
      "ops:write",
    ]);
    expect(scopes("/api/v1/source-channels/{channelId}/run", "post")).toEqual([
      "ops:write",
    ]);
    expect(scopes("/api/v1/source-channels/{channelId}", "get")).toEqual([
      "ops:read",
    ]);
    expect(scopes("/api/v1/source-channels/{channelId}/test", "post")).toEqual([
      "ops:write",
    ]);
    expect(scopes("/api/v1/source-channels/{channelId}/records/review", "post")).toEqual([
      "ops:write",
    ]);
    expect(scopes("/api/v1/source-channels/{channelId}/enable", "post")).toEqual([
      "acquisition:write",
    ]);
    expect(scopes("/api/v1/source-channels/available", "get")).toEqual([
      "acquisition:read",
    ]);
    expect(scopes("/api/v1/imported-buyers", "post")).toEqual([
      "acquisition:write",
    ]);
  });
});
