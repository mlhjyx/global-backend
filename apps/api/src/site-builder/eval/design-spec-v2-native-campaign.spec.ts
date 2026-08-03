import { describe, expect, it } from "vitest";

import { buildTaskEvaluationPlan } from "./model-evaluation-harness";
import {
  buildDesignSpecV2NativeCampaignExecutions,
  runDesignSpecV2NativeCampaign,
  type DesignSpecV2NativeCampaignRunner,
} from "./design-spec-v2-native-campaign";

describe("design_spec v2 native campaign", () => {
  it("builds the exact 73-entry canonical plan with the GPT-5.5 probe first", () => {
    const campaignId = "8b0ee1a5-58b5-4e51-a84e-698ebd7ecbd6";
    const executions = buildDesignSpecV2NativeCampaignExecutions({
      campaignId,
    });
    const plan = buildTaskEvaluationPlan("site_builder.design_spec");

    expect(executions).toHaveLength(73);
    expect(executions[0]).toMatchObject({
      phase: "probe",
      alias: "gpt-5.5",
      fixtureId: plan.evaluationSuite!.fixtureIds[0],
      attempt: 1,
    });
    expect(executions.slice(1)).toHaveLength(72);
    expect(executions.filter((entry) => entry.phase === "probe")).toHaveLength(
      1,
    );
    expect(executions.filter((entry) => entry.phase === "matrix")).toHaveLength(
      72,
    );
    expect(new Set(executions.map((entry) => entry.executionId)).size).toBe(73);
    expect(
      executions.every((entry) => entry.executionId.includes(campaignId)),
    ).toBe(true);
  });

  it("rejects an untrusted structural runner before any execution can start", async () => {
    const calls: Array<
      Parameters<DesignSpecV2NativeCampaignRunner["execute"]>[0]
    > = [];
    const runner: DesignSpecV2NativeCampaignRunner = {
      execute: async (input) => {
        calls.push(input);
        throw new Error("must not execute");
      },
      abort: () => undefined,
    };

    await expect(
      runDesignSpecV2NativeCampaign({
        campaignId: "8b0ee1a5-58b5-4e51-a84e-698ebd7ecbd6",
        runner,
      }),
    ).rejects.toThrow(
      "trusted native design_spec execution runner is required",
    );
    expect(calls).toHaveLength(0);
  });
});
