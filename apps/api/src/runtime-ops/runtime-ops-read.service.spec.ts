import { describe, expect, it, vi } from "vitest";
import { RuntimeOpsReadService } from "./runtime-ops-read.service";

const NOW = new Date("2026-08-07T12:00:00.000Z");

function fakeDb() {
  return {
    workerHeartbeat: {
      findMany: vi.fn().mockResolvedValue([
        {
          taskQueue: "acquisition",
          status: "POLLING",
          lastSeenAt: new Date(NOW.getTime() - 4_000),
          workerBuildSha: "b".repeat(40),
        },
        {
          taskQueue: "acquisition",
          status: "POLLING",
          lastSeenAt: new Date(NOW.getTime() - 5_000),
          workerBuildSha: "a".repeat(40),
        },
        {
          taskQueue: "site-builder",
          status: "POLLING",
          lastSeenAt: new Date(NOW.getTime() - 90_000),
          workerBuildSha: "a".repeat(40),
        },
      ]),
    },
    scheduleDriftReceipt: {
      findMany: vi.fn().mockResolvedValue([
        {
          scheduleId: "acq-sweep",
          disposition: "IN_SYNC",
          recordedAt: new Date(NOW.getTime() - 1_000),
          paused: false,
          nextActionAt: new Date(NOW.getTime() + 60_000),
          missedCatchupCount: 0,
          skippedOverlapCount: 0,
        },
        {
          scheduleId: "acq-sweep",
          disposition: "FAILED",
          recordedAt: new Date(NOW.getTime() - 2_000),
          paused: false,
          nextActionAt: new Date(NOW.getTime() - 60_000),
          missedCatchupCount: 0,
          skippedOverlapCount: 0,
        },
        {
          scheduleId: "intent-sweep",
          disposition: "FAILED",
          recordedAt: new Date(NOW.getTime() - 1_000),
          paused: true,
          nextActionAt: null,
          missedCatchupCount: 2,
          skippedOverlapCount: 1,
        },
      ]),
    },
    workflowRunReceipt: {
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        where.phase === "FAILED" ? 2 : 1,
      ),
    },
    signalIngest: {
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.status === "ERROR") return 3;
        if ((where.leaseExpiresAt as { lt?: Date } | undefined)?.lt) return 1;
        if (where.status === "PENDING") return 2;
        return 0;
      }),
    },
  };
}

describe("RuntimeOpsReadService", () => {
  it("returns only aggregate, non-PII health data and distinguishes stale worker heartbeats", async () => {
    const snapshot = await new RuntimeOpsReadService(fakeDb() as never, {
      expectedTaskQueues: [
        "acquisition",
        "site-builder",
        "maintenance",
        "understanding",
      ],
      expectedWorkerBuildSha: "a".repeat(40),
      expectedScheduleIds: ["acq-sweep", "intent-sweep", "backlog-sweep"],
      heartbeatFreshnessMs: 30_000,
      scheduleLatenessToleranceMs: 30_000,
      scheduleObservationFreshnessMs: 10 * 60_000,
    }).snapshot(NOW);

    expect(snapshot).toEqual({
      observedAt: NOW.toISOString(),
      workers: {
        expected: 4,
        polling: 1,
        stale: 1,
        missing: ["maintenance", "understanding"],
        buildShas: ["a".repeat(40), "b".repeat(40)],
        unexpectedBuildShas: ["b".repeat(40)],
      },
      schedules: {
        expected: 3,
        tracked: 2,
        missing: ["backlog-sweep"],
        drifted: ["intent-sweep"],
        paused: ["intent-sweep"],
        late: [],
        staleEvidence: [],
        unobservable: [],
        missedCatchup: ["intent-sweep"],
        skippedOverlap: ["intent-sweep"],
      },
      workflows: { recentFailed: 2, recentBudgetTruncated: 1 },
      signalIngest: { pending: 2, expiredLeases: 1, errors: 3 },
      ready: false,
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/@|token|payload|args/i);
  });

  it("is ready only when every expected queue and schedule is current and healthy", async () => {
    const db = fakeDb();
    db.workerHeartbeat.findMany.mockResolvedValue(
      ["acquisition", "site-builder", "maintenance", "understanding"].map(
        (taskQueue) => ({
          taskQueue,
          status: "POLLING",
          lastSeenAt: new Date(NOW.getTime() - 1_000),
          workerBuildSha: "a".repeat(40),
        }),
      ),
    );
    db.scheduleDriftReceipt.findMany.mockResolvedValue(
      ["acq-sweep", "intent-sweep"].map((scheduleId) => ({
        scheduleId,
        disposition: "IN_SYNC",
        recordedAt: new Date(NOW.getTime() - 1_000),
        paused: false,
        nextActionAt: new Date(NOW.getTime() + 60_000),
        missedCatchupCount: 0,
        skippedOverlapCount: 0,
      })),
    );
    db.workflowRunReceipt.count.mockResolvedValue(0);
    db.signalIngest.count.mockResolvedValue(0);

    const snapshot = await new RuntimeOpsReadService(db as never, {
      expectedTaskQueues: [
        "acquisition",
        "site-builder",
        "maintenance",
        "understanding",
      ],
      expectedWorkerBuildSha: "a".repeat(40),
      expectedScheduleIds: ["acq-sweep", "intent-sweep"],
      heartbeatFreshnessMs: 30_000,
      scheduleLatenessToleranceMs: 30_000,
      scheduleObservationFreshnessMs: 10 * 60_000,
    }).snapshot(NOW);

    expect(snapshot.ready).toBe(true);
    expect(snapshot.workers.unexpectedBuildShas).toEqual([]);
    expect(snapshot.schedules.missing).toEqual([]);
    expect(snapshot.schedules.unobservable).toEqual([]);
  });

  it("fails readiness when the last persisted Temporal observation is stale", async () => {
    const db = fakeDb();
    db.workerHeartbeat.findMany.mockResolvedValue(
      ["acquisition", "site-builder", "maintenance", "understanding"].map(
        (taskQueue) => ({
          taskQueue,
          status: "POLLING",
          lastSeenAt: new Date(NOW.getTime() - 1_000),
          workerBuildSha: "a".repeat(40),
        }),
      ),
    );
    db.scheduleDriftReceipt.findMany.mockResolvedValue([
      {
        scheduleId: "acq-sweep",
        disposition: "IN_SYNC",
        recordedAt: new Date(NOW.getTime() - 11 * 60_000),
        paused: false,
        nextActionAt: new Date(NOW.getTime() + 60_000),
        missedCatchupCount: 0,
        skippedOverlapCount: 0,
      },
    ]);
    db.workflowRunReceipt.count.mockResolvedValue(0);
    db.signalIngest.count.mockResolvedValue(0);

    const snapshot = await new RuntimeOpsReadService(db as never, {
      expectedTaskQueues: [
        "acquisition",
        "site-builder",
        "maintenance",
        "understanding",
      ],
      expectedWorkerBuildSha: "a".repeat(40),
      expectedScheduleIds: ["acq-sweep"],
      heartbeatFreshnessMs: 30_000,
      scheduleLatenessToleranceMs: 30_000,
      scheduleObservationFreshnessMs: 10 * 60_000,
    }).snapshot(NOW);

    expect(snapshot.schedules.staleEvidence).toEqual(["acq-sweep"]);
    expect(snapshot.ready).toBe(false);
  });
});
