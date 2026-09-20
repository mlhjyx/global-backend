import { createHash } from 'node:crypto';
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { RequestContext } from '../auth/request-context';
import type { ExecutionBudgetPurpose } from './execution-budget-authority.types';
import {
  workspaceExecutionBudgetRequestScope,
  type WorkspaceExecutionBudgetRequest,
} from './execution-budget-request-scope';
import { MODEL_STRUCTURED_OUTPUT_WIRE_UPPER_BOUND } from '../model-gateway/model-execution-envelope';

export const WORKSPACE_TECHNICAL_BUDGET_QUOTE_SCHEMA =
  'execution-budget-technical-quote/v1' as const;

const QUOTE_TTL_MS = 5 * 60 * 1_000;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const MICROUSD_PER_CENT = 10_000n;
const REPRESENTATION_MINIMUM_MICROUSD = 1n;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface WorkspaceTechnicalBudgetModelPolicy {
  readonly taskId: string;
  readonly requestedAlias: string;
  readonly logicalInvocations: number;
  readonly structuredWireUpperBound: number;
  readonly maxCostCents: number;
  readonly maxOutputTokens: number;
}

export interface WorkspaceTechnicalBudgetToolPolicy {
  readonly toolId: string;
  readonly version: string;
  readonly maxPhysicalInvocations: number;
  readonly estimatedCents: number;
  readonly costUnit: string;
}

export interface WorkspaceTechnicalBudgetPolicy {
  readonly schemaVersion: 'workspace-execution-envelope/v1';
  readonly requestScopeVersion: 'workspace-execution-budget-request-scope/v1';
  readonly operation: WorkspaceExecutionBudgetRequest['operation'];
  readonly costBasis: 'backend_reservation_ceiling';
  readonly currency: 'USD';
  readonly unit: 'microusd';
  readonly microUsdPerCent: string;
  readonly representationMinimumMicrousd: string;
  readonly models: readonly WorkspaceTechnicalBudgetModelPolicy[];
  readonly tools: readonly WorkspaceTechnicalBudgetToolPolicy[];
  readonly executionLimits: Readonly<Record<string, number>>;
}

export interface WorkspaceTechnicalBudgetEnvelope {
  readonly requiredCapMicrousd: bigint;
  readonly policy: WorkspaceTechnicalBudgetPolicy;
}

export interface WorkspaceTechnicalBudgetQuote {
  readonly schemaVersion: typeof WORKSPACE_TECHNICAL_BUDGET_QUOTE_SCHEMA;
  readonly authorityKind: 'WORKSPACE_GRANT';
  readonly operation: WorkspaceExecutionBudgetRequest['operation'];
  readonly workspaceId: string;
  readonly purpose: ExecutionBudgetPurpose;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly requestSha256: string;
  readonly currency: 'USD';
  readonly unit: 'microusd';
  readonly requiredCapMicrousd: string;
  readonly policyRevision: string;
  readonly expiresAt: string;
}

export type WorkspaceTechnicalBudgetQuoteErrorCode =
  | 'EXECUTION_BUDGET_QUOTE_INVALID'
  | 'EXECUTION_BUDGET_QUOTE_UNAVAILABLE'
  | 'EXECUTION_BUDGET_POLICY_DRIFT';

export class WorkspaceTechnicalBudgetQuoteError extends HttpException {
  constructor(public readonly code: WorkspaceTechnicalBudgetQuoteErrorCode) {
    super(
      {
        error: {
          code,
          message:
            code === 'EXECUTION_BUDGET_QUOTE_INVALID'
              ? 'technical execution budget quote request is invalid'
              : 'technical execution budget quote is temporarily unavailable',
        },
      },
      code === 'EXECUTION_BUDGET_QUOTE_INVALID'
        ? HttpStatus.BAD_REQUEST
        : HttpStatus.SERVICE_UNAVAILABLE,
    );
    this.name = 'WorkspaceTechnicalBudgetQuoteError';
    this.message = code;
  }
}

interface QuoteDependencies {
  readonly now?: () => Date;
  readonly resolveEnvelope: (
    request: WorkspaceExecutionBudgetRequest,
  ) => WorkspaceTechnicalBudgetEnvelope;
}

function invalid(): never {
  throw new WorkspaceTechnicalBudgetQuoteError(
    'EXECUTION_BUDGET_QUOTE_INVALID',
  );
}

function unavailable(): never {
  throw new WorkspaceTechnicalBudgetQuoteError(
    'EXECUTION_BUDGET_QUOTE_UNAVAILABLE',
  );
}

function policyDrift(): never {
  throw new WorkspaceTechnicalBudgetQuoteError(
    'EXECUTION_BUDGET_POLICY_DRIFT',
  );
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) policyDrift();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value !== 'object') policyDrift();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) policyDrift();
  const record = value as Record<string, unknown>;
  if (Object.values(record).some((item) => item === undefined)) policyDrift();
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function policyRevision(policy: unknown): string {
  return createHash('sha256').update(canonicalJson(policy), 'utf8').digest('hex');
}

