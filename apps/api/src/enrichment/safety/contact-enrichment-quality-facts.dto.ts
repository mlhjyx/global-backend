import { EMAIL_VERIFICATION_STATES } from "../../discovery/contact-point-verification-state";
import { isCanonicalArtifactUuid } from "../../durable-results/artifact/artifact.types";
import { parseCanonicalMicrousd } from "../../tools/microusd";
import { parseEnrichmentContactApplyDecision } from "./enrichment-domain-commit";
import {
  CONTACT_ENRICHMENT_RESULT_REASONS,
  EnrichmentSafetyError,
  closedSafetyRecord,
  deepFreezeSafety,
  denseSafetyArray,
  safetyDigest,
  safetyInteger,
} from "./enrichment-safety.contract";
import {
  CONTACT_QUALITY_SKIP_REASONS,
  isContactQualitySkipReason,
  type ContactQualityFact,
} from "./enrichment-quality-facts";
import { readEnrichmentResultSnapshot } from "./enrichment-result-snapshot";
import {
  CONTACT_ENRICHMENT_EXECUTION_STATUSES,
  metadataMoney,
  type ContactEnrichmentQualityResultV1,
} from "./contact-enrichment-results.dto";
import type { EnrichmentRuntimeExecutionRecord } from "./enrichment-safety.contract";
const STATUSES = CONTACT_ENRICHMENT_EXECUTION_STATUSES;
const NULLABLE_METRICS = Object.freeze([
  "eligibleUniqueContacts",
  "stockValidPersonalContacts",
  "organizationChannelContacts",
  "unknownEmailTypeContacts",
  "physicallyAttemptedUniqueContacts",
  "newValidPersonalContacts",
  "unresolvedUniqueContacts",
  "skippedByReason",
] as const);
type QualityMetric = (typeof NULLABLE_METRICS)[number];
const QUALITY_FACT_FIELDS = Object.freeze([
  "newValidPersonal",
  "stockValidPersonal",
  "organizationChannel",
  "unknownEmailType",
  "eligible",
  "unresolved",
] as const);
const QUALITY_BOOLEAN_FIELDS = Object.freeze([
  "newCandidate",
  ...QUALITY_FACT_FIELDS,
] as const);
const PER_CONTACT_KEYS = Object.freeze([
  "contactId",
  "reasonCode",
  "committedState",
  "beforeStates",
  "afterStates",
  "pointRefs",
  "eventRefs",
  "attemptRefs",
  ...QUALITY_BOOLEAN_FIELDS,
] as const);
function invalid(): never {
  throw new EnrichmentSafetyError("INVALID_PLAN");
}
function choice<T extends string>(value: unknown, options: readonly T[]): T {
  return typeof value === "string" && options.some((entry) => entry === value)
    ? (value as T)
    : invalid();
}
function uuidValue(value: unknown): string {
  return isCanonicalArtifactUuid(value) ? value : invalid();
}
function canonicalTime(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  )
    return invalid();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value)
    return invalid();
  return value;
}
function stateValue(value: unknown): (typeof EMAIL_VERIFICATION_STATES)[number] {
  return choice(value, EMAIL_VERIFICATION_STATES);
}
function sortedStates(
  values: readonly (typeof EMAIL_VERIFICATION_STATES)[number][],
) {
  return [...new Set(values)].sort(
    (left, right) =>
      EMAIL_VERIFICATION_STATES.indexOf(left) -
      EMAIL_VERIFICATION_STATES.indexOf(right),
  );
}
function stateList(value: unknown): (typeof EMAIL_VERIFICATION_STATES)[number][] {
  const parsed = denseSafetyArray(value, 4).map(stateValue);
  if (new Set(parsed).size !== parsed.length) return invalid();
  return sortedStates(parsed);
}
function nullableStateList(
  value: unknown,
): (typeof EMAIL_VERIFICATION_STATES)[number][] | null {
  return value === null ? null : stateList(value);
}
function ids(value: unknown, max: number): string[] {
  const parsed = denseSafetyArray(value, max).map(uuidValue);
  if (new Set(parsed).size !== parsed.length) return invalid();
  return parsed;
}
function microValue(value: unknown): string {
  if (typeof value !== "string") return invalid();
  parseCanonicalMicrousd("result metadata microusd", value);
  return value;
}
function nullableBoolean(value: unknown): boolean | null {
  return value === null
    ? null
    : typeof value === "boolean"
      ? value
      : invalid();
}
function nullableCount(value: unknown, considered: number): number | null {
  return value === null ? null : safetyInteger(value, 0, considered);
}
const exactObject = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const countSchema = { type: "integer", minimum: 0, maximum: 10 };
const nullableCountSchema = { ...countSchema, nullable: true };
const booleanSchema = { type: "boolean", nullable: true };
const uuidSchema = { type: "string", format: "uuid", maxLength: 36 };
const reasonSchema = {
  type: "string",
  enum: [...CONTACT_ENRICHMENT_RESULT_REASONS],
  maxLength: 32,
};
const skipReasonSchema = {
  type: "string",
  enum: [...CONTACT_QUALITY_SKIP_REASONS],
  maxLength: 32,
};
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
const nullableStatesSchema = { ...statesSchema, nullable: true };
const idArray = (maxItems: number) => ({
  type: "array",
  maxItems,
  uniqueItems: true,
  items: uuidSchema,
});
const microSchema = { type: "string", pattern: "^(0|[1-9][0-9]*)$", maxLength: 19 };
const perContactSchema = exactObject({
  contactId: uuidSchema,
  reasonCode: reasonSchema,
  committedState: {
    type: "string",
    enum: [...EMAIL_VERIFICATION_STATES],
    nullable: true,
    maxLength: 32,
  },
  beforeStates: nullableStatesSchema,
  afterStates: nullableStatesSchema,
  pointRefs: idArray(100),
  eventRefs: idArray(18),
  attemptRefs: idArray(3),
  newCandidate: booleanSchema,
  newValidPersonal: booleanSchema,
  stockValidPersonal: booleanSchema,
  organizationChannel: booleanSchema,
  unknownEmailType: booleanSchema,
  eligible: booleanSchema,
  unresolved: booleanSchema,
});
const summarySchema = exactObject({
  consideredUniqueContacts: countSchema,
  coveredUniqueContacts: countSchema,
  eligibleUniqueContacts: nullableCountSchema,
  stockValidPersonalContacts: nullableCountSchema,
  organizationChannelContacts: nullableCountSchema,
  unknownEmailTypeContacts: nullableCountSchema,
  physicallyAttemptedUniqueContacts: nullableCountSchema,
  newCandidatePoints: countSchema,
  newValidPersonalContacts: nullableCountSchema,
  unresolvedUniqueContacts: nullableCountSchema,
  skippedByReason: {
    type: "array",
    nullable: true,
    maxItems: 10,
    items: exactObject({
      reasonCode: skipReasonSchema,
      count: { type: "integer", minimum: 1, maximum: 10 },
    }),
  },
});
/** Versioned complete facts face; never a relabel of the closed V1 prerequisite carrier. */
export const CONTACT_ENRICHMENT_QUALITY_FACTS_SCHEMA = deepFreezeSafety(
  exactObject({
    version: { type: "integer", enum: [2] },
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
    status: { type: "string", enum: [...STATUSES] },
    resultRevision: { type: "integer", minimum: 1, maximum: 2147483647 },
    qualityCoverage: {
      type: "string",
      enum: ["PREREQUISITE_ONLY", "FULL_QUALITY_FACTS"],
      description:
        "FULL_QUALITY_FACTS 仅表示每个冻结目标的同事务事实已齐，不等于产品验收或完整A包。",
    },
    basis: exactObject({
      consideredScope: { type: "string", enum: ["FROZEN_EXECUTION_TARGETS"] },
      attributionBasis: {
        type: "string",
        enum: ["CANONICAL_COMPANY_CONTACT_SCOPE"],
      },
      validityBasis: {
        type: "string",
        enum: ["ORIGINAL_VERIFICATION_RULES"],
      },
      sendability: { type: "string", enum: ["NOT_IMPLIED"] },
    }),
    summary: summarySchema,
    perContact: { type: "array", maxItems: 10, items: perContactSchema },
    spend: exactObject({
      quotedUpperBoundMicrousd: microSchema,
      knownChargedMicrousd: { ...microSchema, nullable: true },
      unknownUpperBoundMicrousd: { ...microSchema, nullable: true },
      costBasis: { type: "string", enum: ["estimated_upper_bound"] },
    }),
    unavailableMetrics: {
      type: "array",
      maxItems: 8,
      uniqueItems: true,
      items: { type: "string", enum: [...NULLABLE_METRICS] },
    },
  }),
);
export interface ContactEnrichmentQualityFactsV2 {
  readonly version: 2;
  readonly protocolVersion: 1;
  readonly operationRef: string;
  readonly companyId: string;
  readonly entrypoint: "http" | "discovery_run";
  readonly businessRunId: string | null;
  readonly createdAt: string;
  readonly status: (typeof STATUSES)[number];
  readonly resultRevision: number;
  readonly qualityCoverage: "PREREQUISITE_ONLY" | "FULL_QUALITY_FACTS";
  readonly basis: Readonly<{
    consideredScope: "FROZEN_EXECUTION_TARGETS";
    attributionBasis: "CANONICAL_COMPANY_CONTACT_SCOPE";
    validityBasis: "ORIGINAL_VERIFICATION_RULES";
    sendability: "NOT_IMPLIED";
  }>;
  readonly summary: Readonly<{
    consideredUniqueContacts: number;
    coveredUniqueContacts: number;
    eligibleUniqueContacts: number | null;
    stockValidPersonalContacts: number | null;
    organizationChannelContacts: number | null;
    unknownEmailTypeContacts: number | null;
    physicallyAttemptedUniqueContacts: number | null;
    newCandidatePoints: number;
    newValidPersonalContacts: number | null;
    unresolvedUniqueContacts: number | null;
    skippedByReason: readonly Readonly<{
      reasonCode: (typeof CONTACT_QUALITY_SKIP_REASONS)[number];
      count: number;
    }>[] | null;
  }>;
  readonly perContact: readonly Readonly<{
    contactId: string;
    reasonCode: (typeof CONTACT_ENRICHMENT_RESULT_REASONS)[number];
    committedState: (typeof EMAIL_VERIFICATION_STATES)[number] | null;
    beforeStates: readonly (typeof EMAIL_VERIFICATION_STATES)[number][] | null;
    afterStates: readonly (typeof EMAIL_VERIFICATION_STATES)[number][] | null;
    pointRefs: readonly string[];
    eventRefs: readonly string[];
    attemptRefs: readonly string[];
    newCandidate: boolean | null;
    newValidPersonal: boolean | null;
    stockValidPersonal: boolean | null;
    organizationChannel: boolean | null;
    unknownEmailType: boolean | null;
    eligible: boolean | null;
    unresolved: boolean | null;
  }>[];
  readonly spend: ContactEnrichmentQualityResultV1["spend"];
  readonly unavailableMetrics: readonly QualityMetric[];
}
type QualityRow = ContactEnrichmentQualityFactsV2["perContact"][number];
function parseRow(value: unknown): QualityRow {
  const row = closedSafetyRecord(value, PER_CONTACT_KEYS);
  const contactId = uuidValue(row.contactId);
  const reasonCode = choice(row.reasonCode, CONTACT_ENRICHMENT_RESULT_REASONS);
  const committedState =
    row.committedState === null ? null : stateValue(row.committedState);
  const pointRefs = ids(row.pointRefs, 100);
  const eventRefs = ids(row.eventRefs, 18);
  const attemptRefs = ids(row.attemptRefs, 3);
  const beforeStates = nullableStateList(row.beforeStates);
  const afterStates = nullableStateList(row.afterStates);
  const covered = beforeStates !== null && afterStates !== null;
  if ((beforeStates === null) !== (afterStates === null)) return invalid();
  const newCandidate = nullableBoolean(row.newCandidate);
  const factBooleans = QUALITY_FACT_FIELDS.map((key) => nullableBoolean(row[key]));
  const factCovered = factBooleans.some((entry) => entry !== null);
  if (factCovered !== covered || (covered && factBooleans.some((entry) => entry === null)))
    return invalid();
  if (newCandidate !== null && newCandidate !== (pointRefs.length > 0)) return invalid();
  if (covered && newCandidate === null) return invalid();
  const [
    newValidPersonal,
    stockValidPersonal,
    organizationChannel,
    unknownEmailType,
    eligible,
    unresolved,
  ] = factBooleans as (boolean | null)[];
  if (covered) {
    const skip = isContactQualitySkipReason(reasonCode);
    const expectedAfter = sortedStates([
      ...beforeStates!,
      ...(pointRefs.length > 0 && committedState !== null ? [committedState] : []),
    ]);
    if (
      eligible !== !stockValidPersonal ||
      (newValidPersonal && (!newCandidate || stockValidPersonal)) ||
      newCandidate !== (pointRefs.length > 0) ||
      unresolved !== (!stockValidPersonal && !newValidPersonal && !skip) ||
      canonicalJson(expectedAfter) !== canonicalJson(afterStates)
    )
      return invalid();
  }
  return {
    contactId,
    reasonCode,
    committedState,
    beforeStates,
    afterStates,
    pointRefs,
    eventRefs,
    attemptRefs,
    newCandidate,
    newValidPersonal,
    stockValidPersonal,
    organizationChannel,
    unknownEmailType,
    eligible,
    unresolved,
  };
}
function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}
function assertDistinctQualityReferences(
  rows: readonly QualityRow[],
): void {
  for (const kind of ["pointRefs", "eventRefs", "attemptRefs"] as const) {
    const owner = new Map<string, string>();
    for (const row of rows)
      for (const id of row[kind]) {
        const previous = owner.get(id);
        if (previous !== undefined && previous !== row.contactId)
          return invalid();
        owner.set(id, row.contactId);
      }
  }
}
function skipCounts(
  rows: readonly QualityRow[],
): readonly { reasonCode: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows)
    if (isContactQualitySkipReason(row.reasonCode))
      counts.set(row.reasonCode, (counts.get(row.reasonCode) ?? 0) + 1);
  return CONTACT_QUALITY_SKIP_REASONS.filter((reason) => counts.has(reason)).map(
    (reasonCode) => ({ reasonCode, count: counts.get(reasonCode)! }),
  );
}
function nullQualitySummary(considered: number, covered: number) {
  return {
    consideredUniqueContacts: considered,
    coveredUniqueContacts: covered,
    eligibleUniqueContacts: null,
    stockValidPersonalContacts: null,
    organizationChannelContacts: null,
    unknownEmailTypeContacts: null,
    physicallyAttemptedUniqueContacts: null as number | null,
    newCandidatePoints: 0,
    newValidPersonalContacts: null,
    unresolvedUniqueContacts: null,
    skippedByReason: null,
  };
}
function parseSummary(value: unknown) {
  const row = closedSafetyRecord(value, Object.keys(summarySchema.properties));
  const considered = safetyInteger(row.consideredUniqueContacts, 0, 10);
  const covered = safetyInteger(row.coveredUniqueContacts, 0, considered);
  const skipped = row.skippedByReason === null ? null : denseSafetyArray(row.skippedByReason, 10).map((entry) => {
    const item = closedSafetyRecord(entry, ["reasonCode", "count"]);
    return {
      reasonCode: choice(item.reasonCode, CONTACT_QUALITY_SKIP_REASONS),
      count: safetyInteger(item.count, 1, considered),
    };
  });
  if (
    skipped !== null &&
    new Set(skipped.map((entry) => entry.reasonCode)).size !== skipped.length
  )
    return invalid();
  return {
    consideredUniqueContacts: considered,
    coveredUniqueContacts: covered,
    eligibleUniqueContacts: nullableCount(row.eligibleUniqueContacts, considered),
    stockValidPersonalContacts: nullableCount(row.stockValidPersonalContacts, considered),
    organizationChannelContacts: nullableCount(row.organizationChannelContacts, considered),
    unknownEmailTypeContacts: nullableCount(row.unknownEmailTypeContacts, considered),
    physicallyAttemptedUniqueContacts: nullableCount(row.physicallyAttemptedUniqueContacts, considered),
    newCandidatePoints: safetyInteger(row.newCandidatePoints, 0, considered),
    newValidPersonalContacts: nullableCount(row.newValidPersonalContacts, considered),
    unresolvedUniqueContacts: nullableCount(row.unresolvedUniqueContacts, considered),
    skippedByReason: skipped,
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
    row.knownChargedMicrousd === null ? null : microValue(row.knownChargedMicrousd);
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
    return invalid();
  return {
    quotedUpperBoundMicrousd,
    knownChargedMicrousd,
    unknownUpperBoundMicrousd,
    costBasis: "estimated_upper_bound",
  };
}
/** Closed, versioned quality facts; the shape never proves runtime use or provider invoices. */
export function parseContactEnrichmentQualityFacts(
  value: unknown,
): ContactEnrichmentQualityFactsV2 {
  const row = closedSafetyRecord(
    value,
    Object.keys(CONTACT_ENRICHMENT_QUALITY_FACTS_SCHEMA.properties),
  );
  if (row.version !== 2 || row.protocolVersion !== 1) return invalid();
  const entrypoint = choice(row.entrypoint, ["http", "discovery_run"] as const);
  if ((entrypoint === "http") !== (row.businessRunId === null))
    return invalid();
  const status = choice(row.status, STATUSES);
  const qualityCoverage = choice(row.qualityCoverage, [
    "PREREQUISITE_ONLY",
    "FULL_QUALITY_FACTS",
  ] as const);
  const basisRow = closedSafetyRecord(row.basis, [
    "consideredScope",
    "attributionBasis",
    "validityBasis",
    "sendability",
  ]);
  const basis = {
    consideredScope: choice(basisRow.consideredScope, [
      "FROZEN_EXECUTION_TARGETS",
    ] as const),
    attributionBasis: choice(basisRow.attributionBasis, [
      "CANONICAL_COMPANY_CONTACT_SCOPE",
    ] as const),
    validityBasis: choice(basisRow.validityBasis, [
      "ORIGINAL_VERIFICATION_RULES",
    ] as const),
    sendability: choice(basisRow.sendability, ["NOT_IMPLIED"] as const),
  };
  const summary = parseSummary(row.summary);
  const perContact = denseSafetyArray(row.perContact, 10).map(parseRow);
  if (new Set(perContact.map((entry) => entry.contactId)).size !== perContact.length)
    return invalid();
  assertDistinctQualityReferences(perContact);
  const redacted = status === "REDACTED";
  if (redacted ? perContact.length !== 0 : summary.consideredUniqueContacts !== perContact.length)
    return invalid();
  const coveredRows = perContact.filter((entry) => entry.eligible !== null);
  if (
    summary.coveredUniqueContacts !== coveredRows.length ||
    summary.physicallyAttemptedUniqueContacts !== null &&
      summary.physicallyAttemptedUniqueContacts > summary.consideredUniqueContacts
  )
    return invalid();
  const complete =
    !redacted && summary.consideredUniqueContacts > 0 &&
    summary.coveredUniqueContacts === summary.consideredUniqueContacts;
  if ((qualityCoverage === "FULL_QUALITY_FACTS") !== complete) return invalid();
  const derived = [
    summary.eligibleUniqueContacts,
    summary.stockValidPersonalContacts,
    summary.organizationChannelContacts,
    summary.unknownEmailTypeContacts,
    summary.newValidPersonalContacts,
    summary.unresolvedUniqueContacts,
    summary.skippedByReason,
  ];
  if (!complete) {
    if (derived.some((entry) => entry !== null)) return invalid();
  } else {
    if (derived.some((entry) => entry === null)) return invalid();
    const count = (key: (typeof QUALITY_BOOLEAN_FIELDS)[number]) =>
      perContact.filter((entry) => entry[key] === true).length;
    const expectedSkipped = skipCounts(perContact);
    if (
      summary.eligibleUniqueContacts !== count("eligible") ||
      summary.stockValidPersonalContacts !== count("stockValidPersonal") ||
      summary.organizationChannelContacts !== count("organizationChannel") ||
      summary.unknownEmailTypeContacts !== count("unknownEmailType") ||
      summary.newValidPersonalContacts !== count("newValidPersonal") ||
      summary.unresolvedUniqueContacts !== count("unresolved") ||
      summary.newCandidatePoints < count("newCandidate") ||
      canonicalJson(summary.skippedByReason) !== canonicalJson(expectedSkipped)
    )
      return invalid();
  }
  const newCandidates = perContact.filter((entry) => entry.newCandidate === true).length;
  if (
    summary.newCandidatePoints < newCandidates ||
    summary.newCandidatePoints > summary.consideredUniqueContacts
  )
    return invalid();
  const unavailableMetrics = denseSafetyArray(row.unavailableMetrics, 8).map(
    (entry) => choice(entry, NULLABLE_METRICS),
  );
  const expectedUnavailable = NULLABLE_METRICS.filter(
    (key) => summary[key] === null,
  );
  if (canonicalJson(unavailableMetrics) !== canonicalJson(expectedUnavailable))
    return invalid();
  return deepFreezeSafety({
    version: 2 as const,
    protocolVersion: 1 as const,
    operationRef: safetyDigest(row.operationRef),
    companyId: uuidValue(row.companyId),
    entrypoint,
    businessRunId:
      row.businessRunId === null ? null : uuidValue(row.businessRunId),
    createdAt: canonicalTime(row.createdAt),
    status,
    resultRevision: safetyInteger(row.resultRevision, 1, 2147483647),
    qualityCoverage,
    basis,
    summary: {
      ...summary,
      skippedByReason: summary.skippedByReason as ContactEnrichmentQualityFactsV2["summary"]["skippedByReason"],
    },
    perContact,
    spend: parseSpend(row.spend),
    unavailableMetrics,
  });
}
/** Build the complete facts face from the original scoped head, steps and decisions only. */
export function buildContactEnrichmentQualityFacts(
  record: EnrichmentRuntimeExecutionRecord,
): ContactEnrichmentQualityFactsV2 {
  const money = metadataMoney(record);
  const redacted = record.view.status === "REDACTED";
  let snapshotContacts: readonly unknown[] = [],
    snapshotNewCandidates = 0,
    targetCount = record.targetCount,
    facts: readonly ContactQualityFact[] = [];
  if (record.resultSnapshot !== null) {
    const snapshot = readEnrichmentResultSnapshot(record.resultSnapshot);
    if (snapshot.targetCount !== record.targetCount) return invalid();
    snapshotContacts = snapshot.contacts;
    snapshotNewCandidates = snapshot.newCandidatePoints;
    targetCount = snapshot.targetCount;
    facts = snapshot.quality;
  } else if (redacted) return invalid();
  const decisions = snapshotContacts.map(parseEnrichmentContactApplyDecision);
  if (new Set(decisions.map((entry) => entry.contactId)).size !== decisions.length)
    return invalid();
  const targets = record.plan?.targets ?? [];
  if (
    (!redacted && !record.plan) ||
    (redacted && (decisions.length !== 0 || facts.length !== 0)) ||
    (!redacted && targets.length !== targetCount)
  )
    return invalid();
  const decisionById = new Map(
    decisions.map((entry) => [entry.contactId as string, entry]),
  );
  const factById = new Map(facts.map((entry) => [entry.contactId, entry]));
  for (const id of factById.keys())
    if (!decisionById.has(id)) return invalid();
  for (const [id, fact] of factById)
    if (id !== fact.contactId || !targets.some((target) => target.contactId === id))
      return invalid();
  const newCandidatePoints = redacted
    ? snapshotNewCandidates
    : decisions.reduce((sum, entry) => sum + entry.newCandidatePoints, 0);
  if (
    !redacted &&
    (newCandidatePoints !== snapshotNewCandidates || newCandidatePoints > 10)
  )
    return invalid();
  for (const [id, decision] of decisionById) {
    const fact = factById.get(id);
    if (fact && fact.newCandidate !== (decision.newCandidatePoints > 0))
      return invalid();
    if (!targets.some((target) => target.contactId === id)) return invalid();
  }
  const rows: QualityRow[] = redacted
    ? []
    : targets.map((target) => {
        const decision = decisionById.get(target.contactId);
        const fact = factById.get(target.contactId);
        return {
          contactId: target.contactId,
          reasonCode: decision?.reasonCode ?? "PENDING",
          committedState: decision?.state ?? null,
          beforeStates: fact?.beforeStates ?? null,
          afterStates: fact?.afterStates ?? null,
          pointRefs: decision?.pointRefs ?? [],
          eventRefs: decision?.eventRefs ?? [],
          attemptRefs: decision?.attemptRefs ?? [],
          newCandidate: decision ? decision.newCandidatePoints > 0 : null,
          newValidPersonal: fact?.newValidPersonal ?? null,
          stockValidPersonal: fact?.stockValidPersonal ?? null,
          organizationChannel: fact?.organizationChannel ?? null,
          unknownEmailType: fact?.emailTypeUnknown ?? null,
          eligible: fact?.eligible ?? null,
          unresolved: fact?.unresolved ?? null,
        };
      });
  const covered = redacted ? 0 : rows.filter((entry) => entry.eligible !== null).length;
  const complete =
    !redacted && rows.length > 0 && covered === rows.length;
  const qualityCoverage = complete
    ? ("FULL_QUALITY_FACTS" as const)
    : ("PREREQUISITE_ONLY" as const);
  const summary = complete
    ? {
        consideredUniqueContacts: rows.length,
        coveredUniqueContacts: covered,
        eligibleUniqueContacts: rows.filter((entry) => entry.eligible === true).length,
        stockValidPersonalContacts: rows.filter((entry) => entry.stockValidPersonal === true).length,
        organizationChannelContacts: rows.filter((entry) => entry.organizationChannel === true).length,
        unknownEmailTypeContacts: rows.filter((entry) => entry.unknownEmailType === true).length,
        physicallyAttemptedUniqueContacts: money.physical,
        newCandidatePoints,
        newValidPersonalContacts: rows.filter((entry) => entry.newValidPersonal === true).length,
        unresolvedUniqueContacts: rows.filter((entry) => entry.unresolved === true).length,
        skippedByReason: skipCounts(rows),
      }
    : {
        ...nullQualitySummary(redacted ? record.targetCount : rows.length, covered),
        physicallyAttemptedUniqueContacts: money.physical,
        newCandidatePoints,
      };
  const unavailableMetrics = NULLABLE_METRICS.filter(
    (key) => summary[key] === null,
  );
  return parseContactEnrichmentQualityFacts({
    version: 2,
    protocolVersion: 1,
    operationRef: record.view.operationRef,
    companyId: record.companyId,
    entrypoint: record.entrypoint,
    businessRunId: record.businessRunId,
    createdAt: record.createdAt,
    status: record.view.status,
    resultRevision: record.resultRevision,
    qualityCoverage,
    basis: {
      consideredScope: "FROZEN_EXECUTION_TARGETS",
      attributionBasis: "CANONICAL_COMPANY_CONTACT_SCOPE",
      validityBasis: "ORIGINAL_VERIFICATION_RULES",
      sendability: "NOT_IMPLIED",
    },
    summary,
    perContact: rows,
    spend: money.spend,
    unavailableMetrics,
  });
}
