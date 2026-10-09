import { describe, expect, it } from 'vitest';
import {
  ActivityFailure,
  ApplicationFailure,
  TimeoutFailure,
} from '@temporalio/common';
import { describeDiscoveryRunFailure } from './discovery.run-failure';
import { isExecutionControlError } from '../execution-budget/execution-control-error';

function activityFailure(activityType: string, cause: Error): ActivityFailure {
  return new ActivityFailure(
    'Activity task failed',
    activityType,
    '5',
    'MAXIMUM_ATTEMPTS_REACHED',
    'worker-1',
    cause,
  );
}

describe('describeDiscoveryRunFailure', () => {
  it('names the stage and the innermost failure type, never a message', () => {
    const error = activityFailure(
      'qualifyFitForRun',
      new ApplicationFailure(
        'upstream said: person@example.com cannot be served',
        'ProviderTransportError',
        false,
        [{ prompt: 'Acme GmbH, Musterstraße 1' }],
      ),
    );

    const failure = describeDiscoveryRunFailure('fit', error);

    expect(failure).toEqual({
      stage: 'fit',
      errorType: 'ProviderTransportError',
      control: false,
    });
    expect(JSON.stringify(failure)).not.toMatch(/person@|Acme|Muster|upstream/u);
  });

  it('marks execution-control stops the way the shared classifier does', () => {
    const replay = activityFailure(
      'executeQuery',
      new ApplicationFailure(
        'BUDGET_OPERATION_REPLAY_UNAVAILABLE',
        'BudgetOperationReplayError',
        false,
      ),
    );
    const timeout = activityFailure(
      'qualifyFitForRun',
      new TimeoutFailure('activity timed out', undefined, 'START_TO_CLOSE'),
    );

    expect(describeDiscoveryRunFailure('query', replay)).toEqual({
      stage: 'query',
      errorType: 'BudgetOperationReplayError',
      control: true,
    });
    expect(describeDiscoveryRunFailure('fit', timeout)).toEqual({
      stage: 'fit',
      errorType: 'TimeoutFailure',
      control: isExecutionControlError(timeout),
    });
  });

  it('falls back to a plain error code or class name when there is no application type', () => {
    expect(
      describeDiscoveryRunFailure('canonicalize', new Error('database refused: secret')),
    ).toEqual({ stage: 'canonicalize', errorType: 'Error', control: false });
    expect(
      describeDiscoveryRunFailure('enrich', {
        name: 'ActivityFailure',
        message: 'Activity task failed',
        cause: { type: 'ApplicationFailure', cause: { code: 'EXECUTION_BUDGET_AUTHORITY_REVOKED' } },
      }),
    ).toEqual({
      stage: 'enrich',
      errorType: 'EXECUTION_BUDGET_AUTHORITY_REVOKED',
      control: true,
    });
  });

  it('keeps only identifier-shaped types', () => {
    expect(
      describeDiscoveryRunFailure('fit', {
        message: 'Activity task failed',
        cause: { type: 'Provider failed for person@example.com', message: 'x' },
      }).errorType,
    ).toBe('UNCLASSIFIED');
    expect(
      describeDiscoveryRunFailure('fit', {
        name: 'ActivityFailure',
        cause: { type: 'x'.repeat(65) },
      }).errorType,
    ).toBe('ActivityFailure');
  });

  it('reads data properties only and never runs accessors', () => {
    let reads = 0;
    const hostile = Object.defineProperty({ message: 'm' }, 'type', {
      enumerable: true,
      get() {
        reads += 1;
        return 'HostileType';
      },
    });

    expect(describeDiscoveryRunFailure('watches', hostile)).toEqual({
      stage: 'watches',
      errorType: 'UNCLASSIFIED',
      control: true,
    });
    expect(reads).toBe(0);
  });

  it('stops on cause cycles and past a bounded depth', () => {
    const cyclic: { name: string; cause?: unknown } = { name: 'ActivityFailure' };
    cyclic.cause = { type: 'CycleType', cause: cyclic };
    let deep: Record<string, unknown> = { type: 'TooDeepType' };
    for (let level = 0; level < 20; level += 1) deep = { cause: deep };

    expect(describeDiscoveryRunFailure('signals', cyclic).errorType).toBe('CycleType');
    expect(describeDiscoveryRunFailure('signals', deep).errorType).toBe('UNCLASSIFIED');
  });

  it('classifies a thrown non-object without reading it', () => {
    expect(describeDiscoveryRunFailure('plan', 'person@example.com')).toEqual({
      stage: 'plan',
      errorType: 'UNCLASSIFIED',
      control: true,
    });
  });
});
