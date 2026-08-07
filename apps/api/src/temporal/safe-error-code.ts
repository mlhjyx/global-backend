/**
 * Workflow-sandbox-safe error evidence.
 *
 * This module deliberately has no Node imports, clocks, randomness or mutable
 * registration API. It inspects only exact machine markers and never reads an
 * Error message, stack, arbitrary property value or general string coercion.
 */
export const SAFE_TEMPORAL_ERROR_CODES = Object.freeze([
  'BUDGET_EXCEEDED',
  'ACQUISITION_ACTIVITY_FAILED',
  'ACQUISITION_SOURCE_FAILED',
  'ACQUISITION_SOURCE_SKIPPED',
  'INTENT_WATCH_FAILED',
  'INTENT_WATCH_SKIPPED',
  'DISCOVERY_QUERY_FAILED',
  'EXTERNAL_TARGET_RESOLUTION_FAILED',
  'EXTERNAL_SIGNAL_INGEST_FAILED',
  'EXTERNAL_INTENT_RECOMPUTE_FAILED',
  'EXTERNAL_INTENT_PROJECTION_FAILED',
  'CPV_RESOLUTION_FAILED',
  'FDA_RESOLUTION_FAILED',
  'NAICS_RESOLUTION_FAILED',
  'TED_SIGNAL_INGEST_FAILED',
  'OPENFDA_SIGNAL_INGEST_FAILED',
  'SAMGOV_SIGNAL_INGEST_FAILED',
  'TED_BROKER_UNAVAILABLE',
  'OPENFDA_BROKER_UNAVAILABLE',
  'SAMGOV_BROKER_UNAVAILABLE',
  'TED_EMPTY_QUERY',
  'OPENFDA_EMPTY_QUERY',
  'SAMGOV_EMPTY_QUERY',
  'TED_LEASE_BUSY',
  'OPENFDA_LEASE_BUSY',
  'SAMGOV_LEASE_BUSY',
  'TED_LEASE_LOST',
  'OPENFDA_LEASE_LOST',
  'SAMGOV_LEASE_LOST',
  'TED_SIGNAL_FETCH_FAILED',
  'OPENFDA_SIGNAL_FETCH_FAILED',
  'SAMGOV_SIGNAL_FETCH_FAILED',
  'TED_PROJECTION_FAILED',
  'OPENFDA_PROJECTION_FAILED',
  'SAMGOV_PROJECTION_FAILED',
] as const);

export type SafeTemporalErrorCode = (typeof SAFE_TEMPORAL_ERROR_CODES)[number];

const SAFE_CODES: ReadonlySet<string> = new Set(SAFE_TEMPORAL_ERROR_CODES);
const BUDGET_MARKERS: ReadonlySet<string> = new Set([
  'BUDGET_EXCEEDED',
  'BudgetExceededError',
  'budget_exceeded',
]);
const MAX_CAUSE_DEPTH = 5;

function exactSafeCode(value: unknown): SafeTemporalErrorCode | null {
  if (typeof value !== 'string') return null;
  if (BUDGET_MARKERS.has(value)) return 'BUDGET_EXCEEDED';
  return SAFE_CODES.has(value) ? (value as SafeTemporalErrorCode) : null;
}

function safeField(record: Record<string, unknown>, field: string): unknown {
  try {
    return record[field];
  } catch {
    return undefined;
  }
}

/**
 * Resolve a closed code from a direct error or a bounded Temporal cause chain.
 * Only `code`, `type` and `name` are considered, and only exact allowlisted
 * values are returned. `message`, `stack` and other data are never observed.
 */
export function safeTemporalErrorCode(
  error: unknown,
  fallback: SafeTemporalErrorCode,
): SafeTemporalErrorCode {
  let cursor = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) {
      break;
    }
    const record = cursor as Record<string, unknown>;
    for (const field of ['code', 'type', 'name'] as const) {
      const code = exactSafeCode(safeField(record, field));
      if (code) return code;
    }
    cursor = safeField(record, 'cause');
  }
  return fallback;
}

/**
 * Sanitize a semicolon-delimited machine-code field received from an activity.
 * Any unknown token is replaced with the caller's closed fallback. This lets
 * workflows distrust activity results without copying arbitrary strings.
 */
export function safeErrorCodeSequence(
  value: unknown,
  fallback: SafeTemporalErrorCode,
): string {
  if (typeof value !== 'string') return fallback;
  const output: SafeTemporalErrorCode[] = [];
  let rejected = false;
  for (const token of value.split(';')) {
    const code = exactSafeCode(token.trim());
    if (code) {
      if (!output.includes(code)) output.push(code);
    } else {
      rejected = true;
    }
  }
  if (rejected || output.length === 0) {
    if (!output.includes(fallback)) output.push(fallback);
  }
  return output.join(';');
}

export function appendSafeErrorCode(
  current: string | undefined,
  next: SafeTemporalErrorCode,
): string {
  if (!current) return next;
  const codes = current.split(';').filter((code) => SAFE_CODES.has(code));
  if (!codes.includes(next)) codes.push(next);
  return codes.join(';');
}

export function safeErrorCodeList(
  values: readonly unknown[],
  fallback: SafeTemporalErrorCode,
): string[] {
  const output: string[] = [];
  for (const value of values) {
    for (const code of safeErrorCodeSequence(value, fallback).split(';')) {
      if (!output.includes(code)) output.push(code);
    }
  }
  return output;
}

/**
 * Remove an untrusted free-text reason from an activity result before it can
 * be serialized into Temporal history. Only the result status selects the
 * replacement; the original reason is never inspected or copied.
 */
export function sanitizeTemporalResultReason<
  T extends { status: 'DONE' | 'FAILED' | 'SKIPPED'; reason?: string },
>(
  result: T,
  codes: Readonly<{
    failed: SafeTemporalErrorCode;
    skipped: SafeTemporalErrorCode;
  }>,
): T {
  if (result.reason === undefined) return result;
  const { reason: _untrustedReason, ...withoutReason } = result;
  if (result.status === 'DONE') return withoutReason as T;
  return {
    ...withoutReason,
    reason: result.status === 'SKIPPED' ? codes.skipped : codes.failed,
  } as T;
}
