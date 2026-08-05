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

export const COPY_REAL_CAPABILITY_ARTIFACT_PATHS = Object.freeze(
  [
    ...COPY_CAPABILITY_OPERATIONAL_ARTIFACT_PATHS,
    "apps/api/dist/model-gateway/new-api-request-bound-settlement.js",
    "apps/api/dist/site-builder/eval/copy-pilot-source-verifier.js",
    "apps/api/dist/site-builder/eval/copy-pilot-ledger-identity.js",
    "apps/api/dist/site-builder/eval/copy-pilot-trusted-gateway.js",
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

export interface CopyRealCapabilityReceipt {
  classification: "DISPATCH_PREFLIGHT_RECEIPT_ONLY";
  evidenceClass: "copy_gateway_settlement_candidate";
  campaignId: string;
  executionId: string;
  alias: string;
  protocol: ModelProtocol;
  reasoning: ReasoningLevel;
  wireCount: 1 | 2;
  repaired: boolean;
  ledgerDigest: string;
  outputDigest: string;
  fixedSourceCommit: string;
  sourceBundleDigest: string;
  manifestDigest: string;
  credentialAttestationDigest: string;
  settlementObserverDigest: string;
  authorizationId: string;
  reservationId: string;
  compiledRuntimeDigest: string;
  compiledBindingDigest: string;
}

export interface CopyRealCapabilityRunner {
  execute(executionKey: string): Promise<ModelExecutionResult<CopyTaskOutput>>;
  summary(): Promise<RealModelExecutionLedgerSummary>;
}

const REAL_CAPABILITY_RECEIPTS = new WeakMap<
  object,
  CopyRealCapabilityReceipt
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
  return canonicalDigest({
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
  return Object.freeze({
    schemaVersion: "copy-real-capability-runtime-binding/2026-08-05-v1",
    taskId: COPY_CAPABILITY_PILOT_PLAN.taskId,
    planDigest: canonicalDigest(COPY_CAPABILITY_PILOT_PLAN),
    fixedSourceCommit: input.source.fixedSourceCommit,
    sourceBundleDigest: input.source.sourceBundleDigest,
    manifestDigest: canonicalDigest(input.admission.manifest),
    credentialAttestationDigest: canonicalDigest(input.admission.credential),
    settlementObserverDigest: canonicalDigest(input.admission.settlement),
    authorizationDigest: canonicalDigest(input.admission.authorization),
    artifactPathsDigest: canonicalDigest(COPY_REAL_CAPABILITY_ARTIFACT_PATHS),
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
    source.manifestDigest !== canonicalDigest(input.admission.manifest) ||
    gatewayBinding == null ||
    gatewayBinding.manifestDigest !== source.manifestDigest ||
    gatewayBinding.credentialAttestationDigest !==
      canonicalDigest(input.admission.credential) ||
    gatewayBinding.settlementObserverDigest !==
      canonicalDigest(input.admission.settlement) ||
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
      planDigest: canonicalDigest(COPY_CAPABILITY_PILOT_PLAN),
      maximumExecutions: 3,
      maximumWireCalls: 6,
    },
    authorization: input.admission.authorization,
  });
  await markCopyPilotLedgerIdentityClaimed(ledgerIdentity.handle, {
    authorizationDigest: canonicalDigest(input.admission.authorization),
  });
  await assertCopyPilotLedgerIdentityCurrent(ledgerIdentity.handle);
  const gateway = createCopyPilotTrustedGatewayBindings(input.trustedGateway);

  return Object.freeze({
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
              canonicalDigest(input.admission.credential) &&
            settlementProof.authorizationDigest ===
              canonicalDigest(input.admission.authorization) &&
            usageComplete &&
            native.reportedModel === execution.alias &&
            (!(native instanceof NativeModelOutputError) ||
              native.rawOutputText != null);
          const observation: ModelObservation<CopyTaskOutput> = Object.freeze({
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
            warnings: Object.freeze(
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
              canonicalDigest(
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
        REAL_CAPABILITY_RECEIPTS.set(
          result,
          Object.freeze({
            classification: "DISPATCH_PREFLIGHT_RECEIPT_ONLY" as const,
            evidenceClass: "copy_gateway_settlement_candidate" as const,
            campaignId: durable.campaignId,
            executionId: durable.executionId,
            alias: metadata.resolvedAlias,
            protocol: metadata.protocol,
            reasoning: metadata.reasoning,
            wireCount: durable.wireCount,
            repaired: durable.wireCount === 2,
            ledgerDigest: durable.ledgerDigest,
            outputDigest: durable.outputDigest,
            fixedSourceCommit: source.fixedSourceCommit,
            sourceBundleDigest: source.sourceBundleDigest,
            manifestDigest: source.manifestDigest,
            credentialAttestationDigest: canonicalDigest(
              input.admission.credential,
            ),
            settlementObserverDigest: canonicalDigest(
              input.admission.settlement,
            ),
            authorizationId: input.admission.authorization.authorizationId,
            reservationId: input.admission.authorization.reservationId,
            compiledRuntimeDigest: compiled.artifactTreeDigest,
            compiledBindingDigest: compiled.bindingDigest,
          }),
        );
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
    summary: () => ledger.summary(),
  });
}
