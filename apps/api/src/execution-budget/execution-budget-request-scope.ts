import { createHash } from 'node:crypto';
import type { WorkspaceExecutionBudgetScope } from './execution-budget-authority.service';

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type WorkspaceExecutionBudgetRequest =
  | Readonly<{
      operation: 'POST /companies';
      body: Readonly<{ website: string; name?: string }>;
    }>
  | Readonly<{
      operation: 'POST /companies/:companyId/icps';
      companyId: string;
    }>
  | Readonly<{
      operation: 'POST /icps/:icpId/query-plans';
      icpId: string;
    }>
  | Readonly<{
      operation: 'POST /query-plans/:planId/execute';
      planId: string;
    }>
  | Readonly<{
      operation: 'POST /canonical-companies/:id/discover-contacts';
      companyId: string;
    }>
  | Readonly<{
      operation: 'POST /canonical-companies/:id/guess-emails';
      companyId: string;
      body?: unknown;
    }>
  | Readonly<{
      operation: 'POST /contact-points/:pointId/verify';
      pointId: string;
      body?: unknown;
    }>;

export interface GuessEmailsHttpRequestBody {
  readonly lawfulBasis?: string;
  readonly lawfulBasisRef?: string;
  readonly lawfulBasisNote?: string;
  readonly allowPersonalWithoutBasis?: boolean;
  readonly maxContacts?: number;
  readonly maxProbe?: number;
}

export interface VerifyContactPointHttpRequestBody {
  readonly lawfulBasis?: string;
  readonly lawfulBasisRef?: string;
  readonly lawfulBasisNote?: string;
  readonly allowPersonalWithoutBasis?: boolean;
}

function invalidRequest(): never {
  throw new Error('EXECUTION_BUDGET_REQUEST_INVALID');
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidRequest();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value !== 'object') invalidRequest();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalidRequest();
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function requestMaterial(request: WorkspaceExecutionBudgetRequest): JsonValue {
  switch (request.operation) {
    case 'POST /companies':
      return { operation: request.operation, body: request.body } as JsonValue;
    case 'POST /companies/:companyId/icps':
      return { operation: request.operation, companyId: request.companyId };
    case 'POST /icps/:icpId/query-plans':
      return { operation: request.operation, icpId: request.icpId };
    case 'POST /query-plans/:planId/execute':
      return { operation: request.operation, planId: request.planId };
    case 'POST /canonical-companies/:id/discover-contacts':
      return { operation: request.operation, companyId: request.companyId };
    case 'POST /canonical-companies/:id/guess-emails':
      return {
        operation: request.operation,
        companyId: request.companyId,
        body: (request.body ?? null) as JsonValue,
      };
    case 'POST /contact-points/:pointId/verify':
      return {
        operation: request.operation,
        pointId: request.pointId,
        body: (request.body ?? null) as JsonValue,
      };
  }
}

export function workspaceExecutionBudgetRequestScope(
  request: WorkspaceExecutionBudgetRequest,
): Readonly<WorkspaceExecutionBudgetScope> {
  const requestSha256 = createHash('sha256')
    .update(canonicalJson(requestMaterial(request)), 'utf8')
    .digest('hex');

  switch (request.operation) {
    case 'POST /companies':
      return Object.freeze({
        purpose: 'understanding.run',
        subjectType: 'company',
        subjectId: `request:${requestSha256}`,
        requestSha256,
      });
    case 'POST /companies/:companyId/icps':
      return Object.freeze({
        purpose: 'icp.design',
        subjectType: 'company',
        subjectId: request.companyId,
        requestSha256,
      });
    case 'POST /icps/:icpId/query-plans':
      return Object.freeze({
        purpose: 'icp.query_plan',
        subjectType: 'icp',
        subjectId: request.icpId,
        requestSha256,
      });
    case 'POST /query-plans/:planId/execute':
      return Object.freeze({
        purpose: 'discovery.run',
        subjectType: 'discovery_run',
        subjectId: `request:${requestSha256}`,
        requestSha256,
      });
    case 'POST /canonical-companies/:id/discover-contacts':
    case 'POST /canonical-companies/:id/guess-emails':
      return Object.freeze({
        purpose: 'discovery.run',
        subjectType: 'company',
        subjectId: request.companyId,
        requestSha256,
      });
    case 'POST /contact-points/:pointId/verify':
      return Object.freeze({
        purpose: 'contact.verify',
        subjectType: 'contact_point',
        subjectId: request.pointId,
        requestSha256,
      });
  }
}

/** Canonical public DTO boundary used by both the HTTP adapter and grant issuer. */
export function guessEmailsExecutionBudgetRequestScope(
  companyId: string,
  body?: GuessEmailsHttpRequestBody,
): Readonly<WorkspaceExecutionBudgetScope> {
  return workspaceExecutionBudgetRequestScope({
    operation: 'POST /canonical-companies/:id/guess-emails',
    companyId,
    body: body
      ? {
          lawfulBasis: body.lawfulBasis,
          lawfulBasisRef: body.lawfulBasisRef,
          lawfulBasisNote: body.lawfulBasisNote,
          allowPersonalWithoutBasis: body.allowPersonalWithoutBasis,
          maxContacts: body.maxContacts,
          maxProbe: body.maxProbe,
        }
      : undefined,
  });
}

/** Canonical public DTO boundary used by both the HTTP adapter and grant issuer. */
export function verifyContactPointExecutionBudgetRequestScope(
  pointId: string,
  body?: VerifyContactPointHttpRequestBody,
): Readonly<WorkspaceExecutionBudgetScope> {
  return workspaceExecutionBudgetRequestScope({
    operation: 'POST /contact-points/:pointId/verify',
    pointId,
    body: body
      ? {
          lawfulBasis: body.lawfulBasis,
          lawfulBasisRef: body.lawfulBasisRef,
          lawfulBasisNote: body.lawfulBasisNote,
          allowPersonalWithoutBasis: body.allowPersonalWithoutBasis,
        }
      : undefined,
  });
}
