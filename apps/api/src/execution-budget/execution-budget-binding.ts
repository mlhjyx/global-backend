import type { ExecutionBudgetPurpose } from './execution-budget-authority.types';

const BINDING_KEYS = [
  'accountKey',
  'authorityId',
  'purpose',
  'replay',
  'requestSha256',
  'scopeKey',
  'subjectId',
  'subjectType',
] as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const WORKSPACE_PURPOSES = new Set<ExecutionBudgetPurpose>([
  'icp.design',
  'icp.query_plan',
  'understanding.run',
  'discovery.run',
  'contact.verify',
]);

export interface ExecutionBudgetBinding {
  readonly authorityId: string;
  readonly replay: boolean;
  readonly scopeKey: string;
  readonly accountKey: string;
  readonly purpose: ExecutionBudgetPurpose;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly requestSha256: string;
}

export interface ExecutionBudgetBindingExpectation {
  readonly scopeKey?: string;
  readonly purpose?: ExecutionBudgetPurpose;
  readonly subjectType?: string;
}

export class ExecutionBudgetBindingError extends Error {
  readonly code = 'EXECUTION_BUDGET_BINDING_INVALID';

  constructor() {
    super('EXECUTION_BUDGET_BINDING_INVALID');
    this.name = 'ExecutionBudgetBindingError';
  }
}

function invalid(): never {
  throw new ExecutionBudgetBindingError();
}

function boundedText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    ![...value].some((character) => character.charCodeAt(0) < 32)
  );
}

/**
 * Reconstructs the exact workspace account identity carried by a verified
 * grant. This is deliberately pure so Relay, Temporal workflows and workers
 * can all reject a missing or reshaped binding before any model/tool wire.
 */
export function parseExecutionBudgetBinding(
  value: unknown,
  expected: ExecutionBudgetBindingExpectation = {},
): ExecutionBudgetBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join('\0') !== [...BINDING_KEYS].sort().join('\0') ||
    typeof record.authorityId !== 'string' ||
    !UUID_PATTERN.test(record.authorityId) ||
    typeof record.scopeKey !== 'string' ||
    !UUID_PATTERN.test(record.scopeKey) ||
    record.replay !== false ||
    typeof record.purpose !== 'string' ||
    !WORKSPACE_PURPOSES.has(record.purpose as ExecutionBudgetPurpose) ||
    !boundedText(record.subjectType, 80) ||
    !boundedText(record.subjectId, 200) ||
    typeof record.requestSha256 !== 'string' ||
    !SHA256_PATTERN.test(record.requestSha256) ||
    !boundedText(record.accountKey, 200)
  ) {
    invalid();
  }

  const purpose = record.purpose as ExecutionBudgetPurpose;
  const expectedAccountKey = [
    purpose,
    record.subjectType,
    record.subjectId,
    record.requestSha256,
  ].join(':');
  if (
    record.accountKey !== expectedAccountKey ||
    (expected.scopeKey !== undefined && record.scopeKey !== expected.scopeKey) ||
    (expected.purpose !== undefined && purpose !== expected.purpose) ||
    (expected.subjectType !== undefined && record.subjectType !== expected.subjectType)
  ) {
    invalid();
  }

  return Object.freeze({
    authorityId: record.authorityId,
    replay: false,
    scopeKey: record.scopeKey,
    accountKey: record.accountKey,
    purpose,
    subjectType: record.subjectType,
    subjectId: record.subjectId,
    requestSha256: record.requestSha256,
  });
}
