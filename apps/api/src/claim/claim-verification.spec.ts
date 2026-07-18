import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildClaimApprovalProof,
  hasValidClaimApprovalAudit,
} from "./claim-verification";

const CLAIM = {
  id: "22222222-2222-4222-8222-222222222222",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  companyId: "33333333-3333-4333-8333-333333333333",
  sourceId: null,
  originKey: "a".repeat(64),
  factKey: "certifications",
  type: "certification",
  statement: "ISO 9001 certified",
  validUntil: null,
  version: 4,
};

describe("claim approval proof", () => {
  it("binds the approved version to the exact persisted claim identity", () => {
    const approvalAudit = {
      verifiedBy: "reviewer-42",
      verifiedAt: new Date("2026-07-18T12:00:00.000Z"),
      verificationMethod: "human_review" as const,
    };
    const proof = buildClaimApprovalProof(CLAIM, 5, approvalAudit);
    const audited = {
      ...CLAIM,
      version: 5,
      ...approvalAudit,
      verificationProof: proof,
    };

    expect(proof).toEqual({
      action: "claim_approval",
      proofVersion: 3,
      approvedVersion: 5,
      claimDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(hasValidClaimApprovalAudit(audited)).toBe(true);
    expect(
      hasValidClaimApprovalAudit({
        ...audited,
        factKey: "quality_certifications",
      }),
    ).toBe(false);
    expect(
      hasValidClaimApprovalAudit({
        ...audited,
        statement: "ISO 14001 certified",
      }),
    ).toBe(false);
    expect(
      hasValidClaimApprovalAudit({
        ...audited,
        verifiedBy: "forged-reviewer",
      }),
    ).toBe(false);
    expect(
      hasValidClaimApprovalAudit({
        ...audited,
        verifiedAt: new Date("2039-01-01T00:00:00.000Z"),
      }),
    ).toBe(false);
    expect(
      hasValidClaimApprovalAudit({
        ...audited,
        verificationMethod: "forged_method",
      }),
    ).toBe(false);
  });

  it("does not let a legacy v2 proof authorize an origin-keyed Claim with new fact semantics", () => {
    expect(
      hasValidClaimApprovalAudit({
        ...CLAIM,
        version: 5,
        verifiedBy: "reviewer-42",
        verifiedAt: new Date("2026-07-18T12:00:00.000Z"),
        verificationMethod: "human_review",
        verificationProof: {
          action: "claim_approval",
          proofVersion: 2,
          approvedVersion: 5,
          claimDigest: "a".repeat(64),
        },
      }),
    ).toBe(false);
  });

  it("keeps a valid v2 proof readable only for a genuinely legacy Claim", () => {
    const legacy = {
      ...CLAIM,
      originKey: null,
      factKey: null,
      version: 5,
      verifiedBy: "reviewer-42",
      verifiedAt: new Date("2026-07-18T12:00:00.000Z"),
      verificationMethod: "human_review" as const,
    };
    const claimDigest = createHash("sha256")
      .update(
        `claim-approval/2\u0000${JSON.stringify([
          legacy.id,
          legacy.workspaceId,
          legacy.companyId,
          legacy.sourceId,
          legacy.originKey,
          legacy.type,
          legacy.statement,
          legacy.validUntil,
          legacy.version,
          legacy.verifiedBy,
          legacy.verifiedAt.toISOString(),
          legacy.verificationMethod,
        ])}`,
        "utf8",
      )
      .digest("hex");

    expect(
      hasValidClaimApprovalAudit({
        ...legacy,
        verificationProof: {
          action: "claim_approval",
          proofVersion: 2,
          approvedVersion: legacy.version,
          claimDigest,
        },
      }),
    ).toBe(true);
  });

  it("rejects a proof whose version does not equal the persisted claim version", () => {
    expect(
      hasValidClaimApprovalAudit({
        ...CLAIM,
        version: 6,
        verifiedBy: "reviewer-42",
        verifiedAt: new Date("2026-07-18T12:00:00.000Z"),
        verificationMethod: "human_review",
        verificationProof: buildClaimApprovalProof(CLAIM, 5, {
          verifiedBy: "reviewer-42",
          verifiedAt: new Date("2026-07-18T12:00:00.000Z"),
          verificationMethod: "human_review",
        }),
      }),
    ).toBe(false);
  });
});
