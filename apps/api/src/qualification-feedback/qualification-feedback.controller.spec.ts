import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Module, VersioningType, type INestApplication } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { QualificationFeedbackController } from "./qualification-feedback.controller";
import {
  QualificationFeedbackService,
  QUALIFICATION_FEEDBACK_PRINCIPAL,
} from "./qualification-feedback.service";
import { AuthGuard } from "../auth/auth.guard";
import { ScopesGuard } from "../auth/scopes.guard";
import { GlobalHttpExceptionFilter } from "../common/http-exception.filter";
import {
  ROLES_TO_SCOPES_POLICY,
  createRolesToScopesPolicy,
} from "../auth/scopes";
import { TokenVerifier } from "../auth/token-verifier";
import { PrismaService } from "../prisma/prisma.service";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";

const ws = "11111111-1111-4111-8111-111111111111";
const event = {
  schemaVersion: "qualification-feedback-reference/v1",
  eventType: "QUALIFICATION_DECISION_RECORDED",
  producer: "growthos-saas",
  eventId: "22222222-2222-4222-8222-222222222222",
  workspaceId: ws,
  opportunityId: "33333333-3333-4333-8333-333333333333",
  leadId: "44444444-4444-4444-8444-444444444444",
  decisionId: "55555555-5555-4555-8555-555555555555",
  revision: "1",
  decision: "REJECTED",
  occurredAt: "2026-09-19T00:00:00Z",
};
const tx = {
  qualificationFeedbackReceipt: { findUnique: vi.fn().mockResolvedValue(null) },
};
const prisma = {
  withWorkspace: vi.fn(async (_ws: string, fn: (t: unknown) => unknown) =>
    fn(tx),
  ),
};
const policy = createRolesToScopesPolicy(
  {
    AUTH_ROLE_SCOPE_MAP_JSON: JSON.stringify({
      sender: ["acquisition:label:write"],
      human: ["acquisition:label:write"],
      reader: ["acquisition:read"],
    }),
  },
  "test",
);
const verifier = {
  verify: vi.fn(async (token: string) => ({
    userId: token === "sender" ? QUALIFICATION_FEEDBACK_PRINCIPAL : "human-id",
    workspaceId: ws,
    roles: [token],
  })),
};
@Module({
  controllers: [QualificationFeedbackController],
  providers: [
    { provide: TokenVerifier, useValue: verifier },
    { provide: ROLES_TO_SCOPES_POLICY, useValue: policy },
    { provide: AuthGuard, useFactory: () => new AuthGuard(verifier, policy) },
    {
      provide: ScopesGuard,
      useFactory: () => new ScopesGuard(new Reflector()),
    },
    {
      provide: QualificationFeedbackService,
      useFactory: () =>
        new QualificationFeedbackService(prisma as unknown as PrismaService),
    },
  ],
})
class TestModule {}
describe("qualification feedback HTTP", () => {
  let app: INestApplication, base: string;
  beforeAll(async () => {
    app = await NestFactory.create(TestModule, {
      logger: false,
      abortOnError: false,
    });
    app.setGlobalPrefix("api");
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
    app.useGlobalFilters(new GlobalHttpExceptionFilter());
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
  });
  const request = (path: string, token?: string, body?: unknown) =>
    fetch(base + "/api/v1/qualification-feedback" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(token ? { Authorization: "Bearer " + token } : {}),
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  it("requires bearer identity and refuses ordinary humans even with label scope", async () => {
    expect((await request("/" + event.eventId + "/receipt")).status).toBe(401);
    expect(
      (await request("/" + event.eventId + "/receipt", "human")).status,
    ).toBe(403);
    expect(
      (await request("/" + event.eventId + "/receipt", "reader")).status,
    ).toBe(403);
  });
  it("returns a bounded no-store readback envelope without writing", async () => {
    const r = await request("/" + event.eventId + "/receipt", "sender");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({
      data: { status: "NOT_RECEIVED", eventId: event.eventId, workspaceId: ws },
    });
  });
  it("rejects extra payload and workspace mismatch before persistence", async () => {
    const count = prisma.withWorkspace.mock.calls.length;
    const invalid = await request("", "sender", {
      ...event,
      reason: "private text",
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain("private text");
    expect(
      (await request("", "sender", { ...event, workspaceId: event.leadId }))
        .status,
    ).toBe(403);
    expect(prisma.withWorkspace.mock.calls.length).toBe(count);
  });
  it("rejects an encoded trailing newline in the receipt identifier before persistence", async () => {
    const count = prisma.withWorkspace.mock.calls.length;
    const response = await request(
      "/" + event.eventId + "%0A/receipt",
      "sender",
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "FEEDBACK_INVALID" },
    });
    expect(prisma.withWorkspace.mock.calls.length).toBe(count);
  });
  it("publishes both operations from the controller with a closed input schema", () => {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth().build(),
    );
    const post = doc.paths["/api/v1/qualification-feedback"]?.post;
    expect(post?.operationId).toBe(
      "QualificationFeedbackController_receive_v1",
    );
    expect(post?.requestBody).toMatchObject({
      content: {
        "application/json": { schema: { additionalProperties: false } },
      },
    });
    expect(
      doc.paths["/api/v1/qualification-feedback/{eventId}/receipt"]?.get
        ?.operationId,
    ).toBe("QualificationFeedbackController_receipt_v1");
  });
});
