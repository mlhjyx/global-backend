import { describe, expect, it } from "vitest";
import { diffPlanLeaves } from "./golden-diff";

describe("diffPlanLeaves", () => {
  it("reports added, removed and changed leaf paths", () => {
    const baseline = {
      goal: { objective: "A", successMetric: "M" },
      motions: [{ type: "discovery", icpIds: ["x"] }],
      budget: { capMicros: 100, currency: "USD" },
    };
    const current = {
      goal: { objective: "B" },
      motions: [{ type: "discovery", icpIds: ["x", "y"] }],
      budget: { capMicros: 100, currency: "USD" },
      decisionPolicy: { maxReplans: 1 },
    };
    expect(diffPlanLeaves(baseline, current)).toEqual({
      added: ["decisionPolicy.maxReplans", "motions.0.icpIds.1"],
      removed: ["goal.successMetric"],
      changed: ["goal.objective"],
    });
  });

  it("treats empty containers as leaves and is order-insensitive", () => {
    const baseline = { schedule: {}, filters: [] };
    const current = { schedule: {}, filters: [], extra: { a: 1 } };
    expect(diffPlanLeaves(baseline, current)).toEqual({
      added: ["extra.a"],
      removed: [],
      changed: [],
    });
  });

  it("returns an empty diff for identical plans", () => {
    const plan = { a: 1, b: [1, 2], c: { d: "x" } };
    expect(diffPlanLeaves(plan, JSON.parse(JSON.stringify(plan)))).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
  });
});
