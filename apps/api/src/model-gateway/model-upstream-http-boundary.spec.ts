import { ConflictException, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlobalHttpExceptionFilter } from '../common/http-exception.filter';
import { ExecutionBudgetGrantError } from '../execution-budget/execution-budget-authority.types';
import { ExecutionControlError } from '../execution-budget/execution-control-error';
import {
  ExternalActionDeniedError,
  ProviderHttpError,
  ProviderIdentityError,
  ProviderOutputError,
  ProviderOutputUnresolvedError,
  ProviderSettlementError,
  ProviderTransportError,
  ProviderWireInFlightError,
  TaskOutputValidationError,
} from './providers/provider-output-error';
import {
  MODEL_UPSTREAM_UNUSABLE,
  asModelUpstreamHttpBoundary,
  modelUpstreamUnusableHttpException,
  settledModelUpstreamFailureReason,
} from './model-upstream-http-boundary';

class DerivedTransportError extends ProviderTransportError {}

/** Model text that must never reach the HTTP body or the log. */
const MODEL_TEXT = 'Acme GmbH sells Kreiselpumpen';

afterEach(() => vi.restoreAllMocks());

describe('a model call the gateway settled without a usable answer', () => {
  it.each([
    [
      'a content-filtered chat completion (xin 2026-10-13, seller #24)',
      new ProviderOutputError('CHAT_COMPLETIONS_CONTENT_FILTERED'),
      'CHAT_COMPLETIONS_CONTENT_FILTERED',
    ],
    ['an output cut by the token limit', new ProviderOutputError('STRUCTURED_OUTPUT_TRUNCATED'), 'STRUCTURED_OUTPUT_TRUNCATED'],
    ['an empty output cut by the token limit', new ProviderOutputError('STRUCTURED_OUTPUT_EMPTY_TRUNCATED'), 'STRUCTURED_OUTPUT_EMPTY_TRUNCATED'],
    [
      'an answer that is not JSON, whose message describes it',
      new ProviderOutputError(`gateway m: structured output is not valid JSON: ${MODEL_TEXT}`, undefined, {
        reasonCode: 'STRUCTURED_OUTPUT_NOT_JSON',
      }),
      'STRUCTURED_OUTPUT_NOT_JSON',
    ],
    ['a schema miss after the closed repair', new ProviderOutputError('STRUCTURED_OUTPUT_SCHEMA_INVALID_AFTER_REPAIR: /name'), 'STRUCTURED_OUTPUT_SCHEMA_INVALID_AFTER_REPAIR'],
    ['a task-gate rejection', new TaskOutputValidationError('rejected'), 'TASK_OUTPUT_REJECTED'],
    ['an answer that cannot prove its model', new ProviderIdentityError('MODEL_IDENTITY_MISMATCH'), 'MODEL_IDENTITY_MISMATCH'],
    ['a cut stream', new ProviderTransportError('CHAT_COMPLETIONS_STREAM_TRUNCATED'), 'CHAT_COMPLETIONS_STREAM_TRUNCATED'],
    ['an upstream error event in the stream', new ProviderTransportError('CHAT_COMPLETIONS_STREAM_UPSTREAM_ERROR'), 'CHAT_COMPLETIONS_STREAM_UPSTREAM_ERROR'],
    ['an unreadable stream', new ProviderTransportError('CHAT_COMPLETIONS_STREAM_UNREADABLE'), 'CHAT_COMPLETIONS_STREAM_UNREADABLE'],
    ['a body that is not JSON', new ProviderTransportError('CHAT_COMPLETIONS_BODY_NOT_JSON'), 'CHAT_COMPLETIONS_BODY_NOT_JSON'],
    ['an invalid finish reason', new ProviderTransportError('CHAT_COMPLETIONS_FINISH_REASON_INVALID'), 'CHAT_COMPLETIONS_FINISH_REASON_INVALID'],
    ['a failed Responses status', new ProviderTransportError('RESPONSES_STATUS_INVALID'), 'RESPONSES_STATUS_INVALID'],
    [
      'a cut stream behind an ordinary cause',
      new ProviderTransportError('CHAT_COMPLETIONS_STREAM_TRUNCATED', undefined, { cause: new TypeError('terminated') }),
      'CHAT_COMPLETIONS_STREAM_TRUNCATED',
    ],
    [
      'a failed repair behind an unusable first answer',
      new ProviderOutputError('repair call failed', undefined, {
        reasonCode: 'STRUCTURED_OUTPUT_REPAIR_CALL_FAILED',
        cause: new ProviderOutputError('STRUCTURED_OUTPUT_NOT_JSON'),
      }),
      'STRUCTURED_OUTPUT_REPAIR_CALL_FAILED',
    ],
  ])('is recognised for %s', (_case, error, reason) => {
    expect(settledModelUpstreamFailureReason(error)).toBe(reason);
  });

  it.each([
    ['an upstream 503 the gateway relayed (xin 2026-10-13, seller #26)', 503, 'GATEWAY_HTTP_503'],
    ['a rate limit', 429, 'GATEWAY_HTTP_429'],
    ['a gateway 502 for a stream that failed before its first byte', 502, 'GATEWAY_HTTP_502'],
    ['an origin timeout behind the CDN', 524, 'GATEWAY_HTTP_524'],
  ])('is recognised for %s', (_case, status, reason) => {
    const error = new ProviderHttpError({ status, provider: 'gateway', model: 'deepseek-v4-pro' });
    expect(settledModelUpstreamFailureReason(error)).toBe(reason);
  });

  it.each([
    ['a status below 400', 302],
    ['a status above 599', 600],
    ['a fractional status', 503.5],
  ])('is not recognised for an HTTP error with %s', (_case, status) => {
    const error = new ProviderHttpError({ status, provider: 'gateway', model: 'deepseek-v4-pro' });
    expect(settledModelUpstreamFailureReason(error)).toBeUndefined();
  });

  it('is not recognised for a subclass of the HTTP error nobody registered', () => {
    class DerivedHttpError extends ProviderHttpError {}
    const error = new DerivedHttpError({ status: 503, provider: 'gateway', model: 'deepseek-v4-pro' });
    expect(settledModelUpstreamFailureReason(error)).toBeUndefined();
  });

  it.each([
    [
      'an unusable answer behind a control error',
      new ProviderOutputError('STRUCTURED_OUTPUT_NOT_JSON', undefined, {
        cause: new ExecutionControlError('EXECUTION_BUDGET_EXHAUSTED'),
      }),
    ],
    [
      'a cut stream behind a control error',
      new ProviderTransportError('CHAT_COMPLETIONS_STREAM_TRUNCATED', undefined, {
        cause: new ExecutionControlError('BUDGET_OPERATION_REPLAY_UNAVAILABLE'),
      }),
    ],
    ['a subclass nobody registered', new DerivedTransportError('CHAT_COMPLETIONS_STREAM_TRUNCATED')],
    ['an unresolved repair', new ProviderOutputUnresolvedError('STRUCTURED_OUTPUT_REPAIR_CALL_FAILED: unknown')],
    ['an unknown settlement', new ProviderSettlementError('MODEL_SETTLEMENT_UPSTREAM_ACK_UNKNOWN')],
    ['a compliance denial', new ExternalActionDeniedError()],
    ['a wire another worker owns', new ProviderWireInFlightError()],
    ['a grant error', new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_REUSED')],
    ['a control error', new ExecutionControlError('EXECUTION_BUDGET_EXHAUSTED')],
    ['a business conflict', new ConflictException({ error: { code: 'NO_RUNNABLE_QUERIES', message: 'x' } })],
    ['a plain error', new Error('socket hang up')],
    ['a string', 'CHAT_COMPLETIONS_CONTENT_FILTERED'],
    ['null', null],
  ])('is not recognised for %s', (_case, error) => {
    expect(settledModelUpstreamFailureReason(error)).toBeUndefined();
  });
});

describe('the 502 MODEL_UPSTREAM_UNUSABLE response', () => {
  it('carries the stable code, a fixed message and the reason code, and nothing else', () => {
    const exception = modelUpstreamUnusableHttpException('CHAT_COMPLETIONS_CONTENT_FILTERED');

    expect(exception).toBeInstanceOf(HttpException);
    expect(exception.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    expect(exception.getResponse()).toEqual({
      error: {
        code: MODEL_UPSTREAM_UNUSABLE,
        message: expect.stringMatching(/usable answer/),
        details: { reasonCode: 'CHAT_COMPLETIONS_CONTENT_FILTERED' },
      },
    });
    expect(Object.keys((exception.getResponse() as { error: object }).error)).toEqual([
      'code',
      'message',
      'details',
    ]);
  });

  it('tells the caller that the grant is consumed and a retry needs a new one', () => {
    const body = modelUpstreamUnusableHttpException('STRUCTURED_OUTPUT_TRUNCATED').getResponse() as {
      error: { message: string };
    };
    expect(body.error.message).toMatch(/grant/);
    expect(body.error.message).toMatch(/new/);
  });

  it('refuses a reason code that could carry free text', () => {
    expect(() => modelUpstreamUnusableHttpException(`not a code: ${MODEL_TEXT}`)).toThrow(
      'MODEL_UPSTREAM_REASON_CODE_INVALID',
    );
  });

  it('passes through the global filter unchanged', () => {
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ originalUrl: '/api/v1/icps/971c9242/query-plans' }),
      }),
    };

    new GlobalHttpExceptionFilter().catch(
      modelUpstreamUnusableHttpException('CHAT_COMPLETIONS_CONTENT_FILTERED'),
      host as never,
    );

    expect(response.status).toHaveBeenCalledWith(502);
    expect(response.json).toHaveBeenCalledWith({
      error: {
        code: 'MODEL_UPSTREAM_UNUSABLE',
        message: expect.any(String),
        details: { reasonCode: 'CHAT_COMPLETIONS_CONTENT_FILTERED' },
      },
    });
  });
});

