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
  const taskQueue = {
    name: 'workspace-authority-replay',
    kind: 'TASK_QUEUE_KIND_NORMAL',
  };
  return {
    events: [
      {
        eventId: '1',
        eventTime,
        eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED',
        taskId: '1',
        workflowExecutionStartedEventAttributes: {
          workflowType: { name: input.workflowType },
          taskQueue,
          input: { payloads: [payload(input.workflowInput)] },
          workflowExecutionTimeout: '0s',
          workflowRunTimeout: '0s',
          workflowTaskTimeout: '10s',
          originalExecutionRunId: '00000000-0000-4000-8000-000000000001',
          firstExecutionRunId: '00000000-0000-4000-8000-000000000001',
          identity: 'legacy-worker',
          attempt: 1,
          firstWorkflowTaskBackoff: '0s',
        },
      },
      {
        eventId: '2',
        eventTime,
        eventType: 'EVENT_TYPE_WORKFLOW_TASK_SCHEDULED',
        taskId: '2',
        workflowTaskScheduledEventAttributes: {
          taskQueue,
          startToCloseTimeout: '10s',
          attempt: 1,
        },
      },
      {
        eventId: '3',
        eventTime,
        eventType: 'EVENT_TYPE_WORKFLOW_TASK_STARTED',
        taskId: '3',
        workflowTaskStartedEventAttributes: {
          scheduledEventId: '2',
          identity: 'legacy-worker',
          requestId: '00000000-0000-4000-8000-000000000002',
          historySizeBytes: '0',
        },
      },
      {
        eventId: '4',
        eventTime,
        eventType: 'EVENT_TYPE_WORKFLOW_TASK_COMPLETED',
        taskId: '4',
        workflowTaskCompletedEventAttributes: {
          scheduledEventId: '2',
          startedEventId: '3',
          identity: 'legacy-worker',
          sdkMetadata: { coreUsedFlags: [1, 2, 3] },
          meteringMetadata: {},
        },
      },
      {
        eventId: '5',
        eventTime,
        eventType: 'EVENT_TYPE_ACTIVITY_TASK_SCHEDULED',
        taskId: '5',
        activityTaskScheduledEventAttributes: {
          activityId: '1',
          activityType: { name: input.activityType },
          taskQueue,
          header: {},
          input: { payloads: [payload(input.activityInput)] },
          scheduleToCloseTimeout: '0s',
          scheduleToStartTimeout: '0s',
          startToCloseTimeout: input.startToCloseTimeout,
          heartbeatTimeout: '0s',
          workflowTaskCompletedEventId: '4',
          retryPolicy: {
            initialInterval: '1s',
            backoffCoefficient: 2,
            maximumInterval: '100s',
            maximumAttempts: 3,
            nonRetryableErrorTypes: [],
          },
          useWorkflowBuildId: true,
        },
      },
    ],
  };
}

const DISCOVERY_AUTHORITY_PATCH = 'discovery-workspace-authority-v2';
const DISCOVERY_RAW_GOVERNANCE_PATCH =
  'discovery-raw-governance-dispositions-v1';
const DISCOVERY_QUERY_RECEIPT_PATCH = 'discovery-query-receipt-input-v1';
const DISCOVERY_QUERY_RECEIPT_MODE = 'raw-governance-query-receipt/v1';
const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const SHA = 'a'.repeat(64);
const DISCOVERY_BUDGET = Object.freeze({
  authorityId: '20000000-0000-4000-8000-000000000002',
  replay: false,
  scopeKey: WORKSPACE,
  accountKey: `discovery.run:discovery_run:request:${SHA}:${SHA}`,
  purpose: 'discovery.run',
  subjectType: 'discovery_run',
  subjectId: `request:${SHA}`,
  requestSha256: SHA,
});
const DISCOVERY_QUERY = Object.freeze({
  source_class: 'official_registry',
  filters: {},
  keywords: [],
  priority: 1,
});

