import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertCompiledRuntimeGuardCurrent,
  createCompiledRuntimeGuard,
  getCompiledRuntimeGuardAttestation,
} from "../../model-runtime/compiled-runtime-guard";
import { canonicalDigest } from "../../model-runtime/context-engine";
import {
  DurableModelExecutionRuntime,
  getDurableModelExecutionAttestation,
} from "../../model-runtime/durable-model-execution-runtime";
import { getTrustedModelExecutionMetadata } from "../../model-runtime/model-execution-runtime";
import {
  assertGitReviewedEvidenceAcceptanceCurrent,
  createGitReviewedEvidenceAcceptanceArtifact,
  getGitReviewedEvidenceAcceptanceAttestation,
  GIT_REVIEWED_EVIDENCE_ACCEPTANCE_SCHEMA_VERSION,
  type GitReviewedEvidenceAcceptanceArtifact,
  type GitReviewedEvidenceAcceptanceSubject,
  type VerifiedGitReviewedEvidenceAcceptance,
} from "../../model-runtime/git-reviewed-evidence-acceptance";
import {
  RealModelExecutionLedger,
  type RealModelExecutionAuthorization,
  type RealKnownSettlementEvidence,
  type RealModelExecutionLedgerSummary,
} from "../../model-runtime/real-model-execution-ledger";
import type { ModelExecutionCampaignContract } from "../../model-runtime/model-execution-ledger";
import {
  NativeModelApiError,
  NativeModelOutputError,
} from "../../model-runtime/adapters/ai-sdk-native-adapter.contract";
import type { NativeModelAdapterResult } from "../../model-runtime/adapters/ai-sdk-native-adapter.contract";
import type {
  ModelExecutionResult,
  ModelObservation,
  ModelProtocol,
  ModelTransport,
  ReasoningLevel,
} from "../../model-runtime/types";
import type { CopyTaskInput, CopyTaskOutput } from "../agents/copy";
import {
  createCopyCapabilityExecutionPlan,
  createCopyCapabilityRepairCompiler,
  COPY_CAPABILITY_OPERATIONAL_ARTIFACT_PATHS,
} from "./copy-capability-pilot-runner";
import { COPY_CAPABILITY_PILOT_PLAN } from "./copy-capability-pilot";
import {
  copyPilotChildReservationDigest,
  type CopyPilotChildDispatchAuthorization,
  type CopyRealCapabilityAdmissionInput,
} from "./copy-real-capability-admission";
import {
  isCopySonnetRecoveryAdmission,
  validateCopyCapabilityAdmissionEnvelope,
  type CopyCapabilityAdmissionInput,
} from "./copy-capability-admission";
import {
  copySonnetRecoveryReservationDigest,
  type CopySonnetRecoveryAdmissionInput,
  type CopySonnetRecoveryChildDispatchAuthorization,
} from "./copy-sonnet-recovery-admission";
import {
  createCopyPilotTrustedGatewayBindings,
  assertCopyPilotTrustedGatewayCurrent,
  getCopyPilotTrustedAdmissionBinding,
  type CopyPilotTrustedGateway,
} from "./copy-pilot-trusted-gateway";
import {
  requireCopyPilotVerifiedSourceBinding,
  assertCopyPilotVerifiedSourceCurrent,
  type CopyPilotVerifiedSource,
} from "./copy-pilot-source-verifier";
import {
  assertCopyPilotLedgerIdentityCurrent,
  loadCopyPilotLedgerIdentity,
  markCopyPilotLedgerIdentityClaimed,
} from "./copy-pilot-ledger-identity";

const FREEZE_OBJECT = Object.freeze.bind(Object);
const OBJECT_IS_FROZEN = Object.isFrozen.bind(Object);
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf.bind(Object);
const REFLECT_OWN_KEYS = Reflect.ownKeys.bind(Reflect);
const ARRAY_IS_ARRAY = Array.isArray.bind(Array);
const SAFE_WEAK_SET = WeakSet;
const WEAK_SET_HAS = Function.prototype.call.bind(WeakSet.prototype.has) as (
  set: WeakSet<object>,
  value: object,
) => boolean;
const WEAK_SET_ADD = Function.prototype.call.bind(WeakSet.prototype.add) as (
  set: WeakSet<object>,
  value: object,
) => WeakSet<object>;
const STRING_REPLACE = Function.prototype.call.bind(
  String.prototype.replace,
) as (
  value: string,
  searchValue: string | RegExp,
  replaceValue: string,
) => string;
const STRING_TO_LOWER_CASE = Function.prototype.call.bind(
  String.prototype.toLowerCase,
) as (value: string) => string;
const CANONICAL_DIGEST = canonicalDigest;
const freezeProbe = { value: "unchanged" };
FREEZE_OBJECT(freezeProbe);
if (
  !OBJECT_IS_FROZEN(freezeProbe) ||
  Reflect.set(freezeProbe, "value", "mutated")
) {
  throw new Error("COPY_GIT_EVIDENCE_OBJECT_PRIMITIVE_DRIFT");
}

export const COPY_REAL_CAPABILITY_ARTIFACT_PATHS = FREEZE_OBJECT(
  [
    ...COPY_CAPABILITY_OPERATIONAL_ARTIFACT_PATHS,
    "apps/api/dist/model-gateway/new-api-request-bound-settlement.js",
    "apps/api/dist/model-runtime/git-reviewed-evidence-acceptance.js",
    "apps/api/dist/site-builder/eval/copy-pilot-source-verifier.js",
    "apps/api/dist/site-builder/eval/copy-pilot-ledger-identity.js",
    "apps/api/dist/site-builder/eval/copy-pilot-trusted-gateway.js",
    "apps/api/dist/site-builder/eval/copy-capability-admission.js",
    "apps/api/dist/site-builder/eval/copy-real-capability-admission.js",
    "apps/api/dist/site-builder/eval/copy-sonnet-recovery-admission.js",
    "apps/api/dist/site-builder/eval/copy-sonnet-recovery-contract.js",
    "apps/api/dist/site-builder/eval/copy-real-capability-runner.js",
  ].filter((path, index, paths) => paths.indexOf(path) === index),
);
const COPY_SONNET_RECOVERY_ARTIFACT_PATHS = FREEZE_OBJECT(
  [
    ...COPY_REAL_CAPABILITY_ARTIFACT_PATHS,
    "apps/api/dist/site-builder/eval/copy-sonnet-recovery-manifest-prep.js",
  ]
    .filter((path, index, paths) => paths.indexOf(path) === index)
    .sort(),
);

const LOADED_REPOSITORY_ROOT = resolve(__dirname, "../../../../..");
const COMPILED_ENTRYPOINT = resolve(
  LOADED_REPOSITORY_ROOT,
  "apps/api/dist/site-builder/eval/copy-real-capability-runner.js",
);
const ASSERT_COMPILED_CURRENT = assertCompiledRuntimeGuardCurrent;
const GET_COMPILED_ATTESTATION = getCompiledRuntimeGuardAttestation;
const GET_DURABLE_ATTESTATION = getDurableModelExecutionAttestation;
const GET_TRUSTED_METADATA = getTrustedModelExecutionMetadata;
const FREEZE_REAL_EXECUTION =
  RealModelExecutionLedger.prototype.freezeExecution;

export interface CopyRealCapabilityReceipt {
  classification: "DISPATCH_PREFLIGHT_RECEIPT_ONLY";
  evidenceClass: "copy_gateway_settlement_candidate";
  evidenceKind: "capability_pilot";
  taskId: "site_builder.copy";
  campaignId: string;
  executionId: string;
  alias: string;
  protocol: ModelProtocol;
  reasoning: ReasoningLevel;
  wireCount: 1 | 2;
  repaired: boolean;
  fixtureId: string;
  repeatIndex: null;
  planDigest: string;
  inputDigest: string;
  contextDigest: string;
  promptDigest: string;
  ledgerDigest: string;
  outputDigest: string;
  fixedSourceCommit: string;
  sourceBundleDigest: string;
  manifestDigest: string;
  admissionDigest: string;
  credentialAttestationDigest: string;
  settlementObserverDigest: string;
  knownSettlementDigest: string;
  settlementChain: RealKnownSettlementEvidence;
  authorizationId: string;
  reservationId: string;
  globalAuthorizationDigest: string;
  childAuthorizationDigest: string;
  childSlotId: string;
  ledgerCampaign: ModelExecutionCampaignContract;
  ledgerAuthorization: RealModelExecutionAuthorization;
  runtimeBinding: CopyRealCapabilityRuntimeBinding;
  compiledRuntimeDigest: string;
  compiledBindingDigest: string;
}

export interface CopyRealCapabilityRuntimeBinding {
  schemaVersion: "copy-real-capability-runtime-binding/2026-08-08-v4";
  taskId: "site_builder.copy";
  planDigest: string;
  fixedSourceCommit: string;
  preparationHeadCommit: string;
  sourceBundleDigest: string;
  manifestDigest: string;
  manifestArtifactDigest: string;
  expectedCompiledRuntimeDigest: string;
  credentialAttestationDigest: string;
  settlementObserverDigest: string;
  globalAuthorizationDigest: string;
  childAuthorizationDigest: string;
  selectedExecutionKey: string;
  childCampaignId: string;
  gitReviewedEvidenceAcceptanceSchemaVersion: typeof GIT_REVIEWED_EVIDENCE_ACCEPTANCE_SCHEMA_VERSION;
  artifactPathsDigest: string;
}

export interface CopyGitEvidenceAcceptanceChallenge {
  schemaVersion: "site-builder-copy-git-evidence-acceptance-challenge/2026-08-07-v1";
  candidateReceiptDigest: string;
  receipt: CopyRealCapabilityReceipt;
}

export interface CopyGitAcceptedExecution {
  readonly classification: "OPAQUE_COPY_GIT_ACCEPTED_EXECUTION";
}

export interface CopyGitAcceptedExecutionAttestation {
  classification: "GIT_REVIEWED_REAL_EVIDENCE";
  evidenceClass: "git_reviewed_gateway_settlement_accepted";
  evidenceKind: "capability_pilot";
  acceptanceId: string;
  artifactDigest: string;
  artifactCommit: string;
  mergeCommit: string;
  pullRequestNumber: number;
  candidateReceiptDigest: string;
  candidateLedgerDigest: string;
  evidenceLedgerDigest: string;
  executionId: string;
  outputDigest: string;
  alias: string;
  protocol: ModelProtocol;
  reasoning: ReasoningLevel;
  fixedSourceCommit: string;
  sourceBundleDigest: string;
  manifestDigest: string;
  compiledRuntimeDigest: string;
  compiledBindingDigest: string;
  settlementObserverDigest: string;
  knownSettlementDigest: string;
}

