import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import {
  ActivityFailure,
  ApplicationFailure,
  defaultFailureConverter,
  defaultPayloadConverter,
} from "@temporalio/common";
import { temporal } from "@temporalio/proto";
import { loadDataConverter } from "@temporalio/common/lib/internal-non-workflow/data-converter-helpers";
import { bundleWorkflowCode, Runtime, Worker } from "@temporalio/worker";

const compiledConverter = resolve(
  import.meta.dirname,
  "../../dist/temporal/diagnostic-failure-converter.js",
);
let sharedBundle: ReturnType<typeof bundleWorkflowCode> | undefined;
function workflowBundle() {
  return (sharedBundle ??= bundleWorkflowCode({
    workflowsPath: resolve(
      import.meta.dirname,
      "testing/failure-boundary.workflow.ts",
    ),
    failureConverterPath: compiledConverter,
  }));
}
const queue = { name: "failure-boundary-replay" };
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
function event(id: number, kind: string, field: string, attributes: object) {
  return {
    eventId: String(id),
    eventTime: "2026-09-01T00:00:00Z",
    eventType: `EVENT_TYPE_${kind}`,
    [field]: attributes,
  };
}
function taskEvents(id: number) {
  return [
    event(
      id,
      "WORKFLOW_TASK_SCHEDULED",
      "workflowTaskScheduledEventAttributes",
      { taskQueue: queue, startToCloseTimeout: "10s", attempt: 1 },
    ),
    event(
      id + 1,
      "WORKFLOW_TASK_STARTED",
      "workflowTaskStartedEventAttributes",
      {
        scheduledEventId: String(id),
        identity: "fixture",
        requestId: "22222222-2222-4222-8222-222222222222",
      },
    ),
    event(
      id + 2,
      "WORKFLOW_TASK_COMPLETED",
      "workflowTaskCompletedEventAttributes",
      {
        scheduledEventId: String(id),
        startedEventId: String(id + 1),
        identity: "fixture",
      },
    ),
  ];
}
function backlogHistory(hold: boolean) {
  const input = {
    workspaceId: "workspace",
    icpId: "icp",
    maxFitRounds: 1,
    maxEnrichRounds: 0,
    maxSignalRounds: 0,
    maxWatchRounds: 0,
    maxContactRounds: 0,
    maxGuessRounds: 0,
  };
  const cause = ApplicationFailure.nonRetryable(
    hold
      ? "EXECUTION_BUDGET_PLATFORM_AUTHORITY_REQUIRED"
      : "synthetic-history-secret",
    "Error",
    { diagnostic: "synthetic-history-secret" },
  );
  const events = [
    event(
      1,
      "WORKFLOW_EXECUTION_STARTED",
      "workflowExecutionStartedEventAttributes",
      {
        workflowType: { name: "backlogSweepWorkflow" },
        taskQueue: queue,
        input: { payloads: [payload(input)] },
        workflowTaskTimeout: "10s",
        originalExecutionRunId: "11111111-1111-4111-8111-111111111111",
        firstExecutionRunId: "11111111-1111-4111-8111-111111111111",
        attempt: 1,
      },
    ),
    ...taskEvents(2),
    event(
      5,
      "ACTIVITY_TASK_SCHEDULED",
      "activityTaskScheduledEventAttributes",
      {
        activityId: "1",
        activityType: { name: "qualifyFitBacklog" },
        taskQueue: queue,
        input: {
          payloads: [
            payload({
              workspaceId: "workspace",
              icpId: "icp",
              limit: 20,
              cursor: null,
            }),
          ],
        },
        startToCloseTimeout: "1800s",
        workflowTaskCompletedEventId: "4",
        retryPolicy: { maximumAttempts: 2 },
      },
    ),
    event(6, "ACTIVITY_TASK_STARTED", "activityTaskStartedEventAttributes", {
      scheduledEventId: "5",
      identity: "fixture",
      attempt: 1,
    }),
    event(7, "ACTIVITY_TASK_FAILED", "activityTaskFailedEventAttributes", {
      scheduledEventId: "5",
      startedEventId: "6",
      identity: "fixture",
      failure: failureJSON(cause),
      retryState: "RETRY_STATE_NON_RETRYABLE_FAILURE",
    }),
    ...taskEvents(8),
  ];
  if (hold) {
    events.push(
      event(
        11,
        "WORKFLOW_EXECUTION_FAILED",
        "workflowExecutionFailedEventAttributes",
        {
          workflowTaskCompletedEventId: "10",
          retryState: "RETRY_STATE_NON_RETRYABLE_FAILURE",
          failure: failureJSON(
            new ActivityFailure(
              "Activity task failed",
              "qualifyFitBacklog",
              "1",
              "NON_RETRYABLE_FAILURE",
              "fixture",
              cause,
            ),
          ),
        },
      ),
    );
  } else {
    const stats = {
      workspaceId: "workspace",
      icpId: "icp",
      fit: {
        scanned: 0,
        judged: 0,
        verdicts: { match: 0, weak: 0, mismatch: 0 },
        exhausted: false,
      },
      enrich: { scanned: 0, attempted: 0, matched: 0 },
      signals: { scanned: 0, attempted: 0, matched: 0 },
      watches: { scanned: 0, registered: 0 },
      contacts: { scanned: 0, attempted: 0, contactsCreated: 0 },
      guesses: { scanned: 0, attempted: 0, guessed: 0 },
      scored: 0,
    };
    events.push(
      event(
        11,
        "ACTIVITY_TASK_SCHEDULED",
        "activityTaskScheduledEventAttributes",
        {
          activityId: "2",
          activityType: { name: "scoreCandidates" },
          taskQueue: queue,
          input: {
            payloads: [payload({ workspaceId: "workspace", icpId: "icp" })],
          },
          startToCloseTimeout: "600s",
          workflowTaskCompletedEventId: "10",
          retryPolicy: { maximumAttempts: 3 },
        },
      ),
      event(12, "ACTIVITY_TASK_STARTED", "activityTaskStartedEventAttributes", {
        scheduledEventId: "11",
        identity: "fixture",
        attempt: 1,
      }),
      event(
        13,
        "ACTIVITY_TASK_COMPLETED",
        "activityTaskCompletedEventAttributes",
        {
          scheduledEventId: "11",
          startedEventId: "12",
          result: { payloads: [payload({ scored: 0 })] },
          identity: "fixture",
        },
      ),
      ...taskEvents(14),
      event(
        17,
        "WORKFLOW_EXECUTION_COMPLETED",
        "workflowExecutionCompletedEventAttributes",
        {
          workflowTaskCompletedEventId: "16",
          result: { payloads: [payload([stats])] },
        },
      ),
    );
  }
  return { events };
}

