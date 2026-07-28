import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import { modelPolicyRegistry } from "../agents/model-policy.registry";
import type { ModelCandidateProtocol } from "../agents/model-candidate-baseline";
import {
  SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID,
  buildCanonicalModelEvaluationCase,
  buildTaskEvaluationPlan,
} from "./model-evaluation-harness";
import {
  MODEL_EVALUATION_PROTOCOL_FRAMING_TOKEN_UPPER_BOUND,
  SITE_BUILDER_MODEL_EVALUATION_COST_SAFETY_ID,
  assertModelEvaluationCostSafetyDispatch,
  frozenModelEvaluationPriceCents,
  isTrustedModelEvaluationCostSafetyAttestation,
  type ModelEvaluationCostSafetyAttestation,
  type ModelEvaluationDispatchMode,
} from "./model-evaluation-cost-safety";
import { sha256CanonicalJson } from "./eval-provenance";

export const SITE_BUILDER_MODEL_EVALUATION_EVIDENCE_PREP_ID =
  "site-builder-model-evaluation-evidence-prep/2026-07-29-v1" as const;
export const MODEL_EVALUATION_EVIDENCE_PREP_SCHEMA_VERSION =
  "site-builder-model-evaluation-evidence-prep/v1" as const;
export const MODEL_EVALUATION_EVIDENCE_DECISION_CARD_SCHEMA_VERSION =
  "site-builder-model-evaluation-cost-decision-card/v1" as const;

export const MODEL_EVALUATION_UNVERIFIED_PLANNING_UPPER_BOUND = Object.freeze({
  executions: 61,
  wireCalls: 122,
  amountCents: 2_440,
  verification: "unverified_planning_upper_bound",
} as const);

export const MODEL_EVALUATION_EVIDENCE_STOP_CONDITIONS = Object.freeze([
  "fixed_commit_or_source_bundle_drift",
  "credential_scope_or_fingerprint_drift",
  "quota_or_balance_below_frozen_campaign_cap",
  "pricing_snapshot_or_billing_unit_drift",
  "authorization_or_create_only_ledger_mismatch",
  "execution_or_wire_call_manifest_exhausted",
  "production_deadline_or_hard_stop",
  "protocol_or_model_identity_mismatch",
  "missing_usage_artifact_digest_or_verified_settlement",
  "unknown_or_over_budget_settlement",
  "capability_probe_rejected",
] as const);

export interface ModelEvaluationEvidenceWireCallPlan {
  wireCallOrdinal: 1 | 2;
  purpose: "initial" | "schema_repair_if_required";
}

export interface ModelEvaluationEvidenceExecutionPlan {
  ordinal: number;
  executionKey: string;
  kind: "capability_probe" | "target" | "legacy_comparator";
  mode: ModelEvaluationDispatchMode;
  alias: string;
  protocol: ModelCandidateProtocol;
  fixtureId: string;
  attempt: number;
  maximumWireCalls: 2;
  wireCalls: readonly ModelEvaluationEvidenceWireCallPlan[];
}

export interface ModelEvaluationEvidencePlanningManifest {
  prepId: typeof SITE_BUILDER_MODEL_EVALUATION_EVIDENCE_PREP_ID;
  harnessId: typeof SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID;
  taskId: "site_builder.brand_profile";
  suiteId: string;
  sourceBundleContractId: string;
  sourceBundleSha256: string;
  sourceFiles: readonly {
    role: string;
    path: string;
    sha256: string;
  }[];
  repair: {
    taskOutputRepairEnabled: true;
    maximumWireCallsPerExecution: 2;
    maximumRepairCallsPerExecution: 1;
  };
  executions: readonly ModelEvaluationEvidenceExecutionPlan[];
  executionCount: 61;
  maximumWireCallCount: 122;
  stopConditions: typeof MODEL_EVALUATION_EVIDENCE_STOP_CONDITIONS;
  unverifiedPlanningUpperBound: typeof MODEL_EVALUATION_UNVERIFIED_PLANNING_UPPER_BOUND;
}

