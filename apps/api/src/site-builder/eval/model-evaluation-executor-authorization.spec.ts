import { describe, expect, it, vi } from "vitest";

import { BRAND_PROFILE_TASK } from "../agents/brand-profile";
import { modelPolicyRegistry } from "../agents/model-policy.registry";
import {
  ModelEvaluationBudgetGuard,
  ModelEvaluationCallError,
  buildCanonicalModelEvaluationCase,
  buildTaskEvaluationPlan,
  runTaskEvaluationAttempt,
  type ModelEvaluationExecutionRequest,
} from "./model-evaluation-harness";
import {
  createModelEvaluationProtocolExecutor as createRawModelEvaluationProtocolExecutor,
  type ModelEvaluationWireClient,
} from "./model-evaluation-executor";
import { createFakeModelEvaluationCostSafety } from "./model-evaluation-cost-safety.spec-support";
import {
  createModelEvaluationCostSafetyAttestation,
  type ModelEvaluationCostSafetyInput,
} from "./model-evaluation-cost-safety";

function createModelEvaluationProtocolExecutor(
  deps: Omit<
    Parameters<typeof createRawModelEvaluationProtocolExecutor>[0],
    "costSafety"
  >,
) {
  return createRawModelEvaluationProtocolExecutor({
    ...deps,
    costSafety: createFakeModelEvaluationCostSafety(
      deps.settlementResolver.resolverId,
    ),
  });
}

function fakeWireClient(openAIResponses: ReturnType<typeof vi.fn>) {
  return {
    openAIResponses,
    anthropicMessages: vi.fn(async () => {
      throw new Error("unexpected Messages dispatch");
    }),
    openAIChatCompletions: vi.fn(async () => {
      throw new Error("unexpected Chat dispatch");
    }),
  } satisfies ModelEvaluationWireClient;
}

function fakeResolver() {
  return {
    resolverId: "authorization-spec-settlement/v1",
    resolve: (context: {
      providerReportedCostCents: readonly (number | null)[];
    }) => {
      const costs = context.providerReportedCostCents;
      return costs.every((amount): amount is number => amount !== null)
        ? {
            state: "settled" as const,
            amountCents: costs.reduce((sum, amount) => sum + amount, 0),
            basis: "provider_reported" as const,
          }
        : {
            state: "unknown" as const,
            reason: "provider_ack_unknown" as const,
          };
    },
  };
}

function directRequest(): ModelEvaluationExecutionRequest {
  const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
  const candidate = plan.candidates[0];
  const evaluationCase = buildCanonicalModelEvaluationCase(
    plan,
    "auto-parts-rich",
  );
  return {
    executionId: "authorization-spec:direct:1",
    taskId: plan.taskId,
    profile: plan.profile,
    alias: candidate.alias,
    expectedProtocol: candidate.expectedProtocol,
    fixtureId: evaluationCase.contract.fixtureId,
    attempt: 1,
    maxTokens: plan.envelope.maxTokens,
    runtimeDeadlineMs: plan.envelope.runtimeDeadlineMs,
    hardStopMs: plan.envelope.hardStopMs,
    perCallCostCapCents: plan.envelope.perCallCostCapCents,
    reasoningEffort: plan.envelope.reasoningEffort,
    outputSchema: BRAND_PROFILE_TASK.outputSchema,
    repairTaskOutput: plan.evaluationSuite!.repairTaskOutput,
    caseContract: evaluationCase.contract,
    casePayload: evaluationCase.payload,
    signal: new AbortController().signal,
  };
}

describe("model evaluation executor authorization", () => {
  it("rejects direct target and legacy dispatch before any wire call", async () => {
    const targetWire = vi.fn();
    const wireClient = fakeWireClient(targetWire);
    const executor = createModelEvaluationProtocolExecutor({
      wireClient,
      settlementResolver: fakeResolver(),
    });
    const target = directRequest();
    const legacy = {
      ...target,
      executionId: "authorization-spec:legacy:1",
      alias: modelPolicyRegistry.getLegacyTaskPolicy(target.taskId).route
        .primary,
      expectedProtocol: "openai-chat-completions" as const,
    };

    await expect(executor.execute(target)).rejects.toMatchObject({
      failureCode: "evaluation_dispatch_not_authorized",
      costSettlement: {
        state: "not_incurred",
        reason: "rejected_before_dispatch",
      },
    });
    await expect(
      executor.executeLegacyComparator(legacy),
    ).rejects.toMatchObject({
      failureCode: "evaluation_dispatch_not_authorized",
    });
    expect(targetWire).not.toHaveBeenCalled();
    expect(wireClient.openAIChatCompletions).not.toHaveBeenCalled();
  });

  it("binds one budget campaign to one branded executor identity", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[0];
    const firstWire = vi.fn(async () => ({
      body: {
        status: "completed",
        model: candidate.alias,
        output: [{ content: [{ type: "output_text", text: "" }] }],
        usage: { input_tokens: 10, output_tokens: 1 },
      },
      providerReportedCostCents: 1,
    }));
    const secondWire = vi.fn();
    const firstExecutor = createModelEvaluationProtocolExecutor({
      wireClient: fakeWireClient(firstWire),
      settlementResolver: fakeResolver(),
    });
    const secondExecutor = createModelEvaluationProtocolExecutor({
      wireClient: fakeWireClient(secondWire),
      settlementResolver: fakeResolver(),
    });
    const budget = new ModelEvaluationBudgetGuard(100);

    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate,
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: budget,
        execute: firstExecutor.execute,
      }),
    ).resolves.toMatchObject({
      resultClass: "content_invalid",
    });
    const snapshot = budget.snapshot();

    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate,
        fixtureId: "industrial-pump-sparse",
        attempt: 1,
        campaignBudget: budget,
        execute: secondExecutor.execute,
      }),
    ).rejects.toEqual(
      expect.objectContaining<ModelEvaluationCallError>({
        failureCode: "evaluation_executor_campaign_mismatch",
      }),
    );
    expect(firstWire).toHaveBeenCalledTimes(1);
    expect(secondWire).not.toHaveBeenCalled();
    expect(budget.snapshot()).toEqual(snapshot);
  });

  it("rejects an incomplete target credential scope before budget or client", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const wire = vi.fn();
    const resolver = fakeResolver();
    const input = structuredClone(
      createFakeModelEvaluationCostSafety(resolver.resolverId),
    ) as ModelEvaluationCostSafetyInput;
    input.credential.allowedDispatches =
      input.credential.allowedDispatches.filter(
        (entry) => entry.alias !== "gpt-5.5",
      );
    input.pricing.entries = input.pricing.entries.filter(
      (entry) => entry.alias !== "gpt-5.5",
    );
    const executor = createRawModelEvaluationProtocolExecutor({
      wireClient: fakeWireClient(wire),
      settlementResolver: resolver,
      costSafety: createModelEvaluationCostSafetyAttestation(input),
    });
    const budget = new ModelEvaluationBudgetGuard(100);
    const snapshot = budget.snapshot();

    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate: plan.candidates[0],
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: budget,
        execute: executor.execute,
      }),
    ).rejects.toMatchObject({
      failureCode: "evaluation_cost_safety_mismatch",
      costSettlement: {
        state: "not_incurred",
        reason: "rejected_before_dispatch",
      },
    });
    expect(wire).not.toHaveBeenCalled();
    expect(budget.snapshot()).toEqual(snapshot);
  });
});
