import { createHash } from "node:crypto";

interface ClaimApprovalIdentity {
  id: string;
  workspaceId: string;
  companyId: string;
  sourceId: string | null;
  originKey: string | null;
  factKey: string | null;
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

function claimApprovalDigestV2(
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

function claimApprovalDigestV3(
  claim: ClaimApprovalIdentity,
  approvedVersion: number,
  audit: ClaimApprovalAuditIdentity,
): string {
  return createHash("sha256")
    .update(
      `claim-approval/3\u0000${JSON.stringify([
        claim.id,
        claim.workspaceId,
        claim.companyId,
        claim.sourceId,
        claim.originKey,
        claim.factKey,
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
  proofVersion: 3;
  approvedVersion: number;
  claimDigest: string;
} {
  return {
    action: "claim_approval",
    proofVersion: 3,
    approvedVersion,
    claimDigest: claimApprovalDigestV3(claim, approvedVersion, audit),
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
    proof.approvedVersion !== claim.version
  ) {
    return false;
  }
  const audit = {
    verifiedBy: claim.verifiedBy,
    verifiedAt: claim.verifiedAt,
    verificationMethod: claim.verificationMethod,
  } as const;
  if (proof.proofVersion === 3) {
    return proof.claimDigest === claimApprovalDigestV3(claim, claim.version, audit);
  }
  // v2 predates factKey. It remains readable only for genuinely legacy/manual
  // Claims; an origin-keyed bridge Claim must be re-reviewed under v3 rather
  // than inheriting an audit that did not bind its semantic key.
  return (
    proof.proofVersion === 2 &&
    claim.originKey === null &&
    claim.factKey === null &&
    proof.claimDigest === claimApprovalDigestV2(claim, claim.version, audit)
  );
}
