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
const SOURCE_URL = "https://example.test/evidence/iso-9001";
const FETCHED_AT = new Date("2026-07-18T08:15:30.000Z");

describe("PrismaClaimEvidenceBridgeRepository", () => {
  it("prelocks existing projected Claims once in database UUID order", async () => {
    const queryRaw = vi.fn(async () => [
      { id: "11111111-1111-4111-8111-111111111111" },
      { id: "99999999-9999-4999-8999-999999999999" },
    ]);
    const repository = new PrismaClaimEvidenceBridgeRepository({
      $queryRaw: queryRaw,
    } as never);

    await expect(
      repository.lockExistingClaimsForOrigins(
        WORKSPACE_ID,
        COMPANY_ID,
        ["b".repeat(64), "a".repeat(64), "b".repeat(64)],
      ),
    ).resolves.toEqual([
      "11111111-1111-4111-8111-111111111111",
      "99999999-9999-4999-8999-999999999999",
    ]);

    expect(queryRaw).toHaveBeenCalledOnce();
    const query = queryRaw.mock.calls[0][0] as {
      sql: string;
      values: unknown[];
    };
    expect(query.sql).toMatch(
      /WHERE "workspace_id" = \?::uuid[\s\S]+"company_id" = \?::uuid[\s\S]+"origin_key" IN \(\?,\?\)[\s\S]+ORDER BY "id"[\s\S]+FOR UPDATE/,
    );
    expect(query.values).toEqual([
      WORKSPACE_ID,
      COMPANY_ID,
      "a".repeat(64),
      "b".repeat(64),
    ]);
  });

  it("does not issue an invalid IN () prelock query for an empty projection", async () => {
    const queryRaw = vi.fn();
    const repository = new PrismaClaimEvidenceBridgeRepository({
      $queryRaw: queryRaw,
    } as never);

    await expect(
      repository.lockExistingClaimsForOrigins(WORKSPACE_ID, COMPANY_ID, []),
    ).resolves.toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("reconstructs a fact only from the exact persisted ref/snapshot edge", async () => {
    const findFirst = vi.fn(async () => ({
      id: BRAND_PROFILE_ID,
      workspaceId: WORKSPACE_ID,
      siteId: SITE_ID,
      factSheet: [
        {
          key: "certifications",
          value: "ISO 9001 certified",
          claimType: "certification",
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
            displayUrl: SOURCE_URL,
            fetchedAt: FETCHED_AT,
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
        sourceUrl: SOURCE_URL,
        fetchedAt: FETCHED_AT,
      },
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BRAND_PROFILE_ID, workspaceId: WORKSPACE_ID },
      }),
    );
  });

  it("fails closed when a v2 fact lacks its server-frozen claim type", async () => {
    const repository = new PrismaClaimEvidenceBridgeRepository({
      brandProfile: {
        findFirst: vi.fn(async () => ({
          id: BRAND_PROFILE_ID,
          workspaceId: WORKSPACE_ID,
          siteId: SITE_ID,
          factSheet: [
            {
              key: "maximum_pressure",
              value: "Maximum pressure: 400 bar",
            },
          ],
          site: { companyProfileId: COMPANY_ID },
          evidenceRefs: [
            {
              id: "ref-1",
              factIndex: 0,
              factKey: "maximum_pressure",
              sourceSnapshotId: "99999999-9999-4999-8999-999999999999",
              sourceContentHash: "a".repeat(64),
              quote: "Maximum pressure: 400 bar",
              quoteStart: 0,
              quoteEnd: 25,
              quotePrefix: null,
              quoteSuffix: null,
              sourceSnapshot: {
                sourceRole: "fact_candidate",
                provenance: {},
              },
            },
          ],
        })),
      },
    } as never);

    await expect(
      repository.getFactContext(WORKSPACE_ID, BRAND_PROFILE_ID, 0),
    ).resolves.toBeNull();
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
      factKey: "certifications",
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
      factKey: "certifications",
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
        sourceUrl: SOURCE_URL,
        fetchedAt: FETCHED_AT,
      },
    });

    expect(result).toEqual({
      claimId: CLAIM_ID,
      evidenceId: EVIDENCE_ID,
      factKey: "certifications",
      status: "APPROVED",
      reused: false,
    });
    expect(claimUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {},
        create: expect.objectContaining({ factKey: "certifications" }),
        select: { factKey: true, id: true, status: true },
      }),
    );
    expect(evidenceUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {},
        create: expect.objectContaining({
          sourceUrl: SOURCE_URL,
          fetchedAt: FETCHED_AT,
        }),
      }),
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

  it("retains a non-cert source Asset on Evidence without mislabeling it as cert proof", async () => {
    const evidenceUpsert = vi.fn(async () => ({ id: EVIDENCE_ID }));
    const bridgeCreateMany = vi.fn(async () => ({ count: 1 }));
    const repository = new PrismaClaimEvidenceBridgeRepository({
      claim: {
        upsert: vi.fn(async () => ({
          id: CLAIM_ID,
          factKey: "main_products",
          status: "NEEDS_REVIEW",
        })),
      },
      evidence: { upsert: evidenceUpsert },
      brandProfileClaimBridge: { createMany: bridgeCreateMany },
    } as never);

    await repository.projectPendingClaim({
      workspaceId: WORKSPACE_ID,
      siteId: SITE_ID,
      companyProfileId: COMPANY_ID,
      brandProfileId: BRAND_PROFILE_ID,
      factIndex: 0,
      factKey: "main_products",
      type: "capability",
      statement: "Industrial pumps",
      status: "NEEDS_REVIEW",
      claimOriginKey: "b".repeat(64),
      evidenceOriginKey: "c".repeat(64),
      bridgeKey: "d".repeat(64),
      evidence: {
        evidenceRefId: "88888888-8888-4888-8888-888888888888",
        sourceSnapshotId: "99999999-9999-4999-8999-999999999999",
        sourceRole: "fact_candidate",
        sourceContentHash: "a".repeat(64),
        quote: "Industrial pumps",
        assetId: ASSET_ID,
      },
    });

    expect(evidenceUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ assetId: ASSET_ID }),
      }),
    );
    expect(bridgeCreateMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ certAssetId: undefined })],
      skipDuplicates: true,
    });
  });

  it("rejects reuse when an existing Claim exposes a different normalized fact key", async () => {
    const evidenceUpsert = vi.fn();
    const repository = new PrismaClaimEvidenceBridgeRepository({
      claim: {
        upsert: vi.fn(async () => ({
          id: CLAIM_ID,
          factKey: "operating_pressure",
          status: "NEEDS_REVIEW",
        })),
      },
      evidence: { upsert: evidenceUpsert },
    } as never);

    await expect(
      repository.projectPendingClaim({
        workspaceId: WORKSPACE_ID,
        siteId: SITE_ID,
        companyProfileId: COMPANY_ID,
        brandProfileId: BRAND_PROFILE_ID,
        factIndex: 0,
        factKey: "maximum_pressure",
        type: "param",
        statement: "Maximum pressure 400 bar",
        status: "NEEDS_REVIEW",
        claimOriginKey: "b".repeat(64),
        evidenceOriginKey: "c".repeat(64),
        bridgeKey: "d".repeat(64),
        evidence: {
          evidenceRefId: "88888888-8888-4888-8888-888888888888",
          sourceSnapshotId: "99999999-9999-4999-8999-999999999999",
          sourceRole: "fact_candidate",
          sourceContentHash: "a".repeat(64),
          quote: "Maximum pressure 400 bar",
        },
      }),
    ).rejects.toThrow("CLAIM_IDENTITY_CONFLICT");
    expect(evidenceUpsert).not.toHaveBeenCalled();
  });

  it("carries factKey through approved-effective reads after bridge deletion", async () => {
    const findMany = vi.fn(async () => [
      {
        id: CLAIM_ID,
        workspaceId: WORKSPACE_ID,
        companyId: COMPANY_ID,
        sourceId: null,
        originKey: "b".repeat(64),
        factKey: "maximum_pressure",
        type: "param",
        statement: "Maximum pressure 400 bar",
        status: "APPROVED",
        version: 2,
        validUntil: null,
        verifiedBy: "reviewer-1",
        verifiedAt: FETCHED_AT,
        verificationMethod: "human_review",
        verificationProof: { proofVersion: 3 },
        claimBridges: [],
      },
    ]);
    const repository = new PrismaClaimEvidenceBridgeRepository({
      claim: { findMany },
    } as never);

    await expect(
      repository.listClaimsForCompany(WORKSPACE_ID, COMPANY_ID, SITE_ID),
    ).resolves.toEqual([
      expect.objectContaining({
        id: CLAIM_ID,
        factKey: "maximum_pressure",
        hasSiteBridge: false,
      }),
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ factKey: true }),
      }),
    );
  });

  it("fails closed when a skipped bridge insert resolves to a different immutable identity", async () => {
    const bridgeFindUnique = vi.fn(async () => ({
      workspaceId: WORKSPACE_ID,
      siteId: SITE_ID,
      companyProfileId: COMPANY_ID,
      brandProfileId: BRAND_PROFILE_ID,
      evidenceRefId: "88888888-8888-4888-8888-888888888888",
      factIndex: 0,
      claimId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      evidenceId: EVIDENCE_ID,
      certAssetId: ASSET_ID,
      bridgeKey: "d".repeat(64),
    }));
    const repository = new PrismaClaimEvidenceBridgeRepository({
      claim: {
        upsert: vi.fn(async () => ({
          id: CLAIM_ID,
          factKey: "certifications",
          status: "NEEDS_REVIEW",
        })),
      },
      evidence: { upsert: vi.fn(async () => ({ id: EVIDENCE_ID })) },
      brandProfileClaimBridge: {
        createMany: vi.fn(async () => ({ count: 0 })),
        findUnique: bridgeFindUnique,
      },
    } as never);

    await expect(
      repository.projectPendingClaim({
        workspaceId: WORKSPACE_ID,
        siteId: SITE_ID,
        companyProfileId: COMPANY_ID,
        brandProfileId: BRAND_PROFILE_ID,
        factIndex: 0,
        factKey: "certifications",
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
          assetId: ASSET_ID,
        },
      }),
    ).rejects.toThrow("BRIDGE_IDENTITY_CONFLICT");
    expect(bridgeFindUnique).toHaveBeenCalledOnce();
  });
});