export interface CopyRealCapabilityRunner {
  execute(executionKey: string): Promise<ModelExecutionResult<CopyTaskOutput>>;
  acceptGitReviewedEvidence(input: {
    acceptance: VerifiedGitReviewedEvidenceAcceptance;
  }): Promise<CopyGitAcceptedExecution>;
  summary(): Promise<RealModelExecutionLedgerSummary>;
}

export interface CopySonnetRecoveryRunner {
  execute(executionKey: string): Promise<ModelExecutionResult<CopyTaskOutput>>;
  acceptGitReviewedEvidence(input: {
    acceptance: VerifiedGitReviewedEvidenceAcceptance;
  }): Promise<CopyGitAcceptedExecution>;
  summary(): Promise<RealModelExecutionLedgerSummary>;
}

export interface CopyGitEvidenceAcceptanceRunner {
  acceptGitReviewedEvidence(input: {
    acceptance: VerifiedGitReviewedEvidenceAcceptance;
  }): Promise<CopyGitAcceptedExecution>;
  summary(): Promise<RealModelExecutionLedgerSummary>;
}

export interface CopyRealCapabilityCampaignRunner {
  execute(executionKey: string): Promise<ModelExecutionResult<CopyTaskOutput>>;
  summaries(): Promise<readonly RealModelExecutionLedgerSummary[]>;
}

const REAL_CAPABILITY_RECEIPTS = new WeakMap<
  object,
  CopyRealCapabilityReceipt
>();
const GET_REAL_CAPABILITY_RECEIPT = REAL_CAPABILITY_RECEIPTS.get.bind(
  REAL_CAPABILITY_RECEIPTS,
);
const SET_REAL_CAPABILITY_RECEIPT = REAL_CAPABILITY_RECEIPTS.set.bind(
  REAL_CAPABILITY_RECEIPTS,
);
interface CopyGitEvidenceAcceptanceDetail {
  ledger: RealModelExecutionLedger;
  ledgerIdentity: Awaited<ReturnType<typeof loadCopyPilotLedgerIdentity>>;
  campaignId: string;
}

interface CopyRealCapabilityRuntimeDetail extends CopyGitEvidenceAcceptanceDetail {
  admission: CopyCapabilityAdmissionInput;
  receipt?: CopyRealCapabilityReceipt;
  compiledGuard: Awaited<ReturnType<typeof createCompiledRuntimeGuard>>;
  verifiedSource: CopyPilotVerifiedSource;
  trustedGateway: CopyPilotTrustedGateway;
  source: ReturnType<typeof requireCopyPilotVerifiedSourceBinding>;
}

const REAL_CAPABILITY_DETAILS = new WeakMap<
  object,
  CopyRealCapabilityRuntimeDetail & { receipt: CopyRealCapabilityReceipt }
>();
const GET_REAL_CAPABILITY_DETAIL = REAL_CAPABILITY_DETAILS.get.bind(
  REAL_CAPABILITY_DETAILS,
);
const SET_REAL_CAPABILITY_DETAIL = REAL_CAPABILITY_DETAILS.set.bind(
  REAL_CAPABILITY_DETAILS,
);
const REAL_CAPABILITY_RUNNERS = new WeakMap<
  object,
  CopyRealCapabilityRuntimeDetail
>();
const GET_REAL_CAPABILITY_RUNNER = REAL_CAPABILITY_RUNNERS.get.bind(
  REAL_CAPABILITY_RUNNERS,
);
const SET_REAL_CAPABILITY_RUNNER = REAL_CAPABILITY_RUNNERS.set.bind(
  REAL_CAPABILITY_RUNNERS,
);
const BATCH_DISPATCH_AUTHORIZATIONS = new WeakMap<object, string>();
const GET_BATCH_DISPATCH_AUTHORIZATION = BATCH_DISPATCH_AUTHORIZATIONS.get.bind(
  BATCH_DISPATCH_AUTHORIZATIONS,
);
const SET_BATCH_DISPATCH_AUTHORIZATION = BATCH_DISPATCH_AUTHORIZATIONS.set.bind(
  BATCH_DISPATCH_AUTHORIZATIONS,
);
const DELETE_BATCH_DISPATCH_AUTHORIZATION =
  BATCH_DISPATCH_AUTHORIZATIONS.delete.bind(BATCH_DISPATCH_AUTHORIZATIONS);
const PROMISE_ALL_SETTLED = Promise.allSettled.bind(Promise);
const EVIDENCE_REOPEN_INPUT_KEYS = FREEZE_OBJECT([
  "ledgerPath",
  "authorizationClaimPath",
  "ledgerMarkerPath",
  "campaignId",
] as const);
const EVIDENCE_ACCEPT_INPUT_KEYS = FREEZE_OBJECT(["acceptance"] as const);
const COPY_RECEIPT_KEYS = FREEZE_OBJECT([
  "classification",
  "evidenceClass",
  "evidenceKind",
  "taskId",
  "campaignId",
  "executionId",
  "alias",
  "protocol",
  "reasoning",
  "wireCount",
  "repaired",
  "fixtureId",
  "repeatIndex",
  "planDigest",
  "inputDigest",
  "contextDigest",
  "promptDigest",
  "ledgerDigest",
  "outputDigest",
  "fixedSourceCommit",
  "sourceBundleDigest",
  "manifestDigest",
  "admissionDigest",
  "credentialAttestationDigest",
  "settlementObserverDigest",
  "knownSettlementDigest",
  "settlementChain",
  "authorizationId",
  "reservationId",
  "globalAuthorizationDigest",
  "childAuthorizationDigest",
  "childSlotId",
  "ledgerCampaign",
  "ledgerAuthorization",
  "runtimeBinding",
  "compiledRuntimeDigest",
  "compiledBindingDigest",
] as const);
const RUNTIME_BINDING_KEYS = FREEZE_OBJECT([
  "schemaVersion",
  "taskId",
  "planDigest",
  "fixedSourceCommit",
  "preparationHeadCommit",
  "sourceBundleDigest",
  "manifestDigest",
  "manifestArtifactDigest",
  "expectedCompiledRuntimeDigest",
  "credentialAttestationDigest",
  "settlementObserverDigest",
  "globalAuthorizationDigest",
  "childAuthorizationDigest",
  "selectedExecutionKey",
  "childCampaignId",
  "gitReviewedEvidenceAcceptanceSchemaVersion",
  "artifactPathsDigest",
] as const);
const LEDGER_CAMPAIGN_KEYS = FREEZE_OBJECT([
  "campaignId",
  "taskId",
  "planDigest",
  "maximumExecutions",
  "maximumWireCalls",
] as const);
const LEDGER_AUTHORIZATION_KEYS = FREEZE_OBJECT([
  "authorizationId",
  "reservationId",
  "manifestDigest",
  "credentialAttestationDigest",
  "settlementObserverDigest",
  "ledgerIdentityDigest",
  "reservationDigest",
  "maximumExecutions",
  "maximumWireCalls",
  "maximumRepairCallsPerExecution",
  "evidenceBinding",
] as const);
const EVIDENCE_BINDING_KEYS = FREEZE_OBJECT([
  "schemaVersion",
  "executionId",
  "childSlotId",
  "alias",
  "protocol",
  "reasoning",
  "fixtureId",
  "executionPlanDigest",
  "inputDigest",
  "contextDigest",
  "promptDigest",
  "fixedSourceCommit",
  "sourceBundleDigest",
  "manifestDigest",
  "admissionDigest",
  "globalAuthorizationDigest",
  "childAuthorizationDigest",
  "compiledRuntimeDigest",
  "compiledBindingDigest",
] as const);
const FORBIDDEN_EVIDENCE_KEYS = FREEZE_OBJECT([
  "apikey",
  "bearertoken",
  "output",
  "password",
  "prompt",
  "rawoutput",
  "rawprompt",
  "rawrequestid",
  "requestid",
  "secret",
  "token",
] as const);
const batchDispatchProbe = FREEZE_OBJECT({});
SET_BATCH_DISPATCH_AUTHORIZATION(batchDispatchProbe, "probe");
if (
  GET_BATCH_DISPATCH_AUTHORIZATION(batchDispatchProbe) !== "probe" ||
  !DELETE_BATCH_DISPATCH_AUTHORIZATION(batchDispatchProbe) ||
  GET_BATCH_DISPATCH_AUTHORIZATION(batchDispatchProbe) !== undefined
) {
  throw new Error("COPY_REAL_CAPABILITY_WEAK_MAP_PRIMITIVE_DRIFT");
}
const GIT_ACCEPTED_EXECUTIONS = new WeakMap<
  object,
  CopyGitAcceptedExecutionAttestation
>();
const GET_GIT_ACCEPTED_EXECUTION = GIT_ACCEPTED_EXECUTIONS.get.bind(
  GIT_ACCEPTED_EXECUTIONS,
);
const SET_GIT_ACCEPTED_EXECUTION = GIT_ACCEPTED_EXECUTIONS.set.bind(
  GIT_ACCEPTED_EXECUTIONS,
);
const EVIDENCE_REOPEN_LEDGERS = new WeakMap<object, RealModelExecutionLedger>();
const GET_EVIDENCE_REOPEN_LEDGER = EVIDENCE_REOPEN_LEDGERS.get.bind(
  EVIDENCE_REOPEN_LEDGERS,
);
const SET_EVIDENCE_REOPEN_LEDGER = EVIDENCE_REOPEN_LEDGERS.set.bind(
  EVIDENCE_REOPEN_LEDGERS,
);

function fail(code: string): never {
  throw new Error(code);
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== "object" || ARRAY_IS_ARRAY(value)) {
    return false;
  }
  const prototype = OBJECT_GET_PROTOTYPE_OF(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObjectKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (!objectRecord(value)) return false;
  const keys = REFLECT_OWN_KEYS(value);
  if (keys.length !== expected.length) return false;
  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    const key = keys[keyIndex];
    if (typeof key !== "string") return false;
    let found = false;
    for (
      let candidateIndex = 0;
      candidateIndex < expected.length;
      candidateIndex += 1
    ) {
      const candidate = expected[candidateIndex];
      if (key === candidate) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function containsForbiddenEvidenceKey(value: unknown): boolean {
  if (value == null || typeof value !== "object") return false;
  const pending: object[] = [value];
  const seen = new SAFE_WEAK_SET<object>();
  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index]!;
    if (WEAK_SET_HAS(seen, current)) return true;
    WEAK_SET_ADD(seen, current);
    if (ARRAY_IS_ARRAY(current)) {
      for (let itemIndex = 0; itemIndex < current.length; itemIndex += 1) {
        const nested = current[itemIndex];
        if (nested != null && typeof nested === "object") {
          pending[pending.length] = nested;
        }
      }
      continue;
    }
    const keys = REFLECT_OWN_KEYS(current);
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
      const key = keys[keyIndex];
      if (typeof key !== "string") return true;
      const normalized = STRING_TO_LOWER_CASE(
        STRING_REPLACE(key, /[^a-z0-9]/giu, ""),
      );
      for (
        let forbiddenIndex = 0;
        forbiddenIndex < FORBIDDEN_EVIDENCE_KEYS.length;
        forbiddenIndex += 1
      ) {
        const forbidden = FORBIDDEN_EVIDENCE_KEYS[forbiddenIndex];
        if (normalized === forbidden) return true;
      }
      const nested = (current as Record<string, unknown>)[key];
      if (nested != null && typeof nested === "object") {
        pending[pending.length] = nested;
      }
    }
  }
  return false;
}

