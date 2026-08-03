import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  assertModelEvaluationRuntimeIntegrity,
  modelEvaluationRuntimeIntegrityMatches,
} from "./model-evaluation-runtime-integrity";
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
  DESIGN_SPEC_EVALUATOR_RUBRIC,
  DESIGN_SPEC_EVALUATOR_VERSION,
  DESIGN_SPEC_EVAL_FIXTURES,
  DESIGN_SPEC_EVAL_FIXTURE_SCHEMA_VERSION,
  DESIGN_SPEC_PROMPT_VERSION,
  DESIGN_SPEC_ROUTE_VALIDATION_VERSION,
  designSpecFixtureFingerprint,
  evaluateDesignSpecOutput,
  prepareDesignSpecEvalFixture,
  type DesignSpecEvalFixture,
} from "./design-spec-eval";
import {
  DESIGN_SPEC_TASK,
  type DesignSpecTaskInput,
  type DesignSpecTaskOutput,
} from "../design/design-brief-producer";
import {
  COPY_TASK,
  type CopyTaskInput,
  type CopyTaskOutput,
} from "../agents/copy";
import {
  ASSEMBLE_TASK,
  ASSEMBLY_FIX_TASK,
  type ControlledAssemblyTaskInput,
} from "../agents/controlled-assembly";
import {
  COPY_ASSEMBLY_EVALUATOR_RUBRIC,
  COPY_ASSEMBLY_EVALUATOR_VERSION,
  COPY_ASSEMBLY_EVAL_FIXTURES,
  COPY_ASSEMBLY_EVAL_FIXTURE_SCHEMA_VERSION,
  COPY_ASSEMBLY_PROMPT_VERSION,
  COPY_ASSEMBLY_ROUTE_VALIDATION_VERSION,
  evaluateCopyAssemblyOutput,
  prepareCopyAssemblyEvalFixture,
  type CopyAssemblyEvalFixture,
} from "./copy-assembly-eval";
import {
  CONTROLLED_ASSEMBLY_EVALUATOR_RUBRIC,
  CONTROLLED_ASSEMBLY_EVALUATOR_VERSION,
  CONTROLLED_ASSEMBLY_EVAL_FIXTURES,
  CONTROLLED_ASSEMBLY_EVAL_FIXTURE_SCHEMA_VERSION,
  CONTROLLED_ASSEMBLY_PROMPT_VERSION,
  CONTROLLED_ASSEMBLY_ROUTE_VALIDATION_VERSION,
  evaluateControlledAssemblyOutput,
  prepareControlledAssemblyEvalFixture,
  type ControlledAssemblyEvalFixture,
} from "./controlled-assembly-eval";
import {
  QA_SUMMARIZE_TASK,
  SEO_REVIEW_TASK,
  type QualityNarrativeTaskInputV1,
  type QualityNarrativeTaskOutputV1,
} from "../quality/quality-narrative";
import {
  QUALITY_NARRATIVE_EVALUATOR_RUBRIC,
  QUALITY_NARRATIVE_EVALUATOR_VERSION,
  QUALITY_NARRATIVE_EVAL_FIXTURES,
  QUALITY_NARRATIVE_EVAL_FIXTURE_SCHEMA_VERSION,
  QUALITY_NARRATIVE_PROMPT_VERSION,
  QUALITY_NARRATIVE_ROUTE_VALIDATION_VERSION,
  evaluateQualityNarrativeOutput,
  prepareQualityNarrativeEvalFixture,
  type QualityNarrativeEvalFixture,
} from "./quality-narrative-eval";
import {
  inspectEvaluationMatrix,
  sha256Bytes,
  sha256CanonicalJson,
  sha256Text,
} from "./eval-provenance";
import {
  freezeModelEvaluationProtocolExecutor,
  isTrustedModelEvaluationProtocolExecute,
  modelEvaluationProtocolExecutorCostSafety,
  modelEvaluationProtocolExecutorIdentity,
} from "./model-evaluation-executor";
import {
  SITE_BUILDER_MODEL_EVALUATION_COST_SAFETY_ID,
  type ModelEvaluationCostSafetyAttestation,
} from "./model-evaluation-cost-safety";
import {
  compiledContractsRuntimeBindingMatches,
  type CompiledContractsRuntimeBinding,
} from "./compiled-contracts-attestation";
import { DESIGN_SPEC_COMPILED_CONTRACTS_RUNTIME_BINDING } from "./design-spec-compiled-contracts-runtime";

export const MODEL_EVALUATION_HARNESS_SCHEMA_VERSION =
  "site-builder-model-evaluation-harness/v1" as const;
export const SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID =
  "site-builder-model-evaluation-harness/2026-08-01-v18" as const;
export const MODEL_EVALUATION_RUN_SCHEMA_VERSION =
  "site-builder-model-evaluation-run/v4" as const;
export const CAPABILITY_PROBE_ATTESTATION_SCHEMA_VERSION =
  "site-builder-model-capability-probe-attestation/v3" as const;

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
  systemPromptSha256: string;
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
  legacyComparatorAliases: readonly string[];
  compiledContractsRuntimeBinding: CompiledContractsRuntimeBinding | null;
  sourceBundleContractId: string;
  sourceBundleFiles: readonly {
    role: string;
    path: string;
  }[];
}

const TRUSTED_OBJECT_FREEZE = Object.freeze;
const TRUSTED_OBJECT_IS_FROZEN = Object.isFrozen;
const TRUSTED_OBJECT_VALUES = Object.values;
const TRUSTED_BRAND_WEAK_MAP_GET = WeakMap.prototype.get;
const TRUSTED_BRAND_WEAK_MAP_SET = WeakMap.prototype.set;
const TRUSTED_BRAND_WEAK_MAP_HAS = WeakMap.prototype.has;
const TRUSTED_BRAND_WEAK_SET_ADD = WeakSet.prototype.add;
const TRUSTED_BRAND_WEAK_SET_HAS = WeakSet.prototype.has;
const APPLY_TRUSTED_BRAND_INTRINSIC = Reflect.apply;

function trustedObjectIsFrozen(value: object): boolean {
  return APPLY_TRUSTED_BRAND_INTRINSIC(TRUSTED_OBJECT_IS_FROZEN, Object, [
    value,
  ]) as boolean;
}

function trustedObjectFreeze(value: object): void {
  APPLY_TRUSTED_BRAND_INTRINSIC(TRUSTED_OBJECT_FREEZE, Object, [value]);
}

function trustedObjectValues(value: object): unknown[] {
  return APPLY_TRUSTED_BRAND_INTRINSIC(TRUSTED_OBJECT_VALUES, Object, [
    value,
  ]) as unknown[];
}

function trustedWeakSetAdd(set: WeakSet<object>, value: object): void {
  APPLY_TRUSTED_BRAND_INTRINSIC(TRUSTED_BRAND_WEAK_SET_ADD, set, [value]);
}

function trustedWeakSetHas(set: WeakSet<object>, value: object): boolean {
  return APPLY_TRUSTED_BRAND_INTRINSIC(TRUSTED_BRAND_WEAK_SET_HAS, set, [
    value,
  ]) as boolean;
}

function deepFreezeValue(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== "object" || trustedWeakSetHas(seen, value)) {
    return;
  }
  trustedWeakSetAdd(seen, value);
  if (!trustedObjectIsFrozen(value)) {
    trustedObjectFreeze(value);
  }
  if (!trustedObjectIsFrozen(value)) {
    throw new Error("trusted evaluation value could not be frozen");
  }
  for (const child of trustedObjectValues(value)) {
    deepFreezeValue(child, seen);
  }
}

function deepFreeze<T>(value: T): T {
  deepFreezeValue(value, new WeakSet<object>());
  return value;
}

function assertDeepFrozen(value: unknown): void {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown): void => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      trustedWeakSetHas(seen, candidate)
    ) {
      return;
    }
    trustedWeakSetAdd(seen, candidate);
    if (!trustedObjectIsFrozen(candidate)) {
      throw new Error("trusted evaluation value is not deeply frozen");
    }
    for (const child of trustedObjectValues(candidate)) {
      visit(child);
    }
  };
  visit(value);
}

const BRAND_PROFILE_INPUT_SCHEMA_SNAPSHOT = deepFreeze(
  structuredClone(BRAND_PROFILE_TASK.inputSchema),
);
const BRAND_PROFILE_OUTPUT_SCHEMA_SNAPSHOT = deepFreeze(
  structuredClone(BRAND_PROFILE_TASK.outputSchema),
);
const BRAND_PROFILE_REPAIR_TASK_OUTPUT =
  BRAND_PROFILE_TASK.repairTaskOutput === true;
const BRAND_PROFILE_SYSTEM_PROMPT_SHA256 = sha256Text(
  BRAND_PROFILE_TASK.system ?? "",
);
const BUILD_BRAND_PROFILE_PROMPT = BRAND_PROFILE_TASK.buildPrompt;
const VALIDATE_BRAND_PROFILE_OUTPUT = (() => {
  const validator = BRAND_PROFILE_TASK.validateOutput;
  if (!validator) {
    throw new Error("BrandProfile canonical route validator is required");
  }
  return validator;
})();
assertModelOutputSchemaCompiles(BRAND_PROFILE_OUTPUT_SCHEMA_SNAPSHOT);

const DESIGN_SPEC_INPUT_SCHEMA_SNAPSHOT = deepFreeze(
  structuredClone(DESIGN_SPEC_TASK.inputSchema),
);
const DESIGN_SPEC_OUTPUT_SCHEMA_SNAPSHOT = deepFreeze(
  structuredClone(DESIGN_SPEC_TASK.outputSchema),
);
const DESIGN_SPEC_REPAIR_TASK_OUTPUT =
  DESIGN_SPEC_TASK.repairTaskOutput === true;
const DESIGN_SPEC_SYSTEM_PROMPT_SHA256 = sha256Text(
  DESIGN_SPEC_TASK.system ?? "",
);
const BUILD_DESIGN_SPEC_PROMPT = DESIGN_SPEC_TASK.buildPrompt;
const VALIDATE_DESIGN_SPEC_OUTPUT = (() => {
  const validator = DESIGN_SPEC_TASK.validateOutput;
  if (!validator) {
    throw new Error("DesignSpec canonical route validator is required");
  }
  return validator;
})();
assertModelOutputSchemaCompiles(DESIGN_SPEC_OUTPUT_SCHEMA_SNAPSHOT);

const COPY_INPUT_SCHEMA_SNAPSHOT = deepFreeze(
  structuredClone(COPY_TASK.inputSchema),
);
const COPY_OUTPUT_SCHEMA_SNAPSHOT = deepFreeze(
  structuredClone(COPY_TASK.outputSchema),
);
const COPY_REPAIR_TASK_OUTPUT = COPY_TASK.repairTaskOutput === true;
const COPY_SYSTEM_PROMPT_SHA256 = sha256Text(COPY_TASK.system ?? "");
const BUILD_COPY_PROMPT = COPY_TASK.buildPrompt;
const VALIDATE_COPY_OUTPUT = (() => {
  const validator = COPY_TASK.validateOutput;
  if (!validator) {
    throw new Error("Copy canonical route validator is required");
  }
  return validator;
})();
assertModelOutputSchemaCompiles(COPY_OUTPUT_SCHEMA_SNAPSHOT);

const ASSEMBLE_INPUT_SCHEMA_SNAPSHOT = deepFreeze(
  structuredClone(ASSEMBLE_TASK.inputSchema),
);
const ASSEMBLE_OUTPUT_SCHEMA_SNAPSHOT = deepFreeze(
  structuredClone(ASSEMBLE_TASK.outputSchema),
);
const ASSEMBLE_REPAIR_TASK_OUTPUT = ASSEMBLE_TASK.repairTaskOutput === true;
const ASSEMBLE_SYSTEM_PROMPT_SHA256 = sha256Text(ASSEMBLE_TASK.system ?? "");
const BUILD_ASSEMBLE_PROMPT = ASSEMBLE_TASK.buildPrompt;
const VALIDATE_ASSEMBLE_OUTPUT = (() => {
  const validator = ASSEMBLE_TASK.validateOutput;
  if (!validator) throw new Error("Assemble canonical route validator is required");
  return validator;
})();
assertModelOutputSchemaCompiles(ASSEMBLE_OUTPUT_SCHEMA_SNAPSHOT);

const ASSEMBLY_FIX_INPUT_SCHEMA_SNAPSHOT = deepFreeze(
  structuredClone(ASSEMBLY_FIX_TASK.inputSchema),
);
const ASSEMBLY_FIX_OUTPUT_SCHEMA_SNAPSHOT = deepFreeze(
  structuredClone(ASSEMBLY_FIX_TASK.outputSchema),
);
const ASSEMBLY_FIX_REPAIR_TASK_OUTPUT =
  ASSEMBLY_FIX_TASK.repairTaskOutput === true;
const ASSEMBLY_FIX_SYSTEM_PROMPT_SHA256 = sha256Text(
  ASSEMBLY_FIX_TASK.system ?? "",
);
const BUILD_ASSEMBLY_FIX_PROMPT = ASSEMBLY_FIX_TASK.buildPrompt;
const VALIDATE_ASSEMBLY_FIX_OUTPUT = (() => {
  const validator = ASSEMBLY_FIX_TASK.validateOutput;
  if (!validator) {
    throw new Error("AssemblyFix canonical route validator is required");
  }
  return validator;
})();
assertModelOutputSchemaCompiles(ASSEMBLY_FIX_OUTPUT_SCHEMA_SNAPSHOT);

const QA_SUMMARIZE_INPUT_SCHEMA_SNAPSHOT = deepFreeze(
  structuredClone(QA_SUMMARIZE_TASK.inputSchema),
);
const QA_SUMMARIZE_OUTPUT_SCHEMA_SNAPSHOT = deepFreeze(
  structuredClone(QA_SUMMARIZE_TASK.outputSchema),
);
const QA_SUMMARIZE_REPAIR_TASK_OUTPUT =
  QA_SUMMARIZE_TASK.repairTaskOutput === true;
const QA_SUMMARIZE_SYSTEM_PROMPT_SHA256 = sha256Text(
  QA_SUMMARIZE_TASK.system ?? "",
);
const BUILD_QA_SUMMARIZE_PROMPT = QA_SUMMARIZE_TASK.buildPrompt;
const VALIDATE_QA_SUMMARIZE_OUTPUT = (() => {
  const validator = QA_SUMMARIZE_TASK.validateOutput;
  if (!validator) {
    throw new Error("QA summarize canonical route validator is required");
  }
  return validator;
})();
assertModelOutputSchemaCompiles(QA_SUMMARIZE_OUTPUT_SCHEMA_SNAPSHOT);

