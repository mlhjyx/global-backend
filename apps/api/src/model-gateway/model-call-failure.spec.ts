import { describe, expect, it } from 'vitest';
import { ExecutionControlError } from '../execution-budget/execution-control-error';
import { BudgetOperationReplayError } from '../tools/budget-store';
import {
  isControlStopAfterModelCall,
  isModelCallItemFailure,
} from './model-call-failure';
import {
  ExternalActionDeniedError,
  ProviderHttpError,
  ProviderIdentityError,
  ProviderOutputError,
  ProviderSettlementError,
  ProviderWireInFlightError,
  TaskOutputValidationError,
} from './providers/provider-output-error';

const provenance = { provider: 'gateway', model: 'deepseek-v4-pro' };

describe('model call failures inside multi-item pipelines', () => {
  it.each([
    ['an unusable structured output', () => new ProviderOutputError('STRUCTURED_OUTPUT_TRUNCATED', undefined, provenance)],
    ['an untrusted model identity', () => new ProviderIdentityError('MODEL_IDENTITY_MISMATCH', undefined, provenance)],
    ['a task output hard gate', () => new TaskOutputValidationError('task output hard gate rejected', undefined, provenance)],
    ['a gateway HTTP status', () => new ProviderHttpError({ status: 524, ...provenance })],
    ['a request timeout', () => new DOMException('The operation was aborted due to timeout', 'TimeoutError')],
  ])('treats %s as a failure of this item only', (_case, make) => {
    const error = make();
    expect(isModelCallItemFailure(error)).toBe(true);
    expect(isControlStopAfterModelCall(error)).toBe(false);
  });

  it.each([
    ['a budget authority stop', () => new ExecutionControlError('EXECUTION_BUDGET_AUTHORITY_EXHAUSTED')],
    ['a replay of an operation without a reusable result', () => new BudgetOperationReplayError('op')],
    ['a paid settlement failure', () => new ProviderSettlementError('MODEL_SETTLEMENT_GATEWAY_UNAVAILABLE', undefined, { callCount: 0 })],
    ['an external action denial', () => new ExternalActionDeniedError()],
    ['a wire whose outcome is still in flight', () => new ProviderWireInFlightError()],
    ['a cancellation', () => new DOMException('aborted', 'AbortError')],
    [
      'a model failure caused by a budget stop',
      () => new ProviderOutputError('repair call failed', undefined, {
        ...provenance,
        cause: new ExecutionControlError('EXECUTION_BUDGET_GRANT_EXPIRED'),
      }),
    ],
  ])('keeps %s a control stop', (_case, make) => {
    const error = make();
    expect(isModelCallItemFailure(error)).toBe(false);
    expect(isControlStopAfterModelCall(error)).toBe(true);
  });

  it('leaves an ordinary error to the caller exactly as before', () => {
    const error = new Error('gateway 502');
    expect(isModelCallItemFailure(error)).toBe(false);
    expect(isControlStopAfterModelCall(error)).toBe(false);
  });

  it('treats a model failure caused by another model failure as one item failure', () => {
    const error = new ProviderOutputError('repair call failed', undefined, {
      ...provenance,
      cause: new ProviderHttpError({ status: 502, ...provenance }),
    });
    expect(isModelCallItemFailure(error)).toBe(true);
    expect(isControlStopAfterModelCall(error)).toBe(false);
  });
});