function exactSettlementChain(
  value: unknown,
): value is RealKnownSettlementEvidence {
  if (
    !exactObjectKeys(value, [
      "schemaVersion",
      "executionId",
      "executionClaim",
      "wires",
      "completion",
      "digest",
    ]) ||
    !exactObjectKeys(value.executionClaim, ["planDigest"]) ||
    !ARRAY_IS_ARRAY(value.wires) ||
    !exactObjectKeys(value.completion, ["outputDigest"])
  ) {
    return false;
  }
  for (let index = 0; index < value.wires.length; index += 1) {
    const wire = value.wires[index];
    if (
      !exactObjectKeys(
        wire,
        index === 0
          ? ["wireIndex", "claim", "observation"]
          : ["wireIndex", "claim", "repairPlan", "observation"],
      ) ||
      !exactObjectKeys(wire.claim, ["wireId", "requestDigest"]) ||
      (index > 0 &&
        !exactObjectKeys(wire.repairPlan, [
          "wireId",
          "bindingDigest",
          "priorOutputDigest",
          "findingsDigest",
        ])) ||
      !exactObjectKeys(wire.observation, [
        "settlement",
        "requestIdDigest",
        "requestedAlias",
        "resolvedAlias",
        "reportedModel",
        "protocol",
        "usage",
        "outputDigest",
        "receiptDigest",
        "quota",
        "resolverId",
        "channelId",
      ]) ||
      !exactObjectKeys(wire.observation.usage, ["inputTokens", "outputTokens"])
    ) {
      return false;
    }
  }
  return true;
}

function exactCopyReceipt(value: unknown): value is CopyRealCapabilityReceipt {
  if (
    containsForbiddenEvidenceKey(value) ||
    !exactObjectKeys(value, COPY_RECEIPT_KEYS) ||
    !exactObjectKeys(value.runtimeBinding, RUNTIME_BINDING_KEYS) ||
    !exactObjectKeys(value.ledgerCampaign, LEDGER_CAMPAIGN_KEYS) ||
    !exactObjectKeys(value.ledgerAuthorization, LEDGER_AUTHORIZATION_KEYS) ||
    !exactObjectKeys(
      value.ledgerAuthorization.evidenceBinding,
      EVIDENCE_BINDING_KEYS,
    ) ||
    !exactSettlementChain(value.settlementChain)
  ) {
    return false;
  }
  return true;
}

function settlementWiresMatchReceipt(
  receipt: CopyRealCapabilityReceipt,
): boolean {
  for (
    let index = 0;
    index < receipt.settlementChain.wires.length;
    index += 1
  ) {
    const observation = receipt.settlementChain.wires[index]?.observation;
    if (
      observation?.settlement !== "known" ||
      observation.resolvedAlias !== receipt.alias ||
      observation.reportedModel !== receipt.alias ||
      observation.protocol !== receipt.protocol
    ) {
      return false;
    }
  }
  return true;
}

function assertCompiledEntrypoint(): void {
  let loaded: string;
  let expected: string;
  try {
    loaded = realpathSync(__filename);
    expected = realpathSync(COMPILED_ENTRYPOINT);
  } catch {
    return fail("COPY_REAL_CAPABILITY_COMPILED_ENTRYPOINT_REQUIRED");
  }
  if (loaded !== expected) {
    fail("COPY_REAL_CAPABILITY_COMPILED_ENTRYPOINT_REQUIRED");
  }
}

export async function copyPilotLedgerIdentityDigest(input: {
  ledgerPath: string;
  authorizationClaimPath: string;
  ledgerMarkerPath: string;
  campaignId: string;
}): Promise<string> {
  return (
    await loadCopyPilotLedgerIdentity({
      ledgerPath: input.ledgerPath,
      authorizationClaimPath: input.authorizationClaimPath,
      markerPath: input.ledgerMarkerPath,
      campaignId: input.campaignId,
    })
  ).ledgerIdentityDigest;
}

export function copyPilotReservationDigest(
  authorization: Omit<CopyPilotChildDispatchAuthorization, "reservationDigest">,
): string {
  return copyPilotChildReservationDigest(authorization);
}

function childLedgerAuthorization(
  child:
    | CopyPilotChildDispatchAuthorization
    | CopySonnetRecoveryChildDispatchAuthorization,
  evidenceBinding?: NonNullable<
    RealModelExecutionAuthorization["evidenceBinding"]
  >,
): RealModelExecutionAuthorization {
  return FREEZE_OBJECT({
    authorizationId: child.authorizationId,
    reservationId: child.reservationId,
    manifestDigest: child.manifestDigest,
    credentialAttestationDigest: child.credentialAttestationDigest,
    settlementObserverDigest: child.settlementObserverDigest,
    ledgerIdentityDigest: child.ledgerIdentityDigest,
    reservationDigest: child.reservationDigest,
    maximumExecutions: child.maximumExecutions,
    maximumWireCalls: child.maximumWireCalls,
    maximumRepairCallsPerExecution: child.maximumRepairCallsPerExecution,
    ...(evidenceBinding == null ? {} : { evidenceBinding }),
  });
}

function childLedgerCampaign(input: {
  campaignId: string;
  manifest: CopyCapabilityAdmissionInput["manifest"];
}): ModelExecutionCampaignContract {
  return FREEZE_OBJECT({
    campaignId: input.campaignId,
    taskId: input.manifest.taskId,
    planDigest: input.manifest.planDigest,
    maximumExecutions: 1,
    maximumWireCalls: 2,
  });
}

function runtimeBinding(input: {
  admission: CopyCapabilityAdmissionInput;
  source: {
    fixedSourceCommit: string;
    preparationHeadCommit: string;
    sourceBundleDigest: string;
    artifactDigest: string;
    compiledRuntimeExpectation: { artifactTreeDigest: string };
  };
}): CopyRealCapabilityRuntimeBinding {
  return FREEZE_OBJECT({
    schemaVersion: "copy-real-capability-runtime-binding/2026-08-08-v4",
    taskId: input.admission.manifest.taskId,
    planDigest: input.admission.manifest.planDigest,
    fixedSourceCommit: input.source.fixedSourceCommit,
    preparationHeadCommit: input.source.preparationHeadCommit,
    sourceBundleDigest: input.source.sourceBundleDigest,
    manifestDigest: CANONICAL_DIGEST(input.admission.manifest),
    manifestArtifactDigest: input.source.artifactDigest,
    expectedCompiledRuntimeDigest:
      input.source.compiledRuntimeExpectation.artifactTreeDigest,
    credentialAttestationDigest: CANONICAL_DIGEST(input.admission.credential),
    settlementObserverDigest: CANONICAL_DIGEST(input.admission.settlement),
    globalAuthorizationDigest: CANONICAL_DIGEST(input.admission.authorization),
    childAuthorizationDigest: CANONICAL_DIGEST(
      input.admission.childAuthorization,
    ),
    selectedExecutionKey: input.admission.selectedExecutionKey,
    childCampaignId: input.admission.childAuthorization.campaignId,
    gitReviewedEvidenceAcceptanceSchemaVersion:
      GIT_REVIEWED_EVIDENCE_ACCEPTANCE_SCHEMA_VERSION,
    artifactPathsDigest: CANONICAL_DIGEST(artifactPathsFor(input.admission)),
  });
}

function artifactPathsFor(
  admission: CopyCapabilityAdmissionInput,
): readonly string[] {
  return isCopySonnetRecoveryAdmission(admission)
    ? COPY_SONNET_RECOVERY_ARTIFACT_PATHS
    : COPY_REAL_CAPABILITY_ARTIFACT_PATHS;
}

function recoveryAwareReservationDigest(
  admission: CopyCapabilityAdmissionInput,
  child: Omit<
    | CopyPilotChildDispatchAuthorization
    | CopySonnetRecoveryChildDispatchAuthorization,
    "reservationDigest"
  >,
): string {
  return isCopySonnetRecoveryAdmission(admission)
    ? copySonnetRecoveryReservationDigest(
        child as Omit<
          CopySonnetRecoveryChildDispatchAuthorization,
          "reservationDigest"
        >,
      )
    : copyPilotReservationDigest(
        child as Omit<CopyPilotChildDispatchAuthorization, "reservationDigest">,
      );
}

type CopyCapabilitySelectedExecution =
  (typeof COPY_CAPABILITY_PILOT_PLAN.executions)[number] & {
    sourcePilotExecutionKey: string;
  };

function selectedExecutionFor(
  admission: CopyCapabilityAdmissionInput,
): CopyCapabilitySelectedExecution | undefined {
  if (!isCopySonnetRecoveryAdmission(admission)) {
    const selected = COPY_CAPABILITY_PILOT_PLAN.executions.find(
      ({ executionKey }) => executionKey === admission.selectedExecutionKey,
    );
    return selected == null
      ? undefined
      : FREEZE_OBJECT({
          ...selected,
          sourcePilotExecutionKey: selected.executionKey,
        });
  }
  const recovery = admission.manifest.executions.find(
    ({ executionKey }) => executionKey === admission.selectedExecutionKey,
  );
  const source = COPY_CAPABILITY_PILOT_PLAN.executions.find(
    ({ executionKey }) => executionKey === recovery?.sourcePilotExecutionKey,
  );
  if (
    recovery == null ||
    source == null ||
    source.alias !== recovery.alias ||
    source.protocol !== recovery.protocol ||
    source.reasoning !== recovery.reasoning
  ) {
    return undefined;
  }
  return FREEZE_OBJECT({
    ...source,
    executionKey: recovery.executionKey,
    sourcePilotExecutionKey: recovery.sourcePilotExecutionKey,
  });
}

function executionPlanFor(
  execution: CopyCapabilitySelectedExecution,
  campaignId: string,
): ReturnType<typeof createCopyCapabilityExecutionPlan> {
  const source = createCopyCapabilityExecutionPlan({
    executionKey: execution.sourcePilotExecutionKey,
    campaignId,
    workspaceId: "copy-capability-real-gateway",
  });
  if (execution.executionKey === source.executionId) return source;
  return FREEZE_OBJECT({ ...source, executionId: execution.executionKey });
}

