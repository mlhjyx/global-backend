import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("node:fs");
  vi.resetModules();
});

describe("model evaluation source bundle drift", () => {
  it("re-reads the real source bundle after dispatch and fails closed on changed bytes", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const readFileSync = actualFs.readFileSync as unknown as (
      ...args: unknown[]
    ) => unknown;
    let wireCompleted = false;
    let postDispatchTargetReads = 0;

    vi.doMock("node:fs", () => ({
      ...actualFs,
      readFileSync: (...args: unknown[]) => {
        const result = readFileSync(...args);
        if (
          wireCompleted &&
          String(args[0]).endsWith(
            "/apps/api/src/site-builder/eval/model-evaluation-executor.ts",
          )
        ) {
          postDispatchTargetReads += 1;
          if (Buffer.isBuffer(result)) {
            return Buffer.concat([result, Buffer.from("\n")]);
          }
          if (typeof result === "string") {
            return `${result}\n`;
          }
        }
        return result;
      },
    }));

    const harness = await import("./model-evaluation-harness");
    const { createModelEvaluationProtocolExecutor } =
      await import("./model-evaluation-executor");
    const {
      bindFakeModelEvaluationWireCredential,
      createFakeModelEvaluationAuthorizationLedger,
      createFakeModelEvaluationCostSafety,
    } = await import("./model-evaluation-cost-safety.spec-support");
    const plan = harness.buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[0];
    const evaluationCase = harness.buildCanonicalModelEvaluationCase(
      plan,
      "auto-parts-rich",
    );
    const sources = [
      evaluationCase.payload.taskInput.intakeSource,
      ...evaluationCase.payload.taskInput.kbSources,
      ...evaluationCase.payload.taskInput.research,
    ];
    const artifact = {
      valueProps: [],
      glossary: [],
      keywords: [],
      differentiators: [],
      competitors: [],
      gaps: [],
      factSheet:
        evaluationCase.payload.fixture.assertions.requiredAcceptedTerms.map(
          (term) => {
            const source = sources.find((entry) =>
              entry.content.toLowerCase().includes(term.toLowerCase()),
            );
            if (!source) {
              throw new Error(`test requires canonical evidence for ${term}`);
            }
            const index = source.content
              .toLowerCase()
              .indexOf(term.toLowerCase());
            return {
              key: "products",
              value: term,
              evidence: {
                sourceType: source.sourceType,
                sourceId: source.sourceId,
                contentHash: source.contentHash,
                quote: source.content.slice(
                  Math.max(0, index - 120),
                  Math.min(source.content.length, index + term.length + 120),
                ),
              },
            };
          },
        ),
    };
    const wireCall = vi.fn(async () => {
      wireCompleted = true;
      return {
        body: {
          status: "completed",
          model: candidate.alias,
          output: [
            {
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify(artifact),
                },
              ],
            },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
          },
        },
        providerReportedCostCents: 1,
      };
    });
    const costSafety = createFakeModelEvaluationCostSafety(
      "source-drift-spec-settlement/v1",
    );
    const wireClient = {
      openAIResponses: wireCall,
      anthropicMessages: async () => {
        throw new Error("unexpected Messages dispatch");
      },
      openAIChatCompletions: async () => {
        throw new Error("unexpected Chat dispatch");
      },
    };
    const executor = createModelEvaluationProtocolExecutor({
      wireClient: bindFakeModelEvaluationWireCredential(wireClient, costSafety),
      authorizationLedger:
        createFakeModelEvaluationAuthorizationLedger(costSafety),
      settlementResolver: {
        resolverId: "source-drift-spec-settlement/v1",
        resolve: (context) => ({
          state: "settled" as const,
          amountCents: 1,
          basis: "provider_reported" as const,
          executionId: context.executionId,
        }),
      },
      costSafety,
    });

    await expect(
      harness.runTaskEvaluationAttempt({
        plan,
        candidate,
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: new harness.ModelEvaluationBudgetGuard(100),
        execute: executor.execute,
      }),
    ).resolves.toMatchObject({
      resultClass: "provenance_invalid",
      artifactAccepted: false,
      failureCode: "source_bundle_changed_during_dispatch",
    });
    expect(wireCall).toHaveBeenCalledTimes(1);
    expect(postDispatchTargetReads).toBeGreaterThan(0);
  }, 15_000);
});
