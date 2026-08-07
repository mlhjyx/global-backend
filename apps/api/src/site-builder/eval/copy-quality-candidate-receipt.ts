import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import {
  canonicalDigest,
  stableSerialize,
} from "../../model-runtime/context-engine";
import { getDurableModelExecutionAttestation } from "../../model-runtime/durable-model-execution-runtime";
import { getTrustedModelExecutionMetadata } from "../../model-runtime/model-execution-runtime";
import {
  isTrustedRealModelExecutionLedger,
  RealModelExecutionLedger,
  type RealModelExecutionAuthorization,
} from "../../model-runtime/real-model-execution-ledger";
import type { ModelExecutionCampaignContract } from "../../model-runtime/model-execution-ledger";
import type {
  ModelExecutionResult,
  ModelProtocol,
  ReasoningLevel,
} from "../../model-runtime/types";
import { COPY_TASK, type CopyTaskOutput } from "../agents/copy";
import {
  COPY_ASSEMBLY_EVAL_FIXTURES,
  evaluateCopyAssemblyOutput,
  prepareCopyAssemblyEvalFixture,
} from "./copy-assembly-eval";
import { COPY_EVALUATION_V2_CANDIDATES } from "./copy-evaluation-v2-candidates";
import {
  COPY_QUALITY_MATRIX_PLAN,
  createCopyQualityMatrixExecutionPlan,
  validateCopyQualityMatrixPlan,
} from "./copy-quality-matrix-runner";

export const COPY_QUALITY_CANDIDATE_RECEIPT_SCHEMA_VERSION =
  "site-builder-copy-quality-candidate-receipt/2026-08-07-v1" as const;
export const COPY_QUALITY_ACCEPTED_REPLAY_WORKSPACE_ID =
  "copy-quality-real-gateway" as const;

const RECEIPT_CLASSIFICATION =
  "COPY_QUALITY_GATEWAY_SETTLEMENT_CANDIDATE" as const;
const MAXIMUM_OUTPUT_BYTES = 64 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,191}$/u;
const CANONICAL_BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

const CANONICAL_DIGEST = canonicalDigest;
const STABLE_SERIALIZE = stableSerialize;
const CREATE_HASH = createHash;
const GET_DURABLE_ATTESTATION = getDurableModelExecutionAttestation;
const GET_TRUSTED_METADATA = getTrustedModelExecutionMetadata;
const IS_TRUSTED_REAL_LEDGER = isTrustedRealModelExecutionLedger;
const ARRAY_IS_ARRAY = Array.isArray.bind(Array);
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf.bind(Object);
const OBJECT_KEYS = Object.keys.bind(Object);
const OBJECT_VALUES = Object.values.bind(Object);
const OBJECT_FREEZE = Object.freeze.bind(Object);
const REFLECT_OWN_KEYS = Reflect.ownKeys.bind(Reflect);
const JSON_PARSE = JSON.parse.bind(JSON);
const STRUCTURED_CLONE = structuredClone;
const STRING_SPLIT = Function.call.bind(String.prototype.split) as (
  value: string,
  separator: string,
) => string[];
const BUFFER_FROM = Buffer.from.bind(Buffer) as {
  (value: string, encoding: BufferEncoding): Buffer;
  (value: Uint8Array): Buffer;
};
const BUFFER_EQUALS = Function.call.bind(Buffer.prototype.equals) as (
  value: Buffer,
  other: Uint8Array,
) => boolean;
const BUFFER_TO_STRING = Function.call.bind(Buffer.prototype.toString) as (
  value: Buffer,
  encoding: BufferEncoding,
) => string;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const DECODE_UTF8 = UTF8_DECODER.decode.bind(UTF8_DECODER);

function keyList(value: string): readonly string[] {
  return OBJECT_FREEZE(STRING_SPLIT(value, " "));
}

