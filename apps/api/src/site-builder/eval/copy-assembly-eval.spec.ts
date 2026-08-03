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
    expect(fixtures).toHaveLength(2);

    for (const fixture of fixtures) {
      const prepared = prepareCopyAssemblyEvalFixture(fixture);
      expect(prepared.input).toEqual(fixture.input);
      expect(
        evaluateCopyAssemblyOutput(prepared, fixture.expectedOutput),
      ).toMatchObject({
        exactCanonicalOutput: true,
        productionValidationPassed: true,
      });
    }
  });

  it("rejects copy outputs whose canonical Claim result changes", () => {
    const fixture = COPY_ASSEMBLY_EVAL_FIXTURES.find(
      (entry) => entry.fixtureId === "copy-factual-claims",
    );
    expect(fixture).toBeDefined();
    const prepared = prepareCopyAssemblyEvalFixture(fixture!);
    expect(
      evaluateCopyAssemblyOutput(prepared, {
        slots: Object.fromEntries(
          Object.entries(fixture!.expectedOutput.slots).map(([key, value]) => [
            key,
            { ...value, claimRefs: [] },
          ]),
        ),
      }),
    ).toMatchObject({ exactCanonicalOutput: false });
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
    expect(evaluateCopyAssemblyOutput(prepared, output)).toMatchObject({
      exactCanonicalOutput: false,
      factualSlotContentMatches: false,
      rejectedSlotKeys: ["home.hero.headline"],
    });
  });
});
