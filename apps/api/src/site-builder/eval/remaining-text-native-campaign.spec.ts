import { describe, expect, it } from "vitest";

import {
  buildRemainingTextNativeCampaignExecutions,
  type RemainingTextNativeCampaignTaskId,
} from "./remaining-text-native-campaign";

const campaignId = "123e4567-e89b-42d3-a456-426614174000";
const cases = [
  ["site_builder.copy", 13, 1],
  ["site_builder.assemble", 48, 0],
  ["site_builder.assembly_fix", 48, 0],
  ["site_builder.qa_summarize", 12, 0],
  ["site_builder.seo_review", 12, 0],
] as const;

describe("remaining text native campaign", () => {
  it.each(cases)(
    "freezes the exact manifest matrix for %s",
    (taskId, executionCount, probeCount) => {
      const executions = buildRemainingTextNativeCampaignExecutions({
        campaignId,
        taskId,
      });

      expect(executions).toHaveLength(executionCount);
      expect(executions.filter(({ phase }) => phase === "probe")).toHaveLength(
        probeCount,
      );
      expect(
        new Set(executions.map(({ executionId }) => executionId)).size,
      ).toBe(executionCount);
      expect(executions.every((execution) => execution.taskId === taskId)).toBe(
        true,
      );
      expect(Object.isFrozen(executions)).toBe(true);
      expect(executions.every(Object.isFrozen)).toBe(true);
    },
  );

  it("places the copy capability probe before its target matrix", () => {
    const executions = buildRemainingTextNativeCampaignExecutions({
      campaignId,
      taskId: "site_builder.copy",
    });

    expect(executions[0]).toMatchObject({
      phase: "probe",
      alias: "gpt-5.5",
      protocol: "openai-responses",
      attempt: 1,
    });
    expect(executions.slice(1).every(({ phase }) => phase === "matrix")).toBe(
      true,
    );
  });

  it("rejects a non-canonical campaign id or task before planning", () => {
    expect(() =>
      buildRemainingTextNativeCampaignExecutions({
        campaignId: "not-a-campaign",
        taskId: "site_builder.copy",
      }),
    ).toThrow("remaining text native campaign input is invalid");
    expect(() =>
      buildRemainingTextNativeCampaignExecutions({
        campaignId,
        taskId: "site_builder.design_spec" as RemainingTextNativeCampaignTaskId,
      }),
    ).toThrow("remaining text native campaign input is invalid");
  });
});
