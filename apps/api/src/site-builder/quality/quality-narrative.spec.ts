import { describe, expect, it } from "vitest";
import {
  buildQualityNarrativeFindingIndex,
  deterministicQualityNarrativeOutput,
  partitionQualityNarrativeFindings,
  qualityNarrativeTaskInput,
  validateQualityNarrativeTaskOutput,
} from "./quality-narrative";
import { qualityNarrativeFixture } from "./quality-narrative.test-fixture";

describe("QualityNarrativeSetV1 closed contract", () => {
  it("partitions SEO-report findings from the wider deterministic QA set", () => {
    const fixture = qualityNarrativeFixture();
    const findings = buildQualityNarrativeFindingIndex(
      fixture.evaluation,
      fixture.artifactSet,
    );
    const partitioned = partitionQualityNarrativeFindings(findings);
    expect(partitioned.qa.map((finding) => finding.ruleCode)).toEqual([
      "OUTBOUND_REQUEST_FORBIDDEN",
    ]);
    expect(partitioned.seo.map((finding) => finding.ruleCode)).toEqual([
      "H1_COUNT_INVALID",
    ]);
  });

  it("accepts only exact finding/group/explanation IDs and no free prose", () => {
    const fixture = qualityNarrativeFixture();
    const findings = buildQualityNarrativeFindingIndex(
      fixture.evaluation,
      fixture.artifactSet,
    );
    const input = qualityNarrativeTaskInput(
      "site_builder.qa_summarize",
      fixture.evaluation,
      fixture.artifactSet,
      partitionQualityNarrativeFindings(findings).qa,
      [],
    );
    const output = deterministicQualityNarrativeOutput(input);
    expect(validateQualityNarrativeTaskOutput(input, output)).toEqual(output);
    expect(() =>
      validateQualityNarrativeTaskOutput(input, {
        groups: [
          {
            ...output.groups[0]!,
            findingIds: ["invented-finding"],
          },
        ],
      }),
    ).toThrow("QUALITY_NARRATIVE_OUTPUT_INVALID");
    expect(() =>
      validateQualityNarrativeTaskOutput(input, {
        ...output,
        summary: "invented prose",
      } as never),
    ).toThrow("QUALITY_NARRATIVE_OUTPUT_INVALID");
  });
});
