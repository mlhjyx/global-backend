import { describe, expect, it } from "vitest";
import { ClaimEvidenceBridgeService } from "./claim-evidence-bridge.service";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE_ID = "99999999-9999-4999-8999-999999999999";
const SITE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_SITE_ID = "88888888-8888-4888-8888-888888888888";
const COMPANY_PROFILE_ID = "33333333-3333-4333-8333-333333333333";
const BRAND_PROFILE_ID = "44444444-4444-4444-8444-444444444444";
const ASSET_ID = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-07-18T12:00:00.000Z");
const CTX = { workspaceId: WORKSPACE_ID, userId: "reviewer-1", roles: [] };

type ClaimStatus =
  | "INGESTED"
  | "EXTRACTED"
  | "NEEDS_REVIEW"
  | "APPROVED"
  | "EXPIRED"
  | "REVOKED";

interface StoredFactContext {
  workspaceId: string;
  siteId: string;
  companyProfileId: string | null;
  brandProfileId: string;
  factIndex: number;
  factKey: string;
  claimType: string;
  value: string;
  evidenceRef: {
    evidenceRefId: string;
    sourceSnapshotId: string;
    sourceRole: "fact_candidate" | "research_hint";
    sourceContentHash: string;
    quote: string;
    assetId?: string;
  };
}

interface StoredAsset {
  id: string;
  workspaceId: string;
  siteId: string;
  kind: string;
  processingStatus: string;
  deletedAt: Date | null;
}

interface StoredClaim {
  id: string;
  workspaceId: string;
  companyProfileId: string;
  type: string;
  statement: string;
  status: ClaimStatus;
  validUntil: Date | null;
  verifiedBy?: string | null;
  verifiedAt?: Date | null;
  verificationMethod?: string | null;
  verificationProof?: Record<string, unknown> | null;
}

function factKey(brandProfileId: string, factIndex: number): string {
  return `${brandProfileId}:${factIndex}`;
}

