import {
  HttpException,
  HttpStatus,
  applyDecorators,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import { ApiHeader, ApiResponse } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { EnrichmentSafetyError } from '../enrichment/safety/enrichment-safety.contract';
import {
  ExecutionBudgetGrantError,
  executionBudgetGrantErrorHttpStatus,
} from './execution-budget-authority.types';
import { ExecutionControlError } from './execution-control-error';

export const EXECUTION_BUDGET_GRANT_HEADER = 'X-Execution-Budget-Grant';

const AUTHORITY_ERROR_SCHEMA: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
    },
  },
};

/** Extracts the compact grant exactly once. The value is never logged or persisted. */
export const ExecutionBudgetGrant = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined => {
    const request = context.switchToHttp().getRequest<{
      headers?: Record<string, unknown>;
    }>();
    const value = request.headers?.[EXECUTION_BUDGET_GRANT_HEADER.toLowerCase()];
    return typeof value === 'string' ? value : undefined;
  },
);

export function ApiExecutionBudgetGrant(options?: {
  additionalForbiddenCodes?: readonly string[];
  /** Operation-specific 409 codes, listed in the response description; the schema stays open. */
  additionalConflictCodes?: readonly string[];
}): MethodDecorator {
  const additionalForbiddenCodes = options?.additionalForbiddenCodes ?? [];
  const conflictCodes = [
    'EXECUTION_BUDGET_GRANT_REUSED',
    ...(options?.additionalConflictCodes ?? []),
  ];
  const forbiddenCodes = [
    'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH',
    'EXECUTION_BUDGET_AUTHORITY_REVOKED',
    ...additionalForbiddenCodes,
  ];
  const forbiddenSchema: SchemaObject =
    additionalForbiddenCodes.length === 0
      ? AUTHORITY_ERROR_SCHEMA
      : {
          ...AUTHORITY_ERROR_SCHEMA,
          properties: {
            error: {
              type: 'object',
              additionalProperties: false,
              required: ['code', 'message'],
              properties: {
                code: { type: 'string', enum: forbiddenCodes },
                message: { type: 'string' },
              },
            },
          },
        };
  return applyDecorators(
    ApiHeader({
      name: EXECUTION_BUDGET_GRANT_HEADER,
      required: true,
      schema: { type: 'string', minLength: 1, maxLength: 16_384 },
      description: 'SaaS signed authority bound to this exact workspace mutation',
    }),
    ApiResponse({
      status: 402,
      description:
        'EXECUTION_BUDGET_GRANT_REQUIRED, EXECUTION_BUDGET_GRANT_INVALID, EXECUTION_BUDGET_GRANT_EXPIRED or EXECUTION_BUDGET_AUTHORITY_EXHAUSTED',
      schema: AUTHORITY_ERROR_SCHEMA,
    }),
    ApiResponse({
      status: 403,
      description:
        additionalForbiddenCodes.length === 0
          ? 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH or EXECUTION_BUDGET_AUTHORITY_REVOKED'
          : forbiddenCodes.join(' or '),
      schema: forbiddenSchema,
    }),
    ApiResponse({
      status: 409,
      description:
        conflictCodes.length === 1
          ? conflictCodes[0]
          : `${conflictCodes.slice(0, -1).join(', ')} or ${conflictCodes.at(-1)}`,
      schema: AUTHORITY_ERROR_SCHEMA,
    }),
    ApiResponse({
      status: 503,
      description: 'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE',
      schema: AUTHORITY_ERROR_SCHEMA,
    }),
  );
}

export function executionBudgetGrantHttpException(
  error: ExecutionBudgetGrantError,
): HttpException {
  return new HttpException(
    { error: { code: error.code, message: error.code } },
    executionBudgetGrantErrorHttpStatus(error.code),
  );
}

function enrichmentSafetyHttpStatus(code: EnrichmentSafetyError['code']): number {
  switch (code) {
    case 'INVALID_PLAN':
      return HttpStatus.BAD_REQUEST;
    case 'BUDGET_CAP_EXCEEDED':
      return HttpStatus.PAYMENT_REQUIRED;
    case 'GOVERNANCE_PENDING':
      return HttpStatus.SERVICE_UNAVAILABLE;
    case 'HOLD':
    case 'INPUT_CONFLICT':
    case 'REDACTED':
    case 'CONTROL_MISMATCH':
    default:
      return HttpStatus.CONFLICT;
  }
}

function executionControlHttpStatus(code: string): number {
  const upper = code.toUpperCase();
  if (upper.includes('EXCEEDED') || upper.includes('EXHAUSTED')) {
    return HttpStatus.PAYMENT_REQUIRED;
  }
  if (upper.includes('MISMATCH') || upper.includes('CONFLICT') || upper.includes('REUSED')) {
    return HttpStatus.CONFLICT;
  }
  return HttpStatus.SERVICE_UNAVAILABLE;
}

function findExecutionControlError(error: unknown): ExecutionControlError | null {
  if (error instanceof HttpException) return null;
  let current: unknown = error;
  try {
    const seen = new Set<object>();
    for (let depth = 0; depth < 8 && current && typeof current === 'object' && !seen.has(current); depth += 1) {
      if (current instanceof ExecutionControlError) return current;
      seen.add(current);
      const cause = Object.getOwnPropertyDescriptor(current, 'cause');
      current = cause && Object.hasOwn(cause, 'value') ? cause.value : undefined;
    }
  } catch {
    return null;
  }
  return null;
}

export async function asExecutionBudgetHttpBoundary<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HttpException) {
      throw error;
    }
    if (error instanceof ExecutionBudgetGrantError) {
      throw executionBudgetGrantHttpException(error);
    }
    throw error;
  }
}

export async function asContactEnrichmentHttpBoundary<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await asExecutionBudgetHttpBoundary(operation);
  } catch (error) {
    if (error instanceof EnrichmentSafetyError) {
      throw new HttpException(
        { error: { code: `ENRICHMENT_${error.code}`, message: `ENRICHMENT_${error.code}` } },
        enrichmentSafetyHttpStatus(error.code),
      );
    }
    const controlError = findExecutionControlError(error);
    if (controlError) {
      throw new HttpException(
        { error: { code: controlError.code, message: controlError.code } },
        executionControlHttpStatus(controlError.code),
      );
    }
    throw error;
  }
}