describe("claimTypeForBrandFact", () => {
  it.each([
    ["certifications", "ISO 9001 certified", "certification"],
    ["quality_system", "ISO9001", "certification"],
    ["safety_standard", "IEC61508", "certification"],
    ["automotive_quality", "IATF16949", "certification"],
    ["aerospace_quality", "AS9100", "certification"],
    ["质量体系", "通过ISO9001标准", "certification"],
    ["合规", "符合CE", "certification"],
    ["maximum_pressure", "Maximum pressure 400 bar", "param"],
    ["efficiency", "Efficiency reaches 95%", "param"],
    ["operating_temperature", "Operating temperature 80℃", "param"],
    ["tank_volume", "Tank volume 1.5 m³", "param"],
    ["rated_torque", "Rated torque 50 N·m", "param"],
    ["customer_case", "Delivered a verified customer project", "case"],
    ["capability", "We showcase precision engineering", "capability"],
    ["customization", "Client-specific custom engineering", "capability"],
    ["support", "Project-ready pump support", "capability"],
    ["customer关系", "Public capability", "capability"],
    ["capability", "Powerful after-sales service", "capability"],
    ["capability", "Capacity building support", "capability"],
    ["design", "Lightweight design", "capability"],
    ["capability", "We reach customers in 50 countries", "capability"],
    ["export_markets", "Reach global buyers", "capability"],
    ["capability", "Our services reach Europe", "capability"],
    ["environmental_compliance", "REACH compliant", "certification"],
    ["main_products", "Industrial pumps", "capability"],
  ])("maps %s to %s", (key, value, expected) => {
    expect(claimTypeForBrandFact(key, value)).toBe(expected);
  });
});
