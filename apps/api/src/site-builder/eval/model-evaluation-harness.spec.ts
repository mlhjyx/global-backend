import { describe, expect, it, vi } from "vitest";
import {
  ModelEvaluationBudgetGuard,
  ModelEvaluationCallError,
  buildAllTaskEvaluationPlans,
  buildProfileEvaluationAdmission,
  buildTaskEvaluationPlan,
  classifyCompletedTaskResult,
  rankModelEvaluationCandidates,
  runTaskEvaluationAttempt,
  summarizeModelEvaluationCandidate,
  taskEvaluationContractFingerprint,
  validateCapabilityProbe,
  type ModelEvaluationCaseContract,
  type ModelEvaluationCallResult,
  type ModelEvaluationCandidateSummary,
  type ModelEvaluationRun,
  type TaskArtifactAssessment,
} from "./model-evaluation-harness";
import { sha256CanonicalJson } from "./eval-provenance";

const validAssessment = (
  stabilityKey = "semantic-set-a",
): TaskArtifactAssessment => ({
  qualityPassed: true,
  structurePassed: true,
  factualityPassed: true,
  stabilityKey,
  findingCodes: [],
});

function completedCall<T>(
  alias: string,
  protocol:
    "openai-responses" | "anthropic-messages" | "openai-chat-completions",
  artifact: T,
  costCents = 1,
): ModelEvaluationCallResult<T> {
  return {
    artifactState: "complete",
    artifact,
    ...(artifact === undefined
      ? {}
      : { artifactSha256: sha256CanonicalJson(artifact) }),
    actualProtocol: protocol,
    requestedModel: alias,
    reportedModel: alias,
    resolvedModel: alias,
    modelResolutionSource: "upstream_response",
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      callCount: 1,
      source: "provider_reported",
    },
    costSettlement: {
      state: "settled",
      amountCents: costCents,
      basis: "provider_reported",
    },
  };
}

function evaluationCase(
  plan: ReturnType<typeof buildTaskEvaluationPlan>,
  fixtureId = "auto-parts-rich",
): ModelEvaluationCaseContract {
  const suite = plan.evaluationSuite;
  if (!suite) throw new Error("test requires a canonical evaluation suite");
  const fixture = suite.fixtureFingerprints.find(
    (entry) => entry.fixtureId === fixtureId,
  );
  if (!fixture) throw new Error("test requires a canonical fixture");
  return {
    suiteId: suite.suiteId,
    adapterId: suite.adapterId,
    taskContractId: suite.taskContractId,
    taskContractFingerprint: taskEvaluationContractFingerprint(suite),
    promptVersion: suite.promptVersion,
    inputSchemaSha256: suite.inputSchemaSha256,
    outputSchemaSha256: suite.outputSchemaSha256,
    routeValidationVersion: suite.routeValidationVersion,
    evaluatorVersion: suite.evaluatorVersion,
    evaluatorRubricSha256: suite.evaluatorRubricSha256,
    fixtureSetId: suite.fixtureSetId,
    sourceBundleContractId: suite.sourceBundleContractId,
    fixtureSchemaVersion: suite.fixtureSchemaVersion,
    fixtureId,
    fixtureSha256: fixture.fixtureSha256,
    promptSha256: fixture.promptSha256,
    sourceBundleSha256: "c".repeat(64),
  };
}