export interface ModelEvaluationEvidencePrepBundle {
  schemaVersion: typeof MODEL_EVALUATION_EVIDENCE_PREP_SCHEMA_VERSION;
  prepId: typeof SITE_BUILDER_MODEL_EVALUATION_EVIDENCE_PREP_ID;
  fixedCommitSha: string;
  createOnly: true;
  dispatchAuthorization: "NOT_AUTHORIZED";
  planningManifest: ModelEvaluationEvidencePlanningManifest;
  credentialEvidence: {
    attestationId: string;
    credentialSnapshotSha256: string;
    bearerTokenSha256: string;
    observedAt: string;
    balanceSampledAt: string;
    gatewayOrigin: string;
    purpose: "site_builder_model_evaluation";
    quotaMode: "limited";
    scopeExact: true;
    quotaCapCents: number;
    remainingQuotaCents: number;
    allowedDispatches: readonly {
      mode: ModelEvaluationDispatchMode;
      alias: string;
      protocol: ModelCandidateProtocol;
    }[];
  };
  pricingEvidence: {
    snapshotId: string;
    snapshotSha256: string;
    basis: "frozen_unit_price_snapshot";
    resolverId: string;
    billingUnit: "cents_per_million_tokens";
    entries: readonly {
      alias: string;
      protocol: ModelCandidateProtocol;
      inputCentsPerMillionTokens: number;
      outputCentsPerMillionTokens: number;
    }[];
  };
  decisionCard: {
    schemaVersion: typeof MODEL_EVALUATION_EVIDENCE_DECISION_CARD_SCHEMA_VERSION;
    status: "READY_FOR_PRODUCT_DECISION";
    dispatchAuthorization: "NOT_AUTHORIZED";
    fixedCommitSha: string;
    executionCount: 61;
    maximumWireCallCount: 122;
    frozenPricedMaximumCents: number;
    approvedCampaignBudgetCents: number;
    remainingQuotaCents: number;
    unverifiedPlanningUpperBound: typeof MODEL_EVALUATION_UNVERIFIED_PLANNING_UPPER_BOUND;
    pricingSnapshotSha256: string;
    credentialSnapshotSha256: string;
    manifestSha256: string;
  };
  bundleSha256: string;
}

const SHA1 = /^[a-f0-9]{40}$/;
const MAXIMUM_WIRE_CALLS_PER_EXECUTION = 2 as const;
const TRUSTED_EVIDENCE_PREP_BUNDLES = new WeakSet<object>();
const WIRE_CALLS = Object.freeze([
  Object.freeze({ wireCallOrdinal: 1, purpose: "initial" }),
  Object.freeze({
    wireCallOrdinal: 2,
    purpose: "schema_repair_if_required",
  }),
] as readonly ModelEvaluationEvidenceWireCallPlan[]);

function executionKey(input: {
  kind: ModelEvaluationEvidenceExecutionPlan["kind"];
  alias: string;
  protocol: ModelCandidateProtocol;
  fixtureId: string;
  attempt: number;
}): string {
  return [
    input.kind,
    input.alias,
    input.protocol,
    input.fixtureId,
    input.attempt,
  ].join("/");
}

