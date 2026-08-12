export type SafeTemporalErrorCode = 'BUDGET_EXCEEDED' | 'ACQUISITION_ACTIVITY_FAILED';

const BUDGET_MARKERS: ReadonlySet<string> = new Set([
  'BUDGET_EXCEEDED',
  'BudgetExceededError',
  'budget_exceeded',
]);
const MAX_CAUSE_DEPTH = 5;

function safeField(record: Record<string, unknown>, field: string): unknown {
  try {
    return record[field];
  } catch {
    return undefined;
  }
}

/**
 * Produce workflow-history-safe error evidence without observing message,
 * stack, arbitrary property values or general string coercion.
 */
export function safeTemporalErrorCode(
  error: unknown,
  fallback: SafeTemporalErrorCode,
): SafeTemporalErrorCode {
  let cursor = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) break;
    const record = cursor as Record<string, unknown>;
    for (const field of ['code', 'type', 'name'] as const) {
      const value = safeField(record, field);
      if (typeof value === 'string' && BUDGET_MARKERS.has(value)) return 'BUDGET_EXCEEDED';
    }
    cursor = safeField(record, 'cause');
  }
  return fallback;
}
