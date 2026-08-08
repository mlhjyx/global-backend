export const LEAD_QUALITY_LABELS = [
  "QGO_CREATED",
  "SALES_ACCEPTED",
  "COMMERCIAL_OUTCOME_VERIFIED",
  "LEAD_OUTCOME_REJECTED",
] as const;

export const LEAD_QUALITY_REASON_CODES = [
  "NOT_ICP",
  "BAD_TIMING",
  "UNREACHABLE",
  "DUPLICATE",
  "INSUFFICIENT_EVIDENCE",
  "COMPLIANCE_BLOCKED",
  "OTHER",
] as const;

export const LEAD_QUALITY_COMMERCIAL_RESULTS = ["WON", "LOST"] as const;

export const LEAD_QUALITY_HELD_REASONS = [
  "OCCURRED_BEFORE_HANDOFF",
  "OCCURRED_AT_IN_FUTURE",
  "OUT_OF_ORDER_ARRIVAL",
  "MISSING_QGO_CREATED",
  "MISSING_PREREQUISITE",
  "CONTRADICTORY_POSITIVE_LABEL",
  "CONTRADICTORY_REJECTION",
  "CONTRADICTORY_COMMERCIAL_RESULT",
] as const;

export type LeadQualityLabel = (typeof LEAD_QUALITY_LABELS)[number];
export type LeadQualityReasonCode = (typeof LEAD_QUALITY_REASON_CODES)[number];
export type LeadQualityCommercialResult =
  (typeof LEAD_QUALITY_COMMERCIAL_RESULTS)[number];
export type LeadQualityHeldReason = (typeof LEAD_QUALITY_HELD_REASONS)[number];
export type LeadQualityDisposition = "ACCEPTED" | "HELD";

export interface LeadQualityLabelRequestShape {
  source_event_id: string;
  lead_id: string;
  lead_qualified_event_id: string;
  label: LeadQualityLabel;
  occurred_at: string;
  source_system: string;
  external_object_ref?: string;
  reason_code?: LeadQualityReasonCode;
  commercial_result?: LeadQualityCommercialResult;
}

export interface NormalizedLeadQualityLabelRequest {
  sourceEventId: string;
  leadId: string;
  leadQualifiedEventId: string;
  label: LeadQualityLabel;
  occurredAt: Date;
  sourceSystem: string;
  externalObjectRef: string | null;
  reasonCode: LeadQualityReasonCode | null;
  commercialResult: LeadQualityCommercialResult | null;
}

export interface AcceptedLeadQualityLabel {
  label: LeadQualityLabel;
  reasonCode: LeadQualityReasonCode | null;
  commercialResult: LeadQualityCommercialResult | null;
  occurredAt: Date;
}

export interface LeadQualityClassificationContext {
  handoffOccurredAt: Date;
  observedAt: Date;
}

export const MAX_LABEL_FUTURE_SKEW_MS = 5 * 60 * 1_000;

export interface LeadQualityClassification {
  disposition: LeadQualityDisposition;
  heldReason: LeadQualityHeldReason | null;
}

