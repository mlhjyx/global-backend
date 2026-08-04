import type { ModelProtocol, ReasoningLevel } from "../../model-runtime";
import {
  getModelProfileCandidatePool,
  SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID,
} from "../agents/model-candidate-baseline";
import { COPY_TASK } from "../agents/copy";
import {
  COPY_ASSEMBLY_EVALUATOR_VERSION,
  COPY_ASSEMBLY_EVAL_FIXTURES,
  COPY_ASSEMBLY_EVAL_FIXTURE_SCHEMA_VERSION,
} from "./copy-assembly-eval";

export const COPY_EVALUATION_V2_SCHEMA_VERSION =
  "site-builder-copy-evaluation-plan/2026-08-04-v2" as const;

const COPY_PROFILE = "copy.premium" as const;
const CURRENT_TASK_CONTRACT_VERSION =
  COPY_TASK.contractVersion ?? `site-builder-task-contract/${COPY_TASK.id}/v1`;
const REQUIRED_TASK_CONTRACT_VERSION =
  "site-builder-task-contract/site_builder.copy/v2" as const;
const REQUIRED_FIXTURE_SCENARIOS = Object.freeze([
  "factual_exact_en",
  "factual_exact_cross_locale",
  "unsupported_assertion_rejection",
  "brand_voice_en",
  "brand_voice_cross_locale",
  "cta_and_character_budget",
] as const);
const REQUIRED_CONTEXT = Object.freeze([
  "claim_snapshot",
  "slot_contract",
  "locale",
  "audience",
  "brand_voice",
  "prohibited_assertions",
  "character_budget",
  "cta_policy",
] as const);
const REQUIRED_TASK_CONTEXT = Object.freeze([
  "audience",
  "brand_voice",
  "prohibited_assertions",
  "cta_policy",
] as const);
const HARD_GATES = Object.freeze([
  "schema",
  "claim_provenance",
  "prohibited_assertions",
  "character_budget",
  "cta_policy",
] as const);
const SCORED_DIMENSIONS = Object.freeze([
  "language_quality",
  "brand_voice",
  "cta_quality",
  "cross_locale_quality",
  "stability",
] as const);
const DECISION_BOUNDARIES = Object.freeze([
  "capability_pilot_dispatch_requires_separate_user_authorization",
  "task_matrix_dispatch_requires_separate_user_authorization",
  "promotion_requires_separate_pr_and_user_authorization",
  "runtime_route_adoption_requires_separate_pr_and_user_authorization",
] as const);

export interface CopyEvaluationV2Candidate {
  alias: string;
  protocol: ModelProtocol;
  reasoning: ReasoningLevel;
}

const CANDIDATES = Object.freeze([
  Object.freeze({
    alias: "gpt-5.6-terra",
    protocol: "openai_responses" as const,
    reasoning: "medium" as const,
  }),
  Object.freeze({
    alias: "gpt-5.6-sol",
    protocol: "openai_responses" as const,
    reasoning: "high" as const,
  }),
  Object.freeze({
    alias: "claude-sonnet-5",
    protocol: "anthropic_messages" as const,
    reasoning: "medium" as const,
  }),
] satisfies readonly CopyEvaluationV2Candidate[]);

const REQUIRED_ALIASES = Object.freeze(
  CANDIDATES.map((candidate) => candidate.alias),
);
const currentPool = getModelProfileCandidatePool(COPY_PROFILE);
if (!currentPool) throw new Error("COPY_EVALUATION_V2_PROFILE_MISSING");
const CURRENT_ALIASES = Object.freeze(
  currentPool.candidates.map((candidate) => candidate.alias),
);
const CURRENT_FIXTURE_IDS = Object.freeze(
  COPY_ASSEMBLY_EVAL_FIXTURES.map((fixture) => fixture.fixtureId),
);
const CURRENT_FIXTURE_SCENARIOS = Object.freeze(
  COPY_ASSEMBLY_EVAL_FIXTURES.map((fixture) => fixture.scenario),
);
const REQUIRED_FIXTURE_COUNT = REQUIRED_FIXTURE_SCENARIOS.length;
const REPEATS = 2 as const;
const PILOT_EXECUTIONS = CANDIDATES.length;
const TASK_MATRIX_EXECUTIONS =
  CANDIDATES.length * REQUIRED_FIXTURE_COUNT * REPEATS;