const RECEIPT_KEYS = keyList(
  "schemaVersion classification evidenceClass evidenceKind taskId campaignId executionKey executionId alias protocol reasoning providerFamily fixtureId repeatIndex matrixPlanDigest executionPlanDigest inputDigest contextDigest promptDigest schemaDigest completionSequence ledgerDigest knownSettlementDigest wireCount outputDigest outputByteLength outputBytesSha256 outputBytesBase64 fixedSourceCommit sourceBundleDigest manifestDigest admissionDigest credentialAttestationDigest settlementObserverDigest ledgerAuthorizationDigest runtimeBindingDigest compiledRuntimeDigest compiledBindingDigest ledgerCampaign ledgerAuthorization",
);
const CAMPAIGN_KEYS = keyList(
  "campaignId taskId planDigest maximumExecutions maximumWireCalls",
);
const AUTHORIZATION_KEYS = keyList(
  "authorizationId reservationId manifestDigest credentialAttestationDigest settlementObserverDigest ledgerIdentityDigest reservationDigest maximumExecutions maximumWireCalls maximumRepairCallsPerExecution",
);
const AUTHORIZATION_WITH_SHARED_CAMPAIGN_BINDING_KEYS = OBJECT_FREEZE([
  ...AUTHORIZATION_KEYS,
  "sharedCampaignBinding",
]);
const SHARED_CAMPAIGN_BINDING_KEYS = keyList(
  "schemaVersion purpose ledgerTopology taskId planDigest fixedSourceCommit sourceBundleDigest manifestDigest admissionDigest credentialAttestationDigest settlementObserverDigest compiledRuntimeDigest compiledBindingDigest maximumExecutions maximumWireCalls maximumRepairCallsPerExecution",
);
const CREATE_RECEIPT_INPUT_KEYS = keyList("result ledger binding");
const RECEIPT_BINDING_KEYS = keyList(
  "schemaVersion fixedSourceCommit sourceBundleDigest manifestDigest admissionDigest credentialAttestationDigest settlementObserverDigest compiledRuntimeDigest compiledBindingDigest",
);
const FORBIDDEN_KEYS = keyList(
  "apikey authorizationclaimpath bearer bearertoken credentialref ledgerpath localpath password prompt rawoutput rawprompt rawprovidertext rawrequestid requestid requestlog secret token tokenfingerprint",
);

type CopyQualityProviderFamily = "openai" | "anthropic";
type CopyQualityMatrixExecutionPlan = ReturnType<
  typeof createCopyQualityMatrixExecutionPlan
>;

export interface CopyQualityCandidateRuntimeBinding {
  schemaVersion: "site-builder-copy-quality-runtime-binding/2026-08-07-v1";
  fixedSourceCommit: string;
  sourceBundleDigest: string;
  manifestDigest: string;
  admissionDigest: string;
  credentialAttestationDigest: string;
  settlementObserverDigest: string;
  compiledRuntimeDigest: string;
  compiledBindingDigest: string;
}

export interface CopyQualityCandidateReceipt {
  schemaVersion: typeof COPY_QUALITY_CANDIDATE_RECEIPT_SCHEMA_VERSION;
  classification: typeof RECEIPT_CLASSIFICATION;
  evidenceClass: "gateway_settlement_claim_only";
  evidenceKind: "quality_matrix";
  taskId: "site_builder.copy";
  campaignId: string;
  executionKey: string;
  executionId: string;
  alias: string;
  protocol: ModelProtocol;
  reasoning: ReasoningLevel;
  providerFamily: CopyQualityProviderFamily;
  fixtureId: string;
  repeatIndex: 0 | 1;
  matrixPlanDigest: string;
  executionPlanDigest: string;
  inputDigest: string;
  contextDigest: string;
  promptDigest: string;
  schemaDigest: string;
  completionSequence: number;
  ledgerDigest: string;
  knownSettlementDigest: string;
  wireCount: 1 | 2;
  outputDigest: string;
  outputByteLength: number;
  outputBytesSha256: string;
  outputBytesBase64: string;
  fixedSourceCommit: string;
  sourceBundleDigest: string;
  manifestDigest: string;
  admissionDigest: string;
  credentialAttestationDigest: string;
  settlementObserverDigest: string;
  ledgerAuthorizationDigest: string;
  runtimeBindingDigest: string;
  compiledRuntimeDigest: string;
  compiledBindingDigest: string;
  ledgerCampaign: ModelExecutionCampaignContract;
  ledgerAuthorization: RealModelExecutionAuthorization;
}

