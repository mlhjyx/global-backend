import { describe, expect, it } from "vitest";
import {
  DRAFT_FORBIDDEN_PHRASES,
  draftViolationCodes,
  prepareDraftGrounding,
  validateOutreachDraft,
  type DraftGroundingContext,
  type OutreachDraft,
} from "./draft-validation";

const SENDER = {
  legalName: "Nordwind Maschinenbau GmbH",
  postalAddress: "Industriestraße 12, 80333 Munich, Germany",
};

function context(overrides: Partial<DraftGroundingContext> = {}): DraftGroundingContext {
  return {
    jurisdiction: "US",
    language: "en",
    sender: SENDER,
    knowledge: {
      claims: [
        { id: "claim-iso", status: "APPROVED" },
        { id: "claim-review", status: "NEEDS_REVIEW" },
      ],
      offerings: [
        { id: "off-laser", approved: true },
        { id: "off-draft", approved: false },
      ],
      evidenceUrls: ["https://seller.example/capabilities"],
    },
    ...overrides,
  };
}

function draft(overrides: Partial<OutreachDraft> = {}): OutreachDraft {
  return {
    subject: "Fiber laser cutting capacity for your fabrication lines",
    body: "Hello, we supply fiber laser cutting systems and would like to discuss your Q1 sourcing plans.",
    language: "en",
    groundedOn: [{ claimId: "claim-iso" }, { offeringId: "off-laser" }],
    jurisdictionFooter:
      "Nordwind Maschinenbau GmbH, Industriestraße 12, 80333 Munich, Germany. Unsubscribe: reply STOP.",
    ...overrides,
  };
}