function authorityQueryHistory(input: {
  patches: readonly string[];
  executeQueryInput: Record<string, unknown>;
}) {
  const eventTime = '2026-08-20T00:00:00Z';
  const taskQueue = {
    name: 'workspace-authority-replay',
    kind: 'TASK_QUEUE_KIND_NORMAL',
  };
  const workflowInput = {
    workspaceId: WORKSPACE,
    runId: 'run-1',
    planId: 'plan-1',
    icpId: 'icp-1',
    executionContractVersion: 2,
    executionBudget: DISCOVERY_BUDGET,
  };
  const events: Record<string, unknown>[] = [
    {
      eventId: '1',
      eventTime,
      eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED',
      taskId: '1',
      workflowExecutionStartedEventAttributes: {
        workflowType: { name: 'discoveryWorkflow' },
        taskQueue,
        input: { payloads: [payload(workflowInput)] },
        workflowExecutionTimeout: '0s',
        workflowRunTimeout: '0s',
        workflowTaskTimeout: '10s',
        originalExecutionRunId: '00000000-0000-4000-8000-000000000001',
        firstExecutionRunId: '00000000-0000-4000-8000-000000000001',
        identity: 'legacy-worker',
        attempt: 1,
        firstWorkflowTaskBackoff: '0s',
      },
    },
    {
      eventId: '2',
      eventTime,
      eventType: 'EVENT_TYPE_WORKFLOW_TASK_SCHEDULED',
      taskId: '2',
      workflowTaskScheduledEventAttributes: {
        taskQueue,
        startToCloseTimeout: '10s',
        attempt: 1,
      },
    },
    {
      eventId: '3',
      eventTime,
      eventType: 'EVENT_TYPE_WORKFLOW_TASK_STARTED',
      taskId: '3',
      workflowTaskStartedEventAttributes: {
        scheduledEventId: '2',
        identity: 'legacy-worker',
        requestId: '00000000-0000-4000-8000-000000000002',
        historySizeBytes: '0',
      },
    },
    {
      eventId: '4',
      eventTime,
      eventType: 'EVENT_TYPE_WORKFLOW_TASK_COMPLETED',
      taskId: '4',
      workflowTaskCompletedEventAttributes: {
        scheduledEventId: '2',
        startedEventId: '3',
        identity: 'legacy-worker',
        sdkMetadata: { coreUsedFlags: [1, 2, 3] },
        meteringMetadata: {},
      },
    },
  ];
  for (const patchId of input.patches) {
    events.push({
      eventId: String(events.length + 1),
      eventTime,
      eventType: 'EVENT_TYPE_MARKER_RECORDED',
      taskId: String(events.length + 1),
      markerRecordedEventAttributes: {
        markerName: 'core_patch',
        details: {
          'patch-data': {
            payloads: [payload({ id: patchId, deprecated: false })],
          },
        },
        workflowTaskCompletedEventId: '4',
      },
    });
    events.push({
      eventId: String(events.length + 1),
      eventTime,
      eventType: 'EVENT_TYPE_UPSERT_WORKFLOW_SEARCH_ATTRIBUTES',
      taskId: String(events.length + 1),
      upsertWorkflowSearchAttributesEventAttributes: {
        workflowTaskCompletedEventId: '4',
        searchAttributes: {
          indexedFields: {
            TemporalChangeVersion: payload([patchId]),
          },
        },
      },
    });
  }
  const loadScheduledId = String(events.length + 1);
  events.push({
    eventId: loadScheduledId,
    eventTime,
    eventType: 'EVENT_TYPE_ACTIVITY_TASK_SCHEDULED',
    taskId: loadScheduledId,
    activityTaskScheduledEventAttributes: {
      activityId: '1',
      activityType: { name: 'loadPlanQueries' },
      taskQueue,
      header: {},
      input: {
        payloads: [
          payload({
            workspaceId: WORKSPACE,
            planId: 'plan-1',
            executionContractVersion: 2,
            executionBudget: DISCOVERY_BUDGET,
          }),
        ],
      },
      scheduleToCloseTimeout: '0s',
      scheduleToStartTimeout: '0s',
      startToCloseTimeout: '120s',
      heartbeatTimeout: '0s',
      workflowTaskCompletedEventId: '4',
      retryPolicy: {
        initialInterval: '1s',
        backoffCoefficient: 2,
        maximumInterval: '100s',
        maximumAttempts: 3,
        nonRetryableErrorTypes: [],
      },
      useWorkflowBuildId: true,
    },
  });
  const activityStartedId = String(events.length + 1);
  events.push({
    eventId: activityStartedId,
    eventTime,
    eventType: 'EVENT_TYPE_ACTIVITY_TASK_STARTED',
    taskId: activityStartedId,
    activityTaskStartedEventAttributes: {
      scheduledEventId: loadScheduledId,
      identity: 'legacy-worker',
      requestId: '00000000-0000-4000-8000-000000000003',
      attempt: 1,
      lastFailure: null,
    },
  });
  const activityCompletedId = String(events.length + 1);
  events.push({
    eventId: activityCompletedId,
    eventTime,
    eventType: 'EVENT_TYPE_ACTIVITY_TASK_COMPLETED',
    taskId: activityCompletedId,
    activityTaskCompletedEventAttributes: {
      scheduledEventId: loadScheduledId,
      startedEventId: activityStartedId,
      identity: 'legacy-worker',
      result: { payloads: [payload({ queries: [DISCOVERY_QUERY] })] },
    },
  });
  const secondTaskScheduledId = String(events.length + 1);
  events.push({
    eventId: secondTaskScheduledId,
    eventTime,
    eventType: 'EVENT_TYPE_WORKFLOW_TASK_SCHEDULED',
    taskId: secondTaskScheduledId,
    workflowTaskScheduledEventAttributes: {
      taskQueue,
      startToCloseTimeout: '10s',
      attempt: 1,
    },
  });
  const secondTaskStartedId = String(events.length + 1);
  events.push({
    eventId: secondTaskStartedId,
    eventTime,
    eventType: 'EVENT_TYPE_WORKFLOW_TASK_STARTED',
    taskId: secondTaskStartedId,
    workflowTaskStartedEventAttributes: {
      scheduledEventId: secondTaskScheduledId,
      identity: 'legacy-worker',
      requestId: '00000000-0000-4000-8000-000000000004',
      historySizeBytes: '0',
    },
  });
  const secondTaskCompletedId = String(events.length + 1);
  events.push({
    eventId: secondTaskCompletedId,
    eventTime,
    eventType: 'EVENT_TYPE_WORKFLOW_TASK_COMPLETED',
    taskId: secondTaskCompletedId,
    workflowTaskCompletedEventAttributes: {
      scheduledEventId: secondTaskScheduledId,
      startedEventId: secondTaskStartedId,
      identity: 'legacy-worker',
      sdkMetadata: { coreUsedFlags: [1, 2, 3] },
      meteringMetadata: {},
    },
  });
  const executeScheduledId = String(events.length + 1);
  events.push({
    eventId: executeScheduledId,
    eventTime,
    eventType: 'EVENT_TYPE_ACTIVITY_TASK_SCHEDULED',
    taskId: executeScheduledId,
    activityTaskScheduledEventAttributes: {
      activityId: '2',
      activityType: { name: 'executeQuery' },
      taskQueue,
      header: {},
      input: { payloads: [payload(input.executeQueryInput)] },
      scheduleToCloseTimeout: '0s',
      scheduleToStartTimeout: '0s',
      startToCloseTimeout: '120s',
      heartbeatTimeout: '0s',
      workflowTaskCompletedEventId: secondTaskCompletedId,
      retryPolicy: {
        initialInterval: '1s',
        backoffCoefficient: 2,
        maximumInterval: '100s',
        maximumAttempts: 3,
        nonRetryableErrorTypes: [],
      },
      useWorkflowBuildId: true,
    },
  });
  return { events };
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
      runId: 'run-1',
      planId: 'plan-1',
      icpId: 'icp-1',
    };
    await Worker.runReplayHistory(
      { workflowBundle },
      legacyHistory({
        workflowType: 'discoveryWorkflow',
        workflowInput,
        activityType: 'resetRunBudget',
        activityInput: {
          workspaceId: workflowInput.workspaceId,
          runId: workflowInput.runId,
        },
        startToCloseTimeout: '120s',
      }),
      'legacy-discovery',
    );
  }, 20_000);

  it('replays the authority-era non-Raw executeQuery input without receipt identity', async () => {
    await Worker.runReplayHistory(
      { workflowBundle },
      authorityQueryHistory({
        patches: [DISCOVERY_AUTHORITY_PATCH],
        executeQueryInput: {
          workspaceId: WORKSPACE,
          runId: 'run-1',
          query: DISCOVERY_QUERY,
          executionContractVersion: 2,
          executionBudget: DISCOVERY_BUDGET,
        },
      }),
      'authority-era-discovery',
    );
  }, 20_000);

  it('replays the pre-receipt Raw-governance executeQuery input without receipt identity', async () => {
    await Worker.runReplayHistory(
      { workflowBundle },
      authorityQueryHistory({
        patches: [DISCOVERY_AUTHORITY_PATCH, DISCOVERY_RAW_GOVERNANCE_PATCH],
        executeQueryInput: {
          workspaceId: WORKSPACE,
          runId: 'run-1',
          query: DISCOVERY_QUERY,
          executionContractVersion: 2,
          executionBudget: DISCOVERY_BUDGET,
        },
      }),
      'pre-receipt-raw-governance-discovery',
    );
  }, 20_000);

  it('replays the new Raw-governance receipt input with the closed mode and identity', async () => {
    await Worker.runReplayHistory(
      { workflowBundle },
      authorityQueryHistory({
        patches: [
          DISCOVERY_AUTHORITY_PATCH,
          DISCOVERY_RAW_GOVERNANCE_PATCH,
          DISCOVERY_QUERY_RECEIPT_PATCH,
        ],
        executeQueryInput: {
          workspaceId: WORKSPACE,
          runId: 'run-1',
          planId: 'plan-1',
          queryOrdinal: 0,
          queryReceiptMode: DISCOVERY_QUERY_RECEIPT_MODE,
          query: DISCOVERY_QUERY,
          executionContractVersion: 2,
          executionBudget: DISCOVERY_BUDGET,
        },
      }),
      'new-receipt-raw-governance-discovery',
    );
  }, 20_000);

  it('replays the pre-authority understanding status command without nondeterminism', async () => {
    const workflowInput = {
      workspaceId: '10000000-0000-4000-8000-000000000001',
      companyId: 'company-1',
      website: 'https://acme.example/',
    };
    await Worker.runReplayHistory(
      { workflowBundle },
      legacyHistory({
        workflowType: 'understandingWorkflow',
        workflowInput,
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