function expectedDispatchKey(input: {
  mode: ModelEvaluationDispatchMode;
  alias: string;
  protocol: ModelCandidateProtocol;
}): string {
  return `${input.mode}:${input.alias}:${input.protocol}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function buildModelEvaluationEvidencePlanningManifest(): ModelEvaluationEvidencePlanningManifest {
  const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
  const suite = plan.evaluationSuite;
  if (
    plan.dispatchAdmission !== "task_evaluation_ready" ||
    !suite ||
    suite.repairTaskOutput !== true
  ) {
    throw new Error("BrandProfile canonical repairable suite is required");
  }

  const firstCase = buildCanonicalModelEvaluationCase(
    plan,
    suite.fixtureIds[0]!,
  );
  const executions: ModelEvaluationEvidenceExecutionPlan[] = [];
  const append = (
    value: Omit<
      ModelEvaluationEvidenceExecutionPlan,
      "ordinal" | "executionKey" | "maximumWireCalls" | "wireCalls"
    >,
  ): void => {
    executions.push({
      ...value,
      ordinal: executions.length + 1,
      executionKey: executionKey(value),
      maximumWireCalls: MAXIMUM_WIRE_CALLS_PER_EXECUTION,
      wireCalls: WIRE_CALLS,
    });
  };

  for (const candidate of plan.candidates) {
    if (candidate.preflight === "capability_probe") {
      append({
        kind: "capability_probe",
        mode: "target",
        alias: candidate.alias,
        protocol: candidate.expectedProtocol,
        fixtureId: suite.fixtureIds[0]!,
        attempt: 1,
      });
    }
  }
  for (const candidate of plan.candidates) {
    for (const fixtureId of suite.fixtureIds) {
      for (let attempt = 1; attempt <= suite.repeats; attempt += 1) {
        append({
          kind: "target",
          mode: "target",
          alias: candidate.alias,
          protocol: candidate.expectedProtocol,
          fixtureId,
          attempt,
        });
      }
    }
  }
  const legacyRoute = modelPolicyRegistry.getLegacyTaskPolicy(
    plan.taskId,
  ).route;
  for (const alias of [legacyRoute.primary, ...legacyRoute.fallbacks]) {
    for (const fixtureId of suite.fixtureIds) {
      for (let attempt = 1; attempt <= suite.repeats; attempt += 1) {
        append({
          kind: "legacy_comparator",
          mode: "legacy_comparator",
          alias,
          protocol: "openai-chat-completions",
          fixtureId,
          attempt,
        });
      }
    }
  }

  if (
    executions.length !==
      MODEL_EVALUATION_UNVERIFIED_PLANNING_UPPER_BOUND.executions ||
    new Set(executions.map((entry) => entry.executionKey)).size !==
      executions.length
  ) {
    throw new Error("model evaluation execution manifest is not canonical");
  }
  const maximumWireCallCount =
    executions.length * MAXIMUM_WIRE_CALLS_PER_EXECUTION;
  if (
    maximumWireCallCount !==
    MODEL_EVALUATION_UNVERIFIED_PLANNING_UPPER_BOUND.wireCalls
  ) {
    throw new Error("model evaluation wire-call manifest is not canonical");
  }

  return deepFreeze({
    prepId: SITE_BUILDER_MODEL_EVALUATION_EVIDENCE_PREP_ID,
    harnessId: SITE_BUILDER_MODEL_EVALUATION_HARNESS_ID,
    taskId: "site_builder.brand_profile",
    suiteId: suite.suiteId,
    sourceBundleContractId: suite.sourceBundleContractId,
    sourceBundleSha256: firstCase.contract.sourceBundleSha256,
    sourceFiles: firstCase.payload.sourceFiles,
    repair: {
      taskOutputRepairEnabled: true,
      maximumWireCallsPerExecution: 2,
      maximumRepairCallsPerExecution: 1,
    },
    executions,
    executionCount: executions.length as 61,
    maximumWireCallCount: maximumWireCallCount as 122,
    stopConditions: MODEL_EVALUATION_EVIDENCE_STOP_CONDITIONS,
    unverifiedPlanningUpperBound:
      MODEL_EVALUATION_UNVERIFIED_PLANNING_UPPER_BOUND,
  });
}

function expectedDispatches(
  manifest: ModelEvaluationEvidencePlanningManifest,
): string[] {
  return [
    ...new Set(
      manifest.executions.map((entry) =>
        expectedDispatchKey({
          mode: entry.mode,
          alias: entry.alias,
          protocol: entry.protocol,
        }),
      ),
    ),
  ].sort();
}

function assertExactCostSafety(
  manifest: ModelEvaluationEvidencePlanningManifest,
  costSafety: ModelEvaluationCostSafetyAttestation,
): void {
  if (!isTrustedModelEvaluationCostSafetyAttestation(costSafety)) {
    throw new Error(
      "trusted model evaluation cost safety attestation required",
    );
  }
  const actualDispatches = costSafety.credential.allowedDispatches
    .map(expectedDispatchKey)
    .sort();
  if (
    costSafety.contractId !== SITE_BUILDER_MODEL_EVALUATION_COST_SAFETY_ID ||
    JSON.stringify(actualDispatches) !==
      JSON.stringify(expectedDispatches(manifest)) ||
    costSafety.authorization.approvedDispatchExecutions !==
      manifest.executionCount ||
    costSafety.limits.maxDispatchExecutions !== manifest.executionCount ||
    costSafety.limits.maxWireCalls !== manifest.maximumWireCallCount
  ) {
    throw new Error(
      "cost safety attestation does not exactly match the frozen evidence manifest",
    );
  }

  const plan = buildTaskEvaluationPlan(manifest.taskId);
  for (const dispatch of costSafety.credential.allowedDispatches) {
    const executionCount = manifest.executions.filter(
      (entry) =>
        entry.mode === dispatch.mode &&
        entry.alias === dispatch.alias &&
        entry.protocol === dispatch.protocol,
    ).length;
    assertModelEvaluationCostSafetyDispatch(costSafety, {
      ...dispatch,
      maxOutputTokens: plan.envelope.maxTokens,
      promptUtf8Bytes: costSafety.limits.maxPromptUtf8BytesPerCall,
      maximumWireCalls: executionCount * MAXIMUM_WIRE_CALLS_PER_EXECUTION,
      perCallCostCapCents: plan.envelope.perCallCostCapCents,
    });
  }
}

function frozenPricedMaximumCents(
  manifest: ModelEvaluationEvidencePlanningManifest,
  costSafety: ModelEvaluationCostSafetyAttestation,
): number {
  const plan = buildTaskEvaluationPlan(manifest.taskId);
  let total = 0;
  for (const execution of manifest.executions) {
    const perCall = frozenModelEvaluationPriceCents(costSafety, {
      alias: execution.alias,
      protocol: execution.protocol,
      inputTokens:
        costSafety.limits.maxPromptUtf8BytesPerCall +
        MODEL_EVALUATION_PROTOCOL_FRAMING_TOKEN_UPPER_BOUND,
      outputTokens: plan.envelope.maxTokens,
    });
    if (perCall === null) {
      throw new Error("frozen pricing is incomplete for evidence manifest");
    }
    total += Math.ceil(perCall) * execution.maximumWireCalls;
  }
  return Math.ceil(total);
}

export function createModelEvaluationEvidencePrepBundle(input: {
  fixedCommitSha: string;
  costSafety: ModelEvaluationCostSafetyAttestation;
}): ModelEvaluationEvidencePrepBundle {
  if (!SHA1.test(input.fixedCommitSha)) {
    throw new Error("fixed evidence commit must be a full lowercase SHA-1");
  }
  const planningManifest = buildModelEvaluationEvidencePlanningManifest();
  assertExactCostSafety(planningManifest, input.costSafety);
  const frozenMaximumCents = frozenPricedMaximumCents(
    planningManifest,
    input.costSafety,
  );
  if (
    frozenMaximumCents > input.costSafety.limits.campaignBudgetCents ||
    frozenMaximumCents > input.costSafety.credential.remainingQuotaCents
  ) {
    throw new Error("frozen priced maximum exceeds approved finite funds");
  }
  const manifestSha256 = sha256CanonicalJson(planningManifest);
  const withoutDigest = {
    schemaVersion: MODEL_EVALUATION_EVIDENCE_PREP_SCHEMA_VERSION,
    prepId: SITE_BUILDER_MODEL_EVALUATION_EVIDENCE_PREP_ID,
    fixedCommitSha: input.fixedCommitSha,
    createOnly: true as const,
    dispatchAuthorization: "NOT_AUTHORIZED" as const,
    planningManifest,
    credentialEvidence: {
      attestationId: input.costSafety.credential.attestationId,
      credentialSnapshotSha256: input.costSafety.credential.snapshotSha256,
      bearerTokenSha256: input.costSafety.credential.bearerTokenSha256,
      observedAt: input.costSafety.credential.observedAt,
      balanceSampledAt: input.costSafety.credential.observedAt,
      gatewayOrigin: input.costSafety.credential.gatewayOrigin,
      purpose: input.costSafety.credential.purpose,
      quotaMode: input.costSafety.credential.quotaMode,
      scopeExact: input.costSafety.credential.scopeExact,
      quotaCapCents: input.costSafety.credential.quotaCapCents,
      remainingQuotaCents: input.costSafety.credential.remainingQuotaCents,
      allowedDispatches: input.costSafety.credential.allowedDispatches,
    },
    pricingEvidence: {
      snapshotId: input.costSafety.pricing.snapshotId,
      snapshotSha256: input.costSafety.pricing.snapshotSha256,
      basis: input.costSafety.pricing.basis,
      resolverId: input.costSafety.pricing.resolverId,
      billingUnit: "cents_per_million_tokens" as const,
      entries: input.costSafety.pricing.entries,
    },
    decisionCard: {
      schemaVersion: MODEL_EVALUATION_EVIDENCE_DECISION_CARD_SCHEMA_VERSION,
      status: "READY_FOR_PRODUCT_DECISION" as const,
      dispatchAuthorization: "NOT_AUTHORIZED" as const,
      fixedCommitSha: input.fixedCommitSha,
      executionCount: planningManifest.executionCount,
      maximumWireCallCount: planningManifest.maximumWireCallCount,
      frozenPricedMaximumCents: frozenMaximumCents,
      approvedCampaignBudgetCents:
        input.costSafety.authorization.approvedCampaignBudgetCents,
      remainingQuotaCents: input.costSafety.credential.remainingQuotaCents,
      unverifiedPlanningUpperBound:
        MODEL_EVALUATION_UNVERIFIED_PLANNING_UPPER_BOUND,
      pricingSnapshotSha256: input.costSafety.pricing.snapshotSha256,
      credentialSnapshotSha256: input.costSafety.credential.snapshotSha256,
      manifestSha256,
    },
  };
  const bundle = deepFreeze({
    ...withoutDigest,
    bundleSha256: sha256CanonicalJson(withoutDigest),
  });
  TRUSTED_EVIDENCE_PREP_BUNDLES.add(bundle);
  return bundle;
}

export async function writeModelEvaluationEvidencePrepBundleCreateOnly(
  repositoryRoot: string,
  repositoryRelativePath: string,
  bundle: ModelEvaluationEvidencePrepBundle,
): Promise<void> {
  if (!TRUSTED_EVIDENCE_PREP_BUNDLES.has(bundle)) {
    throw new Error("trusted evidence preparation bundle required");
  }
  if (
    repositoryRelativePath.length === 0 ||
    isAbsolute(repositoryRelativePath) ||
    repositoryRelativePath.includes("\\") ||
    repositoryRelativePath.split("/").includes("..") ||
    !repositoryRelativePath.endsWith(".json")
  ) {
    throw new Error("output must be a new repository-relative JSON path");
  }
  const realRepositoryRoot = await realpath(repositoryRoot);
  const lexicalOutput = resolve(realRepositoryRoot, repositoryRelativePath);
  const lexicalRelative = relative(realRepositoryRoot, lexicalOutput);
  if (
    lexicalRelative === ".." ||
    lexicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(lexicalRelative)
  ) {
    throw new Error("evidence preparation output escapes the repository");
  }

  const parentParts = dirname(repositoryRelativePath)
    .split("/")
    .filter((part) => part !== "." && part !== "");
  let safeParent = realRepositoryRoot;
  for (const part of parentParts) {
    const next = resolve(safeParent, part);
    try {
      await mkdir(next, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const metadata = await lstat(next);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(
        "evidence preparation output parent must be a real directory",
      );
    }
    const realNext = await realpath(next);
    const nextRelative = relative(realRepositoryRoot, realNext);
    if (
      nextRelative === ".." ||
      nextRelative.startsWith(`..${sep}`) ||
      isAbsolute(nextRelative)
    ) {
      throw new Error("evidence preparation output parent escapes repository");
    }
    safeParent = realNext;
  }

  const directory = await open(
    safeParent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let output;
  try {
    const descriptorPath = `/proc/self/fd/${directory.fd}`;
    const descriptorTarget = await realpath(descriptorPath);
    const descriptorRelative = relative(realRepositoryRoot, descriptorTarget);
    if (
      descriptorRelative === ".." ||
      descriptorRelative.startsWith(`..${sep}`) ||
      isAbsolute(descriptorRelative)
    ) {
      throw new Error(
        "evidence preparation directory descriptor escaped repository",
      );
    }
    output = await open(
      `${descriptorPath}/${basename(repositoryRelativePath)}`,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await output.writeFile(`${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    await output.sync();
  } finally {
    await output?.close();
    await directory.close();
  }
}
