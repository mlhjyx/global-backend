import { beforeEach, describe, expect, it, vi } from "vitest";

const { trustedExecutorIdentity, trustedCostSafety } = vi.hoisted(() => ({
  trustedExecutorIdentity: Object.freeze({}),
  trustedCostSafety: Object.freeze({
    credential: Object.freeze({
      snapshotSha256:
        "1111111111111111111111111111111111111111111111111111111111111111",
      allowedDispatches: Object.freeze([
        Object.freeze({
          mode: "target",
          alias: "gpt-5.6-terra",
          protocol: "openai-responses",
        }),
        Object.freeze({
          mode: "target",
          alias: "claude-sonnet-5",
          protocol: "anthropic-messages",
        }),
        Object.freeze({
          mode: "target",
          alias: "gpt-5.5",
          protocol: "openai-responses",
        }),
        Object.freeze({
          mode: "legacy_comparator",
          alias: "deepseek-v4-pro",
          protocol: "openai-chat-completions",
        }),
        Object.freeze({
          mode: "legacy_comparator",
          alias: "glm-5.2",
          protocol: "openai-chat-completions",
        }),
      ]),
    }),
    pricing: Object.freeze({
      snapshotSha256:
        "2222222222222222222222222222222222222222222222222222222222222222",
    }),
    limits: Object.freeze({
      campaignBudgetCents: 10_000,
      maxDispatchExecutions: 500,
      maxWireCalls: 1_000,
      maxOutputTokensPerCall: 100_000,
    }),
  }),
}));

vi.mock("./model-evaluation-executor", () => ({
  freezeModelEvaluationProtocolExecutor: () => true,
  isTrustedModelEvaluationProtocolExecute: () => true,
  modelEvaluationProtocolExecutorIdentity: () => trustedExecutorIdentity,
  modelEvaluationProtocolExecutorCostSafety: () => trustedCostSafety,
}));

import {
  ModelEvaluationBudgetGuard,
  ModelEvaluationCallError,
  ModelEvaluationCapabilityCampaign,
  buildAllTaskEvaluationPlans,
  buildCanonicalModelEvaluationCase,
  buildProfileEvaluationAdmission,
  buildTaskEvaluationPlan,
  classifyCompletedTaskResult,
  rankModelEvaluationCandidates as rankModelEvaluationCandidatesRaw,
  runTaskEvaluationAttempt,
  summarizeModelEvaluationCandidate as summarizeModelEvaluationCandidateRaw,
  validateCapabilityProbe,
  type ModelEvaluationCallResult,
  type ModelEvaluationRun,
  type TaskArtifactAssessment,
} from "./model-evaluation-harness";
import {
  BRAND_PROFILE_TASK,
  type BrandProfileOutput,
} from "../agents/brand-profile";
import { sha256CanonicalJson, sha256Text } from "./eval-provenance";

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
      basis: "provider_reported@fake-settlement/v1",
    },
  };
}

