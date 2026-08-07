import { scrubSensitiveText } from "../common/sensitive-data-scrubber";

export const LEGAL_SUPPRESSION_REASONS = [
  "unsubscribe",
  "complaint",
  "art17",
  "art21",
  "legal",
] as const;

const PREFERENCE_SUPPRESSION_REASONS = new Set([
  "manual",
  "preference",
  "user_preference",
]);
const LEGAL_REASON_SET = new Set<string>(LEGAL_SUPPRESSION_REASONS);
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const CONTROL_CHARACTER = /\p{Cc}/u;

export type SuppressionReleaseRequestKind =
  "USER_PREFERENCE" | "IDENTITY_CORRECTION";

export interface SuppressionReleaseRequest {
  storedReason: string | null;
  requestKind: SuppressionReleaseRequestKind;
  justification: string;
  evidenceRef: string | null;
}

export interface SuppressionReleasePolicyDecision {
  requestAccepted: true;
  decisionStatus: "PENDING_REVIEW" | "PENDING_LEGAL_REVIEW";
  mayAutoRelease: false;
  reviewClass: "PREFERENCE" | "IDENTITY_CORRECTION";
}

function normalizedReason(reason: string | null): string {
  return (reason ?? "").trim().toLowerCase();
}

function assertBoundedText(value: string): void {
  if (value.length < 1 || value.length > 500 || CONTROL_CHARACTER.test(value)) {
    throw new Error("INVALID_JUSTIFICATION");
  }
  if (scrubSensitiveText(value, { maxLength: 1_000 }) !== value) {
    throw new Error("JUSTIFICATION_SENSITIVE_DATA_FORBIDDEN");
  }
}

/**
 * This policy only decides whether an immutable review request may be written.
 * It deliberately has no release result: application callers can never make a
 * suppression ineffective directly.
 */
export function evaluateSuppressionReleaseRequest(
  request: SuppressionReleaseRequest,
): SuppressionReleasePolicyDecision {
  assertBoundedText(request.justification);
  const reason = normalizedReason(request.storedReason);

  if (request.requestKind === "IDENTITY_CORRECTION") {
    if (!request.evidenceRef || !SAFE_REFERENCE.test(request.evidenceRef)) {
      throw new Error("CORRECTION_EVIDENCE_REQUIRED");
    }
    return {
      requestAccepted: true,
      decisionStatus: LEGAL_REASON_SET.has(reason)
        ? "PENDING_LEGAL_REVIEW"
        : "PENDING_REVIEW",
      mayAutoRelease: false,
      reviewClass: "IDENTITY_CORRECTION",
    };
  }

  if (LEGAL_REASON_SET.has(reason)) {
    throw new Error("LEGAL_SUPPRESSION_NOT_RELEASABLE");
  }
  if (!PREFERENCE_SUPPRESSION_REASONS.has(reason)) {
    throw new Error("SUPPRESSION_REASON_UNCLASSIFIED");
  }
  return {
    requestAccepted: true,
    decisionStatus: "PENDING_REVIEW",
    mayAutoRelease: false,
    reviewClass: "PREFERENCE",
  };
}
