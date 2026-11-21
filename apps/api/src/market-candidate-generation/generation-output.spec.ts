import { describe, expect, it } from "vitest";
import {
  generationOutputToDraft,
  validateGenerationOutput,
} from "./generation-output";
const C = "22222222-2222-4222-8222-222222222222",
  O = "33333333-3333-4333-8333-333333333333",
  K = "44444444-4444-4444-8444-444444444444";
const descriptors = {
  schemaVersion: "market-candidate-generation-basis/v1" as const,
  company: { companyId: C, version: 1 },
  sources: [
    {
      kind: "CLAIM" as const,
      key: `CLAIM:${K}`,
      sourceId: K,
      usedFieldsDigest: "a".repeat(64),
      version: 1,
      status: "APPROVED",
    },
    {
      kind: "OFFERING" as const,
      key: `OFFERING:${O}`,
      sourceId: O,
      usedFieldsDigest: "b".repeat(64),
      version: null,
      status: null,
    },
  ],
};
function statement() {
  return {
    text: "Conditional hypothesis",
    knowledgeState: "INFERENCE",
    basisKeys: [`CLAIM:${K}`],
    impact: "Needs verification",
  };
}
function result() {
  return {
    outcome: "CANDIDATES_PROPOSED",
    candidates: [
      {
        proposal: {
          supplyOrCapability: {
            offeringId: O,
            description: "Conditional supply",
          },
          buyerOrganizationCountry: null,
          projectCountry: null,
          application: statement(),
          organizationRole: statement(),
          fitExplanation: statement(),
          entryConditions: [statement()],
          support: [],
          counterEvidence: [{ ...statement(), knowledgeState: "CONFLICT" }],
          gaps: [{ ...statement(), knowledgeState: "UNKNOWN" }],
          recommendation: {
            status: "CONDITIONAL",
            reason: "Evidence required",
          },
          nextVerification: ["Verify current capacity"],
        },
      },
    ],
  };
}

describe("complete generation output is a hypothesis, never an imported fact or silently filtered partial result", () => {
  it("preserves null countries, counter-evidence, gaps, conditions and candidate order", () => {
    const input = result(),
      before = structuredClone(input);
    const parsed = validateGenerationOutput(input, descriptors);
    expect(parsed).toEqual(before);
    expect(input).toEqual(before);
    const draft = generationOutputToDraft(parsed, descriptors);
    expect(draft).toEqual({
      generationOutcome: "CANDIDATES_PROPOSED",
      sources: [
        { kind: "CLAIM", sourceId: K },
        { kind: "OFFERING", sourceId: O },
      ],
      candidates: before.candidates,
    });
  });
  it("accepts an explicit empty result only with its matching outcome, not a manufactured reason", () => {
    expect(
      validateGenerationOutput(
        { outcome: "COMPLETED_EMPTY", candidates: [] },
        descriptors,
      ),
    ).toEqual({ outcome: "COMPLETED_EMPTY", candidates: [] });
    expect(() =>
      validateGenerationOutput(
        { outcome: "CANDIDATES_PROPOSED", candidates: [] },
        descriptors,
      ),
    ).toThrow();
    expect(() =>
      validateGenerationOutput(
        { ...result(), outcome: "COMPLETED_EMPTY" },
        descriptors,
      ),
    ).toThrow();
  });
  it.each([
    "candidateId",
    "actor",
    "revision",
    "feedback",
    "verified",
    "buyerCompany",
    "personalEmail",
  ])("refuses model-controlled authority or buyer field %s", (field) => {
    const input = result();
    Object.assign(input.candidates[0], { [field]: "fake" });
    expect(() => validateGenerationOutput(input, descriptors)).toThrow();
  });
  it("rejects a forged source or unselected offering and does not discard only the bad card", () => {
    const input = result(),
      bad = structuredClone(input.candidates[0]);
    bad.proposal.supplyOrCapability.offeringId =
      "99999999-9999-4999-8999-999999999999";
    input.candidates.push(bad);
    expect(() => validateGenerationOutput(input, descriptors)).toThrow();
    const source = result();
    source.candidates[0].proposal.support.push({
      ...statement(),
      basisKeys: ["CLAIM:99999999-9999-4999-8999-999999999999"],
    });
    expect(() => validateGenerationOutput(source, descriptors)).toThrow();
  });
  it("does not let the model promote a statement to REVIEWED_SOURCE_FACT", () => {
    const input = result();
    input.candidates[0].proposal.application.knowledgeState =
      "REVIEWED_SOURCE_FACT";
    expect(() => validateGenerationOutput(input, descriptors)).toThrow();
  });
  it("keeps legal negative recommendations and unknown combinations rather than ranking or suppressing them", () => {
    const input = result();
    input.candidates[0].proposal.recommendation = {
      status: "NOT_RECOMMENDED",
      reason: "Counter-evidence remains",
    };
    expect(
      validateGenerationOutput(input, descriptors).candidates[0].proposal
        .recommendation.status,
    ).toBe("NOT_RECOMMENDED");
  });
  it("rejects 101 cards as one invalid complete result", () => {
    const input = result();
    input.candidates = Array.from({ length: 101 }, () =>
      structuredClone(input.candidates[0]),
    );
    expect(() => validateGenerationOutput(input, descriptors)).toThrow();
  });
  it("enforces the exact 65536-byte UTF8 serialized-output boundary including JSON wrapping", () => {
    const input = result();
    input.candidates[0].proposal.nextVerification = [];
    while (Buffer.byteLength(JSON.stringify(input), "utf8") + 2003 < 65536)
      input.candidates[0].proposal.nextVerification.push("a".repeat(2000));
    input.candidates[0].proposal.nextVerification.push("");
    const missing = 65536 - Buffer.byteLength(JSON.stringify(input), "utf8");
    input.candidates[0].proposal.nextVerification[
      input.candidates[0].proposal.nextVerification.length - 1
    ] = "a".repeat(missing);
    expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBe(65536);
    expect(validateGenerationOutput(input, descriptors)).toEqual(input);
    input.candidates[0].proposal.nextVerification[
      input.candidates[0].proposal.nextVerification.length - 1
    ] += "a";
    expect(() => validateGenerationOutput(input, descriptors)).toThrow();
  });
  it("counts Chinese bytes rather than string length and rejects refusal or raw malformed JSON as empty success", () => {
    const input = result();
    input.candidates[0].proposal.nextVerification = Array(20).fill(
      "中".repeat(2000),
    );
    expect(() => validateGenerationOutput(input, descriptors)).toThrow();
    expect(() =>
      validateGenerationOutput({ refusal: "no" }, descriptors),
    ).toThrow();
    expect(() => validateGenerationOutput("{bad-json", descriptors)).toThrow();
  });
});
