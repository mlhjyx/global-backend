import { describe, expect, it } from "vitest";
import {
  ACQUISITION_TASK_QUEUE,
  LEGACY_TASK_QUEUE,
  MAINTENANCE_TASK_QUEUE,
  SITE_BUILDER_TASK_QUEUE,
  WORKER_DOMAINS,
  parseWorkerConcurrency,
  taskQueueForWorkflow,
} from "./worker-topology";

describe("worker topology", () => {
  it("routes every newly-started workflow to a bounded domain queue while retaining the legacy poller", () => {
    expect(new Set(WORKER_DOMAINS.map((domain) => domain.taskQueue)).size).toBe(
      4,
    );
    expect(WORKER_DOMAINS.map((domain) => domain.taskQueue)).toEqual([
      LEGACY_TASK_QUEUE,
      ACQUISITION_TASK_QUEUE,
      SITE_BUILDER_TASK_QUEUE,
      MAINTENANCE_TASK_QUEUE,
    ]);

    expect(taskQueueForWorkflow("understandingWorkflow")).toBe(
      ACQUISITION_TASK_QUEUE,
    );
    expect(taskQueueForWorkflow("externalIntentSweepWorkflow")).toBe(
      ACQUISITION_TASK_QUEUE,
    );
    expect(taskQueueForWorkflow("demoV0Workflow")).toBe(
      SITE_BUILDER_TASK_QUEUE,
    );
    expect(taskQueueForWorkflow("kbRecoverySweepWorkflow")).toBe(
      SITE_BUILDER_TASK_QUEUE,
    );
    expect(taskQueueForWorkflow("deletionWorkflow")).toBe(
      MAINTENANCE_TASK_QUEUE,
    );
    expect(taskQueueForWorkflow("siteReleaseMaintenanceSweepWorkflow")).toBe(
      MAINTENANCE_TASK_QUEUE,
    );
  });

  it("does not silently route unknown workflow types to a paid or privileged queue", () => {
    expect(() => taskQueueForWorkflow("unregisteredWorkflow")).toThrow(
      "UNREGISTERED_WORKFLOW_TASK_QUEUE",
    );
  });

  it("uses finite defaults and accepts an explicit bounded integer concurrency budget", () => {
    expect(
      parseWorkerConcurrency(undefined, "ACQUISITION_WORKER_CONCURRENCY", 8),
    ).toBe(8);
    expect(
      parseWorkerConcurrency("12", "ACQUISITION_WORKER_CONCURRENCY", 8),
    ).toBe(12);
  });

  it.each(["0", "-1", "1.5", "NaN", "65", " 8 "])(
    "rejects invalid or ambiguous concurrency value %s",
    (value) => {
      expect(() =>
        parseWorkerConcurrency(value, "ACQUISITION_WORKER_CONCURRENCY", 8),
      ).toThrow("INVALID_WORKER_CONCURRENCY");
    },
  );
});
