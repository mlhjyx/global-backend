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
  RealModelExecutionLedger,
  type RealModelExecutionLedgerSummary,
} from "../../model-runtime/real-model-execution-ledger";
import { NativeModelOutputError } from "../../model-runtime/adapters/ai-sdk-native-adapter.contract";
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
  validateCopyRealCapabilityAdmissionEnvelope,
  type CopyRealCapabilityAdmissionInput,
} from "./copy-real-capability-admission";
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
import {
  assertCopyOperatorEvidenceAuthorizationCurrent,
  getCopyOperatorEvidenceAuthorizationAttestation,
  type VerifiedCopyOperatorEvidenceAuthorization,
} from "./copy-operator-evidence-authorization";
import {
  COPY_OPERATOR_EVIDENCE_KEY_ID,
  COPY_OPERATOR_EVIDENCE_PUBLIC_KEY_SHA256,
} from "./copy-operator-evidence-key";

const FREEZE_OBJECT = Object.freeze.bind(Object);
const OBJECT_IS_FROZEN = Object.isFrozen.bind(Object);
const CANONICAL_DIGEST = canonicalDigest;
const freezeProbe = { value: "unchanged" };
FREEZE_OBJECT(freezeProbe);
if (
  !OBJECT_IS_FROZEN(freezeProbe) ||
  Reflect.set(freezeProbe, "value", "mutated")
) {
  throw new Error("COPY_OPERATOR_EVIDENCE_OBJECT_PRIMITIVE_DRIFT");
}