describe('asModelUpstreamHttpBoundary', () => {
  it('returns what the operation returns', async () => {
    await expect(asModelUpstreamHttpBoundary(async () => ({ id: 'plan-1' }))).resolves.toEqual({
      id: 'plan-1',
    });
  });

  it('maps a settled unusable answer to 502 without the model text, and logs only the reason code', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const failure = new ProviderOutputError(
      `gateway m: structured output is not valid JSON: ${MODEL_TEXT}`,
      { inputTokens: 10, outputTokens: 20 },
      { reasonCode: 'STRUCTURED_OUTPUT_NOT_JSON' },
    );

    const rejection = await asModelUpstreamHttpBoundary(async () => {
      throw failure;
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(HttpException);
    const exception = rejection as HttpException;
    expect(exception.getStatus()).toBe(502);
    expect(JSON.stringify(exception.getResponse())).not.toContain(MODEL_TEXT);
    expect(exception.message).not.toContain(MODEL_TEXT);
    expect(exception.cause).toBeUndefined();
    expect(exception.getResponse()).toMatchObject({
      error: { code: 'MODEL_UPSTREAM_UNUSABLE', details: { reasonCode: 'STRUCTURED_OUTPUT_NOT_JSON' } },
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls[0])).toContain('STRUCTURED_OUTPUT_NOT_JSON');
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain(MODEL_TEXT);
  });

  it.each([
    ['a grant error, which the grant boundary maps', new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_REUSED')],
    ['a control error', new ExecutionControlError('EXECUTION_BUDGET_EXHAUSTED')],
    ['an unknown settlement', new ProviderSettlementError('MODEL_SETTLEMENT_UPSTREAM_ACK_UNKNOWN')],
    ['an unresolved repair', new ProviderOutputUnresolvedError('STRUCTURED_OUTPUT_REPAIR_CALL_FAILED: unknown')],
    ['a business conflict', new ConflictException({ error: { code: 'NO_RUNNABLE_QUERIES', message: 'x' } })],
    ['a plain error', new Error('socket hang up')],
  ])('rethrows %s untouched', async (_case, error) => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(
      asModelUpstreamHttpBoundary(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(warn).not.toHaveBeenCalled();
  });
});