describe("model evaluation planning", () => {
  it("derives every current task candidate and protocol from the baseline", () => {
    const plans = buildAllTaskEvaluationPlans();
    expect(plans).toHaveLength(7);
    expect(plans.map((plan) => plan.taskId)).toEqual([
      "site_builder.brand_profile",
      "site_builder.copy",
      "site_builder.design_spec",
      "site_builder.assemble",
      "site_builder.assembly_fix",
      "site_builder.qa_summarize",
      "site_builder.seo_review",
    ]);

    expect(buildTaskEvaluationPlan("site_builder.brand_profile")).toMatchObject(
      {
        candidateBaselineId:
          "site-builder-model-candidate-baseline/2026-07-27-v1",
        profile: "structured.workspace_materials",
        dispatchAdmission: "task_evaluation_ready",
        evaluationSuite: {
          suiteId: "site-builder.brand-profile-evaluation-suite/2026-07-27-v1",
          fixtureSetId: "site-builder.brand-profile-golden/2026-07-18-v1",
          repeats: 2,
        },
        envelope: {
          maxTokens: 12_000,
          runtimeDeadlineMs: 240_000,
          diagnosticObservationMs: 240_000,
          hardStopMs: 480_000,
          perCallCostCapCents: 40,
          reasoningEffort: "low",
        },
        candidates: [
          {
            alias: "gpt-5.6-terra",
            status: "runnable",
            expectedProtocol: "openai-responses",
          },
          {
            alias: "claude-sonnet-5",
            status: "runnable",
            expectedProtocol: "anthropic-messages",
          },
          {
            alias: "gpt-5.5",
            status: "runnable",
            expectedProtocol: "openai-responses",
          },
        ],
      },
    );

    expect(buildTaskEvaluationPlan("site_builder.copy").envelope).toEqual({
      maxTokens: 4000,
      runtimeDeadlineMs: 120_000,
      diagnosticObservationMs: 120_000,
      hardStopMs: 240_000,
      perCallCostCapCents: 20,
      reasoningEffort: "low",
    });
    expect(buildTaskEvaluationPlan("site_builder.assemble").envelope).toEqual({
      maxTokens: 16_000,
      runtimeDeadlineMs: 180_000,
      diagnosticObservationMs: 180_000,
      hardStopMs: 360_000,
      perCallCostCapCents: 20,
      reasoningEffort: null,
    });
    expect(
      buildTaskEvaluationPlan("site_builder.qa_summarize").envelope,
    ).toEqual({
      maxTokens: 3000,
      runtimeDeadlineMs: 90_000,
      diagnosticObservationMs: 90_000,
      hardStopMs: 180_000,
      perCallCostCapCents: 20,
      reasoningEffort: null,
    });
    expect(buildTaskEvaluationPlan("site_builder.copy")).toMatchObject({
      dispatchAdmission: "blocked_no_evaluation_suite",
      evaluationSuite: null,
    });
    expect(buildProfileEvaluationAdmission("copy.premium")).toMatchObject({
      disposition: "blocked_no_evaluation_suite",
    });
  });

  it("keeps unbound and media profiles non-dispatchable", () => {
    expect(buildProfileEvaluationAdmission("reasoning.high")).toMatchObject({
      disposition: "blocked_no_task_envelope",
      mappedTasks: [],
    });
    expect(buildProfileEvaluationAdmission("multimodal.review")).toMatchObject({
      disposition: "blocked_no_task_envelope",
      mappedTasks: [],
    });

    const image = buildProfileEvaluationAdmission("image.bulk.creative");
    expect(image.disposition).toBe("blocked_requires_media_gateway");
    expect(image.candidates).toEqual([
      expect.objectContaining({
        alias: "gemini-3.1-flash-image-preview",
        admission: "blocked_preview_shadow_only",
      }),
      expect.objectContaining({
        alias: "gpt-image-2",
        admission: "blocked_requires_media_gateway",
      }),
    ]);

    const video = buildProfileEvaluationAdmission("video.primary");
    expect(video.disposition).toBe("blocked_requires_media_gateway");
    expect(
      video.candidates.every(
        (candidate) => candidate.admission === "blocked_deferred",
      ),
    ).toBe(true);
  });
});

describe("capability and protocol validation", () => {
  const candidate = buildTaskEvaluationPlan("site_builder.copy").candidates[1];

  it("requires the planned protocol and exact upstream model identity", () => {
    expect(
      validateCapabilityProbe(candidate, {
        actualProtocol: "openai-responses",
        requestedModel: "gpt-5.5",
        reportedModel: "gpt-5.5",
        resolvedModel: "gpt-5.5",
        modelResolutionSource: "upstream_response",
        outputState: "complete",
      }),
    ).toEqual({
      status: "capability_proven",
      protocolVerified: true,
      identityVerified: true,
      outputVerified: true,
    });

    expect(
      validateCapabilityProbe(candidate, {
        actualProtocol: "openai-chat-completions",
        requestedModel: "gpt-5.5",
        reportedModel: "gpt-5.5",
        resolvedModel: "gpt-5.5",
        modelResolutionSource: "upstream_response",
        outputState: "complete",
      }).status,
    ).toBe("protocol_mismatch");

    expect(
      validateCapabilityProbe(candidate, {
        actualProtocol: "openai-responses",
        requestedModel: "gpt-5.5",
        reportedModel: undefined,
        resolvedModel: "gpt-5.5",
        modelResolutionSource: "requested_fallback",
        outputState: "complete",
      }).status,
    ).toBe("identity_unproven");

    expect(
      validateCapabilityProbe(candidate, {
        actualProtocol: "openai-responses",
        requestedModel: "gpt-5.5",
        reportedModel: "gpt-5.5",
        resolvedModel: "gpt-5.5",
        modelResolutionSource: "upstream_response",
        outputState: "schema_invalid",
      }).status,
    ).toBe("output_invalid");

    expect(
      validateCapabilityProbe(candidate, {
        actualProtocol: "openai-responses",
        requestedModel: "gpt-5.5",
        reportedModel: "gpt-5.5",
        resolvedModel: "gpt-5.5",
        modelResolutionSource: "upstream_response",
        outputState: "provider_error",
      }).status,
    ).toBe("capability_unavailable");
  });
});

