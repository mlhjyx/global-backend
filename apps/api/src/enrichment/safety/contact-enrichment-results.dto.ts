import { CONTACT_ENRICHMENT_RESULT_REASONS } from "./enrichment-safety.contract";
import { parseEnrichmentContactApplyDecision } from "./enrichment-domain-commit";
import { durableReceiptFromLedgerRow, requireLedgerProjectionReceipt } from "../../tools/budget-operation-result";
import { parseGenericOperationProjection } from "../../tools/generic-operation-projection";
import { parseArtifactReference } from "../../durable-results/artifact/artifact-reference.schema";
import type { EnrichmentRuntimeExecutionRecord, EnrichmentRuntimeStepRow } from "./enrichment-safety.contract";
import { types } from "node:util";
import { EMAIL_VERIFICATION_STATES } from "../../discovery/contact-point-verification-state";
import { parseCanonicalMicrousd } from "../../tools/microusd";
import { isCanonicalArtifactUuid } from "../../durable-results/artifact/artifact.types";
import {
  canonicalSafetyJson,
  closedSafetyRecord,
  deepFreezeSafety,
  denseSafetyArray,
  safetyDigest,
  safetyInteger,
  EnrichmentSafetyError,
} from "./enrichment-safety.contract";
import { readEnrichmentResultSnapshot } from "./enrichment-result-snapshot";
export interface ContactEnrichmentResultCursor {
  readonly createdAt: string;
  readonly id: string;
}
export interface ContactEnrichmentResultsQuery {
  readonly limit: 10;
  readonly cursor: ContactEnrichmentResultCursor | null;
  readonly businessRunId: string | null;
}
function invalidReadInput(): never {
  throw new EnrichmentSafetyError("INVALID_PLAN");
}
function canonicalTime(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  )
    return invalidReadInput();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value)
    return invalidReadInput();
  return value;
}
function cursorValue(value: unknown): ContactEnrichmentResultCursor {
  const row = closedSafetyRecord(value, ["createdAt", "id"]);
  if (!isCanonicalArtifactUuid(row.id)) return invalidReadInput();
  return deepFreezeSafety({
    createdAt: canonicalTime(row.createdAt),
    id: row.id,
  });
}
export function encodeContactEnrichmentResultCursor(
  value: ContactEnrichmentResultCursor,
): string {
  return Buffer.from(canonicalSafetyJson(cursorValue(value)), "utf8").toString(
    "base64url",
  );
}
export function decodeContactEnrichmentResultCursor(
  value: string,
): ContactEnrichmentResultCursor {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value))
    return invalidReadInput();
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) return invalidReadInput();
    const parsed = cursorValue(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (encodeContactEnrichmentResultCursor(parsed) !== value)
      return invalidReadInput();
    return parsed;
  } catch {
    return invalidReadInput();
  }
}
export function parseContactEnrichmentResultsQuery(
  value: unknown,
): ContactEnrichmentResultsQuery {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    types.isProxy(value)
  )
    return invalidReadInput();
  const keys = Reflect.ownKeys(value);
  if (
    keys.some(
      (key) => typeof key !== "string" || (key !== "cursor" && key !== "runId"),
    )
  )
    return invalidReadInput();
  const row = closedSafetyRecord(value, keys as string[]);
  if (Object.hasOwn(row, "runId") && !isCanonicalArtifactUuid(row.runId))
    return invalidReadInput();
  if (Object.hasOwn(row, "cursor") && typeof row.cursor !== "string")
    return invalidReadInput();
  return deepFreezeSafety({
    limit: 10 as const,
    cursor: Object.hasOwn(row, "cursor")
      ? decodeContactEnrichmentResultCursor(row.cursor as string)
      : null,
    businessRunId: Object.hasOwn(row, "runId") ? (row.runId as string) : null,
  });
}

