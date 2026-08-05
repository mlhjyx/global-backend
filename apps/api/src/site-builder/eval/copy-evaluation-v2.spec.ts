import { describe, expect, it } from "vitest";
import {
  COPY_EVALUATION_V2_PLAN,
  validateCopyEvaluationV2Plan,
} from "./copy-evaluation-v2";

describe("Copy Evaluation v2 admission plan", () => {
  it("keeps dispatch blocked and records zero observed paid activity", () => {
    expect(COPY_EVALUATION_V2_PLAN.executionStatus).toBe(
      "BLOCKED_BEFORE_CAPABILITY_PILOT",
    );
    expect(COPY_EVALUATION_V2_PLAN.dispatchAuthorization).toBe(
      "NOT_AUTHORIZED",
    );
    expect(COPY_EVALUATION_V2_PLAN.observedModelWireCalls).toBe(0);
    expect(COPY_EVALUATION_V2_PLAN.observedModelCost).toEqual({
      CNY: 0,
      USD: 0,
    });
  });

  it("admits the rebaselined Terra, Sol, and Sonnet pool", () => {
    expect(
      COPY_EVALUATION_V2_PLAN.candidates.map((candidate) => ({
        alias: candidate.alias,
        protocol: candidate.protocol,
        reasoning: candidate.reasoning,
      })),
    ).toEqual([
      {
        alias: "gpt-5.6-terra",
        protocol: "openai_responses",
        reasoning: "medium",
      },
      {
        alias: "gpt-5.6-sol",
        protocol: "openai_responses",
        reasoning: "high",
      },
      {
        alias: "claude-sonnet-5",
        protocol: "anthropic_messages",
        reasoning: "medium",
      },
    ]);
    expect(COPY_EVALUATION_V2_PLAN.candidateAdmission).toMatchObject({
      profile: "copy.premium",
      status: "READY",
      currentAliases: ["gpt-5.6-terra", "gpt-5.6-sol", "claude-sonnet-5"],
      requiredAliases: ["gpt-5.6-terra", "gpt-5.6-sol", "claude-sonnet-5"],
      currentCandidates: [
        {
          alias: "gpt-5.6-terra",
          expectedProtocol: "openai-responses",
          preflight: "capability_probe",
        },
        {
          alias: "gpt-5.6-sol",
          expectedProtocol: "openai-responses",
          preflight: "capability_probe",
        },
        {
          alias: "claude-sonnet-5",
          expectedProtocol: "anthropic-messages",
          preflight: "capability_probe",
        },
      ],
      requiredCandidates: [
        {
          alias: "gpt-5.6-terra",
          expectedProtocol: "openai-responses",
          preflight: "capability_probe",
        },
        {
          alias: "gpt-5.6-sol",
          expectedProtocol: "openai-responses",
          preflight: "capability_probe",
        },
        {
          alias: "claude-sonnet-5",
          expectedProtocol: "anthropic-messages",
          preflight: "capability_probe",
        },
      ],
    });
  });

  it("binds the future matrix to the completed production contract and evaluator", () => {
    expect(COPY_EVALUATION_V2_PLAN.taskContract).toMatchObject({
      taskId: "site_builder.copy",
      currentVersion: "site-builder-task-contract/site_builder.copy/v2",
      requiredVersion: "site-builder-task-contract/site_builder.copy/v2",
      status: "READY",
      missingContext: [],
      currentContext: [
        "audience",
        "brand_voice",
        "prohibited_assertions",
        "cta_policy",
      ],
    });
    expect(COPY_EVALUATION_V2_PLAN.creativeOutputAdmission).toEqual({
      currentPolicy: "validated_non_factual_copy_is_preserved",
      requiredPolicy: "validated_non_factual_copy_is_preserved",
      status: "READY",
    });
    expect(COPY_EVALUATION_V2_PLAN.fixtureAdmission).toMatchObject({
      currentFixtureIds: [
        "copy-factual-claims",
        "copy-factual-cross-locale",
        "copy-unsupported-assertion",
        "copy-brand-voice-en",
        "copy-brand-voice-cross-locale",
        "copy-cta-budget",
      ],
      currentFixtureCount: 6,
      currentScenarios: [
        "factual_exact_en",
        "factual_exact_cross_locale",
        "unsupported_assertion_rejection",
        "brand_voice_en",
        "brand_voice_cross_locale",
        "cta_and_character_budget",
      ],
      requiredFixtureCount: 6,
      repeats: 2,
      status: "READY",
    });
    expect(COPY_EVALUATION_V2_PLAN.evaluatorAdmission).toEqual({
      evaluatorVersion: "site-builder-copy-assembly-evaluator/2026-08-04-v3",
      reviewSchemaVersion: "site-builder-copy-quality-review/2026-08-04-v1",
      rubricVersion: "site-builder-copy-quality-rubric/2026-08-04-v1",
      currentScoredDimensions: [
        "language_quality",
        "brand_voice",
        "cta_quality",
        "cross_locale_quality",
        "stability",
      ],
      requiredScoredDimensions: [
        "language_quality",
        "brand_voice",
        "cta_quality",
        "cross_locale_quality",
        "stability",
      ],
      findingVocabulary: "closed_code_only",
      reviewerPolicy:
        "human_blind_or_independent_model_with_provider_separation",
      candidateIdentityVisibleToReviewer: false,
      executionReceiptPolicy: "model_runtime_branded_known_settlement_no_cache",
      repeatBindingPolicy: "candidate_fixture_repeat_execution_output_digest",
      stabilityPolicy: "deterministic_two_repeat_normalized_token_dice",
      qualityGate: {
        scaleMinimum: 0,
        scaleMaximum: 4,
        observationMinimum: 2,
        dimensionMeanMinimum: 3,
        allHardGatesRequired: true,
        promotionDecision: "SEPARATE_PR_REQUIRED",
        routeAdoptionAuthorized: false,
      },
      status: "READY",
    });
    expect(COPY_EVALUATION_V2_PLAN.requiredContext).toEqual([
      "claim_snapshot",
      "slot_contract",
      "locale",
      "audience",
      "brand_voice",
      "prohibited_assertions",
      "character_budget",
      "cta_policy",
    ]);
  });

  it("separates the three-call pilot from the later task-shaped matrix", () => {
    expect(COPY_EVALUATION_V2_PLAN.capabilityPilot).toMatchObject({
      contractId: "site-builder-copy-capability-pilot/2026-08-05-v3",
      contractSchemaVersion:
        "site-builder-copy-capability-pilot-plan/2026-08-05-v3",
      evidenceClassification: "CAPABILITY_ONLY_NOT_QUALITY_EVIDENCE",
      plannedExecutions: 3,
      maximumWireCalls: 6,
      status: "REAL_ADMISSION_SOURCE_READY_MANIFEST_REQUIRED",
    });
    expect(COPY_EVALUATION_V2_PLAN.taskMatrix).toMatchObject({
      plannedExecutions: 36,
      maximumWireCalls: 72,
      status: "BLOCKED_BEFORE_PILOT_RESULT",
    });
    expect(COPY_EVALUATION_V2_PLAN.cachePolicy).toEqual({
      exactResultCache: "disabled_for_evaluation",
      repeatIdentity: "distinct_execution_and_cache_identity_per_repeat",
      durableReplay: "same_physical_execution_only",
    });
    expect(COPY_EVALUATION_V2_PLAN.decisionBoundaries).toEqual([
      "capability_pilot_dispatch_requires_separate_user_authorization",
      "task_matrix_dispatch_requires_separate_user_authorization",
      "promotion_requires_separate_pr_and_user_authorization",
      "runtime_route_adoption_requires_separate_pr_and_user_authorization",
    ]);
  });

  it("keeps hard validity gates separate from scored copy quality", () => {
    expect(COPY_EVALUATION_V2_PLAN.hardGates).toEqual([
      "schema",
      "claim_provenance",
      "prohibited_assertions",
      "character_budget",
      "cta_policy",
    ]);
    expect(COPY_EVALUATION_V2_PLAN.scoredDimensions).toEqual([
      "language_quality",
      "brand_voice",
      "cta_quality",
      "cross_locale_quality",
      "stability",
    ]);
    expect(() =>
      validateCopyEvaluationV2Plan(COPY_EVALUATION_V2_PLAN),
    ).not.toThrow();
  });

  it.each([
    [
      "candidate",
      (plan: typeof COPY_EVALUATION_V2_PLAN) => ({
        ...plan,
        candidates: plan.candidates.slice(1),
      }),
    ],
    [
      "pilot",
      (plan: typeof COPY_EVALUATION_V2_PLAN) => ({
        ...plan,
        capabilityPilot: { ...plan.capabilityPilot, maximumWireCalls: 7 },
      }),
    ],
    [
      "fixture",
      (plan: typeof COPY_EVALUATION_V2_PLAN) => ({
        ...plan,
        fixtureAdmission: { ...plan.fixtureAdmission, requiredFixtureCount: 2 },
      }),
    ],
    [
      "context",
      (plan: typeof COPY_EVALUATION_V2_PLAN) => ({
        ...plan,
        requiredContext: plan.requiredContext.slice(1),
      }),
    ],
    [
      "gate",
      (plan: typeof COPY_EVALUATION_V2_PLAN) => ({
        ...plan,
        hardGates: plan.hardGates.slice(1),
      }),
    ],
  ])(
    "rejects %s drift before any future dispatcher can consume the plan",
    (_name, mutate) => {
      expect(() =>
        validateCopyEvaluationV2Plan(mutate(COPY_EVALUATION_V2_PLAN)),
      ).toThrow("COPY_EVALUATION_V2_PLAN_DRIFT");
    },
  );

  it.each([
    [
      "undefined field",
      () => ({ ...COPY_EVALUATION_V2_PLAN, hidden: undefined }),
    ],
    [
      "function field",
      () => ({ ...COPY_EVALUATION_V2_PLAN, hidden: () => "omitted" }),
    ],
    [
      "symbol-keyed field",
      () => {
        const candidate = { ...COPY_EVALUATION_V2_PLAN } as Record<
          PropertyKey,
          unknown
        >;
        candidate[Symbol("hidden")] = "omitted";
        return candidate;
      },
    ],
    [
      "array property",
      () => {
        const candidates = [...COPY_EVALUATION_V2_PLAN.candidates] as Array<
          (typeof COPY_EVALUATION_V2_PLAN.candidates)[number]
        > & { hidden?: string };
        candidates.hidden = "omitted";
        return { ...COPY_EVALUATION_V2_PLAN, candidates };
      },
    ],
    [
      "non-JSON object",
      () => ({ ...COPY_EVALUATION_V2_PLAN, hidden: new Date(0) }),
    ],
  ])("rejects %s before canonical JSON comparison", (_name, build) => {
    expect(() => validateCopyEvaluationV2Plan(build())).toThrow(
      "COPY_EVALUATION_V2_PLAN_NON_JSON",
    );
  });
});
