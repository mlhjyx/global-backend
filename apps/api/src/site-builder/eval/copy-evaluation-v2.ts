import {
  getModelProfileCandidatePool,
  SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID,
  type ModelCandidateProtocol,
} from "../agents/model-candidate-baseline";
import type { ModelProtocol } from "../../model-runtime";
import { COPY_TASK } from "../agents/copy";
import {
  COPY_ASSEMBLY_EVALUATOR_VERSION,
  COPY_ASSEMBLY_EVALUATOR_RUBRIC,
  COPY_ASSEMBLY_EVAL_FIXTURES,
  COPY_ASSEMBLY_EVAL_FIXTURE_SCHEMA_VERSION,
} from "./copy-assembly-eval";
import {
  COPY_EVALUATION_V2_CANDIDATES,
  type CopyEvaluationV2Candidate,
} from "./copy-evaluation-v2-candidates";
import { COPY_CAPABILITY_PILOT_PLAN } from "./copy-capability-pilot";
import { COPY_QUALITY_ACCEPTED_REPLAY_SCHEMA_VERSION } from "./copy-quality-accepted-replay";
import {
  COPY_QUALITY_GATE,
  COPY_QUALITY_REVIEW_SCHEMA_VERSION,
  COPY_QUALITY_RUBRIC_VERSION,
  COPY_QUALITY_SCORED_DIMENSIONS,
} from "./copy-quality-rubric";

export const COPY_EVALUATION_V2_SCHEMA_VERSION =
  "site-builder-copy-evaluation-plan/2026-08-07-v7" as const;

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
const SCORED_DIMENSIONS = COPY_QUALITY_SCORED_DIMENSIONS;
const DECISION_BOUNDARIES = Object.freeze([
  "capability_pilot_dispatch_requires_separate_user_authorization",
  "task_matrix_dispatch_requires_separate_user_authorization",
  "promotion_requires_separate_pr_and_user_authorization",
  "runtime_route_adoption_requires_separate_pr_and_user_authorization",
] as const);

const CANDIDATES: readonly CopyEvaluationV2Candidate[] =
  COPY_EVALUATION_V2_CANDIDATES;

const REQUIRED_ALIASES = Object.freeze(
  CANDIDATES.map((candidate) => candidate.alias),
);
const BASELINE_PROTOCOL_BY_RUNTIME_PROTOCOL: Readonly<
  Record<ModelProtocol, ModelCandidateProtocol>
