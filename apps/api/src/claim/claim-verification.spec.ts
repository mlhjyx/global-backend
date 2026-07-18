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
  type: "certification",
  statement: "ISO 9001 certified",
  validUntil: null,
  version: 4,
};

describe("claim approval proof", () => {
  it("binds the approved version to the exact persisted claim identity", () => {
    const proof = buildClaimApprovalProof(CLAIM, 5);
    const audited = {
      ...CLAIM,
      version: 5,
      verifiedBy: "reviewer-42",
      verifiedAt: new Date("2026-07-18T12:00:00.000Z"),
      verificationMethod: "human_review",
      verificationProof: proof,
    };

    expect(proof).toEqual({
      action: "claim_approval",
      approvedVersion: 5,
      claimDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(hasValidClaimApprovalAudit(audited)).toBe(true);
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

  it("rejects a proof whose version does not equal the persisted claim version", () => {
    expect(
      hasValidClaimApprovalAudit({
        ...CLAIM,
        version: 6,
        verifiedBy: "reviewer-42",
        verifiedAt: new Date("2026-07-18T12:00:00.000Z"),
        verificationMethod: "human_review",
        verificationProof: buildClaimApprovalProof(CLAIM, 5),
      }),
    ).toBe(false);
  });
});
