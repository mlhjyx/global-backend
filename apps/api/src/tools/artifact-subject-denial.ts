/**
 * G3 (spec 2026-09-24 §4.2): prohibition-class ToolBroker denials for a
 * subject-bound artifact call. In a per-company enrichment stage these skip
 * that company (counted into PARTIAL) instead of failing the run. Budget,
 * authorization, storage and other control errors are never skippable, and
 * `isExecutionControlError` is unchanged, so the discovery stage (no subject)
 * keeps its previous fail-the-query behaviour.
 */
export const SKIPPABLE_ARTIFACT_SUBJECT_DENIALS: ReadonlySet<string> = new Set([
  'GENERIC_OPERATION_ARTIFACT_SUBJECT_BINDING_HOLD',
  'GENERIC_OPERATION_ARTIFACT_SUBJECT_TOMBSTONED',
  'GENERIC_OPERATION_ARTIFACT_SUBJECT_SUPPRESSED',
  'GENERIC_OPERATION_ARTIFACT_SUBJECT_BINDING_INVALID',
]);

const MAX_CAUSE_DEPTH = 12;

function brandedDenialReason(value: object): string | null {
  const candidate = value as { name?: unknown; toolId?: unknown; reason?: unknown };
  return candidate.name === 'ToolPolicyDenied' &&
    typeof candidate.toolId === 'string' &&
    typeof candidate.reason === 'string' &&
    SKIPPABLE_ARTIFACT_SUBJECT_DENIALS.has(candidate.reason)
    ? candidate.reason
    : null;
}

/** The skippable denial reason carried by `error` or its cause chain, else null. */
export function artifactSubjectSkipReason(error: unknown): string | null {
  const visited = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (!current || typeof current !== 'object' || visited.has(current)) return null;
    visited.add(current);
    const reason = brandedDenialReason(current);
    if (reason) return reason;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
