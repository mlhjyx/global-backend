import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildM1TextEvaluationPlan,
  runM1TextEvaluation,
} from "../../../scripts/run-m1-text-evaluation.mts";
import {
  buildCanonicalModelEvaluationCase,
  buildTaskEvaluationPlan,
} from "./model-evaluation-harness";
import {
  deterministicQualityNarrativeOutput,
  type QualityNarrativeTaskInputV1,
} from "../quality/quality-narrative";

const designSpecManifest = JSON.parse(
  readFileSync(
    join(
      __dirname,
      "../../../../../docs/evidence/site-builder/m1-g-design-spec-evaluation-manifest-v6.json",
    ),
    "utf8",
  ),
);
const remainingTextManifest = JSON.parse(
  readFileSync(
    join(
      __dirname,
      "../../../../../docs/evidence/site-builder/m1-g-remaining-text-evaluation-manifest-v2.json",
    ),
    "utf8",
  ),
);

describe("minimal M1 text evaluation plan", () => {
  it("consumes the two current manifests as one exact 206/412 execution plan", () => {
    const plan = buildM1TextEvaluationPlan({
      designSpecManifest,
      remainingTextManifest,
    });
    expect(plan.executionCount).toBe(206);
    expect(plan.maximumWireCallCount).toBe(412);
    expect(
      plan.executions.filter(({ kind }) => kind === "capability_probe"),
    ).toHaveLength(2);
    expect(
      Object.fromEntries(
        plan.taskIds.map((taskId) => [
          taskId,
          plan.executions.filter((execution) => execution.taskId === taskId)
            .length,
        ]),
      ),
    ).toEqual({
      "site_builder.design_spec": 73,
      "site_builder.copy": 13,
      "site_builder.assemble": 48,
      "site_builder.assembly_fix": 48,
      "site_builder.qa_summarize": 12,
      "site_builder.seo_review": 12,
    });
    expect(
      [...new Set(plan.executions.map(({ alias }) => alias))].sort(),
    ).toEqual(["claude-sonnet-5", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-terra"]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.executions)).toBe(true);
  });

  it("rejects an expanded model or call-count drift before any network call", () => {
    const expanded = structuredClone(remainingTextManifest);
    expanded.tasks[0].executions.push({
      ...expanded.tasks[0].executions[0],
      ordinal: 14,
      executionKey: "target/minimax-m3/openai-responses/copy-factual-claims/1",
      kind: "target",
      alias: "minimax-m3",
    });
    expanded.tasks[0].executionCount += 1;
    expanded.tasks[0].maximumWireCallCount += 2;
    expanded.executionCount += 1;
    expanded.maximumWireCallCount += 2;
    expect(() =>
      buildM1TextEvaluationPlan({
        designSpecManifest,
        remainingTextManifest: expanded,
      }),
    ).toThrow("M1 text evaluation manifest is invalid");

    const drifted = structuredClone(designSpecManifest);
    drifted.maximumWireCallCount = 147;
    expect(() =>
      buildM1TextEvaluationPlan({
        designSpecManifest: drifted,
        remainingTextManifest,
      }),
    ).toThrow("M1 text evaluation manifest is invalid");

    const tampered = structuredClone(remainingTextManifest);
    tampered.prepId = "tampered-without-recomputing-digest";
    expect(() =>
      buildM1TextEvaluationPlan({
        designSpecManifest,
        remainingTextManifest: tampered,
      }),
    ).toThrow("M1 text evaluation manifest is invalid");
  });

  it.each([
    ["wrong repair model", "request_0002", "gpt-5.6-terra"],
    ["duplicate receipt", "request_0001", "gpt-5.5"],
  ])("stops on %s", async (_name, secondRequestId, secondModel) => {
    let calls = 0;
    const fakeFetch: typeof fetch = async (request, init) => {
      const outgoing = new Request(request, init);
      if (outgoing.method === "GET") {
        return Response.json({
          data: [
            { id: "claude-sonnet-5" },
            { id: "gpt-5.5" },
            { id: "gpt-5.6-luna" },
            { id: "gpt-5.6-terra" },
          ],
        });
      }
      calls += 1;
      return Response.json(
        {
          status: "completed",
          model: calls === 1 ? "gpt-5.5" : secondModel,
          output: [
            { content: [{ type: "output_text", text: JSON.stringify({}) }] },
          ],
          usage: { input_tokens: 10, output_tokens: 2 },
        },
        {
          headers: {
            "x-oneapi-request-id":
              calls === 1 ? "request_0001" : secondRequestId,
          },
        },
      );
    };
    await expect(
      runM1TextEvaluation({
        campaignId: "123e4567-e89b-42d3-a456-426614174001",
        designSpecManifest,
        remainingTextManifest,
        token: "x".repeat(16),
        fetch: fakeFetch,
      }),
    ).rejects.toThrow(/reported model does not match|receipt is duplicated/);
    expect(calls).toBe(2);
  });

  it("runs the exact matrix through fake wires and retains only receipts, usage, and digests", async () => {
    const plan = buildM1TextEvaluationPlan({
      designSpecManifest,
      remainingTextManifest,
    });
    const campaignId = "123e4567-e89b-42d3-a456-426614174000";
    const entryByExecutionId = new Map(
      plan.executions.map((entry) => [
        `m1-${campaignId}-${entry.taskId}-${entry.ordinal}`,
        entry,
      ]),
    );
    let modelCalls = 0;
    const fakeFetch: typeof fetch = async (request, init) => {
      const outgoing = new Request(request, init);
      if (outgoing.method === "GET" && outgoing.url.endsWith("/v1/models")) {
        return Response.json({
          data: [
            { id: "claude-sonnet-5" },
            { id: "gpt-5.5" },
            { id: "gpt-5.6-luna" },
            { id: "gpt-5.6-terra" },
          ],
        });
      }
      modelCalls += 1;
      const executionId = outgoing.headers.get(
        "x-site-builder-evaluation-execution-id",
      );
      const entry = entryByExecutionId.get(executionId ?? "")!;
      const evaluationCase = buildCanonicalModelEvaluationCase(
        buildTaskEvaluationPlan(entry.taskId),
        entry.fixtureId,
      );
      const fixture = evaluationCase.payload.fixture as unknown as {
        expectedOutput?: unknown;
        assertions?: { deterministicCandidateId?: string };
      };
      const expectedOutput =
        entry.taskId === "site_builder.design_spec"
          ? {
              candidateId: fixture.assertions!.deterministicCandidateId,
              reasons: [],
              warnings: [],
            }
          : entry.taskId === "site_builder.qa_summarize" ||
              entry.taskId === "site_builder.seo_review"
            ? deterministicQualityNarrativeOutput(
                evaluationCase.payload.taskInput as QualityNarrativeTaskInputV1,
              )
            : fixture.expectedOutput;
      const headers = {
        "x-oneapi-request-id": `request_${String(modelCalls).padStart(4, "0")}`,
      };
      if (entry.protocol === "openai-responses") {
        return Response.json(
          {
            status: "completed",
            model: entry.alias,
            output: [
              {
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify(expectedOutput),
                  },
                ],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 20 },
          },
          { headers },
        );
      }
      return Response.json(
        {
          stop_reason: "end_turn",
          model: entry.alias,
          content: [{ type: "text", text: JSON.stringify(expectedOutput) }],
          usage: { input_tokens: 10, output_tokens: 20 },
        },
        { headers },
      );
    };

    const evidence = await runM1TextEvaluation({
      campaignId,
      designSpecManifest,
      remainingTextManifest,
      token: "x".repeat(16),
      fetch: fakeFetch,
    });

    expect(modelCalls).toBe(206);
    expect(evidence.actualNetworkCalls).toBe(206);
    expect(evidence.results).toHaveLength(206);
    expect(
      evidence.results.every(({ outcome }) => outcome === "accepted"),
    ).toBe(true);
    expect(
      evidence.results.every(({ requestIds }) => requestIds.length === 1),
    ).toBe(true);
    expect(evidence.candidates.every(({ rankable }) => rankable)).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain("x".repeat(16));
  }, 30_000);
});
