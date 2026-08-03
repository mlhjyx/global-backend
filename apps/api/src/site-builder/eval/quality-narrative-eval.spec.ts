import { describe, expect, it } from "vitest";

import {
  QUALITY_NARRATIVE_EVAL_FIXTURES,
  evaluateQualityNarrativeOutput,
  prepareQualityNarrativeEvalFixture,
  type QualityNarrativeEvalFixture,
} from "./quality-narrative-eval";
import {
  deterministicQualityNarrativeOutput,
  type QualityNarrativeTaskOutputV1,
} from "../quality/quality-narrative";

describe("quality narrative canonical evaluation fixtures", () => {
  it("rebuilds closed QA and SEO task inputs only through production contracts", () => {
    expect(QUALITY_NARRATIVE_EVAL_FIXTURES).toHaveLength(4);
    expect(
      QUALITY_NARRATIVE_EVAL_FIXTURES.map((fixture) => fixture.fixtureId),
    ).toEqual([
      "qa-multigroup",
      "qa-ordering",
      "seo-full-rule-matrix",
      "seo-multilocale-reports",
    ]);

    for (const fixture of QUALITY_NARRATIVE_EVAL_FIXTURES) {
      const prepared = prepareQualityNarrativeEvalFixture(fixture);
      expect(prepared.input.taskId).toBe(fixture.taskId);
      expect(prepared.input.findings.length).toBeGreaterThan(0);
      expect(prepared.input.seoReports).toHaveLength(
        fixture.taskId === "site_builder.seo_review"
          ? fixture.seoReports.length
          : 0,
      );
    }
  });

  it("accepts only the exact deterministic closed output", () => {
    for (const fixture of QUALITY_NARRATIVE_EVAL_FIXTURES) {
      const prepared = prepareQualityNarrativeEvalFixture(fixture);
      const output = deterministicQualityNarrativeOutput(prepared.input);
      expect(evaluateQualityNarrativeOutput(prepared, output)).toEqual({
        exactDeterministicOutput: true,
        rejectedFindingIds: [],
      });

      const reordered: QualityNarrativeTaskOutputV1 = {
        groups: [...output.groups].reverse(),
      };
      expect(evaluateQualityNarrativeOutput(prepared, reordered)).toEqual({
        exactDeterministicOutput: false,
        rejectedFindingIds: [],
      });
    }
  });

  it("fails closed when QA/SEO fixture report boundaries drift", () => {
    const qaFixture = QUALITY_NARRATIVE_EVAL_FIXTURES.find(
      (fixture) => fixture.taskId === "site_builder.qa_summarize",
    );
    const seoFixture = QUALITY_NARRATIVE_EVAL_FIXTURES.find(
      (fixture) => fixture.taskId === "site_builder.seo_review",
    );
    expect(qaFixture).toBeDefined();
    expect(seoFixture).toBeDefined();

    const qaWithSeoReport: QualityNarrativeEvalFixture = {
      ...qaFixture!,
      seoReports: [...seoFixture!.seoReports.slice(0, 1)],
    };
    expect(() => prepareQualityNarrativeEvalFixture(qaWithSeoReport)).toThrow(
      "QA fixture must not include SEO reports",
    );

    const seoWithWrongDigest: QualityNarrativeEvalFixture = {
      ...seoFixture!,
      seoReports: seoFixture!.seoReports.map((report, index) =>
        index === 0 ? { ...report, sha256: "0".repeat(64) } : { ...report },
      ),
    };
    expect(() =>
      prepareQualityNarrativeEvalFixture(seoWithWrongDigest),
    ).toThrow("SEO report is not artifact-bound");
  });
});