function executionPlanDigest(
  plan: ReturnType<typeof createCopyCapabilityExecutionPlan>,
): string {
  return CANONICAL_DIGEST({
    executionId: plan.executionId,
    workspaceId: plan.workspaceId,
    buildRunId: plan.buildRunId,
    taskId: plan.contract.taskId,
    taskVersion: plan.contract.version,
    inputDigest: plan.inputDigest,
    contextDigest: plan.contextDigest,
    promptVersion: plan.promptVersion,
    schemaDigest: plan.schemaDigest,
    requestedAlias: plan.requestedAlias,
    resolvedAlias: plan.resolvedAlias,
    protocol: plan.protocol,
    reasoning: plan.reasoning,
    sampling: plan.sampling,
    locale: plan.locale,
    promptDigest: CANONICAL_DIGEST(plan.prompt),
  });
}

function completeUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
}): usage is { inputTokens: number; outputTokens: number } {
  return (
    Number.isSafeInteger(usage.inputTokens) &&
    Number(usage.inputTokens) >= 0 &&
    Number.isSafeInteger(usage.outputTokens) &&
    Number(usage.outputTokens) >= 0
  );
}

function runtimeProtocol(
  value: "openai-responses" | "openai-chat-completions" | "anthropic-messages",
): ModelProtocol {
  if (value === "openai-responses") return "openai_responses";
  if (value === "openai-chat-completions") {
    return "openai_chat_completions";
  }
  if (value === "anthropic-messages") return "anthropic_messages";
  return fail("COPY_REAL_CAPABILITY_NATIVE_PROTOCOL_NOT_SUPPORTED");
}

function invalidOutput(error: NativeModelOutputError): CopyTaskOutput {
  if (error.rawOutputText == null) return {} as CopyTaskOutput;
  try {
    const parsed = JSON.parse(error.rawOutputText) as unknown;
    return parsed != null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as CopyTaskOutput)
      : ({} as CopyTaskOutput);
  } catch {
    return {} as CopyTaskOutput;
  }
}

function nativeApiFailureReason(
  error: NativeModelApiError,
  settlementReason:
    | "request_id_missing"
    | "log_unavailable"
    | "log_ambiguous"
    | "log_invalid"
    | "model_mismatch"
    | "channel_mismatch"
    | "settlement_proof_invalid"
    | "settled",
): string {
  const status =
    Number.isSafeInteger(error.statusCode) &&
    Number(error.statusCode) >= 100 &&
    Number(error.statusCode) <= 599
      ? `http_${error.statusCode}`
      : "http_unknown";
  const digest =
    typeof error.responseBodyDigest === "string" &&
    /^[0-9a-f]{64}$/u.test(error.responseBodyDigest)
      ? `:body_sha256_${error.responseBodyDigest}`
      : "";
  const bytes =
    Number.isSafeInteger(error.responseBodyBytes) &&
    Number(error.responseBodyBytes) >= 0
      ? `:bytes_${error.responseBodyBytes}`
      : "";
  return `native_api_failure_${status}:${settlementReason}${digest}${bytes}`;
}

export function getCopyRealCapabilityReceipt(
  result: ModelExecutionResult<unknown>,
): CopyRealCapabilityReceipt | undefined {
  return GET_REAL_CAPABILITY_RECEIPT(result);
}

export function createCopyGitEvidenceAcceptanceChallenge(
  result: ModelExecutionResult<unknown>,
): CopyGitEvidenceAcceptanceChallenge {
  const detail = GET_REAL_CAPABILITY_DETAIL(result);
  if (!detail) fail("COPY_GIT_EVIDENCE_CANDIDATE_REQUIRED");
  return FREEZE_OBJECT({
    schemaVersion:
      "site-builder-copy-git-evidence-acceptance-challenge/2026-08-07-v1" as const,
    candidateReceiptDigest: CANONICAL_DIGEST(detail.receipt),
    receipt: detail.receipt,
  });
}

function copyAcceptanceSubject(
  receipt: CopyRealCapabilityReceipt,
): GitReviewedEvidenceAcceptanceSubject {
  return FREEZE_OBJECT({
    executionId: receipt.executionId,
    outputDigest: receipt.outputDigest,
    candidateLedgerDigest: receipt.ledgerDigest,
    fixedSourceCommit: receipt.fixedSourceCommit,
    sourceBundleDigest: receipt.sourceBundleDigest,
    manifestDigest: receipt.manifestDigest,
    compiledRuntimeDigest: receipt.compiledRuntimeDigest,
    compiledBindingDigest: receipt.compiledBindingDigest,
    settlementObserverDigest: receipt.settlementObserverDigest,
    knownSettlementDigest: receipt.knownSettlementDigest,
    alias: receipt.alias,
    protocol: receipt.protocol,
    reasoning: receipt.reasoning,
  });
}

interface ReviewedCopyReceipt {
  accepted: NonNullable<
    ReturnType<typeof getGitReviewedEvidenceAcceptanceAttestation>
  >;
  receipt: CopyRealCapabilityReceipt;
  candidateReceiptDigest: string;
}

function reviewedCopyReceipt(
  acceptance: VerifiedGitReviewedEvidenceAcceptance,
): ReviewedCopyReceipt {
  const accepted = getGitReviewedEvidenceAcceptanceAttestation(acceptance);
  if (!accepted) fail("COPY_GIT_EVIDENCE_ACCEPTANCE_REQUIRED");
  const candidateReceipt = accepted.candidateReceipt as unknown;
  if (!exactCopyReceipt(candidateReceipt)) {
    fail("COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH");
  }
  const receipt = candidateReceipt;
  let candidateReceiptDigest: string;
  try {
    candidateReceiptDigest = CANONICAL_DIGEST(receipt);
  } catch {
    return fail("COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH");
  }
  if (
    accepted.schemaVersion !==
      GIT_REVIEWED_EVIDENCE_ACCEPTANCE_SCHEMA_VERSION ||
    accepted.acceptedEvidenceClass !==
      "git_reviewed_gateway_settlement_accepted" ||
    accepted.taskId !== "site_builder.copy" ||
    accepted.evidenceKind !== "capability_pilot" ||
    accepted.candidateReceiptDigest !== candidateReceiptDigest ||
    CANONICAL_DIGEST(accepted.subject) !==
      CANONICAL_DIGEST(copyAcceptanceSubject(receipt))
  ) {
    fail("COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH");
  }
  return { accepted, receipt, candidateReceiptDigest };
}

function historicalReceiptBindingIsExact(
  receipt: CopyRealCapabilityReceipt,
): boolean {
  let expectedCampaignDigest: string;
  let expectedAuthorizationDigest: string;
  let runtimeBindingDigest: string;
  try {
    expectedCampaignDigest = CANONICAL_DIGEST({
      campaignId: receipt.campaignId,
      taskId: receipt.taskId,
      planDigest: receipt.runtimeBinding.planDigest,
      maximumExecutions: 1,
      maximumWireCalls: 2,
    });
    expectedAuthorizationDigest = CANONICAL_DIGEST({
      authorizationId: receipt.authorizationId,
      reservationId: receipt.reservationId,
      manifestDigest: receipt.manifestDigest,
      credentialAttestationDigest: receipt.credentialAttestationDigest,
      settlementObserverDigest: receipt.settlementObserverDigest,
      ledgerIdentityDigest: receipt.ledgerAuthorization.ledgerIdentityDigest,
      reservationDigest: receipt.ledgerAuthorization.reservationDigest,
      maximumExecutions: 1,
      maximumWireCalls: 2,
      maximumRepairCallsPerExecution: 1,
      evidenceBinding: receipt.ledgerAuthorization.evidenceBinding,
    });
    runtimeBindingDigest = CANONICAL_DIGEST(receipt.runtimeBinding);
  } catch {
    return false;
  }
  return (
    receipt.classification === "DISPATCH_PREFLIGHT_RECEIPT_ONLY" &&
    receipt.evidenceClass === "copy_gateway_settlement_candidate" &&
    receipt.evidenceKind === "capability_pilot" &&
    receipt.taskId === "site_builder.copy" &&
    (receipt.wireCount === 1 || receipt.wireCount === 2) &&
    receipt.repaired === (receipt.wireCount === 2) &&
    receipt.repeatIndex === null &&
    receipt.runtimeBinding.schemaVersion ===
      "copy-real-capability-runtime-binding/2026-08-08-v4" &&
    receipt.runtimeBinding.taskId === receipt.taskId &&
    receipt.runtimeBinding.fixedSourceCommit === receipt.fixedSourceCommit &&
    /^[0-9a-f]{40}$/u.test(receipt.runtimeBinding.preparationHeadCommit) &&
    receipt.runtimeBinding.sourceBundleDigest === receipt.sourceBundleDigest &&
    receipt.runtimeBinding.manifestDigest === receipt.manifestDigest &&
    /^[0-9a-f]{64}$/u.test(receipt.runtimeBinding.manifestArtifactDigest) &&
    receipt.runtimeBinding.expectedCompiledRuntimeDigest ===
      receipt.compiledRuntimeDigest &&
    receipt.runtimeBinding.credentialAttestationDigest ===
      receipt.credentialAttestationDigest &&
    receipt.runtimeBinding.settlementObserverDigest ===
      receipt.settlementObserverDigest &&
    receipt.runtimeBinding.globalAuthorizationDigest ===
      receipt.globalAuthorizationDigest &&
    receipt.runtimeBinding.childAuthorizationDigest ===
      receipt.childAuthorizationDigest &&
    receipt.runtimeBinding.selectedExecutionKey === receipt.executionId &&
    receipt.runtimeBinding.childCampaignId === receipt.campaignId &&
    receipt.runtimeBinding.gitReviewedEvidenceAcceptanceSchemaVersion ===
      GIT_REVIEWED_EVIDENCE_ACCEPTANCE_SCHEMA_VERSION &&
    receipt.compiledBindingDigest === runtimeBindingDigest &&
    receipt.ledgerAuthorization.evidenceBinding?.schemaVersion ===
      "real-model-execution-evidence-binding/2026-08-07-v1" &&
    receipt.ledgerAuthorization.evidenceBinding.executionId ===
      receipt.executionId &&
    receipt.ledgerAuthorization.evidenceBinding.childSlotId ===
      receipt.childSlotId &&
    receipt.ledgerAuthorization.evidenceBinding.alias === receipt.alias &&
    receipt.ledgerAuthorization.evidenceBinding.protocol === receipt.protocol &&
    receipt.ledgerAuthorization.evidenceBinding.reasoning ===
      receipt.reasoning &&
    receipt.ledgerAuthorization.evidenceBinding.fixtureId ===
      receipt.fixtureId &&
    receipt.ledgerAuthorization.evidenceBinding.executionPlanDigest ===
      receipt.planDigest &&
    receipt.ledgerAuthorization.evidenceBinding.inputDigest ===
      receipt.inputDigest &&
    receipt.ledgerAuthorization.evidenceBinding.contextDigest ===
      receipt.contextDigest &&
    receipt.ledgerAuthorization.evidenceBinding.promptDigest ===
      receipt.promptDigest &&
    receipt.ledgerAuthorization.evidenceBinding.fixedSourceCommit ===
      receipt.fixedSourceCommit &&
    receipt.ledgerAuthorization.evidenceBinding.sourceBundleDigest ===
      receipt.sourceBundleDigest &&
    receipt.ledgerAuthorization.evidenceBinding.manifestDigest ===
      receipt.manifestDigest &&
    receipt.ledgerAuthorization.evidenceBinding.admissionDigest ===
      receipt.admissionDigest &&
    receipt.ledgerAuthorization.evidenceBinding.globalAuthorizationDigest ===
      receipt.globalAuthorizationDigest &&
    receipt.ledgerAuthorization.evidenceBinding.childAuthorizationDigest ===
      receipt.childAuthorizationDigest &&
    receipt.ledgerAuthorization.evidenceBinding.compiledRuntimeDigest ===
      receipt.compiledRuntimeDigest &&
    receipt.ledgerAuthorization.evidenceBinding.compiledBindingDigest ===
      receipt.compiledBindingDigest &&
    CANONICAL_DIGEST(receipt.ledgerCampaign) === expectedCampaignDigest &&
    CANONICAL_DIGEST(receipt.ledgerAuthorization) ===
      expectedAuthorizationDigest &&
    receipt.settlementChain.executionId === receipt.executionId &&
    receipt.settlementChain.executionClaim.planDigest === receipt.planDigest &&
    receipt.settlementChain.wires.length === receipt.wireCount &&
    receipt.settlementChain.completion.outputDigest === receipt.outputDigest &&
    settlementWiresMatchReceipt(receipt)
  );
}

