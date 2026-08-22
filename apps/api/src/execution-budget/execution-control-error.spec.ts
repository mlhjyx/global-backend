import { describe, expect, it } from 'vitest';
import { isExecutionControlError } from './execution-control-error';

describe('isExecutionControlError', () => {
  it.each([
    'EXECUTION_BUDGET_GRANT_EXPIRED',
    'BUDGET_STORE_UNAVAILABLE',
    'BUDGET_OPERATION_REPLAY_UNAVAILABLE',
  ])('recognizes %s on a direct code', (code) => {
    expect(isExecutionControlError({ code })).toBe(true);
  });

  it('recursively recognizes Temporal ActivityFailure cause/type/message fields', () => {
    const failure = {
      name: 'ActivityFailure',
      message: 'Activity task failed',
      cause: {
        name: 'ApplicationFailure',
        type: 'BudgetOperationReplayError',
        cause: {
          message: 'EXECUTION_BUDGET_AUTHORITY_REVOKED',
        },
      },
    };

    expect(isExecutionControlError(failure)).toBe(true);
  });

  it.each(['ExecutionBudgetGrantError', 'BudgetAccountUnavailableError'])(
    'recognizes a control class preserved only in Temporal failure type: %s',
    (type) => {
      expect(isExecutionControlError({
        name: 'ActivityFailure',
        message: 'Activity task failed',
        cause: { type, message: 'control denied' },
      })).toBe(true);
    },
  );

  it('does not classify an ordinary provider failure as an execution control', () => {
    expect(isExecutionControlError({
      name: 'ActivityFailure',
      message: 'provider returned 502',
      cause: { type: 'ProviderUnavailableError', message: 'upstream down' },
    })).toBe(false);
  });

  it('terminates safely on cyclic failure causes', () => {
    const failure: { message: string; cause?: unknown } = { message: 'ordinary failure' };
    failure.cause = failure;
    expect(isExecutionControlError(failure)).toBe(false);
  });
});