export const COPY_REAL_CAPABILITY_ARTIFACT_PATHS = FREEZE_OBJECT(
  [
    ...COPY_CAPABILITY_OPERATIONAL_ARTIFACT_PATHS,
    "apps/api/dist/model-gateway/new-api-request-bound-settlement.js",
    "apps/api/dist/site-builder/eval/copy-pilot-source-verifier.js",
    "apps/api/dist/site-builder/eval/copy-pilot-ledger-identity.js",
    "apps/api/dist/site-builder/eval/copy-pilot-trusted-gateway.js",
    "apps/api/dist/site-builder/eval/copy-operator-evidence-key.js",
    "apps/api/dist/site-builder/eval/copy-operator-evidence-authorization.js",
    "apps/api/dist/site-builder/eval/copy-real-capability-admission.js",
    "apps/api/dist/site-builder/eval/copy-real-capability-runner.js",
  ].filter((path, index, paths) => paths.indexOf(path) === index),
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
const TRUSTED_OPERATOR_EVIDENCE_KEY_ID =
  "copy-evidence-operator-2026-08-v1" as const;
const TRUSTED_OPERATOR_EVIDENCE_PUBLIC_KEY_SHA256 =
  "90a80a686b217df4a524a709d940ca9cc133348722e8d611aa4cb2549b21dca7" as const;
if (
  COPY_OPERATOR_EVIDENCE_KEY_ID !== TRUSTED_OPERATOR_EVIDENCE_KEY_ID ||
  COPY_OPERATOR_EVIDENCE_PUBLIC_KEY_SHA256 !==
    TRUSTED_OPERATOR_EVIDENCE_PUBLIC_KEY_SHA256
) {
  throw new Error("COPY_OPERATOR_EVIDENCE_PUBLIC_KEY_DRIFT");
}

export interface CopyRealCapabilityReceipt {
  classification: "DISPATCH_PREFLIGHT_RECEIPT_ONLY";
  evidenceClass: "copy_gateway_settlement_candidate";
  evidenceKind: "capability_pilot";
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
  authorizationId: string;
  reservationId: string;
  compiledRuntimeDigest: string;
  compiledBindingDigest: string;
}

export interface CopyOperatorEvidenceChallenge {
  schemaVersion: "site-builder-copy-operator-evidence-challenge/2026-08-05-v1";
  candidateReceiptDigest: string;
  receipt: CopyRealCapabilityReceipt;
}

export interface CopyOperatorAuthorizedExecution {
  readonly classification: "OPAQUE_COPY_OPERATOR_AUTHORIZED_EXECUTION";
}

export interface CopyOperatorAuthorizedExecutionAttestation {
  classification: "OPERATOR_AUTHENTICATED_REAL_EVIDENCE";
  evidenceClass: "real_gateway_settled";
  evidenceKind: "capability_pilot";
  candidateReceiptDigest: string;
  candidateLedgerDigest: string;
  evidenceLedgerDigest: string;
  authorizationId: string;
  operatorPayloadDigest: string;
  operatorSignatureDigest: string;
  operatorPublicKeySha256: string;
  executionId: string;
  outputDigest: string;
}

export interface CopyRealCapabilityRunner {
  execute(executionKey: string): Promise<ModelExecutionResult<CopyTaskOutput>>;
  authorizeOperatorEvidence(input: {
    challenge: CopyOperatorEvidenceChallenge;
    authorization: VerifiedCopyOperatorEvidenceAuthorization;
  }): Promise<CopyOperatorAuthorizedExecution>;
  summary(): Promise<RealModelExecutionLedgerSummary>;
}

const REAL_CAPABILITY_RECEIPTS = new WeakMap<
  object,
  CopyRealCapabilityReceipt
>();
interface CopyRealCapabilityRuntimeDetail {
  receipt?: CopyRealCapabilityReceipt;
  ledger: RealModelExecutionLedger;
  ledgerIdentity: Awaited<ReturnType<typeof loadCopyPilotLedgerIdentity>>;
  compiledGuard: Awaited<ReturnType<typeof createCompiledRuntimeGuard>>;
  verifiedSource: CopyPilotVerifiedSource;
  trustedGateway: CopyPilotTrustedGateway;
  admission: CopyRealCapabilityAdmissionInput;
  source: ReturnType<typeof requireCopyPilotVerifiedSourceBinding>;
  campaignId: string;
}

const REAL_CAPABILITY_DETAILS = new WeakMap<
  object,
  CopyRealCapabilityRuntimeDetail & { receipt: CopyRealCapabilityReceipt }
>();
const OPERATOR_AUTHORIZED_EXECUTIONS = new WeakMap<
  object,
  CopyOperatorAuthorizedExecutionAttestation
>();

function fail(code: string): never {
  throw new Error(code);
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
  authorization: Omit<
    CopyRealCapabilityAdmissionInput["authorization"],
    "reservationDigest"
  >,
): string {
  return CANONICAL_DIGEST({
    schemaVersion: "copy-pilot-reservation-binding/2026-08-05-v1",
    authorizationId: authorization.authorizationId,
    reservationId: authorization.reservationId,
    manifestDigest: authorization.manifestDigest,
    credentialAttestationDigest: authorization.credentialAttestationDigest,
    settlementObserverDigest: authorization.settlementObserverDigest,
    ledgerIdentityDigest: authorization.ledgerIdentityDigest,
    maximumExecutions: authorization.maximumExecutions,
    maximumWireCalls: authorization.maximumWireCalls,
    maximumRepairCallsPerExecution:
      authorization.maximumRepairCallsPerExecution,
  });
}

function runtimeBinding(input: {
  admission: CopyRealCapabilityAdmissionInput;
  source: ReturnType<typeof requireCopyPilotVerifiedSourceBinding>;
}): Readonly<Record<string, unknown>> {
  return FREEZE_OBJECT({
    schemaVersion: "copy-real-capability-runtime-binding/2026-08-05-v1",
    taskId: COPY_CAPABILITY_PILOT_PLAN.taskId,
    planDigest: CANONICAL_DIGEST(COPY_CAPABILITY_PILOT_PLAN),
    fixedSourceCommit: input.source.fixedSourceCommit,
    sourceBundleDigest: input.source.sourceBundleDigest,
    manifestDigest: CANONICAL_DIGEST(input.admission.manifest),
    credentialAttestationDigest: CANONICAL_DIGEST(input.admission.credential),
    settlementObserverDigest: CANONICAL_DIGEST(input.admission.settlement),
    authorizationDigest: CANONICAL_DIGEST(input.admission.authorization),
    operatorEvidencePublicKeySha256:
      TRUSTED_OPERATOR_EVIDENCE_PUBLIC_KEY_SHA256,
    artifactPathsDigest: CANONICAL_DIGEST(COPY_REAL_CAPABILITY_ARTIFACT_PATHS),
  });
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

function runtimeProtocol(value: "openai-responses" | "anthropic-messages") {
  return value === "openai-responses"
    ? ("openai_responses" as const)
    : ("anthropic_messages" as const);
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

export function getCopyRealCapabilityReceipt(
  result: ModelExecutionResult<unknown>,
): CopyRealCapabilityReceipt | undefined {
  return REAL_CAPABILITY_RECEIPTS.get(result);
}

export function createCopyOperatorEvidenceChallenge(
  result: ModelExecutionResult<unknown>,
): CopyOperatorEvidenceChallenge {
  const detail = REAL_CAPABILITY_DETAILS.get(result);
  if (!detail) fail("COPY_OPERATOR_EVIDENCE_CANDIDATE_REQUIRED");
  return FREEZE_OBJECT({
    schemaVersion:
      "site-builder-copy-operator-evidence-challenge/2026-08-05-v1" as const,
    candidateReceiptDigest: CANONICAL_DIGEST(detail.receipt),
    receipt: detail.receipt,
  });
}

export function getCopyOperatorAuthorizedExecutionAttestation(
  execution: CopyOperatorAuthorizedExecution,
): CopyOperatorAuthorizedExecutionAttestation | undefined {
  return OPERATOR_AUTHORIZED_EXECUTIONS.get(execution);
}

async function authorizeCopyOperatorChallenge(input: {
  detail: CopyRealCapabilityRuntimeDetail;
  challenge: CopyOperatorEvidenceChallenge;
  authorization: VerifiedCopyOperatorEvidenceAuthorization;
}): Promise<CopyOperatorAuthorizedExecution> {
  const operator = getCopyOperatorEvidenceAuthorizationAttestation(
    input.authorization,
  );
  if (!operator) fail("COPY_OPERATOR_EVIDENCE_AUTHORIZATION_REQUIRED");
  const receipt = input.challenge?.receipt;
  let candidateReceiptDigest: string;
  try {
    candidateReceiptDigest = CANONICAL_DIGEST(receipt);
  } catch {
    return fail("COPY_OPERATOR_EVIDENCE_CANDIDATE_MISMATCH");
  }
  if (
    input.challenge?.schemaVersion !==
      "site-builder-copy-operator-evidence-challenge/2026-08-05-v1" ||
    input.challenge.candidateReceiptDigest !== candidateReceiptDigest ||
    operator.candidateReceiptDigest !== candidateReceiptDigest
  ) {
    fail("COPY_OPERATOR_EVIDENCE_CANDIDATE_MISMATCH");
  }
  const execution = COPY_CAPABILITY_PILOT_PLAN.executions.find(
    (candidate) => candidate.executionKey === receipt.executionId,
  );
  if (!execution) fail("COPY_OPERATOR_EVIDENCE_CANDIDATE_MISMATCH");
  const plan = createCopyCapabilityExecutionPlan({
    executionKey: execution.executionKey,
    campaignId: input.detail.campaignId,
    workspaceId: "copy-capability-real-gateway",
  });
  await assertCopyPilotTrustedGatewayCurrent(input.detail.trustedGateway);
  await assertCopyPilotVerifiedSourceCurrent(input.detail.verifiedSource);
  await assertCopyPilotLedgerIdentityCurrent(
    input.detail.ledgerIdentity.handle,
  );
  await ASSERT_COMPILED_CURRENT(input.detail.compiledGuard);
  const compiled = GET_COMPILED_ATTESTATION(input.detail.compiledGuard);
  if (
    receipt.classification !== "DISPATCH_PREFLIGHT_RECEIPT_ONLY" ||
    receipt.evidenceClass !== "copy_gateway_settlement_candidate" ||
    receipt.evidenceKind !== "capability_pilot" ||
    receipt.campaignId !== input.detail.campaignId ||
    receipt.alias !== execution.alias ||
    receipt.protocol !== execution.protocol ||
    receipt.reasoning !== execution.reasoning ||
    (receipt.wireCount !== 1 && receipt.wireCount !== 2) ||
    receipt.repaired !== (receipt.wireCount === 2) ||
    receipt.fixtureId !== COPY_CAPABILITY_PILOT_PLAN.source.fixtureId ||
    receipt.repeatIndex !== null ||
    receipt.planDigest !== executionPlanDigest(plan) ||
    receipt.inputDigest !== plan.inputDigest ||
    receipt.contextDigest !== plan.contextDigest ||
    receipt.promptDigest !== CANONICAL_DIGEST(plan.prompt) ||
    receipt.fixedSourceCommit !== input.detail.source.fixedSourceCommit ||
    receipt.sourceBundleDigest !== input.detail.source.sourceBundleDigest ||
    receipt.manifestDigest !== input.detail.source.manifestDigest ||
    receipt.admissionDigest !== CANONICAL_DIGEST(input.detail.admission) ||
    receipt.credentialAttestationDigest !==
      CANONICAL_DIGEST(input.detail.admission.credential) ||
    receipt.settlementObserverDigest !==
      CANONICAL_DIGEST(input.detail.admission.settlement) ||
    receipt.authorizationId !==
      input.detail.admission.authorization.authorizationId ||
    receipt.reservationId !==
      input.detail.admission.authorization.reservationId ||
    compiled == null ||
    receipt.compiledRuntimeDigest !== compiled.artifactTreeDigest ||
    receipt.compiledBindingDigest !== compiled.bindingDigest
  ) {
    fail("COPY_OPERATOR_EVIDENCE_CANDIDATE_MISMATCH");
  }
  const ledgerAuthorization = {
    authorizationId: operator.authorizationId,
    keyId: TRUSTED_OPERATOR_EVIDENCE_KEY_ID,
    payloadDigest: operator.payloadDigest,
    signatureDigest: operator.signatureDigest,
    candidateReceiptDigest,
    executionId: receipt.executionId,
    outputDigest: receipt.outputDigest,
    candidateLedgerDigest: receipt.ledgerDigest,
  } as const;
  const existingAuthorization =
    await input.detail.ledger.operatorEvidenceAuthorizationDigest(
      ledgerAuthorization,
    );
  if (existingAuthorization == null) {
    const before = await input.detail.ledger.summary();
    if (before.frozen || before.unknownWireSettlements !== 0) {
      fail("COPY_OPERATOR_EVIDENCE_LEDGER_MISMATCH");
    }
    assertCopyOperatorEvidenceAuthorizationCurrent(input.authorization);
  }
  const evidenceLedgerDigest =
    await input.detail.ledger.consumeOperatorEvidenceAuthorization(
      ledgerAuthorization,
    );
  const authorized = FREEZE_OBJECT({
    classification: "OPAQUE_COPY_OPERATOR_AUTHORIZED_EXECUTION" as const,
  });
  OPERATOR_AUTHORIZED_EXECUTIONS.set(
    authorized,
    FREEZE_OBJECT({
      classification: "OPERATOR_AUTHENTICATED_REAL_EVIDENCE" as const,
      evidenceClass: "real_gateway_settled" as const,
      evidenceKind: "capability_pilot" as const,
      candidateReceiptDigest,
      candidateLedgerDigest: receipt.ledgerDigest,
      evidenceLedgerDigest,
      authorizationId: operator.authorizationId,
      operatorPayloadDigest: operator.payloadDigest,
      operatorSignatureDigest: operator.signatureDigest,
      operatorPublicKeySha256: TRUSTED_OPERATOR_EVIDENCE_PUBLIC_KEY_SHA256,
      executionId: receipt.executionId,
      outputDigest: receipt.outputDigest,
    }),
  );
  return authorized;
}

export async function authorizeCopyGatewaySettlementCandidate(input: {
  result: ModelExecutionResult<unknown>;
  authorization: VerifiedCopyOperatorEvidenceAuthorization;
}): Promise<CopyOperatorAuthorizedExecution> {
  const detail = REAL_CAPABILITY_DETAILS.get(input.result);
  if (!detail) fail("COPY_OPERATOR_EVIDENCE_CANDIDATE_REQUIRED");
  return authorizeCopyOperatorChallenge({
    detail,
    challenge: createCopyOperatorEvidenceChallenge(input.result),
    authorization: input.authorization,
  });
}

export async function createCopyRealCapabilityRunner(input: {
  ledgerPath: string;
  authorizationClaimPath: string;
  ledgerMarkerPath: string;
  campaignId: string;
  admission: CopyRealCapabilityAdmissionInput;
  verifiedSource: CopyPilotVerifiedSource;
  trustedGateway: CopyPilotTrustedGateway;
}): Promise<CopyRealCapabilityRunner> {
  assertCompiledEntrypoint();
  validateCopyRealCapabilityAdmissionEnvelope(input.admission);
  const source = requireCopyPilotVerifiedSourceBinding(input.verifiedSource);
  const gatewayBinding = getCopyPilotTrustedAdmissionBinding(
    input.trustedGateway,
  );
  if (
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
    gatewayBinding.authorizationId !==
      input.admission.authorization.authorizationId ||
    gatewayBinding.reservationId !== input.admission.authorization.reservationId
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
    input.admission.authorization;
  if (
    input.admission.authorization.ledgerIdentityDigest !==
      ledgerIdentity.ledgerIdentityDigest ||
    reservationDigest !==
      copyPilotReservationDigest(authorizationWithoutReservationDigest)
  ) {
    fail("COPY_REAL_CAPABILITY_RESERVATION_BINDING_MISMATCH");
  }

  const compiledGuard = await createCompiledRuntimeGuard({
    repositoryRoot: LOADED_REPOSITORY_ROOT,
    artifactPaths: COPY_REAL_CAPABILITY_ARTIFACT_PATHS,
    binding: runtimeBinding({ admission: input.admission, source }),
  });
  await ASSERT_COMPILED_CURRENT(compiledGuard);
  const ledger = await RealModelExecutionLedger.open({
    ledgerPath: input.ledgerPath,
    authorizationClaimPath: input.authorizationClaimPath,
    campaign: {
      campaignId: input.campaignId,
      taskId: COPY_CAPABILITY_PILOT_PLAN.taskId,
      planDigest: CANONICAL_DIGEST(COPY_CAPABILITY_PILOT_PLAN),
      maximumExecutions: 3,
      maximumWireCalls: 6,
    },
    authorization: input.admission.authorization,
  });
  await markCopyPilotLedgerIdentityClaimed(ledgerIdentity.handle, {
    authorizationDigest: CANONICAL_DIGEST(input.admission.authorization),
  });
  await assertCopyPilotLedgerIdentityCurrent(ledgerIdentity.handle);
  const gateway = createCopyPilotTrustedGatewayBindings(input.trustedGateway);

  const runner = FREEZE_OBJECT({
    execute: async (executionKey: string) => {
      validateCopyRealCapabilityAdmissionEnvelope(input.admission);
      await assertCopyPilotTrustedGatewayCurrent(input.trustedGateway);
      await assertCopyPilotVerifiedSourceCurrent(input.verifiedSource);
      await ASSERT_COMPILED_CURRENT(compiledGuard);
      const execution = COPY_CAPABILITY_PILOT_PLAN.executions.find(
        (candidate) => candidate.executionKey === executionKey,
      );
      if (!execution) fail("COPY_CAPABILITY_EXECUTION_NOT_IN_PLAN");
      const plan = createCopyCapabilityExecutionPlan({
        executionKey,
        campaignId: input.campaignId,
        workspaceId: "copy-capability-real-gateway",
      });
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
            NativeModelAdapterResult<CopyTaskOutput> | NativeModelOutputError;
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
            if (!(error instanceof NativeModelOutputError)) throw error;
            native = error;
          }
          const usage = native.usage ?? {};
          const usageComplete = completeUsage(usage);
          const requestId = native.requestId ?? null;
          const settlement = await gateway.resolve({
            requestId,
            alias: execution.alias,
            protocol: execution.protocol,
            expectedChannelId: gateway.channelIdFor(
              execution.alias,
              execution.protocol,
            ),
            usage,
            maxOutputTokens: execution.maximumOutputTokens,
            maximumQuotaPoints:
              input.admission.credential.maximumQuotaPointsPerWire,
          });
          const settlementProof = gateway.trustedSettlementProof(settlement);
          const settled =
            settlement.status === "settled" &&
            settlementProof != null &&
            settlementProof.gatewayOrigin ===
              input.admission.credential.gatewayOrigin &&
            settlementProof.bearerTokenSha256 ===
              input.admission.credential.bearerTokenSha256 &&
            settlementProof.credentialAttestationDigest ===
              CANONICAL_DIGEST(input.admission.credential) &&
            settlementProof.authorizationDigest ===
              CANONICAL_DIGEST(input.admission.authorization) &&
            usageComplete &&
            native.reportedModel === execution.alias &&
            (!(native instanceof NativeModelOutputError) ||
              native.rawOutputText != null);
          const observation: ModelObservation<CopyTaskOutput> = FREEZE_OBJECT({
            output:
              native instanceof NativeModelOutputError
                ? invalidOutput(native)
                : native.output,
            requestedAlias: native.requestedModel,
            resolvedAlias: execution.alias,
            reportedModel: native.reportedModel,
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
            ...(settled ? { settlementProof: settlement } : {}),
            warnings: FREEZE_OBJECT(
              native instanceof NativeModelOutputError
                ? []
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
          validateCopyRealCapabilityAdmissionEnvelope(input.admission);
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
              COPY_REAL_CAPABILITY_ARTIFACT_PATHS.length ||
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
        const receipt = FREEZE_OBJECT({
          classification: "DISPATCH_PREFLIGHT_RECEIPT_ONLY" as const,
          evidenceClass: "copy_gateway_settlement_candidate" as const,
          evidenceKind: "capability_pilot" as const,
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
          authorizationId: input.admission.authorization.authorizationId,
          reservationId: input.admission.authorization.reservationId,
          compiledRuntimeDigest: compiled.artifactTreeDigest,
          compiledBindingDigest: compiled.bindingDigest,
        });
        REAL_CAPABILITY_RECEIPTS.set(result, receipt);
        REAL_CAPABILITY_DETAILS.set(result, {
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
    authorizeOperatorEvidence: (authorizationInput: {
      challenge: CopyOperatorEvidenceChallenge;
      authorization: VerifiedCopyOperatorEvidenceAuthorization;
    }) =>
      authorizeCopyOperatorChallenge({
        detail: {
          ledger,
          ledgerIdentity,
          compiledGuard,
          verifiedSource: input.verifiedSource,
          trustedGateway: input.trustedGateway,
          admission: input.admission,
          source,
          campaignId: input.campaignId,
        },
        challenge: authorizationInput.challenge,
        authorization: authorizationInput.authorization,
      }),
    summary: () => ledger.summary(),
  });
  return runner;
}
