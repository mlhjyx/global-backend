import { describe, expect, it } from "vitest";

import {
  COPY_ASSEMBLY_EVAL_FIXTURES,
  evaluateCopyAssemblyOutput,
  prepareCopyAssemblyEvalFixture,
} from "./copy-assembly-eval";

describe("copy and controlled-assembly canonical evaluation fixtures", () => {
  it("rebuilds copy fixtures through the frozen Claim and slot contracts", () => {
    const fixtures = COPY_ASSEMBLY_EVAL_FIXTURES.filter(
      (fixture) => fixture.taskId === "site_builder.copy",
    );
    expect(fixtures).toHaveLength(6);

    for (const fixture of fixtures) {
      const prepared = prepareCopyAssemblyEvalFixture(fixture);
      expect(prepared.input).toEqual(fixture.input);
      expect(
        evaluateCopyAssemblyOutput(prepared, fixture.expectedOutput),
      ).toMatchObject({
        exactCanonicalOutput: true,
        hardGatePassed: true,
        creativeContentPreserved: true,
        productionValidationPassed: true,
      });
    }
  });

  it("accepts safe creative variation without exact-gold overfitting", () => {
    const fixture = COPY_ASSEMBLY_EVAL_FIXTURES.find(
      (entry) => entry.fixtureId === "copy-brand-voice-en",
    );
    expect(fixture).toBeDefined();
    const prepared = prepareCopyAssemblyEvalFixture(fixture!);
    expect(
      evaluateCopyAssemblyOutput(prepared, {
        slots: {
          "home.hero.summary": {
            content: "Clear thinking for complex sourcing",
            claimRefs: [],
          },
        },
      }),
    ).toMatchObject({
      exactCanonicalOutput: true,
      hardGatePassed: true,
      creativeContentPreserved: true,
    });
  });

  it("covers factual, cross-locale, assertion, voice, and CTA contracts", () => {
    expect(
      COPY_ASSEMBLY_EVAL_FIXTURES.map((fixture) => fixture.fixtureId),
    ).toEqual([
      "copy-factual-claims",
      "copy-factual-cross-locale",
      "copy-unsupported-assertion",
      "copy-brand-voice-en",
      "copy-brand-voice-cross-locale",
      "copy-cta-budget",
    ]);
  });

  it("rejects copy outputs whose canonical Claim result changes", () => {
    const fixture = COPY_ASSEMBLY_EVAL_FIXTURES.find(
      (entry) => entry.fixtureId === "copy-factual-claims",
    );
    expect(fixture).toBeDefined();
    const prepared = prepareCopyAssemblyEvalFixture(fixture!);
    expect(() =>
      evaluateCopyAssemblyOutput(prepared, {
        slots: Object.fromEntries(
          Object.entries(fixture!.expectedOutput.slots).map(([key, value]) => [
            key,
            { ...value, claimRefs: [] },
          ]),
        ),
      }),
    ).toThrow("COPY_DETERMINISTIC_SLOT_VIOLATION");
  });

  it("rejects an invented Claim reference rather than silently dropping it", () => {
    const fixture = COPY_ASSEMBLY_EVAL_FIXTURES.find(
      (entry) => entry.fixtureId === "copy-factual-claims",
    );
    expect(fixture).toBeDefined();
    const prepared = prepareCopyAssemblyEvalFixture(fixture!);
    const output = structuredClone(fixture!.expectedOutput);
    output.slots["home.hero.headline"]!.claimRefs = [
      "claim-pressure",
      "invented-claim",
    ];
    expect(() => evaluateCopyAssemblyOutput(prepared, output)).toThrow(
      "COPY_CLAIM_REF_UNKNOWN",
    );
  });

  it("rejects the unsupported-assertion adversarial output", () => {
    const fixture = COPY_ASSEMBLY_EVAL_FIXTURES.find(
      (entry) => entry.fixtureId === "copy-unsupported-assertion",
    );
    expect(fixture).toBeDefined();
    const prepared = prepareCopyAssemblyEvalFixture(fixture!);
    expect(() =>
      evaluateCopyAssemblyOutput(prepared, {
        slots: {
          "home.hero.headline": {
            content: "Market-leading systems trusted in 40 countries",
            claimRefs: [],
          },
        },
      }),
    ).toThrow("COPY_UNSUPPORTED_ASSERTION");
  });
});
