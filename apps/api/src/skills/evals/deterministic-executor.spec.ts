import { describe, expect, it } from "vitest";
import { runDeterministicEvals } from "./deterministic-executor";
import type { EvalManifest } from "./eval-manifest";

const MANIFEST: EvalManifest = {
  skillName: "demo.service_skill",
  evals: [
    {
      id: 1,
      input: { companyName: "Acme" },
      assertions: [
        { kind: "enum", path: "status", values: ["clear", "potential_match"] },
        { kind: "source_count_gte", path: "matches", value: 0 },
        { kind: "no_vendor_marketing", path: "summary" },
        { kind: "tool_not_called", value: "crawl4ai.fetch" },
      ],
    },
    {
      id: 2,
      input: { companyName: "Beta" },
      assertions: [
        { kind: "equals", path: "status", value: "potential_match" },
        { kind: "gte", path: "matches.0.score", value: 0.7 },
        { kind: "approval_required", value: "sanctions-review" },
      ],
    },
  ],
};

describe("runDeterministicEvals", () => {
  it("passes when every assertion holds", async () => {
    const result = await runDeterministicEvals(MANIFEST, (evalCase) =>
      evalCase.id === 1
        ? { output: { status: "clear", matches: [], summary: "public web only" }, toolCalls: [] }
        : {
            output: { status: "potential_match", matches: [{ score: 0.82 }] },
            approvalRequests: ["sanctions-review"],
          },
    );
    expect(result.passed).toBe(true);
    expect(result.cases.map((entry) => entry.ok)).toEqual([true, true]);
  });

  it("reports per-case failures with the failing assertion", async () => {
    const result = await runDeterministicEvals(MANIFEST, (evalCase) =>
      evalCase.id === 1
        ? {
            output: { status: "unknown", matches: [], summary: "sponsored by Acme" },
            toolCalls: ["crawl4ai.fetch"],
          }
        : { output: { status: "clear", matches: [] } },
    );
    expect(result.passed).toBe(false);
    const first = result.cases[0];
    expect(first.ok).toBe(false);
    expect(first.failures.join("|")).toContain("enum failed");
    expect(first.failures.join("|")).toContain("no_vendor_marketing hit");
    expect(first.failures.join("|")).toContain("tool_not_called failed");
    const second = result.cases[1];
    expect(second.failures.join("|")).toContain("equals failed");
    expect(second.failures.join("|")).toContain("approval_required missing");
  });

  it("supports regex and json_schema assertions", async () => {
    const manifest: EvalManifest = {
      skillName: "demo",
      evals: [
        {
          id: 1,
          input: {},
          assertions: [
            { kind: "regex", path: "formulaVersion", pattern: "^incoterms-2020/v1$" },
            {
              kind: "json_schema",
              schema: {
                type: "object",
                required: ["totalUnitPrice"],
                properties: { totalUnitPrice: { type: "number" } },
              },
            },
          ],
        },
      ],
    };
    const result = await runDeterministicEvals(manifest, () => ({
      output: { totalUnitPrice: 12.5, formulaVersion: "incoterms-2020/v1" },
    }));
    expect(result.passed).toBe(true);
  });
});
