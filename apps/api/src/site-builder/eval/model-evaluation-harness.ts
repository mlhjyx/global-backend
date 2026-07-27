import {
  SITE_BUILDER_MODEL_CANDIDATE_BASELINE,
  SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID,
  MODEL_CANDIDATE_PROTOCOLS,
  getModelCandidateCatalogEntry,
  getModelProfileCandidatePool,
  type ModelCandidateDomain,
  type ModelCandidateProtocol,
  type ModelCandidateStatus,
} from "../agents/model-candidate-baseline";
import type { SiteBuilderModelProfileId } from "../agents/model-profiles";
import {
  BRAND_PROFILE_PROMPT_VERSION,
  BRAND_PROFILE_ROUTE_VALIDATION_VERSION,
  BRAND_PROFILE_TASK,
} from "../agents/brand-profile";
import {
  getSiteBuilderTaskRouteBinding,
  SITE_BUILDER_TASK_IDS,
  type SiteBuilderTaskId,
} from "../agents/task-route-bindings";
import {
  BRAND_PROFILE_EVALUATOR_RUBRIC,
  BRAND_PROFILE_EVALUATOR_VERSION,
  BRAND_PROFILE_EVAL_FIXTURE_SCHEMA_VERSION,
} from "./brand-profile-eval";
import {
  inspectEvaluationMatrix,
  sha256CanonicalJson,
} from "./eval-provenance";

export const MODEL_EVALUATION_HARNESS_SCHEMA_VERSION =
  "site-builder-model-evaluation-harness/v1" as const;
export const SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID =
  "site-builder-model-evaluation-harness/2026-07-27-v1" as const;
export const MODEL_EVALUATION_RUN_SCHEMA_VERSION =
  "site-builder-model-evaluation-run/v1" as const;

export interface TaskEvaluationEnvelope {
  maxTokens: number;
  runtimeDeadlineMs: number;
  diagnosticObservationMs: number;
  hardStopMs: number;
  perCallCostCapCents: number;
  reasoningEffort: "low" | "medium" | "high" | null;
}

export interface TaskEvaluationCandidate {
  alias: string;
  domain: ModelCandidateDomain;
  status: "runnable";
  expectedProtocol: ModelCandidateProtocol;
  gate: string;
}

export interface TaskEvaluationSuite {
  suiteId: string;
  adapterId: string;
  taskContractId: SiteBuilderTaskId;
  promptVersion: string;
  inputSchemaSha256: string;
  outputSchemaSha256: string;
  routeValidationVersion: string;
  evaluatorVersion: string;
  evaluatorRubricSha256: string;
  fixtureSetId: string;
  fixtureSchemaVersion: string;
  fixtureIds: readonly string[];
  fixtureFingerprints: readonly {
    fixtureId: string;
    fixtureSha256: string;
    promptSha256: string;
  }[];
  repeats: number;
  sourceBundleContractId: string;
}

const BRAND_PROFILE_EVALUATION_SUITE = Object.freeze({
  suiteId: "site-builder.brand-profile-evaluation-suite/2026-07-27-v1",
  adapterId: "site-builder.brand-profile-evaluation-adapter/v1",
  taskContractId: "site_builder.brand_profile",
  promptVersion: BRAND_PROFILE_PROMPT_VERSION,
  inputSchemaSha256: sha256CanonicalJson(BRAND_PROFILE_TASK.inputSchema),
  outputSchemaSha256: sha256CanonicalJson(BRAND_PROFILE_TASK.outputSchema),
  routeValidationVersion: BRAND_PROFILE_ROUTE_VALIDATION_VERSION,
  evaluatorVersion: BRAND_PROFILE_EVALUATOR_VERSION,
  evaluatorRubricSha256: sha256CanonicalJson(BRAND_PROFILE_EVALUATOR_RUBRIC),
  fixtureSetId: "site-builder.brand-profile-golden/2026-07-18-v1",
  fixtureSchemaVersion: BRAND_PROFILE_EVAL_FIXTURE_SCHEMA_VERSION,
  fixtureIds: Object.freeze([
    "auto-parts-rich",
    "auto-parts-sparse",
    "industrial-pump-rich",
    "industrial-pump-sparse",
    "lab-instrument-rich",
    "lab-instrument-sparse",
  ]),
  fixtureFingerprints: Object.freeze([
    Object.freeze({
      fixtureId: "auto-parts-rich",
      fixtureSha256:
        "50e9640021d259a328a505aec61cfd3a571399d2ccf4bc95b2a96c88b4121c96",
      promptSha256:
        "b3f9623a9d34c701ac4c6ee330117b06b02758528f359cfa7efede5e5ffac69c",
    }),
    Object.freeze({
      fixtureId: "auto-parts-sparse",
      fixtureSha256:
        "23257da1a72e8fa830fdb2cd6a33d7d5babb1ad9220d1e9c2b1f6757b5d1816f",
      promptSha256:
        "fecfad8b4e283b2fd03320e6f9fe81b35ce91f160d3920fca3b3bb74813841e3",
    }),
    Object.freeze({
      fixtureId: "industrial-pump-rich",
      fixtureSha256:
        "c8554a5ec56cb8d1f65075b989104063f1298a8af784b0cd503b2838376e76a9",
      promptSha256:
        "0f5d018ff030f5a4bb7883dea2028b7b1c9c8dc43d5cb2590fb781930e730748",
    }),
    Object.freeze({
      fixtureId: "industrial-pump-sparse",
      fixtureSha256:
        "402eed21b20da14f73616b58fb7dbd3ff6dd2f0d639d562308ae5730eb8039e5",
      promptSha256:
        "f3fe900ed70cd594afe1454ea3a4a5c4087f33cd96c6b426f5e0fc3b187e4db5",
    }),
    Object.freeze({
      fixtureId: "lab-instrument-rich",
      fixtureSha256:
        "08b4d1e16868c438f83adf527f91a48290943df83f039d78e09f222bd2d06445",
      promptSha256:
        "79ac24e5b584ac56d39a262f9d2e452eb7b96d27beafa34aaeecc2a8ae404a45",
    }),
    Object.freeze({
      fixtureId: "lab-instrument-sparse",
      fixtureSha256:
        "545ceb92c867be4acf5a24fa1280eb3a75854296e9a725418a3fe44df1050781",
      promptSha256:
        "c8cc937b3fd90e1951afb8ed369460d21b2a39c6cd3014a5df18e0320d75ac7f",
    }),
  ]),
  repeats: 2,
  sourceBundleContractId: "brand-profile-evaluation-source-bundle/v2",
}) satisfies TaskEvaluationSuite;

const TASK_EVALUATION_SUITES = Object.freeze(
  new Map<SiteBuilderTaskId, TaskEvaluationSuite>([
    ["site_builder.brand_profile", BRAND_PROFILE_EVALUATION_SUITE],
  ]),
);

export type TaskEvaluationDispatchAdmission =
  "task_evaluation_ready" | "blocked_no_evaluation_suite";

export interface TaskEvaluationPlan {
  schemaVersion: typeof MODEL_EVALUATION_HARNESS_SCHEMA_VERSION;
  harnessId: typeof SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID;
  candidateBaselineId: typeof SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID;
  taskId: SiteBuilderTaskId;
  profile: SiteBuilderModelProfileId;
  dispatchAdmission: TaskEvaluationDispatchAdmission;
  evaluationSuite: TaskEvaluationSuite | null;
  envelope: TaskEvaluationEnvelope;
  candidates: readonly TaskEvaluationCandidate[];
}

export type ProfileEvaluationDisposition =
  | "task_evaluation_ready"
  | "blocked_no_evaluation_suite"
  | "blocked_no_task_envelope"
  | "blocked_requires_media_gateway"
  | "blocked_no_candidate_pool";

export type ProfileCandidateAdmission =
  | "admitted_task_evaluation"
  | "blocked_no_evaluation_suite"
  | "blocked_no_task_envelope"
  | "blocked_requires_media_gateway"
  | "blocked_preview_shadow_only"
  | "blocked_deferred"
  | "blocked_legacy_only";

export interface ProfileCandidateEvaluationAdmission {
  alias: string;
  domain: ModelCandidateDomain;
  status: ModelCandidateStatus;
  expectedProtocol: ModelCandidateProtocol;
  admission: ProfileCandidateAdmission;
}