let replayStarted = false;
afterAll(async () => {
  if (replayStarted) await Runtime.instance().shutdown();
});

describe("compiled diagnostic converter integration", () => {
  it("uses the actual Worker.create data converter configuration to redact outgoing failures", () => {
    const workerPath = resolve(import.meta.dirname, "worker.ts");
    const source = ts.createSourceFile(
      workerPath,
      readFileSync(workerPath, "utf8"),
      ts.ScriptTarget.ESNext,
      true,
    );
    const creates: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(source) === "Worker" &&
        node.expression.name.text === "create"
      )
        creates.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(creates).toHaveLength(1);
    const options = creates[0]!.arguments[0]!;
    expect(ts.isObjectLiteralExpression(options)).toBe(true);
    const property = (options as ts.ObjectLiteralExpression).properties.find(
      (entry) => entry.name?.getText(source) === "dataConverter",
    );
    // Missing assembly deliberately exercises the SDK default and exposes the
    // canary. Only this pure source initializer executes; no Worker starts.
    const expression =
      property && ts.isPropertyAssignment(property)
        ? property.initializer.getText(source)
        : "{}";
    const configuration = runInNewContext(
      `(${expression})`,
      { require: createRequire(compiledConverter) },
      { timeout: 1000 },
    );
    const loaded = loadDataConverter(configuration);
    const proto = loaded.failureConverter.errorToFailure(
      ApplicationFailure.retryable("synthetic-history-secret", "Error"),
      loaded.payloadConverter,
    );
    expect(JSON.stringify(proto)).not.toContain("synthetic-history-secret");
    expect(configuration.failureConverterPath).toBe(compiledConverter);
    expect(
      loaded.payloadConverter.toPayload({ business: "unchanged" }),
    ).toEqual(defaultPayloadConverter.toPayload({ business: "unchanged" }));
    expect(loaded.payloadCodecs).toEqual([]);
  });

  it("loads the exact compiled named export through the SDK data converter loader", () => {
    const loaded = loadDataConverter({
      failureConverterPath: compiledConverter,
    });
    const failure = loaded.failureConverter.errorToFailure(
      ApplicationFailure.retryable("synthetic-history-secret", "Error"),
      loaded.payloadConverter,
    );
    expect(JSON.stringify(failure)).not.toContain("synthetic-history-secret");
    expect(
      loaded.payloadConverter.toPayload({ business: "unchanged" }),
    ).toEqual(defaultPayloadConverter.toPayload({ business: "unchanged" }));
    expect(loaded.payloadCodecs).toEqual([]);
  });

  it("bundles the production converter and replays a legacy failed history without a Temporal server", async () => {
    const bundle = await workflowBundle();
    expect(bundle.code).toContain("EXECUTION_CONTROL_FAILURE_REDACTED");
    const history = {
      events: [
        {
          eventId: "1",
          eventTime: "2026-09-01T00:00:00Z",
          eventType: "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED",
          workflowExecutionStartedEventAttributes: {
            workflowType: { name: "failureBoundaryReplayFixture" },
            taskQueue: { name: "failure-boundary-replay" },
            workflowTaskTimeout: "10s",
            originalExecutionRunId: "11111111-1111-4111-8111-111111111111",
            firstExecutionRunId: "11111111-1111-4111-8111-111111111111",
            attempt: 1,
          },
        },
        {
          eventId: "2",
          eventTime: "2026-09-01T00:00:00Z",
          eventType: "EVENT_TYPE_WORKFLOW_TASK_SCHEDULED",
          workflowTaskScheduledEventAttributes: {
            taskQueue: { name: "failure-boundary-replay" },
            startToCloseTimeout: "10s",
            attempt: 1,
          },
        },
        {
          eventId: "3",
          eventTime: "2026-09-01T00:00:01Z",
          eventType: "EVENT_TYPE_WORKFLOW_TASK_STARTED",
          workflowTaskStartedEventAttributes: {
            scheduledEventId: "2",
            identity: "fixture",
            requestId: "22222222-2222-4222-8222-222222222222",
          },
        },
        {
          eventId: "4",
          eventTime: "2026-09-01T00:00:02Z",
          eventType: "EVENT_TYPE_WORKFLOW_TASK_COMPLETED",
          workflowTaskCompletedEventAttributes: {
            scheduledEventId: "2",
            startedEventId: "3",
            identity: "fixture",
          },
        },
        {
          eventId: "5",
          eventTime: "2026-09-01T00:00:02Z",
          eventType: "EVENT_TYPE_WORKFLOW_EXECUTION_FAILED",
          workflowExecutionFailedEventAttributes: {
            workflowTaskCompletedEventId: "4",
            retryState: "RETRY_STATE_NON_RETRYABLE_FAILURE",
            failure: {
              message: "synthetic-history-secret",
              stackTrace: "synthetic-history-secret",
              applicationFailureInfo: {
                type: "INPUT_INVALID",
                nonRetryable: true,
              },
            },
          },
        },
      ],
    };
    replayStarted = true;
    await Worker.runReplayHistory(
      {
        workflowBundle: bundle,
        dataConverter: { failureConverterPath: compiledConverter },
      },
      history,
      "failure-boundary-replay",
    );
  }, 60_000);
  it.each([true, false])(
    "replays legacy ActivityFailed cause with backlog hold=%s",
    async (hold) => {
      const bundle = await workflowBundle();
      replayStarted = true;
      await Worker.runReplayHistory(
        {
          workflowBundle: bundle,
          dataConverter: { failureConverterPath: compiledConverter },
        },
        backlogHistory(hold),
        `backlog-legacy-${hold}`,
      );
    },
    60_000,
  );
});
