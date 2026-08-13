import { ConflictException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { ClaimService } from "./claim.service";

const CTX = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  userId: "reviewer-42",
  roles: [],
};

function serviceWithTransaction(tx: Record<string, unknown>) {
  const prisma = {
    withWorkspace: vi.fn(async (workspaceId: string, callback: (value: typeof tx) => unknown) => {
      expect(workspaceId).toBe(CTX.workspaceId);
      return callback(tx);
    }),
  };
  return new ClaimService(prisma as never);
}

describe("ClaimService coverage of manual and review surfaces", () => {
  it.each([
    [undefined, { companyId: "company-1" }],
    ["APPROVED", { companyId: "company-1", status: "APPROVED" }],
  ])("lists company claims with the optional status filter", async (status, expectedWhere) => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = serviceWithTransaction({ claim: { findMany } });

    await service.listForCompany(CTX, "company-1", status);

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expectedWhere }));
  });

  it("rejects manual entry for a missing company before creating source data", async () => {
    const knowledgeSourceCreate = vi.fn();
    const service = serviceWithTransaction({
      companyProfile: { findUnique: vi.fn().mockResolvedValue(null) },
      knowledgeSource: { create: knowledgeSourceCreate },
    });

    await expect(
      service.createManual(CTX, "company-1", { type: "fact", statement: "statement" }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(knowledgeSourceCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["operator supplied evidence", "operator supplied evidence"],
    [undefined, `人工录入（${CTX.userId}）`],
  ])("creates a manual claim with bounded evidence fallback", async (evidence, expectedSnippet) => {
    const evidenceCreate = vi.fn().mockResolvedValue({ id: "evidence-1" });
    const findUniqueOrThrow = vi.fn().mockResolvedValue({ id: "claim-1" });
    const service = serviceWithTransaction({
      companyProfile: { findUnique: vi.fn().mockResolvedValue({ id: "company-1" }) },
      knowledgeSource: { create: vi.fn().mockResolvedValue({ id: "source-1" }) },
      claim: {
        create: vi.fn().mockResolvedValue({ id: "claim-1" }),
        findUniqueOrThrow,
      },
      evidence: { create: evidenceCreate },
    });

    await service.createManual(CTX, "company-1", {
      type: "fact",
      statement: "statement",
      evidence,
    });

    expect(evidenceCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ snippet: expectedSnippet }),
    });
    expect(findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: "claim-1" },
      include: { evidence: true },
    });
  });

  it.each([
    [null, NotFoundException, "NOT_FOUND"],
    [{ id: "claim-1", status: "NEEDS_REVIEW", version: 2 }, ConflictException, "INVALID_STATE"],
    [{ id: "claim-1", status: "APPROVED", version: 2 }, ConflictException, "VERSION_CONFLICT"],
  ])("rejects invalid claim revocation state", async (claim, errorType, code) => {
    const service = serviceWithTransaction({
      claim: { findUnique: vi.fn().mockResolvedValue(claim) },
    });

    await expect(service.revoke(CTX, "claim-1", 3)).rejects.toMatchObject({
      constructor: errorType,
      response: expect.objectContaining({ error: expect.objectContaining({ code }) }),
    });
  });

  it("fails a concurrent revocation without emitting an event", async () => {
    const eventCreate = vi.fn();
    const service = serviceWithTransaction({
      claim: {
        findUnique: vi.fn().mockResolvedValue({ id: "claim-1", status: "APPROVED", version: 2 }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      outboxEvent: { create: eventCreate },
    });

    await expect(service.revoke(CTX, "claim-1", 2)).rejects.toMatchObject({
      response: expect.objectContaining({ error: expect.objectContaining({ code: "VERSION_CONFLICT" }) }),
    });
    expect(eventCreate).not.toHaveBeenCalled();
  });

  it("emits a bounded revocation event after a successful compare-and-set", async () => {
    const eventCreate = vi.fn().mockResolvedValue({ id: "event-1" });
    const updated = { id: "claim-1", status: "REVOKED", version: 3 };
    const service = serviceWithTransaction({
      claim: {
        findUnique: vi.fn().mockResolvedValue({
          id: "claim-1",
          companyId: "company-1",
          factKey: "certification",
          type: "fact",
          status: "APPROVED",
          version: 2,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue(updated),
      },
      outboxEvent: { create: eventCreate },
    });

    await expect(service.revoke(CTX, "claim-1", 2)).resolves.toEqual(updated);
    expect(eventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: CTX.workspaceId,
        eventType: "ClaimRevoked",
        aggregateId: "claim-1",
        payload: { companyId: "company-1", factKey: "certification", type: "fact" },
      }),
    });
  });

  it.each([undefined, "OPEN"])("maps conflict claims and preserves missing references", async (status) => {
    const conflict = {
      id: "conflict-1",
      claimAId: "claim-a",
      claimBId: "claim-b",
      status: "OPEN",
    };
    const conflictFindMany = vi.fn().mockResolvedValue([conflict]);
    const service = serviceWithTransaction({
      knowledgeConflict: { findMany: conflictFindMany },
      claim: {
        findMany: vi.fn().mockResolvedValue([
          { id: "claim-a", factKey: "key", statement: "a", status: "APPROVED", type: "fact" },
        ]),
      },
    });

    await expect(service.listConflicts(CTX, "company-1", status)).resolves.toEqual([
      { ...conflict, claimA: expect.objectContaining({ id: "claim-a" }), claimB: null },
    ]);
    expect(conflictFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: status ? { companyId: "company-1", status } : { companyId: "company-1" },
    }));
  });
});
