const MAX_CAUSE_DEPTH = 12;
const MAX_CONTROL_TOKEN_LENGTH = 256;
const SAFE_FAILURE_KEYS = Object.freeze([
  'cause',
  'code',
  'message',
  'name',
  'stack',
  'type',
]);

function controlToken(value: unknown): boolean {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_CONTROL_TOKEN_LENGTH
  ) {
    return false;
  }
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

type SafeFailureSnapshot = Readonly<{
  code?: unknown;
  type?: unknown;
  name?: unknown;
  cause?: unknown;
}>;

function safeFailurePrototypeChain(value: object): boolean {
  const visited = new Set<object>();
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
  } catch {
    return false;
  }
  for (let depth = 0; prototype && depth <= 8; depth += 1) {
    if (visited.has(prototype)) return false;
    visited.add(prototype);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(prototype);
      for (const key of ['cause', 'code', 'type'] as const) {
        if (descriptors[key]) return false;
      }
      for (const key of ['message', 'name', 'stack'] as const) {
        const descriptor = descriptors[key];
        if (descriptor && !('value' in descriptor)) return false;
      }
      prototype = Object.getPrototypeOf(prototype) as object | null;
    } catch {
      return false;
    }
  }
  return prototype === null;
}

function safeFailureSnapshot(value: object): SafeFailureSnapshot | null {
  try {
    if (!safeFailurePrototypeChain(value)) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some(
        (key) =>
          typeof key !== 'string' || !SAFE_FAILURE_KEYS.includes(key),
      ) ||
      Object.entries(descriptors).some(
        ([key, descriptor]) =>
          !('value' in descriptor) &&
          !(
            // V8 exposes a lazy own `stack` accessor on ordinary Error values.
            // It is ignored, never invoked or copied, and is admitted only
            // beside an own data `message`; all classified fields remain data.
            key === 'stack' &&
            descriptors.message &&
            'value' in descriptors.message
          ),
      )
    ) {
      return null;
    }
    const tokenValues = ['code', 'type', 'name'] as const;
    for (const key of tokenValues) {
      const descriptor = descriptors[key];
      if (
        descriptor &&
        descriptor.value !== undefined &&
        (typeof descriptor.value !== 'string' ||
          descriptor.value.length > MAX_CONTROL_TOKEN_LENGTH)
      ) {
        return null;
      }
    }
    return Object.freeze({
      code: descriptors.code?.value,
      type: descriptors.type?.value,
      name: descriptors.name?.value,
      cause: descriptors.cause?.value,
    });
  } catch {
    return null;
  }
}

/**
 * Temporal preserves application failures under one or more ActivityFailure /
 * ApplicationFailure `cause` wrappers. Control-plane denials must therefore be
 * classified structurally instead of by the outer Error class alone.
 */
export function isExecutionControlError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return true;
  const visited = new Set<object>();
  let current = error;

  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (!current || typeof current !== 'object') return true;
    if (visited.has(current)) return true;
    visited.add(current);
    const snapshot = safeFailureSnapshot(current);
    if (!snapshot) return true;
    if ([snapshot.code, snapshot.type, snapshot.name].some(controlToken)) {
      return true;
    }
    if (snapshot.cause === null || snapshot.cause === undefined) return false;
    if (typeof snapshot.cause !== 'object') return true;
    current = snapshot.cause;
  }
  return true;
}
