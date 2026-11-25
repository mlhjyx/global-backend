import { LAWFUL_BASIS_KINDS } from "../../discovery/compliance/email-verification-gate";
import { types as nodeTypes } from "node:util";
import { parseArtifactReference } from "../../durable-results/artifact/artifact-reference.schema";
import { isCanonicalArtifactUuid } from "../../durable-results/artifact/artifact.types";
import { parseCanonicalMicrousd } from "../../tools/microusd";

export type EnrichmentPhase = "FINDER" | "VERIFY" | "SMTP";
export type SafetyCode =
  | "INVALID_PLAN"
  | "GOVERNANCE_PENDING"
  | "BUDGET_CAP_EXCEEDED"
  | "CONTROL_MISMATCH"
  | "INPUT_CONFLICT"
  | "HOLD"
  | "REDACTED";
export class EnrichmentSafetyError extends Error {
  constructor(readonly code: SafetyCode) {
    super("ENRICHMENT_" + code);
    this.name = "EnrichmentSafetyError";
  }
}
export interface ContactTargetSnapshot {
  readonly contactId: string;
  readonly contactOrdinal: number;
  readonly inputVersion: string;
  readonly beforeDigest: string;
  readonly pointRefs: readonly string[];
}
export interface QuotedEnrichmentSlot {
  readonly slotKey: string;
  readonly contactId: string;
  readonly contactOrdinal: number;
  readonly phase: EnrichmentPhase;
  readonly provider: string;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly quoteMicrousd: string;
  readonly pricingVersion: string;
  readonly dependsOnSlotKey: string | null;
}
export interface TrustedPlanInput {
  readonly workspaceId: string;
  readonly companyId: string;
  readonly entrypoint: "http" | "discovery_run";
  readonly businessRunId: string | null;
  readonly requestSha256: string;
  readonly admittedAtMs: number;
  readonly deadlineAtMs: number;
  readonly targets: readonly ContactTargetSnapshot[];
  readonly slots: readonly QuotedEnrichmentSlot[];
  readonly limits: Readonly<{
    authorityCapMicrousd: string;
    companyCapMicrousd: string;
    contactCapMicrousd: string;
    finderCompanyMax: number;
    finderContactMax: number;
    verifyAddressMax: number;
    maxContacts: number;
  }>;
}
export type FrozenEnrichmentPlan = TrustedPlanInput &
  Readonly<{ version: 1; planSha256: string }>;
export function invalidPlan(): never {
  throw new EnrichmentSafetyError("INVALID_PLAN");
}

/** All records are closed, bounded metadata, never a raw provider result. */
export function closedSafetyRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    return invalidPlan();
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return invalidPlan();
  const ownKeys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return invalidPlan();
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
      return invalidPlan();
  }
  return value as Record<string, unknown>;
}
export function denseSafetyArray(
  value: unknown,
  max: number,
): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max
  )
    return invalidPlan();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== value.length + 1 ||
    ownKeys.some(
      (key) =>
        typeof key !== "string" ||
        (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)),
    )
  )
    return invalidPlan();
  const result: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = descriptors[String(i)];
    if (!item?.enumerable || !Object.hasOwn(item, "value"))
      return invalidPlan();
    result.push(item.value);
  }
  return result;
}
export function safetyIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(value))
    return invalidPlan();
  return value;
}
export function safetyInteger(
  value: unknown,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    return invalidPlan();
  return value;
}
export function safetyDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    return invalidPlan();
  return value;
}
export function deepFreezeSafety<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreezeSafety(item);
    Object.freeze(value);
  }
  return value;
}
export function canonicalSafetyJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map(canonicalSafetyJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      "{" +
      Object.keys(record)
        .sort()
        .map(
          (key) => JSON.stringify(key) + ":" + canonicalSafetyJson(record[key]),
        )
        .join(",") +
      "}"
    );
  }
  return invalidPlan();
}
export function parseQuotedEnrichmentSlot(
  value: unknown,
): QuotedEnrichmentSlot {
  const row = closedSafetyRecord(value, [
    "slotKey",
    "contactId",
    "contactOrdinal",
    "phase",
    "provider",
    "toolId",
    "toolVersion",
    "quoteMicrousd",
    "pricingVersion",
    "dependsOnSlotKey",
  ]);
  if (row.phase !== "FINDER" && row.phase !== "VERIFY" && row.phase !== "SMTP")
    return invalidPlan();
  if (typeof row.quoteMicrousd !== "string") return invalidPlan();
  parseCanonicalMicrousd("quoteMicrousd", row.quoteMicrousd);
  return deepFreezeSafety({
    slotKey: safetyIdentifier(row.slotKey),
    contactId: safetyIdentifier(row.contactId),
    contactOrdinal: safetyInteger(row.contactOrdinal, 0, 9),
    phase: row.phase,
    provider: safetyIdentifier(row.provider),
    toolId: safetyIdentifier(row.toolId),
    toolVersion: safetyIdentifier(row.toolVersion),
    quoteMicrousd: row.quoteMicrousd,
    pricingVersion: safetyIdentifier(row.pricingVersion),
    dependsOnSlotKey:
      row.dependsOnSlotKey === null
        ? null
        : safetyIdentifier(row.dependsOnSlotKey),
  });
}