function makeHarness(
  options: {
    fact?: Partial<StoredFactContext>;
    asset?: Partial<StoredAsset> | null;
    claims?: StoredClaim[];
  } = {},
) {
  const fact: StoredFactContext = {
    workspaceId: WORKSPACE_ID,
    siteId: SITE_ID,
    companyProfileId: COMPANY_PROFILE_ID,
    brandProfileId: BRAND_PROFILE_ID,
    factIndex: 0,
    factKey: "main_products",
    claimType: "capability",
    value: "Industrial pumps up to 400 bar",
    evidenceRef: {
      evidenceRefId: "evidence-ref-1",
      sourceSnapshotId: "source-snapshot-1",
      sourceRole: "fact_candidate",
      sourceContentHash: "a".repeat(64),
      quote: "Industrial pumps up to 400 bar",
    },
    ...options.fact,
  };
  const assets = new Map<string, StoredAsset>();
  if (options.asset !== null && options.asset !== undefined) {
    const asset: StoredAsset = {
      id: ASSET_ID,
      workspaceId: WORKSPACE_ID,
      siteId: SITE_ID,
      kind: "cert",
      processingStatus: "ready",
      deletedAt: null,
      ...options.asset,
    };
    assets.set(asset.id, asset);
  }
  const facts = new Map([[factKey(fact.brandProfileId, fact.factIndex), fact]]);
  const claims: StoredClaim[] = [...(options.claims ?? [])];
  const evidence: Record<string, unknown>[] = [];
  const claimsByOrigin = new Map<string, string>();
  const evidenceByOrigin = new Map<string, string>();
  const bridgesByKey = new Map<
    string,
    { claimId: string; evidenceId: string }
  >();
  const projectionInputs: Record<string, unknown>[] = [];
  let claimSequence = claims.length;

  const repository = {
    getCompanyProfileIdForSite: async (
      workspaceId: string,
      siteId: string,
    ) =>
      fact.workspaceId === workspaceId && fact.siteId === siteId
        ? fact.companyProfileId
        : null,
    getFactContext: async (
      workspaceId: string,
      brandProfileId: string,
      factIndex: number,
    ) => {
      const row = facts.get(factKey(brandProfileId, factIndex));
      return row?.workspaceId === workspaceId ? row : null;
    },
    getAsset: async (assetId: string) => assets.get(assetId) ?? null,
    projectPendingClaim: async (input: {
      workspaceId: string;
      siteId: string;
      companyProfileId: string;
      brandProfileId: string;
      factIndex: number;
      type: string;
      statement: string;
      status: ClaimStatus;
      evidence: Record<string, unknown>;
      claimOriginKey: string;
      evidenceOriginKey: string;
      bridgeKey: string;
    }) => {
      projectionInputs.push(input);
      const key = `${input.workspaceId}:${input.bridgeKey}`;
      const prior = bridgesByKey.get(key);
      if (prior)
        return { ...prior, status: "NEEDS_REVIEW" as const, reused: true };

      // Force concurrent callers to cross an async boundary before the unique-key recheck.
      await Promise.resolve();
      const concurrentWinner = bridgesByKey.get(key);
      if (concurrentWinner) {
        return {
          ...concurrentWinner,
          status: "NEEDS_REVIEW" as const,
          reused: true,
        };
      }

      let claimId = claimsByOrigin.get(input.claimOriginKey);
      if (!claimId) {
        claimId = `claim-${++claimSequence}`;
        claims.push({
          id: claimId,
          workspaceId: input.workspaceId,
          companyProfileId: input.companyProfileId,
          type: input.type,
          statement: input.statement,
          status: input.status,
          validUntil: null,
          verifiedBy: null,
          verifiedAt: null,
          verificationMethod: null,
          verificationProof: null,
        });
        claimsByOrigin.set(input.claimOriginKey, claimId);
      }
      let evidenceId = evidenceByOrigin.get(input.evidenceOriginKey);
      if (!evidenceId) {
        evidenceId = `claim-evidence-${evidence.length + 1}`;
        evidence.push({ id: evidenceId, claimId, ...input.evidence });
        evidenceByOrigin.set(input.evidenceOriginKey, evidenceId);
      }
      bridgesByKey.set(key, { claimId, evidenceId });
      return { claimId, evidenceId, status: input.status, reused: false };
    },
    listClaimsForCompany: async (
      workspaceId: string,
      companyProfileId: string,
    ) =>
      claims.filter(
        (claim) =>
          claim.workspaceId === workspaceId &&
          claim.companyProfileId === companyProfileId,
      ),
  };

  return {
    service: new ClaimEvidenceBridgeService(repository as never, () => NOW),
    db: {
      assets,
      claims,
      evidence,
      facts,
      claimsByOrigin,
      evidenceByOrigin,
      bridgesByKey,
      projectionInputs,
    },
  };
}

function projectionRef() {
  return {
    siteId: SITE_ID,
    brandProfileId: BRAND_PROFILE_ID,
    factIndex: 0,
  };
}

