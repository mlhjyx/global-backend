import { createHash } from "node:crypto";
import type { RequestContext } from "../auth/request-context";
import { hasValidClaimApprovalAudit } from "../claim/claim-verification";
import { isCertificationClaim } from "./claim-classification";

export type BridgeClaimStatus =
  | "INGESTED"
  | "EXTRACTED"
  | "NEEDS_REVIEW"
  | "APPROVED"
  | "EXPIRED"
  | "REVOKED";

export interface ClaimEvidenceFactContext {
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
    quoteStart?: number;
    quoteEnd?: number;
    quotePrefix?: string;
    quoteSuffix?: string;
    assetId?: string;
  };
}

export interface ClaimEvidenceAsset {
  id: string;
  workspaceId: string;
  siteId: string;
  kind: string;
  processingStatus: string;
  deletedAt: Date | null;
}

export interface ApprovedEffectiveClaim {
  id: string;
  workspaceId: string;
  companyProfileId: string;
  sourceId: string | null;
  originKey: string | null;
  type: string;
  statement: string;
  status: BridgeClaimStatus;
  version: number;
  validUntil: Date | null;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  verificationMethod: string | null;
  verificationProof: Record<string, unknown> | null;
}

export interface PendingClaimProjectionInput {
  workspaceId: string;
  siteId: string;
  companyProfileId: string;
  brandProfileId: string;
  factIndex: number;
  type: string;
  statement: string;
  status: "NEEDS_REVIEW";
  evidence: {
    evidenceRefId: string;
    sourceSnapshotId: string;
    sourceRole: "fact_candidate";
    sourceContentHash: string;
    quote: string;
    quoteStart?: number;
    quoteEnd?: number;
    quotePrefix?: string;
    quoteSuffix?: string;
    assetId?: string;
  };
  claimOriginKey: string;
  evidenceOriginKey: string;
  bridgeKey: string;
}

export interface PendingClaimProjectionResult {
  claimId: string;
  evidenceId: string;
  status: BridgeClaimStatus;
  reused: boolean;
}

/**
 * Persistence boundary for the pure bridge policy. Implementations must make
 * projectPendingClaim atomic and use the supplied unique keys for conflict-safe
 * replay/concurrency handling.
 */
export interface ClaimEvidenceBridgeRepository {
  getFactContext(
    workspaceId: string,
    brandProfileId: string,
    factIndex: number,
  ): Promise<ClaimEvidenceFactContext | null>;
  getCompanyProfileIdForSite(
    workspaceId: string,
    siteId: string,
  ): Promise<string | null>;
  getAsset(assetId: string): Promise<ClaimEvidenceAsset | null>;
  projectPendingClaim(
    input: PendingClaimProjectionInput,
  ): Promise<PendingClaimProjectionResult>;
  listClaimsForCompany(
    workspaceId: string,
    companyProfileId: string,
  ): Promise<ApprovedEffectiveClaim[]>;
}

export interface ProjectClaimFactInput {
  siteId: string;
  brandProfileId: string;
  factIndex: number;
}

export type ProjectClaimFactResult =
  | {
      kind: "projected";
      claim: { id: string; status: BridgeClaimStatus };
      evidence: { id: string };
      reused: boolean;
    }
  | {
      kind: "gap";
      reason:
        | "fact_not_found"
        | "site_company_profile_link_required"
        | "research_hint_not_publishable"
        | "unverified_certification";
    };

const KEY_VERSION = "claim-evidence-bridge/1";

