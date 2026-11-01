import { describe, expect, it } from 'vitest';
import { modelOperationCorrelationId } from './understanding.activities';

describe('modelOperationCorrelationId', () => {
  it('scopes the paid model operation key to the workflow run, activity and attempt', () => {
    expect(
      modelOperationCorrelationId({
        workflowExecution: { runId: 'run-1' },
        activityId: '12',
        attempt: 1,
      }),
    ).toBe('run-1:12:a1');
    expect(
      modelOperationCorrelationId({
        workflowExecution: { runId: 'run-1' },
        activityId: '12',
        attempt: 2,
      }),
    ).toBe('run-1:12:a2');
  });

  it('returns undefined outside an activity or with an incomplete context', () => {
    expect(modelOperationCorrelationId({})).toBeUndefined();
    expect(
      modelOperationCorrelationId({ workflowExecution: {}, activityId: '1', attempt: 1 }),
    ).toBeUndefined();
    expect(
      modelOperationCorrelationId({ workflowExecution: { runId: 'r' }, attempt: 1 }),
    ).toBeUndefined();
    expect(
      modelOperationCorrelationId({ workflowExecution: { runId: 'r' }, activityId: '1', attempt: 0 }),
    ).toBeUndefined();
  });
});