export interface CandidateRef {
  readonly operationId: string;
  readonly resultDigest: string;
  readonly artifactRef: import("../../durable-results/artifact/artifact.types").GenericOperationArtifactReference;
}
export interface BoundEnrichmentStep extends QuotedEnrichmentSlot {
  readonly stepId: string;
  readonly executionId: string;
  readonly workspaceId: string;
  readonly companyId: string;
  readonly authorityId: string;
  readonly accountId: string;
  readonly generation: number;
  readonly accountKey: string;
  readonly inputFingerprint: string;
  readonly operationKey: string;
  readonly candidateRef: CandidateRef | null;
  readonly revision: number;
  readonly budgetOperationId: string | null;
}
export interface EnrichmentStepContextRow {
  id: string;
  workspace_id: string;
  company_id: string | null;
  execution_id: string;
  contact_id: string | null;
  contact_ordinal: number;
  slot_key: string;
  phase: EnrichmentPhase;
  provider: string;
  tool_id: string;
  tool_version: string;
  quote_microusd: bigint;
  pricing_version: string;
  depends_on_slot_key: string | null;
  input_fingerprint: string | null;
  operation_key: string | null;
  budget_operation_id: string | null;
  candidate_ref: unknown;
  revision: number;
  dispatch_phase: string;
  domain_state: string;
  authority_id: string;
  account_id: string;
  generation: number;
  account_key: string;
  execution_status: string;
  deadline_open: boolean;
}
export function parseEnrichmentCandidateRef(value: unknown): CandidateRef {
  const row = closedSafetyRecord(value, [
    "operationId",
    "resultDigest",
    "artifactRef",
  ]);
  if (!isCanonicalArtifactUuid(row.operationId)) return invalidPlan();
  const artifactRef = parseArtifactReference(row.artifactRef);
  if (
    artifactRef.operationId !== row.operationId ||
    (artifactRef.resultSchema !== "contact-email-find-hunter/v1" &&
      artifactRef.resultSchema !== "contact-email-find-prospeo/v1") ||
    artifactRef.mediaType !== "application/octet-stream" ||
    BigInt(artifactRef.sizeBytes) > 16384n
  )
    return invalidPlan();
  const resultDigest = safetyDigest(row.resultDigest);
  // Original artifact receiptResult binds resultDigest to reference.sha256. The physical-input fingerprint is separate.
  if (resultDigest !== artifactRef.sha256) return invalidPlan();
  // Equality and shape do not prove provenance: the original-candidate SQL guard remains mandatory.
  return deepFreezeSafety({
    operationId: row.operationId,
    resultDigest,
    artifactRef,
  });
}

export interface SettledEnrichmentStepReference {
  readonly stepId: string;
  readonly producerId: string;
  readonly resultSchema: string;
  readonly resultDigest: string;
  readonly durableReceipt: import("../../durable-results/durable-execution-receipt").DurableExecutionReceipt;
}
export type OriginalEnrichmentStepReadback =
  | Readonly<{ status: "NOT_FOUND" | "PENDING" | "UNAVAILABLE" }>
  | Readonly<{ status: "SETTLED"; reference: SettledEnrichmentStepReference }>;

/** Source-local row parser only, not proof of SQL origin or immutability. */
export function parseBoundEnrichmentStepRow(
  row: EnrichmentStepContextRow,
): BoundEnrichmentStep {
  const mismatch = (): never => {
    throw new EnrichmentSafetyError("CONTROL_MISMATCH");
  };
  if (
    row.input_fingerprint === null ||
    row.operation_key === null ||
    row.company_id === null ||
    row.contact_id === null ||
    ![
      row.id,
      row.workspace_id,
      row.execution_id,
      row.company_id,
      row.contact_id,
      row.authority_id,
      row.account_id,
    ].every(isCanonicalArtifactUuid) ||
    (row.budget_operation_id !== null &&
      !isCanonicalArtifactUuid(row.budget_operation_id)) ||
    typeof row.quote_microusd !== "bigint" ||
    !Number.isSafeInteger(row.generation) ||
    row.generation < 1 ||
    row.generation > 2147483647 ||
    typeof row.account_key !== "string" ||
    row.account_key.length < 1 ||
    row.account_key.length > 200 ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    row.revision >= Number.MAX_SAFE_INTEGER ||
    !/^[A-Za-z0-9:._/-]{1,200}$/.test(row.operation_key)
  )
    return mismatch();
  const slot = parseQuotedEnrichmentSlot({
    slotKey: row.slot_key,
    contactId: row.contact_id,
    contactOrdinal: row.contact_ordinal,
    phase: row.phase,
    provider: row.provider,
    toolId: row.tool_id,
    toolVersion: row.tool_version,
    quoteMicrousd: row.quote_microusd.toString(),
    pricingVersion: row.pricing_version,
    dependsOnSlotKey: row.depends_on_slot_key,
  });
  if ((row.phase === "FINDER") !== (row.candidate_ref === null))
    return mismatch();
  return deepFreezeSafety({
    ...slot,
    stepId: row.id,
    executionId: row.execution_id,
    workspaceId: row.workspace_id,
    companyId: row.company_id,
    authorityId: row.authority_id,
    accountId: row.account_id,
    generation: row.generation,
    accountKey: row.account_key,
    inputFingerprint: safetyDigest(row.input_fingerprint),
    operationKey: row.operation_key,
    candidateRef:
      row.candidate_ref === null
        ? null
        : parseEnrichmentCandidateRef(row.candidate_ref),
    revision: row.revision,
    budgetOperationId: row.budget_operation_id,
  });
}