export interface ProfileEvaluationAdmission {
  profile: SiteBuilderModelProfileId;
  disposition: ProfileEvaluationDisposition;
  mappedTasks: readonly SiteBuilderTaskId[];
  candidates: readonly ProfileCandidateEvaluationAdmission[];
}

function evaluationEnvelope(taskId: SiteBuilderTaskId): TaskEvaluationEnvelope {
  const binding = getSiteBuilderTaskRouteBinding(taskId);
  const runtimeDeadlineMs = binding.timeoutMs;
  // A late response remains observable for one additional task-shaped window.
  // There is deliberately no global 120-second or 800-token evaluator default.
  const diagnosticObservationMs = binding.timeoutMs;
  return {
    maxTokens: binding.maxTokens,
    runtimeDeadlineMs,
    diagnosticObservationMs,
    hardStopMs: runtimeDeadlineMs + diagnosticObservationMs,
    perCallCostCapCents: binding.maxCostCents,
    reasoningEffort: binding.reasoningEffort ?? null,
  };
}

export function buildTaskEvaluationPlan(
  taskId: SiteBuilderTaskId,
): TaskEvaluationPlan {
  const taskPool =
    SITE_BUILDER_MODEL_CANDIDATE_BASELINE.taskEvaluationPools.find(
      (entry) => entry.taskId === taskId,
    );
  if (!taskPool) {
    throw new Error(
      `model evaluation task is absent from candidate baseline: ${taskId}`,
    );
  }
  const candidatePool = getModelProfileCandidatePool(taskPool.profile);
  if (!candidatePool) {
    throw new Error(
      `model evaluation profile has no candidate pool: ${taskPool.profile}`,
    );
  }
  if (candidatePool.activation !== "requires_task_evaluation") {
    throw new Error(
      `model evaluation task cannot dispatch without a task profile: ${taskId}`,
    );
  }

  const candidates = candidatePool.candidates.map((candidate) => {
    const catalog = getModelCandidateCatalogEntry(candidate.alias);
    if (catalog.status !== "runnable") {
      throw new Error(
        `model evaluation task candidate is not runnable: ${taskId}/${candidate.alias}/${catalog.status}`,
      );
    }
    if (catalog.domain !== "text") {
      throw new Error(
        `current task evaluation candidate must be text: ${taskId}/${candidate.alias}/${catalog.domain}`,
      );
    }
    return Object.freeze({
      alias: candidate.alias,
      domain: catalog.domain,
      status: catalog.status,
      expectedProtocol: candidate.expectedProtocol,
      gate: candidate.gate,
    });
  });

  return Object.freeze({
    schemaVersion: MODEL_EVALUATION_HARNESS_SCHEMA_VERSION,
    harnessId: SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID,
    candidateBaselineId: SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID,
    taskId,
    profile: taskPool.profile,
    dispatchAdmission: TASK_EVALUATION_SUITES.has(taskId)
      ? "task_evaluation_ready"
      : "blocked_no_evaluation_suite",
    evaluationSuite: TASK_EVALUATION_SUITES.get(taskId) ?? null,
    envelope: Object.freeze(evaluationEnvelope(taskId)),
    candidates: Object.freeze(candidates),
  });
}

export function buildAllTaskEvaluationPlans(): readonly TaskEvaluationPlan[] {
  return Object.freeze(SITE_BUILDER_TASK_IDS.map(buildTaskEvaluationPlan));
}

function candidateAdmission(
  status: ModelCandidateStatus,
  profileDisposition: ProfileEvaluationDisposition,
): ProfileCandidateAdmission {
  if (status === "preview") return "blocked_preview_shadow_only";
  if (status === "deferred") return "blocked_deferred";
  if (status === "legacy-only") return "blocked_legacy_only";
  if (profileDisposition === "blocked_requires_media_gateway") {
    return "blocked_requires_media_gateway";
  }
  if (profileDisposition === "blocked_no_evaluation_suite") {
    return "blocked_no_evaluation_suite";
  }
  if (profileDisposition !== "task_evaluation_ready") {
    return "blocked_no_task_envelope";
  }
  return "admitted_task_evaluation";
}

export function buildProfileEvaluationAdmission(
  profile: SiteBuilderModelProfileId,
): ProfileEvaluationAdmission {
  const pool = getModelProfileCandidatePool(profile);
  const mappedTasks = SITE_BUILDER_MODEL_CANDIDATE_BASELINE.taskEvaluationPools
    .filter((entry) => entry.profile === profile)
    .map((entry) => entry.taskId);
  if (!pool) {
    return Object.freeze({
      profile,
      disposition: "blocked_no_candidate_pool",
      mappedTasks: Object.freeze(mappedTasks),
      candidates: Object.freeze([]),
    });
  }
  const disposition: ProfileEvaluationDisposition =
    pool.activation === "requires_media_gateway"
      ? "blocked_requires_media_gateway"
      : mappedTasks.length === 0
        ? "blocked_no_task_envelope"
        : mappedTasks.some((taskId) => TASK_EVALUATION_SUITES.has(taskId))
          ? "task_evaluation_ready"
          : "blocked_no_evaluation_suite";
  const candidates = pool.candidates.map((candidate) => {
    const catalog = getModelCandidateCatalogEntry(candidate.alias);
    return Object.freeze({
      alias: candidate.alias,
      domain: catalog.domain,
      status: catalog.status,
      expectedProtocol: candidate.expectedProtocol,
      admission: candidateAdmission(catalog.status, disposition),
    });
  });
  return Object.freeze({
    profile,
    disposition,
    mappedTasks: Object.freeze(mappedTasks),
    candidates: Object.freeze(candidates),
  });
}

export type CapabilityProbeOutputState =
  "complete" | "empty" | "truncated" | "schema_invalid" | "provider_error";

export interface CapabilityProbeObservation {
  actualProtocol: ModelCandidateProtocol;
  requestedModel: string;
  reportedModel?: string;
  resolvedModel?: string;
  modelResolutionSource: "upstream_response" | "requested_fallback";
  outputState: CapabilityProbeOutputState;
}

export interface CapabilityProbeValidation {
  status:
    | "capability_proven"
    | "capability_unavailable"
    | "protocol_mismatch"
    | "identity_unproven"
    | "output_invalid";
  protocolVerified: boolean;
  identityVerified: boolean;
  outputVerified: boolean;
}

function exactModelIdentity(
  alias: string,
  observation: Pick<
    CapabilityProbeObservation,
    | "requestedModel"
    | "reportedModel"
    | "resolvedModel"
    | "modelResolutionSource"
  >,
): boolean {
  return (
    observation.requestedModel === alias &&
    observation.modelResolutionSource === "upstream_response" &&
    observation.reportedModel === alias &&
    observation.resolvedModel === alias
  );
}

export function validateCapabilityProbe(
  candidate: TaskEvaluationCandidate,
  observation: CapabilityProbeObservation,
): CapabilityProbeValidation {
  const protocolVerified =
    observation.actualProtocol === candidate.expectedProtocol;
  const identityVerified = exactModelIdentity(candidate.alias, observation);
  const outputVerified = observation.outputState === "complete";
  return {
    status:
      observation.outputState === "provider_error"
        ? "capability_unavailable"
        : !protocolVerified
          ? "protocol_mismatch"
          : !identityVerified
            ? "identity_unproven"
            : !outputVerified
              ? "output_invalid"
              : "capability_proven",
    protocolVerified,
    identityVerified,
    outputVerified,
  };
}

export type CostSettlement =
  | {
      state: "settled";
      amountCents: number;
      basis:
        | "provider_reported"
        | "frozen_pricing_snapshot"
        | "verified_billing_export";
    }
  | {
      state: "not_incurred";
      reason: "rejected_before_dispatch" | "provider_attested_not_incurred";
    }
  | {
      state: "unknown";
      reason:
        "provider_ack_unknown" | "diagnostic_hard_stop" | "invalid_settlement";
    };

export interface ModelEvaluationBudgetSettlementResult {
  settlement: CostSettlement;
  capExceeded: boolean;
  settlementInvalid: boolean;
}

export interface ModelEvaluationBudgetReservation {
  callId: string;
  reservedCents: number;
}

