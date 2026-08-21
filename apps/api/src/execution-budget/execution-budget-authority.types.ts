export type ExecutionBudgetAuthorityKind =
  | 'WORKSPACE_GRANT'
  | 'PLATFORM_GRANT';

export type ExecutionBudgetPurpose =
  | 'icp.design'
  | 'icp.query_plan'
  | 'understanding.run'
  | 'discovery.run'
  | 'contact.verify'
  | 'platform.acquisition'
  | 'platform.intent_watch'
  | 'platform.sanctions';

export const EXECUTION_BUDGET_PLATFORM_PURPOSES = [
  'platform.acquisition',
  'platform.intent_watch',
  'platform.sanctions',
] as const satisfies readonly ExecutionBudgetPurpose[];

export interface VerifiedExecutionBudgetAuthority {
  readonly schemaVersion: 'execution-budget-grant/v1';
  readonly authorityKind: ExecutionBudgetAuthorityKind;
  readonly issuer: string;
  readonly audience: 'global-backend:execution-budget';
  readonly jti: string;
  readonly purpose: ExecutionBudgetPurpose;
  readonly workspaceId: string | null;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly requestSha256: string | null;
  readonly scheduleId: string | null;
  readonly currency: 'USD';
  readonly unit: 'microusd';
  readonly capMicrousd: bigint | null;
  readonly capPerRunMicrousd: bigint | null;
  readonly campaignCapMicrousd: bigint | null;
  readonly maxRuns: bigint | null;
  readonly tokenSha256: string;
  /** Immutable JWT NumericDate epoch seconds. */
  readonly issuedAt: number;
  /** Immutable JWT NumericDate epoch seconds. */
  readonly notBefore: number;
  /** Immutable JWT NumericDate epoch seconds. */
  readonly expiresAt: number;
}

export type ExecutionBudgetGrantErrorCode =
  | 'EXECUTION_BUDGET_GRANT_REQUIRED'
  | 'EXECUTION_BUDGET_GRANT_INVALID'
  | 'EXECUTION_BUDGET_GRANT_EXPIRED'
  | 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH'
  | 'EXECUTION_BUDGET_GRANT_REUSED'
  | 'EXECUTION_BUDGET_AUTHORITY_REVOKED'
  | 'EXECUTION_BUDGET_AUTHORITY_EXHAUSTED'
  | 'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE';

export class ExecutionBudgetGrantError extends Error {
  constructor(public readonly code: ExecutionBudgetGrantErrorCode) {
    super(code);
    this.name = 'ExecutionBudgetGrantError';
  }
}

export function executionBudgetGrantErrorHttpStatus(
  code: ExecutionBudgetGrantErrorCode,
): 402 | 403 | 409 | 503 {
  switch (code) {
    case 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH':
    case 'EXECUTION_BUDGET_AUTHORITY_REVOKED':
      return 403;
    case 'EXECUTION_BUDGET_GRANT_REUSED':
      return 409;
    case 'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE':
      return 503;
    case 'EXECUTION_BUDGET_GRANT_REQUIRED':
    case 'EXECUTION_BUDGET_GRANT_INVALID':
    case 'EXECUTION_BUDGET_GRANT_EXPIRED':
    case 'EXECUTION_BUDGET_AUTHORITY_EXHAUSTED':
      return 402;
  }
}

type AuthorityPurposeShape = Pick<
  VerifiedExecutionBudgetAuthority,
  | 'authorityKind'
  | 'purpose'
  | 'workspaceId'
  | 'requestSha256'
  | 'subjectType'
  | 'subjectId'
  | 'scheduleId'
  | 'capMicrousd'
  | 'capPerRunMicrousd'
  | 'campaignCapMicrousd'
  | 'maxRuns'
>;

const WORKSPACE_PURPOSE_SUBJECT_TYPES: Readonly<
  Record<string, readonly string[]>
> = {
  'understanding.run': ['company'],
  'icp.design': ['company'],
  'icp.query_plan': ['icp'],
  'discovery.run': ['discovery_run', 'company'],
  'contact.verify': ['contact_point'],
};

const PLATFORM_PURPOSES = new Set<ExecutionBudgetPurpose>(
  EXECUTION_BUDGET_PLATFORM_PURPOSES,
);

function isNonEmptyString(value: string | null): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveBigInt(value: bigint | null): value is bigint {
  return typeof value === 'bigint' && value > 0n;
}

function scopeMismatch(): never {
  throw new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH');
}

export function assertCanonicalMicrousd(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_INVALID');
  }

  const parsed = BigInt(value);
  if (parsed > 9_223_372_036_854_775_807n) {
    throw new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_INVALID');
  }

  return parsed;
}

export function assertAuthorityPurposeShape(
  authority: AuthorityPurposeShape,
): void {
  if (authority.authorityKind === 'WORKSPACE_GRANT') {
    const allowedSubjectTypes = WORKSPACE_PURPOSE_SUBJECT_TYPES[authority.purpose];
    if (
      !allowedSubjectTypes ||
      !isNonEmptyString(authority.workspaceId) ||
      !isNonEmptyString(authority.requestSha256) ||
      !isNonEmptyString(authority.subjectId) ||
      !allowedSubjectTypes.includes(authority.subjectType) ||
      authority.scheduleId !== null ||
      !isPositiveBigInt(authority.capMicrousd) ||
      authority.capPerRunMicrousd !== null ||
      authority.campaignCapMicrousd !== null ||
      authority.maxRuns !== null
    ) {
      scopeMismatch();
    }
    return;
  }

  if (
    authority.authorityKind !== 'PLATFORM_GRANT' ||
    !PLATFORM_PURPOSES.has(authority.purpose) ||
    authority.workspaceId !== null ||
    authority.requestSha256 !== null ||
    authority.subjectType !== 'schedule' ||
    !isNonEmptyString(authority.subjectId) ||
    !isNonEmptyString(authority.scheduleId) ||
    authority.subjectId !== authority.scheduleId ||
    authority.capMicrousd !== null ||
    !isPositiveBigInt(authority.capPerRunMicrousd) ||
    !isPositiveBigInt(authority.campaignCapMicrousd) ||
    !isPositiveBigInt(authority.maxRuns)
  ) {
    scopeMismatch();
  }
}
