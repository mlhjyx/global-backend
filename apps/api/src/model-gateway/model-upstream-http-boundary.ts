import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { isExecutionControlError } from '../execution-budget/execution-control-error';
import {
  ProviderIdentityError,
  ProviderOutputError,
  ProviderTransportError,
  isRecoverableModelFailure,
} from './providers/provider-output-error';

/**
 * Stable code of a synchronous generation endpoint whose model call the
 * gateway settled without a usable answer. The answer may be filtered,
 * truncated, not JSON, off-schema, unattributable or cut in transport; the
 * gateway reason code in `details.reasonCode` tells which. The grant that
 * paid for the call is consumed and charged, so a retry needs a new grant.
 */
export const MODEL_UPSTREAM_UNUSABLE = 'MODEL_UPSTREAM_UNUSABLE';

const MODEL_UPSTREAM_UNUSABLE_MESSAGE =
  'the model gateway settled this call without a usable answer; the execution budget grant is consumed, so a retry needs a new grant';

const REASON_CODE = /^[A-Z][A-Z0-9_]{2,63}$/u;

/**
 * Unregistered ProviderOutputError subclasses the gateway still settles with
 * the real usage before rethrowing: the answer cannot prove its model, or the
 * transport failed before a complete answer arrived. Unresolved repairs,
 * unknown settlements, compliance denials and in-flight wires are not
 * settled failures of this call and keep failing closed.
 */
const SETTLED_UNREGISTERED_PROTOTYPES: ReadonlySet<object> = new Set<object>([
  ProviderIdentityError.prototype,
  ProviderTransportError.prototype,
]);

/**
 * The gateway reason code of a model call settled without a usable answer, or
 * undefined when the error does not prove that. Recognised: a recoverable
 * ProviderOutputError (bad JSON, schema miss, task-gate rejection) and an exact
 * identity or transport error with no control error behind it. Everything
 * else, control errors above all, is left to its own boundary.
 */
export function settledModelUpstreamFailureReason(error: unknown): string | undefined {
  if (isRecoverableModelFailure(error)) return error.reasonCode;
  if (
    error instanceof ProviderOutputError &&
    SETTLED_UNREGISTERED_PROTOTYPES.has(Object.getPrototypeOf(error) as object) &&
    (error.cause === undefined || !isExecutionControlError(error.cause))
  ) {
    return error.reasonCode;
  }
  return undefined;
}

/** 502 with the stable code and the reason code; it never carries model text. */
export function modelUpstreamUnusableHttpException(reasonCode: string): HttpException {
  if (!REASON_CODE.test(reasonCode)) {
    throw new TypeError('MODEL_UPSTREAM_REASON_CODE_INVALID');
  }
  return new HttpException(
    {
      error: {
        code: MODEL_UPSTREAM_UNUSABLE,
        message: MODEL_UPSTREAM_UNUSABLE_MESSAGE,
        details: { reasonCode },
      },
    },
    HttpStatus.BAD_GATEWAY,
  );
}

const logger = new Logger('ModelUpstream');

/**
 * Runs a synchronous generation and maps a settled unusable model answer to
 * 502 MODEL_UPSTREAM_UNUSABLE. Grant, control and business errors pass
 * through untouched for their own boundaries. Only the reason code is logged;
 * the provider message may describe the model's answer.
 */
export async function asModelUpstreamHttpBoundary<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const reasonCode = settledModelUpstreamFailureReason(error);
    if (reasonCode === undefined) throw error;
    logger.warn({ code: MODEL_UPSTREAM_UNUSABLE, reasonCode });
    throw modelUpstreamUnusableHttpException(reasonCode);
  }
}

const MODEL_UPSTREAM_UNUSABLE_SCHEMA: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message', 'details'],
      properties: {
        code: { type: 'string', enum: [MODEL_UPSTREAM_UNUSABLE] },
        message: { type: 'string' },
        details: {
          type: 'object',
          additionalProperties: false,
          required: ['reasonCode'],
          properties: {
            reasonCode: {
              type: 'string',
              pattern: REASON_CODE.source,
              description:
                '模型网关的原因码，例如 CHAT_COMPLETIONS_CONTENT_FILTERED、STRUCTURED_OUTPUT_TRUNCATED、CHAT_COMPLETIONS_STREAM_TRUNCATED；不含模型文本',
            },
          },
        },
      },
    },
  },
};

/** Declares the 502 of a synchronous generation endpoint in the code-first OpenAPI. */
export function ApiModelUpstreamUnusable(): MethodDecorator {
  return ApiResponse({
    status: HttpStatus.BAD_GATEWAY,
    description:
      'MODEL_UPSTREAM_UNUSABLE：模型网关已结算这次调用，但没有可用的答案（details.reasonCode 为网关原因码）。预算授权已消耗，重试需要新的授权',
    schema: MODEL_UPSTREAM_UNUSABLE_SCHEMA,
  });
}
