import { describe, expect, it } from "vitest";
import {
  COMPANY_IDENTITY_RULE_VERSION,
  normalizeHumanIdentityReviewRequest,
  normalizeSystemIdentityResolutionDecision,
} from "./identity-review.domain";

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const EVIDENCE_ID = "33333333-3333-4333-8333-333333333333";

const BASE_HUMAN_REQUEST = {
  canonical_company_id: SOURCE_ID,
  linked_canonical_company_id: TARGET_ID,
  decision: "REVIEW_LINK",
  rule_version: COMPANY_IDENTITY_RULE_VERSION,
  evidence_refs: [{ type: "FIELD_EVIDENCE", id: EVIDENCE_ID }],
} as const;

describe("normalizeHumanIdentityReviewRequest", () => {
  it.each([
    ["REVIEW_LINK", TARGET_ID],
    ["REJECT_LINK", undefined],
    ["SPLIT", undefined],
  ] as const)("accepts and freezes the human %s decision", (decision, linkedId) => {
    const normalized = normalizeHumanIdentityReviewRequest({
      ...BASE_HUMAN_REQUEST,
      decision,
      linked_canonical_company_id: linkedId,
    });

    expect(normalized).toMatchObject({
      canonicalCompanyId: SOURCE_ID,
      linkedCanonicalCompanyId: linkedId ?? null,
      decision,
      ruleVersion: COMPANY_IDENTITY_RULE_VERSION,
      evidenceRefs: [{ type: "FIELD_EVIDENCE", id: EVIDENCE_ID }],
    });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.evidenceRefs)).toBe(true);
    expect(Object.isFrozen(normalized.evidenceRefs[0])).toBe(true);
  });

  it("rejects AUTO_LINK at the human boundary", () => {
    expect(() =>
      normalizeHumanIdentityReviewRequest({
        ...BASE_HUMAN_REQUEST,
        decision: "AUTO_LINK",
      }),
    ).toThrow("human identity review decision");
  });

  it.each([
    ["REVIEW_LINK requires a linked target", { ...BASE_HUMAN_REQUEST, linked_canonical_company_id: undefined }],
    ["SPLIT forbids a linked target", { ...BASE_HUMAN_REQUEST, decision: "SPLIT" }],
    ["self-link is forbidden", { ...BASE_HUMAN_REQUEST, linked_canonical_company_id: SOURCE_ID }],
  ])("fails closed when %s", (_label, input) => {
    expect(() => normalizeHumanIdentityReviewRequest(input)).toThrow();
  });

  it("rejects missing, duplicate, malformed, or unsupported evidence references", () => {
    expect(() =>
      normalizeHumanIdentityReviewRequest({
        ...BASE_HUMAN_REQUEST,
        evidence_refs: [],
      }),
    ).toThrow("evidence_refs");
    expect(() =>
      normalizeHumanIdentityReviewRequest({
        ...BASE_HUMAN_REQUEST,
        evidence_refs: [
          BASE_HUMAN_REQUEST.evidence_refs[0],
          BASE_HUMAN_REQUEST.evidence_refs[0],
        ],
      }),
    ).toThrow("duplicate");
    expect(() =>
      normalizeHumanIdentityReviewRequest({
        ...BASE_HUMAN_REQUEST,
        evidence_refs: [{ type: "FIELD_EVIDENCE", id: "not-a-uuid" }],
      }),
    ).toThrow("evidence_refs");
    expect(() =>
      normalizeHumanIdentityReviewRequest({
        ...BASE_HUMAN_REQUEST,
        evidence_refs: [{ type: "UNTRUSTED", id: EVIDENCE_ID }],
      }),
    ).toThrow("evidence_refs");
  });

  it("rejects client-owned provenance and unknown request keys", () => {
    for (const forged of [
      { workspace_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      { actor_id: "forged" },
      { actor_type: "SYSTEM" },
      { decided_at: "2026-08-08T12:00:00.000Z" },
      { created_at: "2026-08-08T12:00:00.000Z" },
    ]) {
      expect(() =>
        normalizeHumanIdentityReviewRequest({
          ...BASE_HUMAN_REQUEST,
          ...forged,
        }),
      ).toThrow("unsupported field");
    }
  });
});

describe("normalizeSystemIdentityResolutionDecision", () => {
  it("admits an internal AUTO_LINK with system-owned provenance", () => {
    const normalized = normalizeSystemIdentityResolutionDecision({
      workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      canonicalCompanyId: SOURCE_ID,
      linkedCanonicalCompanyId: null,
      decision: "AUTO_LINK",
      ruleVersion: COMPANY_IDENTITY_RULE_VERSION,
      evidenceRefs: [{ type: "RAW_RECORD", id: EVIDENCE_ID }],
      actorId: "company-identity-resolver",
      decidedAt: new Date("2026-08-08T12:00:00.000Z"),
    });

    expect(normalized).toMatchObject({
      decision: "AUTO_LINK",
      actorId: "company-identity-resolver",
      decidedAt: new Date("2026-08-08T12:00:00.000Z"),
    });
    expect(Object.isFrozen(normalized)).toBe(true);
  });

  it.each(["REJECT_LINK", "SPLIT"])(
    "does not let an internal resolver impersonate the human %s outcome",
    (decision) => {
      expect(() =>
        normalizeSystemIdentityResolutionDecision({
          workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          canonicalCompanyId: SOURCE_ID,
          linkedCanonicalCompanyId: null,
          decision,
          ruleVersion: COMPANY_IDENTITY_RULE_VERSION,
          evidenceRefs: [{ type: "RAW_RECORD", id: EVIDENCE_ID }],
          actorId: "company-identity-resolver",
          decidedAt: new Date("2026-08-08T12:00:00.000Z"),
        }),
      ).toThrow("system identity resolution decision");
    },
  );
});