> = Object.freeze({
  openai_responses: "openai-responses",
  openai_chat_completions: "openai-chat-completions",
  anthropic_messages: "anthropic-messages",
  google_native: "google-generate-content",
});
const currentPool = getModelProfileCandidatePool(COPY_PROFILE);
if (!currentPool) throw new Error("COPY_EVALUATION_V2_PROFILE_MISSING");
const CURRENT_ALIASES = Object.freeze(
  currentPool.candidates.map((candidate) => candidate.alias),
);
const CURRENT_BASELINE_CANDIDATES = Object.freeze(
  currentPool.candidates.map(({ alias, expectedProtocol, preflight }) =>
    Object.freeze({ alias, expectedProtocol, preflight }),
  ),
);
const REQUIRED_BASELINE_CANDIDATES = Object.freeze(
  CANDIDATES.map(({ alias, protocol }) =>
    Object.freeze({
      alias,
      expectedProtocol: BASELINE_PROTOCOL_BY_RUNTIME_PROTOCOL[protocol],
      preflight: "capability_probe" as const,
    }),
  ),
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

const TASK_CONTEXT_FIELD_IDS = Object.freeze({
  audience: "audience",
  brandVoice: "brand_voice",
  prohibitedAssertions: "prohibited_assertions",
  ctaPolicy: "cta_policy",
} as const);

function currentTaskContext(): readonly string[] {
  const schema = COPY_TASK.inputSchema as {
    required?: readonly string[];
    properties?: Record<string, { required?: readonly string[] } | undefined>;
  };
  if (!schema.required?.includes("context")) return Object.freeze([]);
  const required = schema.properties?.context?.required ?? [];
  return Object.freeze(
    required.map(
      (field) =>
        TASK_CONTEXT_FIELD_IDS[field as keyof typeof TASK_CONTEXT_FIELD_IDS] ??
        `unknown:${field}`,
    ),
  );
}

const CURRENT_TASK_CONTEXT = currentTaskContext();
const CURRENT_SCORED_DIMENSIONS = Object.freeze([
  ...COPY_ASSEMBLY_EVALUATOR_RUBRIC.scoredDimensions,
]);
const EVALUATOR_ADMISSION_STATUS = exactList(
  CURRENT_SCORED_DIMENSIONS,
  SCORED_DIMENSIONS,
)
  ? "READY"
  : "BLOCKED_ON_SCORED_EVALUATOR";
const CANDIDATE_ADMISSION_STATUS = exactList(CURRENT_ALIASES, REQUIRED_ALIASES)
  ? exactList(
      CURRENT_BASELINE_CANDIDATES.map(candidateAdmissionKey),
      REQUIRED_BASELINE_CANDIDATES.map(candidateAdmissionKey),
    )
    ? "READY"
    : "BLOCKED_ON_CANDIDATE_CAPABILITY_PREFLIGHT"
  : "BLOCKED_ON_CANDIDATE_REBASELINE";

function exactList(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function candidateAdmissionKey(candidate: {
  alias: string;
  expectedProtocol: ModelCandidateProtocol;
  preflight: string;
}): string {
  return `${candidate.alias}:${candidate.expectedProtocol}:${candidate.preflight}`;
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

function nonJson(path: string): never {
  throw new Error(`COPY_EVALUATION_V2_PLAN_NON_JSON: ${path}`);
}

function assertExactJsonDomain(
  value: unknown,
  path = "$",
  ancestors = new Set<object>(),
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) nonJson(path);
    return;
  }
  if (typeof value !== "object") nonJson(path);
  if (ancestors.has(value)) nonJson(`${path}:cycle`);
  const nextAncestors = new Set(ancestors).add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) nonJson(path);
    const expectedKeys = [
      ...Array.from({ length: value.length }, (_, index) => String(index)),
      "length",
    ];
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== expectedKeys.length ||
      ownKeys.some((key, index) => key !== expectedKeys[index])
    ) {
      nonJson(path);
    }
    value.forEach((nested, index) =>
      assertExactJsonDomain(nested, `${path}[${index}]`, nextAncestors),
    );
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) nonJson(path);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") nonJson(path);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor?.enumerable ||
      !("value" in descriptor) ||
      descriptor.get ||
      descriptor.set
    ) {
      nonJson(`${path}.${key}`);
    }
    assertExactJsonDomain(descriptor.value, `${path}.${key}`, nextAncestors);
  }
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
    currentCandidates: CURRENT_BASELINE_CANDIDATES,
    requiredCandidates: REQUIRED_BASELINE_CANDIDATES,
    status: CANDIDATE_ADMISSION_STATUS,
  },
  taskContract: {
    taskId: COPY_TASK.id,
    source: "apps/api/src/site-builder/agents/copy.ts",
    currentVersion: CURRENT_TASK_CONTRACT_VERSION,
    requiredVersion: REQUIRED_TASK_CONTRACT_VERSION,
    currentContext: CURRENT_TASK_CONTEXT,
    missingContext: Object.freeze(
      REQUIRED_TASK_CONTEXT.filter(
        (field) => !CURRENT_TASK_CONTEXT.includes(field),
      ),
    ),
    status:
      CURRENT_TASK_CONTRACT_VERSION !== REQUIRED_TASK_CONTRACT_VERSION
        ? "BLOCKED_ON_CONTEXT_V2"
        : exactList(CURRENT_TASK_CONTEXT, REQUIRED_TASK_CONTEXT)
          ? "READY"
          : "BLOCKED_ON_CONTEXT_FIELDS",
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
  evaluatorAdmission: {
    evaluatorVersion: COPY_ASSEMBLY_EVALUATOR_VERSION,
    reviewSchemaVersion: COPY_QUALITY_REVIEW_SCHEMA_VERSION,
    rubricVersion: COPY_QUALITY_RUBRIC_VERSION,
    currentScoredDimensions: CURRENT_SCORED_DIMENSIONS,
    requiredScoredDimensions: SCORED_DIMENSIONS,
    findingVocabulary: "closed_code_only",
    reviewerPolicy: "human_blind_or_independent_model_with_provider_separation",
    candidateIdentityVisibleToReviewer: false,
    executionReceiptPolicy: "restart_safe_git_reviewed_quality_output_replay",
    evidenceAcceptance: {
      replayContractVersion: COPY_QUALITY_ACCEPTED_REPLAY_SCHEMA_VERSION,
      status: "IMPLEMENTED_RESTART_SAFE",
      requiredClass: "git_reviewed_gateway_settlement_accepted",
      requiredKind: "quality_matrix",
      gitReviewPolicy: "immutable_artifact_on_merged_commit_required",
      rawEvidencePolicy: "reject_candidate_test_and_unknown_settlement",
      replayPolicy:
        "reopen_accepted_ledger_consume_once_and_verify_persisted_output_bytes",
      identityBindingPolicy:
        "candidate_fixture_repeat_input_prompt_plan_output_and_settlement",
      outputBytesPolicy:
        "canonical_utf8_json_exact_digest_and_length_max_65536",
      ledgerConsumptionPolicy:
        "one_shot_shared_git_acceptance_identity_namespace",
    },
    repeatBindingPolicy: "candidate_fixture_repeat_execution_output_digest",
    stabilityPolicy: "deterministic_two_repeat_normalized_token_dice",
    qualityGate: COPY_QUALITY_GATE,
    status: EVALUATOR_ADMISSION_STATUS,
  },
  requiredContext: REQUIRED_CONTEXT,
  capabilityPilot: {
    contractId: COPY_CAPABILITY_PILOT_PLAN.planId,
    contractSchemaVersion: COPY_CAPABILITY_PILOT_PLAN.schemaVersion,
    evidenceClassification: COPY_CAPABILITY_PILOT_PLAN.evidenceClassification,
    purpose: "protocol_schema_reasoning_usage_and_identity_only",
    aliases: REQUIRED_ALIASES,
    plannedExecutions: PILOT_EXECUTIONS,
    maximumRepairCallsPerExecution: 1,
    maximumWireCalls: PILOT_EXECUTIONS * 2,
    status:
      CANDIDATE_ADMISSION_STATUS === "READY"
        ? COPY_CAPABILITY_PILOT_PLAN.executionStatus
        : CANDIDATE_ADMISSION_STATUS,
  },
  taskMatrix: {
    purpose: "task_shaped_quality_after_capability_pilot",
    candidateCount: CANDIDATES.length,
    fixtureCount: REQUIRED_FIXTURE_COUNT,
    repeats: REPEATS,
    plannedExecutions: TASK_MATRIX_EXECUTIONS,
    maximumRepairCallsPerExecution: 1,
    maximumWireCalls: TASK_MATRIX_EXECUTIONS * 2,
    status:
      CANDIDATE_ADMISSION_STATUS !== "READY"
        ? CANDIDATE_ADMISSION_STATUS
        : EVALUATOR_ADMISSION_STATUS === "READY"
          ? "BLOCKED_BEFORE_CAPABILITY_PILOT_RESULT"
          : EVALUATOR_ADMISSION_STATUS,
  },
  hardGates: HARD_GATES,
  scoredDimensions: SCORED_DIMENSIONS,
  cachePolicy: {
    exactResultCache: "disabled_for_evaluation",
    repeatIdentity: "distinct_execution_and_cache_identity_per_repeat",
    durableReplay:
      "git_reviewed_exact_output_bytes_same_physical_execution_only",
  },
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

assertExactJsonDomain(PLAN);
const EXPECTED_PLAN_DIGEST_INPUT = JSON.stringify(canonicalize(PLAN));

/**
 * Exact admission guard for future manifest/dispatcher work. This validates the
 * complete zero-call contract, not merely the candidate names.
 */
export function validateCopyEvaluationV2Plan(plan: unknown): void {
  assertExactJsonDomain(plan);
  if (JSON.stringify(canonicalize(plan)) !== EXPECTED_PLAN_DIGEST_INPUT) {
    throw new Error("COPY_EVALUATION_V2_PLAN_DRIFT");
  }
}
