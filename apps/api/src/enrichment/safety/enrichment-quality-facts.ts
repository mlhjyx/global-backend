import {
  EMAIL_VERIFICATION_STATES,
  type EmailVerificationState,
} from "../../discovery/contact-point-verification-state";
import { isCanonicalArtifactUuid } from "../../durable-results/artifact/artifact.types";
import {
  CONTACT_ENRICHMENT_RESULT_REASONS,
  EnrichmentSafetyError,
  closedSafetyRecord,
  deepFreezeSafety,
  denseSafetyArray,
} from "./enrichment-safety.contract";

/** Non-personal address categories that stay outside the personal denominator (A07). */
export const CONTACT_EMAIL_ORGANIZATION_TYPES = Object.freeze([
  "role",
  "generic_sales",
  "procurement",
  "management",
  "finance",
  "support",
] as const);
/** Explicit original gates; their contacts are skipped, not silently unresolved. */
export const CONTACT_QUALITY_SKIP_REASONS = Object.freeze([
  "SUPPRESSED",
  "DEADLINE",
  "BUDGET_CAP",
  "GOVERNANCE_PENDING",
  "NO_DOMAIN",
  "NO_CONTACTS",
  "UNAVAILABLE",
] as const);
const STATES: ReadonlySet<string> = new Set(EMAIL_VERIFICATION_STATES);
const ORG_TYPES: ReadonlySet<string> = new Set(CONTACT_EMAIL_ORGANIZATION_TYPES);
const REASONS: ReadonlySet<string> = new Set(CONTACT_ENRICHMENT_RESULT_REASONS);
const SKIPPED: ReadonlySet<string> = new Set(CONTACT_QUALITY_SKIP_REASONS);
function bad(): never {
  throw new EnrichmentSafetyError("INVALID_PLAN");
}
export function isContactQualitySkipReason(value: string): boolean {
  return SKIPPED.has(value);
}