describe("prepareDraftGrounding", () => {
  it("passes with at least one approved claim", () => {
    expect(prepareDraftGrounding(context())).toEqual({ ok: true, issues: [] });
  });

  it("refuses to draft without approved claims or offerings (GROUNDING_REQUIRED)", () => {
    const result = prepareDraftGrounding(
      context({
        knowledge: {
          claims: [{ id: "claim-review", status: "NEEDS_REVIEW" }],
          offerings: [{ id: "off-draft", approved: false }],
          evidenceUrls: [],
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(draftViolationCodes(result)).toEqual(["GROUNDING_REQUIRED"]);
  });

  it("rejects jurisdictions without a footer policy", () => {
    const result = prepareDraftGrounding(context({ jurisdiction: "FR" }));
    expect(draftViolationCodes(result)).toEqual(["UNSUPPORTED_JURISDICTION"]);
  });

  it("requires en for US recipients and allows de or en for DE", () => {
    expect(draftViolationCodes(prepareDraftGrounding(context({ language: "de" })))).toEqual([
      "LANGUAGE_MISMATCH",
    ]);
    expect(
      prepareDraftGrounding(context({ jurisdiction: "DE", language: "de" })).ok,
    ).toBe(true);
    expect(
      prepareDraftGrounding(context({ jurisdiction: "DE", language: "en" })).ok,
    ).toBe(true);
  });
});

describe("validateOutreachDraft", () => {
  it("accepts a compliant US draft", () => {
    expect(validateOutreachDraft(draft(), context())).toEqual({ ok: true, issues: [] });
  });

  it("short-circuits with GROUNDING_REQUIRED when nothing is approved", () => {
    const result = validateOutreachDraft(
      draft(),
      context({
        knowledge: { claims: [], offerings: [], evidenceUrls: [] },
      }),
    );
    expect(draftViolationCodes(result)).toEqual(["GROUNDING_REQUIRED"]);
  });

  it("flags unknown and non-approved groundedOn references in input order", () => {
    const result = validateOutreachDraft(
      draft({ groundedOn: [{ claimId: "claim-review" }, { claimId: "claim-missing" }] }),
      context(),
    );
    expect(draftViolationCodes(result)).toEqual([
      "GROUNDING_REF_NOT_APPROVED",
      "GROUNDING_REF_UNKNOWN",
    ]);
  });

  it("rejects an empty groundedOn array", () => {
    expect(draftViolationCodes(validateOutreachDraft(draft({ groundedOn: [] }), context()))).toEqual([
      "GROUNDING_REQUIRED",
    ]);
  });

  it("rejects unapproved evidence URLs and unapproved offerings", () => {
    const result = validateOutreachDraft(
      draft({
        groundedOn: [
          { evidenceUrl: "https://elsewhere.example/blog" },
          { offeringId: "off-draft" },
        ],
      }),
      context(),
    );
    expect(draftViolationCodes(result)).toEqual([
      "GROUNDING_REF_NOT_APPROVED",
      "GROUNDING_REF_NOT_APPROVED",
    ]);
  });

  it("requires sender identity, postal address and US unsubscribe in the footer", () => {
    const missingIdentity = validateOutreachDraft(
      draft({ jurisdictionFooter: "Unsubscribe: reply STOP." }),
      context(),
    );
    expect(draftViolationCodes(missingIdentity)).toEqual(["FOOTER_MISSING_ELEMENTS"]);

    const missingExit = validateOutreachDraft(
      draft({ jurisdictionFooter: `${SENDER.legalName}, ${SENDER.postalAddress}.` }),
      context(),
    );
    expect(draftViolationCodes(missingExit)).toEqual(["FOOTER_MISSING_ELEMENTS"]);
  });

  it("requires German withdrawal wording in DE footers", () => {
    const deContext = context({ jurisdiction: "DE", language: "de" });
    const unsubscribeOnly = validateOutreachDraft(
      draft({
        language: "de",
        jurisdictionFooter: `${SENDER.legalName}, ${SENDER.postalAddress}. Unsubscribe: reply STOP.`,
      }),
      deContext,
    );
    expect(draftViolationCodes(unsubscribeOnly)).toEqual(["FOOTER_MISSING_ELEMENTS"]);

    const withWiderruf = validateOutreachDraft(
      draft({
        language: "de",
        jurisdictionFooter: `${SENDER.legalName}, ${SENDER.postalAddress}. Widerruf jederzeit möglich: reply STOP.`,
      }),
      deContext,
    );
    expect(withWiderruf).toEqual({ ok: true, issues: [] });
  });

  it("enforces subject and body length limits in characters", () => {
    const result = validateOutreachDraft(
      draft({ subject: "x".repeat(91), body: "y".repeat(2001) }),
      context(),
    );
    expect(draftViolationCodes(result)).toEqual(["SUBJECT_TOO_LONG", "BODY_TOO_LONG"]);
  });

  it("rejects language mismatch against the recipient evidence", () => {
    expect(
      draftViolationCodes(validateOutreachDraft(draft({ language: "de" }), context())),
    ).toEqual(["LANGUAGE_MISMATCH"]);
  });

  it("rejects absolute/exaggerated phrasing in subject or body", () => {
    for (const phrase of DRAFT_FORBIDDEN_PHRASES) {
      const result = validateOutreachDraft(
        draft({ body: `We are ${phrase} the right partner.` }),
        context(),
      );
      expect(draftViolationCodes(result), phrase).toEqual(["EXAGGERATION_FORBIDDEN"]);
    }
  });

  it("rejects steps[] content that diverges from the top-level draft (v0 single-step)", () => {
    const divergent = validateOutreachDraft(
      draft({
        steps: [{ subject: "Cutting systems", body: "Guaranteed results — ISO 9001 certified" }],
      }),
      context(),
    );
    // 夸大扫描覆盖 steps 文本，且与顶层不一致本身也拒。
    expect(draftViolationCodes(divergent)).toEqual([
      "EXAGGERATION_FORBIDDEN",
      "STEPS_INCONSISTENT",
    ]);

    const mirrored = validateOutreachDraft(
      draft({ steps: [{ subject: draft().subject, body: draft().body }] }),
      context(),
    );
    expect(mirrored).toEqual({ ok: true, issues: [] });
  });

  it("collects multiple independent issues deterministically", () => {
    const result = validateOutreachDraft(
      draft({
        language: "de",
        body: "Guaranteed results.",
        groundedOn: [],
        jurisdictionFooter: "footer without required elements",
      }),
      context(),
    );
    expect(draftViolationCodes(result)).toEqual([
      "EXAGGERATION_FORBIDDEN",
      "LANGUAGE_MISMATCH",
      "GROUNDING_REQUIRED",
      "FOOTER_MISSING_ELEMENTS",
    ]);
  });
});