describe("task result classification", () => {
  const plan = buildTaskEvaluationPlan("site_builder.copy");
  const candidate = plan.candidates[0];

  it("separates valid late results from content-invalid results", () => {
    expect(
      classifyCompletedTaskResult({
        plan,
        candidate,
        elapsedMs: plan.envelope.runtimeDeadlineMs,
        call: completedCall(candidate.alias, candidate.expectedProtocol, {
          ok: true,
        }),
        assessment: validAssessment(),
      }),
    ).toMatchObject({
      resultClass: "quality_valid_runtime_on_time",
      runtimeTiming: "on_time",
      artifactAccepted: true,
    });

    expect(
      classifyCompletedTaskResult({
        plan,
        candidate,
        elapsedMs: plan.envelope.runtimeDeadlineMs + 1,
        call: completedCall(candidate.alias, candidate.expectedProtocol, {
          ok: true,
        }),
        assessment: validAssessment(),
      }),
    ).toMatchObject({
      resultClass: "quality_valid_runtime_late",
      runtimeTiming: "late",
      artifactAccepted: true,
    });

    expect(
      classifyCompletedTaskResult({
        plan,
        candidate,
        elapsedMs: plan.envelope.runtimeDeadlineMs + 1,
        call: completedCall(candidate.alias, candidate.expectedProtocol, {
          ok: false,
        }),
        assessment: {
          ...validAssessment(),
          factualityPassed: false,
          findingCodes: ["unsupported_claim"],
        },
      }),
    ).toMatchObject({
      resultClass: "content_invalid",
      runtimeTiming: "late",
      artifactAccepted: false,
    });
  });

  it("does not let protocol, identity, empty, or truncated output masquerade as quality", () => {
    expect(
      classifyCompletedTaskResult({
        plan,
        candidate,
        elapsedMs: 1000,
        call: {
          ...completedCall(candidate.alias, "openai-chat-completions", {
            ok: true,
          }),
        },
        assessment: validAssessment(),
      }).resultClass,
    ).toBe("protocol_or_identity_invalid");

    expect(
      classifyCompletedTaskResult({
        plan,
        candidate,
        elapsedMs: 1000,
        call: {
          ...completedCall(
            candidate.alias,
            candidate.expectedProtocol,
            undefined,
          ),
          artifactState: "truncated",
          artifact: undefined,
        },
        assessment: null,
      }).resultClass,
    ).toBe("content_invalid");
  });
});

describe("absolute budget guard", () => {
  it("reserves before dispatch and releases unused headroom after settlement", () => {
    const guard = new ModelEvaluationBudgetGuard(50);
    expect(guard.reserve("call-1", 20)).toEqual({
      allowed: true,
      reservation: { callId: "call-1", reservedCents: 20 },
    });
    guard.settle("call-1", {
      state: "settled",
      amountCents: 7,
      basis: "provider_reported",
    });
    expect(guard.snapshot()).toMatchObject({
      campaignBudgetCents: 50,
      committedCents: 7,
      reservedCents: 0,
      unknownUpperBoundCents: 0,
      remainingDispatchableCents: 43,
      blocked: false,
    });
  });

  it("blocks subsequent dispatch after unknown settlement", () => {
    const guard = new ModelEvaluationBudgetGuard(50);
    expect(guard.reserve("call-1", 20).allowed).toBe(true);
    guard.settle("call-1", {
      state: "unknown",
      reason: "provider_ack_unknown",
    });
    expect(guard.snapshot()).toMatchObject({
      committedCents: 0,
      unknownUpperBoundCents: 20,
      remainingDispatchableCents: 30,
      blocked: true,
      blockReason: "unknown_settlement",
    });
    expect(guard.reserve("call-2", 20)).toEqual({
      allowed: false,
      reason: "unknown_settlement",
    });
  });

  it("rejects a call whose per-call cap cannot fit in the remaining campaign budget", () => {
    const guard = new ModelEvaluationBudgetGuard(10);
    expect(guard.reserve("call-1", 20)).toEqual({
      allowed: false,
      reason: "campaign_budget_exhausted",
    });
  });

  it("stops after a provider reports cost above the reserved per-call cap", () => {
    const guard = new ModelEvaluationBudgetGuard(50);
    expect(guard.reserve("call-1", 20).allowed).toBe(true);
    guard.settle("call-1", {
      state: "settled",
      amountCents: 21,
      basis: "provider_reported",
    });
    expect(guard.snapshot()).toMatchObject({
      committedCents: 21,
      blocked: true,
      blockReason: "per_call_cap_exceeded",
    });
    expect(guard.reserve("call-2", 20)).toEqual({
      allowed: false,
      reason: "per_call_cap_exceeded",
    });
  });

  it("normalizes malformed settlement to unknown and freezes dispatch", () => {
    const guard = new ModelEvaluationBudgetGuard(50);
    expect(guard.reserve("call-1", 20).allowed).toBe(true);
    const settled = guard.settle("call-1", {
      state: "bogus",
    } as never);
    expect(settled).toEqual({
      settlement: {
        state: "unknown",
        reason: "invalid_settlement",
      },
      capExceeded: false,
      settlementInvalid: true,
    });
    expect(guard.snapshot()).toMatchObject({
      committedCents: 0,
      reservedCents: 0,
      unknownUpperBoundCents: 20,
      blocked: true,
      blockReason: "unknown_settlement",
    });
  });
});

