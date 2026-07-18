import { describe, expect, it } from "vitest";
import { ClaimService } from "./claim.service";

const CTX = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  userId: "reviewer-42",
  roles: [],
};

function makeService(
  status: "NEEDS_REVIEW" | "APPROVED" = "NEEDS_REVIEW",
  transitionCount = 1,
) {
  let claim = {
    id: "22222222-2222-4222-8222-222222222222",
    workspaceId: CTX.workspaceId,
    companyId: "33333333-3333-4333-8333-333333333333",
    sourceId: null,
    originKey: "a".repeat(64),
    factKey: "certifications",
    type: "certification",
    statement: "ISO 9001 certified",
    status,
    validUntil: null,
    version: 4,
    verifiedBy: null,
    verifiedAt: null,
    verificationMethod: null,
    verificationProof: null,
  };
  const updates: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const tx = {
    claim: {
      findUnique: async () => ({ ...claim }),
      findUniqueOrThrow: async () => ({ ...claim }),
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        if (transitionCount === 1) {
          claim = {
            ...claim,
            ...data,
            status: data.status as typeof claim.status,
            version: claim.version + 1,
          };
        }
        return { count: transitionCount };
      },
      count: async () => 0,
    },
    companyProfile: { updateMany: async () => ({ count: 0 }) },
    outboxEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return { id: "event-1" };
      },
    },
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
    events,
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
          proofVersion: 3,
          approvedVersion: 5,
          claimDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      },
    ]);
  });

  it("fails a stale concurrent approver before emitting a duplicate event", async () => {
    const { service, events } = makeService("NEEDS_REVIEW", 0);

    await expect(
      service.transition(
        CTX,
        "22222222-2222-4222-8222-222222222222",
        "APPROVED",
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        error: expect.objectContaining({ code: "VERSION_CONFLICT" }),
      }),
    });
    expect(events).toHaveLength(0);
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