export type ModelEvaluationBudgetReserveResult =
  | {
      allowed: true;
      reservation: ModelEvaluationBudgetReservation;
    }
  | {
      allowed: false;
      reason:
        | "campaign_budget_exhausted"
        | "unknown_settlement"
        | "per_call_cap_exceeded"
        | "duplicate_call";
    };

export interface ModelEvaluationBudgetSnapshot {
  campaignBudgetCents: number;
  committedCents: number;
  reservedCents: number;
  unknownUpperBoundCents: number;
  remainingDispatchableCents: number;
  blocked: boolean;
  blockReason: "unknown_settlement" | "per_call_cap_exceeded" | null;
}

function assertNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
}

export class ModelEvaluationBudgetGuard {
  private readonly reservations = new Map<string, number>();
  private readonly completedCalls = new Set<string>();
  private committedCents = 0;
  private unknownUpperBoundCents = 0;
  private blockReason: "unknown_settlement" | "per_call_cap_exceeded" | null =
    null;

  constructor(readonly campaignBudgetCents: number) {
    assertNonNegativeFinite(campaignBudgetCents, "campaignBudgetCents");
    if (campaignBudgetCents === 0) {
      throw new Error("campaignBudgetCents must be greater than zero");
    }
  }

  reserve(
    callId: string,
    perCallCapCents: number,
  ): ModelEvaluationBudgetReserveResult {
    assertNonNegativeFinite(perCallCapCents, "perCallCapCents");
    if (perCallCapCents === 0) {
      throw new Error("perCallCapCents must be greater than zero");
    }
    if (this.reservations.has(callId) || this.completedCalls.has(callId)) {
      return { allowed: false, reason: "duplicate_call" };
    }
    if (this.blockReason) {
      return { allowed: false, reason: this.blockReason };
    }
    if (perCallCapCents > this.remainingDispatchableCents()) {
      return { allowed: false, reason: "campaign_budget_exhausted" };
    }
    this.reservations.set(callId, perCallCapCents);
    return {
      allowed: true,
      reservation: { callId, reservedCents: perCallCapCents },
    };
  }

  settle(
    callId: string,
    settlement: CostSettlement,
  ): ModelEvaluationBudgetSettlementResult {
    const reservedCents = this.reservations.get(callId);
    if (reservedCents === undefined) {
      throw new Error(
        `model evaluation call has no active reservation: ${callId}`,
      );
    }
    const normalized = normalizeCostSettlement(settlement);
    this.reservations.delete(callId);
    this.completedCalls.add(callId);

    if (normalized.settlement.state === "unknown") {
      this.unknownUpperBoundCents += reservedCents;
      this.blockReason = "unknown_settlement";
      return normalized;
    }
    if (normalized.settlement.state === "not_incurred") return normalized;

    this.committedCents += normalized.settlement.amountCents;
    if (
      normalized.settlement.amountCents > reservedCents ||
      this.committedCents + this.unknownUpperBoundCents >
        this.campaignBudgetCents
    ) {
      this.blockReason = "per_call_cap_exceeded";
    }
    return {
      ...normalized,
      capExceeded: normalized.settlement.amountCents > reservedCents,
    };
  }

  private reservedCents(): number {
    return [...this.reservations.values()].reduce(
      (total, value) => total + value,
      0,
    );
  }

  private remainingDispatchableCents(): number {
    return Math.max(
      0,
      this.campaignBudgetCents -
        this.committedCents -
        this.reservedCents() -
        this.unknownUpperBoundCents,
    );
  }

  snapshot(): ModelEvaluationBudgetSnapshot {
    return {
      campaignBudgetCents: this.campaignBudgetCents,
      committedCents: this.committedCents,
      reservedCents: this.reservedCents(),
      unknownUpperBoundCents: this.unknownUpperBoundCents,
      remainingDispatchableCents: this.remainingDispatchableCents(),
      blocked: this.blockReason !== null,
      blockReason: this.blockReason,
    };
  }
}

const SETTLED_COST_BASES = new Set([
  "provider_reported",
  "frozen_pricing_snapshot",
  "verified_billing_export",
]);
const NOT_INCURRED_REASONS = new Set([
  "rejected_before_dispatch",
  "provider_attested_not_incurred",
]);
const UNKNOWN_COST_REASONS = new Set([
  "provider_ack_unknown",
  "diagnostic_hard_stop",
  "invalid_settlement",
]);

function exactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort())
  );
}

function normalizeCostSettlement(
  value: unknown,
): ModelEvaluationBudgetSettlementResult {
  const invalid = (): ModelEvaluationBudgetSettlementResult => ({
    settlement: { state: "unknown", reason: "invalid_settlement" },
    capExceeded: false,
    settlementInvalid: true,
  });
  if (!value || typeof value !== "object") return invalid();
  const record = value as Record<string, unknown>;
  if (record.state === "settled") {
    if (
      !exactKeys(record, ["state", "amountCents", "basis"]) ||
      typeof record.amountCents !== "number" ||
      !Number.isFinite(record.amountCents) ||
      record.amountCents < 0 ||
      typeof record.basis !== "string" ||
      !SETTLED_COST_BASES.has(record.basis)
    ) {
      return invalid();
    }
    return {
      settlement: {
        state: "settled",
        amountCents: record.amountCents,
        basis: record.basis as Extract<
          CostSettlement,
          { state: "settled" }
        >["basis"],
      },
      capExceeded: false,
      settlementInvalid: false,
    };
  }
  if (record.state === "not_incurred") {
    if (
      !exactKeys(record, ["state", "reason"]) ||
      typeof record.reason !== "string" ||
      !NOT_INCURRED_REASONS.has(record.reason)
    ) {
      return invalid();
    }
    return {
      settlement: {
        state: "not_incurred",
        reason: record.reason as Extract<
          CostSettlement,
          { state: "not_incurred" }
        >["reason"],
      },
      capExceeded: false,
      settlementInvalid: false,
    };
  }
  if (record.state === "unknown") {
    if (
      !exactKeys(record, ["state", "reason"]) ||
      typeof record.reason !== "string" ||
      !UNKNOWN_COST_REASONS.has(record.reason)
    ) {
      return invalid();
    }
    return {
      settlement: {
        state: "unknown",
        reason: record.reason as Extract<
          CostSettlement,
          { state: "unknown" }
        >["reason"],
      },
      capExceeded: false,
      settlementInvalid: false,
    };
  }
  return invalid();
}

export interface TaskArtifactAssessment {
  qualityPassed: boolean;
  structurePassed: boolean;
  factualityPassed: boolean;
  stabilityKey: string;
  findingCodes: readonly string[];
}

const STABILITY_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FINDING_CODE = /^[a-z][a-z0-9_]{0,63}$/;

function assertTaskArtifactAssessment(
  assessment: unknown,
): asserts assessment is TaskArtifactAssessment {
  if (!assessment || typeof assessment !== "object") {
    throw new Error("task artifact assessment must be an object");
  }
  const record = assessment as Record<string, unknown>;
  if (
    !exactKeys(record, [
      "qualityPassed",
      "structurePassed",
      "factualityPassed",
      "stabilityKey",
      "findingCodes",
    ]) ||
    typeof record.qualityPassed !== "boolean" ||
    typeof record.structurePassed !== "boolean" ||
    typeof record.factualityPassed !== "boolean" ||
    typeof record.stabilityKey !== "string" ||
    !Array.isArray(record.findingCodes) ||
    record.findingCodes.some((code) => typeof code !== "string")
  ) {
    throw new Error("task artifact assessment shape is invalid");
  }
  if (!STABILITY_KEY.test(record.stabilityKey)) {
    throw new Error("task artifact assessment stabilityKey is invalid");
  }
  if (
    record.findingCodes.length > 32 ||
    new Set(record.findingCodes).size !== record.findingCodes.length ||
    record.findingCodes.some((code) => !FINDING_CODE.test(code))
  ) {
    throw new Error("task artifact assessment findingCodes are invalid");
  }
}

export interface ModelEvaluationCallResult<T> {
  artifactState: "complete" | "empty" | "truncated";
  artifact?: T;
  artifactSha256?: string;
  actualProtocol: ModelCandidateProtocol;
  requestedModel: string;
  reportedModel?: string;
  resolvedModel?: string;
  modelResolutionSource: "upstream_response" | "requested_fallback";
  usage: ModelEvaluationUsage;
  costSettlement: CostSettlement;
}

