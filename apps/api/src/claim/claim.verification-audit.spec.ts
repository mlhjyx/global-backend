import { describe, expect, it, vi } from "vitest";
import { ClaimService } from "./claim.service";

const CTX = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  userId: "reviewer-42",
  roles: [],
};

function makeService(
  status: "NEEDS_REVIEW" | "APPROVED" = "NEEDS_REVIEW",
  transitionCount = 1,
  options: {
    hasExactBridge?: boolean;
    originKey?: string | null;
    factKey?: string | null;
  } = {},
) {
  let claim = {
    id: "22222222-2222-4222-8222-222222222222",
    workspaceId: CTX.workspaceId,
    companyId: "33333333-3333-4333-8333-333333333333",
    sourceId: null,
    originKey: options.originKey === undefined ? "a".repeat(64) : options.originKey,
    factKey: options.factKey === undefined ? "certifications" : options.factKey,
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
  const queryRaw = vi.fn(async (strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    if (sql.includes('FROM "claim"')) return [{ ...claim }];
    if (sql.includes('FROM "brand_profile_claim_bridge"')) {
      if (sql.includes("FOR SHARE OF bridge")) {
        throw new Error(
          "permission denied: append-only app_user cannot row-lock brand_profile_claim_bridge",
        );
      }
      return options.hasExactBridge === false ? [] : [{ id: "bridge-1" }];
    }
    return [];
  });
  const tx = {
    $queryRaw: queryRaw,
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
    queryRaw,
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

  it("rejects an origin-keyed approval when its exact Site bridge no longer exists", async () => {
    const { service, updates, events, queryRaw } = makeService(
      "NEEDS_REVIEW",
      1,
      { hasExactBridge: false },
    );

    await expect(
      service.transition(
        CTX,
        "22222222-2222-4222-8222-222222222222",
        "APPROVED",
        4,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        error: expect.objectContaining({ code: "CLAIM_BRIDGE_REQUIRED" }),
      }),
    });
    expect(queryRaw).toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(events).toEqual([]);
  });

  it("keeps manual and legacy Claims approvable without a Site bridge", async () => {
    const { service, updates, events } = makeService("NEEDS_REVIEW", 1, {
      hasExactBridge: false,
      originKey: null,
      factKey: null,
    });

    await service.transition(
      CTX,
      "22222222-2222-4222-8222-222222222222",
      "APPROVED",
      4,
    );

    expect(updates).toHaveLength(1);
    expect(events).toHaveLength(1);
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