/** One pre-existing contact point as locked by the original commit transaction. */
export interface ContactQualityPoint {
  readonly id: string;
  readonly type: string;
  readonly emailType: string | null;
  readonly verificationState: string;
}
export interface ContactQualityDecision {
  readonly status: "APPLIED" | "REPLAYED" | "SAVE_PENDING" | "REDACTED";
  readonly reasonCode: string;
  readonly state: string | null;
  readonly pointRefs: readonly string[];
  readonly newCandidatePoints: number;
}
/** The newly written point of this commit, classified from the original finder address. */
export interface ContactQualityNewPoint {
  readonly emailType: string | null;
  readonly state: string;
}
/** Bounded per-contact facts of exactly one original domain commit; no addresses or names. */
export interface ContactQualityFact {
  readonly contactId: string;
  readonly beforeStates: readonly EmailVerificationState[];
  readonly afterStates: readonly EmailVerificationState[];
  readonly stockValidPersonal: boolean;
  readonly organizationChannel: boolean;
  readonly emailTypeUnknown: boolean;
  readonly eligible: boolean;
  readonly newCandidate: boolean;
  readonly newValidPersonal: boolean;
  readonly unresolved: boolean;
}
const FACT_KEYS = [
  "contactId",
  "beforeStates",
  "afterStates",
  "stockValidPersonal",
  "organizationChannel",
  "emailTypeUnknown",
  "eligible",
  "newCandidate",
  "newValidPersonal",
  "unresolved",
] as const;
function stateList(value: unknown, max: number): EmailVerificationState[] {
  const parsed = denseSafetyArray(value, max).map((entry) =>
    typeof entry === "string" && STATES.has(entry)
      ? (entry as EmailVerificationState)
      : bad(),
  );
  if (new Set(parsed).size !== parsed.length) return bad();
  return parsed.sort(
    (left, right) =>
      EMAIL_VERIFICATION_STATES.indexOf(left) -
      EMAIL_VERIFICATION_STATES.indexOf(right),
  );
}
function sortedStates(values: Iterable<EmailVerificationState>) {
  return [...new Set(values)].sort(
    (left, right) =>
      EMAIL_VERIFICATION_STATES.indexOf(left) -
      EMAIL_VERIFICATION_STATES.indexOf(right),
  );
}
function emailPoints(
  points: readonly ContactQualityPoint[],
): ContactQualityPoint[] {
  const ids = new Set<string>();
  return points.filter((point) => {
    if (
      !isCanonicalArtifactUuid(point.id) ||
      ids.has(point.id) ||
      typeof point.type !== "string" ||
      point.type.length < 1 ||
      point.type.length > 64 ||
      !STATES.has(point.verificationState) ||
      (point.emailType !== null &&
        (typeof point.emailType !== "string" ||
          point.emailType.length > 64))
    )
      return bad();
    ids.add(point.id);
    return point.type === "email";
  });
}
export function buildContactQualityFact(input: {
  readonly contactId: string;
  readonly points: readonly ContactQualityPoint[];
  readonly decision: ContactQualityDecision;
  readonly newPoint: ContactQualityNewPoint | null;
}): ContactQualityFact {
  const contactId = input.contactId;
  if (!isCanonicalArtifactUuid(contactId)) return bad();
  const points = denseSafetyArray(input.points, 100);
  for (const point of points)
    if (!point || typeof point !== "object") return bad();
  const email = emailPoints(points as ContactQualityPoint[]);
  const decision = input.decision;
  if (
    !decision ||
    (decision.status !== "APPLIED" &&
      decision.status !== "REPLAYED" &&
      decision.status !== "SAVE_PENDING" &&
      decision.status !== "REDACTED") ||
    typeof decision.reasonCode !== "string" ||
    !REASONS.has(decision.reasonCode) ||
    (decision.state !== null &&
      (typeof decision.state !== "string" || !STATES.has(decision.state))) ||
    !Number.isSafeInteger(decision.newCandidatePoints) ||
    decision.newCandidatePoints < 0 ||
    decision.newCandidatePoints > 10
  )
    return bad();
  const refs = denseSafetyArray(decision.pointRefs, 1).map((ref) =>
    isCanonicalArtifactUuid(ref) ? ref : bad(),
  );
  if (new Set(refs).size !== refs.length) return bad();
  if (decision.status === "REDACTED") return bad();
  const newPoint = input.newPoint;
  if (refs.length === 0) {
    if (newPoint !== null || decision.newCandidatePoints !== 0) return bad();
  } else {
    if (
      newPoint === null ||
      decision.state === null ||
      newPoint.state !== decision.state ||
      decision.newCandidatePoints !== refs.length ||
      (newPoint.emailType !== null &&
        (typeof newPoint.emailType !== "string" ||
          newPoint.emailType.length > 64))
    )
      return bad();
  }
  const beforeStates = sortedStates(
    email.map((point) => point.verificationState as EmailVerificationState),
  );
  const stockValidPersonal = email.some(
    (point) =>
      point.emailType === "personal" &&
      point.verificationState === "VALID",
  );
  const organizationChannel =
    email.some(
      (point) =>
        point.emailType !== null && ORG_TYPES.has(point.emailType),
    ) ||
    (newPoint !== null &&
      newPoint.emailType !== null &&
      ORG_TYPES.has(newPoint.emailType));
  const emailTypeUnknown =
    email.some(
      (point) =>
        point.emailType === null ||
        (point.emailType !== "personal" && !ORG_TYPES.has(point.emailType)),
    ) ||
    (newPoint !== null &&
      (newPoint.emailType === null ||
        (newPoint.emailType !== "personal" &&
          !ORG_TYPES.has(newPoint.emailType))));
  const newCandidate = refs.length > 0;
  const afterStates = newPoint
    ? sortedStates([
        ...beforeStates,
        newPoint.state as EmailVerificationState,
      ])
    : beforeStates;
  const newValidPersonal =
    newCandidate &&
    newPoint!.emailType === "personal" &&
    newPoint!.state === "VALID" &&
    !stockValidPersonal;
  const unresolved =
    !stockValidPersonal &&
    !newValidPersonal &&
    !isContactQualitySkipReason(decision.reasonCode);
  return deepFreezeSafety({
    contactId,
    beforeStates,
    afterStates,
    stockValidPersonal,
    organizationChannel,
    emailTypeUnknown,
    eligible: !stockValidPersonal,
    newCandidate,
    newValidPersonal,
    unresolved,
  });
}
/** Closed persisted fact; the shape alone never proves RLS, attribution or real point creation. */
export function parseContactQualityFact(value: unknown): ContactQualityFact {
  const row = closedSafetyRecord(value, FACT_KEYS);
  for (const key of [
    "stockValidPersonal",
    "organizationChannel",
    "emailTypeUnknown",
    "eligible",
    "newCandidate",
    "newValidPersonal",
    "unresolved",
  ] as const)
    if (typeof row[key] !== "boolean") return bad();
  const fact = {
    contactId: isCanonicalArtifactUuid(row.contactId) ? row.contactId : bad(),
    beforeStates: stateList(row.beforeStates, 4),
    afterStates: stateList(row.afterStates, 4),
    stockValidPersonal: row.stockValidPersonal as boolean,
    organizationChannel: row.organizationChannel as boolean,
    emailTypeUnknown: row.emailTypeUnknown as boolean,
    eligible: row.eligible as boolean,
    newCandidate: row.newCandidate as boolean,
    newValidPersonal: row.newValidPersonal as boolean,
    unresolved: row.unresolved as boolean,
  };
  if (
    fact.eligible !== !fact.stockValidPersonal ||
    (fact.newValidPersonal &&
      (!fact.newCandidate || fact.stockValidPersonal)) ||
    (fact.unresolved && (fact.stockValidPersonal || fact.newValidPersonal))
  )
    return bad();
  return deepFreezeSafety(fact);
}
/** The same-transaction quality block stored beside the original decisions. */
export function parseContactQualityBlock(
  value: unknown,
): readonly ContactQualityFact[] {
  const row = closedSafetyRecord(value, ["version", "contacts"]);
  if (row.version !== 1) return bad();
  const contacts = denseSafetyArray(row.contacts, 10).map(
    parseContactQualityFact,
  );
  if (new Set(contacts.map((fact) => fact.contactId)).size !== contacts.length)
    return bad();
  return deepFreezeSafety(contacts);
}
