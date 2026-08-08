export const COMPANY_IDENTITY_RULE_VERSION =
  "company-identity-resolution/2026-08-08-v1" as const;

export const IDENTITY_RESOLUTION_DECISIONS = Object.freeze([
  "AUTO_LINK",
  "REVIEW_LINK",
  "REJECT_LINK",
  "SPLIT",
] as const);
export const HUMAN_IDENTITY_REVIEW_DECISIONS = Object.freeze([
  "REVIEW_LINK",
  "REJECT_LINK",
  "SPLIT",
] as const);
export const IDENTITY_EVIDENCE_TYPES = Object.freeze([
  "FIELD_EVIDENCE",
  "RAW_RECORD",
  "SOURCE_SIGNAL",
] as const);

export type IdentityResolutionDecision =
  (typeof IDENTITY_RESOLUTION_DECISIONS)[number];
export type HumanIdentityReviewDecision =
  (typeof HUMAN_IDENTITY_REVIEW_DECISIONS)[number];
export type IdentityEvidenceType = (typeof IDENTITY_EVIDENCE_TYPES)[number];

export interface IdentityEvidenceRef {
  type: IdentityEvidenceType;
  id: string;
}

export interface NormalizedHumanIdentityReviewRequest {
  canonicalCompanyId: string;
  linkedCanonicalCompanyId: string | null;
  decision: HumanIdentityReviewDecision;
  ruleVersion: string;
  evidenceRefs: readonly Readonly<IdentityEvidenceRef>[];
}

export interface NormalizedSystemIdentityResolutionDecision {
  workspaceId: string;
  canonicalCompanyId: string;
  linkedCanonicalCompanyId: string | null;
  decision: "AUTO_LINK";
  ruleVersion: string;
  evidenceRefs: readonly Readonly<IdentityEvidenceRef>[];
  actorId: string;
  decidedAt: Date;
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RULE_VERSION = /^[a-z0-9][a-z0-9._/-]{0,127}$/u;
const SYSTEM_ACTOR = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const HUMAN_FIELDS = new Set([
  "canonical_company_id",
  "linked_canonical_company_id",
  "decision",
  "rule_version",
  "evidence_refs",
]);

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("identity review request must be an object");
  }
  return value as Record<string, unknown>;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_V4.test(value)) {
    throw new Error(`${field} must be a UUID v4`);
  }
  return value;
}

function evidenceRefs(
  value: unknown,
  allowedTypes: readonly IdentityEvidenceType[],
): readonly Readonly<IdentityEvidenceRef>[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new Error("evidence_refs must contain 1..32 references");
  }
  const seen = new Set<string>();
  const refs = value.map((candidate) => {
    const item = record(candidate);
    if (
      Object.keys(item).some((key) => !["type", "id"].includes(key)) ||
      !IDENTITY_EVIDENCE_TYPES.includes(item.type as IdentityEvidenceType) ||
      !allowedTypes.includes(item.type as IdentityEvidenceType)
    ) {
      throw new Error("evidence_refs contains an unsupported reference");
    }
    const ref = Object.freeze({
      type: item.type as IdentityEvidenceType,
      id: uuid(item.id, "evidence_refs.id"),
    });
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) throw new Error("duplicate evidence_refs are forbidden");
    seen.add(key);
    return ref;
  });
  return Object.freeze(refs);
}

function ruleVersion(value: unknown): string {
  if (typeof value !== "string" || !RULE_VERSION.test(value)) {
    throw new Error("rule_version is invalid");
  }
  return value;
}

export function normalizeHumanIdentityReviewRequest(
  input: unknown,
): Readonly<NormalizedHumanIdentityReviewRequest> {
  const value = record(input);
  const unsupported = Object.keys(value).find((key) => !HUMAN_FIELDS.has(key));
  if (unsupported) throw new Error(`unsupported field: ${unsupported}`);
  if (
    !HUMAN_IDENTITY_REVIEW_DECISIONS.includes(
      value.decision as HumanIdentityReviewDecision,
    )
  ) {
    throw new Error("unsupported human identity review decision");
  }
  const canonicalCompanyId = uuid(
    value.canonical_company_id,
    "canonical_company_id",
  );
  const linkedCanonicalCompanyId =
    value.linked_canonical_company_id === undefined ||
    value.linked_canonical_company_id === null
      ? null
      : uuid(value.linked_canonical_company_id, "linked_canonical_company_id");
  const decision = value.decision as HumanIdentityReviewDecision;
  if (decision === "REVIEW_LINK" && !linkedCanonicalCompanyId) {
    throw new Error("REVIEW_LINK requires a linked target");
  }
  if (decision === "SPLIT" && linkedCanonicalCompanyId) {
    throw new Error("SPLIT forbids a linked target");
  }
  if (linkedCanonicalCompanyId === canonicalCompanyId) {
    throw new Error("self-link is forbidden");
  }
  return Object.freeze({
    canonicalCompanyId,
    linkedCanonicalCompanyId,
    decision,
    ruleVersion: ruleVersion(value.rule_version),
    // Human review must cite tenant-scoped company evidence. Platform/raw facts
    // first need a governed projection before a human can rely on them.
    evidenceRefs: evidenceRefs(value.evidence_refs, ["FIELD_EVIDENCE"]),
  });
}

export function normalizeSystemIdentityResolutionDecision(
  input: Omit<NormalizedSystemIdentityResolutionDecision, "decision"> & {
    decision: IdentityResolutionDecision;
  },
): Readonly<NormalizedSystemIdentityResolutionDecision> {
  if (input.decision !== "AUTO_LINK") {
    throw new Error("unsupported system identity resolution decision");
  }
  const canonicalCompanyId = uuid(
    input.canonicalCompanyId,
    "canonicalCompanyId",
  );
  const linkedCanonicalCompanyId = input.linkedCanonicalCompanyId
    ? uuid(input.linkedCanonicalCompanyId, "linkedCanonicalCompanyId")
    : null;
  if (linkedCanonicalCompanyId === canonicalCompanyId) {
    throw new Error("self-link is forbidden");
  }
  if (!UUID_V4.test(input.workspaceId)) throw new Error("workspaceId is invalid");
  if (!SYSTEM_ACTOR.test(input.actorId)) throw new Error("actorId is invalid");
  if (!(input.decidedAt instanceof Date) || Number.isNaN(input.decidedAt.getTime())) {
    throw new Error("decidedAt is invalid");
  }
  return Object.freeze({
    workspaceId: input.workspaceId,
    canonicalCompanyId,
    linkedCanonicalCompanyId,
    decision: "AUTO_LINK",
    ruleVersion: ruleVersion(input.ruleVersion),
    evidenceRefs: evidenceRefs(input.evidenceRefs, IDENTITY_EVIDENCE_TYPES),
    actorId: input.actorId,
    decidedAt: new Date(input.decidedAt.getTime()),
  });
}
