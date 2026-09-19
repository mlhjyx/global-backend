import { describe, it, expect, vi } from "vitest";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  QualificationFeedbackService,
  QUALIFICATION_FEEDBACK_PRINCIPAL,
} from "./qualification-feedback.service";
import {
  qualificationFeedbackDigest,
  type QualificationFeedbackEvent,
} from "./qualification-feedback.contract";
import type { RequestContext } from "../auth/request-context";
import type { PrismaService } from "../prisma/prisma.service";

const workspaceId = "11111111-1111-4111-8111-111111111111",
  leadId = "22222222-2222-4222-8222-222222222222",
  companyId = "77777777-7777-4777-8777-777777777777";
const event: QualificationFeedbackEvent = {
  schemaVersion: "qualification-feedback-reference/v1",
  eventType: "QUALIFICATION_DECISION_RECORDED",
  producer: "growthos-saas",
  workspaceId,
  leadId,
  eventId: "33333333-3333-4333-8333-333333333333",
  opportunityId: "44444444-4444-4444-8444-444444444444",
  decisionId: "55555555-5555-4555-8555-555555555555",
  revision: "9007199254740993",
  decision: "REJECTED",
  occurredAt: "2026-09-19T00:00:00.123456789Z",
};
const context: RequestContext = {
  userId: QUALIFICATION_FEEDBACK_PRINCIPAL,
  workspaceId,
  roles: ["feedback-sender"],
  scopes: ["acquisition:label:write"],
};
const row = {
  id: "66666666-6666-4666-8666-666666666666",
  ...event,
  revision: 9007199254740993n,
  eventDigest: qualificationFeedbackDigest(event),
  receivedAt: new Date("2026-09-19T00:00:01Z"),
};
function fixture() {
  const lead = {
    id: leadId,
    workspaceId,
    canonicalCompanyId: companyId,
    status: "QUALIFIED",
    queue: "recommended",
  };
  const company = { id: companyId, workspaceId, status: "ENRICHED" };
  const tx = {
    $queryRaw: vi.fn(async (query: { sql: string }) =>
      query.sql.includes("FROM canonical_company") ? [company] : [lead],
    ),
    lead: { update: vi.fn() },
    qualificationFeedbackReceipt: {
      findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(row),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = {
    withWorkspace: vi.fn(
      async (_ws: string, fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    ),
  };
  return {
    tx,
    lead,
    company,
    prisma,
    service: new QualificationFeedbackService(
      prisma as unknown as PrismaService,
    ),
  };
}
describe("Qualification feedback receiver", () => {
  it("records reference metadata in one scoped transaction without changing Lead", async () => {
    const { service, tx, prisma } = fixture();
    expect(await service.receive(context, event)).toEqual({
      status: "RECORDED",
      receiptId: row.id,
      eventId: event.eventId,
      workspaceId,
      eventDigest: row.eventDigest,
      receivedAt: "2026-09-19T00:00:01.000Z",
    });
    expect(prisma.withWorkspace).toHaveBeenCalledWith(
      workspaceId,
      expect.any(Function),
    );
    expect(tx.qualificationFeedbackReceipt.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          revision: 9007199254740993n,
          decision: "REJECTED",
          occurredAt: "2026-09-19T00:00:00.123456789Z",
        }),
      ],
      skipDuplicates: true,
    });
    expect(tx.lead.update).not.toHaveBeenCalled();
  });
  it("returns the original receipt on exact replay without another insert", async () => {
    const { service, tx } = fixture();
    tx.qualificationFeedbackReceipt.findUnique
      .mockReset()
      .mockResolvedValue(row);
    expect(await service.receive(context, event)).toMatchObject({
      receiptId: row.id,
      receivedAt: "2026-09-19T00:00:01.000Z",
    });
    expect(tx.qualificationFeedbackReceipt.createMany).not.toHaveBeenCalled();
  });
  it("rejects a frozen company while its lead still awaits asynchronous suppression", async () => {
    const { service, tx, company, lead } = fixture();
    company.status = "SUPPRESSED";
    expect(lead.status).toBe("QUALIFIED");
    await expect(service.receive(context, event)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(tx.qualificationFeedbackReceipt.createMany).not.toHaveBeenCalled();
  });
  it("locks the company before the lead and holds both until receipt insertion", async () => {
    const { service, tx } = fixture();
    await service.receive(context, event);
    const queries = tx.$queryRaw.mock.calls.map(([query]) => query.sql);
    expect(queries).toHaveLength(3);
    expect(queries[0]).toMatch(/FROM lead/);
    expect(queries[0]).not.toMatch(/FOR (?:SHARE|UPDATE)/);
    expect(queries[1]).toMatch(/FROM canonical_company[\s\S]*FOR SHARE/);
    expect(queries[2]).toMatch(/FROM lead[\s\S]*FOR SHARE/);
    expect(tx.$queryRaw.mock.invocationCallOrder[2]).toBeLessThan(
      tx.qualificationFeedbackReceipt.createMany.mock.invocationCallOrder[0],
    );
    expect(tx.lead.update).not.toHaveBeenCalled();
  });
  it.each([null, { id: companyId, workspaceId: leadId, status: "ENRICHED" }])(
    "rejects missing or foreign companies",
    async (company) => {
      const { service, tx, lead } = fixture();
      tx.$queryRaw
        .mockResolvedValueOnce([lead])
        .mockResolvedValueOnce(company ? [company] : []);
      await expect(service.receive(context, event)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(tx.qualificationFeedbackReceipt.createMany).not.toHaveBeenCalled();
    },
  );
  it("rejects a lead whose company reference changed before acquiring the lead lock", async () => {
    const { service, tx, lead, company } = fixture();
    tx.$queryRaw
      .mockResolvedValueOnce([lead])
      .mockResolvedValueOnce([company])
      .mockResolvedValueOnce([
        { ...lead, canonicalCompanyId: event.decisionId },
      ]);
    await expect(service.receive(context, event)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(tx.qualificationFeedbackReceipt.createMany).not.toHaveBeenCalled();
  });
  it("rejects a receipt UUID with a trailing newline before accessing storage", async () => {
    const { service, prisma } = fixture();
    await expect(
      service.receipt(context, event.eventId + "\n"),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.withWorkspace).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { status: "SUPPRESSED" },
    { queue: "suppressed" },
    { workspaceId: leadId },
    { id: companyId },
  ])(
    "rechecks Lead availability after taking the company lock",
    async (change) => {
      const { service, tx, lead, company } = fixture();
      tx.$queryRaw
        .mockResolvedValueOnce([lead])
        .mockResolvedValueOnce([company])
        .mockResolvedValueOnce(change ? [{ ...lead, ...change }] : []);
      await expect(service.receive(context, event)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(tx.qualificationFeedbackReceipt.createMany).not.toHaveBeenCalled();
    },
  );
  it.each([
    { ...context, userId: "human-user" },
    { ...context, scopes: [] },
    { ...context, scopes: ["acquisition:review"] },
  ])(
    "refuses humans or unrelated scopes before accessing data",
    async (ctx) => {
      const { service, prisma } = fixture();
      await expect(
        service.receive(ctx as RequestContext, event),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.withWorkspace).not.toHaveBeenCalled();
    },
  );
  it("rejects cross-workspace and free text without a transaction", async () => {
    const { service, prisma } = fixture();
    await expect(
      service.receive(context, { ...event, workspaceId: leadId }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.receive(context, { ...event, reason: "not part of contract" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.withWorkspace).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { id: leadId, workspaceId, status: "SUPPRESSED", queue: "suppressed" },
    {
      id: leadId,
      workspaceId: leadId,
      status: "QUALIFIED",
      queue: "recommended",
    },
  ])(
    "does not record missing, suppressed or foreign lead references",
    async (lead) => {
      const { service, tx } = fixture();
      tx.$queryRaw.mockResolvedValue(lead ? [lead] : []);
      await expect(service.receive(context, event)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(tx.qualificationFeedbackReceipt.createMany).not.toHaveBeenCalled();
    },
  );
  it("rejects changed data for an existing event", async () => {
    const { service, tx } = fixture();
    tx.qualificationFeedbackReceipt.findUnique
      .mockReset()
      .mockResolvedValue(row);
    await expect(
      service.receive(context, { ...event, decision: "CORRECTED" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it("reads the winner of a duplicate race and rejects other identity collisions", async () => {
    const { service, tx } = fixture();
    tx.qualificationFeedbackReceipt.createMany.mockResolvedValue({ count: 0 });
    expect(await service.receive(context, event)).toMatchObject({
      receiptId: row.id,
    });
    tx.qualificationFeedbackReceipt.findUnique
      .mockReset()
      .mockResolvedValue(null);
    await expect(service.receive(context, event)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
  it("does not return success before transaction commit", async () => {
    const { service, prisma, tx } = fixture();
    prisma.withWorkspace.mockImplementation(async (_ws, fn) => {
      await fn(tx);
      throw new Error("private commit unknown");
    });
    await expect(service.receive(context, event)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(tx.qualificationFeedbackReceipt.createMany).toHaveBeenCalledTimes(1);
    await expect(service.receipt(context, event.eventId)).rejects.toMatchObject(
      {
        response: {
          error: {
            code: "FEEDBACK_STORAGE_UNAVAILABLE",
            message: "feedback storage unavailable",
          },
        },
      },
    );
  });
  it("status lookup is read-only and distinguishes absent events without leaking other workspaces", async () => {
    const { service, tx } = fixture();
    expect(await service.receipt(context, event.eventId)).toEqual({
      status: "NOT_RECEIVED",
      eventId: event.eventId,
      workspaceId,
    });
    expect(await service.receipt(context, event.eventId)).toMatchObject({
      status: "RECORDED",
      receiptId: row.id,
    });
    expect(tx.qualificationFeedbackReceipt.createMany).not.toHaveBeenCalled();
    await expect(service.receipt(context, "bad-id")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