export interface ValidatedCopyQualityCandidateReceipt {
  receipt: CopyQualityCandidateReceipt;
  output: CopyTaskOutput;
  outputBytes: Buffer;
  plan: CopyQualityMatrixExecutionPlan;
}

function fail(code: string): never {
  throw new Error("COPY_QUALITY_REPLAY_" + code);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of OBJECT_VALUES(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    OBJECT_FREEZE(value);
  }
  return value;
}

function immutableClone<T>(value: T): T {
  return deepFreeze(STRUCTURED_CLONE(value));
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== "object" || ARRAY_IS_ARRAY(value)) {
    return false;
  }
  const prototype = OBJECT_GET_PROTOTYPE_OF(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (!plainRecord(value)) return false;
  const keys = REFLECT_OWN_KEYS(value);
  if (keys.length !== expected.length) return false;
  for (const key of keys) {
    if (typeof key !== "string" || !expected.includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return false;
  }
  return true;
}

function normalizedKey(value: string): string {
  return value.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function containsForbiddenKey(value: unknown): boolean {
  if (value == null || typeof value !== "object") return false;
  const pending: object[] = [value];
  const seen = new WeakSet<object>();
  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index]!;
    if (seen.has(current)) return true;
    seen.add(current);
    if (ARRAY_IS_ARRAY(current)) {
      for (const child of current) {
        if (child != null && typeof child === "object") pending.push(child);
      }
      continue;
    }
    for (const key of REFLECT_OWN_KEYS(current)) {
      if (typeof key !== "string") return true;
      if (FORBIDDEN_KEYS.includes(normalizedKey(key) as never)) return true;
      const child = (current as Record<string, unknown>)[key];
      if (child != null && typeof child === "object") pending.push(child);
    }
  }
  return false;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function validPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function executionPlanDigest(plan: CopyQualityMatrixExecutionPlan): string {
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

function exactOutputShape(
  output: unknown,
  expectedSlotKeys: readonly string[],
): output is CopyTaskOutput {
  if (!exactKeys(output, ["slots"]) || !plainRecord(output.slots)) return false;
  const actualSlotKeys = OBJECT_KEYS(output.slots).sort();
  const expected = [...expectedSlotKeys].sort();
  if (CANONICAL_DIGEST(actualSlotKeys) !== CANONICAL_DIGEST(expected)) {
    return false;
  }
  for (const slot of OBJECT_VALUES(output.slots)) {
    if (
      !exactKeys(slot, ["content", "claimRefs"]) ||
      typeof slot.content !== "string" ||
      !ARRAY_IS_ARRAY(slot.claimRefs) ||
      slot.claimRefs.some((claimRef) => typeof claimRef !== "string")
    ) {
      return false;
    }
  }
  return true;
}

function decodeOutput(
  receipt: Pick<
    CopyQualityCandidateReceipt,
    | "outputBytesBase64"
    | "outputByteLength"
    | "outputBytesSha256"
    | "outputDigest"
  >,
  plan: CopyQualityMatrixExecutionPlan,
): { output: CopyTaskOutput; outputBytes: Buffer } {
  if (
    typeof receipt.outputBytesBase64 !== "string" ||
    receipt.outputBytesBase64.length === 0 ||
    !CANONICAL_BASE64.test(receipt.outputBytesBase64)
  ) {
    return fail("OUTPUT_BASE64_INVALID");
  }
  const outputBytes = BUFFER_FROM(receipt.outputBytesBase64, "base64");
  if (
    BUFFER_TO_STRING(outputBytes, "base64") !== receipt.outputBytesBase64 ||
    outputBytes.byteLength !== receipt.outputByteLength ||
    outputBytes.byteLength < 1 ||
    outputBytes.byteLength > MAXIMUM_OUTPUT_BYTES
  ) {
    return fail("OUTPUT_BYTES_INVALID");
  }
  let text: string;
  try {
    text = DECODE_UTF8(outputBytes);
  } catch {
    return fail("OUTPUT_UTF8_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON_PARSE(text);
  } catch {
    return fail("OUTPUT_JSON_INVALID");
  }
  let canonical: Buffer;
  try {
    canonical = BUFFER_FROM(STABLE_SERIALIZE(parsed), "utf8");
  } catch {
    return fail("OUTPUT_JSON_INVALID");
  }
  if (!BUFFER_EQUALS(canonical, outputBytes)) {
    return fail("OUTPUT_CANONICAL_BYTES_REQUIRED");
  }
  const bytesDigest = CREATE_HASH("sha256").update(outputBytes).digest("hex");
  if (
    bytesDigest !== receipt.outputBytesSha256 ||
    bytesDigest !== receipt.outputDigest ||
    CANONICAL_DIGEST(parsed) !== receipt.outputDigest
  ) {
    return fail("OUTPUT_DIGEST_MISMATCH");
  }
  if (
    containsForbiddenKey(parsed) ||
    !exactOutputShape(
      parsed,
      plan.input.slots.map(({ key }) => key),
    )
  ) {
    return fail("OUTPUT_SHAPE_INVALID");
  }
  try {
    COPY_TASK.validateOutput?.(plan.input, parsed);
    const matrixExecution = COPY_QUALITY_MATRIX_PLAN.executions.find(
      ({ executionKey }) => executionKey === plan.executionId,
    );
    const sourceFixture = COPY_ASSEMBLY_EVAL_FIXTURES.find(
      ({ fixtureId }) => fixtureId === matrixExecution?.fixtureId,
    );
    if (!sourceFixture) return fail("FIXTURE_INVALID");
    evaluateCopyAssemblyOutput(
      prepareCopyAssemblyEvalFixture(sourceFixture),
      parsed,
    );
  } catch {
    return fail("OUTPUT_VALIDATION_FAILED");
  }
  return { output: immutableClone(parsed), outputBytes };
}

function runtimeBindingMaterial(input: {
  fixedSourceCommit: string;
  sourceBundleDigest: string;
  manifestDigest: string;
  admissionDigest: string;
  credentialAttestationDigest: string;
  settlementObserverDigest: string;
  compiledRuntimeDigest: string;
  compiledBindingDigest: string;
}): CopyQualityCandidateRuntimeBinding {
  return {
    schemaVersion:
      "site-builder-copy-quality-runtime-binding/2026-08-07-v1" as const,
    fixedSourceCommit: input.fixedSourceCommit,
    sourceBundleDigest: input.sourceBundleDigest,
    manifestDigest: input.manifestDigest,
    admissionDigest: input.admissionDigest,
    credentialAttestationDigest: input.credentialAttestationDigest,
    settlementObserverDigest: input.settlementObserverDigest,
    compiledRuntimeDigest: input.compiledRuntimeDigest,
    compiledBindingDigest: input.compiledBindingDigest,
  };
}

function sharedCampaignAuthorizesRuntime(
  ledger: RealModelExecutionLedger,
  binding: CopyQualityCandidateRuntimeBinding,
): boolean {
  const shared = ledger.authorization.sharedCampaignBinding;
  return (
    shared?.schemaVersion ===
      "real-model-shared-campaign-binding/2026-08-07-v1" &&
    shared.purpose === "site_builder_copy_quality_matrix" &&
    shared.ledgerTopology === "shared_campaign_ledger" &&
    shared.taskId === "site_builder.copy" &&
    shared.planDigest === CANONICAL_DIGEST(COPY_QUALITY_MATRIX_PLAN) &&
    shared.fixedSourceCommit === binding.fixedSourceCommit &&
    shared.sourceBundleDigest === binding.sourceBundleDigest &&
    shared.manifestDigest === binding.manifestDigest &&
    shared.admissionDigest === binding.admissionDigest &&
    shared.credentialAttestationDigest ===
      binding.credentialAttestationDigest &&
    shared.settlementObserverDigest === binding.settlementObserverDigest &&
    shared.compiledRuntimeDigest === binding.compiledRuntimeDigest &&
    shared.compiledBindingDigest === binding.compiledBindingDigest &&
    shared.maximumExecutions === COPY_QUALITY_MATRIX_PLAN.plannedExecutions &&
    shared.maximumWireCalls === COPY_QUALITY_MATRIX_PLAN.maximumWireCalls &&
    shared.maximumRepairCallsPerExecution === 1 &&
    ledger.campaign.taskId === "site_builder.copy" &&
    ledger.campaign.planDigest === shared.planDigest &&
    ledger.campaign.maximumExecutions === shared.maximumExecutions &&
    ledger.campaign.maximumWireCalls === shared.maximumWireCalls
  );
}

function sharedCampaignBindingMatches(
  binding: NonNullable<
    RealModelExecutionAuthorization["sharedCampaignBinding"]
  >,
  receipt: CopyQualityCandidateReceipt,
): boolean {
  return (
    binding.schemaVersion ===
      "real-model-shared-campaign-binding/2026-08-07-v1" &&
    binding.purpose === "site_builder_copy_quality_matrix" &&
    binding.ledgerTopology === "shared_campaign_ledger" &&
    binding.taskId === receipt.taskId &&
    binding.planDigest === receipt.matrixPlanDigest &&
    binding.fixedSourceCommit === receipt.fixedSourceCommit &&
    binding.sourceBundleDigest === receipt.sourceBundleDigest &&
    binding.manifestDigest === receipt.manifestDigest &&
    binding.admissionDigest === receipt.admissionDigest &&
    binding.credentialAttestationDigest ===
      receipt.credentialAttestationDigest &&
    binding.settlementObserverDigest === receipt.settlementObserverDigest &&
    binding.compiledRuntimeDigest === receipt.compiledRuntimeDigest &&
    binding.compiledBindingDigest === receipt.compiledBindingDigest &&
    binding.maximumExecutions === COPY_QUALITY_MATRIX_PLAN.plannedExecutions &&
    binding.maximumWireCalls === COPY_QUALITY_MATRIX_PLAN.maximumWireCalls &&
    binding.maximumRepairCallsPerExecution === 1
  );
}

export function validateCopyQualityCandidateReceipt(
  value: unknown,
): ValidatedCopyQualityCandidateReceipt {
  if (
    containsForbiddenKey(value) ||
    !exactKeys(value, RECEIPT_KEYS) ||
    !exactKeys(value.ledgerCampaign, CAMPAIGN_KEYS)
  ) {
    return fail("RECEIPT_SHAPE_INVALID");
  }
  if (
    !exactKeys(
      value.ledgerAuthorization,
      AUTHORIZATION_WITH_SHARED_CAMPAIGN_BINDING_KEYS,
    ) ||
    !exactKeys(
      value.ledgerAuthorization.sharedCampaignBinding,
      SHARED_CAMPAIGN_BINDING_KEYS,
    )
  ) {
    return fail("RECEIPT_SHAPE_INVALID");
  }
  const receipt = value as unknown as CopyQualityCandidateReceipt;
  const sharedBinding = receipt.ledgerAuthorization.sharedCampaignBinding!;
  const candidate = COPY_EVALUATION_V2_CANDIDATES.find(
    ({ alias, protocol, reasoning, providerFamily }) =>
      alias === receipt.alias &&
      protocol === receipt.protocol &&
      reasoning === receipt.reasoning &&
      providerFamily === receipt.providerFamily,
  );
  const execution = COPY_QUALITY_MATRIX_PLAN.executions.find(
    ({ executionKey }) => executionKey === receipt.executionKey,
  );
  const digestFields = [
    receipt.matrixPlanDigest,
    receipt.executionPlanDigest,
    receipt.inputDigest,
    receipt.contextDigest,
    receipt.promptDigest,
    receipt.schemaDigest,
    receipt.ledgerDigest,
    receipt.knownSettlementDigest,
    receipt.outputDigest,
    receipt.outputBytesSha256,
    receipt.sourceBundleDigest,
    receipt.manifestDigest,
    receipt.admissionDigest,
    receipt.credentialAttestationDigest,
    receipt.settlementObserverDigest,
    receipt.ledgerAuthorizationDigest,
    receipt.runtimeBindingDigest,
    receipt.compiledRuntimeDigest,
    receipt.compiledBindingDigest,
  ];
  if (
    receipt.schemaVersion !== COPY_QUALITY_CANDIDATE_RECEIPT_SCHEMA_VERSION ||
    receipt.classification !== RECEIPT_CLASSIFICATION ||
    receipt.evidenceClass !== "gateway_settlement_claim_only" ||
    receipt.evidenceKind !== "quality_matrix" ||
    receipt.taskId !== "site_builder.copy" ||
    !validIdentifier(receipt.campaignId) ||
    !validIdentifier(receipt.executionKey) ||
    receipt.executionId !== receipt.executionKey ||
    !validIdentifier(receipt.fixtureId) ||
    !candidate ||
    !execution ||
    execution.alias !== receipt.alias ||
    execution.protocol !== receipt.protocol ||
    execution.reasoning !== receipt.reasoning ||
    execution.fixtureId !== receipt.fixtureId ||
    execution.repeatIndex !== receipt.repeatIndex ||
    !validPositiveInteger(receipt.completionSequence) ||
    (receipt.wireCount !== 1 && receipt.wireCount !== 2) ||
    !validPositiveInteger(receipt.outputByteLength) ||
    receipt.outputByteLength > MAXIMUM_OUTPUT_BYTES ||
    !GIT_COMMIT.test(receipt.fixedSourceCommit) ||
    digestFields.some((field) => !validDigest(field))
  ) {
    return fail("RECEIPT_IDENTITY_INVALID");
  }
  try {
    validateCopyQualityMatrixPlan(COPY_QUALITY_MATRIX_PLAN);
  } catch {
    return fail("MATRIX_PLAN_DRIFT");
  }
  const matrixPlanDigest = CANONICAL_DIGEST(COPY_QUALITY_MATRIX_PLAN);
  const plan = createCopyQualityMatrixExecutionPlan({
    executionKey: receipt.executionKey,
    campaignId: receipt.campaignId,
    workspaceId: COPY_QUALITY_ACCEPTED_REPLAY_WORKSPACE_ID,
  });
  const expectedPlanDigest = executionPlanDigest(plan);
  if (
    receipt.matrixPlanDigest !== matrixPlanDigest ||
    receipt.executionPlanDigest !== expectedPlanDigest ||
    receipt.inputDigest !== plan.inputDigest ||
    receipt.contextDigest !== plan.contextDigest ||
    receipt.promptDigest !== CANONICAL_DIGEST(plan.prompt) ||
    receipt.schemaDigest !== plan.schemaDigest ||
    receipt.ledgerCampaign.campaignId !== receipt.campaignId ||
    receipt.ledgerCampaign.taskId !== receipt.taskId ||
    receipt.ledgerCampaign.planDigest !== matrixPlanDigest ||
    receipt.ledgerCampaign.maximumExecutions !==
      COPY_QUALITY_MATRIX_PLAN.plannedExecutions ||
    receipt.ledgerCampaign.maximumWireCalls !==
      COPY_QUALITY_MATRIX_PLAN.maximumWireCalls ||
    receipt.ledgerAuthorization.maximumExecutions !==
      receipt.ledgerCampaign.maximumExecutions ||
    receipt.ledgerAuthorization.maximumWireCalls !==
      receipt.ledgerCampaign.maximumWireCalls ||
    receipt.ledgerAuthorization.maximumRepairCallsPerExecution !== 1 ||
    !validIdentifier(receipt.ledgerAuthorization.authorizationId) ||
    !validIdentifier(receipt.ledgerAuthorization.reservationId) ||
    !validDigest(receipt.ledgerAuthorization.ledgerIdentityDigest) ||
    !validDigest(receipt.ledgerAuthorization.reservationDigest) ||
    receipt.ledgerAuthorization.manifestDigest !== receipt.manifestDigest ||
    receipt.ledgerAuthorization.credentialAttestationDigest !==
      receipt.credentialAttestationDigest ||
    receipt.ledgerAuthorization.settlementObserverDigest !==
      receipt.settlementObserverDigest ||
    receipt.ledgerAuthorizationDigest !==
      CANONICAL_DIGEST(receipt.ledgerAuthorization) ||
    receipt.runtimeBindingDigest !==
      CANONICAL_DIGEST(runtimeBindingMaterial(receipt)) ||
    !sharedCampaignBindingMatches(sharedBinding, receipt)
  ) {
    return fail("RECEIPT_BINDING_MISMATCH");
  }
  const decoded = decodeOutput(receipt, plan);
  return {
    receipt: immutableClone(receipt),
    output: decoded.output,
    outputBytes: decoded.outputBytes,
    plan,
  };
}

export async function createCopyQualityCandidateReceipt(input: {
  result: ModelExecutionResult<CopyTaskOutput>;
  ledger: RealModelExecutionLedger;
  binding: CopyQualityCandidateRuntimeBinding;
}): Promise<CopyQualityCandidateReceipt> {
  if (!exactKeys(input, CREATE_RECEIPT_INPUT_KEYS)) {
    return fail("CREATE_RECEIPT_INPUT_INVALID");
  }
  if (!IS_TRUSTED_REAL_LEDGER(input.ledger)) {
    return fail("LEDGER_UNTRUSTED");
  }
  if (
    containsForbiddenKey(input.binding) ||
    !exactKeys(input.binding, RECEIPT_BINDING_KEYS) ||
    input.binding.schemaVersion !==
      "site-builder-copy-quality-runtime-binding/2026-08-07-v1" ||
    !GIT_COMMIT.test(input.binding.fixedSourceCommit) ||
    [
      input.binding.sourceBundleDigest,
      input.binding.manifestDigest,
      input.binding.admissionDigest,
      input.binding.credentialAttestationDigest,
      input.binding.settlementObserverDigest,
      input.binding.compiledRuntimeDigest,
      input.binding.compiledBindingDigest,
    ].some((value) => !validDigest(value)) ||
    input.binding.manifestDigest !==
      input.ledger.authorization.manifestDigest ||
    input.binding.credentialAttestationDigest !==
      input.ledger.authorization.credentialAttestationDigest ||
    input.binding.settlementObserverDigest !==
      input.ledger.authorization.settlementObserverDigest ||
    !sharedCampaignAuthorizesRuntime(input.ledger, input.binding)
  ) {
    return fail("RUNTIME_BINDING_INVALID");
  }
  const metadata = GET_TRUSTED_METADATA(input.result);
  if (!metadata) return fail("RUNTIME_RESULT_UNTRUSTED");
  const durable = GET_DURABLE_ATTESTATION(input.result);
  if (!durable) return fail("DURABLE_RESULT_UNTRUSTED");
  const execution = COPY_QUALITY_MATRIX_PLAN.executions.find(
    ({ executionKey }) => executionKey === metadata.executionId,
  );
  const candidate = COPY_EVALUATION_V2_CANDIDATES.find(
    ({ alias, protocol, reasoning }) =>
      alias === metadata.resolvedAlias &&
      protocol === metadata.protocol &&
      reasoning === metadata.reasoning,
  );
  if (!execution || !candidate) return fail("RUNTIME_RESULT_INADMISSIBLE");
  const plan = createCopyQualityMatrixExecutionPlan({
    executionKey: execution.executionKey,
    campaignId: input.ledger.campaign.campaignId,
    workspaceId: COPY_QUALITY_ACCEPTED_REPLAY_WORKSPACE_ID,
  });
  const planDigest = executionPlanDigest(plan);
  if (
    metadata.taskId !== "site_builder.copy" ||
    metadata.taskVersion !== COPY_TASK.contractVersion ||
    metadata.requestedAlias !== metadata.resolvedAlias ||
    metadata.reportedModel !== metadata.resolvedAlias ||
    metadata.cacheMode !== "disabled" ||
    metadata.settlement !== "known" ||
    metadata.cacheHit ||
    durable.evidenceClass !== "gateway_settlement_claim_only" ||
    durable.campaignId !== input.ledger.campaign.campaignId ||
    durable.executionId !== metadata.executionId ||
    durable.outputDigest !== metadata.outputDigest ||
    durable.wireCount !== input.result.transportAttempts ||
    !input.result.states.includes("settled") ||
    input.result.states.at(-1) !== "completed" ||
    execution.alias !== metadata.resolvedAlias ||
    execution.protocol !== metadata.protocol ||
    execution.reasoning !== metadata.reasoning
  ) {
    return fail("RUNTIME_RESULT_INADMISSIBLE");
  }
  let outputText: string;
  try {
    outputText = STABLE_SERIALIZE(input.result.output);
  } catch {
    return fail("OUTPUT_JSON_INVALID");
  }
  const outputBytes = BUFFER_FROM(outputText, "utf8");
  if (
    outputBytes.byteLength < 1 ||
    outputBytes.byteLength > MAXIMUM_OUTPUT_BYTES
  ) {
    return fail("OUTPUT_BYTES_INVALID");
  }
  const outputDigest = CREATE_HASH("sha256").update(outputBytes).digest("hex");
  if (outputDigest !== metadata.outputDigest) {
    return fail("OUTPUT_DIGEST_MISMATCH");
  }
  let snapshot;
  try {
    snapshot = await input.ledger.completedExecutionSnapshot(
      metadata.executionId,
      planDigest,
    );
  } catch {
    return fail("COMPLETED_SNAPSHOT_REQUIRED");
  }
  if (
    snapshot.executionId !== metadata.executionId ||
    snapshot.planDigest !== planDigest ||
    snapshot.outputDigest !== outputDigest ||
    snapshot.ledgerDigest !== durable.ledgerDigest ||
    snapshot.alias !== metadata.resolvedAlias ||
    snapshot.protocol !== metadata.protocol ||
    snapshot.wireCount !== durable.wireCount
  ) {
    return fail("COMPLETED_SNAPSHOT_MISMATCH");
  }
  const receipt = {
    schemaVersion: COPY_QUALITY_CANDIDATE_RECEIPT_SCHEMA_VERSION,
    classification: RECEIPT_CLASSIFICATION,
    evidenceClass: "gateway_settlement_claim_only" as const,
    evidenceKind: "quality_matrix" as const,
    taskId: "site_builder.copy" as const,
    campaignId: input.ledger.campaign.campaignId,
    executionKey: execution.executionKey,
    executionId: metadata.executionId,
    alias: metadata.resolvedAlias,
    protocol: metadata.protocol,
    reasoning: metadata.reasoning,
    providerFamily: candidate.providerFamily,
    fixtureId: execution.fixtureId,
    repeatIndex: execution.repeatIndex,
    matrixPlanDigest: CANONICAL_DIGEST(COPY_QUALITY_MATRIX_PLAN),
    executionPlanDigest: planDigest,
    inputDigest: plan.inputDigest,
    contextDigest: plan.contextDigest,
    promptDigest: CANONICAL_DIGEST(plan.prompt),
    schemaDigest: plan.schemaDigest,
    completionSequence: snapshot.completionSequence,
    ledgerDigest: snapshot.ledgerDigest,
    knownSettlementDigest: snapshot.knownSettlementDigest,
    wireCount: snapshot.wireCount as 1 | 2,
    outputDigest,
    outputByteLength: outputBytes.byteLength,
    outputBytesSha256: outputDigest,
    outputBytesBase64: BUFFER_TO_STRING(outputBytes, "base64"),
    fixedSourceCommit: input.binding.fixedSourceCommit,
    sourceBundleDigest: input.binding.sourceBundleDigest,
    manifestDigest: input.binding.manifestDigest,
    admissionDigest: input.binding.admissionDigest,
    credentialAttestationDigest:
      input.ledger.authorization.credentialAttestationDigest,
    settlementObserverDigest:
      input.ledger.authorization.settlementObserverDigest,
    ledgerAuthorizationDigest: CANONICAL_DIGEST(input.ledger.authorization),
    runtimeBindingDigest: CANONICAL_DIGEST(input.binding),
    compiledRuntimeDigest: input.binding.compiledRuntimeDigest,
    compiledBindingDigest: input.binding.compiledBindingDigest,
    ledgerCampaign: immutableClone(input.ledger.campaign),
    ledgerAuthorization: immutableClone(
      input.ledger.authorization,
    ) as CopyQualityCandidateReceipt["ledgerAuthorization"],
  } satisfies CopyQualityCandidateReceipt;
  return validateCopyQualityCandidateReceipt(receipt).receipt;
}