export interface ModelEvaluationUsage {
  inputTokens: number;
  outputTokens: number;
  callCount: number;
  source: "provider_reported" | "adapter_aggregated";
}

export type ModelEvaluationResultClass =
  | "quality_valid_runtime_on_time"
  | "quality_valid_runtime_late"
  | "content_invalid"
  | "protocol_or_identity_invalid"
  | "provenance_invalid"
  | "capability_unavailable"
  | "diagnostic_window_exhausted"
  | "budget_stop";

export type ModelEvaluationRuntimeTiming =
  "on_time" | "late" | "diagnostic_exhausted" | "not_started";

export interface CompletedTaskResultClassification {
  resultClass: ModelEvaluationResultClass;
  runtimeTiming: Exclude<
    ModelEvaluationRuntimeTiming,
    "diagnostic_exhausted" | "not_started"
  >;
  protocolVerified: boolean;
  identityVerified: boolean;
  artifactAccepted: boolean;
  failureCode: string | null;
}

function assertCandidateBelongsToPlan(
  plan: TaskEvaluationPlan,
  candidate: TaskEvaluationCandidate,
): void {
  let canonicalPlan: TaskEvaluationPlan;
  try {
    canonicalPlan = buildTaskEvaluationPlan(plan.taskId);
  } catch {
    throw new Error("task evaluation plan is not canonical");
  }
  const planShape = (value: TaskEvaluationPlan) => ({
    schemaVersion: value.schemaVersion,
    harnessId: value.harnessId,
    candidateBaselineId: value.candidateBaselineId,
    taskId: value.taskId,
    profile: value.profile,
    dispatchAdmission: value.dispatchAdmission,
    evaluationSuite: value.evaluationSuite,
    envelope: {
      maxTokens: value.envelope.maxTokens,
      runtimeDeadlineMs: value.envelope.runtimeDeadlineMs,
      diagnosticObservationMs: value.envelope.diagnosticObservationMs,
      hardStopMs: value.envelope.hardStopMs,
      perCallCostCapCents: value.envelope.perCallCostCapCents,
      reasoningEffort: value.envelope.reasoningEffort,
    },
    candidates: value.candidates.map((entry) => ({
      alias: entry.alias,
      domain: entry.domain,
      status: entry.status,
      expectedProtocol: entry.expectedProtocol,
      gate: entry.gate,
    })),
  });
  if (
    JSON.stringify(planShape(plan)) !== JSON.stringify(planShape(canonicalPlan))
  ) {
    throw new Error("task evaluation plan is not canonical");
  }
  const planned = plan.candidates.find(
    (entry) => entry.alias === candidate.alias,
  );
  if (
    !planned ||
    planned.expectedProtocol !== candidate.expectedProtocol ||
    planned.status !== candidate.status ||
    planned.domain !== candidate.domain ||
    planned.gate !== candidate.gate
  ) {
    throw new Error(
      `candidate is not an exact member of the task evaluation plan: ${plan.taskId}/${candidate.alias}`,
    );
  }
}

export function classifyCompletedTaskResult<T>(input: {
  plan: TaskEvaluationPlan;
  candidate: TaskEvaluationCandidate;
  elapsedMs: number;
  call: ModelEvaluationCallResult<T>;
  assessment: TaskArtifactAssessment | null;
}): CompletedTaskResultClassification {
  assertCandidateBelongsToPlan(input.plan, input.candidate);
  assertNonNegativeFinite(input.elapsedMs, "elapsedMs");
  if (input.elapsedMs > input.plan.envelope.hardStopMs) {
    throw new Error("completed result arrived after the diagnostic hard stop");
  }
  const runtimeTiming =
    input.elapsedMs <= input.plan.envelope.runtimeDeadlineMs
      ? "on_time"
      : "late";
  const protocolVerified =
    input.call.actualProtocol === input.candidate.expectedProtocol;
  const identityVerified = exactModelIdentity(
    input.candidate.alias,
    input.call,
  );
  if (!protocolVerified || !identityVerified) {
    return {
      resultClass: "protocol_or_identity_invalid",
      runtimeTiming,
      protocolVerified,
      identityVerified,
      artifactAccepted: false,
      failureCode: !protocolVerified
        ? "protocol_mismatch"
        : "identity_unproven",
    };
  }
  if (
    input.call.artifactState !== "complete" ||
    input.call.artifact === undefined ||
    input.assessment === null
  ) {
    return {
      resultClass: "content_invalid",
      runtimeTiming,
      protocolVerified,
      identityVerified,
      artifactAccepted: false,
      failureCode:
        input.call.artifactState === "truncated"
          ? "output_truncated"
          : input.call.artifactState === "empty"
            ? "output_empty"
            : "assessment_missing",
    };
  }
  assertTaskArtifactAssessment(input.assessment);
  const artifactAccepted =
    input.assessment.qualityPassed &&
    input.assessment.structurePassed &&
    input.assessment.factualityPassed;
  return {
    resultClass: artifactAccepted
      ? runtimeTiming === "on_time"
        ? "quality_valid_runtime_on_time"
        : "quality_valid_runtime_late"
      : "content_invalid",
    runtimeTiming,
    protocolVerified,
    identityVerified,
    artifactAccepted,
    failureCode: artifactAccepted ? null : "content_invalid",
  };
}

export interface ModelEvaluationRun {
  schemaVersion: typeof MODEL_EVALUATION_RUN_SCHEMA_VERSION;
  harnessId: typeof SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID;
  candidateBaselineId: typeof SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID;
  taskId: SiteBuilderTaskId;
  profile: SiteBuilderModelProfileId;
  alias: string;
  expectedProtocol: ModelCandidateProtocol;
  actualProtocol: ModelCandidateProtocol | null;
  requestedModel: string;
  reportedModel: string | null;
  resolvedModel: string | null;
  modelResolutionSource: "upstream_response" | "requested_fallback" | null;
  evaluationSuiteId: string;
  adapterId: string;
  taskContractFingerprint: string;
  fixtureSetId: string;
  sourceBundleContractId: string;
  fixtureId: string;
  fixtureSha256: string;
  promptSha256: string;
  sourceBundleSha256: string;
  evaluatorVersion: string;
  evaluatorRubricSha256: string;
  artifactSha256: string | null;
  attempt: number;
  resultClass: ModelEvaluationResultClass;
  runtimeTiming: ModelEvaluationRuntimeTiming;
  elapsedMs: number;
  protocolVerified: boolean;
  identityVerified: boolean;
  artifactAccepted: boolean;
  assessment: TaskArtifactAssessment | null;
  costSettlement: CostSettlement;
  budgetCapExceeded: boolean;
  settlementInvalid: boolean;
  usage: ModelEvaluationUsage | null;
  failureCode: string | null;
}

export interface ModelEvaluationCaseContract {
  suiteId: string;
  adapterId: string;
  taskContractId: SiteBuilderTaskId;
  taskContractFingerprint: string;
  promptVersion: string;
  inputSchemaSha256: string;
  outputSchemaSha256: string;
  routeValidationVersion: string;
  evaluatorVersion: string;
  evaluatorRubricSha256: string;
  fixtureSetId: string;
  sourceBundleContractId: string;
  fixtureSchemaVersion: string;
  fixtureId: string;
  fixtureSha256: string;
  promptSha256: string;
  sourceBundleSha256: string;
}

export interface ModelEvaluationExecutionRequest {
  taskId: SiteBuilderTaskId;
  profile: SiteBuilderModelProfileId;
  alias: string;
  expectedProtocol: ModelCandidateProtocol;
  fixtureId: string;
  attempt: number;
  maxTokens: number;
  runtimeDeadlineMs: number;
  hardStopMs: number;
  perCallCostCapCents: number;
  reasoningEffort: "low" | "medium" | "high" | null;
  caseContract: ModelEvaluationCaseContract;
  signal: AbortSignal;
}

export class ModelEvaluationCallError extends Error {
  constructor(
    readonly failureCode: string,
    readonly costSettlement: CostSettlement,
  ) {
    super(failureCode);
    this.name = "ModelEvaluationCallError";
  }
}

const SHA256 = /^[a-f0-9]{64}$/;

