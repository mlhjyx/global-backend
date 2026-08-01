import { describe, expect, it } from "vitest";

import { DESIGN_SPEC_TASK } from "../design/design-brief-producer";
import { STATIC_DESIGN_CATALOG_V2 } from "../design/catalog";
import {
  DESIGN_SPEC_EVAL_FIXTURES,
  designSpecFixtureFingerprint,
  evaluateDesignSpecOutput,
  prepareDesignSpecEvalFixture,
} from "./design-spec-eval";

describe("design_spec canonical evaluation fixtures", () => {
  it("freezes six sparse/rich catalog families with three legal candidates", () => {
    expect(DESIGN_SPEC_EVAL_FIXTURES).toHaveLength(12);
    expect(
      new Set(DESIGN_SPEC_EVAL_FIXTURES.map(({ fixtureId }) => fixtureId)),
    ).toHaveLength(12);
    expect(
      DESIGN_SPEC_EVAL_FIXTURES.filter(({ mode }) => mode === "sparse"),
    ).toHaveLength(6);
    expect(
      DESIGN_SPEC_EVAL_FIXTURES.filter(({ mode }) => mode === "rich"),
    ).toHaveLength(6);
    expect(
      new Set(DESIGN_SPEC_EVAL_FIXTURES.map(({ familyId }) => familyId)),
    ).toEqual(new Set(STATIC_DESIGN_CATALOG_V2.families.map(({ id }) => id)));

    for (const fixture of DESIGN_SPEC_EVAL_FIXTURES) {
      expect(Object.isFrozen(fixture)).toBe(true);
      expect(Object.isFrozen(fixture.input)).toBe(true);
      expect(Object.isFrozen(fixture.input.candidates[0])).toBe(true);
      const prepared = prepareDesignSpecEvalFixture(fixture);
      expect(prepared.input.candidates).toHaveLength(3);
      expect(prepared.input.candidates[0]!.familyId).toBe(fixture.familyId);
      expect(fixture.assertions.deterministicCandidateId).toBe(
        prepared.input.candidates[0]!.id,
      );
      expect(() =>
        DESIGN_SPEC_TASK.validateOutput?.(prepared.input, {
          candidateId: fixture.assertions.deterministicCandidateId,
          reasons: [],
          warnings: [],
        }),
      ).not.toThrow();
      expect(designSpecFixtureFingerprint(fixture)).toEqual({
        fixtureSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    }
  });

  it("accepts the deterministic baseline with closed explanation claims", () => {
    const fixture = DESIGN_SPEC_EVAL_FIXTURES[0]!;
    const prepared = prepareDesignSpecEvalFixture(fixture);
    const selected = prepared.input.candidates[0]!;
    expect(
      evaluateDesignSpecOutput(prepared, {
        candidateId: selected.id,
        reasons: [
          `selectedCandidateId=${selected.id}`,
          `industryMatchCount=${selected.industryMatchCount}`,
        ],
        warnings: [],
      }),
    ).toEqual({
      selectedDeterministicCandidate: true,
      referencedForbiddenCatalogIdentifiers: [],
      contradictedMetricClaims: [],
      invalidExplanationClaims: [],
    });
  });

  it("rejects invented candidate ids before evaluation", () => {
    const prepared = prepareDesignSpecEvalFixture(
      DESIGN_SPEC_EVAL_FIXTURES[0]!,
    );
    expect(() =>
      evaluateDesignSpecOutput(prepared, {
        candidateId: "invented-candidate",
        reasons: [],
        warnings: [],
      }),
    ).toThrow("design_spec output must select one frozen candidate id");
  });

  it("keeps final assessment bound to the captured production validator", () => {
    const prepared = prepareDesignSpecEvalFixture(
      DESIGN_SPEC_EVAL_FIXTURES[0]!,
    );
    const originalValidator = DESIGN_SPEC_TASK.validateOutput;
    DESIGN_SPEC_TASK.validateOutput = () => undefined;
    try {
      expect(() =>
        evaluateDesignSpecOutput(prepared, {
          candidateId: "invented-candidate",
          reasons: [],
          warnings: [],
        }),
      ).toThrow("design_spec output must select one frozen candidate id");
    } finally {
      DESIGN_SPEC_TASK.validateOutput = originalValidator;
    }
  });

  it("flags unselected catalog references and contradictory metrics", () => {
    const fixture = DESIGN_SPEC_EVAL_FIXTURES[0]!;
    const prepared = prepareDesignSpecEvalFixture(fixture);
    const selected = prepared.input.candidates[0]!;
    const unselected = prepared.input.candidates[1]!;
    expect(
      evaluateDesignSpecOutput(prepared, {
        candidateId: selected.id,
        reasons: [
          `selectedCandidateId=${unselected.id}`,
          `industryMatchCount=${selected.industryMatchCount + 1}`,
        ],
        warnings: [],
      }),
    ).toEqual({
      selectedDeterministicCandidate: true,
      referencedForbiddenCatalogIdentifiers: [unselected.id],
      contradictedMetricClaims: ["industryMatchCount"],
      invalidExplanationClaims: [],
    });
  });

  it("rejects free-form prose without classifying ordinary hyphens as catalog ids", () => {
    const fixture = DESIGN_SPEC_EVAL_FIXTURES[0]!;
    const prepared = prepareDesignSpecEvalFixture(fixture);
    const selected = prepared.input.candidates[0]!;
    expect(
      evaluateDesignSpecOutput(prepared, {
        candidateId: selected.id,
        reasons: [
          "B2B-ready launch date 2026-08-01",
          "industryMatchCount is 999",
        ],
        warnings: [],
      }),
    ).toEqual({
      selectedDeterministicCandidate: true,
      referencedForbiddenCatalogIdentifiers: [],
      contradictedMetricClaims: [],
      invalidExplanationClaims: [
        "B2B-ready launch date 2026-08-01",
        "industryMatchCount is 999",
      ],
    });
  });

  it("flags any contradictory repeated metric claim", () => {
    const fixture = DESIGN_SPEC_EVAL_FIXTURES[0]!;
    const prepared = prepareDesignSpecEvalFixture(fixture);
    const selected = prepared.input.candidates[0]!;
    expect(
      evaluateDesignSpecOutput(prepared, {
        candidateId: selected.id,
        reasons: [
          `industryMatchCount=${selected.industryMatchCount}`,
          `industryMatchCount=${selected.industryMatchCount + 999}`,
        ],
        warnings: [],
      }),
    ).toMatchObject({
      referencedForbiddenCatalogIdentifiers: [],
      contradictedMetricClaims: ["industryMatchCount"],
      invalidExplanationClaims: [],
    });
  });
});
