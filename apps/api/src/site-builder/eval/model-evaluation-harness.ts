import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

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
  type BrandProfileInput,
  type BrandProfileOutput,
} from "../agents/brand-profile";
import {
  getSiteBuilderTaskRouteBinding,
  SITE_BUILDER_TASK_IDS,
  type SiteBuilderTaskId,
} from "../agents/task-route-bindings";
import {
  assertModelOutputSchemaCompiles,
  checkAgainstSchema,
} from "../../model-gateway/schema-validate";
import {
  BRAND_PROFILE_EVALUATOR_RUBRIC,
  BRAND_PROFILE_EVALUATOR_VERSION,
  BRAND_PROFILE_EVAL_FIXTURE_SCHEMA_VERSION,
  evaluateBrandProfileOutput,
  prepareBrandProfileEvalFixture,
  type BrandProfileEvalFixture,
} from "./brand-profile-eval";
import {
  inspectEvaluationMatrix,
  sha256Bytes,
  sha256CanonicalJson,
  sha256Text,
} from "./eval-provenance";

export const MODEL_EVALUATION_HARNESS_SCHEMA_VERSION =
  "site-builder-model-evaluation-harness/v1" as const;
export const SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID =
  "site-builder-model-evaluation-harness/2026-07-27-v1" as const;
export const MODEL_EVALUATION_RUN_SCHEMA_VERSION =
  "site-builder-model-evaluation-run/v2" as const;
export const CAPABILITY_PROBE_ATTESTATION_SCHEMA_VERSION =
  "site-builder-model-capability-probe-attestation/v1" as const;

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
  preflight: "none" | "capability_probe";
}

