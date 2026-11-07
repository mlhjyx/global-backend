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
 * B1（L01）replay: the discovery workflow's tunable constants (pool search
 * fallback threshold, deep-company concurrency, query batch size) travel in
 * the recorded start input. A history recorded before the fields existed
 * replays on the frozen defaults; a history recorded with explicit values must
 * replay through those values even though the code defaults differ — that is
 * what a plain module constant could not do.
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
const PRE_QUERY_PATCHES = [
  'discovery-workspace-authority-v2',
  'discovery-raw-governance-dispositions-v1',
  'discovery-query-receipt-input-v1',
  'discovery-run2-quick-scan-v1',
] as const;
const QUERY_BATCH_PATCH = 'discovery-query-batch-v1';
const QUERY_FAILURE_STOP_PATCH = 'discovery-query-failure-stop-v1';
const FAILURE_FINALIZE_PATCH = 'discovery-failure-finalize-v1';
const DEEP_STAGE_LABEL_PATCH = 'discovery-deep-stage-label-v1';
const QUERY_RECEIPT_MODE = 'raw-governance-query-receipt/v1';
const RETRY_POLICY = {
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
  private readonly taskQueue = { name: 'discovery-knobs-replay', kind: 'TASK_QUEUE_KIND_NORMAL' };
  private activities = 0;
  private children = 0;

  constructor(startInput: Record<string, unknown>) {
    this.add('WORKFLOW_EXECUTION_STARTED', 'workflowExecutionStartedEventAttributes', {
      workflowType: { name: 'discoveryWorkflow' },
      taskQueue: this.taskQueue,
      input: { payloads: [payload(startInput)] },
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
      eventTime: '2026-11-08T00:00:00Z',
      eventType: `EVENT_TYPE_${kind}`,
      taskId: eventId,
      [field]: attributes,
    });
    return eventId;
  }

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
    // Every core patch command also upserts the TemporalChangeVersion search
    // attribute; the replay validates the two as a pair.
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
      retryPolicy: RETRY_POLICY,
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

  /** A completed child workflow (executeChild) initiated by `task`. */
  childWorkflow(task: string, workflowId: string, result: unknown): void {
    this.children += 1;
    const initiated = this.add(
      'START_CHILD_WORKFLOW_EXECUTION_INITIATED',
      'startChildWorkflowExecutionInitiatedEventAttributes',
      {
        namespace: 'default',
        workflowId,
        workflowType: { name: 'companyPipelineWorkflow' },
        taskQueue: this.taskQueue,
        input: { payloads: [] },
        parentClosePolicy: 'PARENT_CLOSE_POLICY_TERMINATE',
        workflowExecutionTimeout: '0s',
        workflowRunTimeout: '0s',
        workflowTaskTimeout: '10s',
        header: {},
        workflowTaskCompletedEventId: task,
      },
    );
    const runId = `00000000-0000-4000-8000-0000000000${String(this.children).padStart(2, '0')}`;
    const started = this.add('CHILD_WORKFLOW_EXECUTION_STARTED', 'childWorkflowExecutionStartedEventAttributes', {
      namespace: 'default',
      workflowExecution: { workflowId, runId },
      workflowType: { name: 'companyPipelineWorkflow' },
      initiatedEventId: initiated,
      header: {},
    });
    this.add('CHILD_WORKFLOW_EXECUTION_COMPLETED', 'childWorkflowExecutionCompletedEventAttributes', {
      result: { payloads: [payload(result)] },
      namespace: 'default',
      workflowExecution: { workflowId, runId },
      workflowType: { name: 'companyPipelineWorkflow' },
      initiatedEventId: initiated,
      startedEventId: started,
    });
  }

  workflowFailed(task: string, failure: Error): void {
    this.add('WORKFLOW_EXECUTION_FAILED', 'workflowExecutionFailedEventAttributes', {
      workflowTaskCompletedEventId: task,
      retryState: 'RETRY_STATE_RETRY_POLICY_NOT_SET',
      failure: failureJSON(failure),
    });
  }

  workflowCompleted(task: string, result: unknown): void {
    this.add('WORKFLOW_EXECUTION_COMPLETED', 'workflowExecutionCompletedEventAttributes', {
      result: { payloads: [payload(result)] },
      workflowTaskCompletedEventId: task,
    });
  }
}

