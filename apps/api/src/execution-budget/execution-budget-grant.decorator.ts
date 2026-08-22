import {
  HttpException,
  applyDecorators,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import { ApiHeader, ApiResponse } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import {
  ExecutionBudgetGrantError,
  executionBudgetGrantErrorHttpStatus,
} from './execution-budget-authority.types';

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

export function ApiExecutionBudgetGrant(): MethodDecorator {
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
        'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH or EXECUTION_BUDGET_AUTHORITY_REVOKED',
      schema: AUTHORITY_ERROR_SCHEMA,
    }),
    ApiResponse({
      status: 409,
      description: 'EXECUTION_BUDGET_GRANT_REUSED',
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

export async function asExecutionBudgetHttpBoundary<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ExecutionBudgetGrantError) {
      throw executionBudgetGrantHttpException(error);
    }
    throw error;
  }
}