function challengeReceipt(
  challenge: CopyGitEvidenceAcceptanceChallenge,
): CopyRealCapabilityReceipt {
  if (
    !exactObjectKeys(challenge, [
      "schemaVersion",
      "candidateReceiptDigest",
      "receipt",
    ])
  ) {
    fail("COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH");
  }
  const receipt = challenge?.receipt as unknown;
  if (!exactCopyReceipt(receipt)) {
    fail("COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH");
  }
  let candidateReceiptDigest: string;
  let settlementChainDigest: string;
  try {
    candidateReceiptDigest = CANONICAL_DIGEST(receipt);
    const { digest: _digest, ...settlementChain } = receipt.settlementChain;
    settlementChainDigest = CANONICAL_DIGEST(settlementChain);
  } catch {
    return fail("COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH");
  }
  if (
    challenge?.schemaVersion !==
      "site-builder-copy-git-evidence-acceptance-challenge/2026-08-07-v1" ||
    challenge.candidateReceiptDigest !== candidateReceiptDigest ||
    receipt.knownSettlementDigest !== receipt.settlementChain.digest ||
    receipt.settlementChain.digest !== settlementChainDigest
  ) {
    fail("COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH");
  }
  return receipt;
}

export function createCopyGitEvidenceAcceptanceArtifact(input: {
  artifactId: string;
  challenge: CopyGitEvidenceAcceptanceChallenge;
}): GitReviewedEvidenceAcceptanceArtifact {
  const receipt = challengeReceipt(input.challenge);
  return createGitReviewedEvidenceAcceptanceArtifact({
    artifactId: input.artifactId,
    acceptedEvidenceClass: "git_reviewed_gateway_settlement_accepted",
    taskId: "site_builder.copy",
    evidenceKind: "capability_pilot",
    candidateReceipt: receipt as unknown as Readonly<Record<string, unknown>>,
    subject: copyAcceptanceSubject(receipt),
  });
}

export function getCopyGitAcceptedExecutionAttestation(
  execution: CopyGitAcceptedExecution,
): CopyGitAcceptedExecutionAttestation | undefined {
  return GET_GIT_ACCEPTED_EXECUTION(execution);
}

async function acceptCopyGitReviewedEvidence(input: {
  detail: CopyGitEvidenceAcceptanceDetail;
  acceptance: VerifiedGitReviewedEvidenceAcceptance;
  liveDetail?: CopyRealCapabilityRuntimeDetail;
  reviewed?: ReviewedCopyReceipt;
}): Promise<CopyGitAcceptedExecution> {
  const { accepted, receipt, candidateReceiptDigest } =
    input.reviewed ?? reviewedCopyReceipt(input.acceptance);
  let execution: CopyCapabilitySelectedExecution | undefined;
  let plan: ReturnType<typeof createCopyCapabilityExecutionPlan> | undefined;
  if (input.liveDetail != null) {
    validateCopyCapabilityAdmissionEnvelope(input.liveDetail.admission);
    execution = selectedExecutionFor(input.liveDetail.admission);
    if (execution?.executionKey !== receipt.executionId) {
      fail("COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH");
    }
    plan = executionPlanFor(execution, input.detail.campaignId);
    await assertCopyPilotTrustedGatewayCurrent(input.liveDetail.trustedGateway);
    await assertCopyPilotVerifiedSourceCurrent(input.liveDetail.verifiedSource);
    await ASSERT_COMPILED_CURRENT(input.liveDetail.compiledGuard);
    const compiled = GET_COMPILED_ATTESTATION(input.liveDetail.compiledGuard);
    if (
      compiled == null ||
      receipt.fixedSourceCommit !== input.liveDetail.source.fixedSourceCommit ||
      receipt.sourceBundleDigest !==
        input.liveDetail.source.sourceBundleDigest ||
      receipt.manifestDigest !== input.liveDetail.source.manifestDigest ||
      receipt.compiledRuntimeDigest !== compiled.artifactTreeDigest ||
      receipt.compiledBindingDigest !== compiled.bindingDigest
    ) {
      fail("COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH");
    }
  } else if (!historicalReceiptBindingIsExact(receipt)) {
    fail("COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH");
  }
  await assertCopyPilotLedgerIdentityCurrent(
    input.detail.ledgerIdentity.handle,
  );
  if (
    receipt.classification !== "DISPATCH_PREFLIGHT_RECEIPT_ONLY" ||
    receipt.evidenceClass !== "copy_gateway_settlement_candidate" ||
    receipt.evidenceKind !== "capability_pilot" ||
    receipt.taskId !== "site_builder.copy" ||
    receipt.campaignId !== input.detail.campaignId ||
    (receipt.wireCount !== 1 && receipt.wireCount !== 2) ||
    receipt.repaired !== (receipt.wireCount === 2) ||
    receipt.repeatIndex !== null ||
    receipt.ledgerCampaign.campaignId !== input.detail.campaignId
  ) {
    fail("COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH");
  }
  if (
    input.liveDetail != null &&
    execution != null &&
    plan != null &&
    (receipt.alias !== execution.alias ||
      receipt.protocol !== execution.protocol ||
      receipt.reasoning !== execution.reasoning ||
      receipt.fixtureId !== COPY_CAPABILITY_PILOT_PLAN.source.fixtureId ||
      receipt.planDigest !== executionPlanDigest(plan) ||
      receipt.inputDigest !== plan.inputDigest ||
      receipt.contextDigest !== plan.contextDigest ||
      receipt.promptDigest !== CANONICAL_DIGEST(plan.prompt) ||
      receipt.fixedSourceCommit !==
        input.liveDetail.admission.manifest.fixedSourceCommit ||
      receipt.sourceBundleDigest !==
        input.liveDetail.admission.manifest.sourceBundleDigest ||
      receipt.manifestDigest !==
        CANONICAL_DIGEST(input.liveDetail.admission.manifest) ||
      receipt.admissionDigest !==
        CANONICAL_DIGEST(input.liveDetail.admission) ||
      receipt.credentialAttestationDigest !==
        CANONICAL_DIGEST(input.liveDetail.admission.credential) ||
      receipt.settlementObserverDigest !==
        CANONICAL_DIGEST(input.liveDetail.admission.settlement) ||
      receipt.authorizationId !==
        input.liveDetail.admission.childAuthorization.authorizationId ||
      receipt.reservationId !==
        input.liveDetail.admission.childAuthorization.reservationId ||
      receipt.globalAuthorizationDigest !==
        CANONICAL_DIGEST(input.liveDetail.admission.authorization) ||
      receipt.childAuthorizationDigest !==
        CANONICAL_DIGEST(input.liveDetail.admission.childAuthorization) ||
      receipt.childSlotId !==
        input.liveDetail.admission.childAuthorization.childSlotId ||
      receipt.compiledBindingDigest !==
        CANONICAL_DIGEST(
          runtimeBinding({
            admission: input.liveDetail.admission,
            source: input.liveDetail.source,
          }),
        ))
  ) {
    fail("COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH");
  }
  let settlementChain: RealKnownSettlementEvidence;
  try {
    settlementChain =
      await input.detail.ledger.executionKnownSettlementEvidence(
        receipt.executionId,
        receipt.planDigest,
      );
  } catch {
    return fail("COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH");
  }
  if (
    receipt.knownSettlementDigest !== settlementChain.digest ||
    CANONICAL_DIGEST(receipt.settlementChain) !==
      CANONICAL_DIGEST(settlementChain)
  ) {
    fail("COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH");
  }
  const ledgerAcceptance = {
    acceptanceId: accepted.artifactId,
    artifactDigest: accepted.artifactDigest,
    artifactCommit: accepted.artifactCommit,
    mergeCommit: accepted.mergeCommit,
    pullRequestNumber: accepted.pullRequestNumber,
    acceptedEvidenceClass: accepted.acceptedEvidenceClass,
    evidenceKind: accepted.evidenceKind,
    candidateReceiptDigest,
    executionId: receipt.executionId,
    planDigest: receipt.planDigest,
    outputDigest: receipt.outputDigest,
    candidateLedgerDigest: receipt.ledgerDigest,
    fixedSourceCommit: receipt.fixedSourceCommit,
    sourceBundleDigest: receipt.sourceBundleDigest,
    manifestDigest: receipt.manifestDigest,
    compiledRuntimeDigest: receipt.compiledRuntimeDigest,
    compiledBindingDigest: receipt.compiledBindingDigest,
    settlementObserverDigest: receipt.settlementObserverDigest,
    knownSettlementDigest: receipt.knownSettlementDigest,
    alias: receipt.alias,
    protocol: receipt.protocol,
    reasoning: receipt.reasoning,
  } as const;
  const existingAcceptance =
    await input.detail.ledger.gitEvidenceAcceptanceDigest(ledgerAcceptance);
  if (existingAcceptance == null) {
    const before = await input.detail.ledger.summary();
    if (
      before.frozen ||
      before.completedExecutions !== 1 ||
      before.executionClaims !== 1 ||
      before.wireClaims !== receipt.wireCount ||
      before.knownWireSettlements !== receipt.wireCount ||
      before.unknownWireSettlements !== 0 ||
      before.gitEvidenceAcceptances !== 0
    ) {
      fail("COPY_GIT_EVIDENCE_LEDGER_MISMATCH");
    }
  }
  await assertGitReviewedEvidenceAcceptanceCurrent(input.acceptance);
  await assertCopyPilotLedgerIdentityCurrent(
    input.detail.ledgerIdentity.handle,
  );
  const evidenceLedgerDigest =
    await input.detail.ledger.consumeGitEvidenceAcceptance(ledgerAcceptance);
  const authorized = FREEZE_OBJECT({
    classification: "OPAQUE_COPY_GIT_ACCEPTED_EXECUTION" as const,
  });
  SET_GIT_ACCEPTED_EXECUTION(
    authorized,
    FREEZE_OBJECT({
      classification: "GIT_REVIEWED_REAL_EVIDENCE" as const,
      evidenceClass: "git_reviewed_gateway_settlement_accepted" as const,
      evidenceKind: "capability_pilot" as const,
      acceptanceId: accepted.artifactId,
      artifactDigest: accepted.artifactDigest,
      artifactCommit: accepted.artifactCommit,
      mergeCommit: accepted.mergeCommit,
      pullRequestNumber: accepted.pullRequestNumber,
      candidateReceiptDigest,
      candidateLedgerDigest: receipt.ledgerDigest,
      evidenceLedgerDigest,
      executionId: receipt.executionId,
      outputDigest: receipt.outputDigest,
      alias: receipt.alias,
      protocol: receipt.protocol,
      reasoning: receipt.reasoning,
      fixedSourceCommit: receipt.fixedSourceCommit,
      sourceBundleDigest: receipt.sourceBundleDigest,
      manifestDigest: receipt.manifestDigest,
      compiledRuntimeDigest: receipt.compiledRuntimeDigest,
      compiledBindingDigest: receipt.compiledBindingDigest,
      settlementObserverDigest: receipt.settlementObserverDigest,
      knownSettlementDigest: receipt.knownSettlementDigest,
    }),
  );
  return authorized;
}

