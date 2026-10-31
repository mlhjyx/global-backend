import { describe, expect, it } from 'vitest';
import { ExecutionControlError } from '../execution-budget/execution-control-error';
import {
  ProviderOutputError,
  ProviderOutputUnresolvedError,
  ProviderSettlementError,
  ProviderTransportError,
  TaskOutputValidationError,
} from '../model-gateway/providers/provider-output-error';
import { settledModelFailureReason } from './settled-model-failure';

class DerivedTransportError extends ProviderTransportError {}

describe('a discovery model call the gateway settled without a result', () => {
  it.each([
    ['an unusable answer', new ProviderOutputError('STRUCTURED_OUTPUT_EMPTY_TRUNCATED: empty'), 'STRUCTURED_OUTPUT_EMPTY_TRUNCATED'],
    ['a rejected task output', new TaskOutputValidationError('rejected'), 'TASK_OUTPUT_REJECTED'],
    ['a cut chat-completions stream', new ProviderTransportError('CHAT_COMPLETIONS_STREAM_TRUNCATED'), 'CHAT_COMPLETIONS_STREAM_TRUNCATED'],
    [
      'a cut stream behind a non-control cause',
      new ProviderTransportError('CHAT_COMPLETIONS_STREAM_TRUNCATED', undefined, { cause: new TypeError('terminated') }),
      'CHAT_COMPLETIONS_STREAM_TRUNCATED',
    ],
  ])('is recognised for %s', (_case, error, reason) => {
    expect(settledModelFailureReason(error)).toBe(reason);
  });

  it.each([
    ['a timeout or unreadable body', new ProviderTransportError('CHAT_COMPLETIONS_STREAM_UNREADABLE')],
    ['a body that is not JSON', new ProviderTransportError('CHAT_COMPLETIONS_BODY_NOT_JSON')],
    ['an invalid finish reason such as insufficient_system_resource', new ProviderTransportError('CHAT_COMPLETIONS_FINISH_REASON_INVALID')],
    ['a failed Responses status', new ProviderTransportError('RESPONSES_STATUS_INVALID')],
    ['a subclass of the transport error', new DerivedTransportError('CHAT_COMPLETIONS_STREAM_TRUNCATED')],
    [
      'a cut stream behind a control error',
      new ProviderTransportError('CHAT_COMPLETIONS_STREAM_TRUNCATED', undefined, {
        cause: new ExecutionControlError('EXECUTION_BUDGET_EXHAUSTED'),
      }),
    ],
    ['an unresolved repair', new ProviderOutputUnresolvedError('STRUCTURED_OUTPUT_REPAIR_CALL_FAILED: unknown')],
    ['an unknown settlement', new ProviderSettlementError('MODEL_SETTLEMENT_UPSTREAM_ACK_UNKNOWN')],
    ['a plain error', new Error('socket hang up')],
    ['a control error', new ExecutionControlError('EXECUTION_BUDGET_EXHAUSTED')],
    ['a non-error value', 'CHAT_COMPLETIONS_STREAM_TRUNCATED'],
  ])('is not recognised for %s, which keeps failing closed', (_case, error) => {
    expect(settledModelFailureReason(error)).toBeUndefined();
  });
});