function normalizeIdentityPart(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function domainHash(domain: string, parts: readonly unknown[]): string {
  return createHash("sha256")
    .update(
      `${KEY_VERSION}\u0000${domain}\u0000${JSON.stringify(parts)}`,
      "utf8",
    )
    .digest("hex");
}

function isCertificationFact(fact: ClaimEvidenceFactContext): boolean {
  return isCertificationClaim({
    type: fact.claimType,
    key: fact.factKey,
    value: fact.value,
  });
}

export function isPublishableCertificationAsset(
  asset: ClaimEvidenceAsset | null,
  scope: { workspaceId: string; siteId: string },
): boolean {
  return (
    asset !== null &&
    asset.workspaceId === scope.workspaceId &&
    asset.siteId === scope.siteId &&
    asset.kind === "cert" &&
    asset.processingStatus === "ready" &&
    asset.deletedAt === null
  );
}

function isFutureOrUnbounded(validUntil: Date | null, now: Date): boolean {
  if (validUntil === null) return true;
  const validUntilMs = validUntil.getTime();
  return Number.isFinite(validUntilMs) && validUntilMs > now.getTime();
}

/**
 * Internal Claim/Evidence truth bridge. It deliberately accepts no model-owned
 * approval or verification fields: generated claims always enter human review.
 */
export class ClaimEvidenceBridgeService {
  constructor(
    private readonly repository: ClaimEvidenceBridgeRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async projectFact(
    ctx: RequestContext,
    input: ProjectClaimFactInput,
  ): Promise<ProjectClaimFactResult> {
    const fact = await this.repository.getFactContext(
      ctx.workspaceId,
      input.brandProfileId,
      input.factIndex,
    );
    if (
      fact === null ||
      fact.workspaceId !== ctx.workspaceId ||
      fact.siteId !== input.siteId ||
      fact.brandProfileId !== input.brandProfileId ||
      fact.factIndex !== input.factIndex
    ) {
      return { kind: "gap", reason: "fact_not_found" };
    }
    if (fact.companyProfileId === null) {
      return { kind: "gap", reason: "site_company_profile_link_required" };
    }
    if (fact.evidenceRef.sourceRole !== "fact_candidate") {
      return { kind: "gap", reason: "research_hint_not_publishable" };
    }

    if (isCertificationFact(fact)) {
      const assetId = fact.evidenceRef.assetId;
      const asset = assetId ? await this.repository.getAsset(assetId) : null;
      if (!isPublishableCertificationAsset(asset, fact)) {
        return { kind: "gap", reason: "unverified_certification" };
      }
    }

    const normalizedFactKey = normalizeIdentityPart(fact.factKey);
    const normalizedType = normalizeIdentityPart(fact.claimType);
    const normalizedStatement = normalizeIdentityPart(fact.value);
    const claimOriginKey = domainHash("claim-origin", [
      fact.workspaceId,
      fact.companyProfileId,
      normalizedFactKey,
      normalizedType,
      normalizedStatement,
    ]);
    const evidenceOriginKey = domainHash("evidence-origin", [
      claimOriginKey,
      fact.workspaceId,
      fact.siteId,
      fact.evidenceRef.sourceSnapshotId,
      fact.evidenceRef.sourceRole,
      fact.evidenceRef.assetId ?? null,
      fact.evidenceRef.sourceContentHash,
      fact.evidenceRef.quote,
      fact.evidenceRef.quoteStart ?? null,
      fact.evidenceRef.quoteEnd ?? null,
      fact.evidenceRef.quotePrefix ?? null,
      fact.evidenceRef.quoteSuffix ?? null,
    ]);
    const bridgeKey = domainHash("brand-profile-claim-edge", [
      fact.workspaceId,
      fact.siteId,
      fact.brandProfileId,
      fact.factIndex,
      fact.evidenceRef.evidenceRefId,
      fact.evidenceRef.sourceSnapshotId,
      claimOriginKey,
      evidenceOriginKey,
    ]);

    const projected = await this.repository.projectPendingClaim({
      workspaceId: fact.workspaceId,
      siteId: fact.siteId,
      companyProfileId: fact.companyProfileId,
      brandProfileId: fact.brandProfileId,
      factIndex: fact.factIndex,
      type: normalizedType,
      statement: normalizedStatement,
      status: "NEEDS_REVIEW",
      evidence: {
        evidenceRefId: fact.evidenceRef.evidenceRefId,
        sourceSnapshotId: fact.evidenceRef.sourceSnapshotId,
        sourceRole: "fact_candidate",
        sourceContentHash: fact.evidenceRef.sourceContentHash,
        quote: fact.evidenceRef.quote,
        quoteStart: fact.evidenceRef.quoteStart,
        quoteEnd: fact.evidenceRef.quoteEnd,
        quotePrefix: fact.evidenceRef.quotePrefix,
        quoteSuffix: fact.evidenceRef.quoteSuffix,
        assetId: fact.evidenceRef.assetId,
      },
      claimOriginKey,
      evidenceOriginKey,
      bridgeKey,
    });

    return {
      kind: "projected",
      claim: { id: projected.claimId, status: projected.status },
      evidence: { id: projected.evidenceId },
      reused: projected.reused,
    };
  }

  async listApprovedEffectiveClaims(
    ctx: RequestContext,
    input: { siteId: string },
  ): Promise<ApprovedEffectiveClaim[]> {
    const companyProfileId = await this.repository.getCompanyProfileIdForSite(
      ctx.workspaceId,
      input.siteId,
    );
    if (companyProfileId === null) return [];

    const claims = await this.repository.listClaimsForCompany(
      ctx.workspaceId,
      companyProfileId,
    );
    const now = this.now();
    return claims.filter(
      (claim) =>
        claim.workspaceId === ctx.workspaceId &&
        claim.companyProfileId === companyProfileId &&
        claim.status === "APPROVED" &&
        isFutureOrUnbounded(claim.validUntil, now) &&
        ((claim.originKey == null &&
          !isCertificationClaim({
            type: claim.type,
            value: claim.statement,
          })) ||
          hasValidClaimApprovalAudit({
            ...claim,
            companyId: claim.companyProfileId,
          })),
    );
  }
}
