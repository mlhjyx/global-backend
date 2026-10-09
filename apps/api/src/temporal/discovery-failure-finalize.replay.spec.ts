import { resolve } from 'node:path';
import {
  ActivityFailure,
  ApplicationFailure,
  defaultFailureConverter,
  defaultPayloadConverter,
} from '@temporalio/common';
import { temporal } from '@temporalio/proto';
import {
  Worker,
  bundleWorkflowCode,
  type WorkflowBundle,
} from '@temporalio/worker';
import { beforeAll, describe, it } from 'vitest';

/**
 * BI-25 replay: a fit failure recorded before `discovery-failure-finalize-v1`
 * must replay to the same WorkflowExecutionFailed, and one recorded after it
 * must replay through the FAILED finalizeRun it scheduled.
 */
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
const AUTHORITY = { executionContractVersion: 2, executionBudget: DISCOVERY_BUDGET };
const RUN = { workspaceId: WORKSPACE, runId: 'run-1' };
const RUN_ICP = { ...RUN, icpId: 'icp-1' };
const FAILURE_FINALIZE_PATCH = 'discovery-failure-finalize-v1';
const PRE_FAILURE_PATCHES = [
  'discovery-workspace-authority-v2',
  'discovery-raw-governance-dispositions-v1',
  'discovery-query-receipt-input-v1',
] as const;
const WEBSITE_PROFILE_PATCH = 'discovery-website-profile-v1';
// The retry policy the fit activity was scheduled with before this change.
const OLD_RETRY = {
  initialInterval: '1s',
  backoffCoefficient: 2,
  maximumInterval: '100s',
  maximumAttempts: 3,
  nonRetryableErrorTypes: [],
};

function payload(value: unknown) {
  return temporal.api.common.v1.Payload.toObject(
    defaultPayloadConverter.toPayload(value)!,
    { bytes: String },
  );
}

function failureJSON(error: Error) {
  return temporal.api.failure.v1.Failure.toObject(
    temporal.api.failure.v1.Failure.create(
      defaultFailureConverter.errorToFailure(error, defaultPayloadConverter),
    ),
    { bytes: String, longs: String, enums: String },
  );
}

class DiscoveryHistory {
  readonly events: Record<string, unknown>[] = [];
  private readonly taskQueue = { name: 'discovery-failure-replay', kind: 'TASK_QUEUE_KIND_NORMAL' };
  private activities = 0;

  constructor() {
    this.add('WORKFLOW_EXECUTION_STARTED', 'workflowExecutionStartedEventAttributes', {
      workflowType: { name: 'discoveryWorkflow' },
      taskQueue: this.taskQueue,
      input: { payloads: [payload({ ...RUN_ICP, planId: 'plan-1', ...AUTHORITY })] },
      workflowExecutionTimeout: '0s',
      workflowRunTimeout: '0s',
      workflowTaskTimeout: '10s',
      originalExecutionRunId: '00000000-0000-4000-8000-000000000001',
      firstExecutionRunId: '00000000-0000-4000-8000-000000000001',
      identity: 'replay-fixture',
      attempt: 1,
      firstWorkflowTaskBackoff: '0s',
    });
  }

  private add(kind: string, field: string, attributes: object): string {
    const eventId = String(this.events.length + 1);
    this.events.push({
      eventId,
      eventTime: '2026-10-09T00:00:00Z',
      eventType: `EVENT_TYPE_${kind}`,
      taskId: eventId,
      [field]: attributes,
    });
    return eventId;
  }

  /** One workflow task; returns its WorkflowTaskCompleted event id. */
  workflowTask(): string {
    const scheduled = this.add('WORKFLOW_TASK_SCHEDULED', 'workflowTaskScheduledEventAttributes', {
      taskQueue: this.taskQueue,
      startToCloseTimeout: '10s',
      attempt: 1,
    });
    const started = this.add('WORKFLOW_TASK_STARTED', 'workflowTaskStartedEventAttributes', {
      scheduledEventId: scheduled,
      identity: 'replay-fixture',
      requestId: '00000000-0000-4000-8000-000000000002',
      historySizeBytes: '0',
    });
    return this.add('WORKFLOW_TASK_COMPLETED', 'workflowTaskCompletedEventAttributes', {
      scheduledEventId: scheduled,
      startedEventId: started,
      identity: 'replay-fixture',
      sdkMetadata: { coreUsedFlags: [1, 2, 3] },
      meteringMetadata: {},
    });
  }

  patch(patchId: string, task: string): void {
    this.add('MARKER_RECORDED', 'markerRecordedEventAttributes', {
      markerName: 'core_patch',
      details: { 'patch-data': { payloads: [payload({ id: patchId, deprecated: false })] } },
      workflowTaskCompletedEventId: task,
    });
    this.add('UPSERT_WORKFLOW_SEARCH_ATTRIBUTES', 'upsertWorkflowSearchAttributesEventAttributes', {
      workflowTaskCompletedEventId: task,
      searchAttributes: { indexedFields: { TemporalChangeVersion: payload([patchId]) } },
    });
  }