const REQUEST_KEYS = new Set([
  "source_event_id",
  "lead_id",
  "lead_qualified_event_id",
  "label",
  "occurred_at",
  "source_system",
  "external_object_ref",
  "reason_code",
  "commercial_result",
]);
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_SYSTEM = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VISIBLE_ASCII = /^[!-~]+$/;
const ISO_DATE_TIME_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function fail(field: string, message: string): never {
  throw new Error(`${field}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends readonly string[]>(
  value: unknown,
  values: T,
): value is T[number] {
  return (
    typeof value === "string" && (values as readonly string[]).includes(value)
  );
}

function requiredString(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== "string") fail(field, "must be a string");
  return value;
}

function isSafeOpaqueIdentifier(value: string, maxLength: number): boolean {
  return (
    value.length >= 1 && value.length <= maxLength && VISIBLE_ASCII.test(value)
  );
}

/**
 * Runtime validation shared by the HTTP service and the operator CLI. The REST
 * contract remains code-first OpenAPI; this function protects direct/internal
 * callers and enforces the cross-field rules class-validator cannot express.
 */
export function normalizeLeadQualityLabelRequest(
  input: unknown,
): NormalizedLeadQualityLabelRequest {
  if (!isRecord(input)) fail("request", "must be an object");
  for (const key of Object.keys(input)) {
    if (
      (key === "workspace_id" || key === "actor_id") &&
      input[key] === undefined
    )
      continue;
    if (!REQUEST_KEYS.has(key)) fail(key, "is not allowed");
  }

  const sourceEventId = requiredString(input, "source_event_id");
  if (!isSafeOpaqueIdentifier(sourceEventId, 128)) {
    fail(
      "source_event_id",
      "must be a visible identifier up to 128 characters",
    );
  }

  const leadId = requiredString(input, "lead_id");
  if (!UUID_V4.test(leadId)) fail("lead_id", "must be a UUID v4");

  const leadQualifiedEventId = requiredString(input, "lead_qualified_event_id");
  if (!UUID_V4.test(leadQualifiedEventId))
    fail("lead_qualified_event_id", "must be a UUID v4");

  const label = input.label;
  if (!isOneOf(label, LEAD_QUALITY_LABELS))
    fail("label", "must be a supported label");

  const occurredAtRaw = requiredString(input, "occurred_at");
  const occurredAt = new Date(occurredAtRaw);
  if (
    !Number.isFinite(occurredAt.getTime()) ||
    !ISO_DATE_TIME_WITH_ZONE.test(occurredAtRaw)
  ) {
    fail("occurred_at", "must be an ISO-8601 date-time");
  }

  const sourceSystem = requiredString(input, "source_system");
  if (!SOURCE_SYSTEM.test(sourceSystem))
    fail(
      "source_system",
      "must be a lowercase machine identifier up to 64 characters",
    );

  const externalRefValue = input.external_object_ref;
  if (
    externalRefValue !== undefined &&
    (typeof externalRefValue !== "string" ||
      !isSafeOpaqueIdentifier(externalRefValue, 256))
  ) {
    fail(
      "external_object_ref",
      "must be a visible identifier up to 256 characters",
    );
  }

  const reasonValue = input.reason_code;
  if (
    reasonValue !== undefined &&
    !isOneOf(reasonValue, LEAD_QUALITY_REASON_CODES)
  ) {
    fail("reason_code", "must be a supported reason code");
  }
  if (label === "LEAD_OUTCOME_REJECTED" && reasonValue === undefined) {
    fail("reason_code", "is required for LEAD_OUTCOME_REJECTED");
  }
  if (label !== "LEAD_OUTCOME_REJECTED" && reasonValue !== undefined) {
    fail("reason_code", "is only allowed for LEAD_OUTCOME_REJECTED");
  }

  const commercialValue = input.commercial_result;
  if (
    commercialValue !== undefined &&
    !isOneOf(commercialValue, LEAD_QUALITY_COMMERCIAL_RESULTS)
  ) {
    fail("commercial_result", "must be WON or LOST");
  }
  if (
    label === "COMMERCIAL_OUTCOME_VERIFIED" &&
    commercialValue === undefined
  ) {
    fail("commercial_result", "is required for COMMERCIAL_OUTCOME_VERIFIED");
  }
  if (
    label !== "COMMERCIAL_OUTCOME_VERIFIED" &&
    commercialValue !== undefined
  ) {
    fail(
      "commercial_result",
      "is only allowed for COMMERCIAL_OUTCOME_VERIFIED",
    );
  }

  return {
    sourceEventId,
    leadId,
    leadQualifiedEventId,
    label,
    occurredAt,
    sourceSystem,
    externalObjectRef: externalRefValue ?? null,
    reasonCode: reasonValue ?? null,
    commercialResult: commercialValue ?? null,
  };
}

/**
 * Classifies one immutable arrival against previously ACCEPTED facts only.
 * HELD facts never become prerequisites and are never silently reclassified.
 */
export function classifyLeadQualityLabel(
  input: Pick<
    NormalizedLeadQualityLabelRequest,
    "label" | "reasonCode" | "commercialResult" | "occurredAt"
  >,
  accepted: readonly AcceptedLeadQualityLabel[],
  context: LeadQualityClassificationContext,
): LeadQualityClassification {
  if (input.occurredAt.getTime() < context.handoffOccurredAt.getTime()) {
    return { disposition: "HELD", heldReason: "OCCURRED_BEFORE_HANDOFF" };
  }
  if (
    input.occurredAt.getTime() >
    context.observedAt.getTime() + MAX_LABEL_FUTURE_SKEW_MS
  ) {
    return { disposition: "HELD", heldReason: "OCCURRED_AT_IN_FUTURE" };
  }
  if (
    accepted.some(
      (fact) => fact.occurredAt.getTime() > input.occurredAt.getTime(),
    )
  ) {
    return { disposition: "HELD", heldReason: "OUT_OF_ORDER_ARRIVAL" };
  }

  const causalFacts = accepted.filter(
    (fact) => fact.occurredAt.getTime() <= input.occurredAt.getTime(),
  );
  const hasAccepted = (label: LeadQualityLabel): boolean =>
    causalFacts.some((fact) => fact.label === label);
  const acceptedRejections = causalFacts.filter(
    (fact) => fact.label === "LEAD_OUTCOME_REJECTED",
  );

  if (input.label === "LEAD_OUTCOME_REJECTED") {
    if (causalFacts.some((fact) => fact.label !== "LEAD_OUTCOME_REJECTED")) {
      return {
        disposition: "HELD",
        heldReason: "CONTRADICTORY_POSITIVE_LABEL",
      };
    }
    if (
      acceptedRejections.some((fact) => fact.reasonCode !== input.reasonCode)
    ) {
      return { disposition: "HELD", heldReason: "CONTRADICTORY_REJECTION" };
    }
    return { disposition: "ACCEPTED", heldReason: null };
  }

  if (acceptedRejections.length > 0) {
    return { disposition: "HELD", heldReason: "CONTRADICTORY_REJECTION" };
  }

  if (input.label === "QGO_CREATED") {
    return { disposition: "ACCEPTED", heldReason: null };
  }

  if (input.label === "SALES_ACCEPTED") {
    return hasAccepted("QGO_CREATED")
      ? { disposition: "ACCEPTED", heldReason: null }
      : { disposition: "HELD", heldReason: "MISSING_QGO_CREATED" };
  }

  const oppositeCommercialFact = causalFacts.some(
    (fact) =>
      fact.label === "COMMERCIAL_OUTCOME_VERIFIED" &&
      fact.commercialResult !== null &&
      fact.commercialResult !== input.commercialResult,
  );
  if (oppositeCommercialFact) {
    return {
      disposition: "HELD",
      heldReason: "CONTRADICTORY_COMMERCIAL_RESULT",
    };
  }

  return hasAccepted("QGO_CREATED") && hasAccepted("SALES_ACCEPTED")
    ? { disposition: "ACCEPTED", heldReason: null }
    : { disposition: "HELD", heldReason: "MISSING_PREREQUISITE" };
}