describe("ClaimEvidenceBridgeService — fact projection", () => {
  it("projects an eligible fact as NEEDS_REVIEW and ignores a model-requested APPROVED status", async () => {
    const { service, db } = makeHarness();

    const result = await service.projectFact(CTX, {
      ...projectionRef(),
      requestedStatus: "APPROVED",
    } as never);

    expect(result).toMatchObject({
      kind: "projected",
      claim: { status: "NEEDS_REVIEW" },
    });
    expect(db.claims).toHaveLength(1);
    expect(db.claims[0].status).toBe("NEEDS_REVIEW");
  });

  it("reuses one Claim/Evidence projection under replay and concurrency", async () => {
    const { service, db } = makeHarness();

    const [first, second] = await Promise.all([
      service.projectFact(CTX, projectionRef()),
      service.projectFact(CTX, projectionRef()),
    ]);
    const replay = await service.projectFact(CTX, projectionRef());

    expect(first).toMatchObject({ kind: "projected" });
    expect(second).toMatchObject({ kind: "projected" });
    expect(replay).toMatchObject({ kind: "projected" });
    expect(
      new Set([first.claim.id, second.claim.id, replay.claim.id]).size,
    ).toBe(1);
    expect(db.claims).toHaveLength(1);
    expect(db.evidence).toHaveLength(1);
    expect(db.bridgesByKey).toHaveProperty("size", 1);
  });

  it("derives stable SHA-256 domain keys so a new BrandProfile retry reuses Claim/Evidence", async () => {
    const { service, db } = makeHarness();
    const retryBrandProfileId = "77777777-7777-4777-8777-777777777777";
    const originalFact = db.facts.get(factKey(BRAND_PROFILE_ID, 0))!;
    db.facts.set(factKey(retryBrandProfileId, 0), {
      ...originalFact,
      brandProfileId: retryBrandProfileId,
      evidenceRef: {
        ...originalFact.evidenceRef,
        evidenceRefId: "evidence-ref-retry",
      },
    });

    const first = await service.projectFact(CTX, projectionRef());
    const retry = await service.projectFact(CTX, {
      ...projectionRef(),
      brandProfileId: retryBrandProfileId,
    });

    expect(first.claim.id).toBe(retry.claim.id);
    expect(first.evidence.id).toBe(retry.evidence.id);
    expect(db.claims).toHaveLength(1);
    expect(db.evidence).toHaveLength(1);
    expect(db.bridgesByKey).toHaveProperty("size", 2);
    for (const input of db.projectionInputs) {
      expect(input.claimOriginKey).toMatch(/^[0-9a-f]{64}$/);
      expect(input.evidenceOriginKey).toMatch(/^[0-9a-f]{64}$/);
      expect(input.bridgeKey).toMatch(/^[0-9a-f]{64}$/);
    }

    const otherSourceProfileId = "66666666-6666-4666-8666-666666666666";
    db.facts.set(factKey(otherSourceProfileId, 0), {
      ...originalFact,
      brandProfileId: otherSourceProfileId,
      evidenceRef: {
        ...originalFact.evidenceRef,
        evidenceRefId: "evidence-ref-other-source",
        sourceSnapshotId: "source-snapshot-2",
      },
    });
    const otherSource = await service.projectFact(CTX, {
      ...projectionRef(),
      brandProfileId: otherSourceProfileId,
    });

    expect(otherSource.claim.id).toBe(first.claim.id);
    expect(otherSource.evidence.id).not.toBe(first.evidence.id);
    expect(db.claims).toHaveLength(1);
    expect(db.evidence).toHaveLength(2);
    expect(db.bridgesByKey).toHaveProperty("size", 3);
  });
});

