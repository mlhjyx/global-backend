import { describe, expect, it, vi } from "vitest";
import {
  PrismaClaimEvidenceBridgeRepository,
  claimTypeForBrandFact,
} from "./claim-evidence-bridge.prisma";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SITE_ID = "22222222-2222-4222-8222-222222222222";
const COMPANY_ID = "33333333-3333-4333-8333-333333333333";
const BRAND_PROFILE_ID = "44444444-4444-4444-8444-444444444444";
const CLAIM_ID = "55555555-5555-4555-8555-555555555555";
const EVIDENCE_ID = "66666666-6666-4666-8666-666666666666";
const ASSET_ID = "77777777-7777-4777-8777-777777777777";

describe("PrismaClaimEvidenceBridgeRepository", () => {
  it("reconstructs a fact only from the exact persisted ref/snapshot edge", async () => {
    const findFirst = vi.fn(async () => ({
      id: BRAND_PROFILE_ID,
      workspaceId: WORKSPACE_ID,
      siteId: SITE_ID,
      factSheet: [
        {
          key: "certifications",
          value: "ISO 9001 certified",
          evidence: { evidenceRefId: "model-controlled-id-is-ignored" },
        },
      ],
      site: { companyProfileId: COMPANY_ID },
      evidenceRefs: [
        {
          id: "88888888-8888-4888-8888-888888888888",
          factIndex: 0,
          factKey: "certifications",
          sourceSnapshotId: "99999999-9999-4999-8999-999999999999",
          sourceContentHash: "a".repeat(64),
          quote: "ISO 9001 certified",
          quoteStart: 4,
          quoteEnd: 22,
          quotePrefix: "The ",
          quoteSuffix: " company",
          sourceSnapshot: {
            sourceRole: "fact_candidate",
            provenance: { assetId: ASSET_ID },
          },
        },
      ],
    }));
    const repository = new PrismaClaimEvidenceBridgeRepository({
      brandProfile: { findFirst },
    } as never);

    const fact = await repository.getFactContext(
      WORKSPACE_ID,
      BRAND_PROFILE_ID,
      0,
    );

    expect(fact).toEqual({
      workspaceId: WORKSPACE_ID,
      siteId: SITE_ID,
      companyProfileId: COMPANY_ID,
      brandProfileId: BRAND_PROFILE_ID,
      factIndex: 0,
      factKey: "certifications",
      claimType: "certification",
      value: "ISO 9001 certified",
      evidenceRef: {
        evidenceRefId: "88888888-8888-4888-8888-888888888888",
        sourceSnapshotId: "99999999-9999-4999-8999-999999999999",
        sourceRole: "fact_candidate",
        sourceContentHash: "a".repeat(64),
        quote: "ISO 9001 certified",
        quoteStart: 4,
        quoteEnd: 22,
        quotePrefix: "The ",
        quoteSuffix: " company",
        assetId: ASSET_ID,
      },
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BRAND_PROFILE_ID, workspaceId: WORKSPACE_ID },
      }),
    );
  });

  it("returns null when JSON fact identity and the immutable evidence ref disagree", async () => {
    const repository = new PrismaClaimEvidenceBridgeRepository({
      brandProfile: {
        findFirst: vi.fn(async () => ({
          id: BRAND_PROFILE_ID,
          workspaceId: WORKSPACE_ID,
          siteId: SITE_ID,
          factSheet: [{ key: "main_products", value: "Pumps" }],
          site: { companyProfileId: COMPANY_ID },
          evidenceRefs: [
            {
              id: "ref-1",
              factIndex: 0,
              factKey: "certifications",
              sourceSnapshot: { sourceRole: "fact_candidate", provenance: {} },
            },
          ],
        })),
      },
    } as never);

    await expect(
      repository.getFactContext(WORKSPACE_ID, BRAND_PROFILE_ID, 0),
    ).resolves.toBeNull();
  });

  it("uses no-op upserts and an append-only bridge insert without downgrading an existing Claim", async () => {
    const claimUpsert = vi.fn(async () => ({
      id: CLAIM_ID,
      status: "APPROVED",
    }));
    const evidenceUpsert = vi.fn(async () => ({ id: EVIDENCE_ID }));
    const bridgeCreateMany = vi.fn(async () => ({ count: 1 }));
    const repository = new PrismaClaimEvidenceBridgeRepository({
      claim: { upsert: claimUpsert },
      evidence: { upsert: evidenceUpsert },
      brandProfileClaimBridge: { createMany: bridgeCreateMany },
    } as never);

    const result = await repository.projectPendingClaim({
      workspaceId: WORKSPACE_ID,
      siteId: SITE_ID,
      companyProfileId: COMPANY_ID,
      brandProfileId: BRAND_PROFILE_ID,
      factIndex: 0,
      type: "certification",
      statement: "ISO 9001 certified",
      status: "NEEDS_REVIEW",
      claimOriginKey: "b".repeat(64),
      evidenceOriginKey: "c".repeat(64),
      bridgeKey: "d".repeat(64),
      evidence: {
        evidenceRefId: "88888888-8888-4888-8888-888888888888",
        sourceSnapshotId: "99999999-9999-4999-8999-999999999999",
        sourceRole: "fact_candidate",
        sourceContentHash: "a".repeat(64),
        quote: "ISO 9001 certified",
        quoteStart: 4,
        quoteEnd: 22,
        quotePrefix: "The ",
        quoteSuffix: " company",
        assetId: ASSET_ID,
      },
    });

    expect(result).toEqual({
      claimId: CLAIM_ID,
      evidenceId: EVIDENCE_ID,
      status: "APPROVED",
      reused: false,
    });
    expect(claimUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: {} }),
    );
    expect(evidenceUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: {} }),
    );
    expect(bridgeCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          workspaceId: WORKSPACE_ID,
          siteId: SITE_ID,
          companyProfileId: COMPANY_ID,
          brandProfileId: BRAND_PROFILE_ID,
          factIndex: 0,
          claimId: CLAIM_ID,
          evidenceId: EVIDENCE_ID,
          certAssetId: ASSET_ID,
          bridgeKey: "d".repeat(64),
        }),
      ],
      skipDuplicates: true,
    });
  });

  it("locks certification assets and returns their full scope/lifecycle", async () => {
    const queryRaw = vi.fn(async () => [
      {
        id: ASSET_ID,
        workspaceId: WORKSPACE_ID,
        siteId: SITE_ID,
        kind: "cert",
        processingStatus: "ready",
        deletedAt: null,
      },
    ]);
    const repository = new PrismaClaimEvidenceBridgeRepository({
      $queryRaw: queryRaw,
    } as never);

    await expect(repository.getAsset(ASSET_ID)).resolves.toEqual({
      id: ASSET_ID,
      workspaceId: WORKSPACE_ID,
      siteId: SITE_ID,
      kind: "cert",
      processingStatus: "ready",
      deletedAt: null,
    });
    expect(queryRaw).toHaveBeenCalledOnce();
  });
});

describe("claimTypeForBrandFact", () => {
  it.each([
    ["certifications", "ISO 9001 certified", "certification"],
    ["maximum_pressure", "Maximum pressure 400 bar", "param"],
    ["customer_case", "Delivered a verified customer project", "case"],
    ["main_products", "Industrial pumps", "capability"],
  ])("maps %s to %s", (key, value, expected) => {
    expect(claimTypeForBrandFact(key, value)).toBe(expected);
  });
});