export interface TaskEvaluationSuite {
  suiteId: string;
  adapterId: string;
  taskContractId: SiteBuilderTaskId;
  promptVersion: string;
  inputSchemaSha256: string;
  outputSchemaSha256: string;
  repairTaskOutput: boolean;
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
  sourceBundleFiles: readonly {
    role: string;
    path: string;
  }[];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

const BRAND_PROFILE_INPUT_SCHEMA_SNAPSHOT = deepFreeze(
  structuredClone(BRAND_PROFILE_TASK.inputSchema),
);
const BRAND_PROFILE_OUTPUT_SCHEMA_SNAPSHOT = deepFreeze(
  structuredClone(BRAND_PROFILE_TASK.outputSchema),
);
const BRAND_PROFILE_REPAIR_TASK_OUTPUT =
  BRAND_PROFILE_TASK.repairTaskOutput === true;
const BUILD_BRAND_PROFILE_PROMPT = BRAND_PROFILE_TASK.buildPrompt;
const VALIDATE_BRAND_PROFILE_OUTPUT = (() => {
  const validator = BRAND_PROFILE_TASK.validateOutput;
  if (!validator) {
    throw new Error("BrandProfile canonical route validator is required");
  }
  return validator;
})();
assertModelOutputSchemaCompiles(BRAND_PROFILE_OUTPUT_SCHEMA_SNAPSHOT);

const BRAND_PROFILE_EVALUATION_SOURCE_FILES = deepFreeze([
  {
    role: "candidate_baseline",
    path: "apps/api/src/site-builder/agents/model-candidate-baseline.ts",
  },
  {
    role: "candidate_baseline",
    path: "apps/api/src/site-builder/agents/model-candidate-baseline.json",
  },
  { role: "task", path: "apps/api/src/site-builder/agents/brand-profile.ts" },
  {
    role: "judge",
    path: "apps/api/src/site-builder/eval/brand-profile-eval.ts",
  },
  {
    role: "harness",
    path: "apps/api/src/site-builder/eval/model-evaluation-harness.ts",
  },
  {
    role: "provider",
    path: "apps/api/src/model-gateway/providers/openai-compatible.provider.ts",
  },
  {
    role: "transport_registry",
    path: "apps/api/src/model-gateway/model-transports.ts",
  },
  {
    role: "task_runner",
    path: "apps/api/src/site-builder/agents/ai-task.ts",
  },
  {
    role: "gateway_router",
    path: "apps/api/src/model-gateway/router-model-gateway.ts",
  },
  {
    role: "schema_validator",
    path: "apps/api/src/model-gateway/schema-validate.ts",
  },
  {
    role: "evaluation_provenance",
    path: "apps/api/src/site-builder/eval/eval-provenance.ts",
  },
  {
    role: "task_route",
    path: "apps/api/src/site-builder/agents/task-routes.ts",
  },
  {
    role: "task_route_binding",
    path: "apps/api/src/site-builder/agents/task-route-bindings.ts",
  },
  {
    role: "evidence_contract",
    path: "apps/api/src/site-builder/agents/evidence-ref.ts",
  },
  { role: "pii_guard", path: "apps/api/src/site-builder/agents/pii.ts" },
  {
    role: "claim_classifier",
    path: "apps/api/src/site-builder/claim-classification.ts",
  },
  {
    role: "claim_fact_key",
    path: "apps/api/src/site-builder/claim-fact-key.ts",
  },
  {
    role: "profile_registry",
    path: "apps/api/src/site-builder/agents/model-profiles.ts",
  },
  {
    role: "provider_registry",
    path: "apps/api/src/model-gateway/model-provider.registry.ts",
  },
  {
    role: "model_router",
    path: "apps/api/src/model-gateway/model-router.ts",
  },
  {
    role: "provider_error",
    path: "apps/api/src/model-gateway/providers/provider-output-error.ts",
  },
  { role: "gateway_types", path: "apps/api/src/model-gateway/types.ts" },
  {
    role: "gateway_contract",
    path: "apps/api/src/model-gateway/model-gateway.ts",
  },
  {
    role: "provider_contract",
    path: "apps/api/src/model-gateway/model-provider.ts",
  },
  { role: "budget_ledger", path: "apps/api/src/tools/budget.ts" },
  { role: "contracts_runtime", path: "packages/contracts/dist/index.js" },
  {
    role: "contracts_runtime",
    path: "packages/contracts/dist/site-builder/evidence.js",
  },
  {
    role: "contracts_runtime",
    path: "packages/contracts/dist/site-builder/media-foundation.js",
  },
  {
    role: "contracts_runtime",
    path: "packages/contracts/dist/site-builder/model-policy.js",
  },
  {
    role: "contracts_runtime",
    path: "packages/contracts/dist/site-builder/site-spec.js",
  },
  { role: "contracts_manifest", path: "packages/contracts/package.json" },
  { role: "dependency_lock", path: "pnpm-lock.yaml" },
] as const);

const BRAND_PROFILE_EVALUATION_SUITE = deepFreeze({
  suiteId: "site-builder.brand-profile-evaluation-suite/2026-07-27-v1",
  adapterId: "site-builder.brand-profile-evaluation-adapter/v1",
  taskContractId: "site_builder.brand_profile",
  promptVersion: BRAND_PROFILE_PROMPT_VERSION,
  inputSchemaSha256: sha256CanonicalJson(BRAND_PROFILE_INPUT_SCHEMA_SNAPSHOT),
  outputSchemaSha256: sha256CanonicalJson(BRAND_PROFILE_OUTPUT_SCHEMA_SNAPSHOT),
  repairTaskOutput: BRAND_PROFILE_REPAIR_TASK_OUTPUT,
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
  sourceBundleContractId: "brand-profile-evaluation-source-bundle/v3",
  sourceBundleFiles: BRAND_PROFILE_EVALUATION_SOURCE_FILES,
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
      preflight: candidate.preflight,
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
    | "output_invalid"
    | "provenance_invalid"
    | "budget_blocked"
    | "diagnostic_window_exhausted";
  protocolVerified: boolean;
  identityVerified: boolean;
  outputVerified: boolean;
}

export interface CapabilityProbeAttestation {
  schemaVersion: typeof CAPABILITY_PROBE_ATTESTATION_SCHEMA_VERSION;
  campaignId: string;
  harnessId: typeof SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID;
  candidateBaselineId: typeof SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID;
  taskId: SiteBuilderTaskId;
  profile: SiteBuilderModelProfileId;
  alias: string;
  expectedProtocol: ModelCandidateProtocol;
  actualProtocol: ModelCandidateProtocol;
  requestedModel: string;
  reportedModel: string;
  resolvedModel: string;
  modelResolutionSource: "upstream_response";
  taskContractFingerprint: string;
  sourceBundleContractId: string;
  sourceBundleSha256: string;
  probeFixtureId: string;
  probeFixtureSha256: string;
  probePromptSha256: string;
  artifactSha256: string;
  elapsedMs: number;
  costSettlement: Extract<CostSettlement, { state: "settled" }>;
  usage: ModelEvaluationUsage;
  attestationSha256: string;
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

function readMonotonicNow(now: () => number): number | null {
  try {
    const value = now();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function readMonotonicElapsed(
  now: () => number,
  startedAt: number,
): number | null {
  const finishedAt = readMonotonicNow(now);
  if (finishedAt === null) return null;
  const elapsedMs = finishedAt - startedAt;
  return Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : null;
}

const TRUSTED_MODEL_EVALUATION_BUDGETS = new WeakMap<
  object,
  { readonly campaignId: string }
>();
const TRUSTED_MODEL_EVALUATION_RUN_BUDGETS = new WeakMap<
  object,
  ModelEvaluationBudgetGuard
>();

export class ModelEvaluationBudgetGuard {
  readonly #campaignBudgetCents: number;
  readonly #reservations = new Map<string, number>();
  readonly #completedCalls = new Set<string>();
  #committedCents = 0;
  #unknownUpperBoundCents = 0;
  #blockReason: "unknown_settlement" | "per_call_cap_exceeded" | null = null;

  constructor(campaignBudgetCents: number) {
    assertNonNegativeFinite(campaignBudgetCents, "campaignBudgetCents");
    if (campaignBudgetCents === 0) {
      throw new Error("campaignBudgetCents must be greater than zero");
    }
    this.#campaignBudgetCents = campaignBudgetCents;
    TRUSTED_MODEL_EVALUATION_BUDGETS.set(
      this,
      Object.freeze({ campaignId: randomUUID() }),
    );
  }

  get campaignBudgetCents(): number {
    return this.#campaignBudgetCents;
  }

  reserve(
    callId: string,
    perCallCapCents: number,
  ): ModelEvaluationBudgetReserveResult {
    assertNonNegativeFinite(perCallCapCents, "perCallCapCents");
    if (perCallCapCents === 0) {
      throw new Error("perCallCapCents must be greater than zero");
    }
    if (this.#reservations.has(callId) || this.#completedCalls.has(callId)) {
      return { allowed: false, reason: "duplicate_call" };
    }
    if (this.#blockReason) {
      return { allowed: false, reason: this.#blockReason };
    }
    if (perCallCapCents > this.#remainingDispatchableCents()) {
      return { allowed: false, reason: "campaign_budget_exhausted" };
    }
    this.#reservations.set(callId, perCallCapCents);
    return {
      allowed: true,
      reservation: { callId, reservedCents: perCallCapCents },
    };
  }

  settle(
    callId: string,
    settlement: unknown,
  ): ModelEvaluationBudgetSettlementResult {
    const reservedCents = this.#reservations.get(callId);
    if (reservedCents === undefined) {
      throw new Error(
        `model evaluation call has no active reservation: ${callId}`,
      );
    }
    const normalized = normalizeCostSettlement(settlement);
    this.#reservations.delete(callId);
    this.#completedCalls.add(callId);

    if (normalized.settlement.state === "unknown") {
      this.#unknownUpperBoundCents += reservedCents;
      this.#blockReason = "unknown_settlement";
      return normalized;
    }
    if (normalized.settlement.state === "not_incurred") return normalized;

    this.#committedCents += normalized.settlement.amountCents;
    if (
      normalized.settlement.amountCents > reservedCents ||
      this.#committedCents + this.#unknownUpperBoundCents >
        this.#campaignBudgetCents
    ) {
      this.#blockReason = "per_call_cap_exceeded";
    }
    return {
      ...normalized,
      capExceeded: normalized.settlement.amountCents > reservedCents,
    };
  }

  #reservedCents(): number {
    return [...this.#reservations.values()].reduce(
      (total, value) => total + value,
      0,
    );
  }

  #remainingDispatchableCents(): number {
    return Math.max(
      0,
      this.#campaignBudgetCents -
        this.#committedCents -
        this.#reservedCents() -
        this.#unknownUpperBoundCents,
    );
  }

  snapshot(): ModelEvaluationBudgetSnapshot {
    return {
      campaignBudgetCents: this.#campaignBudgetCents,
      committedCents: this.#committedCents,
      reservedCents: this.#reservedCents(),
      unknownUpperBoundCents: this.#unknownUpperBoundCents,
      remainingDispatchableCents: this.#remainingDispatchableCents(),
      blocked: this.#blockReason !== null,
      blockReason: this.#blockReason,
    };
  }
}

const RESERVE_TRUSTED_MODEL_EVALUATION_BUDGET =
  ModelEvaluationBudgetGuard.prototype.reserve;
const SETTLE_TRUSTED_MODEL_EVALUATION_BUDGET =
  ModelEvaluationBudgetGuard.prototype.settle;

function assertTrustedModelEvaluationBudget(
  budget: unknown,
): asserts budget is ModelEvaluationBudgetGuard {
  if (
    !budget ||
    typeof budget !== "object" ||
    !TRUSTED_MODEL_EVALUATION_BUDGETS.has(budget)
  ) {
    throw new Error("trusted model evaluation budget guard is required");
  }
}

function trustedModelEvaluationCampaignId(budget: unknown): string {
  assertTrustedModelEvaluationBudget(budget);
  const campaignId = TRUSTED_MODEL_EVALUATION_BUDGETS.get(budget)?.campaignId;
  if (!campaignId) {
    throw new Error("trusted model evaluation campaign id is unavailable");
  }
  return campaignId;
}

function bindTrustedModelEvaluationRun<T extends ModelEvaluationRun>(
  budget: ModelEvaluationBudgetGuard,
  run: T,
): T {
  assertTrustedModelEvaluationBudget(budget);
  const frozenRun = deepFreeze(run);
  TRUSTED_MODEL_EVALUATION_RUN_BUDGETS.set(frozenRun, budget);
  return frozenRun;
}

function assertTrustedModelEvaluationRunBudget(
  run: ModelEvaluationRun,
  budget: ModelEvaluationBudgetGuard,
): void {
  assertTrustedModelEvaluationBudget(budget);
  if (TRUSTED_MODEL_EVALUATION_RUN_BUDGETS.get(run) !== budget) {
    throw new Error(
      "candidate summary requires runs from one trusted in-memory campaign budget",
    );
  }
}

function reserveTrustedModelEvaluationBudget(
  budget: unknown,
  callId: string,
  perCallCapCents: number,
): ModelEvaluationBudgetReserveResult {
  assertTrustedModelEvaluationBudget(budget);
  return RESERVE_TRUSTED_MODEL_EVALUATION_BUDGET.call(
    budget,
    callId,
    perCallCapCents,
  );
}

function settleTrustedModelEvaluationBudget(
  budget: unknown,
  callId: string,
  settlement: unknown,
): ModelEvaluationBudgetSettlementResult {
  assertTrustedModelEvaluationBudget(budget);
  return SETTLE_TRUSTED_MODEL_EVALUATION_BUDGET.call(
    budget,
    callId,
    settlement,
  );
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
      settlementInvalid: record.reason === "invalid_settlement",
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
      preflight: entry.preflight,
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
    planned.gate !== candidate.gate ||
    planned.preflight !== candidate.preflight
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
  campaignId: string;
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
  capabilityProbeAttestation: CapabilityProbeAttestation | null;
  artifactRetention: "retained_after_route_gate" | "digest_only" | "none";
  artifact: unknown | null;
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
  repairTaskOutput: boolean;
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

export interface ModelEvaluationSourceFileFingerprint {
  role: string;
  path: string;
  sha256: string;
}

export interface ModelEvaluationCasePayload {
  fixture: BrandProfileEvalFixture;
  taskInput: BrandProfileInput;
  prompt: string;
  sourceFiles: readonly ModelEvaluationSourceFileFingerprint[];
}

export interface ModelEvaluationCase {
  contract: ModelEvaluationCaseContract;
  payload: ModelEvaluationCasePayload;
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
  outputSchema: Readonly<Record<string, unknown>>;
  repairTaskOutput: boolean;
  caseContract: ModelEvaluationCaseContract;
  casePayload: ModelEvaluationCasePayload;
  signal: AbortSignal;
}

export interface CapabilityProbeExecutionRequest extends Omit<
  ModelEvaluationExecutionRequest,
  "attempt"
> {
  campaignId: string;
  probeKind: "canonical_task_shaped_capability";
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
const CAMPAIGN_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function capabilityProbeAttestationPayload(
  attestation: Omit<CapabilityProbeAttestation, "attestationSha256">,
): Omit<CapabilityProbeAttestation, "attestationSha256"> {
  return attestation;
}

function capabilityProbeKey(
  plan: TaskEvaluationPlan,
  candidate: TaskEvaluationCandidate,
): string {
  return `${plan.taskId}:${candidate.alias}`;
}

function capabilityProbeAttestationIsCanonical(
  plan: TaskEvaluationPlan,
  candidate: TaskEvaluationCandidate,
  attestation: CapabilityProbeAttestation,
): boolean {
  if (!plan.evaluationSuite || candidate.preflight !== "capability_probe") {
    return false;
  }
  const probeCase = buildCanonicalModelEvaluationCase(
    plan,
    plan.evaluationSuite.fixtureIds[0],
  );
  const normalizedSettlement = normalizeCostSettlement(
    attestation.costSettlement,
  );
  const { attestationSha256, ...payload } = attestation;
  return (
    attestation.schemaVersion === CAPABILITY_PROBE_ATTESTATION_SCHEMA_VERSION &&
    CAMPAIGN_ID.test(attestation.campaignId) &&
    attestation.harnessId === SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID &&
    attestation.candidateBaselineId ===
      SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID &&
    attestation.taskId === plan.taskId &&
    attestation.profile === plan.profile &&
    attestation.alias === candidate.alias &&
    attestation.expectedProtocol === candidate.expectedProtocol &&
    attestation.actualProtocol === candidate.expectedProtocol &&
    exactModelIdentity(candidate.alias, attestation) &&
    attestation.taskContractFingerprint ===
      probeCase.contract.taskContractFingerprint &&
    attestation.sourceBundleContractId ===
      probeCase.contract.sourceBundleContractId &&
    attestation.sourceBundleSha256 === probeCase.contract.sourceBundleSha256 &&
    attestation.probeFixtureId === probeCase.contract.fixtureId &&
    attestation.probeFixtureSha256 === probeCase.contract.fixtureSha256 &&
    attestation.probePromptSha256 === probeCase.contract.promptSha256 &&
    SHA256.test(attestation.artifactSha256) &&
    Number.isFinite(attestation.elapsedMs) &&
    attestation.elapsedMs >= 0 &&
    attestation.elapsedMs <= plan.envelope.hardStopMs &&
    validEvaluationUsage(attestation.usage) &&
    !normalizedSettlement.settlementInvalid &&
    normalizedSettlement.settlement.state === "settled" &&
    normalizedSettlement.settlement.amountCents <=
      plan.envelope.perCallCostCapCents &&
    JSON.stringify(normalizedSettlement.settlement) ===
      JSON.stringify(attestation.costSettlement) &&
    SHA256.test(attestationSha256) &&
    sha256CanonicalJson(capabilityProbeAttestationPayload(payload)) ===
      attestationSha256
  );
}

const TRUSTED_CAPABILITY_CAMPAIGNS = new WeakSet<object>();

export class ModelEvaluationCapabilityCampaign {
  readonly #campaignId: string;
  readonly #budget: ModelEvaluationBudgetGuard;
  readonly #attestations = new Map<string, CapabilityProbeAttestation>();

  constructor(budget: ModelEvaluationBudgetGuard) {
    assertTrustedModelEvaluationBudget(budget);
    this.#budget = budget;
    this.#campaignId = trustedModelEvaluationCampaignId(budget);
    TRUSTED_CAPABILITY_CAMPAIGNS.add(this);
  }

  get campaignId(): string {
    return this.#campaignId;
  }

  async runCanonicalProbe<T>(options: {
    plan: TaskEvaluationPlan;
    candidate: TaskEvaluationCandidate;
    execute: (
      request: CapabilityProbeExecutionRequest,
    ) => Promise<ModelEvaluationCallResult<T>>;
    now?: () => number;
  }): Promise<CapabilityProbeValidation> {
    assertCandidateBelongsToPlan(options.plan, options.candidate);
    if (
      options.candidate.preflight !== "capability_probe" ||
      options.plan.dispatchAdmission !== "task_evaluation_ready" ||
      !options.plan.evaluationSuite
    ) {
      throw new Error(
        `candidate does not require a canonical capability probe: ${options.plan.taskId}/${options.candidate.alias}`,
      );
    }
    const evaluationCase = buildCanonicalModelEvaluationCase(
      options.plan,
      options.plan.evaluationSuite.fixtureIds[0],
    );
    this.#attestations.delete(
      capabilityProbeKey(options.plan, options.candidate),
    );
    const callId = [
      "capability-probe",
      this.campaignId,
      options.plan.taskId,
      options.candidate.alias,
    ].join(":");
    const reservation = reserveTrustedModelEvaluationBudget(
      this.#budget,
      callId,
      options.plan.envelope.perCallCostCapCents,
    );
    if (!reservation.allowed) {
      return {
        status: "budget_blocked",
        protocolVerified: false,
        identityVerified: false,
        outputVerified: false,
      };
    }

    const now = options.now ?? (() => performance.now());
    const startedAt = readMonotonicNow(now);
    if (startedAt === null) {
      settleTrustedModelEvaluationBudget(this.#budget, callId, null);
      return {
        status: "provenance_invalid",
        protocolVerified: false,
        identityVerified: false,
        outputVerified: false,
      };
    }
    const controller = new AbortController();
    const request: CapabilityProbeExecutionRequest = Object.freeze({
      campaignId: this.campaignId,
      probeKind: "canonical_task_shaped_capability",
      taskId: options.plan.taskId,
      profile: options.plan.profile,
      alias: options.candidate.alias,
      expectedProtocol: options.candidate.expectedProtocol,
      fixtureId: evaluationCase.contract.fixtureId,
      maxTokens: options.plan.envelope.maxTokens,
      runtimeDeadlineMs: options.plan.envelope.runtimeDeadlineMs,
      hardStopMs: options.plan.envelope.hardStopMs,
      perCallCostCapCents: options.plan.envelope.perCallCostCapCents,
      reasoningEffort: options.plan.envelope.reasoningEffort,
      outputSchema: BRAND_PROFILE_OUTPUT_SCHEMA_SNAPSHOT,
      repairTaskOutput: options.plan.evaluationSuite.repairTaskOutput,
      caseContract: evaluationCase.contract,
      casePayload: evaluationCase.payload,
      signal: controller.signal,
    });
    type ProbeOutcome =
      | { kind: "completed"; value: ModelEvaluationCallResult<T> }
      | { kind: "failed"; error: unknown }
      | { kind: "hard_stop" };
    let timer: NodeJS.Timeout | undefined;
    const execution = Promise.resolve()
      .then(() => options.execute(request))
      .then<ProbeOutcome, ProbeOutcome>(
        (value) => ({ kind: "completed", value }),
        (error: unknown) => ({ kind: "failed", error }),
      );
    const hardStop = new Promise<ProbeOutcome>((resolve) => {
      timer = setTimeout(
        () => resolve({ kind: "hard_stop" }),
        options.plan.envelope.hardStopMs,
      );
    });
    const outcome = await Promise.race([execution, hardStop]);
    if (timer) clearTimeout(timer);
    if (outcome.kind === "hard_stop") {
      controller.abort(
        new Error("model capability probe diagnostic window exhausted"),
      );
      settleTrustedModelEvaluationBudget(this.#budget, callId, {
        state: "unknown",
        reason: "diagnostic_hard_stop",
      });
      return {
        status: "diagnostic_window_exhausted",
        protocolVerified: false,
        identityVerified: false,
        outputVerified: false,
      };
    }
    if (outcome.kind === "failed") {
      const settlement =
        outcome.error instanceof ModelEvaluationCallError
          ? outcome.error.costSettlement
          : null;
      const settlementCoherent =
        settlement?.state !== "not_incurred" ||
        settlement.reason !== "rejected_before_dispatch";
      settleTrustedModelEvaluationBudget(
        this.#budget,
        callId,
        settlementCoherent ? settlement : null,
      );
      return {
        status: "capability_unavailable",
        protocolVerified: false,
        identityVerified: false,
        outputVerified: false,
      };
    }

    if (!outcome.value || typeof outcome.value !== "object") {
      settleTrustedModelEvaluationBudget(this.#budget, callId, null);
      return {
        status: "provenance_invalid",
        protocolVerified: false,
        identityVerified: false,
        outputVerified: false,
      };
    }

    const settled = settleTrustedModelEvaluationBudget(
      this.#budget,
      callId,
      outcome.value.costSettlement,
    );
    const settlementCoherent =
      settled.settlement.state === "settled" && !settled.settlementInvalid;
    const elapsedMs = readMonotonicElapsed(now, startedAt);
    const observation: CapabilityProbeObservation = {
      actualProtocol: outcome.value.actualProtocol,
      requestedModel: outcome.value.requestedModel,
      reportedModel: outcome.value.reportedModel,
      resolvedModel: outcome.value.resolvedModel,
      modelResolutionSource: outcome.value.modelResolutionSource,
      outputState:
        outcome.value.artifactState === "complete"
          ? "complete"
          : outcome.value.artifactState,
    };
    const validation = validateCapabilityProbe(options.candidate, observation);
    const evidenceValid =
      elapsedMs !== null &&
      elapsedMs <= options.plan.envelope.hardStopMs &&
      sourceBundleMatchesCase(
        options.plan.evaluationSuite,
        evaluationCase.payload,
      ) &&
      validCallIdentityShape(outcome.value) &&
      validEvaluationUsage(outcome.value.usage) &&
      validArtifactFingerprint(outcome.value) &&
      outcome.value.artifactState === "complete" &&
      outcome.value.artifact !== undefined &&
      settlementCoherent &&
      !settled.capExceeded &&
      !settled.settlementInvalid;
    if (!evidenceValid) {
      return {
        status: "provenance_invalid",
        protocolVerified: validation.protocolVerified,
        identityVerified: validation.identityVerified,
        outputVerified: validation.outputVerified,
      };
    }
    if (validation.status !== "capability_proven") return validation;
    try {
      gradeCanonicalTaskArtifact(
        options.plan,
        evaluationCase.payload,
        outcome.value.artifact,
      );
    } catch {
      return {
        status: "output_invalid",
        protocolVerified: true,
        identityVerified: true,
        outputVerified: false,
      };
    }
    const payload = capabilityProbeAttestationPayload({
      schemaVersion: CAPABILITY_PROBE_ATTESTATION_SCHEMA_VERSION,
      campaignId: this.campaignId,
      harnessId: SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID,
      candidateBaselineId: SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID,
      taskId: options.plan.taskId,
      profile: options.plan.profile,
      alias: options.candidate.alias,
      expectedProtocol: options.candidate.expectedProtocol,
      actualProtocol: outcome.value.actualProtocol,
      requestedModel: outcome.value.requestedModel,
      reportedModel: outcome.value.reportedModel!,
      resolvedModel: outcome.value.resolvedModel!,
      modelResolutionSource: "upstream_response",
      taskContractFingerprint: evaluationCase.contract.taskContractFingerprint,
      sourceBundleContractId: evaluationCase.contract.sourceBundleContractId,
      sourceBundleSha256: evaluationCase.contract.sourceBundleSha256,
      probeFixtureId: evaluationCase.contract.fixtureId,
      probeFixtureSha256: evaluationCase.contract.fixtureSha256,
      probePromptSha256: evaluationCase.contract.promptSha256,
      artifactSha256: outcome.value.artifactSha256!,
      elapsedMs: elapsedMs!,
      costSettlement: settled.settlement as Extract<
        CostSettlement,
        { state: "settled" }
      >,
      usage: { ...outcome.value.usage },
    });
    const attestation = deepFreeze({
      ...payload,
      attestationSha256: sha256CanonicalJson(payload),
    });
    if (
      !capabilityProbeAttestationIsCanonical(
        options.plan,
        options.candidate,
        attestation,
      )
    ) {
      throw new Error("canonical capability probe attestation is invalid");
    }
    this.#attestations.set(
      capabilityProbeKey(options.plan, options.candidate),
      attestation,
    );
    return validation;
  }

  attestationFor(
    plan: TaskEvaluationPlan,
    candidate: TaskEvaluationCandidate,
    budget?: ModelEvaluationBudgetGuard,
  ): CapabilityProbeAttestation | null {
    if (budget !== undefined && budget !== this.#budget) return null;
    const attestation =
      this.#attestations.get(capabilityProbeKey(plan, candidate)) ?? null;
    return attestation &&
      attestation.campaignId === this.campaignId &&
      capabilityProbeAttestationIsCanonical(plan, candidate, attestation)
      ? attestation
      : null;
  }
}

const READ_TRUSTED_CAPABILITY_ATTESTATION =
  ModelEvaluationCapabilityCampaign.prototype.attestationFor;

function trustedCapabilityAttestation(
  campaign: unknown,
  plan: TaskEvaluationPlan,
  candidate: TaskEvaluationCandidate,
  budget?: ModelEvaluationBudgetGuard,
): CapabilityProbeAttestation | null {
  if (
    !campaign ||
    typeof campaign !== "object" ||
    !TRUSTED_CAPABILITY_CAMPAIGNS.has(campaign)
  ) {
    return null;
  }
  try {
    return READ_TRUSTED_CAPABILITY_ATTESTATION.call(
      campaign as ModelEvaluationCapabilityCampaign,
      plan,
      candidate,
      budget,
    );
  } catch {
    return null;
  }
}

export function taskEvaluationContractFingerprint(
  suite: TaskEvaluationSuite,
): string {
  return sha256CanonicalJson({
    taskContractId: suite.taskContractId,
    promptVersion: suite.promptVersion,
    inputSchemaSha256: suite.inputSchemaSha256,
    outputSchemaSha256: suite.outputSchemaSha256,
    repairTaskOutput: suite.repairTaskOutput,
    routeValidationVersion: suite.routeValidationVersion,
    evaluatorVersion: suite.evaluatorVersion,
    evaluatorRubricSha256: suite.evaluatorRubricSha256,
    fixtureSetId: suite.fixtureSetId,
    fixtureSchemaVersion: suite.fixtureSchemaVersion,
    fixtureFingerprints: suite.fixtureFingerprints,
    sourceBundleContractId: suite.sourceBundleContractId,
    sourceBundleFiles: suite.sourceBundleFiles,
  });
}

const REPOSITORY_ROOT = resolve(__dirname, "../../../../..");
const REAL_REPOSITORY_ROOT = realpathSync(REPOSITORY_ROOT);

function resolveRepositorySourcePath(path: string): string {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").includes("..")
  ) {
    throw new Error(
      `model evaluation source path is not repository-relative: ${path}`,
    );
  }
  const resolved = resolve(REPOSITORY_ROOT, path);
  const repositoryRelative = relative(REPOSITORY_ROOT, resolved);
  if (
    repositoryRelative.length === 0 ||
    repositoryRelative === ".." ||
    repositoryRelative.startsWith(`..${sep}`) ||
    isAbsolute(repositoryRelative)
  ) {
    throw new Error(
      `model evaluation source path escapes the repository: ${path}`,
    );
  }
  const realPath = realpathSync(resolved);
  const realRepositoryRelative = relative(REAL_REPOSITORY_ROOT, realPath);
  if (
    realRepositoryRelative === ".." ||
    realRepositoryRelative.startsWith(`..${sep}`) ||
    isAbsolute(realRepositoryRelative)
  ) {
    throw new Error(
      `model evaluation source path resolves outside the repository: ${path}`,
    );
  }
  return realPath;
}

function currentSourceBundle(
  suite: TaskEvaluationSuite,
): ModelEvaluationSourceFileFingerprint[] {
  return suite.sourceBundleFiles.map(({ role, path }) => ({
    role,
    path,
    sha256: sha256Bytes(readFileSync(resolveRepositorySourcePath(path))),
  }));
}

function sourceBundleMatchesCase(
  suite: TaskEvaluationSuite,
  payload: ModelEvaluationCasePayload,
): boolean {
  try {
    return (
      JSON.stringify(currentSourceBundle(suite)) ===
      JSON.stringify(payload.sourceFiles)
    );
  } catch {
    return false;
  }
}

export function buildCanonicalModelEvaluationCase(
  plan: TaskEvaluationPlan,
  fixtureId: string,
): ModelEvaluationCase {
  const firstCandidate = plan.candidates[0];
  if (!firstCandidate) {
    throw new Error("task evaluation plan has no candidate");
  }
  assertCandidateBelongsToPlan(plan, firstCandidate);
  const suite = plan.evaluationSuite;
  if (
    plan.dispatchAdmission !== "task_evaluation_ready" ||
    !suite ||
    plan.taskId !== "site_builder.brand_profile"
  ) {
    throw new Error(`task evaluation has no canonical suite: ${plan.taskId}`);
  }
  if (!suite.fixtureIds.includes(fixtureId)) {
    throw new Error(`model evaluation fixture is not canonical: ${fixtureId}`);
  }
  const fixture = JSON.parse(
    readFileSync(
      resolve(
        REPOSITORY_ROOT,
        "apps/api/test/fixtures/golden-companies/brand-profile",
        `${fixtureId}.json`,
      ),
      "utf8",
    ),
  ) as BrandProfileEvalFixture;
  const prepared = prepareBrandProfileEvalFixture(fixture);
  const sourceFiles = currentSourceBundle(suite);
  const payload = deepFreeze({
    fixture,
    taskInput: prepared.input,
    prompt: BUILD_BRAND_PROFILE_PROMPT(prepared.input),
    sourceFiles,
  });
  const contract: ModelEvaluationCaseContract = {
    suiteId: suite.suiteId,
    adapterId: suite.adapterId,
    taskContractId: suite.taskContractId,
    taskContractFingerprint: taskEvaluationContractFingerprint(suite),
    promptVersion: suite.promptVersion,
    inputSchemaSha256: suite.inputSchemaSha256,
    outputSchemaSha256: suite.outputSchemaSha256,
    repairTaskOutput: suite.repairTaskOutput,
    routeValidationVersion: suite.routeValidationVersion,
    evaluatorVersion: suite.evaluatorVersion,
    evaluatorRubricSha256: suite.evaluatorRubricSha256,
    fixtureSetId: suite.fixtureSetId,
    sourceBundleContractId: suite.sourceBundleContractId,
    fixtureSchemaVersion: suite.fixtureSchemaVersion,
    fixtureId,
    fixtureSha256: sha256CanonicalJson(payload.fixture),
    promptSha256: sha256Text(payload.prompt),
    sourceBundleSha256: sha256CanonicalJson(payload.sourceFiles),
  };
  const evaluationCase = deepFreeze({ contract, payload });
  assertCaseContract(plan, evaluationCase);
  return evaluationCase;
}

function assertCaseContract(
  plan: TaskEvaluationPlan,
  evaluationCase: ModelEvaluationCase,
): void {
  const suite = plan.evaluationSuite;
  if (!suite) {
    throw new Error(`task evaluation has no canonical suite: ${plan.taskId}`);
  }
  const { contract, payload } = evaluationCase;
  const fixedContract = {
    suiteId: contract.suiteId,
    adapterId: contract.adapterId,
    taskContractId: contract.taskContractId,
    taskContractFingerprint: contract.taskContractFingerprint,
    promptVersion: contract.promptVersion,
    inputSchemaSha256: contract.inputSchemaSha256,
    outputSchemaSha256: contract.outputSchemaSha256,
    repairTaskOutput: contract.repairTaskOutput,
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
    repairTaskOutput: suite.repairTaskOutput,
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
  const prepared = prepareBrandProfileEvalFixture(payload.fixture);
  const currentSources = currentSourceBundle(suite);
  if (
    !fixture ||
    contract.fixtureSha256 !== fixture.fixtureSha256 ||
    contract.promptSha256 !== fixture.promptSha256 ||
    contract.fixtureSha256 !== sha256CanonicalJson(payload.fixture) ||
    contract.promptSha256 !== sha256Text(payload.prompt) ||
    contract.sourceBundleSha256 !== sha256CanonicalJson(payload.sourceFiles) ||
    sha256CanonicalJson(payload.fixture) !==
      sha256CanonicalJson(prepared.fixture) ||
    sha256CanonicalJson(payload.taskInput) !==
      sha256CanonicalJson(prepared.input) ||
    payload.prompt !== BUILD_BRAND_PROFILE_PROMPT(payload.taskInput) ||
    JSON.stringify(payload.sourceFiles) !== JSON.stringify(currentSources) ||
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
  campaignId: string,
  capabilityProbeAttestation: CapabilityProbeAttestation | null,
): Pick<
  ModelEvaluationRun,
  | "schemaVersion"
  | "harnessId"
  | "candidateBaselineId"
  | "campaignId"
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
  | "capabilityProbeAttestation"
  | "artifactRetention"
  | "artifact"
  | "artifactSha256"
  | "attempt"
> {
  return {
    schemaVersion: MODEL_EVALUATION_RUN_SCHEMA_VERSION,
    harnessId: SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID,
    candidateBaselineId: SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID,
    campaignId,
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
    capabilityProbeAttestation,
    artifactRetention: "none",
    artifact: null,
    artifactSha256: null,
    attempt,
  };
}

function callProvenance<T>(
  value: ModelEvaluationCallResult<T>,
  retainArtifact: boolean,
): Pick<
  ModelEvaluationRun,
  | "actualProtocol"
  | "requestedModel"
  | "reportedModel"
  | "resolvedModel"
  | "modelResolutionSource"
  | "artifactRetention"
  | "artifact"
  | "artifactSha256"
> {
  let artifact: unknown | null = null;
  if (
    retainArtifact &&
    value.artifactState === "complete" &&
    value.artifact !== undefined &&
    validArtifactFingerprint(value)
  ) {
    try {
      artifact = deepFreeze(structuredClone(value.artifact));
    } catch {
      artifact = null;
    }
  }
  const artifactSha256 =
    value.artifactState === "complete" &&
    value.artifact !== undefined &&
    validArtifactFingerprint(value) &&
    typeof value.artifactSha256 === "string"
      ? value.artifactSha256
      : null;
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
    artifactRetention:
      artifact !== null
        ? "retained_after_route_gate"
        : artifactSha256 !== null
          ? "digest_only"
          : "none",
    artifact,
    artifactSha256,
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

function gradeCanonicalTaskArtifact(
  plan: TaskEvaluationPlan,
  payload: ModelEvaluationCasePayload,
  artifact: unknown,
): TaskArtifactAssessment {
  if (
    plan.taskId !== "site_builder.brand_profile" ||
    plan.evaluationSuite?.evaluatorVersion !==
      BRAND_PROFILE_EVALUATOR_VERSION ||
    plan.evaluationSuite.outputSchemaSha256 !==
      sha256CanonicalJson(BRAND_PROFILE_OUTPUT_SCHEMA_SNAPSHOT)
  ) {
    throw new Error(`task evaluator is not canonical: ${plan.taskId}`);
  }
  assertModelOutputSchemaCompiles(BRAND_PROFILE_OUTPUT_SCHEMA_SNAPSHOT);
  const outputCheck = checkAgainstSchema(
    BRAND_PROFILE_OUTPUT_SCHEMA_SNAPSHOT,
    artifact,
  );
  if (!outputCheck.valid) {
    throw new Error(
      "task artifact does not satisfy the canonical output schema",
    );
  }
  const output = artifact as BrandProfileOutput;
  VALIDATE_BRAND_PROFILE_OUTPUT(payload.taskInput, output);
  const prepared = prepareBrandProfileEvalFixture(payload.fixture);
  const outcome = evaluateBrandProfileOutput(prepared, output);
  const qualityPassed =
    outcome.acceptedFactCount >=
      prepared.fixture.assertions.minimumAcceptedFacts &&
    outcome.forbiddenOutputTerms.length === 0;
  const factualityPassed =
    outcome.rejectedFactCount === 0 &&
    outcome.missingAcceptedTerms.length === 0;
  const findingCodes = [
    ...(outcome.acceptedFactCount <
    prepared.fixture.assertions.minimumAcceptedFacts
      ? ["accepted_fact_minimum"]
      : []),
    ...(outcome.rejectedFactCount > 0 ? ["rejected_fact"] : []),
    ...(outcome.missingAcceptedTerms.length > 0
      ? ["required_fact_missing"]
      : []),
    ...(outcome.forbiddenOutputTerms.length > 0
      ? ["forbidden_output_term"]
      : []),
  ];
  return {
    qualityPassed,
    structurePassed: true,
    factualityPassed,
    stabilityKey: sha256CanonicalJson(artifact),
    findingCodes,
  };
}

export async function runTaskEvaluationAttempt<T>(options: {
  plan: TaskEvaluationPlan;
  candidate: TaskEvaluationCandidate;
  fixtureId: string;
  attempt: number;
  campaignBudget: ModelEvaluationBudgetGuard;
  capabilityCampaign?: ModelEvaluationCapabilityCampaign;
  execute: (
    request: ModelEvaluationExecutionRequest,
  ) => Promise<ModelEvaluationCallResult<T>>;
  now?: () => number;
}): Promise<ModelEvaluationRun> {
  assertCandidateBelongsToPlan(options.plan, options.candidate);
  assertTrustedModelEvaluationBudget(options.campaignBudget);
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
  const evaluationCase = buildCanonicalModelEvaluationCase(
    options.plan,
    options.fixtureId,
  );
  const capabilityProbeAttestation =
    options.candidate.preflight === "capability_probe"
      ? trustedCapabilityAttestation(
          options.capabilityCampaign,
          options.plan,
          options.candidate,
          options.campaignBudget,
        )
      : null;
  if (
    options.candidate.preflight === "capability_probe" &&
    capabilityProbeAttestation === null
  ) {
    throw new Error(
      `canonical campaign capability probe is required before matrix dispatch: ${options.candidate.alias}`,
    );
  }
  const now = options.now ?? (() => performance.now());
  const startedAt = readMonotonicNow(now);
  if (startedAt === null) {
    throw new Error("model evaluation monotonic clock is invalid");
  }
  const identity = runIdentity(
    options.plan,
    options.candidate,
    evaluationCase.contract,
    options.attempt,
    trustedModelEvaluationCampaignId(options.campaignBudget),
    capabilityProbeAttestation,
  );
  const bindRun = (run: ModelEvaluationRun): ModelEvaluationRun =>
    bindTrustedModelEvaluationRun(options.campaignBudget, run);
  const callId = [
    options.plan.taskId,
    options.candidate.alias,
    evaluationCase.contract.fixtureId,
    options.attempt,
  ].join(":");
  const reservation = reserveTrustedModelEvaluationBudget(
    options.campaignBudget,
    callId,
    options.plan.envelope.perCallCostCapCents,
  );
  if (!reservation.allowed) {
    return bindRun({
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
    });
  }

  const controller = new AbortController();
  const request: ModelEvaluationExecutionRequest = {
    taskId: options.plan.taskId,
    profile: options.plan.profile,
    alias: options.candidate.alias,
    expectedProtocol: options.candidate.expectedProtocol,
    fixtureId: evaluationCase.contract.fixtureId,
    attempt: options.attempt,
    maxTokens: options.plan.envelope.maxTokens,
    runtimeDeadlineMs: options.plan.envelope.runtimeDeadlineMs,
    hardStopMs: options.plan.envelope.hardStopMs,
    perCallCostCapCents: options.plan.envelope.perCallCostCapCents,
    reasoningEffort: options.plan.envelope.reasoningEffort,
    outputSchema: BRAND_PROFILE_OUTPUT_SCHEMA_SNAPSHOT,
    repairTaskOutput: options.plan.evaluationSuite.repairTaskOutput,
    caseContract: evaluationCase.contract,
    casePayload: evaluationCase.payload,
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
    const settled = settleTrustedModelEvaluationBudget(
      options.campaignBudget,
      callId,
      {
        state: "unknown",
        reason: "diagnostic_hard_stop",
      },
    );
    const elapsedMs = readMonotonicElapsed(now, startedAt);
    const elapsedIsValid =
      elapsedMs !== null && elapsedMs >= options.plan.envelope.hardStopMs;
    return bindRun({
      ...identity,
      resultClass: elapsedIsValid
        ? "diagnostic_window_exhausted"
        : "capability_unavailable",
      runtimeTiming: elapsedIsValid ? "diagnostic_exhausted" : "not_started",
      elapsedMs: elapsedIsValid ? elapsedMs! : 0,
      protocolVerified: false,
      identityVerified: false,
      artifactAccepted: false,
      assessment: null,
      costSettlement: settled.settlement,
      budgetCapExceeded: settled.capExceeded,
      settlementInvalid: settled.settlementInvalid,
      usage: null,
      failureCode: elapsedIsValid
        ? "diagnostic_window_exhausted"
        : "monotonic_clock_invalid",
    });
  }

  const observedElapsedMs = readMonotonicElapsed(now, startedAt);
  const elapsedIsValid = observedElapsedMs !== null;
  const elapsedMs = observedElapsedMs ?? 0;
  if (outcome.kind === "failed") {
    const failure =
      outcome.error instanceof ModelEvaluationCallError
        ? outcome.error
        : new ModelEvaluationCallError("unknown_provider_error", {
            state: "unknown",
            reason: "provider_ack_unknown",
          });
    const failureSettlementCoherent =
      failure.costSettlement.state !== "not_incurred" ||
      failure.costSettlement.reason !== "rejected_before_dispatch";
    const settled = settleTrustedModelEvaluationBudget(
      options.campaignBudget,
      callId,
      failureSettlementCoherent ? failure.costSettlement : null,
    );
    if (!elapsedIsValid) {
      return bindRun({
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
        failureCode: !failureSettlementCoherent
          ? "post_dispatch_settlement_incoherent"
          : "monotonic_clock_invalid",
      });
    }
    if (elapsedMs > options.plan.envelope.hardStopMs) {
      return bindRun({
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
        failureCode: !failureSettlementCoherent
          ? "post_dispatch_settlement_incoherent"
          : "completed_after_hard_stop",
      });
    }
    return bindRun({
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
      failureCode: failureSettlementCoherent
        ? failure.failureCode
        : "post_dispatch_settlement_incoherent",
    });
  }

  if (!outcome.value || typeof outcome.value !== "object") {
    const settled = settleTrustedModelEvaluationBudget(
      options.campaignBudget,
      callId,
      null,
    );
    return bindRun({
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
    });
  }

  const completedSettlementCoherent =
    outcome.value.costSettlement?.state !== "not_incurred";
  const settled = settleTrustedModelEvaluationBudget(
    options.campaignBudget,
    callId,
    completedSettlementCoherent ? outcome.value.costSettlement : null,
  );
  const redactedProvenance = callProvenance(outcome.value, false);
  const callIdentityShapeVerified = validCallIdentityShape(outcome.value);
  const usageVerified = validEvaluationUsage(outcome.value.usage);
  const artifactFingerprintVerified = validArtifactFingerprint(outcome.value);
  const sourceBundleStable = sourceBundleMatchesCase(
    options.plan.evaluationSuite,
    evaluationCase.payload,
  );
  if (!elapsedIsValid) {
    return bindRun({
      ...identity,
      ...redactedProvenance,
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
    });
  }
  const protocolVerified =
    outcome.value.actualProtocol === options.candidate.expectedProtocol;
  const identityVerified = exactModelIdentity(
    options.candidate.alias,
    outcome.value,
  );
  if (elapsedMs > options.plan.envelope.hardStopMs) {
    return bindRun({
      ...identity,
      ...redactedProvenance,
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
    });
  }
  if (
    !completedSettlementCoherent ||
    !sourceBundleStable ||
    !callIdentityShapeVerified ||
    !usageVerified ||
    !artifactFingerprintVerified
  ) {
    return bindRun({
      ...identity,
      ...redactedProvenance,
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
      failureCode: !completedSettlementCoherent
        ? "completed_settlement_incoherent"
        : !sourceBundleStable
          ? "source_bundle_changed_during_dispatch"
          : !callIdentityShapeVerified
            ? "call_identity_shape_invalid"
            : !usageVerified
              ? "usage_invalid"
              : "artifact_fingerprint_invalid",
    });
  }
  let assessment: TaskArtifactAssessment | null = null;
  if (
    protocolVerified &&
    identityVerified &&
    outcome.value.artifactState === "complete" &&
    outcome.value.artifact !== undefined
  ) {
    try {
      assessment = gradeCanonicalTaskArtifact(
        options.plan,
        evaluationCase.payload,
        outcome.value.artifact,
      );
      assertTaskArtifactAssessment(assessment);
    } catch {
      return bindRun({
        ...identity,
        ...redactedProvenance,
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
      });
    }
  }
  const retainedProvenance =
    assessment !== null
      ? callProvenance(outcome.value, true)
      : redactedProvenance;
  if (
    assessment !== null &&
    retainedProvenance.artifactRetention !== "retained_after_route_gate"
  ) {
    return bindRun({
      ...identity,
      ...redactedProvenance,
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
      usage: { ...outcome.value.usage },
      failureCode: "artifact_evidence_unavailable",
    });
  }
  const classification = classifyCompletedTaskResult({
    plan: options.plan,
    candidate: options.candidate,
    elapsedMs,
    call: outcome.value,
    assessment,
  });
  return bindRun({
    ...identity,
    ...retainedProvenance,
    ...classification,
    elapsedMs,
    assessment,
    costSettlement: settled.settlement,
    budgetCapExceeded: settled.capExceeded,
    settlementInvalid: settled.settlementInvalid,
    usage: { ...outcome.value.usage },
  });
}

export interface ModelEvaluationCandidateSummary {
  harnessId: typeof SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID;
  candidateBaselineId: typeof SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID;
  campaignId: string;
  taskId: SiteBuilderTaskId;
  profile: SiteBuilderModelProfileId;
  evaluationSuiteId: string;
  taskContractFingerprint: string;
  sourceBundleContractId: string;
  sourceBundleSha256: string | null;
  capabilityProbeAttestation: CapabilityProbeAttestation | null;
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
  runtimeDeadlinePassed: boolean;
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
  evaluationCase: ModelEvaluationCase,
  campaignBudget: ModelEvaluationBudgetGuard,
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
  const settlementWasInvalid = normalizedSettlement.settlementInvalid;
  const settlementResultCoherent =
    run.costSettlement.state !== "not_incurred" ||
    (run.costSettlement.reason === "rejected_before_dispatch"
      ? run.resultClass === "budget_stop"
      : run.resultClass === "capability_unavailable" ||
        run.resultClass === "diagnostic_window_exhausted");
  const campaignId = trustedModelEvaluationCampaignId(campaignBudget);

  if (
    run.schemaVersion !== MODEL_EVALUATION_RUN_SCHEMA_VERSION ||
    run.harnessId !== SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID ||
    run.candidateBaselineId !== SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID ||
    run.campaignId !== campaignId ||
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
    (candidate.preflight === "capability_probe"
      ? run.capabilityProbeAttestation === null ||
        !capabilityProbeAttestationIsCanonical(
          plan,
          candidate,
          run.capabilityProbeAttestation,
        )
      : run.capabilityProbeAttestation !== null) ||
    !fixture ||
    run.fixtureSha256 !== fixture.fixtureSha256 ||
    run.promptSha256 !== fixture.promptSha256 ||
    run.sourceBundleSha256 !== evaluationCase.contract.sourceBundleSha256 ||
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
    !(
      (run.artifactRetention === "retained_after_route_gate" &&
        run.artifact !== null &&
        run.artifactSha256 !== null &&
        SHA256.test(run.artifactSha256) &&
        sha256CanonicalJson(run.artifact) === run.artifactSha256) ||
      (run.artifactRetention === "digest_only" &&
        run.artifact === null &&
        run.artifactSha256 !== null &&
        SHA256.test(run.artifactSha256)) ||
      (run.artifactRetention === "none" &&
        run.artifact === null &&
        run.artifactSha256 === null)
    ) ||
    (run.usage !== null && !validEvaluationUsage(run.usage)) ||
    JSON.stringify(normalizedSettlement.settlement) !==
      JSON.stringify(run.costSettlement) ||
    !settlementResultCoherent ||
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
  let canonicalAssessment: TaskArtifactAssessment | null = null;
  if (
    run.artifact !== null &&
    run.artifactRetention === "retained_after_route_gate" &&
    run.protocolVerified &&
    run.identityVerified
  ) {
    try {
      canonicalAssessment = gradeCanonicalTaskArtifact(
        plan,
        evaluationCase.payload,
        run.artifact,
      );
    } catch {
      canonicalAssessment = null;
    }
  }
  if (JSON.stringify(run.assessment) !== JSON.stringify(canonicalAssessment)) {
    throw new Error("candidate summary contains a non-canonical run");
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
    run.artifactRetention === "retained_after_route_gate" &&
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
  campaignBudget: ModelEvaluationBudgetGuard,
  capabilityCampaign?: ModelEvaluationCapabilityCampaign,
): ModelEvaluationCandidateSummary {
  assertTrustedModelEvaluationBudget(campaignBudget);
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
  const trustedProbeAttestation =
    candidate.preflight === "capability_probe"
      ? trustedCapabilityAttestation(
          capabilityCampaign,
          plan,
          candidate,
          campaignBudget,
        )
      : null;
  if (
    candidate.preflight === "capability_probe" &&
    trustedProbeAttestation === null
  ) {
    throw new Error(
      "candidate summary requires the trusted in-memory capability campaign",
    );
  }
  const taskContractFingerprint = taskEvaluationContractFingerprint(suite);
  const canonicalCases = new Map(
    suite.fixtureIds.map((fixtureId) => [
      fixtureId,
      buildCanonicalModelEvaluationCase(plan, fixtureId),
    ]),
  );
  for (const run of runs) {
    assertTrustedModelEvaluationRunBudget(run, campaignBudget);
    const evaluationCase = canonicalCases.get(run.fixtureId);
    if (!evaluationCase) {
      throw new Error("candidate summary contains a non-canonical run");
    }
    assertCanonicalEvaluationRun(
      plan,
      candidate,
      suite,
      run,
      evaluationCase,
      campaignBudget,
    );
    if (
      candidate.preflight === "capability_probe" &&
      JSON.stringify(run.capabilityProbeAttestation) !==
        JSON.stringify(trustedProbeAttestation)
    ) {
      throw new Error(
        "candidate summary contains an untrusted capability probe attestation",
      );
    }
  }
  const sourceBundleHashes = new Set(runs.map((run) => run.sourceBundleSha256));
  if (sourceBundleHashes.size > 1) {
    throw new Error("candidate summary mixes source bundles");
  }
  const capabilityProbeAttestations = new Set(
    runs.map((run) =>
      run.capabilityProbeAttestation === null
        ? null
        : run.capabilityProbeAttestation.attestationSha256,
    ),
  );
  if (
    candidate.preflight === "capability_probe" &&
    (capabilityProbeAttestations.size !== 1 ||
      capabilityProbeAttestations.has(null))
  ) {
    throw new Error("candidate summary mixes capability probe attestations");
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
  const totalSettledCost =
    (trustedProbeAttestation?.costSettlement.amountCents ?? 0) +
    runs.reduce(
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
  const p95LatencyMs = p95(acceptedRuns.map((run) => run.elapsedMs));
  const runtimeDeadlinePassed =
    p95LatencyMs !== null && p95LatencyMs <= plan.envelope.runtimeDeadlineMs;
  return {
    harnessId: SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID,
    candidateBaselineId: SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID,
    campaignId: trustedModelEvaluationCampaignId(campaignBudget),
    taskId: plan.taskId,
    profile: plan.profile,
    evaluationSuiteId: suite.suiteId,
    taskContractFingerprint,
    sourceBundleContractId: suite.sourceBundleContractId,
    sourceBundleSha256: runs[0]?.sourceBundleSha256 ?? null,
    capabilityProbeAttestation: trustedProbeAttestation,
    alias,
    expectedRunCount,
    actualRunCount: runs.length,
    matrixComplete,
    acceptedArtifactCount: acceptedRuns.length,
    qualityRate: rate(qualityPassed, expectedRunCount),
    structureRate: rate(structurePassed, expectedRunCount),
    factualityRate: rate(factualityPassed, expectedRunCount),
    stabilityRate: rate(stableAttempts, acceptedRuns.length),
    p95LatencyMs,
    runtimeDeadlinePassed,
    acceptedArtifactCostCents,
    costSettlementComplete,
    rankable:
      matrixComplete &&
      costSettlementComplete &&
      acceptedRuns.length > 0 &&
      runtimeDeadlinePassed &&
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
  plan: TaskEvaluationPlan,
  candidateRuns: readonly {
    alias: string;
    runs: readonly ModelEvaluationRun[];
  }[],
  campaignBudget: ModelEvaluationBudgetGuard,
  capabilityCampaign?: ModelEvaluationCapabilityCampaign,
): readonly ModelEvaluationCandidateSummary[] {
  assertTrustedModelEvaluationBudget(campaignBudget);
  const expectedAliases = plan.candidates.map((candidate) => candidate.alias);
  const receivedAliases = candidateRuns.map((candidate) => candidate.alias);
  if (
    receivedAliases.length !== expectedAliases.length ||
    new Set(receivedAliases).size !== receivedAliases.length ||
    expectedAliases.some((alias) => !receivedAliases.includes(alias))
  ) {
    throw new Error(
      "candidate ranking matrix must cover every planned candidate exactly once",
    );
  }
  const summaries = candidateRuns.map(({ alias, runs }) =>
    summarizeModelEvaluationCandidate(
      plan,
      alias,
      runs,
      campaignBudget,
      capabilityCampaign,
    ),
  );
  const first = summaries[0];
  if (
    first &&
    summaries.some(
      (summary) =>
        summary.harnessId !== first.harnessId ||
        summary.candidateBaselineId !== first.candidateBaselineId ||
        summary.campaignId !== first.campaignId ||
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
