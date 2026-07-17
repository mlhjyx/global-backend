import {
  CancelledFailure,
  WorkflowFailedError,
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdConflictPolicy,
  WorkflowIdReusePolicy,
} from '@temporalio/client';
import { describe, expect, it, vi } from 'vitest';
import type { TemporalClient } from '../temporal/temporal.client';
import { UNDERSTANDING_TASK_QUEUE } from '../temporal/understanding.constants';
import { refurbishWorkflowId } from './refurbish-launcher';
import { TemporalRefurbishLauncher } from './temporal-refurbish-launcher';

const INPUT = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  siteId: '22222222-2222-4222-8222-222222222222',
  buildRunId: '33333333-3333-4333-8333-333333333333',
};
const WORKFLOW_ID = refurbishWorkflowId(INPUT.buildRunId);

function makeLauncher() {
  const start = vi.fn();
  const describe = vi.fn();
  const cancel = vi.fn();
  const result = vi.fn().mockResolvedValue(undefined);
  const getHandle = vi.fn().mockReturnValue({ describe, cancel, result });
  const temporal = {
    client: { workflow: { start, getHandle } },
  } as unknown as TemporalClient;
  return {
    launcher: new TemporalRefurbishLauncher(temporal),
    start,
    describe,
    cancel,
    result,
    getHandle,
  };
}

describe('TemporalRefurbishLauncher ACK contract', () => {
  it('starts with closed/running idempotency policies and returns both identities', async () => {
    const { launcher, start } = makeLauncher();
    start.mockResolvedValue({ firstExecutionRunId: 'first-run' });

    await expect(launcher.launchRefurbish(INPUT)).resolves.toEqual({
      workflowId: WORKFLOW_ID,
      firstExecutionRunId: 'first-run',
    });
    expect(start).toHaveBeenCalledWith('refurbishWorkflow', {
      taskQueue: UNDERSTANDING_TASK_QUEUE,
      workflowId: WORKFLOW_ID,
      args: [INPUT],
      workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
    });
  });

  it('recovers a closed duplicate by describe and prefers the chain firstRunId', async () => {
    const { launcher, start, describe } = makeLauncher();
    start.mockRejectedValue(
      new WorkflowExecutionAlreadyStartedError(
        'duplicate',
        WORKFLOW_ID,
        'refurbishWorkflow',
      ),
    );
    describe.mockResolvedValue({
      runId: 'latest-run',
      raw: { workflowExecutionInfo: { firstRunId: 'first-run' } },
    });

    await expect(launcher.launchRefurbish(INPUT)).resolves.toEqual({
      workflowId: WORKFLOW_ID,
      firstExecutionRunId: 'first-run',
    });
  });

  it('recover is describe-only and falls back to description.runId', async () => {
    const { launcher, start, describe, getHandle } = makeLauncher();
    describe.mockResolvedValue({ runId: 'described-run', raw: {} });

    await expect(launcher.recoverRefurbish(INPUT)).resolves.toEqual({
      workflowId: WORKFLOW_ID,
      firstExecutionRunId: 'described-run',
    });
    expect(start).not.toHaveBeenCalled();
    expect(getHandle).toHaveBeenCalledWith(WORKFLOW_ID);
  });

  it('fails closed on empty execution identity and preserves ordinary start errors', async () => {
    const empty = makeLauncher();
    empty.start.mockResolvedValue({ firstExecutionRunId: '' });
    await expect(empty.launcher.launchRefurbish(INPUT)).rejects.toThrow(
      /execution run id/i,
    );

    const failed = makeLauncher();
    const original = new Error('transport down');
    failed.start.mockRejectedValue(original);
    await expect(failed.launcher.launchRefurbish(INPUT)).rejects.toBe(original);
    expect(failed.getHandle).not.toHaveBeenCalled();
  });

  it('cancel uses the persisted workflow identity when supplied', async () => {
    const { launcher, getHandle, cancel, result } = makeLauncher();
    await expect(
      launcher.cancelRefurbish(INPUT.buildRunId, 'persisted-workflow-id'),
    ).resolves.toEqual({ terminalStatus: 'completed' });
    expect(getHandle).toHaveBeenCalledWith('persisted-workflow-id');
    expect(cancel).toHaveBeenCalledOnce();
    expect(result).toHaveBeenCalledOnce();
  });

  it('waits for the closed chain and classifies cancellation, failure, and transport errors', async () => {
    const cancelled = makeLauncher();
    const closedCancellation = Object.assign(
      Object.create(WorkflowFailedError.prototype) as WorkflowFailedError,
      { cause: Object.create(CancelledFailure.prototype) as CancelledFailure },
    );
    cancelled.result.mockRejectedValue(closedCancellation);
    await expect(
      cancelled.launcher.cancelRefurbish(INPUT.buildRunId, WORKFLOW_ID),
    ).resolves.toEqual({ terminalStatus: 'cancelled' });

    const workflowFailed = makeLauncher();
    const closedFailure = Object.assign(
      Object.create(WorkflowFailedError.prototype) as WorkflowFailedError,
      { cause: new Error('activity failed') },
    );
    workflowFailed.result.mockRejectedValue(closedFailure);
    await expect(
      workflowFailed.launcher.cancelRefurbish(INPUT.buildRunId, WORKFLOW_ID),
    ).resolves.toEqual({ terminalStatus: 'failed' });

    const failed = makeLauncher();
    failed.result.mockRejectedValue(new Error('workflow failed'));
    await expect(
      failed.launcher.cancelRefurbish(INPUT.buildRunId, WORKFLOW_ID),
    ).rejects.toThrow('workflow failed');
  });
});