/** Authorized transient domain input only, never the public metadata/GET DTO. */
export type EnrichmentDomainMaterializedResult =
  | Readonly<{
      phase: "FINDER";
      step: BoundEnrichmentStep;
      reference: SettledEnrichmentStepReference;
      result: import("../../durable-results/artifact/materializers/contact-email-find.materializer").ContactEmailFindPayload;
    }>
  | Readonly<{
      phase: "VERIFY";
      step: BoundEnrichmentStep;
      reference: SettledEnrichmentStepReference;
      result: import("../../durable-results/contact-email-verification-projections").ControlledVerificationResult;
    }>
  | Readonly<{
      phase: "SMTP";
      step: BoundEnrichmentStep;
      reference: SettledEnrichmentStepReference;
      result: import("../../tools/tool-contract").ToolResult<
        import("../../tools/builtin-tools").SmtpProbeOutput
      >;
    }>;


/** Minimal frozen non-PII execution policy; never a credential, actor profile or money account. */
export interface EnrichmentExecutionOptions {
  readonly lawfulBasisKind: import('../../discovery/provider-contract').LawfulBasisKind;
  readonly tier: "A" | "B";
}
export function parseEnrichmentExecutionOptions(value: unknown): EnrichmentExecutionOptions {
  const row = closedSafetyRecord(value, ["lawfulBasisKind", "tier"]);
  if (typeof row.lawfulBasisKind !== "string" || !LAWFUL_BASIS_KINDS.some((basis) => basis === row.lawfulBasisKind) || (row.tier !== "A" && row.tier !== "B")) return invalidPlan();
  return deepFreezeSafety({ lawfulBasisKind: row.lawfulBasisKind as import('../../discovery/provider-contract').LawfulBasisKind, tier: row.tier });
}


export interface EnrichmentRuntimeStepRow extends EnrichmentStepContextRow {
  readonly budget_original_id: string | null; readonly budget_status: string | null; readonly budget_amount_unit: string | null;
  readonly budget_reserved_microusd: bigint | null; readonly budget_charged_microusd: bigint | null;
  readonly budget_result_schema: string | null; readonly budget_result_digest: string | null; readonly budget_result_json: unknown;
  readonly budget_receipt_usage: unknown; readonly budget_receipt_cost_basis: string | null;
}
export interface EnrichmentRuntimeExecutionRecord {
  readonly view: import('./enrichment-execution.repository').EnrichmentExecutionView;
  readonly workspaceId: string; readonly companyId: string; readonly entrypoint: "http" | "discovery_run"; readonly businessRunId: string | null;
  readonly requestSha256: string; readonly admissionRequestSha256: string; readonly accountKey: string;
  readonly currentAccount: Readonly<{ accountId: string; authorityId: string; generation: number }>;
  readonly plan: FrozenEnrichmentPlan | null; readonly targetCount: number; readonly executionOptions: EnrichmentExecutionOptions | null;
  readonly createdAt: string; readonly resultRevision: number; readonly resultSnapshot: unknown; readonly steps: readonly EnrichmentRuntimeStepRow[];
}

export const CONTACT_ENRICHMENT_RESULT_REASONS = Object.freeze([
  "PENDING",
  "GOVERNANCE_PENDING",
  "RESULT_UNKNOWN",
  "INPUT_CONFLICT",
  "SAVE_PENDING",
  "NO_MATCH",
  "STORED",
  "REUSED",
  "REDACTED",
  "NO_DOMAIN",
  "NO_CONTACTS",
  "SUPPRESSED",
  "INVALID_ALL",
  "UNAVAILABLE",
  "DEADLINE",
  "BUDGET_CAP",
] as const);
export type EnrichmentContactResultReason = (typeof CONTACT_ENRICHMENT_RESULT_REASONS)[number];
