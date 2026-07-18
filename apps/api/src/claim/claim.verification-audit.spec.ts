import { describe, expect, it } from "vitest";
import { ClaimService } from "./claim.service";

const CTX = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  userId: "reviewer-42",
  roles: [],
};

function makeService(status: "NEEDS_REVIEW" | "APPROVED" = "NEEDS_REVIEW") {
  const claim = {
    id: "22222222-2222-4222-8222-222222222222",
    companyId: "33333333-3333-4333-8333-333333333333",
    type: "certification",
    status,
    version: 4,
    verifiedBy: null,
    verifiedAt: null,
    verificationMethod: null,
    verificationProof: null,
  };
  const updates: Record<string, unknown>[] = [];
  const tx = {
    claim: {
      findUnique: async () => ({ ...claim }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return { ...claim, ...data };
      },
      count: async () => 0,
    },
    companyProfile: { updateMany: async () => ({ count: 0 }) },
    outboxEvent: { create: async () => ({ id: "event-1" }) },
  };
  const prisma = {
    withWorkspace: async (
      workspaceId: string,
      fn: (workspaceTx: typeof tx) => Promise<unknown>,
    ) => {
      expect(workspaceId).toBe(CTX.workspaceId);
      return fn(tx);
    },
  };

  return {
    service: new ClaimService(prisma as never),
    updates,
  };
}

describe("ClaimService — durable human verification audit", () => {
  it("records actor, server timestamp, method and proof when approving", async () => {
    const { service, updates } = makeService();

    await service.transition(
      CTX,
      "22222222-2222-4222-8222-222222222222",
      "APPROVED",
      4,
    );

    expect(updates).toEqual([
      {
        status: "APPROVED",
        version: { increment: 1 },
        verifiedBy: CTX.userId,
        verifiedAt: expect.any(Date),
        verificationMethod: "human_review",
        verificationProof: {
          action: "claim_approval",
          approvedVersion: 5,
        },
      },
    ]);
  });

  it("does not stamp human verification when rejecting a pending claim", async () => {
    const { service, updates } = makeService();

    await service.transition(
      CTX,
      "22222222-2222-4222-8222-222222222222",
      "REVOKED",
      4,
    );

    expect(updates).toEqual([
      {
        status: "REVOKED",
        version: { increment: 1 },
      },
    ]);
  });

  it("retains the original approval audit when an approved claim is revoked", async () => {
    const { service, updates } = makeService("APPROVED");

    await service.revoke(CTX, "22222222-2222-4222-8222-222222222222", 4);

    expect(updates).toEqual([
      {
        status: "REVOKED",
        version: { increment: 1 },
      },
    ]);
  });
});