describe("task attempt observation window", () => {
  it("rejects a forged plan before reserving budget or dispatching", async () => {
    const canonical = buildTaskEvaluationPlan("site_builder.brand_profile");
    const forged = structuredClone(canonical);
    forged.envelope.maxTokens = 999_999;
    forged.envelope.perCallCostCapCents = 99;
    const guard = new ModelEvaluationBudgetGuard(100);
    const execute = vi.fn();

    await expect(
      runTaskEvaluationAttempt({
        plan: forged,
        candidate: forged.candidates[0],
        caseContract: evaluationCase(forged),
        attempt: 1,
        campaignBudget: guard,
        execute,
        gradeArtifact: () => validAssessment(),
      }),
    ).rejects.toThrow("task evaluation plan is not canonical");
    expect(execute).not.toHaveBeenCalled();
    expect(guard.snapshot()).toMatchObject({
      committedCents: 0,
      reservedCents: 0,
      unknownUpperBoundCents: 0,
    });
  });

  it("rejects an attempt beyond the canonical suite before reserving or dispatching", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[0];
    const guard = new ModelEvaluationBudgetGuard(100);
    const execute = vi.fn();

    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate,
        caseContract: evaluationCase(plan),
        attempt: plan.evaluationSuite!.repeats + 1,
        campaignBudget: guard,
        execute,
        gradeArtifact: () => validAssessment(),
      }),
    ).rejects.toThrow("model evaluation attempt must be within 1..2");
    expect(execute).not.toHaveBeenCalled();
    expect(guard.snapshot()).toMatchObject({
      committedCents: 0,
      reservedCents: 0,
      unknownUpperBoundCents: 0,
    });
  });

  it("keeps waiting after the production runtime deadline and classifies a valid late result", async () => {
    vi.useFakeTimers();
    try {
      const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
      const candidate = plan.candidates[0];
      const guard = new ModelEvaluationBudgetGuard(100);
      const execute = vi.fn(
        async (): Promise<ModelEvaluationCallResult<{ ok: boolean }>> => {
          await new Promise((resolve) =>
            setTimeout(resolve, plan.envelope.runtimeDeadlineMs + 1000),
          );
          return completedCall(candidate.alias, candidate.expectedProtocol, {
            ok: true,
          });
        },
      );

      const pending = runTaskEvaluationAttempt({
        plan,
        candidate,
        caseContract: evaluationCase(plan),
        attempt: 1,
        campaignBudget: guard,
        execute,
        gradeArtifact: () => validAssessment(),
      });
      await vi.advanceTimersByTimeAsync(plan.envelope.runtimeDeadlineMs + 1000);

      await expect(pending).resolves.toMatchObject({
        resultClass: "quality_valid_runtime_late",
        runtimeTiming: "late",
        artifactAccepted: true,
      });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(
        (
          execute.mock.calls[0][0] as {
            maxTokens: number;
            runtimeDeadlineMs: number;
            hardStopMs: number;
          }
        ).maxTokens,
      ).toBe(12_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts only at the task-shaped hard stop and keeps cost unknown", async () => {
    vi.useFakeTimers();
    try {
      const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
      const candidate = plan.candidates[0];
      const guard = new ModelEvaluationBudgetGuard(100);
      let signal: AbortSignal | undefined;
      const pending = runTaskEvaluationAttempt({
        plan,
        candidate,
        caseContract: evaluationCase(plan),
        attempt: 1,
        campaignBudget: guard,
        execute: async (request) => {
          signal = request.signal;
          await new Promise(() => undefined);
          throw new Error("unreachable");
        },
        gradeArtifact: () => validAssessment(),
      });

      await vi.advanceTimersByTimeAsync(plan.envelope.runtimeDeadlineMs + 1);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(plan.envelope.diagnosticObservationMs);

      await expect(pending).resolves.toMatchObject({
        resultClass: "diagnostic_window_exhausted",
        runtimeTiming: "diagnostic_exhausted",
        artifactAccepted: false,
        costSettlement: {
          state: "unknown",
          reason: "diagnostic_hard_stop",
        },
      });
      expect(signal?.aborted).toBe(true);
      expect(guard.snapshot()).toMatchObject({
        blocked: true,
        blockReason: "unknown_settlement",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a completion observed after the hard stop without truncating elapsed time", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[0];
    const guard = new ModelEvaluationBudgetGuard(100);
    const clock = vi
      .fn<() => number>()
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1000 + plan.envelope.hardStopMs + 1);
    const result = await runTaskEvaluationAttempt({
      plan,
      candidate,
      caseContract: evaluationCase(plan),
      attempt: 1,
      campaignBudget: guard,
      execute: async () =>
        completedCall(candidate.alias, candidate.expectedProtocol, {
          ok: true,
        }),
      gradeArtifact: () => validAssessment(),
      now: clock,
    });

    expect(result).toMatchObject({
      resultClass: "diagnostic_window_exhausted",
      runtimeTiming: "diagnostic_exhausted",
      elapsedMs: plan.envelope.hardStopMs + 1,
      artifactAccepted: false,
      failureCode: "completed_after_hard_stop",
      costSettlement: {
        state: "settled",
        amountCents: 1,
        basis: "provider_reported",
      },
    });
  });

  it("preserves an explicit not-incurred provider failure without inventing cost", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[0];
    const guard = new ModelEvaluationBudgetGuard(100);
    const result = await runTaskEvaluationAttempt({
      plan,
      candidate,
      caseContract: evaluationCase(plan),
      attempt: 1,
      campaignBudget: guard,
      execute: async () => {
        throw new ModelEvaluationCallError("transport_unavailable", {
          state: "not_incurred",
          reason: "provider_attested_not_incurred",
        });
      },
      gradeArtifact: () => validAssessment(),
    });

    expect(result).toMatchObject({
      resultClass: "capability_unavailable",
      failureCode: "transport_unavailable",
      costSettlement: {
        state: "not_incurred",
        reason: "provider_attested_not_incurred",
      },
    });
    expect(guard.snapshot()).toMatchObject({
      committedCents: 0,
      reservedCents: 0,
      unknownUpperBoundCents: 0,
      blocked: false,
    });
  });

  it("closes synchronous executor failures as unknown instead of leaking a reservation", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[0];
    const guard = new ModelEvaluationBudgetGuard(100);
    const result = await runTaskEvaluationAttempt({
      plan,
      candidate,
      caseContract: evaluationCase(plan),
      attempt: 1,
      campaignBudget: guard,
      execute: () => {
        throw new Error("synchronous transport failure");
      },
      gradeArtifact: () => validAssessment(),
    });

    expect(result).toMatchObject({
      resultClass: "capability_unavailable",
      failureCode: "unknown_provider_error",
      costSettlement: {
        state: "unknown",
        reason: "provider_ack_unknown",
      },
    });
    expect(guard.snapshot()).toMatchObject({
      reservedCents: 0,
      unknownUpperBoundCents: plan.envelope.perCallCostCapCents,
      blocked: true,
    });
  });

  it("closes a malformed executor result and freezes dispatch without leaking a reservation", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[0];
    const guard = new ModelEvaluationBudgetGuard(100);
    const result = await runTaskEvaluationAttempt({
      plan,
      candidate,
      caseContract: evaluationCase(plan),
      attempt: 1,
      campaignBudget: guard,
      execute: async () => null as never,
      gradeArtifact: () => validAssessment(),
    });

    expect(result).toMatchObject({
      resultClass: "provenance_invalid",
      failureCode: "call_result_invalid",
      costSettlement: {
        state: "unknown",
        reason: "invalid_settlement",
      },
      settlementInvalid: true,
    });
    expect(guard.snapshot()).toMatchObject({
      reservedCents: 0,
      unknownUpperBoundCents: plan.envelope.perCallCostCapCents,
      blocked: true,
      blockReason: "unknown_settlement",
    });
  });

  it("closes grader failures as content-invalid while preserving settlement", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[0];
    const guard = new ModelEvaluationBudgetGuard(100);
    const result = await runTaskEvaluationAttempt({
      plan,
      candidate,
      caseContract: evaluationCase(plan),
      attempt: 1,
      campaignBudget: guard,
      execute: async () =>
        completedCall(candidate.alias, candidate.expectedProtocol, {
          ok: true,
        }),
      gradeArtifact: () => {
        throw new Error("grader contract failure");
      },
    });

    expect(result).toMatchObject({
      resultClass: "content_invalid",
      failureCode: "assessment_failed",
      costSettlement: {
        state: "settled",
        amountCents: 1,
        basis: "provider_reported",
      },
    });
    expect(guard.snapshot()).toMatchObject({
      committedCents: 1,
      reservedCents: 0,
      blocked: false,
    });
  });

  it("closes invalid grader output under the same assessment failure code", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[0];
    const guard = new ModelEvaluationBudgetGuard(100);
    const result = await runTaskEvaluationAttempt({
      plan,
      candidate,
      caseContract: evaluationCase(plan),
      attempt: 1,
      campaignBudget: guard,
      execute: async () =>
        completedCall(candidate.alias, candidate.expectedProtocol, {
          ok: true,
        }),
      gradeArtifact: () => ({
        ...validAssessment(),
        stabilityKey: "contains spaces",
      }),
    });

    expect(result).toMatchObject({
      resultClass: "content_invalid",
      failureCode: "assessment_failed",
      artifactAccepted: false,
    });
    expect(guard.snapshot()).toMatchObject({
      committedCents: 1,
      reservedCents: 0,
    });
  });

  it("preserves raw call identity and rejects invalid usage provenance", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[0];
    const guard = new ModelEvaluationBudgetGuard(100);
    const call = completedCall(candidate.alias, candidate.expectedProtocol, {
      ok: true,
    });
    call.usage = {
      ...call.usage,
      inputTokens: -1,
    };
    const result = await runTaskEvaluationAttempt({
      plan,
      candidate,
      caseContract: evaluationCase(plan),
      attempt: 1,
      campaignBudget: guard,
      execute: async () => call,
      gradeArtifact: () => validAssessment(),
    });

    expect(result).toMatchObject({
      resultClass: "provenance_invalid",
      failureCode: "usage_invalid",
      actualProtocol: candidate.expectedProtocol,
      requestedModel: candidate.alias,
      reportedModel: candidate.alias,
      resolvedModel: candidate.alias,
      modelResolutionSource: "upstream_response",
      artifactSha256: call.artifactSha256,
      usage: null,
    });
  });

  it("marks the current quality result when provider cost exceeds the per-call cap", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[0];
    const guard = new ModelEvaluationBudgetGuard(100);
    const result = await runTaskEvaluationAttempt({
      plan,
      candidate,
      caseContract: evaluationCase(plan),
      attempt: 1,
      campaignBudget: guard,
      execute: async () =>
        completedCall(
          candidate.alias,
          candidate.expectedProtocol,
          { ok: true },
          plan.envelope.perCallCostCapCents + 1,
        ),
      gradeArtifact: () => validAssessment(),
    });

    expect(result).toMatchObject({
      resultClass: "quality_valid_runtime_on_time",
      artifactAccepted: true,
      budgetCapExceeded: true,
      settlementInvalid: false,
    });
    expect(guard.snapshot()).toMatchObject({
      blocked: true,
      blockReason: "per_call_cap_exceeded",
    });
  });
});

