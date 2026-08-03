import { describe, expect, it } from "vitest";

import {
  assessCanonicalTaskArtifact,
  buildCanonicalModelEvaluationCase,
  buildTaskEvaluationPlan,
} from "./model-evaluation-harness";
import { CONTROLLED_ASSEMBLY_EVAL_FIXTURES } from "./controlled-assembly-eval";

describe("controlled assembly canonical model evaluation suites", () => {
  for (const taskId of [
    "site_builder.assemble",
    "site_builder.assembly_fix",
  ] as const) {
    it(`${taskId} binds all twelve M1-e-B golden fixtures to the production SiteSpec validator`, () => {
      const plan = buildTaskEvaluationPlan(taskId);
      expect(plan).toMatchObject({
        dispatchAdmission: "task_evaluation_ready",
        evaluationSuite: {
          taskContractId: taskId,
          repeats: 2,
          legacyComparatorAliases: [],
          fixtureIds: expect.any(Array),
        },
      });
      expect(plan.evaluationSuite!.fixtureIds).toHaveLength(12);

      for (const fixtureId of plan.evaluationSuite!.fixtureIds) {
        const evaluationCase = buildCanonicalModelEvaluationCase(
          plan,
          fixtureId,
        );
        expect(evaluationCase.payload.taskInput).toMatchObject({
          allowedSectionTargets: expect.arrayContaining([
            expect.objectContaining({ pageKey: expect.any(String) }),
          ]),
        });
        expect(evaluationCase.contract.sourceBundleSha256).toMatch(
          /^[a-f0-9]{64}$/,
        );
      }

      const firstFixture = CONTROLLED_ASSEMBLY_EVAL_FIXTURES.find(
        (entry) => entry.fixtureId === plan.evaluationSuite!.fixtureIds[0],
      )!;
      const firstCase = buildCanonicalModelEvaluationCase(
        plan,
        firstFixture.fixtureId,
      );
      expect(
        assessCanonicalTaskArtifact(
          plan,
          firstCase.payload,
          firstFixture.expectedOutput,
        ),
      ).toMatchObject({
        qualityPassed: true,
        structurePassed: true,
        factualityPassed: true,
        findingCodes: [],
      });
    });
  }

  it("keeps repair cases bound to a prior candidate digest and production findings", () => {
    const plan = buildTaskEvaluationPlan("site_builder.assembly_fix");
    const evaluationCase = buildCanonicalModelEvaluationCase(
      plan,
      plan.evaluationSuite!.fixtureIds[0]!,
    );
    const input = evaluationCase.payload.taskInput as {
      previousCandidateDigest?: string;
      findings: unknown[];
    };
    expect(input.previousCandidateDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(input.findings.length).toBeGreaterThan(0);
  });
});