  activity(
    task: string,
    activityType: string,
    input: unknown,
    startToCloseTimeout: string,
    outcome: { result: unknown } | { failure: Error },
  ): void {
    this.activities += 1;
    const scheduled = this.add('ACTIVITY_TASK_SCHEDULED', 'activityTaskScheduledEventAttributes', {
      activityId: String(this.activities),
      activityType: { name: activityType },
      taskQueue: this.taskQueue,
      header: {},
      input: { payloads: [payload(input)] },
      scheduleToCloseTimeout: '0s',
      scheduleToStartTimeout: '0s',
      startToCloseTimeout,
      heartbeatTimeout: '0s',
      workflowTaskCompletedEventId: task,
      retryPolicy: OLD_RETRY,
      useWorkflowBuildId: true,
    });
    const attempt = 'failure' in outcome ? 3 : 1;
    const started = this.add('ACTIVITY_TASK_STARTED', 'activityTaskStartedEventAttributes', {
      scheduledEventId: scheduled,
      identity: 'replay-fixture',
      requestId: '00000000-0000-4000-8000-000000000003',
      attempt,
    });
    if ('failure' in outcome) {
      this.add('ACTIVITY_TASK_FAILED', 'activityTaskFailedEventAttributes', {
        scheduledEventId: scheduled,
        startedEventId: started,
        identity: 'replay-fixture',
        failure: failureJSON(outcome.failure),
        retryState: 'RETRY_STATE_MAXIMUM_ATTEMPTS_REACHED',
      });
      return;
    }
    this.add('ACTIVITY_TASK_COMPLETED', 'activityTaskCompletedEventAttributes', {
      scheduledEventId: scheduled,
      startedEventId: started,
      identity: 'replay-fixture',
      result: { payloads: [payload(outcome.result)] },
    });
  }

  workflowFailed(task: string, failure: Error): void {
    this.add('WORKFLOW_EXECUTION_FAILED', 'workflowExecutionFailedEventAttributes', {
      workflowTaskCompletedEventId: task,
      retryState: 'RETRY_STATE_RETRY_POLICY_NOT_SET',
      failure: failureJSON(failure),
    });
  }
}

const transport = ApplicationFailure.create({
  message: 'Temporal execution failed',
  type: 'ProviderTransportError',
  nonRetryable: false,
});

/** Everything up to and including the fit activity that failed after its retries. */
function historyThroughFailedFit(): { history: DiscoveryHistory; task: string } {
  const history = new DiscoveryHistory();
  let task = history.workflowTask();
  for (const patchId of PRE_FAILURE_PATCHES) history.patch(patchId, task);
  history.activity(task, 'loadPlanQueries', { workspaceId: WORKSPACE, planId: 'plan-1', ...AUTHORITY }, '120s', {
    result: { queries: [] },
  });
  task = history.workflowTask();
  history.activity(task, 'canonicalizeRun', { ...RUN, ...AUTHORITY }, '120s', {
    result: { companies: 0, suppressed: 0 },
  });
  task = history.workflowTask();
  history.patch(WEBSITE_PROFILE_PATCH, task);
  history.activity(task, 'profileWebsitesForRun', { ...RUN_ICP, ...AUTHORITY }, '1800s', {
    result: { profiled: 0, matched: 0, skippedSubjects: 0, budgetTruncated: false, unclassified: 0 },
  });
  task = history.workflowTask();
  history.activity(task, 'qualifyFitForRun', { ...RUN_ICP, ...AUTHORITY }, '900s', {
    failure: transport,
  });
  return { history, task: history.workflowTask() };
}

function fitFailure(): ActivityFailure {
  return new ActivityFailure(
    'Activity task failed',
    'qualifyFitForRun',
    '4',
    'MAXIMUM_ATTEMPTS_REACHED',
    'replay-fixture',
    transport,
  );
}

describe('discovery failure finalization replay (BI-25)', () => {
  let workflowBundle: WorkflowBundle;

  beforeAll(async () => {
    workflowBundle = await bundleWorkflowCode({
      workflowsPath: resolve(import.meta.dirname, 'workflows.ts'),
    });
  }, 180_000);

  it('replays a fit failure recorded before the patch to the same failed workflow, without finalizing', async () => {
    const { history, task } = historyThroughFailedFit();
    history.workflowFailed(task, fitFailure());

    await Worker.runReplayHistory({ workflowBundle }, { events: history.events }, 'pre-patch-fit-failure');
  }, 120_000);

  it('replays a fit failure recorded after the patch through its FAILED finalizeRun', async () => {
    const { history, task } = historyThroughFailedFit();
    history.patch(FAILURE_FINALIZE_PATCH, task);
    history.activity(
      task,
      'finalizeRun',
      {
        ...RUN_ICP,
        planId: 'plan-1',
        status: 'FAILED',
        stats: {
          perSource: {},
          perQuery: {},
          rawGovernance: {
            accepted: 0,
            quarantined: 0,
            rejected: 0,
            governanceDenied: 0,
            duplicate: 0,
            usageQuantity: 0,
            costCents: 0,
          },
          queries: 0,
          failures: 0,
          failure: { stage: 'fit', errorType: 'ProviderTransportError', control: false },
        },
        ...AUTHORITY,
      },
      '120s',
      { result: undefined },
    );
    history.workflowFailed(history.workflowTask(), fitFailure());

    await Worker.runReplayHistory({ workflowBundle }, { events: history.events }, 'patched-fit-failure');
  }, 120_000);
});
