export const ICP_REJUDGE_MAX_COMPANIES_DEFAULT = 100;
export const ICP_REJUDGE_MAX_COMPANIES_LIMIT = 100;
export const ICP_REJUDGE_BATCH_SIZE_DEFAULT = 25;
export const ICP_REJUDGE_BATCH_SIZE_LIMIT = 25;

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex -- public boundary rejects ASCII control characters.
const NO_CONTROL_CHARS = /^[^\u0000-\u001f\u007f]+$/u;
const ALLOWED_KEYS = new Set([
  'attemptId',
  'maxCompanies',
  'batchSize',
  'refreshCorroboration',
  'refreshWebsiteProfile',
  'includeFresh',
  'companyIds',
]);

export interface IcpRejudgeHttpRequestBody {
  readonly attemptId: string;
  readonly maxCompanies?: number;
  readonly batchSize?: number;
  readonly refreshCorroboration?: boolean;
  readonly refreshWebsiteProfile?: boolean;
  readonly includeFresh?: boolean;
  readonly companyIds?: readonly string[];
}

export interface NormalizedIcpRejudgeBudgetBody {
  readonly attemptId: string;
  readonly maxCompanies: number;
  readonly batchSize: number;
  readonly refreshCorroboration: boolean;
  readonly refreshWebsiteProfile: boolean;
  readonly includeFresh: boolean;
  readonly companyIds?: readonly string[];
  readonly effectiveCompanies: number;
}

function boundedInt(
  value: unknown,
  fallback: number,
  maximum: number,
  onInvalid: () => never,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    onInvalid();
  }
  return value as number;
}

function optionalBool(
  value: unknown,
  fallback: boolean,
  onInvalid: () => never,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') onInvalid();
  return value;
}

function normalizeCompanyIds(
  value: unknown,
  onInvalid: () => never,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > ICP_REJUDGE_MAX_COMPANIES_LIMIT
  ) {
    onInvalid();
  }
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !UUID_V4.test(item)) onInvalid();
    normalized.push(item.toLowerCase());
  }
  return Object.freeze([...new Set(normalized)].sort());
}

/**
 * Shared fail-closed parser & normalizer for POST /icps/:icpId/rejudge used by
 * request scope hashing, technical budget quoting, quote controller, and HTTP service.
 * Never silently clamps out-of-range inputs.
 */
export function normalizeIcpRejudgeBudgetBody(
  raw: unknown,
  onInvalid: () => never,
): NormalizedIcpRejudgeBudgetBody {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) onInvalid();
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) onInvalid();
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some((key) => !ALLOWED_KEYS.has(key))) onInvalid();

  const attemptId = input.attemptId;
  if (
    typeof attemptId !== 'string' ||
    attemptId.length < 1 ||
    attemptId.length > 128 ||
    attemptId.trim().length < 1 ||
    !NO_CONTROL_CHARS.test(attemptId)
  ) {
    onInvalid();
  }

  const maxCompanies = boundedInt(
    input.maxCompanies,
    ICP_REJUDGE_MAX_COMPANIES_DEFAULT,
    ICP_REJUDGE_MAX_COMPANIES_LIMIT,
    onInvalid,
  );
  const batchSize = boundedInt(
    input.batchSize,
    ICP_REJUDGE_BATCH_SIZE_DEFAULT,
    ICP_REJUDGE_BATCH_SIZE_LIMIT,
    onInvalid,
  );
  const refreshCorroboration = optionalBool(input.refreshCorroboration, true, onInvalid);
  const refreshWebsiteProfile = optionalBool(input.refreshWebsiteProfile, false, onInvalid);
  const includeFresh = optionalBool(input.includeFresh, false, onInvalid);
  const companyIds = normalizeCompanyIds(input.companyIds, onInvalid);
  if (includeFresh && !companyIds) onInvalid();

  const effectiveCompanies = companyIds
    ? Math.min(companyIds.length, maxCompanies)
    : maxCompanies;

  return Object.freeze({
    attemptId,
    maxCompanies,
    batchSize,
    refreshCorroboration,
    refreshWebsiteProfile,
    includeFresh,
    ...(companyIds ? { companyIds } : {}),
    effectiveCompanies,
  });
}

export function canonicalIcpRejudgeRequestMaterialBody(
  normalized: NormalizedIcpRejudgeBudgetBody,
): IcpRejudgeHttpRequestBody {
  return Object.freeze({
    attemptId: normalized.attemptId,
    maxCompanies: normalized.maxCompanies,
    batchSize: normalized.batchSize,
    refreshCorroboration: normalized.refreshCorroboration,
    refreshWebsiteProfile: normalized.refreshWebsiteProfile,
    includeFresh: normalized.includeFresh,
    ...(normalized.companyIds ? { companyIds: normalized.companyIds } : {}),
  });
}

export const ICP_REJUDGE_QUOTE_BODY_OPENAPI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['attemptId'],
  properties: {
    attemptId: { type: 'string', minLength: 1, maxLength: 128 },
    maxCompanies: {
      type: 'integer',
      minimum: 1,
      maximum: ICP_REJUDGE_MAX_COMPANIES_LIMIT,
    },
    batchSize: {
      type: 'integer',
      minimum: 1,
      maximum: ICP_REJUDGE_BATCH_SIZE_LIMIT,
    },
    refreshCorroboration: { type: 'boolean' },
    refreshWebsiteProfile: { type: 'boolean' },
    includeFresh: { type: 'boolean' },
    companyIds: {
      type: 'array',
      minItems: 1,
      maxItems: ICP_REJUDGE_MAX_COMPANIES_LIMIT,
      items: { type: 'string', format: 'uuid' },
    },
  },
} as const;