export interface ContactEnrichmentQualityResultV1 {
  readonly version: 1;
  readonly protocolVersion: 1;
  readonly operationRef: string;
  readonly companyId: string;
  readonly entrypoint: "http" | "discovery_run";
  readonly businessRunId: string | null;
  readonly createdAt: string;
  readonly status:
    | "PREPARED"
    | "RUNNING"
    | "RESULT_UNKNOWN"
    | "APPLY_PENDING"
    | "COMPLETED"
    | "FAILED"
    | "REDACTED";
  readonly resultRevision: number;
  readonly qualityCoverage: "PREREQUISITE_ONLY";
  readonly summary: Readonly<{
    consideredUniqueContacts: number;
    eligibleUniqueContacts: number;
    stockValidPersonalContacts: null;
    physicallyAttemptedUniqueContacts: number | null;
    newCandidatePoints: number;
    newValidPersonalContacts: null;
    unresolvedUniqueContacts: number | null;
    skippedByReason: readonly Readonly<{ reasonCode: string; count: number }>[];
  }>;
  readonly perContact: readonly Readonly<{
    contactId: string;
    reasonCode: string;
    beforeStates: readonly string[];
    afterStates: readonly string[];
    pointRefs: readonly string[];
    eventRefs: readonly string[];
    attemptRefs: readonly string[];
    newCandidate: boolean | null;
    newValidPersonal: null;
  }>[];
  readonly spend: Readonly<{
    quotedUpperBoundMicrousd: string;
    knownChargedMicrousd: string | null;
    unknownUpperBoundMicrousd: string | null;
    costBasis: "estimated_upper_bound";
  }>;
  readonly unavailableMetrics: readonly string[];
}
export { CONTACT_ENRICHMENT_RESULT_REASONS } from "./enrichment-safety.contract";
export const CONTACT_ENRICHMENT_EXECUTION_STATUSES = Object.freeze([
  "PREPARED",
  "RUNNING",
  "RESULT_UNKNOWN",
  "APPLY_PENDING",
  "COMPLETED",
  "FAILED",
  "REDACTED",
] as const);
const NULLABLE_METRICS = [
  "stockValidPersonalContacts",
  "physicallyAttemptedUniqueContacts",
  "newValidPersonalContacts",
  "unresolvedUniqueContacts",
] as const;
const exactObject = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const countSchema = { type: "integer", minimum: 0, maximum: 10 };
const nullQualitySchema = {
  type: "integer",
  minimum: 0,
  maximum: 10,
  nullable: true,
  enum: [null],
  description: "本安全首片未证明该完整质量指标，固定为 null。",
};
const uuidSchema = { type: "string", format: "uuid", maxLength: 36 };
const reasonSchema = {
  type: "string",
  enum: [...CONTACT_ENRICHMENT_RESULT_REASONS],
  maxLength: 32,
};
const microSchema = {
  type: "string",
  pattern: "^(0|[1-9][0-9]*)$",
  maxLength: 19,
};
const idArray = (maxItems: number) => ({
  type: "array",
  maxItems,
  uniqueItems: true,
  items: uuidSchema,
});
const statesSchema = {
  type: "array",
  maxItems: 4,
  uniqueItems: true,
  items: {
    type: "string",
    enum: [...EMAIL_VERIFICATION_STATES],
    maxLength: 32,
  },
};
const perContactSchema = exactObject({
  contactId: uuidSchema,
  reasonCode: reasonSchema,
  beforeStates: statesSchema,
  afterStates: statesSchema,
  pointRefs: idArray(100),
  eventRefs: idArray(18),
  attemptRefs: idArray(3),
  newCandidate: { type: "boolean", nullable: true },
  newValidPersonal: { type: "boolean", nullable: true, enum: [null] },
});
const summarySchema = exactObject({
  consideredUniqueContacts: countSchema,
  eligibleUniqueContacts: countSchema,
  stockValidPersonalContacts: nullQualitySchema,
  physicallyAttemptedUniqueContacts: { ...countSchema, nullable: true },
  newCandidatePoints: countSchema,
  newValidPersonalContacts: nullQualitySchema,
  unresolvedUniqueContacts: { ...countSchema, nullable: true },
  skippedByReason: {
    type: "array",
    maxItems: 10,
    items: exactObject({
      reasonCode: reasonSchema,
      count: { type: "integer", minimum: 1, maximum: 10 },
    }),
  },
});
export const CONTACT_ENRICHMENT_QUALITY_RESULT_SCHEMA = deepFreezeSafety(
  exactObject({
    version: { type: "integer", enum: [1] },
    protocolVersion: { type: "integer", enum: [1] },
    operationRef: {
      type: "string",
      pattern: "^[a-f0-9]{64}$",
      minLength: 64,
      maxLength: 64,
    },
    companyId: uuidSchema,
    entrypoint: { type: "string", enum: ["http", "discovery_run"] },
    businessRunId: { ...uuidSchema, nullable: true },
    createdAt: { type: "string", format: "date-time", maxLength: 24 },
    status: {
      type: "string",
      enum: [...CONTACT_ENRICHMENT_EXECUTION_STATUSES],
    },
    resultRevision: { type: "integer", minimum: 1, maximum: 2147483647 },
    qualityCoverage: { type: "string", enum: ["PREREQUISITE_ONLY"] },
    summary: summarySchema,
    perContact: { type: "array", maxItems: 10, items: perContactSchema },
    spend: exactObject({
      quotedUpperBoundMicrousd: microSchema,
      knownChargedMicrousd: { ...microSchema, nullable: true },
      unknownUpperBoundMicrousd: { ...microSchema, nullable: true },
      costBasis: {
        type: "string",
        enum: ["estimated_upper_bound"],
        description:
          "原 ledger 金额与未决上界，不是供应商发票；未知金额不视为零。",
      },
    }),
    unavailableMetrics: {
      type: "array",
      maxItems: 4,
      uniqueItems: true,
      items: { type: "string", enum: [...NULLABLE_METRICS] },
    },
  }),
);
function uuidValue(value: unknown): string {
  return isCanonicalArtifactUuid(value) ? value : invalidReadInput();
}
function choice<T extends string>(value: unknown, options: readonly T[]): T {
  return typeof value === "string" && options.some((v) => v === value)
    ? (value as T)
    : invalidReadInput();
}
function ids(value: unknown, max: number): string[] {
  const parsed = denseSafetyArray(value, max).map(uuidValue);
  if (new Set(parsed).size !== parsed.length) return invalidReadInput();
  return parsed;
}
function states(value: unknown): string[] {
  const parsed = denseSafetyArray(value, 4).map((v) =>
    choice(v, EMAIL_VERIFICATION_STATES),
  );
  if (new Set(parsed).size !== parsed.length) return invalidReadInput();
  return parsed;
}
function nullValue(value: unknown): null {
  return value === null ? null : invalidReadInput();
}
function nullableCount(value: unknown, max: number): number | null {
  return value === null ? null : safetyInteger(value, 0, max);
}
function microValue(value: unknown): string {
  if (typeof value !== "string") return invalidReadInput();
  parseCanonicalMicrousd("result metadata microusd", value);
  return value;
}
function parseContactResult(
  value: unknown,
): ContactEnrichmentQualityResultV1["perContact"][number] {
  const row = closedSafetyRecord(
    value,
    Object.keys(perContactSchema.properties),
  );
  if (row.newCandidate !== null && typeof row.newCandidate !== "boolean")
    return invalidReadInput();
  return {
    contactId: uuidValue(row.contactId),
    reasonCode: choice(row.reasonCode, CONTACT_ENRICHMENT_RESULT_REASONS),
    beforeStates: states(row.beforeStates),
    afterStates: states(row.afterStates),
    pointRefs: ids(row.pointRefs, 100),
    eventRefs: ids(row.eventRefs, 18),
    attemptRefs: ids(row.attemptRefs, 3),
    newCandidate: row.newCandidate,
    newValidPersonal: nullValue(row.newValidPersonal),
  };
}
function parseSummary(
  value: unknown,
): ContactEnrichmentQualityResultV1["summary"] {
  const row = closedSafetyRecord(value, Object.keys(summarySchema.properties));
  const consideredUniqueContacts = safetyInteger(
    row.consideredUniqueContacts,
    0,
    10,
  );
  const skippedByReason = denseSafetyArray(row.skippedByReason, 10).map((v) => {
    const item = closedSafetyRecord(v, ["reasonCode", "count"]);
    return {
      reasonCode: choice(item.reasonCode, CONTACT_ENRICHMENT_RESULT_REASONS),
      count: safetyInteger(item.count, 1, consideredUniqueContacts),
    };
  });
  if (
    new Set(skippedByReason.map((v) => v.reasonCode)).size !==
      skippedByReason.length ||
    skippedByReason.reduce((n, v) => n + v.count, 0) > consideredUniqueContacts
  )
    return invalidReadInput();
  return {
    consideredUniqueContacts,
    eligibleUniqueContacts: safetyInteger(
      row.eligibleUniqueContacts,
      0,
      consideredUniqueContacts,
    ),
    stockValidPersonalContacts: nullValue(row.stockValidPersonalContacts),
    physicallyAttemptedUniqueContacts: nullableCount(
      row.physicallyAttemptedUniqueContacts,
      consideredUniqueContacts,
    ),
    newCandidatePoints: safetyInteger(row.newCandidatePoints, 0, 10),
    newValidPersonalContacts: nullValue(row.newValidPersonalContacts),
    unresolvedUniqueContacts: nullableCount(
      row.unresolvedUniqueContacts,
      consideredUniqueContacts,
    ),
    skippedByReason,
  };
}
function parseSpend(value: unknown): ContactEnrichmentQualityResultV1["spend"] {
  const row = closedSafetyRecord(value, [
    "quotedUpperBoundMicrousd",
    "knownChargedMicrousd",
    "unknownUpperBoundMicrousd",
    "costBasis",
  ]);
  const quotedUpperBoundMicrousd = microValue(row.quotedUpperBoundMicrousd);
  const knownChargedMicrousd =
    row.knownChargedMicrousd === null
      ? null
      : microValue(row.knownChargedMicrousd);
  const unknownUpperBoundMicrousd =
    row.unknownUpperBoundMicrousd === null
      ? null
      : microValue(row.unknownUpperBoundMicrousd);
  if (
    row.costBasis !== "estimated_upper_bound" ||
    (knownChargedMicrousd !== null &&
      BigInt(knownChargedMicrousd) > BigInt(quotedUpperBoundMicrousd)) ||
    (unknownUpperBoundMicrousd !== null &&
      BigInt(unknownUpperBoundMicrousd) > BigInt(quotedUpperBoundMicrousd)) ||
    (knownChargedMicrousd !== null &&
      unknownUpperBoundMicrousd !== null &&
      BigInt(knownChargedMicrousd) + BigInt(unknownUpperBoundMicrousd) >
        BigInt(quotedUpperBoundMicrousd))
  )
    return invalidReadInput();
  return {
    quotedUpperBoundMicrousd,
    knownChargedMicrousd,
    unknownUpperBoundMicrousd,
    costBasis: "estimated_upper_bound",
  };
}
function assertDistinctContactReferences(
  contacts: ContactEnrichmentQualityResultV1["perContact"],
): void {
  for (const kind of ["pointRefs", "eventRefs", "attemptRefs"] as const) {
    const owner = new Map<string, string>();
    for (const contact of contacts)
      for (const id of contact[kind]) {
        const previous = owner.get(id);
        if (previous !== undefined && previous !== contact.contactId)
          return invalidReadInput();
        owner.set(id, contact.contactId);
      }
  }
}
/** Closed metadata only. Its shape validation does not prove RLS, ledger origin or real point creation. */
export function parseContactEnrichmentQualityResult(
  value: unknown,
): ContactEnrichmentQualityResultV1 {
  const row = closedSafetyRecord(
    value,
    Object.keys(CONTACT_ENRICHMENT_QUALITY_RESULT_SCHEMA.properties),
  );
  if (
    row.version !== 1 ||
    row.protocolVersion !== 1 ||
    row.qualityCoverage !== "PREREQUISITE_ONLY"
  )
    return invalidReadInput();
  const entrypoint = choice(row.entrypoint, ["http", "discovery_run"] as const);
  if ((entrypoint === "http") !== (row.businessRunId === null))
    return invalidReadInput();
  const status = choice(row.status, CONTACT_ENRICHMENT_EXECUTION_STATUSES);
  const summary = parseSummary(row.summary),
    perContact = denseSafetyArray(row.perContact, 10).map(parseContactResult);
  if (
    new Set(perContact.map((v) => v.contactId)).size !== perContact.length ||
    (status === "REDACTED"
      ? perContact.length !== 0
      : summary.consideredUniqueContacts !== perContact.length)
  )
    return invalidReadInput();
  assertDistinctContactReferences(perContact);
  if (
    status !== "REDACTED" &&
    (summary.newCandidatePoints <
      perContact.filter((v) => v.newCandidate === true).length ||
      summary.newCandidatePoints >
        perContact.reduce((n, v) => n + v.pointRefs.length, 0))
  )
    return invalidReadInput();
  const unavailableMetrics = denseSafetyArray(row.unavailableMetrics, 4).map(
    (v) => choice(v, NULLABLE_METRICS),
  );
  if (
    canonicalSafetyJson(unavailableMetrics) !==
    canonicalSafetyJson(NULLABLE_METRICS.filter((key) => summary[key] === null))
  )
    return invalidReadInput();
  return deepFreezeSafety({
    version: 1,
    protocolVersion: 1,
    operationRef: safetyDigest(row.operationRef),
    companyId: uuidValue(row.companyId),
    entrypoint,
    businessRunId:
      row.businessRunId === null ? null : uuidValue(row.businessRunId),
    createdAt: canonicalTime(row.createdAt),
    status,
    resultRevision: safetyInteger(row.resultRevision, 1, 2147483647),
    qualityCoverage: "PREREQUISITE_ONLY",
    summary,
    perContact,
    spend: parseSpend(row.spend),
    unavailableMetrics,
  });
}


