import { describe, expect, it } from 'vitest';
import { isExecutionControlError } from './execution-control-error';

describe('isExecutionControlError', () => {
  it.each([
    'EXECUTION_BUDGET_GRANT_EXPIRED',
    'BUDGET_STORE_UNAVAILABLE',
    'BUDGET_OPERATION_REPLAY_UNAVAILABLE',
    'DOMAIN_ACK_RECEIPT_BINDING_MISMATCH',
    'DOMAIN_ACK_MIXED_REPLAY_STATE',
    'DURABLE_EXECUTION_RECEIPT_LEDGER_MISMATCH',
    'GENERIC_OPERATION_ARTIFACT_INVALID',
    'GENERIC_OPERATION_ARTIFACT_PROMOTE_ACK_UNKNOWN',
  ])('recognizes %s on a direct code', (code) => {
    expect(isExecutionControlError({ code })).toBe(true);
  });

  it('recognizes deeply Temporal-wrapped receipt, ACK and artifact settlement controls', () => {
    const failure = {
      name: 'ActivityFailure',
      cause: {
        type: 'ApplicationFailure',
        cause: {
          name: 'ArtifactStorageError',
          cause: { code: 'DURABLE_EXECUTION_RECEIPT_FACTS_CONFLICT' },
        },
      },
    };
    expect(isExecutionControlError(failure)).toBe(true);
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
    expect(isExecutionControlError(new Error('ordinary provider failure'))).toBe(
      false,
    );
  });

  it('never executes an own getter and requires the caller to pass the hostile shape through', () => {
    let getterCalls = 0;
    const failure = Object.defineProperty({}, 'code', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'sensitive-getter-payload';
      },
    });

    expect(isExecutionControlError(failure)).toBe(true);
    expect(getterCalls).toBe(0);
  });

  it('contains Proxy descriptor traps and requires pass-through without leaking trap text', () => {
    const failure = new Proxy(Object.create(null), {
      ownKeys() {
        throw new Error('sensitive-descriptor-trap-payload');
      },
    });

    expect(() => isExecutionControlError(failure)).not.toThrow();
    expect(isExecutionControlError(failure)).toBe(true);
  });

  it('requires pass-through on cyclic failure causes', () => {
    const failure: { message: string; cause?: unknown } = { message: 'ordinary failure' };
    failure.cause = failure;
    expect(isExecutionControlError(failure)).toBe(true);
  });

  it('requires pass-through when a safe cause chain exceeds the depth bound', () => {
    const root: { name: string; cause?: unknown } = { name: 'ActivityFailure' };
    let cursor = root;
    for (let index = 0; index < 14; index += 1) {
      const next: { name: string; cause?: unknown } = {
        name: 'ProviderUnavailableError',
      };
      cursor.cause = next;
      cursor = next;
    }
    expect(isExecutionControlError(root)).toBe(true);
  });
});
