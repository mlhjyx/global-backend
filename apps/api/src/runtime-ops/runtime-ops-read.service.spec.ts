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
        },
        {
          scheduleId: "acq-sweep",
          disposition: "FAILED",
          recordedAt: new Date(NOW.getTime() - 2_000),
        },
        {
          scheduleId: "intent-sweep",
          disposition: "FAILED",
          recordedAt: new Date(NOW.getTime() - 1_000),
        },
      ]),
    },
    workflowRunReceipt: {
      count: vi.fn(async ({ where }: any) =>
        where.phase === "FAILED" ? 2 : 1,
      ),
    },
    signalIngest: {
      count: vi.fn(async ({ where }: any) => {
        if (where.status === "ERROR") return 3;
        if (where.leaseExpiresAt?.lt) return 1;
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
      heartbeatFreshnessMs: 30_000,
    }).snapshot(NOW);

    expect(snapshot).toEqual({
      observedAt: NOW.toISOString(),
      workers: {
        expected: 4,
        polling: 1,
        stale: 1,
        missing: ["maintenance", "understanding"],
        buildShas: ["a".repeat(40)],
      },
      schedules: { tracked: 2, drifted: ["intent-sweep"] },
      workflows: { recentFailed: 2, recentBudgetTruncated: 1 },
      signalIngest: { pending: 2, expiredLeases: 1, errors: 3 },
      ready: false,
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/@|token|payload|args/i);
  });
});