const PLAN_QUERIES = [1, 2].map((priority) => ({
  source_class: 'official_registry',
  filters: {},
  keywords: [`Pumpen ${priority}`],
  priority,
}));
const TRIPLE_QUERIES = [
  ...PLAN_QUERIES,
  { source_class: 'official_registry', filters: {}, keywords: ['Pumpen 3'], priority: 3 },
];

function queryReceipt(queryOrdinal: number) {
  return {
    schemaVersion: 'discovery-query-receipt/v1',
    queryKey: `${queryOrdinal}`.padEnd(64, 'b'),
    queryOrdinal,
    sourceClass: 'official_registry',
    providers: ['gleif'],
    accepted: 0,
    quarantined: 0,
    rejected: 0,
    governanceDenied: 0,
    duplicate: 0,
    usageQuantity: 0,
    costCents: 0,
  };
}

function queryInput(queryOrdinal: number, queries = PLAN_QUERIES) {
  return {
    ...RUN,
    planId: 'plan-1',
    queryOrdinal,
    queryReceiptMode: QUERY_RECEIPT_MODE,
    query: queries[queryOrdinal],
    ...AUTHORITY,
  };
}

const QUERY_RESULT = (queryOrdinal: number) => ({
  rawCount: 0,
  quarantinedCount: 0,
  rejectedCount: 0,
  duplicateCount: 0,
  provider: 'gleif',
  budgetTruncated: false,
  queryReceipt: queryReceipt(queryOrdinal),
});

// What the last attempt of a query activity reports when it failed for an ordinary reason.
const lastQueryAttempt = ApplicationFailure.create({
  message: 'database unavailable',
  type: 'PrismaClientKnownRequestError',
  nonRetryable: false,
});

function queryFailure(): ActivityFailure {
  return new ActivityFailure(
    'Activity task failed',
    'executeQuery',
    '2',
    'MAXIMUM_ATTEMPTS_REACHED',
    'replay-fixture',
    lastQueryAttempt,
  );
}

const FAILED_FINALIZE_INPUT = {
  ...RUN_ICP,
  planId: 'plan-1',
  status: 'FAILED',
  stats: { queries: 2, failures: 0 },
  ...AUTHORITY,
};

/**
 * A search-path run up to its two plan queries loading. Activity input payloads
 * here are plausible placeholders: replay matches command type and order, not
 * payloads, so exact activity arguments belong in the workflow unit specs.
 */
function historyThroughPlanQueries(startInput: Record<string, unknown>): {
  history: DiscoveryHistory;
  task: string;
} {
  const history = new DiscoveryHistory(startInput);
  let task = history.workflowTask();
  for (const patchId of PRE_QUERY_PATCHES) history.patch(patchId, task);
  history.activity(task, 'loadPlanQueries', { workspaceId: WORKSPACE, planId: 'plan-1', ...AUTHORITY }, '120s', {
    result: { queries: PLAN_QUERIES },
  });
  task = history.workflowTask();
  return { history, task };
}

/** A run recorded while the code still had no knob fields: the batch defaults to 2, and the two queries go out together. */
function historyThroughConcurrentQueryBatch(): { history: DiscoveryHistory; task: string } {
  const { history, task: task1 } = historyThroughPlanQueries({
    ...RUN_ICP,
    planId: 'plan-1',
    ...AUTHORITY,
  });
  history.patch(QUERY_BATCH_PATCH, task1);
  history.activity(task1, 'executeQuery', queryInput(0), '900s', { result: QUERY_RESULT(0) });
  history.activity(task1, 'executeQuery', queryInput(1), '900s', { failure: lastQueryAttempt });
  return { history, task: history.workflowTask() };
}

/** A run recorded with discoveryQueryBatchSize=3: all three queries leave in one workflow task. */
function historyThroughTripleQueryBatch(): { history: DiscoveryHistory; task: string } {
  const history = new DiscoveryHistory({
    ...RUN_ICP,
    planId: 'plan-1',
    discoveryQueryBatchSize: 3,
    ...AUTHORITY,
  });
  let task = history.workflowTask();
  for (const patchId of PRE_QUERY_PATCHES) history.patch(patchId, task);
  history.activity(task, 'loadPlanQueries', { workspaceId: WORKSPACE, planId: 'plan-1', ...AUTHORITY }, '120s', {
    result: { queries: TRIPLE_QUERIES },
  });
  task = history.workflowTask();
  history.patch(QUERY_BATCH_PATCH, task);
  history.activity(task, 'executeQuery', queryInput(0, TRIPLE_QUERIES), '900s', { result: QUERY_RESULT(0) });
  history.activity(task, 'executeQuery', queryInput(1, TRIPLE_QUERIES), '900s', { result: QUERY_RESULT(1) });
  history.activity(task, 'executeQuery', queryInput(2, TRIPLE_QUERIES), '900s', { failure: lastQueryAttempt });
  return { history, task: history.workflowTask() };
}

