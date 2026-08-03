import { describe, expect, it } from "vitest";

import {
  CONTROLLED_ASSEMBLY_EVAL_FIXTURES,
  evaluateControlledAssemblyOutput,
  prepareControlledAssemblyEvalFixture,
} from "./controlled-assembly-eval";

describe("controlled assembly canonical evaluation fixtures", () => {
  it("rebuilds every M1-e-B golden sparse/rich input and samples each task through the production validator", () => {
    expect(CONTROLLED_ASSEMBLY_EVAL_FIXTURES).toHaveLength(24);
    for (const fixture of CONTROLLED_ASSEMBLY_EVAL_FIXTURES) {
      const prepared = prepareControlledAssemblyEvalFixture(fixture);
      expect(prepared.fixture.expectedOutput.sections.length).toBeGreaterThan(0);
    }
    for (const taskId of [
      "site_builder.assemble",
      "site_builder.assembly_fix",
    ] as const) {
      const fixture = CONTROLLED_ASSEMBLY_EVAL_FIXTURES.find(
        (candidate) => candidate.taskId === taskId,
      )!;
      const prepared = prepareControlledAssemblyEvalFixture(fixture);
      expect(
        evaluateControlledAssemblyOutput(prepared, fixture.expectedOutput),
      ).toMatchObject({
        semanticAssemblyPassed: true,
        productionValidationPassed: true,
        explicitSelectionPassed: true,
      });
    }
  });

  it("rejects a server-fallback empty selection because it omits frozen model targets", () => {
    const fixture = CONTROLLED_ASSEMBLY_EVAL_FIXTURES[0]!;
    const prepared = prepareControlledAssemblyEvalFixture(fixture);
    expect(() =>
      evaluateControlledAssemblyOutput(prepared, { sections: [] }),
    ).toThrow("CONTROLLED_ASSEMBLY_MODEL_OUTPUT_INVALID");
  });

  it("rejects a selection outside the frozen page/section bounds", () => {
    const fixture = CONTROLLED_ASSEMBLY_EVAL_FIXTURES[0]!;
    const prepared = prepareControlledAssemblyEvalFixture(fixture);
    expect(() =>
      evaluateControlledAssemblyOutput(prepared, {
        sections: [
          {
            pageKey: "invented",
            sectionId: "invented",
            copySlotKeys: [],
            assetReferenceIds: [],
            claimIds: [],
            itemIndexes: [],
          },
        ],
      }),
    ).toThrow("CONTROLLED_ASSEMBLY_MODEL_OUTPUT_INVALID");
  });
});