describe("quality-first candidate summary and ranking", () => {
  const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
  const suite = plan.evaluationSuite!;

  function run(
    alias: string,
    resultClass: ModelEvaluationRun["resultClass"],
    assessment: TaskArtifactAssessment | null,
    elapsedMs: number,
    amountCents: number | null,
    fixtureId: string,
    attempt: number,
  ): ModelEvaluationRun {
    return {
      schemaVersion: "site-builder-model-evaluation-run/v1",
      harnessId: "site-builder-model-evaluation-harness/2026-07-27-v1",
      candidateBaselineId:
        "site-builder-model-candidate-baseline/2026-07-27-v1",
      taskId: "site_builder.brand_profile",
      profile: "structured.workspace_materials",
      alias,
      expectedProtocol:
        alias === "claude-sonnet-5" ? "anthropic-messages" : "openai-responses",
      actualProtocol:
        alias === "claude-sonnet-5" ? "anthropic-messages" : "openai-responses",
      requestedModel: alias,
      reportedModel: alias,
      resolvedModel: alias,
      modelResolutionSource: "upstream_response",
      evaluationSuiteId: suite.suiteId,
      adapterId: suite.adapterId,
      taskContractFingerprint: taskEvaluationContractFingerprint(suite),
      fixtureSetId: suite.fixtureSetId,
      sourceBundleContractId: suite.sourceBundleContractId,
      fixtureId,
      fixtureSha256: suite.fixtureFingerprints.find(
        (entry) => entry.fixtureId === fixtureId,
      )!.fixtureSha256,
      promptSha256: suite.fixtureFingerprints.find(
        (entry) => entry.fixtureId === fixtureId,
      )!.promptSha256,
      sourceBundleSha256: "c".repeat(64),
      evaluatorVersion: suite.evaluatorVersion,
      evaluatorRubricSha256: suite.evaluatorRubricSha256,
      artifactSha256: "d".repeat(64),
      attempt,
      resultClass,
      runtimeTiming:
        resultClass === "quality_valid_runtime_late" ? "late" : "on_time",
      elapsedMs,
      protocolVerified: true,
      identityVerified: true,
      artifactAccepted: resultClass.startsWith("quality_valid_"),
      assessment,
      costSettlement:
        amountCents === null
          ? { state: "unknown", reason: "provider_ack_unknown" }
          : {
              state: "settled",
              amountCents,
              basis: "provider_reported",
            },
      budgetCapExceeded: false,
      settlementInvalid: false,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        callCount: 1,
        source: "provider_reported",
      },
      failureCode: resultClass === "content_invalid" ? "content_invalid" : null,
    };
  }

  function fullMatrix(
    alias: string,
    build: (
      fixtureId: string,
      attempt: number,
      index: number,
    ) => Omit<ModelEvaluationRun, "fixtureId" | "attempt">,
  ): ModelEvaluationRun[] {
    const runs: ModelEvaluationRun[] = [];
    let index = 0;
    for (const fixtureId of suite.fixtureIds) {
      for (let attempt = 1; attempt <= suite.repeats; attempt += 1) {
        runs.push({ ...build(fixtureId, attempt, index), fixtureId, attempt });
        index += 1;
      }
    }
    return runs;
  }

  function acceptedRun(
    alias: string,
    fixtureId: string,
    attempt: number,
    assessment = validAssessment(`${fixtureId}-stable`),
    elapsedMs = 1000,
    amountCents: number | null = 1,
  ): ModelEvaluationRun {
    return run(
      alias,
      "quality_valid_runtime_on_time",
      assessment,
      elapsedMs,
      amountCents,
      fixtureId,
      attempt,
    );
  }

  it("orders quality, structure, factuality, stability, P95, then accepted cost", () => {
    const highQualitySlow = summarizeModelEvaluationCandidate(
      plan,
      "gpt-5.5",
      fullMatrix("gpt-5.5", (fixtureId, attempt, index) => {
        const {
          fixtureId: _fixtureId,
          attempt: _attempt,
          ...record
        } = acceptedRun(
          "gpt-5.5",
          fixtureId,
          attempt,
          validAssessment(`${fixtureId}-stable`),
          index % 2 === 0 ? 110_000 : 120_000,
          5,
        );
        return record;
      }),
    );
    const lowerQualityFast = summarizeModelEvaluationCandidate(
      plan,
      "claude-sonnet-5",
      fullMatrix("claude-sonnet-5", (fixtureId, attempt, index) => {
        const record =
          index === 0
            ? run(
                "claude-sonnet-5",
                "content_invalid",
                {
                  ...validAssessment(`${fixtureId}-stable`),
                  qualityPassed: false,
                  findingCodes: ["quality_failure"],
                },
                1000,
                1,
                fixtureId,
                attempt,
              )
            : acceptedRun(
                "claude-sonnet-5",
                fixtureId,
                attempt,
                validAssessment(`${fixtureId}-stable`),
              );
        const {
          fixtureId: _fixtureId,
          attempt: _attempt,
          ...withoutKey
        } = record;
        return withoutKey;
      }),
    );

    expect(
      rankModelEvaluationCandidates([lowerQualityFast, highQualitySlow]).map(
        (summary) => summary.alias,
      ),
    ).toEqual(["gpt-5.5", "claude-sonnet-5"]);
    expect(highQualitySlow.acceptedArtifactCostCents).toBe(5);
  });

  it("keeps unknown settlement unrankable instead of treating it as zero", () => {
    const summary = summarizeModelEvaluationCandidate(
      plan,
      "gpt-5.5",
      fullMatrix("gpt-5.5", (fixtureId, attempt, index) => {
        const {
          fixtureId: _fixtureId,
          attempt: _attempt,
          ...record
        } = acceptedRun(
          "gpt-5.5",
          fixtureId,
          attempt,
          validAssessment(`${fixtureId}-stable`),
          1000,
          index === 0 ? null : 1,
        );
        return record;
      }),
    );
    expect(summary).toMatchObject({
      rankable: false,
      acceptedArtifactCostCents: null,
      costSettlementComplete: false,
    });
  });

  it("keeps quality observations but makes an over-cap run unrankable", () => {
    const runs = fullMatrix("gpt-5.5", (fixtureId, attempt) => {
      const record = acceptedRun("gpt-5.5", fixtureId, attempt);
      const {
        fixtureId: _fixtureId,
        attempt: _attempt,
        ...withoutKey
      } = record;
      return withoutKey;
    });
    runs[0].budgetCapExceeded = true;
    runs[0].costSettlement = {
      state: "settled",
      amountCents: plan.envelope.perCallCostCapCents + 1,
      basis: "provider_reported",
    };

    const summary = summarizeModelEvaluationCandidate(plan, "gpt-5.5", runs);
    expect(summary).toMatchObject({
      acceptedArtifactCount: 12,
      hardFailureCount: 1,
      rankable: false,
    });
  });

  it("computes stability within each fixture instead of across unrelated fixtures", () => {
    const summary = summarizeModelEvaluationCandidate(
      plan,
      "gpt-5.5",
      fullMatrix("gpt-5.5", (fixtureId, attempt) => {
        const {
          fixtureId: _fixtureId,
          attempt: _attempt,
          ...record
        } = acceptedRun(
          "gpt-5.5",
          fixtureId,
          attempt,
          validAssessment(`${fixtureId}-output`),
        );
        return record;
      }),
    );

    expect(summary).toMatchObject({
      matrixComplete: true,
      stabilityRate: 1,
    });
  });

  it("rejects a non-canonical fixture before computing a matrix", () => {
    const runs = fullMatrix("gpt-5.5", (fixtureId, attempt) => {
      const {
        fixtureId: _fixtureId,
        attempt: _attempt,
        ...record
      } = acceptedRun("gpt-5.5", fixtureId, attempt);
      return record;
    });
    runs[0].fixtureId = "unexpected-fixture";
    expect(() =>
      summarizeModelEvaluationCandidate(plan, "gpt-5.5", runs),
    ).toThrow("candidate summary contains a non-canonical run");
  });

  it("rejects tampered protocol, fixture and cost provenance before ranking", () => {
    const runs = fullMatrix("gpt-5.5", (fixtureId, attempt) => {
      const {
        fixtureId: _fixtureId,
        attempt: _attempt,
        ...record
      } = acceptedRun("gpt-5.5", fixtureId, attempt);
      return record;
    });
    runs[0].actualProtocol = "openai-chat-completions";
    runs[0].sourceBundleSha256 = "e".repeat(64);
    runs[0].costSettlement = {
      state: "settled",
      amountCents: plan.envelope.perCallCostCapCents + 1,
      basis: "provider_reported",
    };

    expect(() =>
      summarizeModelEvaluationCandidate(plan, "gpt-5.5", runs),
    ).toThrow("candidate summary contains a non-canonical run");
  });

  it("implements the full lexicographic policy before latency and cost", () => {
    const base: ModelEvaluationCandidateSummary = {
      harnessId: "site-builder-model-evaluation-harness/2026-07-27-v1",
      candidateBaselineId:
        "site-builder-model-candidate-baseline/2026-07-27-v1",
      taskId: "site_builder.brand_profile",
      profile: "structured.workspace_materials",
      evaluationSuiteId: suite.suiteId,
      taskContractFingerprint: taskEvaluationContractFingerprint(suite),
      sourceBundleContractId: suite.sourceBundleContractId,
      sourceBundleSha256: "c".repeat(64),
      alias: "base",
      expectedRunCount: 2,
      actualRunCount: 2,
      matrixComplete: true,
      acceptedArtifactCount: 2,
      qualityRate: 1,
      structureRate: 1,
      factualityRate: 1,
      stabilityRate: 1,
      p95LatencyMs: 1000,
      acceptedArtifactCostCents: 1,
      costSettlementComplete: true,
      rankable: true,
      hardFailureCount: 0,
    };
    const summaries: ModelEvaluationCandidateSummary[] = [
      { ...base, alias: "cost", acceptedArtifactCostCents: 2 },
      { ...base, alias: "latency", p95LatencyMs: 2000 },
      { ...base, alias: "stability", stabilityRate: 0.9 },
      { ...base, alias: "factuality", factualityRate: 0.9 },
      { ...base, alias: "structure", structureRate: 0.9 },
      { ...base, alias: "quality", qualityRate: 0.9 },
      { ...base, alias: "best" },
    ];

    expect(
      rankModelEvaluationCandidates(summaries).map((summary) => summary.alias),
    ).toEqual([
      "best",
      "cost",
      "latency",
      "stability",
      "factuality",
      "structure",
      "quality",
    ]);
  });

  it("rejects candidate summaries from different pinned source bundles", () => {
    const base: ModelEvaluationCandidateSummary = {
      harnessId: "site-builder-model-evaluation-harness/2026-07-27-v1",
      candidateBaselineId:
        "site-builder-model-candidate-baseline/2026-07-27-v1",
      taskId: "site_builder.brand_profile",
      profile: "structured.workspace_materials",
      evaluationSuiteId: suite.suiteId,
      taskContractFingerprint: taskEvaluationContractFingerprint(suite),
      sourceBundleContractId: suite.sourceBundleContractId,
      sourceBundleSha256: "c".repeat(64),
      alias: "gpt-5.5",
      expectedRunCount: 12,
      actualRunCount: 12,
      matrixComplete: true,
      acceptedArtifactCount: 12,
      qualityRate: 1,
      structureRate: 1,
      factualityRate: 1,
      stabilityRate: 1,
      p95LatencyMs: 1000,
      acceptedArtifactCostCents: 1,
      costSettlementComplete: true,
      rankable: true,
      hardFailureCount: 0,
    };
    expect(() =>
      rankModelEvaluationCandidates([
        base,
        {
          ...base,
          alias: "claude-sonnet-5",
          sourceBundleSha256: "d".repeat(64),
        },
      ]),
    ).toThrow("candidate summaries do not share one evaluation scope");
  });
});