export function taskEvaluationContractFingerprint(
  suite: TaskEvaluationSuite,
): string {
  return sha256CanonicalJson({
    taskContractId: suite.taskContractId,
    promptVersion: suite.promptVersion,
    inputSchemaSha256: suite.inputSchemaSha256,
    outputSchemaSha256: suite.outputSchemaSha256,
    routeValidationVersion: suite.routeValidationVersion,
    evaluatorVersion: suite.evaluatorVersion,
    evaluatorRubricSha256: suite.evaluatorRubricSha256,
    fixtureSetId: suite.fixtureSetId,
    fixtureSchemaVersion: suite.fixtureSchemaVersion,
    fixtureFingerprints: suite.fixtureFingerprints,
    sourceBundleContractId: suite.sourceBundleContractId,
  });
}

function assertCaseContract(
  plan: TaskEvaluationPlan,
  contract: ModelEvaluationCaseContract,
): void {
  const suite = plan.evaluationSuite;
  if (!suite) {
    throw new Error(`task evaluation has no canonical suite: ${plan.taskId}`);
  }
  const fixedContract = {
    suiteId: contract.suiteId,
    adapterId: contract.adapterId,
    taskContractId: contract.taskContractId,
    taskContractFingerprint: contract.taskContractFingerprint,
    promptVersion: contract.promptVersion,
    inputSchemaSha256: contract.inputSchemaSha256,
    outputSchemaSha256: contract.outputSchemaSha256,
    routeValidationVersion: contract.routeValidationVersion,
    evaluatorVersion: contract.evaluatorVersion,
    evaluatorRubricSha256: contract.evaluatorRubricSha256,
    fixtureSetId: contract.fixtureSetId,
    sourceBundleContractId: contract.sourceBundleContractId,
    fixtureSchemaVersion: contract.fixtureSchemaVersion,
  };
  const expected = {
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
  };
  if (JSON.stringify(fixedContract) !== JSON.stringify(expected)) {
    throw new Error("model evaluation case contract is not canonical");
  }
  const fixture = suite.fixtureFingerprints.find(
    (entry) => entry.fixtureId === contract.fixtureId,
  );
  if (
    !fixture ||
    contract.fixtureSha256 !== fixture.fixtureSha256 ||
    contract.promptSha256 !== fixture.promptSha256 ||
    !SHA256.test(contract.sourceBundleSha256)
  ) {
    throw new Error("model evaluation case fingerprints are invalid");
  }
}

function runIdentity(
  plan: TaskEvaluationPlan,
  candidate: TaskEvaluationCandidate,
  caseContract: ModelEvaluationCaseContract,
  attempt: number,
): Pick<
  ModelEvaluationRun,
  | "schemaVersion"
  | "harnessId"
  | "candidateBaselineId"
  | "taskId"
  | "profile"
  | "alias"
  | "expectedProtocol"
  | "actualProtocol"
  | "requestedModel"
  | "reportedModel"
  | "resolvedModel"
  | "modelResolutionSource"
  | "evaluationSuiteId"
  | "adapterId"
  | "taskContractFingerprint"
  | "fixtureSetId"
  | "sourceBundleContractId"
  | "fixtureId"
  | "fixtureSha256"
  | "promptSha256"
  | "sourceBundleSha256"
  | "evaluatorVersion"
  | "evaluatorRubricSha256"
  | "artifactSha256"
  | "attempt"
> {
  return {
    schemaVersion: MODEL_EVALUATION_RUN_SCHEMA_VERSION,
    harnessId: SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID,
    candidateBaselineId: SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID,
    taskId: plan.taskId,
    profile: plan.profile,
    alias: candidate.alias,
    expectedProtocol: candidate.expectedProtocol,
    actualProtocol: null,
    requestedModel: candidate.alias,
    reportedModel: null,
    resolvedModel: null,
    modelResolutionSource: null,
    evaluationSuiteId: caseContract.suiteId,
    adapterId: caseContract.adapterId,
    taskContractFingerprint: caseContract.taskContractFingerprint,
    fixtureSetId: caseContract.fixtureSetId,
    sourceBundleContractId: caseContract.sourceBundleContractId,
    fixtureId: caseContract.fixtureId,
    fixtureSha256: caseContract.fixtureSha256,
    promptSha256: caseContract.promptSha256,
    sourceBundleSha256: caseContract.sourceBundleSha256,
    evaluatorVersion: caseContract.evaluatorVersion,
    evaluatorRubricSha256: caseContract.evaluatorRubricSha256,
    artifactSha256: null,
    attempt,
  };
}

function callProvenance<T>(
  value: ModelEvaluationCallResult<T>,
): Pick<
  ModelEvaluationRun,
  | "actualProtocol"
  | "requestedModel"
  | "reportedModel"
  | "resolvedModel"
  | "modelResolutionSource"
  | "artifactSha256"
> {
  return {
    actualProtocol: MODEL_CANDIDATE_PROTOCOLS.includes(value.actualProtocol)
      ? value.actualProtocol
      : null,
    requestedModel:
      typeof value.requestedModel === "string" ? value.requestedModel : "",
    reportedModel:
      typeof value.reportedModel === "string" ? value.reportedModel : null,
    resolvedModel:
      typeof value.resolvedModel === "string" ? value.resolvedModel : null,
    modelResolutionSource:
      value.modelResolutionSource === "upstream_response" ||
      value.modelResolutionSource === "requested_fallback"
        ? value.modelResolutionSource
        : null,
    artifactSha256:
      typeof value.artifactSha256 === "string" ? value.artifactSha256 : null,
  };
}

function validCallIdentityShape<T>(
  value: ModelEvaluationCallResult<T>,
): boolean {
  return (
    MODEL_CANDIDATE_PROTOCOLS.includes(value.actualProtocol) &&
    typeof value.requestedModel === "string" &&
    value.requestedModel.length > 0 &&
    (value.reportedModel === undefined ||
      typeof value.reportedModel === "string") &&
    (value.resolvedModel === undefined ||
      typeof value.resolvedModel === "string") &&
    (value.modelResolutionSource === "upstream_response" ||
      value.modelResolutionSource === "requested_fallback")
  );
}

function validEvaluationUsage(value: unknown): value is ModelEvaluationUsage {
  if (!value || typeof value !== "object") return false;
  const usage = value as Record<string, unknown>;
  return (
    exactKeys(usage, ["inputTokens", "outputTokens", "callCount", "source"]) &&
    Number.isInteger(usage.inputTokens) &&
    (usage.inputTokens as number) >= 0 &&
    Number.isInteger(usage.outputTokens) &&
    (usage.outputTokens as number) >= 0 &&
    Number.isInteger(usage.callCount) &&
    (usage.callCount as number) >= 1 &&
    (usage.source === "provider_reported" ||
      usage.source === "adapter_aggregated")
  );
}

function validArtifactFingerprint<T>(
  value: ModelEvaluationCallResult<T>,
): boolean {
  if (value.artifactState !== "complete" || value.artifact === undefined) {
    return value.artifactSha256 === undefined;
  }
  try {
    return (
      typeof value.artifactSha256 === "string" &&
      value.artifactSha256 === sha256CanonicalJson(value.artifact)
    );
  } catch {
    return false;
  }
}

