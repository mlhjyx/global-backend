import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadGoldenBriefs, type GoldenBriefAsset } from "./golden-brief";
import { evaluateGoldenPlan } from "./golden-evaluate";

/**
 * Golden 断言层 + 变异测试（设计 §7-3）：改坏产出或改坏期望都必须判红——
 * 鉴别力不足的 golden 门等于没有门。
 */
const ASSETS_DIR = join(import.meta.dirname, "../../../../evals/golden-campaign-briefs");
const { assets } = loadGoldenBriefs(ASSETS_DIR);
const SAMPLE = assets.find((asset) => asset.id === "01-de-thermoforming-medical") as GoldenBriefAsset;

function validPlan(asset: GoldenBriefAsset): Record<string, unknown> {
  return {
    schemaVersion: "campaign-plan/v0",
    goal: { objective: asset.brief.objective },
    audience: {
      icpIds: ["11111111-1111-4111-8111-111111111111"],
      sizeCap: 200,
    },
    motions: [
      { type: "discovery", icpIds: ["11111111-1111-4111-8111-111111111111"] },
    ],
    budget: { capMicros: 1_000_000, currency: "USD" },
    approvalPolicy: { required: true },
    decisionPolicy: { maxReplans: 0 },
  };
}

function failedNames(asset: GoldenBriefAsset, plan: unknown): string[] {
  return evaluateGoldenPlan(asset, plan)
    .checks.filter((check) => !check.ok)
    .map((check) => check.name);
}

describe("evaluateGoldenPlan", () => {
  it("passes a contract-shaped plan for every shipped brief", () => {
    for (const asset of assets) {
      const evaluation = evaluateGoldenPlan(asset, validPlan(asset));
      const failed = evaluation.checks.filter((check) => !check.ok);
      expect(failed, asset.id).toEqual([]);
      expect(evaluation.passed, asset.id).toBe(true);
      expect(evaluation.checks.map((check) => check.name)).toEqual([
        "plan_schema_version",
        "required_fields",
        "forbidden_fields",
        "forbidden_content",
        "budget_respect",
        "decision_policy",
        "motion_types",
      ]);
    }
  });

  it("fails closed on a non-object plan", () => {
    expect(evaluateGoldenPlan(SAMPLE, null).passed).toBe(false);
    expect(evaluateGoldenPlan(SAMPLE, []).passed).toBe(false);
  });

  it("rejects a wrong schema version", () => {
    const plan = validPlan(SAMPLE);
    plan["schemaVersion"] = "campaign-plan/v9";
    expect(failedNames(SAMPLE, plan)).toContain("plan_schema_version");
  });

  it("rejects a missing required field", () => {
    const plan = validPlan(SAMPLE);
    delete (plan["goal"] as Record<string, unknown>)["objective"];
    expect(failedNames(SAMPLE, plan)).toContain("required_fields");
  });

  it("rejects forbidden fields (send / document semantics)", () => {
    const plan = validPlan(SAMPLE);
    (plan["motions"] as Record<string, unknown>[])[0]["send"] = { channel: "email" };
    expect(failedNames(SAMPLE, plan)).toContain("forbidden_fields");
  });

  it("rejects forbidden content across fields", () => {
    const plan = validPlan(SAMPLE);
    (plan["goal"] as Record<string, unknown>)["objective"] = "Send email with a proforma invoice";
    expect(failedNames(SAMPLE, plan)).toContain("forbidden_content");
  });

  it("rejects a budget above the brief cap or the wrong currency", () => {
    const overCap = validPlan(SAMPLE);
    (overCap["budget"] as Record<string, unknown>)["capMicros"] = SAMPLE.brief.budgetCapMicros + 1;
    expect(failedNames(SAMPLE, overCap)).toContain("budget_respect");

    const wrongCurrency = validPlan(SAMPLE);
    (wrongCurrency["budget"] as Record<string, unknown>)["currency"] = "EUR";
    expect(failedNames(SAMPLE, wrongCurrency)).toContain("budget_respect");
  });

  it("bounds decisionPolicy.maxReplans to [0,2] (old plans with 0 stay valid)", () => {
    for (const value of [0, 1, 2]) {
      const plan = validPlan(SAMPLE);
      (plan["decisionPolicy"] as Record<string, unknown>)["maxReplans"] = value;
      expect(evaluateGoldenPlan(SAMPLE, plan).passed, `maxReplans=${String(value)}`).toBe(true);
    }
    for (const value of [3, -1, 1.5, "0"]) {
      const plan = validPlan(SAMPLE);
      (plan["decisionPolicy"] as Record<string, unknown>)["maxReplans"] = value;
      expect(failedNames(SAMPLE, plan), `maxReplans=${String(value)}`).toContain("decision_policy");
    }
  });

  it("rejects motion types outside the v0 allowlist", () => {
    const plan = validPlan(SAMPLE);
    (plan["motions"] as Record<string, unknown>[])[0]["type"] = "outreach";
    expect(failedNames(SAMPLE, plan)).toContain("motion_types");
  });

  it("mutation: a tampered expectation turns a valid plan red", () => {
    const tampered: GoldenBriefAsset = {
      ...SAMPLE,
      expectations: {
        ...SAMPLE.expectations,
        requiredFields: [...SAMPLE.expectations.requiredFields, "audience.includeFilters"],
      },
    };
    expect(evaluateGoldenPlan(tampered, validPlan(SAMPLE)).passed).toBe(false);
    expect(failedNames(tampered, validPlan(SAMPLE))).toContain("required_fields");
  });
});