export async function acceptCopyGatewaySettlementCandidate(input: {
  runner: CopyRealCapabilityRunner;
  acceptance: VerifiedGitReviewedEvidenceAcceptance;
}): Promise<CopyGitAcceptedExecution> {
  const detail = GET_REAL_CAPABILITY_RUNNER(input.runner);
  if (!detail) fail("COPY_REAL_CAPABILITY_TRUSTED_CHILD_RUNNER_REQUIRED");
  return acceptCopyGitReviewedEvidence({
    detail,
    acceptance: input.acceptance,
    liveDetail: detail,
  });
}

export async function reopenCopyGitEvidenceAcceptanceRunner(input: {
  ledgerPath: string;
  authorizationClaimPath: string;
  ledgerMarkerPath: string;
  campaignId: string;
}): Promise<CopyGitEvidenceAcceptanceRunner> {
  assertCompiledEntrypoint();
  if (!exactObjectKeys(input, EVIDENCE_REOPEN_INPUT_KEYS)) {
    fail("COPY_GIT_EVIDENCE_REOPEN_INPUT_INVALID");
  }
  const runner = FREEZE_OBJECT({
    acceptGitReviewedEvidence: async (acceptanceInput: {
      acceptance: VerifiedGitReviewedEvidenceAcceptance;
    }) => {
      if (!exactObjectKeys(acceptanceInput, EVIDENCE_ACCEPT_INPUT_KEYS)) {
        fail("COPY_GIT_EVIDENCE_ACCEPTANCE_INPUT_INVALID");
      }
      const reviewed = reviewedCopyReceipt(acceptanceInput.acceptance);
      const { receipt } = reviewed;
      if (
        receipt.campaignId !== input.campaignId ||
        !historicalReceiptBindingIsExact(receipt)
      ) {
        fail("COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH");
      }
      let ledgerIdentity: Awaited<
        ReturnType<typeof loadCopyPilotLedgerIdentity>
      >;
      let ledger: RealModelExecutionLedger;
      try {
        ledgerIdentity = await loadCopyPilotLedgerIdentity({
          ledgerPath: input.ledgerPath,
          authorizationClaimPath: input.authorizationClaimPath,
          markerPath: input.ledgerMarkerPath,
          campaignId: input.campaignId,
        });
        if (
          receipt.ledgerAuthorization.ledgerIdentityDigest !==
          ledgerIdentity.ledgerIdentityDigest
        ) {
          fail("COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH");
        }
        await assertCopyPilotLedgerIdentityCurrent(ledgerIdentity.handle);
        ledger = await RealModelExecutionLedger.reopen({
          ledgerPath: input.ledgerPath,
          authorizationClaimPath: input.authorizationClaimPath,
          campaign: receipt.ledgerCampaign,
          authorization: receipt.ledgerAuthorization,
        });
      } catch {
        return fail("COPY_GIT_EVIDENCE_CANDIDATE_MISMATCH");
      }
      const accepted = await acceptCopyGitReviewedEvidence({
        detail: {
          ledger,
          ledgerIdentity,
          campaignId: input.campaignId,
        },
        acceptance: acceptanceInput.acceptance,
        reviewed,
      });
      SET_EVIDENCE_REOPEN_LEDGER(runner, ledger);
      return accepted;
    },
    summary: () => {
      const ledger = GET_EVIDENCE_REOPEN_LEDGER(runner);
      if (!ledger) fail("COPY_GIT_EVIDENCE_ACCEPTANCE_REQUIRED");
      return ledger.summary();
    },
  });
  return runner;
}