const SEO_REVIEW_INPUT_SCHEMA_SNAPSHOT = deepFreeze(
  structuredClone(SEO_REVIEW_TASK.inputSchema),
);
const SEO_REVIEW_OUTPUT_SCHEMA_SNAPSHOT = deepFreeze(
  structuredClone(SEO_REVIEW_TASK.outputSchema),
);
const SEO_REVIEW_REPAIR_TASK_OUTPUT = SEO_REVIEW_TASK.repairTaskOutput === true;
const SEO_REVIEW_SYSTEM_PROMPT_SHA256 = sha256Text(
  SEO_REVIEW_TASK.system ?? "",
);
const BUILD_SEO_REVIEW_PROMPT = SEO_REVIEW_TASK.buildPrompt;
const VALIDATE_SEO_REVIEW_OUTPUT = (() => {
  const validator = SEO_REVIEW_TASK.validateOutput;
  if (!validator) {
    throw new Error("SEO review canonical route validator is required");
  }
  return validator;
})();
assertModelOutputSchemaCompiles(SEO_REVIEW_OUTPUT_SCHEMA_SNAPSHOT);

function currentTaskSystemPromptSha256(taskId: SiteBuilderTaskId): string {
  if (taskId === "site_builder.brand_profile") {
    return sha256Text(BRAND_PROFILE_TASK.system ?? "");
  }
  if (taskId === "site_builder.design_spec") {
    return sha256Text(DESIGN_SPEC_TASK.system ?? "");
  }
  if (taskId === "site_builder.copy") {
    return sha256Text(COPY_TASK.system ?? "");
  }
  if (taskId === "site_builder.assemble") {
    return sha256Text(ASSEMBLE_TASK.system ?? "");
  }
  if (taskId === "site_builder.assembly_fix") {
    return sha256Text(ASSEMBLY_FIX_TASK.system ?? "");
  }
  if (taskId === "site_builder.qa_summarize") {
    return sha256Text(QA_SUMMARIZE_TASK.system ?? "");
  }
  if (taskId === "site_builder.seo_review") {
    return sha256Text(SEO_REVIEW_TASK.system ?? "");
  }
  throw new Error(`task system prompt is not canonical: ${taskId}`);
}

function currentTaskValidatorMatchesCapturedIdentity(
  taskId: SiteBuilderTaskId,
): boolean {
  if (taskId === "site_builder.brand_profile") {
    return true;
  }
  if (taskId === "site_builder.design_spec") {
    return DESIGN_SPEC_TASK.validateOutput === VALIDATE_DESIGN_SPEC_OUTPUT;
  }
  if (taskId === "site_builder.copy") {
    return COPY_TASK.validateOutput === VALIDATE_COPY_OUTPUT;
  }
  if (taskId === "site_builder.assemble") {
    return ASSEMBLE_TASK.validateOutput === VALIDATE_ASSEMBLE_OUTPUT;
  }
  if (taskId === "site_builder.assembly_fix") {
    return ASSEMBLY_FIX_TASK.validateOutput === VALIDATE_ASSEMBLY_FIX_OUTPUT;
  }
  if (taskId === "site_builder.qa_summarize") {
    return QA_SUMMARIZE_TASK.validateOutput === VALIDATE_QA_SUMMARIZE_OUTPUT;
  }
  if (taskId === "site_builder.seo_review") {
    return SEO_REVIEW_TASK.validateOutput === VALIDATE_SEO_REVIEW_OUTPUT;
  }
  return false;
}

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
    role: "evaluation_executor",
    path: "apps/api/src/site-builder/eval/model-evaluation-executor.ts",
  },
  {
    role: "evaluation_cost_safety",
    path: "apps/api/src/site-builder/eval/model-evaluation-cost-safety.ts",
  },
  {
    role: "evidence_preparation",
    path: "apps/api/src/site-builder/eval/model-evaluation-evidence-prep.ts",
  },
  {
    role: "evidence_preparation_runner",
    path: "apps/api/scripts/prepare-site-builder-model-evaluation-evidence.mts",
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
  {
    role: "contracts_source",
    path: "packages/contracts/src/site-builder/evidence.ts",
  },
  {
    role: "contracts_source",
    path: "packages/contracts/src/site-builder/media-foundation.ts",
  },
  {
    role: "contracts_source",
    path: "packages/contracts/src/site-builder/model-policy.ts",
  },
  {
    role: "contracts_source",
    path: "packages/contracts/src/site-builder/site-spec.ts",
  },
  { role: "contracts_source", path: "packages/contracts/src/index.ts" },
  { role: "contracts_build", path: "packages/contracts/tsconfig.json" },
  { role: "contracts_manifest", path: "packages/contracts/package.json" },
  { role: "dependency_lock", path: "pnpm-lock.yaml" },
] as const);

const BRAND_PROFILE_EVALUATION_SUITE = deepFreeze({
  suiteId: "site-builder.brand-profile-evaluation-suite/2026-07-27-v1",
  adapterId: "site-builder.brand-profile-evaluation-adapter/v2",
  taskContractId: "site_builder.brand_profile",
  promptVersion: BRAND_PROFILE_PROMPT_VERSION,
  systemPromptSha256: BRAND_PROFILE_SYSTEM_PROMPT_SHA256,
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
  legacyComparatorAliases: Object.freeze(["deepseek-v4-pro", "glm-5.2"]),
  compiledContractsRuntimeBinding: null,
  sourceBundleContractId: "brand-profile-evaluation-source-bundle/v7",
  sourceBundleFiles: BRAND_PROFILE_EVALUATION_SOURCE_FILES,
}) satisfies TaskEvaluationSuite;