export async function runTaskEvaluationAttempt<T>(options: {
  plan: TaskEvaluationPlan;
  candidate: TaskEvaluationCandidate;
  caseContract: ModelEvaluationCaseContract;
  attempt: number;
  campaignBudget: ModelEvaluationBudgetGuard;
  execute: (
    request: ModelEvaluationExecutionRequest,
  ) => Promise<ModelEvaluationCallResult<T>>;
  gradeArtifact: (
    artifact: T,
    context: {
      taskId: SiteBuilderTaskId;
      fixtureId: string;
      attempt: number;
    },
  ) => TaskArtifactAssessment;
  now?: () => number;
}): Promise<ModelEvaluationRun> {
  assertCandidateBelongsToPlan(options.plan, options.candidate);
  if (
    options.plan.dispatchAdmission !== "task_evaluation_ready" ||
    !options.plan.evaluationSuite
  ) {
    throw new Error(
      `task evaluation has no canonical suite: ${options.plan.taskId}`,
    );
  }
  if (
    !Number.isInteger(options.attempt) ||
    options.attempt < 1 ||
    options.attempt > options.plan.evaluationSuite.repeats
  ) {
    throw new Error(
      `model evaluation attempt must be within 1..${options.plan.evaluationSuite.repeats}`,
    );
  }
  assertCaseContract(options.plan, options.caseContract);
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  if (!Number.isFinite(startedAt)) {
    throw new Error("model evaluation monotonic clock is invalid");
  }
  const identity = runIdentity(
    options.plan,
    options.candidate,
    options.caseContract,
    options.attempt,
  );
  const callId = [
    options.plan.taskId,
    options.candidate.alias,
    options.caseContract.fixtureId,
    options.attempt,
  ].join(":");
  const reservation = options.campaignBudget.reserve(
    callId,
    options.plan.envelope.perCallCostCapCents,
  );
  if (!reservation.allowed) {
    return {
      ...identity,
      resultClass: "budget_stop",
      runtimeTiming: "not_started",
      elapsedMs: 0,
      protocolVerified: false,
      identityVerified: false,
      artifactAccepted: false,
      assessment: null,
      costSettlement: {
        state: "not_incurred",
        reason: "rejected_before_dispatch",
      },
      budgetCapExceeded: false,
      settlementInvalid: false,
      usage: null,
      failureCode: reservation.reason,
    };
  }

  const controller = new AbortController();
  const request: ModelEvaluationExecutionRequest = {
    taskId: options.plan.taskId,
    profile: options.plan.profile,
    alias: options.candidate.alias,
    expectedProtocol: options.candidate.expectedProtocol,
    fixtureId: options.caseContract.fixtureId,
    attempt: options.attempt,
    maxTokens: options.plan.envelope.maxTokens,
    runtimeDeadlineMs: options.plan.envelope.runtimeDeadlineMs,
    hardStopMs: options.plan.envelope.hardStopMs,
    perCallCostCapCents: options.plan.envelope.perCallCostCapCents,
    reasoningEffort: options.plan.envelope.reasoningEffort,
    caseContract: options.caseContract,
    signal: controller.signal,
  };

  type ExecutionOutcome =
    | { kind: "completed"; value: ModelEvaluationCallResult<T> }
    | { kind: "failed"; error: unknown }
    | { kind: "hard_stop" };
  let timer: NodeJS.Timeout | undefined;
  const execution = Promise.resolve()
    .then(() => options.execute(request))
    .then<ExecutionOutcome, ExecutionOutcome>(
      (value) => ({ kind: "completed", value }),
      (error: unknown) => ({ kind: "failed", error }),
    );
  const hardStop = new Promise<ExecutionOutcome>((resolve) => {
    timer = setTimeout(
      () => resolve({ kind: "hard_stop" }),
      options.plan.envelope.hardStopMs,
    );
  });
  const outcome = await Promise.race([execution, hardStop]);
  if (timer) clearTimeout(timer);

  if (outcome.kind === "hard_stop") {
    controller.abort(new Error("model evaluation diagnostic window exhausted"));
    const settled = options.campaignBudget.settle(callId, {
      state: "unknown",
      reason: "diagnostic_hard_stop",
    });
    return {
      ...identity,
      resultClass: "diagnostic_window_exhausted",
      runtimeTiming: "diagnostic_exhausted",
      elapsedMs: options.plan.envelope.hardStopMs,
      protocolVerified: false,
      identityVerified: false,
      artifactAccepted: false,
      assessment: null,
      costSettlement: settled.settlement,
      budgetCapExceeded: settled.capExceeded,
      settlementInvalid: settled.settlementInvalid,
      usage: null,
      failureCode: "diagnostic_window_exhausted",
    };
  }

  const elapsedMs = now() - startedAt;
  const elapsedIsValid = Number.isFinite(elapsedMs) && elapsedMs >= 0;
  if (outcome.kind === "failed") {
    const failure =
      outcome.error instanceof ModelEvaluationCallError
        ? outcome.error
        : new ModelEvaluationCallError("unknown_provider_error", {
            state: "unknown",
            reason: "provider_ack_unknown",
          });
    const settled = options.campaignBudget.settle(
      callId,
      failure.costSettlement,
    );
    if (!elapsedIsValid) {
      return {
        ...identity,
        resultClass: "capability_unavailable",
        runtimeTiming: "not_started",
        elapsedMs: 0,
        protocolVerified: false,
        identityVerified: false,
        artifactAccepted: false,
        assessment: null,
        costSettlement: settled.settlement,
        budgetCapExceeded: settled.capExceeded,
        settlementInvalid: settled.settlementInvalid,
        usage: null,
        failureCode: "monotonic_clock_invalid",
      };
    }
    if (elapsedMs > options.plan.envelope.hardStopMs) {
      return {
        ...identity,
        resultClass: "diagnostic_window_exhausted",
        runtimeTiming: "diagnostic_exhausted",
        elapsedMs,
        protocolVerified: false,
        identityVerified: false,
        artifactAccepted: false,
        assessment: null,
        costSettlement: settled.settlement,
        budgetCapExceeded: settled.capExceeded,
        settlementInvalid: settled.settlementInvalid,
        usage: null,
        failureCode: "completed_after_hard_stop",
      };
    }
    return {
      ...identity,
      resultClass: "capability_unavailable",
      runtimeTiming:
        elapsedMs <= options.plan.envelope.runtimeDeadlineMs
          ? "on_time"
          : "late",
      elapsedMs,
      protocolVerified: false,
      identityVerified: false,
      artifactAccepted: false,
      assessment: null,
      costSettlement: settled.settlement,
      budgetCapExceeded: settled.capExceeded,
      settlementInvalid: settled.settlementInvalid,
      usage: null,
      failureCode: failure.failureCode,
    };
  }

  if (!outcome.value || typeof outcome.value !== "object") {
    const settled = options.campaignBudget.settle(
      callId,
      null as unknown as CostSettlement,
    );
    return {
      ...identity,
      resultClass: "provenance_invalid",
      runtimeTiming:
        elapsedIsValid && elapsedMs > options.plan.envelope.runtimeDeadlineMs
          ? "late"
          : "on_time",
      elapsedMs: elapsedIsValid ? elapsedMs : 0,
      protocolVerified: false,
      identityVerified: false,
      artifactAccepted: false,
      assessment: null,
      costSettlement: settled.settlement,
      budgetCapExceeded: settled.capExceeded,
      settlementInvalid: settled.settlementInvalid,
      usage: null,
      failureCode: "call_result_invalid",
    };
  }

  const settled = options.campaignBudget.settle(
    callId,
    outcome.value.costSettlement,
  );
  const provenance = callProvenance(outcome.value);
  const callIdentityShapeVerified = validCallIdentityShape(outcome.value);
  const usageVerified = validEvaluationUsage(outcome.value.usage);
  const artifactFingerprintVerified = validArtifactFingerprint(outcome.value);
  if (!elapsedIsValid) {
    return {
      ...identity,
      ...provenance,
      resultClass: "capability_unavailable",
      runtimeTiming: "not_started",
      elapsedMs: 0,
      protocolVerified: false,
      identityVerified: false,
      artifactAccepted: false,
      assessment: null,
      costSettlement: settled.settlement,
      budgetCapExceeded: settled.capExceeded,
      settlementInvalid: settled.settlementInvalid,
      usage: usageVerified ? { ...outcome.value.usage } : null,
      failureCode: "monotonic_clock_invalid",
    };
  }
  const protocolVerified =
    outcome.value.actualProtocol === options.candidate.expectedProtocol;
  const identityVerified = exactModelIdentity(
    options.candidate.alias,
    outcome.value,
  );
  if (elapsedMs > options.plan.envelope.hardStopMs) {
    return {
      ...identity,
      ...provenance,
      resultClass: "diagnostic_window_exhausted",
      runtimeTiming: "diagnostic_exhausted",
      elapsedMs,
      protocolVerified,
      identityVerified,
      artifactAccepted: false,
      assessment: null,
      costSettlement: settled.settlement,
      budgetCapExceeded: settled.capExceeded,
      settlementInvalid: settled.settlementInvalid,
      usage: usageVerified ? { ...outcome.value.usage } : null,
      failureCode: "completed_after_hard_stop",
    };
  }
  if (
    !callIdentityShapeVerified ||
    !usageVerified ||
    !artifactFingerprintVerified
  ) {
    return {
      ...identity,
      ...provenance,
      resultClass: "provenance_invalid",
      runtimeTiming:
        elapsedMs <= options.plan.envelope.runtimeDeadlineMs
          ? "on_time"
          : "late",
      elapsedMs,
      protocolVerified,
      identityVerified,
      artifactAccepted: false,
      assessment: null,
      costSettlement: settled.settlement,
      budgetCapExceeded: settled.capExceeded,
      settlementInvalid: settled.settlementInvalid,
      usage: usageVerified ? { ...outcome.value.usage } : null,
      failureCode: !callIdentityShapeVerified
        ? "call_identity_shape_invalid"
        : !usageVerified
          ? "usage_invalid"
          : "artifact_fingerprint_invalid",
    };
  }
  let assessment: TaskArtifactAssessment | null = null;
  if (
    protocolVerified &&
    identityVerified &&
    outcome.value.artifactState === "complete" &&
    outcome.value.artifact !== undefined
  ) {
    try {
      assessment = options.gradeArtifact(outcome.value.artifact, {
        taskId: options.plan.taskId,
        fixtureId: options.caseContract.fixtureId,
        attempt: options.attempt,
      });
      assertTaskArtifactAssessment(assessment);
    } catch {
      return {
        ...identity,
        ...provenance,
        resultClass: "content_invalid",
        runtimeTiming:
          elapsedMs <= options.plan.envelope.runtimeDeadlineMs
            ? "on_time"
            : "late",
        elapsedMs,
        protocolVerified,
        identityVerified,
        artifactAccepted: false,
        assessment: null,
        costSettlement: settled.settlement,
        budgetCapExceeded: settled.capExceeded,
        settlementInvalid: settled.settlementInvalid,
        usage: { ...outcome.value.usage },
        failureCode: "assessment_failed",
      };
    }
  }
  const classification = classifyCompletedTaskResult({
    plan: options.plan,
    candidate: options.candidate,
    elapsedMs,
    call: outcome.value,
    assessment,
  });
  return {
    ...identity,
    ...provenance,
    ...classification,
    elapsedMs,
    assessment,
    costSettlement: settled.settlement,
    budgetCapExceeded: settled.capExceeded,
    settlementInvalid: settled.settlementInvalid,
    usage: { ...outcome.value.usage },
  };
}