async function createCopyCapabilityChildRunner(input: {
  ledgerPath: string;
  authorizationClaimPath: string;
  ledgerMarkerPath: string;
  campaignId: string;
  admission: CopyCapabilityAdmissionInput;
  verifiedSource: CopyPilotVerifiedSource;
  trustedGateway: CopyPilotTrustedGateway;
}): Promise<CopyRealCapabilityRunner> {
  assertCompiledEntrypoint();
  validateCopyCapabilityAdmissionEnvelope(input.admission);
  const source = requireCopyPilotVerifiedSourceBinding(input.verifiedSource);
  const gatewayBinding = getCopyPilotTrustedAdmissionBinding(
    input.trustedGateway,
  );
  if (
    input.campaignId !== input.admission.childAuthorization.campaignId ||
    source.repositoryRoot !== realpathSync(LOADED_REPOSITORY_ROOT) ||
    source.fixedSourceCommit !== input.admission.manifest.fixedSourceCommit ||
    source.sourceBundleDigest !== input.admission.manifest.sourceBundleDigest ||
    source.manifestDigest !== CANONICAL_DIGEST(input.admission.manifest) ||
    gatewayBinding == null ||
    gatewayBinding.manifestDigest !== source.manifestDigest ||
    gatewayBinding.credentialAttestationDigest !==
      CANONICAL_DIGEST(input.admission.credential) ||
    gatewayBinding.settlementObserverDigest !==
      CANONICAL_DIGEST(input.admission.settlement) ||
    gatewayBinding.globalAuthorizationDigest !==
      CANONICAL_DIGEST(input.admission.authorization) ||
    gatewayBinding.childAuthorizationDigest !==
      CANONICAL_DIGEST(input.admission.childAuthorization) ||
    gatewayBinding.executionKey !== input.admission.selectedExecutionKey ||
    gatewayBinding.childCampaignId !==
      input.admission.childAuthorization.campaignId ||
    gatewayBinding.childAuthorizationId !==
      input.admission.childAuthorization.authorizationId ||
    gatewayBinding.childReservationId !==
      input.admission.childAuthorization.reservationId
  ) {
    fail("COPY_REAL_CAPABILITY_ADMISSION_BINDING_MISMATCH");
  }
  const ledgerIdentity = await loadCopyPilotLedgerIdentity({
    ledgerPath: input.ledgerPath,
    authorizationClaimPath: input.authorizationClaimPath,
    markerPath: input.ledgerMarkerPath,
    campaignId: input.campaignId,
  });
  const { reservationDigest, ...authorizationWithoutReservationDigest } =
    input.admission.childAuthorization;
  if (
    input.admission.childAuthorization.ledgerIdentityDigest !==
      ledgerIdentity.ledgerIdentityDigest ||
    reservationDigest !==
      recoveryAwareReservationDigest(
        input.admission,
        authorizationWithoutReservationDigest,
      )
  ) {
    fail("COPY_REAL_CAPABILITY_RESERVATION_BINDING_MISMATCH");
  }

  const selectedExecution = selectedExecutionFor(input.admission);
  const selectedChild = input.admission.authorization.children.find(
    ({ childSlotId }) =>
      childSlotId === input.admission.childAuthorization.childSlotId,
  );
  if (
    selectedExecution == null ||
    selectedChild == null ||
    selectedChild.executionKey !== selectedExecution.executionKey ||
    selectedChild.alias !== selectedExecution.alias ||
    selectedChild.protocol !== selectedExecution.protocol ||
    selectedChild.reasoning !== selectedExecution.reasoning
  ) {
    fail("COPY_REAL_CAPABILITY_ADMISSION_BINDING_MISMATCH");
  }
  const selectedExecutionPlan = executionPlanFor(
    selectedExecution,
    input.campaignId,
  );

  const compiledGuard = await createCompiledRuntimeGuard({
    repositoryRoot: LOADED_REPOSITORY_ROOT,
    artifactPaths: artifactPathsFor(input.admission),
    binding: runtimeBinding({ admission: input.admission, source }),
    expectation: source.compiledRuntimeExpectation,
  });
  await ASSERT_COMPILED_CURRENT(compiledGuard);
  const compiledAtOpen = GET_COMPILED_ATTESTATION(compiledGuard);
  if (compiledAtOpen == null) {
    fail("COPY_REAL_CAPABILITY_COMPILED_ATTESTATION_REQUIRED");
  }
  if (
    compiledAtOpen.artifactTreeDigest !==
    source.compiledRuntimeExpectation.artifactTreeDigest
  ) {
    fail("COPY_REAL_CAPABILITY_COMPILED_EXPECTATION_MISMATCH");
  }
  const ledgerEvidenceBinding = FREEZE_OBJECT({
    schemaVersion:
      "real-model-execution-evidence-binding/2026-08-07-v1" as const,
    executionId: input.admission.selectedExecutionKey,
    childSlotId: selectedChild.childSlotId,
    alias: selectedExecution.alias,
    protocol: selectedExecution.protocol,
    reasoning: selectedExecution.reasoning,
    fixtureId: selectedExecution.fixtureId,
    executionPlanDigest: executionPlanDigest(selectedExecutionPlan),
    inputDigest: selectedExecutionPlan.inputDigest,
    contextDigest: selectedExecutionPlan.contextDigest,
    promptDigest: CANONICAL_DIGEST(selectedExecutionPlan.prompt),
    fixedSourceCommit: source.fixedSourceCommit,
    sourceBundleDigest: source.sourceBundleDigest,
    manifestDigest: source.manifestDigest,
    admissionDigest: CANONICAL_DIGEST(input.admission),
    globalAuthorizationDigest: CANONICAL_DIGEST(input.admission.authorization),
    childAuthorizationDigest: CANONICAL_DIGEST(
      input.admission.childAuthorization,
    ),
    compiledRuntimeDigest: compiledAtOpen.artifactTreeDigest,
    compiledBindingDigest: compiledAtOpen.bindingDigest,
  });
  const ledgerAuthorization = childLedgerAuthorization(
    input.admission.childAuthorization,
    ledgerEvidenceBinding,
  );
  const ledger = await RealModelExecutionLedger.open({
    ledgerPath: input.ledgerPath,
    authorizationClaimPath: input.authorizationClaimPath,
    campaign: childLedgerCampaign({
      campaignId: input.campaignId,
      manifest: input.admission.manifest,
    }),
    authorization: ledgerAuthorization,
  });
  await markCopyPilotLedgerIdentityClaimed(ledgerIdentity.handle, {
    authorizationDigest: CANONICAL_DIGEST(ledgerAuthorization),
  });
  await assertCopyPilotLedgerIdentityCurrent(ledgerIdentity.handle);
  const gateway = createCopyPilotTrustedGatewayBindings(input.trustedGateway);

  const runner = FREEZE_OBJECT({
    execute: async (executionKey: string) => {
      if (GET_BATCH_DISPATCH_AUTHORIZATION(runner) !== executionKey) {
        fail("COPY_REAL_CAPABILITY_BATCH_RUNNER_REQUIRED");
      }
      DELETE_BATCH_DISPATCH_AUTHORIZATION(runner);
      validateCopyCapabilityAdmissionEnvelope(input.admission);
      await assertCopyPilotTrustedGatewayCurrent(input.trustedGateway);
      await assertCopyPilotVerifiedSourceCurrent(input.verifiedSource);
      await ASSERT_COMPILED_CURRENT(compiledGuard);
      if (executionKey !== input.admission.selectedExecutionKey) {
        fail("COPY_REAL_CAPABILITY_CHILD_EXECUTION_MISMATCH");
      }
      const execution = selectedExecution;
      const plan = selectedExecutionPlan;
      const transport: ModelTransport<CopyTaskInput, CopyTaskOutput> = {
        dispatch: async (currentPlan) => {
          const prompt =
            typeof currentPlan.prompt.user === "string"
              ? currentPlan.prompt.user
              : fail("COPY_REAL_CAPABILITY_PROMPT_INVALID");
          const compiledPrompt =
            currentPlan.prompt.repair == null
              ? prompt
              : `${prompt}\n\nClosed repair payload:\n${JSON.stringify(
                  currentPlan.prompt.repair,
                )}`;
          let native:
            | NativeModelAdapterResult<CopyTaskOutput>
            | NativeModelOutputError
            | NativeModelApiError;
          try {
            native = await gateway.execute<CopyTaskOutput>(execution.protocol, {
              alias: execution.alias,
              system:
                typeof currentPlan.prompt.system === "string"
                  ? currentPlan.prompt.system
                  : undefined,
              prompt: compiledPrompt,
              outputSchema: currentPlan.contract.outputSchema,
              outputSchemaName: "copy_capability_output",
              reasoning: {
                effort: execution.reasoning,
              },
              maxOutputTokens: execution.maximumOutputTokens,
              abortSignal: AbortSignal.timeout(execution.timeoutMs),
            });
          } catch (error) {
            if (
              !(error instanceof NativeModelOutputError) &&
              !(error instanceof NativeModelApiError)
            ) {
              throw error;
            }
            native = error;
          }
          const adapterUsage =
            native instanceof NativeModelApiError ? {} : (native.usage ?? {});
          const requestId = native.requestId ?? null;
          const settlement = await gateway.resolve({
            requestId,
            alias: execution.alias,
            protocol: execution.protocol,
            expectedChannelId: gateway.channelIdFor(
              execution.alias,
              execution.protocol,
            ),
            usage: adapterUsage,
            maxOutputTokens: execution.maximumOutputTokens,
            maximumQuotaPoints:
              input.admission.credential.maximumQuotaPointsPerWire,
          });
          const settlementProof = gateway.trustedSettlementProof(settlement);
          const usage =
            native instanceof NativeModelApiError &&
            settlement.status === "settled"
              ? {
                  inputTokens: settlement.inputTokens,
                  outputTokens: settlement.outputTokens,
                }
              : adapterUsage;
          const usageComplete = completeUsage(usage);
          const reportedModel =
            native instanceof NativeModelApiError
              ? settlement.status === "settled"
                ? settlement.alias
                : undefined
              : native.reportedModel;
          const settled =
            settlement.status === "settled" &&
            settlementProof != null &&
            settlementProof.gatewayOrigin ===
              input.admission.credential.gatewayOrigin &&
            settlementProof.bearerTokenSha256 ===
              input.admission.credential.bearerTokenSha256 &&
            settlementProof.credentialAttestationDigest ===
              CANONICAL_DIGEST(input.admission.credential) &&
            settlementProof.globalAuthorizationDigest ===
              CANONICAL_DIGEST(input.admission.authorization) &&
            settlementProof.childAuthorizationDigest ===
              CANONICAL_DIGEST(input.admission.childAuthorization) &&
            settlementProof.executionKey ===
              input.admission.selectedExecutionKey &&
            usageComplete &&
            reportedModel === execution.alias &&
            (!(native instanceof NativeModelOutputError) ||
              native.rawOutputText != null);
          const settlementReason =
            settlement.status === "unknown"
              ? settlement.reason
              : "settlement_proof_invalid";
          const apiFailureReason =
            native instanceof NativeModelApiError
              ? nativeApiFailureReason(native, settlementReason)
              : undefined;
          const observation: ModelObservation<CopyTaskOutput> = FREEZE_OBJECT({
            output:
              native instanceof NativeModelOutputError
                ? invalidOutput(native)
                : native instanceof NativeModelApiError
                  ? ({} as CopyTaskOutput)
                  : native.output,
            requestedAlias: native.requestedModel,
            resolvedAlias: execution.alias,
            ...(reportedModel == null ? {} : { reportedModel }),
            protocol: runtimeProtocol(native.protocol),
            usage: {
              inputTokens: usage.inputTokens ?? -1,
              outputTokens: usage.outputTokens ?? -1,
              ...(usage.cacheReadTokens == null
                ? {}
                : { cacheReadTokens: usage.cacheReadTokens }),
              ...(usage.cacheWriteTokens == null
                ? {}
                : { cacheCreationTokens: usage.cacheWriteTokens }),
            },
            usageComplete,
            ...(requestId == null ? {} : { requestId }),
            settlement: settled ? "known" : "unknown",
            ...(!settled && apiFailureReason != null
              ? { settlementUnknownReason: apiFailureReason }
              : {}),
            ...(settled ? { settlementProof: settlement } : {}),
            ...(native instanceof NativeModelApiError &&
            native.responseShape != null
              ? { responseShape: native.responseShape }
              : {}),
            warnings: FREEZE_OBJECT(
              native instanceof NativeModelOutputError
                ? []
                : native instanceof NativeModelApiError
                  ? [
                      nativeApiFailureReason(
                        native,
                        settled ? "settled" : settlementReason,
                      ),
                    ]
                  : native.warnings.map(({ type, feature, details }) =>
                      [type, feature, details].filter(Boolean).join(":"),
                    ),
            ),
          });
          return observation;
        },
      };
      let completed = false;
      const result = await new DurableModelExecutionRuntime<
        CopyTaskInput,
        CopyTaskOutput
      >({
        ledger,
        expectedEvidenceClass: "gateway_settlement_claim_only",
        transport,
        repairCompiler: createCopyCapabilityRepairCompiler(),
        preWireGuard: async () => {
          validateCopyCapabilityAdmissionEnvelope(input.admission);
          await assertCopyPilotTrustedGatewayCurrent(input.trustedGateway);
          await assertCopyPilotVerifiedSourceCurrent(input.verifiedSource);
          await assertCopyPilotLedgerIdentityCurrent(ledgerIdentity.handle);
          await ASSERT_COMPILED_CURRENT(compiledGuard);
        },
        postWireGuard: async () => {
          await assertCopyPilotLedgerIdentityCurrent(ledgerIdentity.handle);
          await ASSERT_COMPILED_CURRENT(compiledGuard);
        },
        completionGuard: async ({ result: candidate, wireCount }) => {
          await ASSERT_COMPILED_CURRENT(compiledGuard);
          await assertCopyPilotLedgerIdentityCurrent(ledgerIdentity.handle);
          const metadata = GET_TRUSTED_METADATA(candidate);
          const compiled = GET_COMPILED_ATTESTATION(compiledGuard);
          if (
            (wireCount !== 1 && wireCount !== 2) ||
            candidate.transportAttempts !== wireCount ||
            candidate.repairAttempts !== wireCount - 1 ||
            metadata?.executionId !== execution.executionKey ||
            metadata.resolvedAlias !== execution.alias ||
            metadata.protocol !== execution.protocol ||
            metadata.reasoning !== execution.reasoning ||
            metadata.settlement !== "known" ||
            compiled == null ||
            compiled.artifactCount !==
              artifactPathsFor(input.admission).length ||
            compiled.bindingDigest !==
              CANONICAL_DIGEST(
                runtimeBinding({ admission: input.admission, source }),
              )
          ) {
            fail("COPY_REAL_CAPABILITY_COMPLETION_INCOMPLETE");
          }
          completed = true;
        },
      }).execute(plan);

      try {
        await ASSERT_COMPILED_CURRENT(compiledGuard);
        const durable = GET_DURABLE_ATTESTATION(result);
        const metadata = GET_TRUSTED_METADATA(result);
        const compiled = GET_COMPILED_ATTESTATION(compiledGuard);
        if (
          !completed ||
          durable?.evidenceClass !== "gateway_settlement_claim_only" ||
          (durable.wireCount !== 1 && durable.wireCount !== 2) ||
          metadata?.settlement !== "known" ||
          metadata.resolvedAlias !== execution.alias ||
          compiled == null
        ) {
          fail("COPY_REAL_CAPABILITY_RECEIPT_INCOMPLETE");
        }
        const settlementChain = await ledger.executionKnownSettlementEvidence(
          durable.executionId,
          executionPlanDigest(plan),
        );
        const receipt = FREEZE_OBJECT({
          classification: "DISPATCH_PREFLIGHT_RECEIPT_ONLY" as const,
          evidenceClass: "copy_gateway_settlement_candidate" as const,
          evidenceKind: "capability_pilot" as const,
          taskId: "site_builder.copy" as const,
          campaignId: durable.campaignId,
          executionId: durable.executionId,
          alias: metadata.resolvedAlias,
          protocol: metadata.protocol,
          reasoning: metadata.reasoning,
          wireCount: durable.wireCount,
          repaired: durable.wireCount === 2,
          fixtureId: COPY_CAPABILITY_PILOT_PLAN.source.fixtureId,
          repeatIndex: null,
          planDigest: executionPlanDigest(plan),
          inputDigest: plan.inputDigest,
          contextDigest: plan.contextDigest,
          promptDigest: CANONICAL_DIGEST(plan.prompt),
          ledgerDigest: durable.ledgerDigest,
          outputDigest: durable.outputDigest,
          fixedSourceCommit: source.fixedSourceCommit,
          sourceBundleDigest: source.sourceBundleDigest,
          manifestDigest: source.manifestDigest,
          admissionDigest: CANONICAL_DIGEST(input.admission),
          credentialAttestationDigest: CANONICAL_DIGEST(
            input.admission.credential,
          ),
          settlementObserverDigest: CANONICAL_DIGEST(
            input.admission.settlement,
          ),
          knownSettlementDigest: settlementChain.digest,
          settlementChain,
          authorizationId: input.admission.childAuthorization.authorizationId,
          reservationId: input.admission.childAuthorization.reservationId,
          globalAuthorizationDigest: CANONICAL_DIGEST(
            input.admission.authorization,
          ),
          childAuthorizationDigest: CANONICAL_DIGEST(
            input.admission.childAuthorization,
          ),
          childSlotId: input.admission.childAuthorization.childSlotId,
          ledgerCampaign: childLedgerCampaign({
            campaignId: input.campaignId,
            manifest: input.admission.manifest,
          }),
          ledgerAuthorization,
          runtimeBinding: runtimeBinding({
            admission: input.admission,
            source,
          }),
          compiledRuntimeDigest: compiled.artifactTreeDigest,
          compiledBindingDigest: compiled.bindingDigest,
        });
        SET_REAL_CAPABILITY_RECEIPT(result, receipt);
        SET_REAL_CAPABILITY_DETAIL(result, {
          receipt,
          ledger,
          ledgerIdentity,
          compiledGuard,
          verifiedSource: input.verifiedSource,
          trustedGateway: input.trustedGateway,
          admission: input.admission,
          source,
          campaignId: input.campaignId,
        });
      } catch (error) {
        await FREEZE_REAL_EXECUTION.call(
          ledger,
          plan.executionId,
          "real_capability_receipt_failed",
        );
        throw error;
      }
      return result;
    },
    acceptGitReviewedEvidence: (acceptanceInput: {
      acceptance: VerifiedGitReviewedEvidenceAcceptance;
    }) =>
      acceptCopyGitReviewedEvidence({
        detail: {
          ledger,
          ledgerIdentity,
          campaignId: input.campaignId,
        },
        acceptance: acceptanceInput.acceptance,
        liveDetail: {
          ledger,
          ledgerIdentity,
          compiledGuard,
          verifiedSource: input.verifiedSource,
          trustedGateway: input.trustedGateway,
          admission: input.admission,
          source,
          campaignId: input.campaignId,
        },
      }),
    summary: () => ledger.summary(),
  });
  SET_REAL_CAPABILITY_RUNNER(runner, {
    ledger,
    ledgerIdentity,
    compiledGuard,
    verifiedSource: input.verifiedSource,
    trustedGateway: input.trustedGateway,
    admission: input.admission,
    source,
    campaignId: input.campaignId,
  });
  return runner;
}