const DESIGN_SPEC_EVALUATION_SOURCE_FILES = deepFreeze([
  {
    role: "candidate_baseline",
    path: "apps/api/src/site-builder/agents/model-candidate-baseline.ts",
  },
  {
    role: "candidate_baseline",
    path: "apps/api/src/site-builder/agents/model-candidate-baseline.json",
  },
  {
    role: "task",
    path: "apps/api/src/site-builder/design/design-brief-producer.ts",
  },
  {
    role: "catalog",
    path: "apps/api/src/site-builder/design/catalog.ts",
  },
  {
    role: "catalog_data",
    path: "apps/api/src/site-builder/design/catalog-v2-approved.ts",
  },
  {
    role: "catalog_data",
    path: "apps/api/src/site-builder/design/catalog-v2-b3-drafts.ts",
  },
  {
    role: "catalog_data",
    path: "apps/api/src/site-builder/design/catalog-v2-b2-drafts.ts",
  },
  {
    role: "catalog_data",
    path: "apps/api/src/site-builder/design/catalog-v2-b1-drafts.ts",
  },
  {
    role: "catalog_data",
    path: "apps/api/src/site-builder/design/renderer-preset-digests.ts",
  },
  {
    role: "judge",
    path: "apps/api/src/site-builder/eval/design-spec-eval.ts",
  },
  {
    role: "harness",
    path: "apps/api/src/site-builder/eval/model-evaluation-harness.ts",
  },
  {
    role: "evaluation_executor",
    path: "apps/api/src/site-builder/eval/model-evaluation-executor.ts",
  },
  {
    role: "evaluation_cost_safety",
    path: "apps/api/src/site-builder/eval/model-evaluation-cost-safety.ts",
  },
  {
    role: "compiled_contracts_attestation",
    path: "apps/api/src/site-builder/eval/compiled-contracts-attestation.ts",
  },
  {
    role: "compiled_contracts_runtime_binding",
    path: "apps/api/src/site-builder/eval/design-spec-compiled-contracts-runtime.ts",
  },
  {
    role: "loaded_contracts_runtime_binding",
    path: "apps/api/src/site-builder/eval/design-spec-loaded-contracts-runtime.ts",
  },
  {
    role: "runtime_integrity",
    path: "apps/api/src/site-builder/eval/model-evaluation-runtime-integrity.ts",
  },
  {
    role: "api_manifest",
    path: "apps/api/package.json",
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
  {
    role: "contracts_source",
    path: "packages/contracts/src/site-builder/model-policy.ts",
  },
  {
    role: "contracts_source",
    path: "packages/contracts/src/site-builder/design-catalog-v2.ts",
  },
  {
    role: "contracts_source",
    path: "packages/contracts/src/site-builder/component-qualification.ts",
  },
  {
    role: "contracts_source",
    path: "packages/contracts/src/site-builder/design-integrity.ts",
  },
  {
    role: "contracts_source",
    path: "packages/contracts/src/site-builder/design-dna.ts",
  },
  {
    role: "contracts_source",
    path: "packages/contracts/src/site-builder/design-observation.ts",
  },
  {
    role: "contracts_source",
    path: "packages/contracts/src/site-builder/design-source.ts",
  },
  {
    role: "contracts_source",
    path: "packages/contracts/src/site-builder/site-spec.ts",
  },
  {
    role: "contracts_source",
    path: "packages/contracts/src/site-builder/copy-bundle.ts",
  },
  { role: "contracts_source", path: "packages/contracts/src/index.ts" },
  { role: "contracts_build", path: "packages/contracts/tsconfig.json" },
  { role: "contracts_manifest", path: "packages/contracts/package.json" },
  { role: "dependency_lock", path: "pnpm-lock.yaml" },
] as const);

const DESIGN_SPEC_EXPECTED_FIXTURE_FINGERPRINTS = deepFreeze([
  {
    fixtureId: "natural-origin-rich",
    fixtureSha256:
      "83ac126bf9e019442a028b894c70c13010a68b0c86bf7ee484b987e175692e9b",
    promptSha256:
      "b5f95c6c412beddd28e3ffb30dd9226cb0805967831f07af37c75af901dc1a66",
  },
  {
    fixtureId: "natural-origin-sparse",
    fixtureSha256:
      "15b4141169e4862cc6fc8a96fd5338e44fa9dc9e6e1cd53c4b83dd58b4ed1be8",
    promptSha256:
      "8d658afd3e9f473f2edec47de8dfd3bd6aec885966331b4457697562c3d847c1",
  },
  {
    fixtureId: "oem-capability-rich",
    fixtureSha256:
      "cdfb18b5cadc568d794ff87366a001ac0fa10d1380e7ee35af1c7ca28634e581",
    promptSha256:
      "3e8780dbb9429801c8c0c77d72e00a92880d75365bd5ba61e82df554e2177a0b",
  },
  {
    fixtureId: "oem-capability-sparse",
    fixtureSha256:
      "e8365172be3afe76ac9fd9615f11eb6092807c883a78958d991e003cf22410d9",
    promptSha256:
      "f46e796309c1e8bdda632bd1c01a4999abd820c55ce495ea13efee36f2ab5aaa",
  },
  {
    fixtureId: "precision-industrial-rich",
    fixtureSha256:
      "8c2a7cfa6207b863c15832cd1ff5abeefce420aa6c5b305db2eae8f5df284ff6",
    promptSha256:
      "bb694026658db537945520847e3588f1aceb10c163c4d488532b0213b2b668ec",
  },
  {
    fixtureId: "precision-industrial-sparse",
    fixtureSha256:
      "cc1c0e069f613d1d82ec53d4783ed26250ca06eddfb1b76cd3294022ccc5fcf6",
    promptSha256:
      "3f740cba234be448bedf15b60833401e43d173708d0ed5d141839d2d7478bfd2",
  },
  {
    fixtureId: "premium-innovation-rich",
    fixtureSha256:
      "3f2ec1f8f7519dcbc572e075f84d836cda73874d7ad53df063f92d4c42e251c4",
    promptSha256:
      "12c7c55fa40d83954e5e602c282c5e86d038adf943b3ec4a99d9fb72b2220417",
  },
  {
    fixtureId: "premium-innovation-sparse",
    fixtureSha256:
      "2946840a353835c9e1c8aa043f22d02eeef1739b75ba03afff6aa4e29fd1eb46",
    promptSha256:
      "0659e2871f7673585aa083bce06e98dcb57e96d69ed50ef24a0b1df42a40bfea",
  },
  {
    fixtureId: "scientific-trust-rich",
    fixtureSha256:
      "de6bcb2cc3c53390e7f153d23ec6770d429bb2aeb1772e4d3112be419b1a3a89",
    promptSha256:
      "7e5b9dde096487a523ac81cae4609ca36a555a0b4a693b65e422937dd09d3ede",
  },
  {
    fixtureId: "scientific-trust-sparse",
    fixtureSha256:
      "9f97ed2b08d054da37e15aee4b4ac0ec95aa79827382200e3d329fd1640106c4",
    promptSha256:
      "7b901063360f9686f595f3f15c2af3571fe64a4f80c8d639baf28696606b6a7f",
  },
  {
    fixtureId: "technical-catalog-rich",
    fixtureSha256:
      "8428714ffc6886f7ddff3448ae6c2ce19dffd5a68aba7e8825e23a9b18fd7404",
    promptSha256:
      "2a8f33b841a6239199d10b0e881cee9375451f792a1468fa71597e5cd594daa7",
  },
  {
    fixtureId: "technical-catalog-sparse",
    fixtureSha256:
      "31a62190afcee593f172892c20ac0370a43e4d27d4bcf51de95f58606afd4969",
    promptSha256:
      "09e634738d1d0cc6b12d2dbddbcd33501fb475717324607622603e08d8bb9983",
  },
] as const);

const DESIGN_SPEC_ACTUAL_FIXTURE_FINGERPRINTS = DESIGN_SPEC_EVAL_FIXTURES.map(
  (fixture) => ({
    fixtureId: fixture.fixtureId,
    ...designSpecFixtureFingerprint(fixture),
  }),
);

if (
  JSON.stringify(DESIGN_SPEC_ACTUAL_FIXTURE_FINGERPRINTS) !==
  JSON.stringify(DESIGN_SPEC_EXPECTED_FIXTURE_FINGERPRINTS)
) {
  throw new Error("design_spec frozen fixture fingerprints drifted");
}

const DESIGN_SPEC_EVALUATION_SUITE = deepFreeze({
  // v15 deliberately supersedes the historical v14 source contract.  The
  // prior create-only manifest and fee card remain audit artifacts, but cannot
  // be used to bind a new native-currency execution authorization.
  suiteId: "site-builder.design-spec-evaluation-suite/2026-08-03-v15",
  adapterId: "site-builder.design-spec-evaluation-adapter/v13",
  taskContractId: "site_builder.design_spec",
  promptVersion: DESIGN_SPEC_PROMPT_VERSION,
  systemPromptSha256: DESIGN_SPEC_SYSTEM_PROMPT_SHA256,
  inputSchemaSha256: sha256CanonicalJson(DESIGN_SPEC_INPUT_SCHEMA_SNAPSHOT),
  outputSchemaSha256: sha256CanonicalJson(DESIGN_SPEC_OUTPUT_SCHEMA_SNAPSHOT),
  repairTaskOutput: DESIGN_SPEC_REPAIR_TASK_OUTPUT,
  routeValidationVersion: DESIGN_SPEC_ROUTE_VALIDATION_VERSION,
  evaluatorVersion: DESIGN_SPEC_EVALUATOR_VERSION,
  evaluatorRubricSha256: sha256CanonicalJson(DESIGN_SPEC_EVALUATOR_RUBRIC),
  fixtureSetId: "site-builder.design-spec-golden/2026-07-30-v3",
  fixtureSchemaVersion: DESIGN_SPEC_EVAL_FIXTURE_SCHEMA_VERSION,
  fixtureIds: Object.freeze(
    DESIGN_SPEC_EVAL_FIXTURES.map(({ fixtureId }) => fixtureId),
  ),
  fixtureFingerprints: DESIGN_SPEC_EXPECTED_FIXTURE_FINGERPRINTS,
  repeats: 2,
  legacyComparatorAliases: Object.freeze([]),
  compiledContractsRuntimeBinding:
    DESIGN_SPEC_COMPILED_CONTRACTS_RUNTIME_BINDING,
  sourceBundleContractId: "design-spec-evaluation-source-bundle/v15",
  sourceBundleFiles: DESIGN_SPEC_EVALUATION_SOURCE_FILES,
}) satisfies TaskEvaluationSuite;

const COPY_EVALUATION_SOURCE_FILES = deepFreeze([
  {
    role: "candidate_baseline",
    path: "apps/api/src/site-builder/agents/model-candidate-baseline.ts",
  },
  {
    role: "candidate_baseline",
    path: "apps/api/src/site-builder/agents/model-candidate-baseline.json",
  },
  { role: "task", path: "apps/api/src/site-builder/agents/copy.ts" },
  {
    role: "copy_consumer",
    path: "apps/api/src/site-builder/copy-bundle.service.ts",
  },
  {
    role: "claim_snapshot",
    path: "apps/api/src/site-builder/publishable-claim-snapshot.ts",
  },
  {
    role: "judge",
    path: "apps/api/src/site-builder/eval/copy-assembly-eval.ts",
  },
  {
    role: "harness",
    path: "apps/api/src/site-builder/eval/model-evaluation-harness.ts",
  },
  {
    role: "evaluation_executor",
    path: "apps/api/src/site-builder/eval/model-evaluation-executor.ts",
  },
  {
    role: "evaluation_cost_safety",
    path: "apps/api/src/site-builder/eval/model-evaluation-cost-safety.ts",
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
    role: "profile_registry",
    path: "apps/api/src/site-builder/agents/model-profiles.ts",
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
    role: "schema_validator",
    path: "apps/api/src/model-gateway/schema-validate.ts",
  },
  {
    role: "gateway_router",
    path: "apps/api/src/model-gateway/router-model-gateway.ts",
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
  {
    role: "contracts_source",
    path: "packages/contracts/src/site-builder/copy-bundle.ts",
  },
  {
    role: "contracts_source",
    path: "packages/contracts/src/site-builder/model-policy.ts",
  },
  { role: "contracts_source", path: "packages/contracts/src/index.ts" },
  { role: "contracts_build", path: "packages/contracts/tsconfig.json" },
  { role: "contracts_manifest", path: "packages/contracts/package.json" },
  { role: "dependency_lock", path: "pnpm-lock.yaml" },
] as const);

const COPY_ACTUAL_FIXTURE_FINGERPRINTS = deepFreeze(
  COPY_ASSEMBLY_EVAL_FIXTURES.map((fixture) => {
    const prepared = prepareCopyAssemblyEvalFixture(fixture);
    return {
      fixtureId: fixture.fixtureId,
      fixtureSha256: sha256CanonicalJson(fixture),
      promptSha256: sha256Text(BUILD_COPY_PROMPT(prepared.input)),
    };
  }),
);

const COPY_EXPECTED_FIXTURE_FINGERPRINTS = deepFreeze([
  {
    fixtureId: "copy-factual-claims",
    fixtureSha256:
      "aad1ee2713691126ef29ea3900b970dde47f8cc0597e0ecccf3fb9f81516f665",
    promptSha256:
      "b389bf24f468f64bd2cfdc8a4dab01818686b4cde2e8d0679bdbdfba0343439f",
  },
  {
    fixtureId: "copy-neutral-budget",
    fixtureSha256:
      "69540f7687c0d99c3832c47db11e1e7c9ef131ad43687e9947a58d684bfc54f8",
    promptSha256:
      "ba62471db01e7d6cd0242e538cf463a2fabf82e68b908673fc1128d79c494cc9",
  },
] as const);

if (
  JSON.stringify(COPY_ACTUAL_FIXTURE_FINGERPRINTS) !==
  JSON.stringify(COPY_EXPECTED_FIXTURE_FINGERPRINTS)
) {
  throw new Error("copy frozen fixture fingerprints drifted");
}

const COPY_EVALUATION_SUITE = deepFreeze({
  suiteId: "site-builder.copy-evaluation-suite/2026-08-04-v1",
  adapterId: "site-builder-copy-evaluation-adapter/v1",
  taskContractId: "site_builder.copy",
  promptVersion: COPY_ASSEMBLY_PROMPT_VERSION,
  systemPromptSha256: COPY_SYSTEM_PROMPT_SHA256,
  inputSchemaSha256: sha256CanonicalJson(COPY_INPUT_SCHEMA_SNAPSHOT),
  outputSchemaSha256: sha256CanonicalJson(COPY_OUTPUT_SCHEMA_SNAPSHOT),
  repairTaskOutput: COPY_REPAIR_TASK_OUTPUT,
  routeValidationVersion: COPY_ASSEMBLY_ROUTE_VALIDATION_VERSION,
  evaluatorVersion: COPY_ASSEMBLY_EVALUATOR_VERSION,
  evaluatorRubricSha256: sha256CanonicalJson(COPY_ASSEMBLY_EVALUATOR_RUBRIC),
  fixtureSetId: "site-builder-copy-golden/2026-08-04-v1",
  fixtureSchemaVersion: COPY_ASSEMBLY_EVAL_FIXTURE_SCHEMA_VERSION,
  fixtureIds: Object.freeze(
    COPY_ASSEMBLY_EVAL_FIXTURES.map((fixture) => fixture.fixtureId),
  ),
  fixtureFingerprints: COPY_EXPECTED_FIXTURE_FINGERPRINTS,
  repeats: 2,
  legacyComparatorAliases: Object.freeze([]),
  compiledContractsRuntimeBinding: null,
  sourceBundleContractId: "copy-evaluation-source-bundle/v1",
  sourceBundleFiles: COPY_EVALUATION_SOURCE_FILES,
}) satisfies TaskEvaluationSuite;

const CONTROLLED_ASSEMBLY_EVALUATION_SOURCE_FILES = deepFreeze([
  { role: "candidate_baseline", path: "apps/api/src/site-builder/agents/model-candidate-baseline.ts" },
  { role: "candidate_baseline", path: "apps/api/src/site-builder/agents/model-candidate-baseline.json" },
  { role: "task", path: "apps/api/src/site-builder/agents/controlled-assembly.ts" },
  { role: "assembly_consumer", path: "apps/api/src/site-builder/assembly/controlled-assembly.service.ts" },
  { role: "assembly_validator", path: "apps/api/src/site-builder/assembly/controlled-assembly-validator.ts" },
  { role: "assembly_adapters", path: "apps/api/src/site-builder/assembly/component-assembly-adapters.ts" },
  { role: "copy_slot_derivation", path: "apps/api/src/site-builder/assembly/copy-slot-derivation.ts" },
  { role: "copy_bundle", path: "apps/api/src/site-builder/copy-bundle.service.ts" },
  { role: "controlled_assets", path: "apps/api/src/site-builder/controlled-asset-materializer.ts" },
  { role: "qualified_templates", path: "apps/api/src/site-builder/assembly/qualified-component-templates.ts" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/about-block-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/area-gallery-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/area-marquee-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/article-grid-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/axiom-hero-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/cert-wall-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/chapter-showcase-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/collection-cards-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/colorway-picker-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/coverage-map-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/crew-grid-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/cta-banner-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/cta-center-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/dishes-showcase-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/dispatch-hero-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/dispatch-timeline-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/editorial-hero-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/faq-accordion-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/faq-split-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/farmhouse-hero-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/feature-cards-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/featured-spotlight-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/hero-banner-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/hero-full-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/industrial-hero-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/inquiry-form-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/ledger-stats-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/logo-marquee-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/map-location-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/materials-library-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/media-cta-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/minimal-hero-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/photo-gallery-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/pricing-table-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/pricing-tiers-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/process-steps-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/process-timeline-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/product-grid-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/product-showcase-alt-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/projects-grid-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/saa-shero-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/service-rows-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/services-dark-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/services-editorial-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/services-grid-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/split-about-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/statement-block-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/stats-band-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/stats-countup-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/story-chapters-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/tech-systems-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/testimonials-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/trust-split-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/value-strip-spec.json" },
  { role: "qualified_component_fixture", path: "apps/site-renderer/fixtures/component-qualification/warm-hero-spec.json" },
  { role: "golden_fixture_source", path: "apps/api/src/site-builder/design/m1eb-golden.ts" },
  { role: "design_brief_producer", path: "apps/api/src/site-builder/design/design-brief-producer.ts" },
  { role: "catalog", path: "apps/api/src/site-builder/design/catalog.ts" },
  { role: "judge", path: "apps/api/src/site-builder/eval/controlled-assembly-eval.ts" },
  { role: "harness", path: "apps/api/src/site-builder/eval/model-evaluation-harness.ts" },
  { role: "evaluation_executor", path: "apps/api/src/site-builder/eval/model-evaluation-executor.ts" },
  { role: "evaluation_cost_safety", path: "apps/api/src/site-builder/eval/model-evaluation-cost-safety.ts" },
  { role: "evaluation_provenance", path: "apps/api/src/site-builder/eval/eval-provenance.ts" },
  { role: "task_route", path: "apps/api/src/site-builder/agents/task-routes.ts" },
  { role: "task_route_binding", path: "apps/api/src/site-builder/agents/task-route-bindings.ts" },
  { role: "profile_registry", path: "apps/api/src/site-builder/agents/model-profiles.ts" },
  { role: "task_runner", path: "apps/api/src/site-builder/agents/ai-task.ts" },
  { role: "schema_validator", path: "apps/api/src/model-gateway/schema-validate.ts" },
  { role: "gateway_router", path: "apps/api/src/model-gateway/router-model-gateway.ts" },
  { role: "provider_registry", path: "apps/api/src/model-gateway/model-provider.registry.ts" },
  { role: "model_router", path: "apps/api/src/model-gateway/model-router.ts" },
  { role: "gateway_types", path: "apps/api/src/model-gateway/types.ts" },
  { role: "gateway_contract", path: "apps/api/src/model-gateway/model-gateway.ts" },
  { role: "provider_contract", path: "apps/api/src/model-gateway/model-provider.ts" },
  { role: "budget_ledger", path: "apps/api/src/tools/budget.ts" },
  { role: "contracts_source", path: "packages/contracts/src/site-builder/design-brief.ts" },
  { role: "contracts_source", path: "packages/contracts/src/site-builder/site-spec.ts" },
  { role: "contracts_source", path: "packages/contracts/src/site-builder/model-policy.ts" },
  { role: "contracts_source", path: "packages/contracts/src/index.ts" },
  { role: "contracts_build", path: "packages/contracts/tsconfig.json" },
  { role: "contracts_manifest", path: "packages/contracts/package.json" },
  { role: "dependency_lock", path: "pnpm-lock.yaml" },
] as const);

const CONTROLLED_ASSEMBLY_ACTUAL_FIXTURE_FINGERPRINTS = deepFreeze(
  CONTROLLED_ASSEMBLY_EVAL_FIXTURES.map((fixture) => {
    const prepared = prepareControlledAssemblyEvalFixture(fixture);
    const prompt =
      fixture.taskId === "site_builder.assemble"
        ? BUILD_ASSEMBLE_PROMPT(prepared.input)
        : BUILD_ASSEMBLY_FIX_PROMPT(prepared.input);
    return {
      fixtureId: fixture.fixtureId,
      fixtureSha256: sha256CanonicalJson(fixture),
      promptSha256: sha256Text(prompt),
    };
  }),
);

const CONTROLLED_ASSEMBLY_EXPECTED_FIXTURE_FINGERPRINTS = deepFreeze([
  { fixtureId: "assemble-natural-origin-rich", fixtureSha256: "e336e75afd83ee0b05d88530c6b813ee05bfcb6414b9cfd40283c997e497d804", promptSha256: "1a347c5491a1ffd7bd28460a759d4ada7f8dfdf912ea37a1db78157b3f5ed4e7" },
  { fixtureId: "assembly-fix-natural-origin-rich", fixtureSha256: "5a67d16f90638671c3b44abc46d97517b89cc13dfba5bc22a1014b00896e1fbf", promptSha256: "2eb1a53eb930e5c36c5cc5e2aadc6d493b68210c95ba69c5d7d03f9cfd7c61a4" },
  { fixtureId: "assemble-natural-origin-sparse", fixtureSha256: "adbcc00018e87965f10d457f291c138cc7162e968954cdfc947020ff509e678b", promptSha256: "d7c7c06c7ae03cafaa09d5c88b77605dd2b5ce160898b26f802e61a12d2d8fac" },
  { fixtureId: "assembly-fix-natural-origin-sparse", fixtureSha256: "9cd6b83a8f95b7a2f8b18e46147020e729f5e0739609439008c9f651d671ae7d", promptSha256: "bc2d8d2758afffbf970c1840ad2562841875815f1e8a77d7c26153ee89b902e1" },
  { fixtureId: "assemble-oem-capability-rich", fixtureSha256: "2e1ab13d81ec156d8d3dfee0e2c53c07500c11440bb90263127c9519e64888f9", promptSha256: "031387f9b3c02fb7572dd66d52d2b62638ba9c1ff901ee9b44071e1a6419c826" },
  { fixtureId: "assembly-fix-oem-capability-rich", fixtureSha256: "8374e444c9b73526e687f802fc638c0dc1142230c147bfe33fa3ce7d02795d50", promptSha256: "42e87adecb20f971b7d93faaede8a3cb67f7e1e11f53b73c80812b6f474771ca" },
  { fixtureId: "assemble-oem-capability-sparse", fixtureSha256: "72dee9a276aba4aa9175243d3f665cb83b6ba6458f7b6e45f71a23950e07962d", promptSha256: "3f36da79391412848835ba40968b675365df50a80064f0c242cc83918dd01005" },
  { fixtureId: "assembly-fix-oem-capability-sparse", fixtureSha256: "66f5b3e98b48ca199ca542b4ea8162467b5f9484be6f7d16846115c6726752ab", promptSha256: "550b7dff9fc146172ff25910c37a4e86e7747eec71e41e4e0008f5d9478e030c" },
  { fixtureId: "assemble-precision-industrial-rich", fixtureSha256: "1036d02308283921527777c9b8518b17608bb78c78ba48fc353d1c1405213af7", promptSha256: "ec6f34f7b9018d51e68eba9fc09dc7d7781a83b0c47aa8c84c09872902802fce" },
  { fixtureId: "assembly-fix-precision-industrial-rich", fixtureSha256: "64a6ccd1b87f62ba7079d96767a694ec9ef8480c4ba164078e008c2f3d420a5d", promptSha256: "dc4196928c6945fe4c6bbcdc9e7d5bd07b7302e9f6c63963e6e84aaf300231b3" },
  { fixtureId: "assemble-precision-industrial-sparse", fixtureSha256: "2a8ca890a75647a636471de8e51bcd6e1e5b8f69b039b62688cd62e5d84cd3d4", promptSha256: "352bc9d38464bbc859ab3b2f2f43889fef0f2e70d15eef5cf0efccf73f5b84d4" },
  { fixtureId: "assembly-fix-precision-industrial-sparse", fixtureSha256: "fe1273073daadde2d5aae836e2bd35e88247d8c3a586a174e68c21792b61ac36", promptSha256: "0f110593e26520e6b986afc3003a0080f557867edef6ba9678779b9770799dce" },
  { fixtureId: "assemble-premium-innovation-rich", fixtureSha256: "7ccb50754004b8c2483b6194a731033e33d4340521efcd5f6508605ab663f164", promptSha256: "2f8ed2aeb1590f3257383162b59c908b6b205ad3aab756413381dc486fb82be9" },
  { fixtureId: "assembly-fix-premium-innovation-rich", fixtureSha256: "769a701ec6c4daa924b2b47336ca4bf4246a77e1f425f01d3f5f1493d404d502", promptSha256: "9d59a59b08ab729953f351e2323c1d0926911900b524c94aba0c54d5762b405f" },
  { fixtureId: "assemble-premium-innovation-sparse", fixtureSha256: "36d1025cb79d13f7561041620b38523011dac6091dd2c2bbdfb05821867e4b00", promptSha256: "aeff4a6866bcda4b26da1ca76c96776a28a96cf6b5de756ddc7cff4a2ae71dc8" },
  { fixtureId: "assembly-fix-premium-innovation-sparse", fixtureSha256: "28862a918110cc1b11c8a3219e2e08e42bb5481c7f7575ef5822f14a3498eb94", promptSha256: "2e6a56cc0816867e4ad31d20973a811e90b798ede10c213cd779b874143d763f" },
  { fixtureId: "assemble-scientific-trust-rich", fixtureSha256: "c0f59981a6bd4ed878b36ddcf698cfcabbc93c4011db64d32d101c8b7b5b3028", promptSha256: "e8b87c072a84fafc92bffcc6ebf1c7d694e4446bc909faddd77271a22e40e7b6" },
  { fixtureId: "assembly-fix-scientific-trust-rich", fixtureSha256: "003277956c4eb5f8ef1c026e221632eeed585028587c085e5debe693fb110ab8", promptSha256: "f041a767a0a64cd3576cb64356fc87145c7424e84f1d2b7277d815f5e322a5bc" },
  { fixtureId: "assemble-scientific-trust-sparse", fixtureSha256: "a26c2ba841c021075fe19a8b92470fc2b470d731ec81f24f5de7269b4528cdf5", promptSha256: "b9ca2cafe79a3944aeb0d4a58dc89ed536a27312802aa64a282ba18535149c88" },
  { fixtureId: "assembly-fix-scientific-trust-sparse", fixtureSha256: "4a849000764d2cbdecca2c6b18b3a8e6a93cc5b39f2db91d9f110bec9daac0d2", promptSha256: "878d00c211a5c96cf384005be1e4d226bf28d582c07800e2bb57cd6f6023593d" },
  { fixtureId: "assemble-technical-catalog-rich", fixtureSha256: "f77d946bbd9c6493f03b1306dc5adf6fa814268655588ef83d8d281c2f705647", promptSha256: "f4aba29ac0f9432a0010fa75bfc3f27f7201c080d2d023bece6c07eb3ff1809a" },
  { fixtureId: "assembly-fix-technical-catalog-rich", fixtureSha256: "5e7a35bafb70d2af77f6a5637eb8bb4661a4818e6a25e6e2f5faf56cbadaaf61", promptSha256: "8cf20ab71781a4544f60a20f86df46c851c91763fa2d38a90b3ea66337e9e5cd" },
  { fixtureId: "assemble-technical-catalog-sparse", fixtureSha256: "67d734fa3ffd6585dc710d06efef2a585d5172e1c296c57dd8549046c93833de", promptSha256: "c28614eaadd025f0c11aaf4447e1ea63e45f4e415f66c4e23ddf16d9495b340c" },
  { fixtureId: "assembly-fix-technical-catalog-sparse", fixtureSha256: "788eb36bc4d3a08e0b14f56fe392522fea13fa01cacce3a979258f459678c1aa", promptSha256: "eefc95eb68c339b6b982a8e3af419015d17d30a8e7cd9ebc5f0c3f71bd279ec8" },
] as const);

if (
  JSON.stringify(CONTROLLED_ASSEMBLY_ACTUAL_FIXTURE_FINGERPRINTS) !==
  JSON.stringify(CONTROLLED_ASSEMBLY_EXPECTED_FIXTURE_FINGERPRINTS)
) {
  throw new Error("controlled assembly frozen fixture fingerprints drifted");
}

function controlledAssemblySuite(
  taskId: "site_builder.assemble" | "site_builder.assembly_fix",
): TaskEvaluationSuite {
  const isAssemble = taskId === "site_builder.assemble";
  const inputSchema = isAssemble
    ? ASSEMBLE_INPUT_SCHEMA_SNAPSHOT
    : ASSEMBLY_FIX_INPUT_SCHEMA_SNAPSHOT;
  const outputSchema = isAssemble
    ? ASSEMBLE_OUTPUT_SCHEMA_SNAPSHOT
    : ASSEMBLY_FIX_OUTPUT_SCHEMA_SNAPSHOT;
  return deepFreeze({
    suiteId: `site-builder.${isAssemble ? "assemble" : "assembly-fix"}-evaluation-suite/2026-08-04-v1`,
    adapterId: "site-builder-controlled-assembly-evaluation-adapter/v1",
    taskContractId: taskId,
    promptVersion: CONTROLLED_ASSEMBLY_PROMPT_VERSION,
    systemPromptSha256: isAssemble
      ? ASSEMBLE_SYSTEM_PROMPT_SHA256
      : ASSEMBLY_FIX_SYSTEM_PROMPT_SHA256,
    inputSchemaSha256: sha256CanonicalJson(inputSchema),
    outputSchemaSha256: sha256CanonicalJson(outputSchema),
    repairTaskOutput: isAssemble
      ? ASSEMBLE_REPAIR_TASK_OUTPUT
      : ASSEMBLY_FIX_REPAIR_TASK_OUTPUT,
    routeValidationVersion: CONTROLLED_ASSEMBLY_ROUTE_VALIDATION_VERSION,
    evaluatorVersion: CONTROLLED_ASSEMBLY_EVALUATOR_VERSION,
    evaluatorRubricSha256: sha256CanonicalJson(
      CONTROLLED_ASSEMBLY_EVALUATOR_RUBRIC,
    ),
    fixtureSetId: "site-builder-controlled-assembly-golden/2026-08-04-v1",
    fixtureSchemaVersion: CONTROLLED_ASSEMBLY_EVAL_FIXTURE_SCHEMA_VERSION,
    fixtureIds: Object.freeze(
      CONTROLLED_ASSEMBLY_EVAL_FIXTURES.filter(
        (fixture) => fixture.taskId === taskId,
      ).map((fixture) => fixture.fixtureId),
    ),
    fixtureFingerprints: Object.freeze(
      CONTROLLED_ASSEMBLY_EXPECTED_FIXTURE_FINGERPRINTS.filter((entry) =>
        entry.fixtureId.startsWith(isAssemble ? "assemble-" : "assembly-fix-"),
      ),
    ),
    repeats: 2,
    legacyComparatorAliases: Object.freeze([]),
    compiledContractsRuntimeBinding: null,
    sourceBundleContractId: "controlled-assembly-evaluation-source-bundle/v1",
    sourceBundleFiles: CONTROLLED_ASSEMBLY_EVALUATION_SOURCE_FILES,
  });
}

const ASSEMBLE_EVALUATION_SUITE = controlledAssemblySuite(
  "site_builder.assemble",
);
const ASSEMBLY_FIX_EVALUATION_SUITE = controlledAssemblySuite(
  "site_builder.assembly_fix",
);

const QUALITY_NARRATIVE_EVALUATION_SOURCE_FILES = deepFreeze([
  {
    role: "candidate_baseline",
    path: "apps/api/src/site-builder/agents/model-candidate-baseline.ts",
  },
  {
    role: "candidate_baseline",
    path: "apps/api/src/site-builder/agents/model-candidate-baseline.json",
  },
  {
    role: "task",
    path: "apps/api/src/site-builder/quality/quality-narrative.ts",
  },
  {
    role: "quality_narrative_consumer",
    path: "apps/api/src/site-builder/quality/quality-narrative.service.ts",
  },
  {
    role: "judge",
    path: "apps/api/src/site-builder/eval/quality-narrative-eval.ts",
  },
  {
    role: "harness",
    path: "apps/api/src/site-builder/eval/model-evaluation-harness.ts",
  },
  {
    role: "evaluation_executor",
    path: "apps/api/src/site-builder/eval/model-evaluation-executor.ts",
  },
  {
    role: "evaluation_cost_safety",
    path: "apps/api/src/site-builder/eval/model-evaluation-cost-safety.ts",
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
    role: "profile_registry",
    path: "apps/api/src/site-builder/agents/model-profiles.ts",
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
    role: "schema_validator",
    path: "apps/api/src/model-gateway/schema-validate.ts",
  },
  {
    role: "gateway_router",
    path: "apps/api/src/model-gateway/router-model-gateway.ts",
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
  {
    role: "contracts_source",
    path: "packages/contracts/src/site-builder/design-evaluation.ts",
  },
  {
    role: "contracts_source",
    path: "packages/contracts/src/site-builder/model-policy.ts",
  },
  { role: "contracts_source", path: "packages/contracts/src/index.ts" },
  { role: "contracts_build", path: "packages/contracts/tsconfig.json" },
  { role: "contracts_manifest", path: "packages/contracts/package.json" },
  { role: "dependency_lock", path: "pnpm-lock.yaml" },
] as const);

const QUALITY_NARRATIVE_ACTUAL_FIXTURE_FINGERPRINTS = deepFreeze(
  QUALITY_NARRATIVE_EVAL_FIXTURES.map((fixture) => {
    const prepared = prepareQualityNarrativeEvalFixture(fixture);
    const prompt =
      fixture.taskId === "site_builder.qa_summarize"
        ? BUILD_QA_SUMMARIZE_PROMPT(prepared.input)
        : BUILD_SEO_REVIEW_PROMPT(prepared.input);
    return {
      fixtureId: fixture.fixtureId,
      fixtureSha256: sha256CanonicalJson(fixture),
      promptSha256: sha256Text(prompt),
    };
  }),
);

const QUALITY_NARRATIVE_EXPECTED_FIXTURE_FINGERPRINTS = deepFreeze([
  {
    fixtureId: "qa-multigroup",
    fixtureSha256:
      "01dfffef595e77530d897799c2c24d5d8422416146635044f63ed28b5c53d50f",
    promptSha256:
      "491c0affcec997403bdbc8326a1c3ee7b1333bffbef2f4c75e69d9dbb89564e0",
  },
  {
    fixtureId: "qa-ordering",
    fixtureSha256:
      "db29e8843498fe1e19db46f846825e8e7d44456efeaf9086829f4bee0c4dc342",
    promptSha256:
      "f9acc0c526c9a2290e3e2af81da919749a8c87cf00ec347958e432a6180bfcbc",
  },
  {
    fixtureId: "seo-full-rule-matrix",
    fixtureSha256:
      "baca3079d7b237e9fcad04b13ee296735bd8f26ab80d35e6c2850ea87f8dacbe",
    promptSha256:
      "2285b868e07d58a7ed99e9263f882b539d5a9e67d2393d2ff5f6bcb822e6295a",
  },
  {
    fixtureId: "seo-multilocale-reports",
    fixtureSha256:
      "f10c561e6576b72fbcbe2e27b906c43e09d814f809b02b4d11d26b802523c077",
    promptSha256:
      "2b7331e2d2e54bab1e4567b4fee4f015d0fc82e7e7e88869fe1ae990e23e3932",
  },
] as const);

if (
  JSON.stringify(QUALITY_NARRATIVE_ACTUAL_FIXTURE_FINGERPRINTS) !==
  JSON.stringify(QUALITY_NARRATIVE_EXPECTED_FIXTURE_FINGERPRINTS)
) {
  throw new Error("quality narrative frozen fixture fingerprints drifted");
}

function qualityNarrativeFixtureFingerprints(
  taskId: "site_builder.qa_summarize" | "site_builder.seo_review",
) {
  return deepFreeze(
    QUALITY_NARRATIVE_EXPECTED_FIXTURE_FINGERPRINTS.filter((fingerprint) =>
      fingerprint.fixtureId.startsWith(
        taskId === "site_builder.qa_summarize" ? "qa-" : "seo-",
      ),
    ),
  );
}

function qualityNarrativeSuite(
  taskId: "site_builder.qa_summarize" | "site_builder.seo_review",
): TaskEvaluationSuite {
  const isQa = taskId === "site_builder.qa_summarize";
  const inputSchema = isQa
    ? QA_SUMMARIZE_INPUT_SCHEMA_SNAPSHOT
    : SEO_REVIEW_INPUT_SCHEMA_SNAPSHOT;
  const outputSchema = isQa
    ? QA_SUMMARIZE_OUTPUT_SCHEMA_SNAPSHOT
    : SEO_REVIEW_OUTPUT_SCHEMA_SNAPSHOT;
  return deepFreeze({
    suiteId: `site-builder.${isQa ? "qa-summarize" : "seo-review"}-evaluation-suite/2026-08-04-v1`,
    adapterId: "site-builder-quality-narrative-evaluation-adapter/v1",
    taskContractId: taskId,
    promptVersion: QUALITY_NARRATIVE_PROMPT_VERSION,
    systemPromptSha256: isQa
      ? QA_SUMMARIZE_SYSTEM_PROMPT_SHA256
      : SEO_REVIEW_SYSTEM_PROMPT_SHA256,
    inputSchemaSha256: sha256CanonicalJson(inputSchema),
    outputSchemaSha256: sha256CanonicalJson(outputSchema),
    repairTaskOutput: isQa
      ? QA_SUMMARIZE_REPAIR_TASK_OUTPUT
      : SEO_REVIEW_REPAIR_TASK_OUTPUT,
    routeValidationVersion: QUALITY_NARRATIVE_ROUTE_VALIDATION_VERSION,
    evaluatorVersion: QUALITY_NARRATIVE_EVALUATOR_VERSION,
    evaluatorRubricSha256: sha256CanonicalJson(
      QUALITY_NARRATIVE_EVALUATOR_RUBRIC,
    ),
    fixtureSetId: "site-builder-quality-narrative-golden/2026-08-04-v1",
    fixtureSchemaVersion: QUALITY_NARRATIVE_EVAL_FIXTURE_SCHEMA_VERSION,
    fixtureIds: Object.freeze(
      QUALITY_NARRATIVE_EVAL_FIXTURES.filter(
        (fixture) => fixture.taskId === taskId,
      ).map((fixture) => fixture.fixtureId),
    ),
    fixtureFingerprints: qualityNarrativeFixtureFingerprints(taskId),
    repeats: 2,
    legacyComparatorAliases: Object.freeze([]),
    compiledContractsRuntimeBinding: null,
    sourceBundleContractId: "quality-narrative-evaluation-source-bundle/v1",
    sourceBundleFiles: QUALITY_NARRATIVE_EVALUATION_SOURCE_FILES,
  });
}

const QA_SUMMARIZE_EVALUATION_SUITE = qualityNarrativeSuite(
  "site_builder.qa_summarize",
);
const SEO_REVIEW_EVALUATION_SUITE = qualityNarrativeSuite(
  "site_builder.seo_review",
);

const TASK_EVALUATION_SUITES = Object.freeze(
  new Map<SiteBuilderTaskId, TaskEvaluationSuite>([
    ["site_builder.brand_profile", BRAND_PROFILE_EVALUATION_SUITE],
    ["site_builder.copy", COPY_EVALUATION_SUITE],
    ["site_builder.design_spec", DESIGN_SPEC_EVALUATION_SUITE],
    ["site_builder.assemble", ASSEMBLE_EVALUATION_SUITE],
    ["site_builder.assembly_fix", ASSEMBLY_FIX_EVALUATION_SUITE],
    ["site_builder.qa_summarize", QA_SUMMARIZE_EVALUATION_SUITE],
    ["site_builder.seo_review", SEO_REVIEW_EVALUATION_SUITE],
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

/**
 * Evaluation envelopes are deliberately separate from production task routes.
 * These two closed assembly tasks keep their existing runtime token ceilings;
 * the smaller value applies only to the finite, paid-evaluation matrix.
 */
export const SITE_BUILDER_EVALUATION_ONLY_MAX_TOKENS: Readonly<
  Partial<Record<SiteBuilderTaskId, number>>
> = Object.freeze({
  'site_builder.assemble': 12_000,
  'site_builder.assembly_fix': 12_000,
});

function evaluationEnvelope(taskId: SiteBuilderTaskId): TaskEvaluationEnvelope {
  const binding = getSiteBuilderTaskRouteBinding(taskId);
  const runtimeDeadlineMs = binding.timeoutMs;
  // A late response remains observable for one additional task-shaped window.
  // There is deliberately no global 120-second or 800-token evaluator default.
  const diagnosticObservationMs = binding.timeoutMs;
  return {
    maxTokens:
      SITE_BUILDER_EVALUATION_ONLY_MAX_TOKENS[taskId] ?? binding.maxTokens,
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
  costSafetyContractId: typeof SITE_BUILDER_MODEL_EVALUATION_COST_SAFETY_ID;
  costSafetyAttestationSha256: string;
  credentialSnapshotSha256: string;
  pricingSnapshotSha256: string;
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
  compiledContractsArtifactTreeSha256: string | null;
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

export type ModelEvaluationCostBasis =
  "provider_reported" | "frozen_pricing_snapshot" | "verified_billing_export";

export type ModelEvaluationAuditedCostBasis =
  `${ModelEvaluationCostBasis}@${string}`;

export type CostSettlement =
  | {
      state: "settled";
      amountCents: number;
      basis: ModelEvaluationAuditedCostBasis;
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

const TRUSTED_MONOTONIC_NOW = performance.now.bind(performance);

function maximumExecutionCallCount(repairTaskOutput: boolean): number {
  return repairTaskOutput ? 2 : 1;
}

const TRUSTED_MODEL_EVALUATION_BUDGETS = new WeakMap<
  object,
  { readonly campaignId: string }
>();
const TRUSTED_MODEL_EVALUATION_RUN_BUDGETS = new WeakMap<
  object,
  ModelEvaluationBudgetGuard
>();
const TRUSTED_MODEL_EVALUATION_BUDGET_EXECUTORS = new WeakMap<object, object>();

function trustedBrandGet<K extends object, V>(
  map: WeakMap<K, V>,
  key: K,
): V | undefined {
  return APPLY_TRUSTED_BRAND_INTRINSIC(TRUSTED_BRAND_WEAK_MAP_GET, map, [
    key,
  ]) as V | undefined;
}

function trustedBrandSet<K extends object, V>(
  map: WeakMap<K, V>,
  key: K,
  value: V,
): void {
  APPLY_TRUSTED_BRAND_INTRINSIC(TRUSTED_BRAND_WEAK_MAP_SET, map, [key, value]);
}

function trustedBrandHas<K extends object, V>(
  map: WeakMap<K, V>,
  key: K,
): boolean {
  return APPLY_TRUSTED_BRAND_INTRINSIC(TRUSTED_BRAND_WEAK_MAP_HAS, map, [
    key,
  ]) as boolean;
}

function trustedBrandWeakSetAdd(set: WeakSet<object>, value: object): void {
  APPLY_TRUSTED_BRAND_INTRINSIC(TRUSTED_BRAND_WEAK_SET_ADD, set, [value]);
}

function trustedBrandWeakSetHas(set: WeakSet<object>, value: object): boolean {
  return APPLY_TRUSTED_BRAND_INTRINSIC(TRUSTED_BRAND_WEAK_SET_HAS, set, [
    value,
  ]) as boolean;
}

function bindTrustedModelEvaluationExecutor(
  budget: ModelEvaluationBudgetGuard,
  execute: unknown,
  plan: TaskEvaluationPlan,
): ModelEvaluationCostSafetyAttestation {
  const identity = modelEvaluationProtocolExecutorIdentity(execute);
  const costSafety = modelEvaluationProtocolExecutorCostSafety(execute);
  if (identity === null || costSafety === null) {
    throw new ModelEvaluationCallError("untrusted_evaluation_executor", {
      state: "not_incurred",
      reason: "rejected_before_dispatch",
    });
  }
  const comparatorAliases = plan.evaluationSuite?.legacyComparatorAliases ?? [];
  const expectedDispatches = [
    ...plan.candidates.map(
      (candidate) => `target:${candidate.alias}:${candidate.expectedProtocol}`,
    ),
    ...comparatorAliases.map(
      (alias) => `legacy_comparator:${alias}:openai-chat-completions`,
    ),
  ].sort();
  const actualDispatches = costSafety.credential.allowedDispatches
    .map((entry) => `${entry.mode}:${entry.alias}:${entry.protocol}`)
    .sort();
  const requiresExactCapacity = comparatorAliases.length === 0;
  const requiredExecutions =
    plan.evaluationSuite === null
      ? 0
      : plan.candidates.length *
          plan.evaluationSuite.fixtureIds.length *
          plan.evaluationSuite.repeats +
        comparatorAliases.length *
          plan.evaluationSuite.fixtureIds.length *
          plan.evaluationSuite.repeats +
        plan.candidates.filter(
          (candidate) => candidate.preflight === "capability_probe",
        ).length;
  const requiredWireCalls =
    requiredExecutions *
    maximumExecutionCallCount(plan.evaluationSuite?.repairTaskOutput === true);
  const suite = plan.evaluationSuite;
  const preparedCase =
    suite === null
      ? null
      : buildCanonicalModelEvaluationCase(plan, suite.fixtureIds[0]);
  const currentFixedCommitSha = (() => {
    try {
      const observed = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: REAL_REPOSITORY_ROOT,
        encoding: "utf8",
      }).trim();
      return /^[a-f0-9]{40}$/.test(observed) ? observed : null;
    } catch {
      return null;
    }
  })();
  if (
    suite === null ||
    preparedCase === null ||
    currentFixedCommitSha === null ||
    costSafety.authorization.preparedFixedCommitSha !== currentFixedCommitSha ||
    suite.systemPromptSha256 !== currentTaskSystemPromptSha256(plan.taskId) ||
    !currentTaskValidatorMatchesCapturedIdentity(plan.taskId) ||
    costSafety.authorization.preparedSuiteId !== suite.suiteId ||
    costSafety.authorization.preparedSourceBundleContractId !==
      suite.sourceBundleContractId ||
    costSafety.authorization.preparedSourceBundleSha256 !==
      preparedCase.contract.sourceBundleSha256 ||
    JSON.stringify(actualDispatches) !== JSON.stringify(expectedDispatches) ||
    budget.campaignBudgetCents > costSafety.limits.campaignBudgetCents ||
    costSafety.limits.maxOutputTokensPerCall < plan.envelope.maxTokens ||
    (requiresExactCapacity
      ? costSafety.limits.maxDispatchExecutions !== requiredExecutions
      : costSafety.limits.maxDispatchExecutions < requiredExecutions) ||
    (requiresExactCapacity
      ? costSafety.limits.maxWireCalls !== requiredWireCalls
      : costSafety.limits.maxWireCalls < requiredWireCalls)
  ) {
    throw new ModelEvaluationCallError("evaluation_cost_safety_mismatch", {
      state: "not_incurred",
      reason: "rejected_before_dispatch",
    });
  }
  const bound = trustedBrandGet(
    TRUSTED_MODEL_EVALUATION_BUDGET_EXECUTORS,
    budget,
  );
  if (bound && bound !== identity) {
    throw new ModelEvaluationCallError(
      "evaluation_executor_campaign_mismatch",
      {
        state: "not_incurred",
        reason: "rejected_before_dispatch",
      },
    );
  }
  if (!bound) {
    trustedBrandSet(
      TRUSTED_MODEL_EVALUATION_BUDGET_EXECUTORS,
      budget,
      identity,
    );
  }
  return costSafety;
}

function costSafetyProvenance(
  attestation: ModelEvaluationCostSafetyAttestation,
): Pick<
  CapabilityProbeAttestation,
  | "costSafetyContractId"
  | "costSafetyAttestationSha256"
  | "credentialSnapshotSha256"
  | "pricingSnapshotSha256"
> {
  return {
    costSafetyContractId: SITE_BUILDER_MODEL_EVALUATION_COST_SAFETY_ID,
    costSafetyAttestationSha256: sha256CanonicalJson(attestation),
    credentialSnapshotSha256: attestation.credential.snapshotSha256,
    pricingSnapshotSha256: attestation.pricing.snapshotSha256,
  };
}

export class ModelEvaluationBudgetGuard {
  readonly #campaignBudgetCents: number;
  readonly #reservations = new Map<
    string,
    {
      reservedCents: number;
    }
  >();
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
    trustedBrandSet(
      TRUSTED_MODEL_EVALUATION_BUDGETS,
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
    maximumCallCount = 1,
  ): ModelEvaluationBudgetReserveResult {
    assertNonNegativeFinite(perCallCapCents, "perCallCapCents");
    if (perCallCapCents === 0) {
      throw new Error("perCallCapCents must be greater than zero");
    }
    if (!Number.isInteger(maximumCallCount) || maximumCallCount < 1) {
      throw new Error("maximumCallCount must be a positive integer");
    }
    const reservedCents = perCallCapCents * maximumCallCount;
    assertNonNegativeFinite(reservedCents, "reservedCents");
    if (this.#reservations.has(callId) || this.#completedCalls.has(callId)) {
      return { allowed: false, reason: "duplicate_call" };
    }
    if (this.#blockReason) {
      return { allowed: false, reason: this.#blockReason };
    }
    if (reservedCents > this.#remainingDispatchableCents()) {
      return { allowed: false, reason: "campaign_budget_exhausted" };
    }
    this.#reservations.set(callId, {
      reservedCents,
    });
    return {
      allowed: true,
      reservation: { callId, reservedCents },
    };
  }

  settle(
    callId: string,
    settlement: unknown,
  ): ModelEvaluationBudgetSettlementResult {
    const reservation = this.#reservations.get(callId);
    if (reservation === undefined) {
      throw new Error(
        `model evaluation call has no active reservation: ${callId}`,
      );
    }
    const normalized = normalizeCostSettlement(settlement);
    this.#reservations.delete(callId);
    this.#completedCalls.add(callId);

    if (normalized.settlement.state === "unknown") {
      this.#unknownUpperBoundCents += reservation.reservedCents;
      this.#blockReason = "unknown_settlement";
      return normalized;
    }
    if (normalized.settlement.state === "not_incurred") return normalized;

    this.#committedCents += normalized.settlement.amountCents;
    if (
      normalized.settlement.amountCents > reservation.reservedCents ||
      this.#committedCents + this.#unknownUpperBoundCents >
        this.#campaignBudgetCents
    ) {
      this.#blockReason = "per_call_cap_exceeded";
    }
    return {
      ...normalized,
      capExceeded:
        normalized.settlement.amountCents > reservation.reservedCents,
    };
  }

  #reservedCents(): number {
    return [...this.#reservations.values()].reduce(
      (total, value) => total + value.reservedCents,
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
    !trustedBrandHas(TRUSTED_MODEL_EVALUATION_BUDGETS, budget)
  ) {
    throw new Error("trusted model evaluation budget guard is required");
  }
}

function trustedModelEvaluationCampaignId(budget: unknown): string {
  assertTrustedModelEvaluationBudget(budget);
  const campaignId = trustedBrandGet(
    TRUSTED_MODEL_EVALUATION_BUDGETS,
    budget,
  )?.campaignId;
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
  assertDeepFrozen(frozenRun);
  trustedBrandSet(TRUSTED_MODEL_EVALUATION_RUN_BUDGETS, frozenRun, budget);
  return frozenRun;
}

function assertTrustedModelEvaluationRunBudget(
  run: ModelEvaluationRun,
  budget: ModelEvaluationBudgetGuard,
): void {
  assertTrustedModelEvaluationBudget(budget);
  if (trustedBrandGet(TRUSTED_MODEL_EVALUATION_RUN_BUDGETS, run) !== budget) {
    throw new Error(
      "candidate summary requires runs from one trusted in-memory campaign budget",
    );
  }
}

function reserveTrustedModelEvaluationBudget(
  budget: unknown,
  callId: string,
  perCallCapCents: number,
  maximumCallCount = 1,
): ModelEvaluationBudgetReserveResult {
  assertTrustedModelEvaluationBudget(budget);
  return RESERVE_TRUSTED_MODEL_EVALUATION_BUDGET.call(
    budget,
    callId,
    perCallCapCents,
    maximumCallCount,
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
const SETTLEMENT_RESOLVER_ID = /^[a-z0-9][a-z0-9._/-]{0,127}$/;
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
    const basis =
      typeof record.basis === "string"
        ? record.basis.slice(0, record.basis.indexOf("@"))
        : "";
    const resolverId =
      typeof record.basis === "string"
        ? record.basis.slice(record.basis.indexOf("@") + 1)
        : "";
    if (
      !exactKeys(record, ["state", "amountCents", "basis"]) ||
      typeof record.amountCents !== "number" ||
      !Number.isFinite(record.amountCents) ||
      record.amountCents < 0 ||
      typeof record.basis !== "string" ||
      record.basis.indexOf("@") < 1 ||
      !SETTLED_COST_BASES.has(basis) ||
      !SETTLEMENT_RESOLVER_ID.test(resolverId)
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
  costSafetyContractId: typeof SITE_BUILDER_MODEL_EVALUATION_COST_SAFETY_ID;
  costSafetyAttestationSha256: string;
  credentialSnapshotSha256: string;
  pricingSnapshotSha256: string;
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
  compiledContractsArtifactTreeSha256: string | null;
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
  compiledContractsArtifactTreeSha256: string | null;
}

export interface ModelEvaluationSourceFileFingerprint {
  role: string;
  path: string;
  sha256: string;
}

export interface ModelEvaluationCasePayload {
  fixture:
    | BrandProfileEvalFixture
    | DesignSpecEvalFixture
    | CopyAssemblyEvalFixture
    | ControlledAssemblyEvalFixture
    | QualityNarrativeEvalFixture;
  taskInput:
    | BrandProfileInput
    | DesignSpecTaskInput
    | CopyTaskInput
    | ControlledAssemblyTaskInput
    | QualityNarrativeTaskInputV1;
  prompt: string;
  sourceFiles: readonly ModelEvaluationSourceFileFingerprint[];
}

export interface ModelEvaluationCase {
  contract: ModelEvaluationCaseContract;
  payload: ModelEvaluationCasePayload;
}

export interface ModelEvaluationExecutionRequest {
  executionId: string;
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

const AUTHORIZED_MODEL_EVALUATION_EXECUTION_REQUESTS = new WeakSet<object>();
const AUTHORIZED_EXECUTION_ADD = WeakSet.prototype.add;
const AUTHORIZED_EXECUTION_HAS = WeakSet.prototype.has;
const AUTHORIZED_EXECUTION_DELETE = WeakSet.prototype.delete;
const APPLY_AUTHORIZED_EXECUTION_INTRINSIC = Reflect.apply;

function authorizeModelEvaluationExecutionRequest(
  request: ModelEvaluationExecutionRequest | CapabilityProbeExecutionRequest,
): void {
  APPLY_AUTHORIZED_EXECUTION_INTRINSIC(
    AUTHORIZED_EXECUTION_ADD,
    AUTHORIZED_MODEL_EVALUATION_EXECUTION_REQUESTS,
    [request],
  );
}

export function consumeAuthorizedModelEvaluationExecutionRequest(
  request: unknown,
): boolean {
  if (!request || typeof request !== "object") return false;
  const authorized = APPLY_AUTHORIZED_EXECUTION_INTRINSIC(
    AUTHORIZED_EXECUTION_HAS,
    AUTHORIZED_MODEL_EVALUATION_EXECUTION_REQUESTS,
    [request],
  ) as boolean;
  if (!authorized) return false;
  APPLY_AUTHORIZED_EXECUTION_INTRINSIC(
    AUTHORIZED_EXECUTION_DELETE,
    AUTHORIZED_MODEL_EVALUATION_EXECUTION_REQUESTS,
    [request],
  );
  return true;
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
    compiledContractsRuntimeMatchesSuite(plan.evaluationSuite) &&
    attestation.schemaVersion === CAPABILITY_PROBE_ATTESTATION_SCHEMA_VERSION &&
    CAMPAIGN_ID.test(attestation.campaignId) &&
    attestation.harnessId === SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID &&
    attestation.candidateBaselineId ===
      SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID &&
    attestation.costSafetyContractId ===
      SITE_BUILDER_MODEL_EVALUATION_COST_SAFETY_ID &&
    SHA256.test(attestation.costSafetyAttestationSha256) &&
    SHA256.test(attestation.credentialSnapshotSha256) &&
    SHA256.test(attestation.pricingSnapshotSha256) &&
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
    attestation.compiledContractsArtifactTreeSha256 ===
      probeCase.contract.compiledContractsArtifactTreeSha256 &&
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
      plan.envelope.perCallCostCapCents *
        maximumExecutionCallCount(plan.evaluationSuite.repairTaskOutput) &&
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
    trustedBrandWeakSetAdd(TRUSTED_CAPABILITY_CAMPAIGNS, this);
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
    if (!isTrustedModelEvaluationProtocolExecute(options.execute)) {
      throw new ModelEvaluationCallError("untrusted_evaluation_executor", {
        state: "not_incurred",
        reason: "rejected_before_dispatch",
      });
    }
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
    assertCompiledContractsRuntimeBeforeDispatch(options.plan.evaluationSuite);
    const costSafety = bindTrustedModelEvaluationExecutor(
      this.#budget,
      options.execute,
      options.plan,
    );
    const evaluationCase = buildCanonicalModelEvaluationCase(
      options.plan,
      options.plan.evaluationSuite.fixtureIds[0],
    );
    const probeKey = capabilityProbeKey(options.plan, options.candidate);
    const existingAttestation = this.#attestations.get(probeKey);
    if (
      existingAttestation &&
      capabilityProbeAttestationIsCanonical(
        options.plan,
        options.candidate,
        existingAttestation,
      )
    ) {
      return {
        status: "capability_proven",
        protocolVerified: true,
        identityVerified: true,
        outputVerified: true,
      };
    }
    this.#attestations.delete(probeKey);
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
      maximumExecutionCallCount(options.plan.evaluationSuite.repairTaskOutput),
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
    const trustedStartedAt = readMonotonicNow(TRUSTED_MONOTONIC_NOW);
    if (startedAt === null || trustedStartedAt === null) {
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
      executionId: callId,
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
      outputSchema: canonicalTaskOutputSchema(options.plan.taskId),
      repairTaskOutput: options.plan.evaluationSuite.repairTaskOutput,
      caseContract: evaluationCase.contract,
      casePayload: evaluationCase.payload,
      signal: controller.signal,
    });
    authorizeModelEvaluationExecutionRequest(request);
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
      await freezeModelEvaluationProtocolExecutor(options.execute);
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
    const reportedProbeElapsedMs = readMonotonicElapsed(now, startedAt);
    const trustedProbeElapsedMs = readMonotonicElapsed(
      TRUSTED_MONOTONIC_NOW,
      trustedStartedAt,
    );
    const observedProbeElapsedMs =
      trustedProbeElapsedMs === null
        ? null
        : Math.max(reportedProbeElapsedMs ?? 0, trustedProbeElapsedMs);
    if (
      trustedProbeElapsedMs === null ||
      (observedProbeElapsedMs !== null &&
        observedProbeElapsedMs >= options.plan.envelope.hardStopMs)
    ) {
      controller.abort(
        new Error("model capability probe completed after hard stop"),
      );
      await freezeModelEvaluationProtocolExecutor(options.execute);
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
    const elapsedMs = observedProbeElapsedMs;
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
      compiledContractsRuntimeMatchesSuite(options.plan.evaluationSuite) &&
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
      assessCanonicalTaskArtifact(
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
      ...costSafetyProvenance(costSafety),
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
      compiledContractsArtifactTreeSha256:
        evaluationCase.contract.compiledContractsArtifactTreeSha256,
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
    !trustedBrandWeakSetHas(TRUSTED_CAPABILITY_CAMPAIGNS, campaign)
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
    systemPromptSha256: suite.systemPromptSha256,
    inputSchemaSha256: suite.inputSchemaSha256,
    outputSchemaSha256: suite.outputSchemaSha256,
    repairTaskOutput: suite.repairTaskOutput,
    routeValidationVersion: suite.routeValidationVersion,
    evaluatorVersion: suite.evaluatorVersion,
    evaluatorRubricSha256: suite.evaluatorRubricSha256,
    fixtureSetId: suite.fixtureSetId,
    fixtureSchemaVersion: suite.fixtureSchemaVersion,
    fixtureFingerprints: suite.fixtureFingerprints,
    compiledContractsRuntimeBinding: suite.compiledContractsRuntimeBinding,
    sourceBundleContractId: suite.sourceBundleContractId,
    sourceBundleFiles: suite.sourceBundleFiles,
  });
}

const REPOSITORY_ROOT = resolve(__dirname, "../../../../..");
const REAL_REPOSITORY_ROOT = realpathSync(REPOSITORY_ROOT);

function compiledContractsRuntimeMatchesSuite(
  suite: TaskEvaluationSuite,
): boolean {
  const expected = suite.compiledContractsRuntimeBinding;
  if (expected === null) return true;
  return (
    compiledContractsRuntimeBindingMatches(
      expected,
      DESIGN_SPEC_COMPILED_CONTRACTS_RUNTIME_BINDING,
    ) && modelEvaluationRuntimeIntegrityMatches(suite.taskContractId)
  );
}

function assertCompiledContractsRuntimeBeforeDispatch(
  suite: TaskEvaluationSuite,
): void {
  try {
    assertModelEvaluationRuntimeIntegrity(suite.taskContractId);
  } catch {
    throw new ModelEvaluationCallError(
      "compiled_contracts_runtime_attestation_mismatch",
      {
        state: "not_incurred",
        reason: "rejected_before_dispatch",
      },
    );
  }
}

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

export function modelEvaluationSourceBundleMatches(
  expected: readonly ModelEvaluationSourceFileFingerprint[],
  observed: readonly ModelEvaluationSourceFileFingerprint[],
): boolean {
  return JSON.stringify(observed) === JSON.stringify(expected);
}

function sourceBundleMatchesCase(
  suite: TaskEvaluationSuite,
  payload: ModelEvaluationCasePayload,
): boolean {
  try {
    return modelEvaluationSourceBundleMatches(
      payload.sourceFiles,
      currentSourceBundle(suite),
    );
  } catch {
    return false;
  }
}

function canonicalTaskOutputSchema(
  taskId: SiteBuilderTaskId,
): Readonly<Record<string, unknown>> {
  if (taskId === "site_builder.brand_profile") {
    return BRAND_PROFILE_OUTPUT_SCHEMA_SNAPSHOT;
  }
  if (taskId === "site_builder.design_spec") {
    return DESIGN_SPEC_OUTPUT_SCHEMA_SNAPSHOT;
  }
  if (taskId === "site_builder.copy") {
    return COPY_OUTPUT_SCHEMA_SNAPSHOT;
  }
  if (taskId === "site_builder.assemble") {
    return ASSEMBLE_OUTPUT_SCHEMA_SNAPSHOT;
  }
  if (taskId === "site_builder.assembly_fix") {
    return ASSEMBLY_FIX_OUTPUT_SCHEMA_SNAPSHOT;
  }
  if (taskId === "site_builder.qa_summarize") {
    return QA_SUMMARIZE_OUTPUT_SCHEMA_SNAPSHOT;
  }
  if (taskId === "site_builder.seo_review") {
    return SEO_REVIEW_OUTPUT_SCHEMA_SNAPSHOT;
  }
  throw new Error(`task output schema is not canonical: ${taskId}`);
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
  if (plan.dispatchAdmission !== "task_evaluation_ready" || !suite) {
    throw new Error(`task evaluation has no canonical suite: ${plan.taskId}`);
  }
  if (!suite.fixtureIds.includes(fixtureId)) {
    throw new Error(`model evaluation fixture is not canonical: ${fixtureId}`);
  }
  let fixture:
    | BrandProfileEvalFixture
    | DesignSpecEvalFixture
    | CopyAssemblyEvalFixture
    | ControlledAssemblyEvalFixture
    | QualityNarrativeEvalFixture;
  let taskInput:
    | BrandProfileInput
    | DesignSpecTaskInput
    | CopyTaskInput
    | ControlledAssemblyTaskInput
    | QualityNarrativeTaskInputV1;
  let prompt: string;
  if (plan.taskId === "site_builder.brand_profile") {
    fixture = JSON.parse(
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
    taskInput = prepared.input;
    prompt = BUILD_BRAND_PROFILE_PROMPT(prepared.input);
  } else if (plan.taskId === "site_builder.design_spec") {
    const canonicalFixture = DESIGN_SPEC_EVAL_FIXTURES.find(
      (entry) => entry.fixtureId === fixtureId,
    );
    if (!canonicalFixture) {
      throw new Error(
        `model evaluation fixture is not canonical: ${fixtureId}`,
      );
    }
    fixture = canonicalFixture;
    const prepared = prepareDesignSpecEvalFixture(canonicalFixture);
    taskInput = prepared.input;
    prompt = BUILD_DESIGN_SPEC_PROMPT(prepared.input);
  } else if (plan.taskId === "site_builder.copy") {
    const canonicalFixture = COPY_ASSEMBLY_EVAL_FIXTURES.find(
      (entry) => entry.fixtureId === fixtureId,
    );
    if (!canonicalFixture) {
      throw new Error(`model evaluation fixture is not canonical: ${fixtureId}`);
    }
    fixture = canonicalFixture;
    const prepared = prepareCopyAssemblyEvalFixture(canonicalFixture);
    taskInput = prepared.input;
    prompt = BUILD_COPY_PROMPT(prepared.input);
  } else if (
    plan.taskId === "site_builder.assemble" ||
    plan.taskId === "site_builder.assembly_fix"
  ) {
    const canonicalFixture = CONTROLLED_ASSEMBLY_EVAL_FIXTURES.find(
      (entry) => entry.fixtureId === fixtureId && entry.taskId === plan.taskId,
    );
    if (!canonicalFixture) {
      throw new Error(`model evaluation fixture is not canonical: ${fixtureId}`);
    }
    fixture = canonicalFixture;
    const prepared = prepareControlledAssemblyEvalFixture(canonicalFixture);
    taskInput = prepared.input;
    prompt =
      plan.taskId === "site_builder.assemble"
        ? BUILD_ASSEMBLE_PROMPT(prepared.input)
        : BUILD_ASSEMBLY_FIX_PROMPT(prepared.input);
  } else if (
    plan.taskId === "site_builder.qa_summarize" ||
    plan.taskId === "site_builder.seo_review"
  ) {
    const canonicalFixture = QUALITY_NARRATIVE_EVAL_FIXTURES.find(
      (entry) => entry.fixtureId === fixtureId && entry.taskId === plan.taskId,
    );
    if (!canonicalFixture) {
      throw new Error(
        `model evaluation fixture is not canonical: ${fixtureId}`,
      );
    }
    fixture = canonicalFixture;
    const prepared = prepareQualityNarrativeEvalFixture(canonicalFixture);
    taskInput = prepared.input;
    prompt =
      plan.taskId === "site_builder.qa_summarize"
        ? BUILD_QA_SUMMARIZE_PROMPT(prepared.input)
        : BUILD_SEO_REVIEW_PROMPT(prepared.input);
  } else {
    throw new Error(`task evaluation has no canonical suite: ${plan.taskId}`);
  }
  const sourceFiles = currentSourceBundle(suite);
  const payload = deepFreeze({
    fixture,
    taskInput,
    prompt,
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
    compiledContractsArtifactTreeSha256:
      suite.compiledContractsRuntimeBinding?.compiledArtifactTreeSha256 ?? null,
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
    compiledContractsArtifactTreeSha256:
      contract.compiledContractsArtifactTreeSha256,
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
    compiledContractsArtifactTreeSha256:
      suite.compiledContractsRuntimeBinding?.compiledArtifactTreeSha256 ?? null,
  };
  if (JSON.stringify(fixedContract) !== JSON.stringify(expected)) {
    throw new Error("model evaluation case contract is not canonical");
  }
  const fixture = suite.fixtureFingerprints.find(
    (entry) => entry.fixtureId === contract.fixtureId,
  );
  const currentSources = currentSourceBundle(suite);
  let preparedFixture:
    | BrandProfileEvalFixture
    | DesignSpecEvalFixture
    | CopyAssemblyEvalFixture
    | ControlledAssemblyEvalFixture
    | QualityNarrativeEvalFixture;
  let preparedInput:
    | BrandProfileInput
    | DesignSpecTaskInput
    | CopyTaskInput
    | ControlledAssemblyTaskInput
    | QualityNarrativeTaskInputV1;
  let expectedPrompt: string;
  if (plan.taskId === "site_builder.brand_profile") {
    const prepared = prepareBrandProfileEvalFixture(
      payload.fixture as BrandProfileEvalFixture,
    );
    preparedFixture = prepared.fixture;
    preparedInput = prepared.input;
    expectedPrompt = BUILD_BRAND_PROFILE_PROMPT(prepared.input);
  } else if (plan.taskId === "site_builder.design_spec") {
    const prepared = prepareDesignSpecEvalFixture(
      payload.fixture as DesignSpecEvalFixture,
    );
    preparedFixture = prepared.fixture;
    preparedInput = prepared.input;
    expectedPrompt = BUILD_DESIGN_SPEC_PROMPT(prepared.input);
  } else if (plan.taskId === "site_builder.copy") {
    const prepared = prepareCopyAssemblyEvalFixture(
      payload.fixture as CopyAssemblyEvalFixture,
    );
    preparedFixture = prepared.fixture;
    preparedInput = prepared.input;
    expectedPrompt = BUILD_COPY_PROMPT(prepared.input);
  } else if (
    plan.taskId === "site_builder.assemble" ||
    plan.taskId === "site_builder.assembly_fix"
  ) {
    const prepared = prepareControlledAssemblyEvalFixture(
      payload.fixture as ControlledAssemblyEvalFixture,
    );
    if (prepared.fixture.taskId !== plan.taskId) {
      throw new Error(
        `task evaluation fixture is not canonical: ${plan.taskId}`,
      );
    }
    preparedFixture = prepared.fixture;
    preparedInput = prepared.input;
    expectedPrompt =
      plan.taskId === "site_builder.assemble"
        ? BUILD_ASSEMBLE_PROMPT(prepared.input)
        : BUILD_ASSEMBLY_FIX_PROMPT(prepared.input);
  } else if (
    plan.taskId === "site_builder.qa_summarize" ||
    plan.taskId === "site_builder.seo_review"
  ) {
    const prepared = prepareQualityNarrativeEvalFixture(
      payload.fixture as QualityNarrativeEvalFixture,
    );
    if (prepared.fixture.taskId !== plan.taskId) {
      throw new Error(
        `task evaluation fixture is not canonical: ${plan.taskId}`,
      );
    }
    preparedFixture = prepared.fixture;
    preparedInput = prepared.input;
    expectedPrompt =
      plan.taskId === "site_builder.qa_summarize"
        ? BUILD_QA_SUMMARIZE_PROMPT(prepared.input)
        : BUILD_SEO_REVIEW_PROMPT(prepared.input);
  } else {
    throw new Error(`task evaluation has no canonical suite: ${plan.taskId}`);
  }
  if (
    !fixture ||
    contract.fixtureSha256 !== fixture.fixtureSha256 ||
    contract.promptSha256 !== fixture.promptSha256 ||
    contract.fixtureSha256 !== sha256CanonicalJson(payload.fixture) ||
    contract.promptSha256 !== sha256Text(payload.prompt) ||
    contract.sourceBundleSha256 !== sha256CanonicalJson(payload.sourceFiles) ||
    sha256CanonicalJson(payload.fixture) !==
      sha256CanonicalJson(preparedFixture) ||
    sha256CanonicalJson(payload.taskInput) !==
      sha256CanonicalJson(preparedInput) ||
    payload.prompt !== expectedPrompt ||
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
  costSafety: ModelEvaluationCostSafetyAttestation,
): Pick<
  ModelEvaluationRun,
  | "schemaVersion"
  | "harnessId"
  | "candidateBaselineId"
  | "costSafetyContractId"
  | "costSafetyAttestationSha256"
  | "credentialSnapshotSha256"
  | "pricingSnapshotSha256"
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
  | "compiledContractsArtifactTreeSha256"
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
    ...costSafetyProvenance(costSafety),
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
    compiledContractsArtifactTreeSha256:
      caseContract.compiledContractsArtifactTreeSha256,
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
    Number.isSafeInteger(usage.inputTokens) &&
    (usage.inputTokens as number) >= 0 &&
    Number.isSafeInteger(usage.outputTokens) &&
    (usage.outputTokens as number) >= 0 &&
    Number.isSafeInteger(usage.callCount) &&
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

export function assessCanonicalTaskArtifact(
  plan: TaskEvaluationPlan,
  payload: ModelEvaluationCasePayload,
  artifact: unknown,
): TaskArtifactAssessment {
  if (plan.taskId === "site_builder.brand_profile") {
    if (
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
    const taskInput = payload.taskInput as BrandProfileInput;
    const fixture = payload.fixture as BrandProfileEvalFixture;
    VALIDATE_BRAND_PROFILE_OUTPUT(taskInput, output);
    const prepared = prepareBrandProfileEvalFixture(fixture);
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
  if (plan.taskId === "site_builder.design_spec") {
    if (
      plan.evaluationSuite?.evaluatorVersion !==
        DESIGN_SPEC_EVALUATOR_VERSION ||
      plan.evaluationSuite.outputSchemaSha256 !==
        sha256CanonicalJson(DESIGN_SPEC_OUTPUT_SCHEMA_SNAPSHOT)
    ) {
      throw new Error(`task evaluator is not canonical: ${plan.taskId}`);
    }
    assertModelOutputSchemaCompiles(DESIGN_SPEC_OUTPUT_SCHEMA_SNAPSHOT);
    const outputCheck = checkAgainstSchema(
      DESIGN_SPEC_OUTPUT_SCHEMA_SNAPSHOT,
      artifact,
    );
    if (!outputCheck.valid) {
      throw new Error(
        "task artifact does not satisfy the canonical output schema",
      );
    }
    const output = artifact as DesignSpecTaskOutput;
    const taskInput = payload.taskInput as DesignSpecTaskInput;
    VALIDATE_DESIGN_SPEC_OUTPUT(taskInput, output);
    const prepared = prepareDesignSpecEvalFixture(
      payload.fixture as DesignSpecEvalFixture,
    );
    const outcome = evaluateDesignSpecOutput(prepared, output);
    const factualityPassed =
      outcome.referencedForbiddenCatalogIdentifiers.length === 0 &&
      outcome.contradictedMetricClaims.length === 0 &&
      outcome.invalidExplanationClaims.length === 0;
    return {
      qualityPassed: outcome.selectedDeterministicCandidate && factualityPassed,
      structurePassed: true,
      factualityPassed,
      stabilityKey: sha256CanonicalJson(output),
      findingCodes: [
        ...(!outcome.selectedDeterministicCandidate
          ? ["deterministic_catalog_baseline_mismatch"]
          : []),
        ...(outcome.referencedForbiddenCatalogIdentifiers.length > 0
          ? ["forbidden_catalog_identifier"]
          : []),
        ...(outcome.contradictedMetricClaims.length > 0
          ? ["frozen_candidate_metric_contradiction"]
          : []),
        ...(outcome.invalidExplanationClaims.length > 0
          ? ["invalid_explanation_claim"]
          : []),
      ],
    };
  }
  if (plan.taskId === "site_builder.copy") {
    if (
      plan.evaluationSuite?.evaluatorVersion !==
        COPY_ASSEMBLY_EVALUATOR_VERSION ||
      plan.evaluationSuite.outputSchemaSha256 !==
        sha256CanonicalJson(COPY_OUTPUT_SCHEMA_SNAPSHOT) ||
      plan.evaluationSuite.systemPromptSha256 !== COPY_SYSTEM_PROMPT_SHA256 ||
      plan.evaluationSuite.evaluatorRubricSha256 !==
        sha256CanonicalJson(COPY_ASSEMBLY_EVALUATOR_RUBRIC)
    ) {
      throw new Error(`task evaluator is not canonical: ${plan.taskId}`);
    }
    assertModelOutputSchemaCompiles(COPY_OUTPUT_SCHEMA_SNAPSHOT);
    const outputCheck = checkAgainstSchema(COPY_OUTPUT_SCHEMA_SNAPSHOT, artifact);
    if (!outputCheck.valid) {
      throw new Error(
        "task artifact does not satisfy the canonical output schema",
      );
    }
    const output = artifact as CopyTaskOutput;
    const taskInput = payload.taskInput as CopyTaskInput;
    VALIDATE_COPY_OUTPUT(taskInput, output);
    const prepared = prepareCopyAssemblyEvalFixture(
      payload.fixture as CopyAssemblyEvalFixture,
    );
    if (
      sha256CanonicalJson(prepared.input) !== sha256CanonicalJson(taskInput)
    ) {
      throw new Error(
        `task evaluation fixture is not canonical: ${plan.taskId}`,
      );
    }
    const outcome = evaluateCopyAssemblyOutput(prepared, output);
    return {
      qualityPassed: outcome.exactCanonicalOutput,
      structurePassed: outcome.productionValidationPassed,
      factualityPassed: outcome.factualSlotContentMatches,
      stabilityKey: sha256CanonicalJson(output),
      findingCodes: [
        ...(outcome.exactCanonicalOutput
          ? []
          : ["canonical_copy_bundle_mismatch"]),
        ...outcome.rejectedSlotKeys.map(
          (slotKey) => `factual_claim_text_mismatch:${slotKey}`,
        ),
      ],
    };
  }
  if (
    plan.taskId === "site_builder.assemble" ||
    plan.taskId === "site_builder.assembly_fix"
  ) {
    const isAssemble = plan.taskId === "site_builder.assemble";
    const outputSchema = isAssemble
      ? ASSEMBLE_OUTPUT_SCHEMA_SNAPSHOT
      : ASSEMBLY_FIX_OUTPUT_SCHEMA_SNAPSHOT;
    const expectedSystemPromptSha256 = isAssemble
      ? ASSEMBLE_SYSTEM_PROMPT_SHA256
      : ASSEMBLY_FIX_SYSTEM_PROMPT_SHA256;
    if (
      plan.evaluationSuite?.evaluatorVersion !==
        CONTROLLED_ASSEMBLY_EVALUATOR_VERSION ||
      plan.evaluationSuite.outputSchemaSha256 !==
        sha256CanonicalJson(outputSchema) ||
      plan.evaluationSuite.systemPromptSha256 !== expectedSystemPromptSha256 ||
      plan.evaluationSuite.evaluatorRubricSha256 !==
        sha256CanonicalJson(CONTROLLED_ASSEMBLY_EVALUATOR_RUBRIC)
    ) {
      throw new Error(`task evaluator is not canonical: ${plan.taskId}`);
    }
    assertModelOutputSchemaCompiles(outputSchema);
    const outputCheck = checkAgainstSchema(outputSchema, artifact);
    if (!outputCheck.valid) {
      throw new Error(
        "task artifact does not satisfy the canonical output schema",
      );
    }
    const output = artifact as Parameters<
      typeof evaluateControlledAssemblyOutput
    >[1];
    const taskInput = payload.taskInput as ControlledAssemblyTaskInput;
    const fixture = payload.fixture as ControlledAssemblyEvalFixture;
    const validateOutput = isAssemble
      ? VALIDATE_ASSEMBLE_OUTPUT
      : VALIDATE_ASSEMBLY_FIX_OUTPUT;
    validateOutput(taskInput, output);
    const prepared = prepareControlledAssemblyEvalFixture(fixture);
    if (
      prepared.fixture.taskId !== plan.taskId ||
      sha256CanonicalJson(prepared.input) !== sha256CanonicalJson(taskInput)
    ) {
      throw new Error(
        `task evaluation fixture is not canonical: ${plan.taskId}`,
      );
    }
    const outcome = evaluateControlledAssemblyOutput(prepared, output);
    return {
      qualityPassed: outcome.semanticAssemblyPassed,
      structurePassed: outcome.productionValidationPassed,
      factualityPassed: outcome.semanticAssemblyPassed,
      stabilityKey: outcome.specDigest,
      findingCodes: outcome.semanticAssemblyPassed
        ? []
        : [
            "controlled_assembly_validation_failed",
            ...(outcome.explicitSelectionPassed
              ? []
              : ["controlled_assembly_selection_mismatch"]),
          ],
    };
  }
  if (
    plan.taskId === "site_builder.qa_summarize" ||
    plan.taskId === "site_builder.seo_review"
  ) {
    const isQa = plan.taskId === "site_builder.qa_summarize";
    const outputSchema = isQa
      ? QA_SUMMARIZE_OUTPUT_SCHEMA_SNAPSHOT
      : SEO_REVIEW_OUTPUT_SCHEMA_SNAPSHOT;
    const expectedSystemPromptSha256 = isQa
      ? QA_SUMMARIZE_SYSTEM_PROMPT_SHA256
      : SEO_REVIEW_SYSTEM_PROMPT_SHA256;
    if (
      plan.evaluationSuite?.evaluatorVersion !==
        QUALITY_NARRATIVE_EVALUATOR_VERSION ||
      plan.evaluationSuite.outputSchemaSha256 !==
        sha256CanonicalJson(outputSchema) ||
      plan.evaluationSuite.systemPromptSha256 !== expectedSystemPromptSha256 ||
      plan.evaluationSuite.evaluatorRubricSha256 !==
        sha256CanonicalJson(QUALITY_NARRATIVE_EVALUATOR_RUBRIC)
    ) {
      throw new Error(`task evaluator is not canonical: ${plan.taskId}`);
    }
    assertModelOutputSchemaCompiles(outputSchema);
    const outputCheck = checkAgainstSchema(outputSchema, artifact);
    if (!outputCheck.valid) {
      throw new Error(
        "task artifact does not satisfy the canonical output schema",
      );
    }
    const output = artifact as QualityNarrativeTaskOutputV1;
    const taskInput = payload.taskInput as QualityNarrativeTaskInputV1;
    const fixture = payload.fixture as QualityNarrativeEvalFixture;
    const validateOutput = isQa
      ? VALIDATE_QA_SUMMARIZE_OUTPUT
      : VALIDATE_SEO_REVIEW_OUTPUT;
    validateOutput(taskInput, output);
    const prepared = prepareQualityNarrativeEvalFixture(fixture);
    if (
      prepared.fixture.taskId !== plan.taskId ||
      sha256CanonicalJson(prepared.input) !== sha256CanonicalJson(taskInput)
    ) {
      throw new Error(
        `task evaluation fixture is not canonical: ${plan.taskId}`,
      );
    }
    const outcome = evaluateQualityNarrativeOutput(prepared, output);
    return {
      qualityPassed: outcome.exactDeterministicOutput,
      structurePassed: true,
      factualityPassed: outcome.exactDeterministicOutput,
      stabilityKey: sha256CanonicalJson(output),
      findingCodes: [
        ...(outcome.exactDeterministicOutput
          ? []
          : ["deterministic_quality_narrative_mismatch"]),
        ...outcome.rejectedFindingIds,
      ],
    };
  }
  throw new Error(`task evaluator is not canonical: ${plan.taskId}`);
}

export async function runLegacyComparatorEvaluationAttempt<T>(options: {
  plan: TaskEvaluationPlan;
  alias: string;
  fixtureId: string;
  attempt: number;
  campaignBudget: ModelEvaluationBudgetGuard;
  executeLegacyComparator: (
    request: ModelEvaluationExecutionRequest,
  ) => Promise<ModelEvaluationCallResult<T>>;
}): Promise<ModelEvaluationCallResult<T>> {
  if (
    ["minimax-m3", "doubao-seed-2.0-pro", "doubao-seed-2.0-lite"].includes(
      options.alias,
    )
  ) {
    throw new ModelEvaluationCallError("legacy_comparator_not_admitted", {
      state: "not_incurred",
      reason: "rejected_before_dispatch",
    });
  }
  if (
    !isTrustedModelEvaluationProtocolExecute(options.executeLegacyComparator)
  ) {
    throw new ModelEvaluationCallError("untrusted_evaluation_executor", {
      state: "not_incurred",
      reason: "rejected_before_dispatch",
    });
  }
  const firstCandidate = options.plan.candidates[0];
  if (!firstCandidate) {
    throw new Error(
      `task evaluation has no canonical candidate plan: ${options.plan.taskId}`,
    );
  }
  assertCandidateBelongsToPlan(options.plan, firstCandidate);
  assertTrustedModelEvaluationBudget(options.campaignBudget);
  if (
    options.plan.dispatchAdmission !== "task_evaluation_ready" ||
    !options.plan.evaluationSuite
  ) {
    throw new Error(
      `legacy comparator has no canonical suite: ${options.plan.taskId}`,
    );
  }
  if (
    !options.plan.evaluationSuite.legacyComparatorAliases.includes(
      options.alias,
    )
  ) {
    throw new ModelEvaluationCallError("legacy_comparator_not_admitted", {
      state: "not_incurred",
      reason: "rejected_before_dispatch",
    });
  }
  if (
    !Number.isInteger(options.attempt) ||
    options.attempt < 1 ||
    options.attempt > options.plan.evaluationSuite.repeats
  ) {
    throw new Error(
      `legacy comparator attempt must be within 1..${options.plan.evaluationSuite.repeats}`,
    );
  }
  const evaluationCase = buildCanonicalModelEvaluationCase(
    options.plan,
    options.fixtureId,
  );
  bindTrustedModelEvaluationExecutor(
    options.campaignBudget,
    options.executeLegacyComparator,
    options.plan,
  );
  const campaignId = trustedModelEvaluationCampaignId(options.campaignBudget);
  const callId = [
    "legacy-comparator",
    options.plan.taskId,
    options.alias,
    evaluationCase.contract.fixtureId,
    options.attempt,
  ].join(":");
  const executionId = ["model-evaluation-attempt", campaignId, callId].join(
    ":",
  );
  const reservation = reserveTrustedModelEvaluationBudget(
    options.campaignBudget,
    callId,
    options.plan.envelope.perCallCostCapCents,
    maximumExecutionCallCount(options.plan.evaluationSuite.repairTaskOutput),
  );
  if (!reservation.allowed) {
    throw new ModelEvaluationCallError(reservation.reason, {
      state: "not_incurred",
      reason: "rejected_before_dispatch",
    });
  }

  const controller = new AbortController();
  const request: ModelEvaluationExecutionRequest = Object.freeze({
    executionId,
    taskId: options.plan.taskId,
    profile: options.plan.profile,
    alias: options.alias,
    expectedProtocol: "openai-chat-completions",
    fixtureId: evaluationCase.contract.fixtureId,
    attempt: options.attempt,
    maxTokens: options.plan.envelope.maxTokens,
    runtimeDeadlineMs: options.plan.envelope.runtimeDeadlineMs,
    hardStopMs: options.plan.envelope.hardStopMs,
    perCallCostCapCents: options.plan.envelope.perCallCostCapCents,
    reasoningEffort: options.plan.envelope.reasoningEffort,
    outputSchema: canonicalTaskOutputSchema(options.plan.taskId),
    repairTaskOutput: options.plan.evaluationSuite.repairTaskOutput,
    caseContract: evaluationCase.contract,
    casePayload: evaluationCase.payload,
    signal: controller.signal,
  });
  authorizeModelEvaluationExecutionRequest(request);
  const trustedStartedAt = readMonotonicNow(TRUSTED_MONOTONIC_NOW);
  if (trustedStartedAt === null) {
    settleTrustedModelEvaluationBudget(options.campaignBudget, callId, null);
    throw new ModelEvaluationCallError("model_evaluation_clock_invalid", {
      state: "unknown",
      reason: "invalid_settlement",
    });
  }
  type ComparatorOutcome =
    | { kind: "completed"; value: ModelEvaluationCallResult<T> }
    | { kind: "failed"; error: unknown }
    | { kind: "hard_stop" };
  let timer: NodeJS.Timeout | undefined;
  const execution = Promise.resolve()
    .then(() => options.executeLegacyComparator(request))
    .then<ComparatorOutcome, ComparatorOutcome>(
      (value) => ({ kind: "completed", value }),
      (error: unknown) => ({ kind: "failed", error }),
    );
  const hardStop = new Promise<ComparatorOutcome>((resolve) => {
    timer = setTimeout(
      () => resolve({ kind: "hard_stop" }),
      options.plan.envelope.hardStopMs,
    );
  });
  let outcome = await Promise.race([execution, hardStop]);
  if (timer) clearTimeout(timer);
  const trustedElapsedMs = readMonotonicElapsed(
    TRUSTED_MONOTONIC_NOW,
    trustedStartedAt,
  );
  if (
    outcome.kind !== "hard_stop" &&
    (trustedElapsedMs === null ||
      trustedElapsedMs >= options.plan.envelope.hardStopMs)
  ) {
    outcome = { kind: "hard_stop" };
  }
  if (outcome.kind === "hard_stop") {
    controller.abort(
      new Error("legacy comparator diagnostic window exhausted"),
    );
    await freezeModelEvaluationProtocolExecutor(
      options.executeLegacyComparator,
    );
    settleTrustedModelEvaluationBudget(options.campaignBudget, callId, {
      state: "unknown",
      reason: "diagnostic_hard_stop",
    });
    throw new ModelEvaluationCallError("diagnostic_window_exhausted", {
      state: "unknown",
      reason: "diagnostic_hard_stop",
    });
  }
  if (outcome.kind === "failed") {
    const settlement =
      outcome.error instanceof ModelEvaluationCallError
        ? outcome.error.costSettlement
        : ({ state: "unknown", reason: "invalid_settlement" } as const);
    settleTrustedModelEvaluationBudget(
      options.campaignBudget,
      callId,
      settlement,
    );
    throw outcome.error;
  }
  settleTrustedModelEvaluationBudget(
    options.campaignBudget,
    callId,
    outcome.value.costSettlement,
  );
  return outcome.value;
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
  if (!isTrustedModelEvaluationProtocolExecute(options.execute)) {
    throw new ModelEvaluationCallError("untrusted_evaluation_executor", {
      state: "not_incurred",
      reason: "rejected_before_dispatch",
    });
  }
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
  assertCompiledContractsRuntimeBeforeDispatch(options.plan.evaluationSuite);
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
  const costSafety = bindTrustedModelEvaluationExecutor(
    options.campaignBudget,
    options.execute,
    options.plan,
  );
  const now = options.now ?? (() => performance.now());
  const startedAt = readMonotonicNow(now);
  const trustedStartedAt = readMonotonicNow(TRUSTED_MONOTONIC_NOW);
  if (startedAt === null || trustedStartedAt === null) {
    throw new Error("model evaluation monotonic clock is invalid");
  }
  const campaignId = trustedModelEvaluationCampaignId(options.campaignBudget);
  const identity = runIdentity(
    options.plan,
    options.candidate,
    evaluationCase.contract,
    options.attempt,
    campaignId,
    capabilityProbeAttestation,
    costSafety,
  );
  const bindRun = (run: ModelEvaluationRun): ModelEvaluationRun =>
    bindTrustedModelEvaluationRun(options.campaignBudget, run);
  const callId = [
    options.plan.taskId,
    options.candidate.alias,
    evaluationCase.contract.fixtureId,
    options.attempt,
  ].join(":");
  const executionId = ["model-evaluation-attempt", campaignId, callId].join(
    ":",
  );
  const reservation = reserveTrustedModelEvaluationBudget(
    options.campaignBudget,
    callId,
    options.plan.envelope.perCallCostCapCents,
    maximumExecutionCallCount(options.plan.evaluationSuite.repairTaskOutput),
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
  const request: ModelEvaluationExecutionRequest = Object.freeze({
    executionId,
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
    outputSchema: canonicalTaskOutputSchema(options.plan.taskId),
    repairTaskOutput: options.plan.evaluationSuite.repairTaskOutput,
    caseContract: evaluationCase.contract,
    casePayload: evaluationCase.payload,
    signal: controller.signal,
  });
  authorizeModelEvaluationExecutionRequest(request);

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
    await freezeModelEvaluationProtocolExecutor(options.execute);
    const settled = settleTrustedModelEvaluationBudget(
      options.campaignBudget,
      callId,
      {
        state: "unknown",
        reason: "diagnostic_hard_stop",
      },
    );
    const reportedElapsedMs = readMonotonicElapsed(now, startedAt);
    const trustedElapsedMs = readMonotonicElapsed(
      TRUSTED_MONOTONIC_NOW,
      trustedStartedAt,
    );
    const observedElapsedMs =
      trustedElapsedMs === null
        ? null
        : Math.max(reportedElapsedMs ?? 0, trustedElapsedMs);
    const elapsedMs = Math.max(
      observedElapsedMs ?? 0,
      options.plan.envelope.hardStopMs,
    );
    const elapsedIsValid = trustedElapsedMs !== null;
    return bindRun({
      ...identity,
      resultClass: elapsedIsValid
        ? "diagnostic_window_exhausted"
        : "capability_unavailable",
      runtimeTiming: elapsedIsValid ? "diagnostic_exhausted" : "not_started",
      elapsedMs: elapsedIsValid ? elapsedMs : 0,
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

  const reportedElapsedMs = readMonotonicElapsed(now, startedAt);
  const trustedElapsedMs = readMonotonicElapsed(
    TRUSTED_MONOTONIC_NOW,
    trustedStartedAt,
  );
  const observedElapsedMs =
    trustedElapsedMs === null
      ? null
      : Math.max(reportedElapsedMs ?? 0, trustedElapsedMs);
  const elapsedIsValid = observedElapsedMs !== null;
  const elapsedMs = observedElapsedMs ?? 0;
  if (
    trustedElapsedMs === null ||
    (elapsedIsValid && elapsedMs >= options.plan.envelope.hardStopMs)
  ) {
    controller.abort(new Error("model evaluation completed after hard stop"));
    await freezeModelEvaluationProtocolExecutor(options.execute);
    const settled = settleTrustedModelEvaluationBudget(
      options.campaignBudget,
      callId,
      {
        state: "unknown",
        reason: "diagnostic_hard_stop",
      },
    );
    return bindRun({
      ...identity,
      resultClass:
        trustedElapsedMs === null
          ? "capability_unavailable"
          : "diagnostic_window_exhausted",
      runtimeTiming:
        trustedElapsedMs === null ? "not_started" : "diagnostic_exhausted",
      elapsedMs,
      protocolVerified: false,
      identityVerified: false,
      artifactAccepted: false,
      assessment: null,
      costSettlement: settled.settlement,
      budgetCapExceeded: settled.capExceeded,
      settlementInvalid: settled.settlementInvalid,
      usage: null,
      failureCode:
        trustedElapsedMs === null
          ? "monotonic_clock_invalid"
          : "completed_after_hard_stop",
    });
  }
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
  const compiledContractsRuntimeStable = compiledContractsRuntimeMatchesSuite(
    options.plan.evaluationSuite,
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
    !compiledContractsRuntimeStable ||
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
          : !compiledContractsRuntimeStable
            ? "compiled_contracts_runtime_changed_during_dispatch"
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
      assessment = assessCanonicalTaskArtifact(
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
  costSafetyContractId: typeof SITE_BUILDER_MODEL_EVALUATION_COST_SAFETY_ID;
  costSafetyAttestationSha256: string | null;
  credentialSnapshotSha256: string | null;
  pricingSnapshotSha256: string | null;
  campaignId: string;
  taskId: SiteBuilderTaskId;
  profile: SiteBuilderModelProfileId;
  evaluationSuiteId: string;
  taskContractFingerprint: string;
  sourceBundleContractId: string;
  sourceBundleSha256: string | null;
  compiledContractsArtifactTreeSha256: string | null;
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
    run.costSettlement.amountCents >
      plan.envelope.perCallCostCapCents *
        maximumExecutionCallCount(suite.repairTaskOutput);
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
    run.costSafetyContractId !== SITE_BUILDER_MODEL_EVALUATION_COST_SAFETY_ID ||
    !SHA256.test(run.costSafetyAttestationSha256) ||
    !SHA256.test(run.credentialSnapshotSha256) ||
    !SHA256.test(run.pricingSnapshotSha256) ||
    (run.capabilityProbeAttestation !== null &&
      (run.capabilityProbeAttestation.costSafetyAttestationSha256 !==
        run.costSafetyAttestationSha256 ||
        run.capabilityProbeAttestation.credentialSnapshotSha256 !==
          run.credentialSnapshotSha256 ||
        run.capabilityProbeAttestation.pricingSnapshotSha256 !==
          run.pricingSnapshotSha256)) ||
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
    run.compiledContractsArtifactTreeSha256 !==
      evaluationCase.contract.compiledContractsArtifactTreeSha256 ||
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
      canonicalAssessment = assessCanonicalTaskArtifact(
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
  const costSafetyAttestationSha256 =
    runs[0]?.costSafetyAttestationSha256 ?? null;
  const credentialSnapshotSha256 = runs[0]?.credentialSnapshotSha256 ?? null;
  const pricingSnapshotSha256 = runs[0]?.pricingSnapshotSha256 ?? null;
  if (
    runs.some(
      (run) =>
        run.costSafetyAttestationSha256 !== costSafetyAttestationSha256 ||
        run.credentialSnapshotSha256 !== credentialSnapshotSha256 ||
        run.pricingSnapshotSha256 !== pricingSnapshotSha256,
    ) ||
    (trustedProbeAttestation !== null &&
      (trustedProbeAttestation.costSafetyAttestationSha256 !==
        costSafetyAttestationSha256 ||
        trustedProbeAttestation.credentialSnapshotSha256 !==
          credentialSnapshotSha256 ||
        trustedProbeAttestation.pricingSnapshotSha256 !==
          pricingSnapshotSha256))
  ) {
    throw new Error("candidate summary contains cost safety provenance drift");
  }
  const hardFailureClasses = new Set<ModelEvaluationResultClass>([
    "content_invalid",
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
    costSafetyContractId: SITE_BUILDER_MODEL_EVALUATION_COST_SAFETY_ID,
    costSafetyAttestationSha256,
    credentialSnapshotSha256,
    pricingSnapshotSha256,
    campaignId: trustedModelEvaluationCampaignId(campaignBudget),
    taskId: plan.taskId,
    profile: plan.profile,
    evaluationSuiteId: suite.suiteId,
    taskContractFingerprint,
    sourceBundleContractId: suite.sourceBundleContractId,
    sourceBundleSha256: runs[0]?.sourceBundleSha256 ?? null,
    compiledContractsArtifactTreeSha256:
      suite.compiledContractsRuntimeBinding?.compiledArtifactTreeSha256 ?? null,
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
        summary.compiledContractsArtifactTreeSha256 !==
          first.compiledContractsArtifactTreeSha256 ||
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