function exactList(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

const PLAN = {
  schemaVersion: COPY_EVALUATION_V2_SCHEMA_VERSION,
  executionStatus: "BLOCKED_BEFORE_CAPABILITY_PILOT",
  dispatchAuthorization: "NOT_AUTHORIZED",
  observedModelWireCalls: 0,
  observedModelCost: { CNY: 0, USD: 0 },
  candidates: CANDIDATES,
  candidateAdmission: {
    baselineId: SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID,
    profile: COPY_PROFILE,
    currentAliases: CURRENT_ALIASES,
    requiredAliases: REQUIRED_ALIASES,
    status: exactList(CURRENT_ALIASES, REQUIRED_ALIASES)
      ? "READY"
      : "BLOCKED_ON_CANDIDATE_REBASELINE",
  },
  taskContract: {
    taskId: COPY_TASK.id,
    source: "apps/api/src/site-builder/agents/copy.ts",
    currentVersion: CURRENT_TASK_CONTRACT_VERSION,
    requiredVersion: REQUIRED_TASK_CONTRACT_VERSION,
    missingContext:
      CURRENT_TASK_CONTRACT_VERSION === REQUIRED_TASK_CONTRACT_VERSION
        ? Object.freeze([])
        : REQUIRED_TASK_CONTEXT,
    status:
      CURRENT_TASK_CONTRACT_VERSION === REQUIRED_TASK_CONTRACT_VERSION
        ? "READY"
        : "BLOCKED_ON_CONTEXT_V2",
  },
  creativeOutputAdmission: {
    currentPolicy: "validated_non_factual_copy_is_preserved",
    requiredPolicy: "validated_non_factual_copy_is_preserved",
    status: "READY",
  },
  fixtureAdmission: {
    schemaVersion: COPY_ASSEMBLY_EVAL_FIXTURE_SCHEMA_VERSION,
    evaluatorVersion: COPY_ASSEMBLY_EVALUATOR_VERSION,
    source: "apps/api/src/site-builder/eval/copy-assembly-eval.ts",
    currentFixtureIds: CURRENT_FIXTURE_IDS,
    currentScenarios: CURRENT_FIXTURE_SCENARIOS,
    currentFixtureCount: CURRENT_FIXTURE_IDS.length,
    requiredScenarios: REQUIRED_FIXTURE_SCENARIOS,
    requiredFixtureCount: REQUIRED_FIXTURE_COUNT,
    repeats: REPEATS,
    status: exactList(CURRENT_FIXTURE_SCENARIOS, REQUIRED_FIXTURE_SCENARIOS)
      ? "READY"
      : "BLOCKED_ON_FIXTURE_EXPANSION",
  },
  requiredContext: REQUIRED_CONTEXT,
  capabilityPilot: {
    purpose: "protocol_schema_reasoning_usage_and_identity_only",
    aliases: REQUIRED_ALIASES,
    plannedExecutions: PILOT_EXECUTIONS,
    maximumRepairCallsPerExecution: 1,
    maximumWireCalls: PILOT_EXECUTIONS * 2,
    status: "NOT_AUTHORIZED",
  },
  taskMatrix: {
    purpose: "task_shaped_quality_after_capability_pilot",
    candidateCount: CANDIDATES.length,
    fixtureCount: REQUIRED_FIXTURE_COUNT,
    repeats: REPEATS,
    plannedExecutions: TASK_MATRIX_EXECUTIONS,
    maximumRepairCallsPerExecution: 1,
    maximumWireCalls: TASK_MATRIX_EXECUTIONS * 2,
    status: "BLOCKED_BEFORE_PILOT_RESULT",
  },
  hardGates: HARD_GATES,
  scoredDimensions: SCORED_DIMENSIONS,
  cachePolicy: "durable_same_build_run_replay_only",
  settlementPolicy: "known_per_physical_call_required",
  decisionBoundaries: DECISION_BOUNDARIES,
} as const;

export const COPY_EVALUATION_V2_PLAN = deepFreeze(PLAN);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

const EXPECTED_PLAN_DIGEST_INPUT = JSON.stringify(canonicalize(PLAN));

/**
 * Exact admission guard for future manifest/dispatcher work. This validates the
 * complete zero-call contract, not merely the candidate names.
 */
export function validateCopyEvaluationV2Plan(plan: unknown): void {
  if (JSON.stringify(canonicalize(plan)) !== EXPECTED_PLAN_DIGEST_INPUT) {
    throw new Error("COPY_EVALUATION_V2_PLAN_DRIFT");
  }
}
