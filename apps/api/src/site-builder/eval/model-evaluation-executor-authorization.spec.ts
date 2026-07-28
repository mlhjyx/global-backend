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
import {
  bindFakeModelEvaluationWireCredential,
  createFakeModelEvaluationCostSafety,
} from "./model-evaluation-cost-safety.spec-support";
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
  const costSafety = createFakeModelEvaluationCostSafety(
    deps.settlementResolver.resolverId,
  );
  return createRawModelEvaluationProtocolExecutor({
    ...deps,
    wireClient: bindFakeModelEvaluationWireCredential(
      deps.wireClient,
      costSafety,
    ),
    costSafety,
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
  it("requires the immutable wire credential identity to match the attestation", () => {
    const resolver = fakeResolver();
    const costSafety = createFakeModelEvaluationCostSafety(resolver.resolverId);

    expect(() =>
      createRawModelEvaluationProtocolExecutor({
        wireClient: fakeWireClient(vi.fn()),
        settlementResolver: resolver,
        costSafety,
      }),
    ).toThrow("trusted cost safety must match");
  });

  it("allows one executor factory to claim an authorization id only once", () => {
    const resolver = fakeResolver();
    const costSafety = createFakeModelEvaluationCostSafety(resolver.resolverId);
    const firstWire = fakeWireClient(vi.fn());
    const secondWire = fakeWireClient(vi.fn());

    expect(() =>
      createRawModelEvaluationProtocolExecutor({
        wireClient: bindFakeModelEvaluationWireCredential(
          firstWire,
          costSafety,
        ),
        settlementResolver: resolver,
        costSafety,
      }),
    ).not.toThrow();
    expect(() =>
      createRawModelEvaluationProtocolExecutor({
        wireClient: bindFakeModelEvaluationWireCredential(
          secondWire,
          costSafety,
        ),
        settlementResolver: fakeResolver(),
        costSafety,
      }),
    ).toThrow("trusted cost safety must match");
  });

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
    const costSafety = createModelEvaluationCostSafetyAttestation(input);
    const wireClient = fakeWireClient(wire);
    const executor = createRawModelEvaluationProtocolExecutor({
      wireClient: bindFakeModelEvaluationWireCredential(wireClient, costSafety),
      settlementResolver: resolver,
      costSafety,
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

  it("rejects an unrelated legacy alias in an otherwise complete scope", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const wire = vi.fn();
    const resolver = fakeResolver();
    const input = structuredClone(
      createFakeModelEvaluationCostSafety(resolver.resolverId),
    ) as ModelEvaluationCostSafetyInput;
    input.credential.allowedDispatches = [
      ...input.credential.allowedDispatches,
      {
        mode: "legacy_comparator",
        alias: "unrelated-legacy-model",
        protocol: "openai-chat-completions",
      },
    ];
    input.pricing.entries = [
      ...input.pricing.entries,
      {
        alias: "unrelated-legacy-model",
        protocol: "openai-chat-completions",
        inputCentsPerMillionTokens: 1,
        outputCentsPerMillionTokens: 1,
      },
    ];
    const costSafety = createModelEvaluationCostSafetyAttestation(input);
    const executor = createRawModelEvaluationProtocolExecutor({
      wireClient: bindFakeModelEvaluationWireCredential(
        fakeWireClient(wire),
        costSafety,
      ),
      settlementResolver: resolver,
      costSafety,
    });
    const budget = new ModelEvaluationBudgetGuard(100);

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
    });
    expect(wire).not.toHaveBeenCalled();
  });

  it("keeps campaign spend shared when one executor is presented to fresh budget guards", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[0];
    const wire = vi.fn(async () => ({
      body: {
        status: "completed",
        model: candidate.alias,
        output: [{ content: [{ type: "output_text", text: "{}" }] }],
        usage: { input_tokens: 10, output_tokens: 1 },
      },
      providerReportedCostCents: 40,
    }));
    const resolver = fakeResolver();
    const costSafety = createFakeModelEvaluationCostSafety(
      resolver.resolverId,
      80,
    );
    const executor = createRawModelEvaluationProtocolExecutor({
      wireClient: bindFakeModelEvaluationWireCredential(
        fakeWireClient(wire),
        costSafety,
      ),
      settlementResolver: resolver,
      costSafety,
    });

    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate,
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: new ModelEvaluationBudgetGuard(80),
        execute: executor.execute,
      }),
    ).resolves.toMatchObject({ resultClass: "content_invalid" });
    expect(wire).toHaveBeenCalledTimes(2);

    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate,
        fixtureId: "industrial-pump-sparse",
        attempt: 1,
        campaignBudget: new ModelEvaluationBudgetGuard(80),
        execute: executor.execute,
      }),
    ).resolves.toMatchObject({
      failureCode: "post_dispatch_settlement_incoherent",
      costSettlement: {
        state: "unknown",
        reason: "invalid_settlement",
      },
    });
    expect(wire).toHaveBeenCalledTimes(2);
  });
});
