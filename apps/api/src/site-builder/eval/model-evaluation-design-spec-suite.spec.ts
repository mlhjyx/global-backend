import { describe, expect, it, vi } from "vitest";

import {
  ModelEvaluationBudgetGuard,
  assessCanonicalTaskArtifact,
  buildCanonicalModelEvaluationCase,
  buildTaskEvaluationPlan,
  runLegacyComparatorEvaluationAttempt,
} from "./model-evaluation-harness";

describe("design_spec canonical model evaluation suite", () => {
  it("admits exactly three structured candidates over twelve repeated fixtures", () => {
    const plan = buildTaskEvaluationPlan("site_builder.design_spec");
    expect(plan).toMatchObject({
      taskId: "site_builder.design_spec",
      profile: "structured.default",
      dispatchAdmission: "task_evaluation_ready",
      candidates: [
        {
          alias: "gpt-5.6-terra",
          expectedProtocol: "openai-responses",
          preflight: "none",
        },
        {
          alias: "gpt-5.5",
          expectedProtocol: "openai-responses",
          preflight: "capability_probe",
        },
        {
          alias: "claude-sonnet-5",
          expectedProtocol: "anthropic-messages",
          preflight: "none",
        },
      ],
      envelope: {
        perCallCostCapCents: 20,
      },
      evaluationSuite: {
        taskContractId: "site_builder.design_spec",
        repeats: 2,
        fixtureIds: expect.arrayContaining([
          "precision-industrial-rich",
          "precision-industrial-sparse",
          "technical-catalog-rich",
          "technical-catalog-sparse",
          "oem-capability-rich",
          "oem-capability-sparse",
          "scientific-trust-rich",
          "scientific-trust-sparse",
          "natural-origin-rich",
          "natural-origin-sparse",
          "premium-innovation-rich",
          "premium-innovation-sparse",
        ]),
      },
    });
    expect(plan.evaluationSuite?.fixtureIds).toHaveLength(12);
  });

  it("binds each synthetic case to the closed candidate input and tracked source bundle", () => {
    const plan = buildTaskEvaluationPlan("site_builder.design_spec");
    for (const fixtureId of plan.evaluationSuite!.fixtureIds) {
      const evaluationCase = buildCanonicalModelEvaluationCase(plan, fixtureId);
      expect(evaluationCase.contract.fixtureId).toBe(fixtureId);
      expect(evaluationCase.contract.sourceBundleSha256).toMatch(
        /^[a-f0-9]{64}$/,
      );
      expect(evaluationCase.payload.sourceFiles.length).toBeGreaterThan(20);
      expect(evaluationCase.payload.taskInput).toMatchObject({
        candidates: expect.any(Array),
      });
      const input = evaluationCase.payload.taskInput as {
        candidates: Array<{ id: string }>;
      };
      expect(input.candidates).toHaveLength(3);
      for (const candidate of input.candidates) {
        expect(evaluationCase.payload.prompt).toContain(candidate.id);
      }
      expect(Object.isFrozen(evaluationCase)).toBe(true);
      expect(Object.isFrozen(evaluationCase.payload)).toBe(true);
    }
  });

  it("grades only deterministic, closed-catalog selections as accepted", () => {
    const plan = buildTaskEvaluationPlan("site_builder.design_spec");
    const evaluationCase = buildCanonicalModelEvaluationCase(
      plan,
      "precision-industrial-rich",
    );
    const input = evaluationCase.payload.taskInput as {
      candidates: Array<{
        id: string;
        familyId: string;
        industryMatchCount: number;
      }>;
    };
    const selected = input.candidates[0]!;
    expect(
      assessCanonicalTaskArtifact(plan, evaluationCase.payload, {
        candidateId: selected.id,
        reasons: [
          `Selected ${selected.familyId}`,
          `industryMatchCount:${selected.industryMatchCount}`,
        ],
        warnings: [],
      }),
    ).toEqual({
      qualityPassed: true,
      structurePassed: true,
      factualityPassed: true,
      stabilityKey: selected.id,
      findingCodes: [],
    });

    const alternative = input.candidates[1]!;
    expect(
      assessCanonicalTaskArtifact(plan, evaluationCase.payload, {
        candidateId: alternative.id,
        reasons: [],
        warnings: [],
      }),
    ).toMatchObject({
      qualityPassed: false,
      structurePassed: true,
      factualityPassed: true,
      findingCodes: ["deterministic_catalog_baseline_mismatch"],
    });
  });

  it("rejects legacy model comparators before budget reservation or dispatch", async () => {
    const execute = vi.fn();
    const budget = new ModelEvaluationBudgetGuard(100);
    const before = budget.snapshot();
    await expect(
      runLegacyComparatorEvaluationAttempt({
        plan: buildTaskEvaluationPlan("site_builder.design_spec"),
        alias: "minimax-m3",
        fixtureId: "precision-industrial-rich",
        attempt: 1,
        campaignBudget: budget,
        executeLegacyComparator: execute,
      }),
    ).rejects.toMatchObject({
      failureCode: "legacy_comparator_not_admitted",
      costSettlement: {
        state: "not_incurred",
        reason: "rejected_before_dispatch",
      },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(budget.snapshot()).toEqual(before);
  });
});