function canonicalAcceptedArtifact(
  fixtureId = "auto-parts-rich",
): BrandProfileOutput {
  const evaluationCase = buildCanonicalModelEvaluationCase(
    buildTaskEvaluationPlan("site_builder.brand_profile"),
    fixtureId,
  );
  const sources = [
    evaluationCase.payload.taskInput.intakeSource,
    ...evaluationCase.payload.taskInput.kbSources,
    ...evaluationCase.payload.taskInput.research,
  ];
  const facts =
    evaluationCase.payload.fixture.assertions.requiredAcceptedTerms.map(
      (term) => {
        const source = sources.find((entry) =>
          entry.content.toLowerCase().includes(term.toLowerCase()),
        );
        if (!source) {
          throw new Error(`test requires canonical evidence for ${term}`);
        }
        const index = source.content.toLowerCase().indexOf(term.toLowerCase());
        const quote = source.content.slice(
          Math.max(0, index - 120),
          Math.min(source.content.length, index + term.length + 120),
        );
        return {
          key: "products",
          value: term,
          evidence: {
            sourceType: source.sourceType,
            sourceId: source.sourceId,
            contentHash: source.contentHash,
            quote,
          },
        };
      },
    );
  return {
    valueProps: [],
    glossary: [],
    keywords: [],
    differentiators: [],
    competitors: [],
    gaps: [],
    factSheet: facts,
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
            preflight: "none",
          },
          {
            alias: "claude-sonnet-5",
            status: "runnable",
            expectedProtocol: "anthropic-messages",
            preflight: "none",
          },
          {
            alias: "gpt-5.5",
            status: "runnable",
            expectedProtocol: "openai-responses",
            preflight: "capability_probe",
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

  it("deep-freezes the canonical suite and rejects a forged source path", () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const suite = plan.evaluationSuite!;
    const originalPath = suite.sourceBundleFiles[0].path;
    expect(Object.isFrozen(suite)).toBe(true);
    expect(Object.isFrozen(suite.sourceBundleFiles)).toBe(true);
    expect(Object.isFrozen(suite.sourceBundleFiles[0])).toBe(true);
    expect(suite.sourceBundleFiles).toContainEqual({
      role: "claim_fact_key",
      path: "apps/api/src/site-builder/claim-fact-key.ts",
    });
    expect(() => {
      (suite.sourceBundleFiles[0] as { path: string }).path = "/etc/passwd";
    }).toThrow(TypeError);
    expect(suite.sourceBundleFiles[0].path).toBe(originalPath);

    const forged = structuredClone(plan);
    (forged.evaluationSuite!.sourceBundleFiles[0] as { path: string }).path =
      "../../../../etc/passwd";
    expect(() =>
      buildCanonicalModelEvaluationCase(forged, "auto-parts-rich"),
    ).toThrow("task evaluation plan is not canonical");
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
      basis: "provider_reported@fake-settlement/v1",
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

  it("reserves a bounded repair call up front without relaxing the attempt cap", () => {
    const guard = new ModelEvaluationBudgetGuard(100);
    expect(guard.reserve("repairable-call", 20, 2)).toEqual({
      allowed: true,
      reservation: { callId: "repairable-call", reservedCents: 40 },
    });
    expect(guard.snapshot()).toMatchObject({
      reservedCents: 40,
      remainingDispatchableCents: 60,
    });
    expect(
      guard.settle("repairable-call", {
        state: "settled",
        amountCents: 19,
        basis: "provider_reported@fake-settlement/v1",
      }),
    ).toMatchObject({
      capExceeded: false,
      settlementInvalid: false,
    });
    expect(guard.snapshot()).toMatchObject({
      committedCents: 19,
      reservedCents: 0,
      blocked: false,
    });

    expect(guard.reserve("single-call", 20, 2).allowed).toBe(true);
    expect(
      guard.settle("single-call", {
        state: "settled",
        amountCents: 21,
        basis: "provider_reported@fake-settlement/v1",
      }),
    ).toMatchObject({
      capExceeded: true,
      settlementInvalid: false,
    });
    expect(guard.snapshot()).toMatchObject({
      blocked: true,
      blockReason: "per_call_cap_exceeded",
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
      basis: "provider_reported@fake-settlement/v1",
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

  it("rejects settled cost without an audited resolver identity", () => {
    const guard = new ModelEvaluationBudgetGuard(50);
    expect(guard.reserve("call-1", 20).allowed).toBe(true);
    expect(
      guard.settle("call-1", {
        state: "settled",
        amountCents: 7,
        basis: "provider_reported",
      }),
    ).toEqual({
      settlement: {
        state: "unknown",
        reason: "invalid_settlement",
      },
      capExceeded: false,
      settlementInvalid: true,
    });
    expect(guard.snapshot()).toMatchObject({
      committedCents: 0,
      unknownUpperBoundCents: 20,
      blocked: true,
      blockReason: "unknown_settlement",
    });
  });

  it("rejects duck and Proxy budgets before campaign or matrix dispatch", async () => {
    const duckBudget = {
      reserve: () => ({
        allowed: true,
        reservation: { callId: "forged", reservedCents: 0 },
      }),
      settle: () => ({
        settlement: {
          state: "settled",
          amountCents: 0,
          basis: "provider_reported@fake-settlement/v1",
        },
        capExceeded: false,
        settlementInvalid: false,
      }),
    };
    expect(
      () => new ModelEvaluationCapabilityCampaign(duckBudget as never),
    ).toThrow("trusted model evaluation budget guard is required");

    const realGuard = new ModelEvaluationBudgetGuard(100);
    const proxiedGuard = new Proxy(realGuard, {});
    expect(() => new ModelEvaluationCapabilityCampaign(proxiedGuard)).toThrow(
      "trusted model evaluation budget guard is required",
    );

    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[0];
    const execute = vi.fn();
    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate,
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: duckBudget as never,
        execute,
      }),
    ).rejects.toThrow("trusted model evaluation budget guard is required");
    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate,
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: proxiedGuard,
        execute,
      }),
    ).rejects.toThrow("trusted model evaluation budget guard is required");
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses captured budget methods despite instance and prototype monkeypatches", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const probeCandidate = plan.candidates.find(
      (entry) => entry.alias === "gpt-5.5",
    )!;
    const guard = new ModelEvaluationBudgetGuard(100);
    const instanceReserve = vi.fn();
    const instanceSettle = vi.fn();
    Object.defineProperties(guard, {
      reserve: { configurable: true, value: instanceReserve },
      settle: { configurable: true, value: instanceSettle },
    });
    const campaign = new ModelEvaluationCapabilityCampaign(guard);
    await expect(
      campaign.runCanonicalProbe({
        plan,
        candidate: probeCandidate,
        execute: async () =>
          completedCall(
            probeCandidate.alias,
            probeCandidate.expectedProtocol,
            canonicalAcceptedArtifact(),
          ),
      }),
    ).resolves.toMatchObject({ status: "capability_proven" });
    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate: probeCandidate,
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: guard,
        capabilityCampaign: campaign,
        execute: async () =>
          completedCall(
            probeCandidate.alias,
            probeCandidate.expectedProtocol,
            canonicalAcceptedArtifact(),
          ),
      }),
    ).resolves.toMatchObject({
      resultClass: "quality_valid_runtime_on_time",
    });
    expect(instanceReserve).not.toHaveBeenCalled();
    expect(instanceSettle).not.toHaveBeenCalled();
    expect(guard.snapshot()).toMatchObject({ committedCents: 2 });

    const prototype = ModelEvaluationBudgetGuard.prototype;
    const originalReserve = prototype.reserve;
    const originalSettle = prototype.settle;
    const prototypeReserve = vi.fn();
    const prototypeSettle = vi.fn();
    prototype.reserve = prototypeReserve as never;
    prototype.settle = prototypeSettle as never;
    try {
      const secondGuard = new ModelEvaluationBudgetGuard(100);
      const candidate = plan.candidates[0];
      await expect(
        runTaskEvaluationAttempt({
          plan,
          candidate,
          fixtureId: "auto-parts-rich",
          attempt: 1,
          campaignBudget: secondGuard,
          execute: async () =>
            completedCall(
              candidate.alias,
              candidate.expectedProtocol,
              canonicalAcceptedArtifact(),
            ),
        }),
      ).resolves.toMatchObject({
        resultClass: "quality_valid_runtime_on_time",
      });
      expect(prototypeReserve).not.toHaveBeenCalled();
      expect(prototypeSettle).not.toHaveBeenCalled();
      expect(secondGuard.snapshot()).toMatchObject({ committedCents: 1 });
    } finally {
      prototype.reserve = originalReserve;
      prototype.settle = originalSettle;
    }
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
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: guard,
        execute,
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
        fixtureId: "auto-parts-rich",
        attempt: plan.evaluationSuite!.repeats + 1,
        campaignBudget: guard,
        execute,
      }),
    ).rejects.toThrow("model evaluation attempt must be within 1..2");
    expect(execute).not.toHaveBeenCalled();
    expect(guard.snapshot()).toMatchObject({
      committedCents: 0,
      reservedCents: 0,
      unknownUpperBoundCents: 0,
    });
  });

  it("requires a candidate-bound capability probe before dispatch or budget reservation", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates.find(
      (entry) => entry.alias === "gpt-5.5",
    )!;
    const guard = new ModelEvaluationBudgetGuard(100);
    const execute = vi.fn();

    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate,
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: guard,
        execute,
      }),
    ).rejects.toThrow("canonical campaign capability probe is required");
    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate,
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: guard,
        capabilityCampaign: new ModelEvaluationCapabilityCampaign(guard),
        execute,
      }),
    ).rejects.toThrow("canonical campaign capability probe is required");
    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate,
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: guard,
        capabilityCampaign: {
          attestationFor: () => ({ forged: true }),
        } as never,
        execute,
      }),
    ).rejects.toThrow("canonical campaign capability probe is required");
    expect(execute).not.toHaveBeenCalled();
    expect(guard.snapshot()).toMatchObject({
      committedCents: 0,
      reservedCents: 0,
      unknownUpperBoundCents: 0,
    });
  });

  it("does not unlock matrix dispatch from a probe with forged model identity", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates.find(
      (entry) => entry.alias === "gpt-5.5",
    )!;
    const guard = new ModelEvaluationBudgetGuard(100);
    const campaign = new ModelEvaluationCapabilityCampaign(guard);
    await expect(
      campaign.runCanonicalProbe({
        plan,
        candidate,
        execute: async () => {
          const result = completedCall(
            candidate.alias,
            candidate.expectedProtocol,
            canonicalAcceptedArtifact(),
          );
          result.resolvedModel = "gpt-5.6-terra";
          return result;
        },
      }),
    ).resolves.toMatchObject({
      status: "identity_unproven",
      identityVerified: false,
    });

    const execute = vi.fn();
    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate,
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: guard,
        capabilityCampaign: campaign,
        execute,
      }),
    ).rejects.toThrow("canonical campaign capability probe is required");
    expect(execute).not.toHaveBeenCalled();
    expect(guard.snapshot()).toMatchObject({
      committedCents: 1,
      reservedCents: 0,
    });
  });

  it("settles malformed capability probe results as unknown without leaking reservations", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates.find(
      (entry) => entry.alias === "gpt-5.5",
    )!;

    for (const malformed of [null, {}]) {
      const guard = new ModelEvaluationBudgetGuard(100);
      const campaign = new ModelEvaluationCapabilityCampaign(guard);
      await expect(
        campaign.runCanonicalProbe({
          plan,
          candidate,
          execute: async () => malformed as never,
        }),
      ).resolves.toMatchObject({
        status: "provenance_invalid",
        protocolVerified: false,
        identityVerified: false,
        outputVerified: false,
      });
      expect(guard.snapshot()).toMatchObject({
        committedCents: 0,
        reservedCents: 0,
        unknownUpperBoundCents: plan.envelope.perCallCostCapCents * 2,
        blocked: true,
        blockReason: "unknown_settlement",
      });
    }
  });

  it("freezes the campaign when a dispatched probe falsely claims pre-dispatch zero cost", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates.find(
      (entry) => entry.alias === "gpt-5.5",
    )!;
    const guard = new ModelEvaluationBudgetGuard(100);
    const campaign = new ModelEvaluationCapabilityCampaign(guard);
    await expect(
      campaign.runCanonicalProbe({
        plan,
        candidate,
        execute: async () => {
          throw new ModelEvaluationCallError("probe_failed", {
            state: "not_incurred",
            reason: "rejected_before_dispatch",
          });
        },
      }),
    ).resolves.toMatchObject({
      status: "capability_unavailable",
    });
    expect(guard.snapshot()).toMatchObject({
      committedCents: 0,
      reservedCents: 0,
      unknownUpperBoundCents: plan.envelope.perCallCostCapCents * 2,
      blocked: true,
      blockReason: "unknown_settlement",
    });
  });

  it("admits a probed candidate and binds structured-output repair semantics", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates.find(
      (entry) => entry.alias === "gpt-5.5",
    )!;
    const guard = new ModelEvaluationBudgetGuard(100);
    const campaign = new ModelEvaluationCapabilityCampaign(guard);
    const probeExecute = vi.fn(async (request) => {
      expect(request.probeKind).toBe("canonical_task_shaped_capability");
      expect(request.campaignId).toBe(campaign.campaignId);
      expect(request.caseContract.sourceBundleSha256).toBe(
        sha256CanonicalJson(request.casePayload.sourceFiles),
      );
      return completedCall(
        candidate.alias,
        candidate.expectedProtocol,
        canonicalAcceptedArtifact(),
      );
    });
    await expect(
      campaign.runCanonicalProbe({
        plan,
        candidate,
        execute: probeExecute,
      }),
    ).resolves.toMatchObject({
      status: "capability_proven",
      protocolVerified: true,
      identityVerified: true,
      outputVerified: true,
    });
    const execute = vi.fn(async (request) => {
      expect(request.repairTaskOutput).toBe(true);
      expect(request.caseContract.repairTaskOutput).toBe(true);
      expect(request.caseContract.outputSchemaSha256).toBe(
        sha256CanonicalJson(request.outputSchema),
      );
      expect(Object.isFrozen(request.outputSchema)).toBe(true);
      return completedCall(
        candidate.alias,
        candidate.expectedProtocol,
        canonicalAcceptedArtifact(),
      );
    });

    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate,
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: guard,
        capabilityCampaign: campaign,
        execute,
      }),
    ).resolves.toMatchObject({
      resultClass: "quality_valid_runtime_on_time",
      artifactAccepted: true,
      capabilityProbeAttestation: {
        campaignId: campaign.campaignId,
        alias: candidate.alias,
      },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(probeExecute).toHaveBeenCalledTimes(1);
  });

  it("reuses a canonical probe attestation without dispatch or budget mutation", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates.find(
      (entry) => entry.alias === "gpt-5.5",
    )!;
    const guard = new ModelEvaluationBudgetGuard(100);
    const campaign = new ModelEvaluationCapabilityCampaign(guard);
    const execute = vi.fn(async () =>
      completedCall(
        candidate.alias,
        candidate.expectedProtocol,
        canonicalAcceptedArtifact(),
      ),
    );

    const first = await campaign.runCanonicalProbe({
      plan,
      candidate,
      execute,
    });
    const attestation = campaign.attestationFor(plan, candidate, guard);
    const budgetAfterFirst = guard.snapshot();
    const duplicate = await campaign.runCanonicalProbe({
      plan,
      candidate,
      execute,
    });

    expect(first).toMatchObject({ status: "capability_proven" });
    expect(duplicate).toEqual(first);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(campaign.attestationFor(plan, candidate, guard)).toBe(attestation);
    expect(guard.snapshot()).toEqual(budgetAfterFirst);
  });

  it("dispatches the exact frozen fixture, task input, prompt, and source bundle bound by the case contract", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[0];
    const guard = new ModelEvaluationBudgetGuard(100);
    const execute = vi.fn(async (request) => {
      expect(request.caseContract.fixtureSha256).toBe(
        sha256CanonicalJson(request.casePayload.fixture),
      );
      expect(request.caseContract.promptSha256).toBe(
        sha256Text(request.casePayload.prompt),
      );
      expect(request.caseContract.sourceBundleSha256).toBe(
        sha256CanonicalJson(request.casePayload.sourceFiles),
      );
      expect(request.casePayload.prompt).toContain(
        request.casePayload.taskInput.companyName,
      );
      expect(request.casePayload.sourceFiles.length).toBeGreaterThan(20);
      expect(Object.isFrozen(request.casePayload)).toBe(true);
      expect(Object.isFrozen(request.casePayload.taskInput)).toBe(true);
      expect(Object.isFrozen(request.casePayload.sourceFiles)).toBe(true);
      return completedCall(
        candidate.alias,
        candidate.expectedProtocol,
        canonicalAcceptedArtifact(),
      );
    });

    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate,
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: guard,
        execute,
      }),
    ).resolves.toMatchObject({
      resultClass: "quality_valid_runtime_on_time",
      artifactAccepted: true,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting after the production runtime deadline and classifies a valid late result", async () => {
    vi.useFakeTimers();
    try {
      const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
      const candidate = plan.candidates[0];
      const guard = new ModelEvaluationBudgetGuard(100);
      const execute = vi.fn(
        async (): Promise<ModelEvaluationCallResult<BrandProfileOutput>> => {
          await new Promise((resolve) =>
            setTimeout(resolve, plan.envelope.runtimeDeadlineMs + 1000),
          );
          return completedCall(
            candidate.alias,
            candidate.expectedProtocol,
            canonicalAcceptedArtifact(),
          );
        },
      );

      const pending = runTaskEvaluationAttempt({
        plan,
        candidate,
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: guard,
        execute,
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
      const clock = vi
        .fn<() => number>()
        .mockReturnValueOnce(1000)
        .mockReturnValueOnce(1000 + plan.envelope.hardStopMs + 37);
      const pending = runTaskEvaluationAttempt({
        plan,
        candidate,
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: guard,
        execute: async (request) => {
          signal = request.signal;
          await new Promise(() => undefined);
          throw new Error("unreachable");
        },
        now: clock,
      });

      await vi.advanceTimersByTimeAsync(plan.envelope.runtimeDeadlineMs + 1);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(plan.envelope.diagnosticObservationMs);

      await expect(pending).resolves.toMatchObject({
        resultClass: "diagnostic_window_exhausted",
        runtimeTiming: "diagnostic_exhausted",
        elapsedMs: plan.envelope.hardStopMs + 37,
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

  it("fails closed when the hard-stop timer cannot obtain valid monotonic elapsed time", async () => {
    vi.useFakeTimers();
    try {
      const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
      const candidate = plan.candidates[0];
      const pending = runTaskEvaluationAttempt({
        plan,
        candidate,
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: new ModelEvaluationBudgetGuard(100),
        execute: async () => new Promise(() => undefined),
        now: vi
          .fn<() => number>()
          .mockReturnValueOnce(1000)
          .mockReturnValueOnce(999),
      });
      await vi.advanceTimersByTimeAsync(plan.envelope.hardStopMs);
      await expect(pending).resolves.toMatchObject({
        resultClass: "capability_unavailable",
        runtimeTiming: "not_started",
        elapsedMs: 0,
        failureCode: "monotonic_clock_invalid",
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
      fixtureId: "auto-parts-rich",
      attempt: 1,
      campaignBudget: guard,
      execute: async () =>
        completedCall(
          candidate.alias,
          candidate.expectedProtocol,
          canonicalAcceptedArtifact(),
        ),
      now: clock,
    });

    expect(result).toMatchObject({
      resultClass: "diagnostic_window_exhausted",
      runtimeTiming: "diagnostic_exhausted",
      elapsedMs: plan.envelope.hardStopMs + 1,
      artifactAccepted: false,
      failureCode: "completed_after_hard_stop",
      costSettlement: {
        state: "unknown",
        reason: "diagnostic_hard_stop",
      },
    });
    expect(guard.snapshot()).toMatchObject({
      blocked: true,
      blockReason: "unknown_settlement",
    });
  });

  it("freezes a failed outcome observed after the hard stop", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[0];
    const guard = new ModelEvaluationBudgetGuard(100);
    const clock = vi
      .fn<() => number>()
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1000 + plan.envelope.hardStopMs + 1);

    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate,
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: guard,
        execute: async () => {
          throw new ModelEvaluationCallError("provider_unavailable", {
            state: "settled",
            amountCents: 1,
            basis: "provider_reported@fake-settlement/v1",
          });
        },
        now: clock,
      }),
    ).resolves.toMatchObject({
      resultClass: "diagnostic_window_exhausted",
      runtimeTiming: "diagnostic_exhausted",
      costSettlement: {
        state: "unknown",
        reason: "diagnostic_hard_stop",
      },
    });
    expect(guard.snapshot()).toMatchObject({
      blocked: true,
      blockReason: "unknown_settlement",
    });
  });

  it("freezes a capability probe completion observed after the hard stop", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates.find(
      (entry) => entry.alias === "gpt-5.5",
    )!;
    const guard = new ModelEvaluationBudgetGuard(100);
    const campaign = new ModelEvaluationCapabilityCampaign(guard);
    const clock = vi
      .fn<() => number>()
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1000 + plan.envelope.hardStopMs + 1);

    await expect(
      campaign.runCanonicalProbe({
        plan,
        candidate,
        execute: async () =>
          completedCall(
            candidate.alias,
            candidate.expectedProtocol,
            canonicalAcceptedArtifact(),
          ),
        now: clock,
      }),
    ).resolves.toMatchObject({
      status: "diagnostic_window_exhausted",
      protocolVerified: false,
      identityVerified: false,
      outputVerified: false,
    });
    expect(guard.snapshot()).toMatchObject({
      blocked: true,
      blockReason: "unknown_settlement",
    });
  });

  it("preserves an explicit not-incurred provider failure without inventing cost", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[0];
    const guard = new ModelEvaluationBudgetGuard(100);
    const result = await runTaskEvaluationAttempt({
      plan,
      candidate,
      fixtureId: "auto-parts-rich",
      attempt: 1,
      campaignBudget: guard,
      execute: async () => {
        throw new ModelEvaluationCallError("transport_unavailable", {
          state: "not_incurred",
          reason: "provider_attested_not_incurred",
        });
      },
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

  it("reserves rejected-before-dispatch for the local budget-denial path", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[0];
    const guard = new ModelEvaluationBudgetGuard(100);
    const result = await runTaskEvaluationAttempt({
      plan,
      candidate,
      fixtureId: "auto-parts-rich",
      attempt: 1,
      campaignBudget: guard,
      execute: async () => {
        throw new ModelEvaluationCallError("executor_rejected", {
          state: "not_incurred",
          reason: "rejected_before_dispatch",
        });
      },
    });

    expect(result).toMatchObject({
      resultClass: "capability_unavailable",
      failureCode: "post_dispatch_settlement_incoherent",
      costSettlement: {
        state: "unknown",
        reason: "invalid_settlement",
      },
      settlementInvalid: true,
    });
    expect(guard.snapshot()).toMatchObject({
      unknownUpperBoundCents: plan.envelope.perCallCostCapCents * 2,
      blocked: true,
      blockReason: "unknown_settlement",
    });
  });

  it("closes synchronous executor failures as unknown instead of leaking a reservation", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[0];
    const guard = new ModelEvaluationBudgetGuard(100);
    const result = await runTaskEvaluationAttempt({
      plan,
      candidate,
      fixtureId: "auto-parts-rich",
      attempt: 1,
      campaignBudget: guard,
      execute: () => {
        throw new Error("synchronous transport failure");
      },
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
      unknownUpperBoundCents: plan.envelope.perCallCostCapCents * 2,
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
      fixtureId: "auto-parts-rich",
      attempt: 1,
      campaignBudget: guard,
      execute: async () => null as never,
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
      unknownUpperBoundCents: plan.envelope.perCallCostCapCents * 2,
      blocked: true,
      blockReason: "unknown_settlement",
    });
  });

  it("rejects a completed call that claims no cost was incurred", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[0];
    const guard = new ModelEvaluationBudgetGuard(100);
    const call = completedCall(
      candidate.alias,
      candidate.expectedProtocol,
      canonicalAcceptedArtifact(),
    );
    call.costSettlement = {
      state: "not_incurred",
      reason: "rejected_before_dispatch",
    };

    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate,
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: guard,
        execute: async () => call,
      }),
    ).resolves.toMatchObject({
      resultClass: "provenance_invalid",
      artifactAccepted: false,
      failureCode: "completed_settlement_incoherent",
      costSettlement: {
        state: "unknown",
        reason: "invalid_settlement",
      },
      settlementInvalid: true,
    });
    expect(guard.snapshot()).toMatchObject({
      unknownUpperBoundCents: plan.envelope.perCallCostCapCents * 2,
      blocked: true,
      blockReason: "unknown_settlement",
    });
  });

  it("preserves explicit invalid settlement as a closed budget failure", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[0];
    const guard = new ModelEvaluationBudgetGuard(100);
    const call = completedCall(
      candidate.alias,
      candidate.expectedProtocol,
      canonicalAcceptedArtifact(),
    );
    call.costSettlement = {
      state: "unknown",
      reason: "invalid_settlement",
    };

    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate,
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: guard,
        execute: async () => call,
      }),
    ).resolves.toMatchObject({
      resultClass: "quality_valid_runtime_on_time",
      artifactAccepted: true,
      costSettlement: {
        state: "unknown",
        reason: "invalid_settlement",
      },
      settlementInvalid: true,
    });
    expect(guard.snapshot()).toMatchObject({
      committedCents: 0,
      reservedCents: 0,
      unknownUpperBoundCents: plan.envelope.perCallCostCapCents * 2,
      blocked: true,
      blockReason: "unknown_settlement",
    });
  });

  it("invokes the canonical evaluator and rejects a malformed artifact", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[0];
    const guard = new ModelEvaluationBudgetGuard(100);
    const result = await runTaskEvaluationAttempt({
      plan,
      candidate,
      fixtureId: "auto-parts-rich",
      attempt: 1,
      campaignBudget: guard,
      execute: async () =>
        completedCall(candidate.alias, candidate.expectedProtocol, {
          ok: true,
        }),
    });

    expect(result).toMatchObject({
      resultClass: "content_invalid",
      failureCode: "assessment_failed",
      costSettlement: {
        state: "settled",
        amountCents: 1,
        basis: "provider_reported@fake-settlement/v1",
      },
    });
    expect(guard.snapshot()).toMatchObject({
      committedCents: 1,
      reservedCents: 0,
      blocked: false,
    });
  });

  it("rejects an artifact with output-schema additional properties", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[0];
    const guard = new ModelEvaluationBudgetGuard(100);
    const artifact = {
      ...canonicalAcceptedArtifact(),
      unexpected: "schema bypass",
    };

    const result = await runTaskEvaluationAttempt({
      plan,
      candidate,
      fixtureId: "auto-parts-rich",
      attempt: 1,
      campaignBudget: guard,
      execute: async () =>
        completedCall(candidate.alias, candidate.expectedProtocol, artifact),
    });
    expect(result).toMatchObject({
      resultClass: "content_invalid",
      artifactAccepted: false,
      assessment: null,
      artifactRetention: "digest_only",
      artifact: null,
      artifactSha256: sha256CanonicalJson(artifact),
      failureCode: "assessment_failed",
    });
  });

  it("rejects an artifact blocked by the canonical production route gate", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[0];
    const guard = new ModelEvaluationBudgetGuard(100);
    const artifact = {
      ...canonicalAcceptedArtifact(),
      valueProps: ["Contact John Smith at john.smith@example.com"],
    };

    const result = await runTaskEvaluationAttempt({
      plan,
      candidate,
      fixtureId: "auto-parts-rich",
      attempt: 1,
      campaignBudget: guard,
      execute: async () =>
        completedCall(candidate.alias, candidate.expectedProtocol, artifact),
    });
    expect(result).toMatchObject({
      resultClass: "content_invalid",
      artifactAccepted: false,
      assessment: null,
      artifactRetention: "digest_only",
      artifact: null,
      artifactSha256: sha256CanonicalJson(artifact),
      failureCode: "assessment_failed",
    });
    expect(JSON.stringify(result)).not.toContain("john.smith@example.com");
  });

  it("uses captured schema and validator contracts after exported task mutation", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[0];
    const originalSchema = BRAND_PROFILE_TASK.outputSchema;
    const originalValidator = BRAND_PROFILE_TASK.validateOutput;
    BRAND_PROFILE_TASK.outputSchema = {};
    BRAND_PROFILE_TASK.validateOutput = undefined;
    try {
      const extraFieldArtifact = {
        ...canonicalAcceptedArtifact(),
        unexpected: "mutable schema bypass",
      };
      await expect(
        runTaskEvaluationAttempt({
          plan,
          candidate,
          fixtureId: "auto-parts-rich",
          attempt: 1,
          campaignBudget: new ModelEvaluationBudgetGuard(100),
          execute: async () =>
            completedCall(
              candidate.alias,
              candidate.expectedProtocol,
              extraFieldArtifact,
            ),
        }),
      ).resolves.toMatchObject({
        resultClass: "content_invalid",
        artifactAccepted: false,
        failureCode: "assessment_failed",
      });

      const piiArtifact = {
        ...canonicalAcceptedArtifact(),
        valueProps: ["Contact John Smith at john.smith@example.com"],
      };
      await expect(
        runTaskEvaluationAttempt({
          plan,
          candidate,
          fixtureId: "auto-parts-rich",
          attempt: 2,
          campaignBudget: new ModelEvaluationBudgetGuard(100),
          execute: async () =>
            completedCall(
              candidate.alias,
              candidate.expectedProtocol,
              piiArtifact,
            ),
        }),
      ).resolves.toMatchObject({
        resultClass: "content_invalid",
        artifactAccepted: false,
        failureCode: "assessment_failed",
      });
    } finally {
      BRAND_PROFILE_TASK.outputSchema = originalSchema;
      BRAND_PROFILE_TASK.validateOutput = originalValidator;
    }
  });

  it("accepts only output that passes the canonical task evaluator", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[0];
    const guard = new ModelEvaluationBudgetGuard(100);
    const artifact = canonicalAcceptedArtifact();
    const result = await runTaskEvaluationAttempt({
      plan,
      candidate,
      fixtureId: "auto-parts-rich",
      attempt: 1,
      campaignBudget: guard,
      execute: async () =>
        completedCall(candidate.alias, candidate.expectedProtocol, artifact),
    });

    expect(result).toMatchObject({
      resultClass: "quality_valid_runtime_on_time",
      failureCode: null,
      artifactAccepted: true,
      assessment: {
        qualityPassed: true,
        structurePassed: true,
        factualityPassed: true,
        stabilityKey: sha256CanonicalJson(artifact),
        findingCodes: [],
      },
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
      fixtureId: "auto-parts-rich",
      attempt: 1,
      campaignBudget: guard,
      execute: async () => call,
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
      fixtureId: "auto-parts-rich",
      attempt: 1,
      campaignBudget: guard,
      execute: async () =>
        completedCall(
          candidate.alias,
          candidate.expectedProtocol,
          canonicalAcceptedArtifact(),
          plan.envelope.perCallCostCapCents + 1,
        ),
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
  let capabilityBudget: ModelEvaluationBudgetGuard;
  let capabilityCampaign: ModelEvaluationCapabilityCampaign;

  beforeEach(async () => {
    capabilityBudget = new ModelEvaluationBudgetGuard(10_000);
    capabilityCampaign = new ModelEvaluationCapabilityCampaign(
      capabilityBudget,
    );
    const candidate = plan.candidates.find(
      (entry) => entry.alias === "gpt-5.5",
    )!;
    const validation = await capabilityCampaign.runCanonicalProbe({
      plan,
      candidate,
      execute: async () =>
        completedCall(
          candidate.alias,
          candidate.expectedProtocol,
          canonicalAcceptedArtifact(),
        ),
    });
    expect(validation.status).toBe("capability_proven");
  });

  const summarizeModelEvaluationCandidate = (
    planValue: Parameters<typeof summarizeModelEvaluationCandidateRaw>[0],
    alias: Parameters<typeof summarizeModelEvaluationCandidateRaw>[1],
    runs: Parameters<typeof summarizeModelEvaluationCandidateRaw>[2],
  ) =>
    summarizeModelEvaluationCandidateRaw(
      planValue,
      alias,
      runs,
      capabilityBudget,
      capabilityCampaign,
    );

  const rankModelEvaluationCandidates = (
    planValue: Parameters<typeof rankModelEvaluationCandidatesRaw>[0],
    candidateRuns: Parameters<typeof rankModelEvaluationCandidatesRaw>[1],
  ) =>
    rankModelEvaluationCandidatesRaw(
      planValue,
      candidateRuns,
      capabilityBudget,
      capabilityCampaign,
    );

  async function run(
    alias: string,
    resultClass: ModelEvaluationRun["resultClass"],
    artifact: BrandProfileOutput,
    elapsedMs: number,
    amountCents: number | null,
    fixtureId: string,
    attempt: number,
  ): Promise<ModelEvaluationRun> {
    const candidate = plan.candidates.find((entry) => entry.alias === alias)!;
    const call = completedCall(
      alias,
      candidate.expectedProtocol,
      artifact,
      amountCents ?? 0,
    );
    if (amountCents === null) {
      call.costSettlement = {
        state: "unknown",
        reason: "provider_ack_unknown",
      };
    }
    const times = [0, elapsedMs];
    const produced = await runTaskEvaluationAttempt({
      plan,
      candidate,
      fixtureId,
      attempt,
      campaignBudget: capabilityBudget,
      capabilityCampaign,
      execute: async () => call,
      now: () => times.shift() ?? elapsedMs,
    });
    expect(produced.resultClass).toBe(resultClass);
    return produced;
  }

  async function fullMatrix(
    alias: string,
    build: (
      fixtureId: string,
      attempt: number,
      index: number,
    ) => Promise<ModelEvaluationRun>,
  ): Promise<ModelEvaluationRun[]> {
    const runs: ModelEvaluationRun[] = [];
    let index = 0;
    for (const fixtureId of suite.fixtureIds) {
      for (let attempt = 1; attempt <= suite.repeats; attempt += 1) {
        runs.push(await build(fixtureId, attempt, index));
        index += 1;
      }
    }
    return runs;
  }

  async function acceptedRun(
    alias: string,
    fixtureId: string,
    attempt: number,
    elapsedMs = 1000,
    amountCents: number | null = 1,
    variant?: string,
  ): Promise<ModelEvaluationRun> {
    const artifact = canonicalAcceptedArtifact(fixtureId);
    if (variant) artifact.keywords = [variant];
    return await run(
      alias,
      "quality_valid_runtime_on_time",
      artifact,
      elapsedMs,
      amountCents,
      fixtureId,
      attempt,
    );
  }

  async function contentInvalidRun(
    alias: string,
    fixtureId: string,
    attempt: number,
    elapsedMs = 1000,
    amountCents: number | null = 1,
  ): Promise<ModelEvaluationRun> {
    const evaluationCase = buildCanonicalModelEvaluationCase(plan, fixtureId);
    const artifact = canonicalAcceptedArtifact(fixtureId);
    artifact.keywords = [
      evaluationCase.payload.fixture.assertions.forbiddenOutputTerms[0],
    ];
    return await run(
      alias,
      "content_invalid",
      artifact,
      elapsedMs,
      amountCents,
      fixtureId,
      attempt,
    );
  }

  it("orders quality, structure, factuality, stability, P95, then accepted cost", async () => {
    const highQualityRuns = await fullMatrix(
      "gpt-5.5",
      async (fixtureId, attempt, index) =>
        await acceptedRun(
          "gpt-5.5",
          fixtureId,
          attempt,
          index % 2 === 0 ? 110_000 : 120_000,
          5,
          `${fixtureId}-stable`,
        ),
    );
    const highQualitySlow = summarizeModelEvaluationCandidate(
      plan,
      "gpt-5.5",
      highQualityRuns,
    );
    const lowerQualityRuns = await fullMatrix(
      "claude-sonnet-5",
      async (fixtureId, attempt, index) =>
        index === 0
          ? await contentInvalidRun("claude-sonnet-5", fixtureId, attempt)
          : await acceptedRun(
              "claude-sonnet-5",
              fixtureId,
              attempt,
              1000,
              1,
              `${fixtureId}-stable`,
            ),
    );
    const slowerTerraRuns = await fullMatrix(
      "gpt-5.6-terra",
      async (fixtureId, attempt) =>
        await acceptedRun(
          "gpt-5.6-terra",
          fixtureId,
          attempt,
          130_000,
          6,
          `${fixtureId}-stable`,
        ),
    );

    expect(
      rankModelEvaluationCandidates(plan, [
        { alias: "claude-sonnet-5", runs: lowerQualityRuns },
        { alias: "gpt-5.6-terra", runs: slowerTerraRuns },
        { alias: "gpt-5.5", runs: highQualityRuns },
      ]).map((summary) => summary.alias),
    ).toEqual(["gpt-5.5", "gpt-5.6-terra", "claude-sonnet-5"]);
    expect(highQualitySlow.acceptedArtifactCostCents).toBeCloseTo(61 / 12);
  });

  it("keeps unknown settlement unrankable instead of treating it as zero", async () => {
    const runs = await fullMatrix(
      "gpt-5.5",
      async (fixtureId, attempt, index) =>
        await acceptedRun(
          "gpt-5.5",
          fixtureId,
          attempt,
          1000,
          index === 11 ? null : 1,
          `${fixtureId}-stable`,
        ),
    );
    const summary = summarizeModelEvaluationCandidate(plan, "gpt-5.5", runs);
    expect(summary).toMatchObject({
      rankable: false,
      acceptedArtifactCostCents: null,
      costSettlementComplete: false,
    });
  });

  it("treats every content-invalid run as a hard ranking failure", async () => {
    const runs = await fullMatrix(
      "gpt-5.5",
      async (fixtureId, attempt, index) =>
        index === 11
          ? await contentInvalidRun("gpt-5.5", fixtureId, attempt)
          : await acceptedRun("gpt-5.5", fixtureId, attempt),
    );
    const summary = summarizeModelEvaluationCandidate(plan, "gpt-5.5", runs);

    expect(summary).toMatchObject({
      matrixComplete: true,
      acceptedArtifactCount: 11,
      hardFailureCount: 1,
      rankable: false,
    });
  });

  it("accepts the producer's invalid-settlement flag and keeps the matrix unrankable", async () => {
    const candidate = plan.candidates.find(
      (entry) => entry.alias === "gpt-5.5",
    )!;
    const runs = await fullMatrix(
      candidate.alias,
      async (fixtureId, attempt, index) => {
        if (index < 11) {
          return await acceptedRun(
            candidate.alias,
            fixtureId,
            attempt,
            1000,
            1,
          );
        }
        const call = completedCall(
          candidate.alias,
          candidate.expectedProtocol,
          canonicalAcceptedArtifact(fixtureId),
        );
        call.costSettlement = {
          state: "unknown",
          reason: "invalid_settlement",
        };
        return await runTaskEvaluationAttempt({
          plan,
          candidate,
          fixtureId,
          attempt,
          campaignBudget: capabilityBudget,
          capabilityCampaign,
          execute: async () => call,
        });
      },
    );

    const summary = summarizeModelEvaluationCandidate(
      plan,
      candidate.alias,
      runs,
    );
    expect(summary).toMatchObject({
      acceptedArtifactCount: 12,
      hardFailureCount: 1,
      costSettlementComplete: false,
      acceptedArtifactCostCents: null,
      rankable: false,
    });
  });

  it("keeps late quality observations but fails the production P95 promotion gate", async () => {
    const runs = await fullMatrix(
      "gpt-5.5",
      async (fixtureId, attempt) =>
        await run(
          "gpt-5.5",
          "quality_valid_runtime_late",
          canonicalAcceptedArtifact(fixtureId),
          plan.envelope.runtimeDeadlineMs + 1,
          1,
          fixtureId,
          attempt,
        ),
    );
    const summary = summarizeModelEvaluationCandidate(plan, "gpt-5.5", runs);
    expect(summary).toMatchObject({
      acceptedArtifactCount: 12,
      p95LatencyMs: plan.envelope.runtimeDeadlineMs + 1,
      runtimeDeadlinePassed: false,
      rankable: false,
      capabilityProbeAttestation: {
        alias: "gpt-5.5",
        campaignId: capabilityCampaign.campaignId,
      },
    });
  });

  it("keeps quality observations but makes an over-cap run unrankable", async () => {
    const runs = await fullMatrix(
      "gpt-5.5",
      async (fixtureId, attempt, index) =>
        await acceptedRun(
          "gpt-5.5",
          fixtureId,
          attempt,
          1000,
          index === 11 ? plan.envelope.perCallCostCapCents + 1 : 1,
        ),
    );

    const summary = summarizeModelEvaluationCandidate(plan, "gpt-5.5", runs);
    expect(summary).toMatchObject({
      acceptedArtifactCount: 12,
      hardFailureCount: 1,
      rankable: false,
    });
  });

  it("computes stability within each fixture instead of across unrelated fixtures", async () => {
    const runs = await fullMatrix(
      "gpt-5.5",
      async (fixtureId, attempt) =>
        await acceptedRun(
          "gpt-5.5",
          fixtureId,
          attempt,
          1000,
          1,
          `${fixtureId}-output`,
        ),
    );
    const summary = summarizeModelEvaluationCandidate(plan, "gpt-5.5", runs);

    expect(summary).toMatchObject({
      matrixComplete: true,
      stabilityRate: 1,
    });
  });

  it("rejects a matrix assembled from fresh genuine budgets per attempt", async () => {
    const candidate = plan.candidates.find(
      (entry) => entry.alias === "gpt-5.6-terra",
    )!;
    const budgets: ModelEvaluationBudgetGuard[] = [];
    const runs: ModelEvaluationRun[] = [];
    for (const fixtureId of suite.fixtureIds) {
      for (let attempt = 1; attempt <= suite.repeats; attempt += 1) {
        const budget = new ModelEvaluationBudgetGuard(100);
        budgets.push(budget);
        runs.push(
          await runTaskEvaluationAttempt({
            plan,
            candidate,
            fixtureId,
            attempt,
            campaignBudget: budget,
            execute: async () =>
              completedCall(
                candidate.alias,
                candidate.expectedProtocol,
                canonicalAcceptedArtifact(fixtureId),
              ),
          }),
        );
      }
    }

    expect(() =>
      summarizeModelEvaluationCandidateRaw(
        plan,
        candidate.alias,
        runs,
        budgets[0],
      ),
    ).toThrow("runs from one trusted in-memory campaign budget");
  });

  it("freezes budget-stop runs before binding them to the campaign", async () => {
    const candidate = plan.candidates.find(
      (entry) => entry.alias === "gpt-5.6-terra",
    )!;
    const budget = new ModelEvaluationBudgetGuard(
      plan.envelope.perCallCostCapCents * 2,
    );
    const runs = await fullMatrix(
      candidate.alias,
      async (fixtureId, attempt) =>
        await runTaskEvaluationAttempt({
          plan,
          candidate,
          fixtureId,
          attempt,
          campaignBudget: budget,
          execute: async () =>
            completedCall(
              candidate.alias,
              candidate.expectedProtocol,
              canonicalAcceptedArtifact(fixtureId),
              plan.envelope.perCallCostCapCents,
            ),
        }),
    );
    expect(
      runs.filter((run) => run.resultClass === "budget_stop"),
    ).toHaveLength(11);
    const stoppedRun = runs.find((run) => run.resultClass === "budget_stop")!;
    expect(Object.isFrozen(stoppedRun)).toBe(true);
    expect(() => {
      stoppedRun.resultClass = "quality_valid_runtime_on_time";
    }).toThrow(TypeError);
    expect(() => {
      stoppedRun.artifact = canonicalAcceptedArtifact(stoppedRun.fixtureId);
    }).toThrow(TypeError);

    expect(
      summarizeModelEvaluationCandidateRaw(plan, candidate.alias, runs, budget),
    ).toMatchObject({
      matrixComplete: true,
      acceptedArtifactCount: 1,
      hardFailureCount: 11,
      rankable: false,
    });
  });

  it("freezes a delayed provider-attested no-cost failure at hard stop", async () => {
    const candidate = plan.candidates.find(
      (entry) => entry.alias === "gpt-5.6-terra",
    )!;
    const runs = await fullMatrix(
      candidate.alias,
      async (fixtureId, attempt, index) => {
        if (index !== 11) {
          return await acceptedRun(candidate.alias, fixtureId, attempt);
        }
        const times = [0, plan.envelope.hardStopMs + 1];
        return await runTaskEvaluationAttempt({
          plan,
          candidate,
          fixtureId,
          attempt,
          campaignBudget: capabilityBudget,
          capabilityCampaign,
          execute: async () => {
            throw new ModelEvaluationCallError("provider_unavailable", {
              state: "not_incurred",
              reason: "provider_attested_not_incurred",
            });
          },
          now: () => times.shift() ?? plan.envelope.hardStopMs + 1,
        });
      },
    );

    const summary = summarizeModelEvaluationCandidate(
      plan,
      candidate.alias,
      runs,
    );
    expect(runs[11]).toMatchObject({
      resultClass: "diagnostic_window_exhausted",
      runtimeTiming: "diagnostic_exhausted",
      costSettlement: {
        state: "unknown",
        reason: "diagnostic_hard_stop",
      },
    });
    expect(summary).toMatchObject({
      matrixComplete: true,
      hardFailureCount: 1,
      rankable: false,
    });

    expect(() =>
      Object.assign(runs[11].costSettlement, {
        reason: "provider_ack_unknown",
      }),
    ).toThrow(TypeError);
    expect(runs[11].costSettlement).toEqual({
      state: "unknown",
      reason: "diagnostic_hard_stop",
    });
  });

  it("rejects persisted probe self-hashes without the originating trusted campaign", async () => {
    const runs = await fullMatrix(
      "gpt-5.5",
      async (fixtureId, attempt) =>
        await acceptedRun("gpt-5.5", fixtureId, attempt),
    );
    expect(() =>
      summarizeModelEvaluationCandidateRaw(
        plan,
        "gpt-5.5",
        runs,
        capabilityBudget,
      ),
    ).toThrow("trusted in-memory capability campaign");
    expect(() =>
      summarizeModelEvaluationCandidateRaw(
        plan,
        "gpt-5.5",
        structuredClone(runs),
        capabilityBudget,
        capabilityCampaign,
      ),
    ).toThrow("runs from one trusted in-memory campaign budget");
  });

  it("deep-freezes every trusted run and its nested provenance", async () => {
    const runs = await fullMatrix(
      "gpt-5.5",
      async (fixtureId, attempt) =>
        await acceptedRun("gpt-5.5", fixtureId, attempt),
    );
    const trustedRun = runs[0];
    expect(Object.isFrozen(trustedRun)).toBe(true);
    expect(Object.isFrozen(trustedRun.artifact)).toBe(true);
    expect(Object.isFrozen(trustedRun.assessment)).toBe(true);
    expect(Object.isFrozen(trustedRun.costSettlement)).toBe(true);
    expect(Object.isFrozen(trustedRun.usage)).toBe(true);
    expect(Object.isFrozen(trustedRun.capabilityProbeAttestation)).toBe(true);
    expect(trustedRun).toMatchObject({
      schemaVersion: "site-builder-model-evaluation-run/v3",
      costSafetyContractId:
        "site-builder-model-evaluation-cost-safety/2026-07-28-v1",
      credentialSnapshotSha256:
        "1111111111111111111111111111111111111111111111111111111111111111",
      pricingSnapshotSha256:
        "2222222222222222222222222222222222222222222222222222222222222222",
      capabilityProbeAttestation: {
        schemaVersion: "site-builder-model-capability-probe-attestation/v2",
      },
    });
    expect(trustedRun.costSafetyAttestationSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      trustedRun.capabilityProbeAttestation!.costSafetyAttestationSha256,
    ).toBe(trustedRun.costSafetyAttestationSha256);

    expect(() => {
      trustedRun.fixtureId = "unexpected-fixture";
    }).toThrow(TypeError);
    expect(() => {
      trustedRun.artifact!.keywords[0] = "forged";
    }).toThrow(TypeError);
    expect(() => {
      trustedRun.assessment!.findingCodes.push("forged");
    }).toThrow(TypeError);
    expect(() => {
      trustedRun.costSettlement = {
        state: "not_incurred",
        reason: "rejected_before_dispatch",
      };
    }).toThrow(TypeError);
    expect(() => {
      trustedRun.usage!.inputTokens = -1;
    }).toThrow(TypeError);
    expect(() => {
      trustedRun.capabilityProbeAttestation!.resolvedModel = "gpt-5.6-terra";
    }).toThrow(TypeError);

    expect(
      summarizeModelEvaluationCandidate(plan, "gpt-5.5", runs),
    ).toMatchObject({
      rankable: true,
      costSafetyContractId:
        "site-builder-model-evaluation-cost-safety/2026-07-28-v1",
      costSafetyAttestationSha256: trustedRun.costSafetyAttestationSha256,
      credentialSnapshotSha256: trustedRun.credentialSnapshotSha256,
      pricingSnapshotSha256: trustedRun.pricingSnapshotSha256,
    });
  });

  it("rejects a forged persisted clone before trusting pass flags", async () => {
    const runs = await fullMatrix(
      "gpt-5.5",
      async (fixtureId, attempt, index) =>
        index === 0
          ? await contentInvalidRun("gpt-5.5", fixtureId, attempt)
          : await acceptedRun("gpt-5.5", fixtureId, attempt),
    );
    const forgedRuns = structuredClone(runs);
    forgedRuns[0].resultClass = "quality_valid_runtime_on_time";
    forgedRuns[0].artifactAccepted = true;
    forgedRuns[0].assessment = validAssessment(forgedRuns[0].artifactSha256!);
    forgedRuns[0].failureCode = null;

    expect(() =>
      summarizeModelEvaluationCandidate(plan, "gpt-5.5", forgedRuns),
    ).toThrow("runs from one trusted in-memory campaign budget");
  });

  it("rejects a ranking matrix containing forged persisted runs", async () => {
    const candidateRuns = await Promise.all(
      plan.candidates.map(async (candidate) => ({
        alias: candidate.alias,
        runs: await fullMatrix(
          candidate.alias,
          async (fixtureId, attempt) =>
            await acceptedRun(candidate.alias, fixtureId, attempt),
        ),
      })),
    );
    const forgedCandidateRuns = structuredClone(candidateRuns);
    for (const run of forgedCandidateRuns[1].runs) {
      run.sourceBundleSha256 = "d".repeat(64);
    }

    expect(() =>
      rankModelEvaluationCandidates(plan, forgedCandidateRuns),
    ).toThrow("runs from one trusted in-memory campaign budget");
  });

  it("requires every planned alias exactly once before ranking", async () => {
    const terraRuns = await fullMatrix(
      "gpt-5.6-terra",
      async (fixtureId, attempt) =>
        await acceptedRun("gpt-5.6-terra", fixtureId, attempt),
    );

    expect(() =>
      rankModelEvaluationCandidates(plan, [
        { alias: "gpt-5.6-terra", runs: terraRuns },
        { alias: "gpt-5.6-terra", runs: terraRuns },
      ]),
    ).toThrow(
      "candidate ranking matrix must cover every planned candidate exactly once",
    );
  });
});
