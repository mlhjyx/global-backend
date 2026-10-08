import { describe, expect, it } from 'vitest';
import { ActivityFailure, ApplicationFailure } from '@temporalio/workflow';
import {
  ExecutionControlError,
  isExecutionControlError,
} from './execution-control-error';
import {
  ExternalActionDeniedError,
  ProviderHttpError,
  ProviderIdentityError,
  ProviderOutputError,
  ProviderOutputUnresolvedError,
  ProviderSettlementError,
  ProviderTransportError,
  TaskOutputValidationError,
} from '../model-gateway/providers/provider-output-error';

describe('isExecutionControlError', () => {
  it('preserves a bounded structured code directly and through Temporal conversion', () => {
    const direct = new ExecutionControlError(
      'DOMAIN_ACK_CONSUMER_BINDING_MISSING',
    );
    const temporal = ApplicationFailure.fromError(direct);

    expect(direct).toMatchObject({
      code: 'DOMAIN_ACK_CONSUMER_BINDING_MISSING',
      name: 'ExecutionControlError',
      type: 'ExecutionControlError',
      message: 'DOMAIN_ACK_CONSUMER_BINDING_MISSING',
    });
    expect(temporal.type).toBe('ExecutionControlError');
    expect(isExecutionControlError(direct)).toBe(true);
    expect(isExecutionControlError(temporal)).toBe(true);
    expect(() => new ExecutionControlError('ordinary failure')).toThrow(
      'EXECUTION_CONTROL_ERROR_CODE_INVALID',
    );
    const RuntimeConstructor = ExecutionControlError as unknown as new (
      code: string,
      customMessage: string,
    ) => ExecutionControlError;
    expect(
      new RuntimeConstructor(
        'DOMAIN_ACK_CONSUMER_BINDING_MISSING',
        'Bearer custom-message-must-not-survive',
      ).message,
    ).toBe('DOMAIN_ACK_CONSUMER_BINDING_MISSING');
  });

  it.each([
    'EXECUTION_BUDGET_GRANT_EXPIRED',
    'BUDGET_STORE_UNAVAILABLE',
    'BUDGET_OPERATION_REPLAY_UNAVAILABLE',
    'DOMAIN_ACK_RECEIPT_BINDING_MISMATCH',
    'DOMAIN_ACK_MIXED_REPLAY_STATE',
    'DURABLE_EXECUTION_RECEIPT_LEDGER_MISMATCH',
    'GENERIC_OPERATION_ARTIFACT_INVALID',
    'GENERIC_OPERATION_ARTIFACT_PROMOTE_ACK_UNKNOWN',
    'PLATFORM_EGRESS_FENCE_UNAVAILABLE',
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

  it('classifies the actual Temporal 1.20.3 ActivityFailure/ApplicationFailure shapes', () => {
    const ordinary = new ActivityFailure(
      'activity failed',
      'mineDomain',
      'activity-1',
      'NON_RETRYABLE_FAILURE',
      'worker-1',
      new ApplicationFailure(
        'provider unavailable',
        'ProviderUnavailableError',
        false,
        [{ sensitive: 'must-not-be-read' }],
      ),
    );
    const control = new ActivityFailure(
      'activity failed',
      'mineDomain',
      'activity-2',
      'NON_RETRYABLE_FAILURE',
      'worker-1',
      new ApplicationFailure(
        'control message is not classification input',
        'BudgetOperationReplayError',
        true,
        [{ sensitive: 'must-not-be-read' }],
      ),
    );

    expect(Reflect.ownKeys(ordinary)).toEqual([
      'stack',
      'message',
      'cause',
      'failure',
      'activityType',
      'activityId',
      'retryState',
      'identity',
    ]);
    expect(Reflect.ownKeys(ordinary.cause!)).toEqual([
      'stack',
      'message',
      'cause',
      'failure',
      'type',
      'nonRetryable',
      'details',
      'nextRetryDelay',
      'category',
    ]);
    expect(isExecutionControlError(ordinary)).toBe(false);
    expect(isExecutionControlError(control)).toBe(true);
  });

  it('recognizes the bounded legacy Temporal 1.20.x Error/message encoding', () => {
    const legacyApplicationFailure = ApplicationFailure.fromError(
      new Error('EXECUTION_BUDGET_AUTHORITY_REVOKED'),
    );
    const legacyActivityFailure = new ActivityFailure(
      'activity failed',
      'mineDomain',
      'activity-legacy',
      'NON_RETRYABLE_FAILURE',
      'worker-legacy',
      legacyApplicationFailure,
    );

    expect(legacyApplicationFailure.type).toBe('Error');
    expect(isExecutionControlError(legacyApplicationFailure)).toBe(true);
    expect(isExecutionControlError(legacyActivityFailure)).toBe(true);
    expect(
      isExecutionControlError(
        new ApplicationFailure(
          'DOMAIN_ACK_RECEIPT_BINDING_MISMATCH',
          '',
          true,
        ),
      ),
    ).toBe(true);
  });

  it('does not trust arbitrary Error messages or non-legacy Temporal types', () => {
    expect(
      isExecutionControlError(
        new Error('EXECUTION_BUDGET_AUTHORITY_REVOKED'),
      ),
    ).toBe(false);
    expect(
      isExecutionControlError(
        new ApplicationFailure(
          'EXECUTION_BUDGET_AUTHORITY_REVOKED',
          'ProviderUnavailableError',
          false,
        ),
      ),
    ).toBe(false);
  });

  it('never invokes a legacy Temporal message getter', () => {
    let getterCalls = 0;
    const failure = new ApplicationFailure(
      'ordinary failure',
      'Error',
      false,
    );
    Object.defineProperty(failure, 'message', {
      configurable: true,
      enumerable: false,
      get() {
        getterCalls += 1;
        return 'EXECUTION_BUDGET_AUTHORITY_REVOKED';
      },
    });

    expect(isExecutionControlError(failure)).toBe(true);
    expect(getterCalls).toBe(0);
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

  it('lets a caller with a fallback absorb an unusable model answer', () => {
    // 2026-10-08 xin: one taxonomy.normalize answer that was not JSON failed the
    // whole discovery run, because the rich error shape read as a control.
    const failures = [
      new ProviderOutputError(
        'gateway deepseek-v4-pro: structured output is not valid JSON',
        { inputTokens: 520, outputTokens: 11 },
        { provider: 'gateway', model: 'deepseek-v4-pro', reportedModel: 'deepseek-v4-pro' },
      ),
      new ProviderOutputError('STRUCTURED_OUTPUT_TRUNCATED', { inputTokens: 2601 }),
      new TaskOutputValidationError('task output hard gate rejected: x', { inputTokens: 1 }),
      new Error('fallback wrapper', { cause: new ProviderOutputError('STRUCTURED_OUTPUT_EMPTY') }),
    ];

    for (const failure of failures) {
      expect(isExecutionControlError(failure)).toBe(false);
    }
  });

  it('keeps run-wide model failures, unresolved outcomes, compliance denials and unknown settlements failing closed', () => {
    // A cut stream, a substituted model or a failing gateway usually hits every
    // call of a run: absorbing them per company would end the run with nothing judged.
    const failures = [
      new ProviderTransportError('CHAT_COMPLETIONS_STREAM_TRUNCATED', { inputTokens: 2601 }),
      new ProviderIdentityError('model identity mismatch', { inputTokens: 1 }),
      new ProviderHttpError({ status: 502, provider: 'gateway', model: 'deepseek-v4-pro' }),
      new ProviderOutputUnresolvedError('repair suppressed', { inputTokens: 1 }, {
        reasonCode: 'STRUCTURED_OUTPUT_REPAIR_SUPPRESSED',
      }),
      new ExternalActionDeniedError({ inputTokens: 1 }),
      new ProviderSettlementError('MODEL_SETTLEMENT_UPSTREAM_ACK_UNKNOWN'),
    ];

    for (const failure of failures) {
      expect(isExecutionControlError(failure)).toBe(true);
    }
  });

  it('still finds a control failure behind an unusable model answer', () => {
    const failure = new ProviderOutputError('repair call failed', undefined, {
      cause: new ExecutionControlError('EXECUTION_BUDGET_GRANT_REUSED'),
    });

    expect(isExecutionControlError(failure)).toBe(true);
  });

  it('fails closed for a subclass until that class is registered on its own', () => {
    class LocalModelError extends ProviderOutputError {}

    expect(isExecutionControlError(new LocalModelError('STRUCTURED_OUTPUT_EMPTY'))).toBe(true);
  });

  it('fails closed when a registered failure carries a control code of its own', () => {
    const coded = Object.assign(new ProviderOutputError('STRUCTURED_OUTPUT_EMPTY'), {
      code: 'EXECUTION_BUDGET_GRANT_REUSED',
    });
    const bare = Object.assign(Object.create(ProviderOutputError.prototype) as object, {
      code: 'EXECUTION_BUDGET_GRANT_REUSED',
    });

    expect(isExecutionControlError(coded)).toBe(true);
    expect(isExecutionControlError(bare)).toBe(true);
  });

  it('reads a registered failure without invoking accessors; an accessor or primitive cause fails closed', () => {
    let getterCalls = 0;
    const accessorCause = Object.defineProperty(new ProviderOutputError('STRUCTURED_OUTPUT_EMPTY'), 'cause', {
      get() {
        getterCalls += 1;
        return undefined;
      },
    });
    const primitiveCause = new ProviderOutputError('STRUCTURED_OUTPUT_EMPTY', undefined, { cause: 'boom' });

    expect(isExecutionControlError(accessorCause)).toBe(true);
    expect(getterCalls).toBe(0);
    expect(isExecutionControlError(primitiveCause)).toBe(true);
  });

  it('fails closed on a proxy whose prototype trap throws', () => {
    const failure = new Proxy(new ProviderOutputError('STRUCTURED_OUTPUT_EMPTY'), {
      getPrototypeOf() {
        throw new Error('sensitive-prototype-trap-payload');
      },
    });

    expect(() => isExecutionControlError(failure)).not.toThrow();
    expect(isExecutionControlError(failure)).toBe(true);
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
