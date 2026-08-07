import { describe, expect, it, vi } from "vitest";
import {
  ACQUISITION_TASK_QUEUE,
  LEGACY_TASK_QUEUE,
  MAINTENANCE_TASK_QUEUE,
  SITE_BUILDER_TASK_QUEUE,
  WORKER_DOMAINS,
  parseBoundedIntervalMs,
  parseWorkerConcurrency,
  runWorkerFleet,
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

  it("bounds heartbeat and schedule observation intervals without accepting whitespace coercion", () => {
    expect(
      parseBoundedIntervalMs(undefined, "HEARTBEAT", 15_000, 5_000, 60_000),
    ).toBe(15_000);
    expect(
      parseBoundedIntervalMs("300000", "SCHEDULE", 60_000, 60_000, 3_600_000),
    ).toBe(300_000);
    expect(() =>
      parseBoundedIntervalMs(" 15000 ", "HEARTBEAT", 15_000, 5_000, 60_000),
    ).toThrow("INVALID_WORKER_INTERVAL:HEARTBEAT");
    expect(() =>
      parseBoundedIntervalMs("0", "HEARTBEAT", 15_000, 5_000, 60_000),
    ).toThrow("INVALID_WORKER_INTERVAL:HEARTBEAT");
  });

  it("shuts down the rest of the fleet when one worker exits fatally", async () => {
    let rejectFatal!: (error: Error) => void;
    let resolvePeer!: () => void;
    const fatalRun = new Promise<void>((_resolve, reject) => {
      rejectFatal = reject;
    });
    const peerRun = new Promise<void>((resolve) => {
      resolvePeer = resolve;
    });
    const fatal = { run: () => fatalRun, shutdown: vi.fn() };
    const peer = { run: () => peerRun, shutdown: vi.fn(resolvePeer) };
    const running = runWorkerFleet([fatal, peer]);

    rejectFatal(new Error("fatal poller error"));

    await expect(running).rejects.toThrow("fatal poller error");
    expect(fatal.shutdown).toHaveBeenCalledTimes(1);
    expect(peer.shutdown).toHaveBeenCalledTimes(1);
  });
});