/** Derive bounded public metadata from the original scoped head, steps and ledger facts. Never materializes any artifact body. */
function metadataLedgerReceipt(record: EnrichmentRuntimeExecutionRecord, step: EnrichmentRuntimeStepRow) {
  if (!step.budget_original_id || !step.operation_key || step.budget_result_json === null) return invalidReadInput();
  const common = { scopeKey: record.workspaceId, operationId: step.budget_original_id, operationKey: step.operation_key, accountId: record.view.accountId, authorityId: record.view.authorityId,
    resultSchema: step.budget_result_schema, resultDigest: step.budget_result_digest, resultJson: step.budget_result_json, receiptUsage: step.budget_receipt_usage, receiptCostBasis: step.budget_receipt_cost_basis };
  if (step.phase === "FINDER") {
    const reference = parseArtifactReference(step.budget_result_json);
    if (reference.operationId !== step.budget_original_id || reference.sha256 !== step.budget_result_digest || reference.resultSchema !== "contact-email-find-hunter/v1") return invalidReadInput();
    const receipt = durableReceiptFromLedgerRow({ ...common, resultSchemaVersion: "generic-operation-artifact-ref/v1" }); if (!receipt) return invalidReadInput(); return receipt;
  }
  const projection = parseGenericOperationProjection(step.budget_result_json);
  const expected = step.phase === "SMTP" ? "smtp-probe-verdict/v1" : "contact-email-verify-" + step.provider + "/v1";
  if (projection.kind !== "tool" || projection.schema !== expected) return invalidReadInput();
  return requireLedgerProjectionReceipt({ ...common, expectedOperationId: step.budget_original_id, resultSchemaVersion: "generic-operation-projection/v1", expectedProjection: projection });
}
export function metadataMoney(record: EnrichmentRuntimeExecutionRecord): { spend: ContactEnrichmentQualityResultV1["spend"]; physical: number | null } {
  let quoted = 0n, charged = 0n, unresolved = 0n, uncertainPhysical = false;
  const operations = new Set<string>(), contacts = new Set<number>();
  for (const step of record.steps) {
    const quote = parseCanonicalMicrousd("original quoted microusd", step.quote_microusd.toString()); quoted += quote;
    if (step.budget_original_id === null) { if (step.budget_operation_id !== null) return invalidReadInput(); continue; }
    if (!isCanonicalArtifactUuid(step.budget_original_id) || operations.has(step.budget_original_id) || step.budget_amount_unit !== "microusd" || step.budget_reserved_microusd !== quote || step.generation !== record.view.generation || step.account_id !== record.view.accountId || step.authority_id !== record.view.authorityId) return invalidReadInput();
    operations.add(step.budget_original_id);
    const amount = step.budget_charged_microusd;
    if (amount !== null && (typeof amount !== "bigint" || amount < 0n || amount > quote)) return invalidReadInput();
    if (step.budget_status === "RESERVED" || step.budget_status === "RESULT_UNKNOWN") { unresolved += quote; uncertainPhysical = true; continue; }
    if (step.budget_status === "RELEASED") { if (amount !== null && amount !== 0n) return invalidReadInput(); continue; }
    if (step.budget_status !== "SETTLED") return invalidReadInput();
    if (amount === null) { unresolved += quote; uncertainPhysical = true; continue; }
    charged += amount;
    if (step.budget_result_json === null || step.budget_receipt_usage === null) { uncertainPhysical = true; continue; }
    const receipt = metadataLedgerReceipt(record, step);
    if (receipt.usage.upperBoundMicrousd !== quote.toString() || receipt.usage.chargedMicrousd !== amount.toString()) return invalidReadInput();
    contacts.add(safetyInteger(step.contact_ordinal, 0, 9));
  }
  return { spend: { quotedUpperBoundMicrousd: quoted.toString(), knownChargedMicrousd: charged.toString(), unknownUpperBoundMicrousd: unresolved.toString(), costBasis: "estimated_upper_bound" }, physical: uncertainPhysical ? null : contacts.size };
}
export function buildContactEnrichmentQualityResult(record: EnrichmentRuntimeExecutionRecord): ContactEnrichmentQualityResultV1 {
  let newCandidatePoints = 0;
  const decisions: ReturnType<typeof parseEnrichmentContactApplyDecision>[] = [];
  if (record.resultSnapshot !== null) {
    const snapshot = readEnrichmentResultSnapshot(record.resultSnapshot);
    if (snapshot.targetCount !== record.targetCount) return invalidReadInput();
    newCandidatePoints = snapshot.newCandidatePoints;
    decisions.push(...snapshot.contacts.map(parseEnrichmentContactApplyDecision));
    if (new Set(decisions.map((decision) => decision.contactId)).size !== decisions.length) return invalidReadInput();
  } else if (record.view.status === "REDACTED") return invalidReadInput();
  const money = metadataMoney(record), redacted = record.view.status === "REDACTED";
  if ((!redacted && !record.plan) || (redacted && decisions.length !== 0)) return invalidReadInput();
  const targets = record.plan?.targets ?? [];
  if (!redacted && (targets.length !== record.targetCount || decisions.some((decision) => !targets.some((target) => target.contactId === decision.contactId)) || decisions.reduce((n, decision) => n + decision.newCandidatePoints, 0) !== newCandidatePoints)) return invalidReadInput();
  const perContact = redacted ? [] : targets.map((target) => {
    const decision = decisions.find((candidate) => candidate.contactId === target.contactId);
    const rows = record.steps.filter((step) => step.contact_ordinal === target.contactOrdinal);
    const reasonCode = decision?.reasonCode ?? (rows.some((step) => step.budget_status === "RESULT_UNKNOWN") ? "RESULT_UNKNOWN" : "PENDING");
    return { contactId: target.contactId, reasonCode, beforeStates: [], afterStates: decision?.state && decision.pointRefs.length > 0 ? [decision.state] : [], pointRefs: decision?.pointRefs ?? target.pointRefs, eventRefs: decision?.eventRefs ?? [], attemptRefs: decision?.attemptRefs ?? [], newCandidate: decision ? decision.newCandidatePoints > 0 : null, newValidPersonal: null };
  });
  const skipped = new Map<string, number>();
  for (const contact of perContact) if (["SUPPRESSED", "DEADLINE", "BUDGET_CAP", "GOVERNANCE_PENDING", "NO_DOMAIN", "NO_CONTACTS", "REUSED"].includes(contact.reasonCode)) skipped.set(contact.reasonCode, (skipped.get(contact.reasonCode) ?? 0) + 1);
  const summary = { consideredUniqueContacts: record.targetCount, eligibleUniqueContacts: record.targetCount, stockValidPersonalContacts: null, physicallyAttemptedUniqueContacts: money.physical, newCandidatePoints, newValidPersonalContacts: null, unresolvedUniqueContacts: null, skippedByReason: [...skipped].map(([reasonCode,count]) => ({ reasonCode,count })) };
  return parseContactEnrichmentQualityResult({ version: 1, protocolVersion: 1, operationRef: record.view.operationRef, companyId: record.companyId, entrypoint: record.entrypoint, businessRunId: record.businessRunId, createdAt: record.createdAt, status: record.view.status, resultRevision: record.resultRevision, qualityCoverage: "PREREQUISITE_ONLY", summary, perContact, spend: money.spend, unavailableMetrics: NULLABLE_METRICS.filter((metric) => summary[metric] === null) });
}