function finishQueryFailure(history: DiscoveryHistory, task: string): void {
  history.patch(QUERY_FAILURE_STOP_PATCH, task);
  history.patch(FAILURE_FINALIZE_PATCH, task);
  history.activity(task, 'finalizeRun', FAILED_FINALIZE_INPUT, '120s', { result: undefined });
  history.workflowFailed(history.workflowTask(), queryFailure());
}

describe('discovery workflow knob replay (B1/L01)', () => {
  let workflowBundle: WorkflowBundle;

  beforeAll(async () => {
    workflowBundle = await bundleWorkflowCode({
      workflowsPath: resolve(import.meta.dirname, 'workflows.ts'),
    });
  }, 180_000);

  it('replays an in-flight history recorded without the knob fields on the frozen defaults', async () => {
    const { history, task } = historyThroughConcurrentQueryBatch();
    finishQueryFailure(history, task);

    await Worker.runReplayHistory({ workflowBundle }, { events: history.events }, 'legacy-no-knobs');
  }, 120_000);

  it('replays a history recorded with discoveryQueryBatchSize=3 through its one-task triple query scheduling', async () => {
    const { history, task } = historyThroughTripleQueryBatch();
    finishQueryFailure(history, task);

    await Worker.runReplayHistory({ workflowBundle }, { events: history.events }, 'batch-size-three');
  }, 120_000);

  function quickScanStart(
    startInput: Record<string, unknown>,
    candidates = 10,
  ): {
    history: DiscoveryHistory;
    task: string;
  } {
    const history = new DiscoveryHistory(startInput);
    const task = history.workflowTask();
    for (const patchId of PRE_QUERY_PATCHES) history.patch(patchId, task);
    history.activity(
      task,
      'prefilterPool',
      { ...RUN_ICP, ...AUTHORITY },
      '120s',
      { result: { poolSize: candidates + 20, candidates, prefilteredOut: 20 } },
    );
    return { history, task: history.workflowTask() };
  }

  /** The quick-scan stage activities shared by the two scenarios below, each awaited in its own workflow task. */
  function runQuickScanThroughDeepTargets(history: DiscoveryHistory, task: string): string {
    const phase = (value: string) => ({ workspaceId: WORKSPACE, runId: 'run-1', phase: value });
    history.activity(task, 'markRunPhase', phase('quick_started'), '120s', { result: undefined });
    task = history.workflowTask();
    history.activity(task, 'quickJudgeBatch', { ...RUN_ICP, ...AUTHORITY }, '900s', {
      result: { judged: 10, verdicts: { match: 4, weak: 6 }, fallbackPerCompany: 0, ruleFallback: 0, failed: 0, skipped: 0 },
    });
    task = history.workflowTask();
    history.activity(task, 'materializeProvisionalLeads', { ...RUN_ICP, ...AUTHORITY }, '120s', {
      result: { leads: 10 },
    });
    task = history.workflowTask();
    history.activity(task, 'markRunPhase', phase('quick_done'), '120s', { result: undefined });
    task = history.workflowTask();
    return task;
  }

  function finishDeepRun(history: DiscoveryHistory, task: string): void {
    const phase = (value: string) => ({ workspaceId: WORKSPACE, runId: 'run-1', phase: value });
    history.activity(task, 'deepStageSummary', RUN, '120s', {
      result: { done: 0, failed: 0, skipped: 0, remaining: 0 },
    });
    task = history.workflowTask();
    history.activity(task, 'markRunPhase', phase('deep_done'), '120s', { result: undefined });
    task = history.workflowTask();
    history.activity(task, 'runElapsedMinutes', RUN, '120s', { result: { minutes: 5 } });
    task = history.workflowTask();
    history.activity(
      task,
      'finalizeRun',
      { ...RUN_ICP, planId: 'plan-1', status: 'DONE', stats: {}, ...AUTHORITY },
      '120s',
      { result: undefined },
    );
    history.workflowCompleted(history.workflowTask(), undefined);
  }

  it('replays a pre-knob quick-scan history (no threshold field) on the frozen default 20', async () => {
    // 25 个候选 < 冻结默认 20 为假 → 不搜索。默认值一旦被改大（如 30），重放会调度
    // loadPlanQueries 而与历史不符 → 本用例转红。
    const { history, task: throughQuickDone } = quickScanStart(
      {
        ...RUN_ICP,
        planId: 'plan-1',
        run2QuickScan: true,
        ...AUTHORITY,
      },
      25,
    );
    let task = runQuickScanThroughDeepTargets(history, throughQuickDone);
    const phase = (value: string) => ({ workspaceId: WORKSPACE, runId: 'run-1', phase: value });
    history.activity(task, 'listDeepTargets', RUN, '120s', { result: { companyIds: [] } });
    task = history.workflowTask();
    history.activity(task, 'markRunPhase', phase('deep_started'), '120s', { result: undefined });
    task = history.workflowTask();
    history.patch(DEEP_STAGE_LABEL_PATCH, task);
    finishDeepRun(history, task);

    await Worker.runReplayHistory({ workflowBundle }, { events: history.events }, 'legacy-quick-scan');
  }, 120_000);

  it('replays a quick-scan history recorded with a lower pool threshold past where the default would search', async () => {
    const { history, task: throughQuickDone } = quickScanStart({
      ...RUN_ICP,
      planId: 'plan-1',
      run2QuickScan: true,
      run2PoolSearchFallbackThreshold: 5,
      ...AUTHORITY,
    });
    let task = runQuickScanThroughDeepTargets(history, throughQuickDone);
    const phase = (value: string) => ({ workspaceId: WORKSPACE, runId: 'run-1', phase: value });
    history.activity(task, 'listDeepTargets', RUN, '120s', { result: { companyIds: [] } });
    task = history.workflowTask();
    history.activity(task, 'markRunPhase', phase('deep_started'), '120s', { result: undefined });
    task = history.workflowTask();
    history.patch(DEEP_STAGE_LABEL_PATCH, task);
    finishDeepRun(history, task);

    await Worker.runReplayHistory({ workflowBundle }, { events: history.events }, 'threshold-five');
  }, 120_000);

  it('replays a quick-scan history recorded with deepCompanyConcurrency=1 past where the default would start a second child', async () => {
    const { history, task: throughQuickDone } = quickScanStart({
      ...RUN_ICP,
      planId: 'plan-1',
      run2QuickScan: true,
      run2PoolSearchFallbackThreshold: 5,
      deepCompanyConcurrency: 1,
      ...AUTHORITY,
    });
    let task = runQuickScanThroughDeepTargets(history, throughQuickDone);
    const phase = (value: string) => ({ workspaceId: WORKSPACE, runId: 'run-1', phase: value });
    history.activity(task, 'listDeepTargets', RUN, '120s', { result: { companyIds: ['c1', 'c2'] } });
    task = history.workflowTask();
    history.activity(task, 'markRunPhase', phase('deep_started'), '120s', { result: undefined });
    task = history.workflowTask();
    history.patch(DEEP_STAGE_LABEL_PATCH, task);
    history.childWorkflow(task, 'discovery-run-1-company-c1', { stage: 'done' });
    task = history.workflowTask();
    history.childWorkflow(task, 'discovery-run-1-company-c2', { stage: 'done' });
    task = history.workflowTask();
    history.activity(task, 'deepStageSummary', RUN, '120s', {
      result: { done: 2, failed: 0, skipped: 0, remaining: 0 },
    });
    task = history.workflowTask();
    history.activity(task, 'markRunPhase', phase('deep_done'), '120s', { result: undefined });
    task = history.workflowTask();
    history.activity(task, 'runElapsedMinutes', RUN, '120s', { result: { minutes: 5 } });
    task = history.workflowTask();
    history.activity(
      task,
      'finalizeRun',
      { ...RUN_ICP, planId: 'plan-1', status: 'DONE', stats: {}, ...AUTHORITY },
      '120s',
      { result: undefined },
    );
    history.workflowCompleted(history.workflowTask(), undefined);

    await Worker.runReplayHistory({ workflowBundle }, { events: history.events }, 'concurrency-one');
  }, 120_000);
});
