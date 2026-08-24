import { resolve } from "node:path";
import {
  Worker,
  bundleWorkflowCode,
  defaultPayloadConverter,
  type WorkflowBundle,
} from "@temporalio/worker";
import { beforeAll, describe, it } from "vitest";

function payload(value: unknown) {
  const converted = defaultPayloadConverter.toPayload(value)!;
  return {
    metadata: {
      encoding: Buffer.from(converted.metadata.encoding).toString("base64"),
    },
    data: Buffer.from(converted.data!).toString("base64"),
  };
}

function legacyHistory(input: {
  workflowType: string;
  workflowInput: unknown;
  activityType: string;
  activityInput?: unknown;
  startToCloseTimeout: string;
}) {
  const eventTime = "2026-08-21T00:00:00Z";
  const taskQueue = {
    name: "platform-authority-replay",
    kind: "TASK_QUEUE_KIND_NORMAL",
  };
  const activityInput =
    input.activityInput === undefined
      ? {}
      : { input: { payloads: [payload(input.activityInput)] } };
  return {
    events: [
      {
        eventId: "1",
        eventTime,
        eventType: "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED",
        taskId: "1",
        workflowExecutionStartedEventAttributes: {
          workflowType: { name: input.workflowType },
          taskQueue,
          input: { payloads: [payload(input.workflowInput)] },
          workflowExecutionTimeout: "0s",
          workflowRunTimeout: "0s",
          workflowTaskTimeout: "10s",
          originalExecutionRunId: "00000000-0000-4000-8000-000000000001",
          firstExecutionRunId: "00000000-0000-4000-8000-000000000001",
          identity: "legacy-worker",
          attempt: 1,
          firstWorkflowTaskBackoff: "0s",
        },
      },
      {
        eventId: "2",
        eventTime,
        eventType: "EVENT_TYPE_WORKFLOW_TASK_SCHEDULED",
        taskId: "2",
        workflowTaskScheduledEventAttributes: {
          taskQueue,
          startToCloseTimeout: "10s",
          attempt: 1,
        },
      },
      {
        eventId: "3",
        eventTime,
        eventType: "EVENT_TYPE_WORKFLOW_TASK_STARTED",
        taskId: "3",
        workflowTaskStartedEventAttributes: {
          scheduledEventId: "2",
          identity: "legacy-worker",
          requestId: "00000000-0000-4000-8000-000000000002",
          historySizeBytes: "0",
        },
      },
      {
        eventId: "4",
        eventTime,
        eventType: "EVENT_TYPE_WORKFLOW_TASK_COMPLETED",
        taskId: "4",
        workflowTaskCompletedEventAttributes: {
          scheduledEventId: "2",
          startedEventId: "3",
          identity: "legacy-worker",
          sdkMetadata: { coreUsedFlags: [1, 2, 3] },
          meteringMetadata: {},
        },
      },
      {
        eventId: "5",
        eventTime,
        eventType: "EVENT_TYPE_ACTIVITY_TASK_SCHEDULED",
        taskId: "5",
        activityTaskScheduledEventAttributes: {
          activityId: "1",
          activityType: { name: input.activityType },
          taskQueue,
          header: {},
          ...activityInput,
          scheduleToCloseTimeout: "0s",
          scheduleToStartTimeout: "0s",
          startToCloseTimeout: input.startToCloseTimeout,
          heartbeatTimeout: "0s",
          workflowTaskCompletedEventId: "4",
          retryPolicy: {
            initialInterval: "1s",
            backoffCoefficient: 2,
            maximumInterval: "100s",
            maximumAttempts: 2,
            nonRetryableErrorTypes: [],
          },
          useWorkflowBuildId: true,
        },
      },
    ],
  };
}

describe("platform schedule authority old-history replay", () => {
  let workflowBundle: WorkflowBundle;

  beforeAll(async () => {
    workflowBundle = await bundleWorkflowCode({
      workflowsPath: resolve(process.cwd(), "src/temporal/workflows.ts"),
    });
  }, 30_000);

  for (const fixture of [
    {
      workflowType: "acquisitionSweepWorkflow",
      workflowInput: { limit: 7 },
      activityType: "listDueSources",
      activityInput: { limit: 7 },
      startToCloseTimeout: "300s",
    },
    {
      workflowType: "intentSweepWorkflow",
      workflowInput: { limit: 9 },
      activityType: "purgeStaleIntentEvents",
      activityInput: {},
      startToCloseTimeout: "600s",
    },
    {
      workflowType: "sanctionsRefreshWorkflow",
      workflowInput: {},
      activityType: "refreshSanctionsLists",
      activityInput: undefined,
      startToCloseTimeout: "900s",
    },
    {
      workflowType: "patentsCacheRefreshWorkflow",
      workflowInput: { maxAnchors: 11 },
      activityType: "refreshPatentCacheActivity",
      activityInput: { maxAnchors: 11 },
      startToCloseTimeout: "900s",
    },
  ]) {
    it(`replays the pre-authority ${fixture.workflowType} first command`, async () => {
      await Worker.runReplayHistory(
        { workflowBundle },
        legacyHistory(fixture),
        `legacy-${fixture.workflowType}`,
      );
    }, 30_000);
  }
});
