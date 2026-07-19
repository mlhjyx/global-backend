import { describe, expect, it, vi } from "vitest";
import { buildPublishableClaimSnapshot } from "./publishable-claim-snapshot";
import { PrismaPublishableClaimSnapshotRepository } from "./publishable-claim-snapshot.prisma";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SITE_ID = "22222222-2222-4222-8222-222222222222";
const COMPANY_ID = "33333333-3333-4333-8333-333333333333";
const BUILD_RUN_ID = "44444444-4444-4444-8444-444444444444";

function tx() {
  return {
    site: { findFirst: vi.fn() },
    brandProfileClaimBridge: { findMany: vi.fn() },
    sitePublishableClaimSnapshot: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    $queryRaw: vi.fn(),
  };
}

describe("PrismaPublishableClaimSnapshotRepository", () => {
  it("queries only exact Site and CompanyProfile bridge candidates", async () => {
    const client = tx();
    client.brandProfileClaimBridge.findMany.mockResolvedValue([]);
    const repository = new PrismaPublishableClaimSnapshotRepository(
      client as never,
    );

    await expect(
      repository.listCandidates(
        WORKSPACE_ID,
        SITE_ID,
        COMPANY_ID,
        new Date("2026-07-19T12:00:00Z"),
      ),
    ).resolves.toEqual([]);
    expect(client.brandProfileClaimBridge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: WORKSPACE_ID,
          siteId: SITE_ID,
          companyProfileId: COMPANY_ID,
          claim: expect.objectContaining({ status: "APPROVED" }),
        }),
      }),
    );
  });

  it("persists even an empty snapshot as an immutable run record", async () => {
    const client = tx();
    const snapshot = buildPublishableClaimSnapshot({
      workspaceId: WORKSPACE_ID,
      siteId: SITE_ID,
      companyProfileId: COMPANY_ID,
      buildRunId: BUILD_RUN_ID,
      capturedAt: new Date("2026-07-19T12:00:00Z"),
      candidates: [],
    });
    client.sitePublishableClaimSnapshot.create.mockResolvedValue({
      id: "55555555-5555-4555-8555-555555555555",
    });
    const repository = new PrismaPublishableClaimSnapshotRepository(
      client as never,
    );

    await expect(repository.persist(snapshot)).resolves.toEqual(snapshot);
    expect(client.sitePublishableClaimSnapshot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        siteId: SITE_ID,
        buildRunId: BUILD_RUN_ID,
        items: { create: [] },
      }),
      select: { id: true },
    });
  });
});
