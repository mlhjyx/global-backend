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
import { EventsController } from "./events.controller";
import { EventsService } from "./events.service";

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ID = "aaaaaaaa-0000-4000-8000-000000000001";
const WEBHOOK = "aaaaaaaa-0000-4000-8000-000000000002";
const INTERNAL = "aaaaaaaa-0000-4000-8000-000000000003";
let queries = 0;

const rows = [
  { eventId: ID, workspaceId: WS, sink: "saas", eventType: "LeadQualified" },
  {
    eventId: WEBHOOK,
    workspaceId: WS,
    sink: "webhook",
    eventType: "LeadQualified",
  },
  {
    eventId: INTERNAL,
    workspaceId: WS,
    sink: "saas",
    eventType: "QualifyRequested",
  },
];
const service = new EventsService({
  withWorkspace: async (
    workspaceId: string,
    callback: (tx: unknown) => Promise<unknown>,
  ) =>
    callback({
      outboxDelivery: {
        findFirst: async ({
          where,
        }: {
          where: {
            eventId: string;
            workspaceId: string;
            sink: string;
            event: { workspaceId: string; eventType: { in: string[] } };
          };
        }) => {
          queries++;
          const row = rows.find(
            (item) =>
              item.eventId === where.eventId &&
              item.workspaceId === workspaceId &&
              item.workspaceId === where.workspaceId &&
              item.workspaceId === where.event.workspaceId &&
              item.sink === where.sink &&
              where.event.eventType.in.includes(item.eventType),
          );
          return row
            ? {
                eventId: row.eventId,
                status: "ACKED",
                ackedAt: new Date("2026-09-05T11:00:00Z"),
                payload: { privateValue: "excluded" },
              }
            : null;
        },
      },
    }),
} as unknown as PrismaService);

const verifier = {
  verify: async (token: string) => {
    if (!["consumer", "reader", "other", "forged"].includes(token))
      throw new UnauthorizedException();
    return {
      workspaceId: token === "other" ? OTHER : WS,
      userId: "test-consumer",
      roles:
        token === "reader" || token === "forged" ? ["reader"] : ["consumer"],
      scopes: ["acquisition:event:ack"] as AuthorizationScope[],
    };
  },
};
const policy = {
  resolve: (roles: readonly string[]): AuthorizationScope[] =>
    roles.includes("consumer")
      ? ["acquisition:event:ack"]
      : ["acquisition:read"],
};

// Vitest transpilation omits emitted constructor types; these are the actual types.
Reflect.defineMetadata("design:paramtypes", [EventsService], EventsController);
Reflect.defineMetadata("design:paramtypes", [TokenVerifier, Object], AuthGuard);
Reflect.defineMetadata("design:paramtypes", [Reflector], ScopesGuard);
@Module({
  controllers: [EventsController],
  providers: [
    { provide: EventsService, useValue: service },
    { provide: TokenVerifier, useValue: verifier },
    { provide: ROLES_TO_SCOPES_POLICY, useValue: policy },
    { provide: AuthGuard, useValue: new AuthGuard(verifier, policy) },
    { provide: ScopesGuard, useValue: new ScopesGuard(new Reflector()) },
  ],
})
class AckStatusTestModule {}

describe("event ACK readback HTTP contract", () => {
  let app: NestExpressApplication;
  let origin: string;
  let openapi: OpenAPIObject;
  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(
      AckStatusTestModule,
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
    queries = 0;
  });
  const request = (eventId: string, token?: string) =>
    fetch(`${origin}/api/v1/events/${eventId}/ack-status`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

  it("returns only the bound ACK fact and prevents caching", async () => {
    const response = await request(ID, "consumer");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      data: {
        event_id: ID,
        status: "ACKED",
        acked_at: "2026-09-05T11:00:00.000Z",
      },
    });
  });
  it.each([
    [undefined, 401],
    ["invalid", 401],
    ["reader", 403],
    ["forged", 403],
  ] as const)(
    "denies %s with %s before database access",
    async (token, status) => {
      expect((await request(ID, token)).status).toBe(status);
      expect(queries).toBe(0);
    },
  );
  it("rejects malformed event IDs before a query", async () => {
    expect((await request("not-a-uuid", "consumer")).status).toBe(400);
    expect(queries).toBe(0);
  });
  it.each([
    [ID, "other"],
    [WEBHOOK, "consumer"],
    [INTERNAL, "consumer"],
  ])("does not expose %s to %s", async (eventId, token) => {
    expect((await request(eventId, token)).status).toBe(404);
  });
  it("exports the closed, versioned code-first contract", () => {
    const operation = openapi.paths["/api/v1/events/{eventId}/ack-status"]?.get;
    expect(operation?.operationId).toBe("EventsController_ackStatus_v1");
    expect(operation?.["x-required-scopes"]).toEqual(["acquisition:event:ack"]);
    const response = operation!.responses["200"] as unknown as {
      content: Record<
        string,
        {
          schema: {
            properties: {
              data: { additionalProperties: boolean; required: string[] };
            };
          };
        }
      >;
    };
    const data = response.content["application/json"].schema.properties.data;
    expect(data.additionalProperties).toBe(false);
    expect(data.required).toEqual(["event_id", "status", "acked_at"]);
  });
});
