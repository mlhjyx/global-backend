const MAX_CAUSE_DEPTH = 12;
const MAX_CONTROL_TOKEN_LENGTH = 256;
const PLAIN_FAILURE_KEYS = Object.freeze([
  'cause',
  'code',
  'message',
  'name',
  'stack',
  'type',
]);
const TEMPORAL_ACTIVITY_FAILURE_KEYS = Object.freeze([
  'activityId',
  'activityType',
  'cause',
  'failure',
  'identity',
  'message',
  'retryState',
  'stack',
]);
const TEMPORAL_APPLICATION_FAILURE_KEYS = Object.freeze([
  'category',
  'cause',
  'details',
  'failure',
  'message',
  'nextRetryDelay',
  'nonRetryable',
  'stack',
  'type',
]);
const LEGACY_TEMPORAL_APPLICATION_FAILURE_COMPATIBILITY = Object.freeze({
  sdkBoundary: '@temporalio/workflow@1.20.x',
  genericTypes: Object.freeze(['', 'Error']),
});

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
    token === 'EXECUTIONCONTROLERROR' ||
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

export class ExecutionControlError extends Error {
  readonly code: string;
  readonly type = 'ExecutionControlError';

  constructor(code: string) {
    if (
      !/^[A-Z][A-Z0-9_]{2,127}$/u.test(code) ||
      !controlToken(code)
    ) {
      throw new TypeError('EXECUTION_CONTROL_ERROR_CODE_INVALID');
    }
    super(code);
    this.name = 'ExecutionControlError';
    this.code = code;
  }
}

type SafeFailureSnapshot = Readonly<{
  family: SafeFailureFamily;
  code?: unknown;
  type?: unknown;
  name?: unknown;
  message?: unknown;
  cause?: unknown;
}>;
type SafeFailureFamily = 'PLAIN' | 'TEMPORAL_ACTIVITY' | 'TEMPORAL_APPLICATION';

function exactKeys(
  keys: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    keys.length === expected.length &&
    expected.every((key) => keys.includes(key))
  );
}

function safeFailureFamily(keys: readonly string[]): SafeFailureFamily | null {
  if (exactKeys(keys, TEMPORAL_ACTIVITY_FAILURE_KEYS)) {
    return 'TEMPORAL_ACTIVITY';
  }
  if (exactKeys(keys, TEMPORAL_APPLICATION_FAILURE_KEYS)) {
    return 'TEMPORAL_APPLICATION';
  }
  return keys.every((key) => PLAIN_FAILURE_KEYS.includes(key))
    ? 'PLAIN'
    : null;
}

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
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key !== 'string')) return null;
    const keys = ownKeys as string[];
    const family = safeFailureFamily(keys);
    if (
      !family ||
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
    const tokenValues =
      family === 'PLAIN'
        ? (['code', 'type', 'name'] as const)
        : family === 'TEMPORAL_APPLICATION'
          ? (['type'] as const)
          : ([] as const);
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
      family,
      code: descriptors.code?.value,
      type: descriptors.type?.value,
      name: descriptors.name?.value,
      message: descriptors.message?.value,
      cause: descriptors.cause?.value,
    });
  } catch {
    return null;
  }
}

function isLegacyTemporalApplicationControl(
  snapshot: SafeFailureSnapshot,
): boolean {
  if (
    snapshot.family !== 'TEMPORAL_APPLICATION' ||
    typeof snapshot.type !== 'string' ||
    !LEGACY_TEMPORAL_APPLICATION_FAILURE_COMPATIBILITY.genericTypes.includes(
      snapshot.type,
    ) ||
    typeof snapshot.message !== 'string' ||
    !/^[A-Z][A-Z0-9_]{2,127}$/u.test(snapshot.message)
  ) {
    return false;
  }
  return controlToken(snapshot.message);
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
    if (
      [snapshot.code, snapshot.type, snapshot.name].some(controlToken) ||
      isLegacyTemporalApplicationControl(snapshot)
    ) {
      return true;
    }
    if (snapshot.cause === null || snapshot.cause === undefined) return false;
    if (typeof snapshot.cause !== 'object') return true;
    current = snapshot.cause;
  }
  return true;
}