export function createCopyRealCapabilityRunner(input: {
  ledgerPath: string;
  authorizationClaimPath: string;
  ledgerMarkerPath: string;
  campaignId: string;
  admission: CopyRealCapabilityAdmissionInput;
  verifiedSource: CopyPilotVerifiedSource;
  trustedGateway: CopyPilotTrustedGateway;
}): Promise<CopyRealCapabilityRunner> {
  return createCopyCapabilityChildRunner(input);
}

export async function createCopySonnetRecoveryRunner(input: {
  ledgerPath: string;
  authorizationClaimPath: string;
  ledgerMarkerPath: string;
  campaignId: string;
  admission: CopySonnetRecoveryAdmissionInput;
  verifiedSource: CopyPilotVerifiedSource;
  trustedGateway: CopyPilotTrustedGateway;
}): Promise<CopySonnetRecoveryRunner> {
  const child = await createCopyCapabilityChildRunner(input);
  const executionKey = input.admission.selectedExecutionKey;
  const runner = FREEZE_OBJECT({
    execute: async (requestedExecutionKey: string) => {
      if (requestedExecutionKey !== executionKey) {
        fail("COPY_SONNET_RECOVERY_EXECUTION_MISMATCH");
      }
      SET_BATCH_DISPATCH_AUTHORIZATION(child, executionKey);
      try {
        return await child.execute(executionKey);
      } catch (error) {
        const detail =
          GET_REAL_CAPABILITY_RUNNER(child) ??
          fail("COPY_REAL_CAPABILITY_TRUSTED_CHILD_RUNNER_REQUIRED");
        await FREEZE_REAL_EXECUTION.call(
          detail.ledger,
          executionKey,
          "sonnet_recovery_execution_failed",
        );
        throw error;
      } finally {
        DELETE_BATCH_DISPATCH_AUTHORIZATION(child);
      }
    },
    acceptGitReviewedEvidence: (acceptanceInput: {
      acceptance: VerifiedGitReviewedEvidenceAcceptance;
    }) => child.acceptGitReviewedEvidence(acceptanceInput),
    summary: () => child.summary(),
  });
  const detail =
    GET_REAL_CAPABILITY_RUNNER(child) ??
    fail("COPY_REAL_CAPABILITY_TRUSTED_CHILD_RUNNER_REQUIRED");
  SET_REAL_CAPABILITY_RUNNER(runner, detail);
  return runner;
}

/**
 * Binds the three candidate-local runners into one batch guard. Candidate
 * settlement failures stay local; shared source, manifest, credential, or
 * aggregate authorization drift durably freezes every child campaign.
 */
export function createCopyRealCapabilityCampaignRunner(input: {
  runners: readonly CopyRealCapabilityRunner[];
}): CopyRealCapabilityCampaignRunner {
  const runners = FREEZE_OBJECT([...input.runners]);
  const details = runners.map((runner) => {
    const detail = GET_REAL_CAPABILITY_RUNNER(runner);
    return detail ?? fail("COPY_REAL_CAPABILITY_TRUSTED_CHILD_RUNNER_REQUIRED");
  });
  if (
    details.some(({ admission }) => isCopySonnetRecoveryAdmission(admission))
  ) {
    fail("COPY_REAL_CAPABILITY_CHILD_BATCH_MISMATCH");
  }
  const expectedKeys = COPY_CAPABILITY_PILOT_PLAN.childCampaigns.map(
    ({ executionKey }) => executionKey,
  );
  const actualKeys = details.map(
    ({ admission }) => admission.selectedExecutionKey,
  );
  const sharedBinding = details.map(({ admission, source }) =>
    CANONICAL_DIGEST({
      manifest: admission.manifest,
      credential: admission.credential,
      settlement: admission.settlement,
      authorization: admission.authorization,
      fixedSourceCommit: source.fixedSourceCommit,
      sourceBundleDigest: source.sourceBundleDigest,
    }),
  );
  if (
    details.length !== expectedKeys.length ||
    JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys) ||
    new Set(actualKeys).size !== expectedKeys.length ||
    new Set(details.map(({ campaignId }) => campaignId)).size !==
      expectedKeys.length ||
    new Set(
      details.map(
        ({ admission }) => admission.childAuthorization.authorizationId,
      ),
    ).size !== expectedKeys.length ||
    new Set(sharedBinding).size !== 1
  ) {
    fail("COPY_REAL_CAPABILITY_CHILD_BATCH_MISMATCH");
  }

  const freezeAll = async (reason: string): Promise<readonly unknown[]> => {
    const outcomes = await PROMISE_ALL_SETTLED(
      details.map(({ ledger, admission }) =>
        FREEZE_REAL_EXECUTION.call(
          ledger,
          admission.selectedExecutionKey,
          reason,
        ),
      ),
    );
    return outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
  };
  const throwAfterSharedFreeze = async (
    error: unknown,
    reason: string,
  ): Promise<never> => {
    const freezeFailures = await freezeAll(reason);
    if (freezeFailures.length > 0) {
      throw new AggregateError(
        [error, ...freezeFailures],
        `COPY_REAL_CAPABILITY_SHARED_FREEZE_INCOMPLETE:${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    throw error;
  };
  const assertSharedCurrent = async (): Promise<void> => {
    try {
      for (const [index, detail] of details.entries()) {
        const currentBinding = CANONICAL_DIGEST({
          manifest: detail.admission.manifest,
          credential: detail.admission.credential,
          settlement: detail.admission.settlement,
          authorization: detail.admission.authorization,
          fixedSourceCommit: detail.source.fixedSourceCommit,
          sourceBundleDigest: detail.source.sourceBundleDigest,
        });
        if (currentBinding !== sharedBinding[index]) {
          fail("COPY_REAL_CAPABILITY_SHARED_BINDING_DRIFT");
        }
        validateCopyCapabilityAdmissionEnvelope(detail.admission);
        await assertCopyPilotTrustedGatewayCurrent(detail.trustedGateway);
        await assertCopyPilotVerifiedSourceCurrent(detail.verifiedSource);
        await ASSERT_COMPILED_CURRENT(detail.compiledGuard);
      }
    } catch (error) {
      return throwAfterSharedFreeze(error, "shared_batch_preflight_drift");
    }
  };

  return FREEZE_OBJECT({
    execute: async (executionKey: string) => {
      const index = expectedKeys.indexOf(executionKey);
      if (index < 0) fail("COPY_CAPABILITY_EXECUTION_NOT_IN_PLAN");
      await assertSharedCurrent();
      try {
        SET_BATCH_DISPATCH_AUTHORIZATION(runners[index]!, executionKey);
        return await runners[index]!.execute(executionKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          /COMPILED_RUNTIME|VERIFIED_SOURCE|SHARED_BINDING|LIVE_SCOPE_OR_QUOTA|CREDENTIAL_TOKEN/u.test(
            message,
          )
        ) {
          return throwAfterSharedFreeze(error, "shared_batch_runtime_drift");
        }
        throw error;
      } finally {
        DELETE_BATCH_DISPATCH_AUTHORIZATION(runners[index]!);
      }
    },
    summaries: () => Promise.all(runners.map((runner) => runner.summary())),
  });
}
