const MAX_CAUSE_DEPTH = 12;

function controlToken(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const token = value.toUpperCase();
  return (
    token.includes('EXECUTION_BUDGET_') ||
    token.includes('EXECUTIONBUDGET') ||
    token.includes('BUDGET_') ||
    (token.includes('BUDGET') && token.includes('ERROR')) ||
    token.includes('BUDGETOPERATIONREPLAY') ||
    token.includes('BUDGETSTORE') ||
    token.includes('BUDGETEXCEEDED') ||
    token.includes('PAIDOPERATIONUNKNOWN') ||
    token.includes('DOMAIN_ACK_') ||
    token.includes('DOMAINACK') ||
    token.includes('DURABLE_EXECUTION_RECEIPT_') ||
    token.includes('DURABLEEXECUTIONRECEIPT') ||
    token.includes('GENERIC_OPERATION_ARTIFACT_') ||
    token.includes('GENERICOPERATIONARTIFACT') ||
    token.includes('ARTIFACTSTORAGEERROR') ||
    token.includes('DURABLE_REPLAY_') ||
    token.includes('_REPLAY_')
  );
}

/**
 * Temporal preserves application failures under one or more ActivityFailure /
 * ApplicationFailure `cause` wrappers. Control-plane denials must therefore be
 * classified structurally instead of by the outer Error class alone.
 */
export function isExecutionControlError(error: unknown): boolean {
  const visited = new Set<object>();
  let current = error;
  let depth = 0;

  while (current && typeof current === 'object' && depth <= MAX_CAUSE_DEPTH) {
    if (visited.has(current)) return false;
    visited.add(current);
    const record = current as Record<string, unknown>;
    if ([record.code, record.type, record.name, record.message].some(controlToken)) {
      return true;
    }
    current = record.cause;
    depth += 1;
  }
  return false;
}