function expectedCapMicrousd(
  policy: WorkspaceTechnicalBudgetPolicy,
  operation: WorkspaceExecutionBudgetRequest['operation'],
): bigint {
  if (
    policy.schemaVersion !== 'workspace-execution-envelope/v1' ||
    policy.requestScopeVersion !== 'workspace-execution-budget-request-scope/v1' ||
    policy.operation !== operation ||
    policy.costBasis !== 'backend_reservation_ceiling' ||
    policy.currency !== 'USD' ||
    policy.unit !== 'microusd' ||
    policy.microUsdPerCent !== MICROUSD_PER_CENT.toString() ||
    policy.representationMinimumMicrousd !==
      REPRESENTATION_MINIMUM_MICROUSD.toString() ||
    !Array.isArray(policy.models) ||
    !Array.isArray(policy.tools) ||
    !policy.executionLimits ||
    typeof policy.executionLimits !== 'object' ||
    Array.isArray(policy.executionLimits)
  ) {
    return policyDrift();
  }
  const modelIds = new Set<string>();
  let cents = 0n;
  for (const item of policy.models) {
    if (
      typeof item.taskId !== 'string' ||
      item.taskId.length < 1 ||
      modelIds.has(item.taskId) ||
      typeof item.requestedAlias !== 'string' ||
      item.requestedAlias.length < 1 ||
      !Number.isSafeInteger(item.logicalInvocations) ||
      item.logicalInvocations < 1 ||
      item.structuredWireUpperBound !==
        MODEL_STRUCTURED_OUTPUT_WIRE_UPPER_BOUND ||
      !Number.isSafeInteger(item.maxCostCents) ||
      item.maxCostCents < 1 ||
      !Number.isSafeInteger(item.maxOutputTokens) ||
      item.maxOutputTokens < 1 ||
      item.maxOutputTokens > 16_000
    ) {
      return policyDrift();
    }
    modelIds.add(item.taskId);
    cents +=
      BigInt(item.logicalInvocations) *
      BigInt(item.structuredWireUpperBound) *
      BigInt(item.maxCostCents);
  }
  const toolIds = new Set<string>();
  for (const item of policy.tools) {
    if (
      typeof item.toolId !== 'string' ||
      item.toolId.length < 1 ||
      toolIds.has(item.toolId) ||
      typeof item.version !== 'string' ||
      item.version.length < 1 ||
      typeof item.costUnit !== 'string' ||
      item.costUnit.length < 1 ||
      !Number.isSafeInteger(item.maxPhysicalInvocations) ||
      item.maxPhysicalInvocations < 1 ||
      !Number.isSafeInteger(item.estimatedCents) ||
      item.estimatedCents < 0
    ) {
      return policyDrift();
    }
    toolIds.add(item.toolId);
    cents +=
      BigInt(item.maxPhysicalInvocations) * BigInt(item.estimatedCents);
  }
  if (
    Object.values(policy.executionLimits).some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    )
  ) {
    return policyDrift();
  }
  const calculated = cents * MICROUSD_PER_CENT;
  return calculated > 0n ? calculated : REPRESENTATION_MINIMUM_MICROUSD;
}

/**
 * Pure quote projection. It accepts no database, provider, workflow, storage,
 * billing or network dependency; the injected resolver is a synchronous
 * execution-envelope catalog assembled from product machine contracts.
 */
@Injectable()
export class WorkspaceTechnicalBudgetQuoteService {
  private readonly now: () => Date;

  constructor(private readonly dependencies: QuoteDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  quote(
    identity: RequestContext,
    request: WorkspaceExecutionBudgetRequest,
  ): WorkspaceTechnicalBudgetQuote {
    if (!UUID.test(identity.workspaceId)) invalid();

    const scope = workspaceExecutionBudgetRequestScope(request);
    let envelope: WorkspaceTechnicalBudgetEnvelope;
    try {
      envelope = this.dependencies.resolveEnvelope(request);
    } catch (error) {
      if (error instanceof WorkspaceTechnicalBudgetQuoteError) throw error;
      return unavailable();
    }
    if (
      typeof envelope?.requiredCapMicrousd !== 'bigint' ||
      envelope.requiredCapMicrousd < 1n ||
      envelope.requiredCapMicrousd > POSTGRES_BIGINT_MAX
    ) {
      return policyDrift();
    }
    if (
      expectedCapMicrousd(envelope.policy, request.operation) !==
      envelope.requiredCapMicrousd
    ) {
      return policyDrift();
    }

    const now = this.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) unavailable();

    return Object.freeze({
      schemaVersion: WORKSPACE_TECHNICAL_BUDGET_QUOTE_SCHEMA,
      authorityKind: 'WORKSPACE_GRANT',
      operation: request.operation,
      workspaceId: identity.workspaceId,
      purpose: scope.purpose,
      subjectType: scope.subjectType,
      subjectId: scope.subjectId,
      requestSha256: scope.requestSha256,
      currency: 'USD',
      unit: 'microusd',
      requiredCapMicrousd: envelope.requiredCapMicrousd.toString(),
      policyRevision: policyRevision(envelope.policy),
      expiresAt: new Date(now.getTime() + QUOTE_TTL_MS).toISOString(),
    });
  }
}
