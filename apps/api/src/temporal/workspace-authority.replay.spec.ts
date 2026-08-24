import { resolve } from 'node:path';
import {
  Worker,
  bundleWorkflowCode,
  defaultPayloadConverter,
  type WorkflowBundle,
} from '@temporalio/worker';
import { beforeAll, describe, it } from 'vitest';

function payload(value: unknown) {
  const converted = defaultPayloadConverter.toPayload(value)!;
  return {
    metadata: {
      encoding: Buffer.from(converted.metadata.encoding).toString('base64'),
    },
    data: Buffer.from(converted.data!).toString('base64'),
  };
}

function legacyHistory(input: {
  workflowType: string;
  workflowInput: unknown;
  activityType: string;
  activityInput: unknown;
  startToCloseTimeout: string;
}) {
  const eventTime = '2026-08-20T00:00:00Z';
  const taskQueue = { name: 'workspace-authority-replay', kind: 'TASK_QUEUE_KIND_NORMAL' };
  return {
    events: [
      {
        eventId: '1', eventTime, eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED', taskId: '1',
        workflowExecutionStartedEventAttributes: {
          workflowType: { name: input.workflowType }, taskQueue,
          input: { payloads: [payload(input.workflowInput)] },
          workflowExecutionTimeout: '0s', workflowRunTimeout: '0s', workflowTaskTimeout: '10s',
          originalExecutionRunId: '00000000-0000-4000-8000-000000000001',
          firstExecutionRunId: '00000000-0000-4000-8000-000000000001',
          identity: 'legacy-worker', attempt: 1, firstWorkflowTaskBackoff: '0s',
        },
      },
      {
        eventId: '2', eventTime, eventType: 'EVENT_TYPE_WORKFLOW_TASK_SCHEDULED', taskId: '2',
        workflowTaskScheduledEventAttributes: { taskQueue, startToCloseTimeout: '10s', attempt: 1 },
      },
      {
        eventId: '3', eventTime, eventType: 'EVENT_TYPE_WORKFLOW_TASK_STARTED', taskId: '3',
        workflowTaskStartedEventAttributes: {
          scheduledEventId: '2', identity: 'legacy-worker',
          requestId: '00000000-0000-4000-8000-000000000002', historySizeBytes: '0',
        },
      },
      {
        eventId: '4', eventTime, eventType: 'EVENT_TYPE_WORKFLOW_TASK_COMPLETED', taskId: '4',
        workflowTaskCompletedEventAttributes: {
          scheduledEventId: '2', startedEventId: '3', identity: 'legacy-worker',
          sdkMetadata: { coreUsedFlags: [1, 2, 3] }, meteringMetadata: {},
        },
      },
      {
        eventId: '5', eventTime, eventType: 'EVENT_TYPE_ACTIVITY_TASK_SCHEDULED', taskId: '5',
        activityTaskScheduledEventAttributes: {
          activityId: '1', activityType: { name: input.activityType }, taskQueue, header: {},
          input: { payloads: [payload(input.activityInput)] },
          scheduleToCloseTimeout: '0s', scheduleToStartTimeout: '0s',
          startToCloseTimeout: input.startToCloseTimeout, heartbeatTimeout: '0s',
          workflowTaskCompletedEventId: '4',
          retryPolicy: {
            initialInterval: '1s', backoffCoefficient: 2, maximumInterval: '100s',
            maximumAttempts: 3, nonRetryableErrorTypes: [],
          },
          useWorkflowBuildId: true,
        },
      },
    ],
  };
}

describe('workspace authority old-history replay', () => {
  let workflowBundle: WorkflowBundle;

  beforeAll(async () => {
    workflowBundle = await bundleWorkflowCode({
      workflowsPath: resolve(process.cwd(), 'src/temporal/workflows.ts'),
    });
  }, 20_000);

  it('replays the pre-authority discovery reset command without nondeterminism', async () => {
    const workflowInput = {
      workspaceId: '10000000-0000-4000-8000-000000000001',
      runId: 'run-1', planId: 'plan-1', icpId: 'icp-1',
    };
    await Worker.runReplayHistory(
      { workflowBundle },
      legacyHistory({
        workflowType: 'discoveryWorkflow', workflowInput,
        activityType: 'resetRunBudget',
        activityInput: { workspaceId: workflowInput.workspaceId, runId: workflowInput.runId },
        startToCloseTimeout: '120s',
      }),
      'legacy-discovery',
    );
  }, 20_000);

  it('replays the pre-authority understanding status command without nondeterminism', async () => {
    const workflowInput = {
      workspaceId: '10000000-0000-4000-8000-000000000001',
      companyId: 'company-1', website: 'https://acme.example/',
    };
    await Worker.runReplayHistory(
      { workflowBundle },
      legacyHistory({
        workflowType: 'understandingWorkflow', workflowInput,
        activityType: 'setStatus',
        activityInput: {
          companyId: workflowInput.companyId,
          workspaceId: workflowInput.workspaceId,
          status: 'ENRICHING',
        },
        startToCloseTimeout: '60s',
      }),
      'legacy-understanding',
    );
  }, 20_000);
});
