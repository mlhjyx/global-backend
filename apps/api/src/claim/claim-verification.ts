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
): string {
  return createHash("sha256")
    .update(
      `claim-approval/1\u0000${JSON.stringify([
        claim.id,
        claim.workspaceId,
        claim.companyId,
        claim.sourceId,
        claim.originKey,
        claim.type,
        claim.statement,
        claim.validUntil?.toISOString() ?? null,
        approvedVersion,
      ])}`,
      "utf8",
    )
    .digest("hex");
}

export function buildClaimApprovalProof(
  claim: ClaimApprovalIdentity,
  approvedVersion: number,
): {
  action: "claim_approval";
  approvedVersion: number;
  claimDigest: string;
} {
  return {
    action: "claim_approval",
    approvedVersion,
    claimDigest: claimApprovalDigest(claim, approvedVersion),
  };
}

/** Recompute the approval proof instead of trusting non-empty audit columns. */
export function hasValidClaimApprovalAudit(claim: AuditedClaim): boolean {
  const proof = claim.verificationProof;
  return (
    Boolean(claim.verifiedBy?.trim()) &&
    claim.verifiedAt instanceof Date &&
    Number.isFinite(claim.verifiedAt.getTime()) &&
    claim.verificationMethod === "human_review" &&
    isRecord(proof) &&
    proof.action === "claim_approval" &&
    proof.approvedVersion === claim.version &&
    proof.claimDigest === claimApprovalDigest(claim, claim.version)
  );
}