describe("ClaimEvidenceBridgeService — certification gate", () => {
  const certificationFact: Partial<StoredFactContext> = {
    factKey: "certifications",
    claimType: "certification",
    value: "ISO 9001 certified",
    evidenceRef: {
      evidenceRefId: "evidence-ref-cert",
      sourceSnapshotId: "source-snapshot-cert",
      sourceRole: "fact_candidate",
      sourceContentHash: "b".repeat(64),
      quote: "ISO 9001 certified",
      assetId: ASSET_ID,
    },
  };

  it.each([
    ["missing", null],
    ["wrong kind", { kind: "doc" }],
    ["non-ready", { processingStatus: "processing" }],
    ["deleted", { deletedAt: new Date("2026-07-18T11:00:00.000Z") }],
    ["cross-site", { siteId: OTHER_SITE_ID }],
    ["cross-tenant", { workspaceId: OTHER_WORKSPACE_ID }],
  ])("rejects certification backed by a %s asset", async (_label, asset) => {
    const { service, db } = makeHarness({
      fact: certificationFact,
      asset: asset as Partial<StoredAsset> | null,
    });

    const result = await service.projectFact(CTX, projectionRef());

    expect(result).toEqual({
      kind: "gap",
      reason: "unverified_certification",
    });
    expect(db.claims).toHaveLength(0);
  });

  it("allows a ready same-tenant/site cert Asset but still creates only NEEDS_REVIEW", async () => {
    const { service, db } = makeHarness({
      fact: certificationFact,
      asset: {},
    });

    const result = await service.projectFact(CTX, projectionRef());

    expect(result).toMatchObject({
      kind: "projected",
      claim: { status: "NEEDS_REVIEW" },
    });
    expect(db.claims[0].status).toBe("NEEDS_REVIEW");
  });

  it("does not trust model-supplied manual verification", async () => {
    const { service, db } = makeHarness({
      fact: {
        ...certificationFact,
        evidenceRef: {
          ...certificationFact.evidenceRef!,
          assetId: undefined,
        },
      },
      asset: null,
    });

    const result = await service.projectFact(CTX, {
      ...projectionRef(),
      manualVerification: {
        actorId: "model",
        verifiedAt: NOW,
        proof: "model says verified",
      },
    } as never);

    expect(result).toEqual({
      kind: "gap",
      reason: "unverified_certification",
    });
    expect(db.claims).toHaveLength(0);
  });
});

describe("ClaimEvidenceBridgeService — approved-effective read gate", () => {
  it("returns only APPROVED claims with no expiry or a future validUntil", async () => {
    const claims: StoredClaim[] = [
      ["approved-future", "APPROVED", "2026-07-19T12:00:00.000Z"],
      ["approved-expired-by-time", "APPROVED", "2026-07-18T11:59:59.999Z"],
      ["approved-without-expiry", "APPROVED", null],
      ["needs-review", "NEEDS_REVIEW", "2026-07-19T12:00:00.000Z"],
      ["expired-state", "EXPIRED", "2026-07-19T12:00:00.000Z"],
      ["revoked-state", "REVOKED", "2026-07-19T12:00:00.000Z"],
    ].map(([id, status, validUntil]) => ({
      id: id as string,
      workspaceId: WORKSPACE_ID,
      companyProfileId: COMPANY_PROFILE_ID,
      type: "capability",
      statement: id as string,
      status: status as ClaimStatus,
      validUntil: validUntil ? new Date(validUntil as string) : null,
    }));
    const { service } = makeHarness({ claims });

    const result = await service.listApprovedEffectiveClaims(CTX, {
      siteId: SITE_ID,
    });

    expect(result.map((claim: StoredClaim) => claim.id)).toEqual([
      "approved-future",
      "approved-without-expiry",
    ]);
  });

  it("fails closed for an unaudited certification but accepts durable human verification", async () => {
    const base: Omit<StoredClaim, "id" | "verifiedBy" | "verifiedAt" | "verificationMethod" | "verificationProof"> = {
      workspaceId: WORKSPACE_ID,
      companyProfileId: COMPANY_PROFILE_ID,
      type: "certification",
      statement: "ISO 9001 certified",
      status: "APPROVED",
      validUntil: null,
    };
    const { service } = makeHarness({
      claims: [
        {
          ...base,
          id: "unaudited-certification",
          verifiedBy: null,
          verifiedAt: null,
          verificationMethod: null,
          verificationProof: null,
        },
        {
          ...base,
          id: "human-verified-certification",
          verifiedBy: "reviewer-1",
          verifiedAt: NOW,
          verificationMethod: "human_review",
          verificationProof: {
            action: "claim_approval",
            approvedVersion: 2,
          },
        },
      ],
    });

    const result = await service.listApprovedEffectiveClaims(CTX, {
      siteId: SITE_ID,
    });

    expect(result.map((claim: StoredClaim) => claim.id)).toEqual([
      "human-verified-certification",
    ]);
  });
});