export interface ModelEvaluationCandidateSummary {
  harnessId: typeof SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID;
  candidateBaselineId: typeof SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID;
  taskId: SiteBuilderTaskId;
  profile: SiteBuilderModelProfileId;
  evaluationSuiteId: string;
  taskContractFingerprint: string;
  sourceBundleContractId: string;
  sourceBundleSha256: string | null;
  alias: string;
  expectedRunCount: number;
  actualRunCount: number;
  matrixComplete: boolean;
  acceptedArtifactCount: number;
  qualityRate: number;
  structureRate: number;
  factualityRate: number;
  stabilityRate: number;
  p95LatencyMs: number | null;
  acceptedArtifactCostCents: number | null;
  costSettlementComplete: boolean;
  rankable: boolean;
  hardFailureCount: number;
}

function rate(passed: number, expected: number): number {
  return expected === 0 ? 0 : passed / expected;
}

function p95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

function assertCanonicalEvaluationRun(
  plan: TaskEvaluationPlan,
  candidate: TaskEvaluationCandidate,
  suite: TaskEvaluationSuite,
  run: ModelEvaluationRun,
): void {
  const fixture = suite.fixtureFingerprints.find(
    (entry) => entry.fixtureId === run.fixtureId,
  );
  const taskContractFingerprint = taskEvaluationContractFingerprint(suite);
  const normalizedSettlement = normalizeCostSettlement(run.costSettlement);
  const protocolVerified = run.actualProtocol === candidate.expectedProtocol;
  const identityVerified = exactModelIdentity(candidate.alias, {
    requestedModel: run.requestedModel,
    reportedModel: run.reportedModel ?? undefined,
    resolvedModel: run.resolvedModel ?? undefined,
    modelResolutionSource: run.modelResolutionSource ?? "requested_fallback",
  });
  const capExceeded =
    run.costSettlement.state === "settled" &&
    run.costSettlement.amountCents > plan.envelope.perCallCostCapCents;
  const settlementWasInvalid =
    run.costSettlement.state === "unknown" &&
    run.costSettlement.reason === "invalid_settlement";

  if (
    run.schemaVersion !== MODEL_EVALUATION_RUN_SCHEMA_VERSION ||
    run.harnessId !== SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID ||
    run.candidateBaselineId !== SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID ||
    run.taskId !== plan.taskId ||
    run.profile !== plan.profile ||
    run.alias !== candidate.alias ||
    run.expectedProtocol !== candidate.expectedProtocol ||
    run.evaluationSuiteId !== suite.suiteId ||
    run.adapterId !== suite.adapterId ||
    run.taskContractFingerprint !== taskContractFingerprint ||
    run.fixtureSetId !== suite.fixtureSetId ||
    run.sourceBundleContractId !== suite.sourceBundleContractId ||
    run.evaluatorVersion !== suite.evaluatorVersion ||
    run.evaluatorRubricSha256 !== suite.evaluatorRubricSha256 ||
    !fixture ||
    run.fixtureSha256 !== fixture.fixtureSha256 ||
    run.promptSha256 !== fixture.promptSha256 ||
    !SHA256.test(run.sourceBundleSha256) ||
    !Number.isInteger(run.attempt) ||
    run.attempt < 1 ||
    run.attempt > suite.repeats ||
    !Number.isFinite(run.elapsedMs) ||
    run.elapsedMs < 0 ||
    (run.actualProtocol !== null &&
      !MODEL_CANDIDATE_PROTOCOLS.includes(run.actualProtocol)) ||
    typeof run.requestedModel !== "string" ||
    (run.reportedModel !== null && typeof run.reportedModel !== "string") ||
    (run.resolvedModel !== null && typeof run.resolvedModel !== "string") ||
    (run.modelResolutionSource !== null &&
      run.modelResolutionSource !== "upstream_response" &&
      run.modelResolutionSource !== "requested_fallback") ||
    run.protocolVerified !== protocolVerified ||
    run.identityVerified !== identityVerified ||
    (run.artifactSha256 !== null && !SHA256.test(run.artifactSha256)) ||
    (run.usage !== null && !validEvaluationUsage(run.usage)) ||
    normalizedSettlement.settlementInvalid ||
    JSON.stringify(normalizedSettlement.settlement) !==
      JSON.stringify(run.costSettlement) ||
    run.settlementInvalid !== settlementWasInvalid ||
    run.budgetCapExceeded !== capExceeded ||
    (run.failureCode !== null &&
      (typeof run.failureCode !== "string" || run.failureCode.length === 0))
  ) {
    throw new Error("candidate summary contains a non-canonical run");
  }

  if (run.assessment !== null) {
    assertTaskArtifactAssessment(run.assessment);
  }
  const acceptedAssessment =
    run.assessment !== null &&
    run.assessment.qualityPassed &&
    run.assessment.structurePassed &&
    run.assessment.factualityPassed;
  const timingIsValid =
    (run.runtimeTiming === "on_time" &&
      run.elapsedMs <= plan.envelope.runtimeDeadlineMs) ||
    (run.runtimeTiming === "late" &&
      run.elapsedMs > plan.envelope.runtimeDeadlineMs &&
      run.elapsedMs <= plan.envelope.hardStopMs) ||
    (run.runtimeTiming === "diagnostic_exhausted" &&
      run.elapsedMs >= plan.envelope.hardStopMs) ||
    (run.runtimeTiming === "not_started" && run.elapsedMs === 0);
  if (!timingIsValid) {
    throw new Error("candidate summary contains a non-canonical run");
  }

  const commonAccepted =
    run.protocolVerified &&
    run.identityVerified &&
    run.artifactAccepted &&
    acceptedAssessment &&
    run.artifactSha256 !== null &&
    run.usage !== null &&
    run.failureCode === null;
  const resultIsValid =
    (run.resultClass === "quality_valid_runtime_on_time" &&
      run.runtimeTiming === "on_time" &&
      commonAccepted) ||
    (run.resultClass === "quality_valid_runtime_late" &&
      run.runtimeTiming === "late" &&
      commonAccepted) ||
    (run.resultClass === "content_invalid" &&
      (run.runtimeTiming === "on_time" || run.runtimeTiming === "late") &&
      run.protocolVerified &&
      run.identityVerified &&
      !run.artifactAccepted &&
      !acceptedAssessment &&
      run.usage !== null &&
      run.failureCode !== null) ||
    (run.resultClass === "protocol_or_identity_invalid" &&
      (run.runtimeTiming === "on_time" || run.runtimeTiming === "late") &&
      (!run.protocolVerified || !run.identityVerified) &&
      !run.artifactAccepted &&
      run.assessment === null &&
      run.usage !== null &&
      run.failureCode !== null) ||
    (run.resultClass === "provenance_invalid" &&
      (run.runtimeTiming === "on_time" || run.runtimeTiming === "late") &&
      !run.artifactAccepted &&
      run.assessment === null &&
      run.failureCode !== null) ||
    (run.resultClass === "capability_unavailable" &&
      (run.runtimeTiming === "not_started" ||
        run.runtimeTiming === "on_time" ||
        run.runtimeTiming === "late") &&
      !run.artifactAccepted &&
      run.assessment === null &&
      run.failureCode !== null) ||
    (run.resultClass === "diagnostic_window_exhausted" &&
      run.runtimeTiming === "diagnostic_exhausted" &&
      !run.artifactAccepted &&
      run.assessment === null &&
      run.failureCode !== null) ||
    (run.resultClass === "budget_stop" &&
      run.runtimeTiming === "not_started" &&
      !run.protocolVerified &&
      !run.identityVerified &&
      !run.artifactAccepted &&
      run.assessment === null &&
      run.usage === null &&
      run.costSettlement.state === "not_incurred" &&
      run.costSettlement.reason === "rejected_before_dispatch" &&
      run.failureCode !== null);
  if (!resultIsValid) {
    throw new Error("candidate summary contains a non-canonical run");
  }
}

