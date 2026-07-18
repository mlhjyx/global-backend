import { createHash } from "node:crypto";

interface ClaimApprovalIdentity {
  id: string;
  workspaceId: string;
  companyId: string;
  sourceId: string | null;
  originKey: string | null;
  type: string;
  statement: string;
  validUntil: Date | null;
}

interface ClaimApprovalAuditIdentity {
  verifiedBy: string;
  verifiedAt: Date;
  verificationMethod: "human_review";
}

interface AuditedClaim extends ClaimApprovalIdentity {
  version: number;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  verificationMethod: string | null;
  verificationProof: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function claimApprovalDigest(
  claim: ClaimApprovalIdentity,
  approvedVersion: number,
  audit: ClaimApprovalAuditIdentity,
): string {
  return createHash("sha256")
    .update(
      `claim-approval/2\u0000${JSON.stringify([
        claim.id,
        claim.workspaceId,
        claim.companyId,
        claim.sourceId,
        claim.originKey,
        claim.type,
        claim.statement,
        claim.validUntil?.toISOString() ?? null,
        approvedVersion,
        audit.verifiedBy,
        audit.verifiedAt.toISOString(),
        audit.verificationMethod,
      ])}`,
      "utf8",
    )
    .digest("hex");
}

export function buildClaimApprovalProof(
  claim: ClaimApprovalIdentity,
  approvedVersion: number,
  audit: ClaimApprovalAuditIdentity,
): {
  action: "claim_approval";
  proofVersion: 2;
  approvedVersion: number;
  claimDigest: string;
} {
  return {
    action: "claim_approval",
    proofVersion: 2,
    approvedVersion,
    claimDigest: claimApprovalDigest(claim, approvedVersion, audit),
  };
}

/** Recompute the approval proof instead of trusting non-empty audit columns. */
export function hasValidClaimApprovalAudit(claim: AuditedClaim): boolean {
  const proof = claim.verificationProof;
  if (
    !claim.verifiedBy?.trim() ||
    !(claim.verifiedAt instanceof Date) ||
    !Number.isFinite(claim.verifiedAt.getTime()) ||
    claim.verificationMethod !== "human_review" ||
    !isRecord(proof) ||
    proof.action !== "claim_approval" ||
    proof.proofVersion !== 2 ||
    proof.approvedVersion !== claim.version
  ) {
    return false;
  }
  return (
    proof.claimDigest ===
    claimApprovalDigest(claim, claim.version, {
      verifiedBy: claim.verifiedBy,
      verifiedAt: claim.verifiedAt,
      verificationMethod: claim.verificationMethod,
    })
  );
}