export function summarizeModelEvaluationCandidate(
  plan: TaskEvaluationPlan,
  alias: string,
  runs: readonly ModelEvaluationRun[],
): ModelEvaluationCandidateSummary {
  const candidate = plan.candidates.find((entry) => entry.alias === alias);
  if (!candidate) {
    throw new Error("candidate summary alias is absent from the task plan");
  }
  assertCandidateBelongsToPlan(plan, candidate);
  if (
    plan.dispatchAdmission !== "task_evaluation_ready" ||
    !plan.evaluationSuite
  ) {
    throw new Error(`task evaluation has no canonical suite: ${plan.taskId}`);
  }
  const expectedRunCount =
    plan.evaluationSuite.fixtureIds.length * plan.evaluationSuite.repeats;
  if (runs.some((run) => run.taskId !== plan.taskId || run.alias !== alias)) {
    throw new Error("candidate summary contains a different task or alias");
  }
  const suite = plan.evaluationSuite;
  const taskContractFingerprint = taskEvaluationContractFingerprint(suite);
  for (const run of runs) {
    assertCanonicalEvaluationRun(plan, candidate, suite, run);
  }
  const sourceBundleHashes = new Set(runs.map((run) => run.sourceBundleSha256));
  if (sourceBundleHashes.size > 1) {
    throw new Error("candidate summary mixes source bundles");
  }
  const matrix = inspectEvaluationMatrix(
    [alias],
    suite.fixtureIds,
    suite.repeats,
    runs.map((run) => ({
      model: run.alias,
      fixtureId: run.fixtureId,
      attempt: run.attempt,
    })),
  );
  const matrixComplete = matrix.complete;
  const acceptedRuns = runs.filter((run) => run.artifactAccepted);
  const qualityPassed = runs.filter(
    (run) => run.assessment?.qualityPassed,
  ).length;
  const structurePassed = runs.filter(
    (run) => run.assessment?.structurePassed,
  ).length;
  const factualityPassed = runs.filter(
    (run) => run.assessment?.factualityPassed,
  ).length;
  const stabilityCountsByFixture = new Map<string, Map<string, number>>();
  for (const run of acceptedRuns) {
    const key = run.assessment?.stabilityKey;
    if (!key) continue;
    const fixtureCounts =
      stabilityCountsByFixture.get(run.fixtureId) ?? new Map<string, number>();
    fixtureCounts.set(key, (fixtureCounts.get(key) ?? 0) + 1);
    stabilityCountsByFixture.set(run.fixtureId, fixtureCounts);
  }
  const stableAttempts = [...stabilityCountsByFixture.values()].reduce(
    (total, fixtureCounts) => total + Math.max(0, ...fixtureCounts.values()),
    0,
  );
  const costSettlementComplete = runs.every(
    (run) => run.costSettlement.state !== "unknown",
  );
  const totalSettledCost = runs.reduce(
    (total, run) =>
      total +
      (run.costSettlement.state === "settled"
        ? run.costSettlement.amountCents
        : 0),
    0,
  );
  const acceptedArtifactCostCents =
    costSettlementComplete && acceptedRuns.length > 0
      ? totalSettledCost / acceptedRuns.length
      : null;
  const hardFailureClasses = new Set<ModelEvaluationResultClass>([
    "protocol_or_identity_invalid",
    "provenance_invalid",
    "capability_unavailable",
    "diagnostic_window_exhausted",
    "budget_stop",
  ]);
  const hardFailureCount = runs.filter(
    (run) =>
      hardFailureClasses.has(run.resultClass) ||
      run.budgetCapExceeded ||
      run.settlementInvalid,
  ).length;
  return {
    harnessId: SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID,
    candidateBaselineId: SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID,
    taskId: plan.taskId,
    profile: plan.profile,
    evaluationSuiteId: suite.suiteId,
    taskContractFingerprint,
    sourceBundleContractId: suite.sourceBundleContractId,
    sourceBundleSha256: runs[0]?.sourceBundleSha256 ?? null,
    alias,
    expectedRunCount,
    actualRunCount: runs.length,
    matrixComplete,
    acceptedArtifactCount: acceptedRuns.length,
    qualityRate: rate(qualityPassed, expectedRunCount),
    structureRate: rate(structurePassed, expectedRunCount),
    factualityRate: rate(factualityPassed, expectedRunCount),
    stabilityRate: rate(stableAttempts, acceptedRuns.length),
    p95LatencyMs: p95(acceptedRuns.map((run) => run.elapsedMs)),
    acceptedArtifactCostCents,
    costSettlementComplete,
    rankable:
      matrixComplete &&
      costSettlementComplete &&
      acceptedRuns.length > 0 &&
      hardFailureCount === 0,
    hardFailureCount,
  };
}

function compareDescending(left: number, right: number): number {
  return right - left;
}

function compareNullableAscending(
  left: number | null,
  right: number | null,
): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

export function rankModelEvaluationCandidates(
  summaries: readonly ModelEvaluationCandidateSummary[],
): readonly ModelEvaluationCandidateSummary[] {
  const first = summaries[0];
  if (
    first &&
    summaries.some(
      (summary) =>
        summary.harnessId !== first.harnessId ||
        summary.candidateBaselineId !== first.candidateBaselineId ||
        summary.taskId !== first.taskId ||
        summary.profile !== first.profile ||
        summary.evaluationSuiteId !== first.evaluationSuiteId ||
        summary.taskContractFingerprint !== first.taskContractFingerprint ||
        summary.sourceBundleContractId !== first.sourceBundleContractId ||
        summary.sourceBundleSha256 !== first.sourceBundleSha256 ||
        summary.expectedRunCount !== first.expectedRunCount,
    )
  ) {
    throw new Error("candidate summaries do not share one evaluation scope");
  }
  return [...summaries].sort((left, right) => {
    if (left.rankable !== right.rankable) return left.rankable ? -1 : 1;
    return (
      compareDescending(left.qualityRate, right.qualityRate) ||
      compareDescending(left.structureRate, right.structureRate) ||
      compareDescending(left.factualityRate, right.factualityRate) ||
      compareDescending(left.stabilityRate, right.stabilityRate) ||
      compareNullableAscending(left.p95LatencyMs, right.p95LatencyMs) ||
      compareNullableAscending(
        left.acceptedArtifactCostCents,
        right.acceptedArtifactCostCents,
      ) ||
      (left.alias < right.alias ? -1 : left.alias > right.alias ? 1 : 0)
    );
  });
}
