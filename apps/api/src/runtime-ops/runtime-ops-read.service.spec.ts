import { describe, expect, it, vi } from "vitest";
import { RuntimeOpsReadService } from "./runtime-ops-read.service";

const NOW = new Date("2026-08-07T12:00:00.000Z");

function fakeDb() {
  const heartbeatRows = [
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
  ];
  const scheduleRows = [
    {
      scheduleId: "acq-sweep",
      disposition: "IN_SYNC",
      desiredHash: "a".repeat(64),
      observedHash: "a".repeat(64),
      recordedAt: new Date(NOW.getTime() - 1_000),
      paused: false,
      nextActionAt: new Date(NOW.getTime() + 60_000),
      missedCatchupCount: 0,
      skippedOverlapCount: 0,
    },
    {
      scheduleId: "acq-sweep",
      disposition: "FAILED",
      desiredHash: "a".repeat(64),
      observedHash: "b".repeat(64),
      recordedAt: new Date(NOW.getTime() - 2_000),
      paused: false,
      nextActionAt: new Date(NOW.getTime() - 60_000),
      missedCatchupCount: 0,
      skippedOverlapCount: 0,
    },
    {
      scheduleId: "intent-sweep",
      disposition: "FAILED",
      desiredHash: "a".repeat(64),
      observedHash: null,
      recordedAt: new Date(NOW.getTime() - 1_000),
      paused: true,
      nextActionAt: null,
      missedCatchupCount: 2,
      skippedOverlapCount: 1,
    },
  ];
  const db = {
    workerHeartbeat: {
      findMany: vi.fn(async ({ where, take }: { where?: { taskQueue?: string }; take?: number }) =>
        heartbeatRows
          .filter((row) => !where?.taskQueue || row.taskQueue === where.taskQueue)
          .slice(0, take)),
    },
    scheduleDriftReceipt: {
      findMany: vi.fn(async ({ where, take }: { where?: { scheduleId?: string }; take?: number }) =>
        scheduleRows
          .filter((row) => !where?.scheduleId || row.scheduleId === where.scheduleId)
          .slice(0, take)),
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
    outboxEvent: {
      count: vi.fn().mockResolvedValue(4),
    },
    outboxDelivery: {
      count: vi.fn().mockResolvedValue(2),
    },
    acquisitionBudgetAccount: {
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        where.status === 'EXHAUSTED' ? 1 : 3,
      ),
    },
    acquisitionBudgetReservation: {
      count: vi.fn().mockResolvedValue(2),
    },
    sourcePolicy: {
      count: vi.fn().mockResolvedValue(5),
    },
  };
  return {
    ...db,
    withWorkspace: vi.fn(
      async (
        _workspaceId: string,
        callback: (transaction: typeof db) => Promise<unknown>,
      ) => callback(db),
    ),
  };
}

describe("RuntimeOpsReadService", () => {
  it('returns a closed workspace-scoped ops snapshot through withWorkspace', async () => {
    const db = fakeDb();
    const service = new RuntimeOpsReadService(db as never, {
      expectedTaskQueues: [
        'acquisition',
        'site-builder',
        'maintenance',
        'understanding',
      ],
      expectedWorkerBuildSha: 'a'.repeat(40),
      expectedScheduleIds: ['acq-sweep', 'intent-sweep', 'backlog-sweep'],
      heartbeatFreshnessMs: 30_000,
      scheduleLatenessToleranceMs: 30_000,
      scheduleObservationFreshnessMs: 10 * 60_000,
    });

    const snapshot = await service.snapshotForWorkspace(
      '11111111-1111-4111-8111-111111111111',
      NOW,
    );

    expect(db.withWorkspace).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      expect.any(Function),
    );
    expect(snapshot).toMatchObject({
      schemaVersion: 'runtime-ops/v1',
      observedAt: NOW.toISOString(),
      runtime: {
        status: 'DEGRADED',
        schedules: {
          expected: 3,
          tracked: 2,
          drifted: 1,
          paused: 1,
          missedCatchup: 1,
        },
        workflows: { failed24h: 2, budgetTruncated24h: 1 },
        signalIngest: { pending: 2, expiredLeases: 1, errors: 3 },
      },
      workspace: {
        outbox: { parked: 4, dead: 2 },
        acquisitionBudget: {
          exhausted: 1,
          frozen: 3,
          unknownSettlement: 2,
        },
      },
      global: { suspendedSourcePolicies: 5 },
      proof: {
        outboxRelay: 'UNVERIFIED',
        gatewayAdmission: 'UNVERIFIED',
        providerConsecutiveZeroResults: 'UNOBSERVABLE',
      },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(
      /11111111|scheduleId|workflowId|runId|eventId|accountId|reason|errorMessage|payload|@/iu,
    );
    expect(db.outboxEvent.count).toHaveBeenCalledWith({
      where: { parkedAt: { not: null } },
    });
    expect(db.outboxDelivery.count).toHaveBeenCalledWith({
      where: { status: 'DEAD' },
    });
    expect(db.acquisitionBudgetReservation.count).toHaveBeenCalledWith({
      where: { status: 'UNKNOWN' },
    });
    expect(db.workerHeartbeat.findMany).toHaveBeenCalledTimes(4);
    expect(db.workerHeartbeat.findMany).toHaveBeenCalledWith({
      where: { taskQueue: 'acquisition' },
      orderBy: { lastSeenAt: 'desc' },
      take: 64,
      select: {
        taskQueue: true,
        status: true,
        lastSeenAt: true,
        workerBuildSha: true,
      },
    });
    expect(db.scheduleDriftReceipt.findMany).toHaveBeenCalledTimes(3);
    expect(db.scheduleDriftReceipt.findMany).toHaveBeenCalledWith({
      where: { scheduleId: 'acq-sweep' },
      orderBy: { recordedAt: 'desc' },
      take: 2,
      select: {
        scheduleId: true,
        disposition: true,
        desiredHash: true,
        observedHash: true,
        recordedAt: true,
        paused: true,
        nextActionAt: true,
        missedCatchupCount: true,
        skippedOverlapCount: true,
      },
    });
  });

  it('rejects a non-token-shaped workspace before opening an RLS transaction', async () => {
    const db = fakeDb();
    const service = new RuntimeOpsReadService(db as never, {
      expectedTaskQueues: ['acquisition'],
      expectedWorkerBuildSha: 'a'.repeat(40),
      expectedScheduleIds: ['acq-sweep'],
      heartbeatFreshnessMs: 30_000,
      scheduleLatenessToleranceMs: 30_000,
      scheduleObservationFreshnessMs: 10 * 60_000,
    });

    await expect(
      service.snapshotForWorkspace('spoofed-workspace', NOW),
    ).rejects.toThrow('INVALID_RUNTIME_OPS_WORKSPACE');
    expect(db.withWorkspace).not.toHaveBeenCalled();
  });

  it('performs every workspace and global aggregate through the RLS transaction client', async () => {
    const scoped = fakeDb();
    const unscopedRead = vi.fn().mockRejectedValue(new Error('UNSCOPED_READ'));
    const root = {
      workerHeartbeat: { findMany: unscopedRead },
      scheduleDriftReceipt: { findMany: unscopedRead },
      workflowRunReceipt: { count: unscopedRead },
      signalIngest: { count: unscopedRead },
      outboxEvent: { count: unscopedRead },
      outboxDelivery: { count: unscopedRead },
      acquisitionBudgetAccount: { count: unscopedRead },
      acquisitionBudgetReservation: { count: unscopedRead },
      sourcePolicy: { count: unscopedRead },
      withWorkspace: vi.fn(
        async (
          _workspaceId: string,
          callback: (transaction: typeof scoped) => Promise<unknown>,
        ) => callback(scoped),
      ),
    };
    const service = new RuntimeOpsReadService(root as never, {
      expectedTaskQueues: [
        'acquisition',
        'site-builder',
        'maintenance',
        'understanding',
      ],
      expectedWorkerBuildSha: 'a'.repeat(40),
      expectedScheduleIds: ['acq-sweep', 'intent-sweep', 'backlog-sweep'],
      heartbeatFreshnessMs: 30_000,
      scheduleLatenessToleranceMs: 30_000,
      scheduleObservationFreshnessMs: 10 * 60_000,
    });

    await expect(
      service.snapshotForWorkspace(
        '11111111-1111-4111-8111-111111111111',
        NOW,
      ),
    ).resolves.toMatchObject({ schemaVersion: 'runtime-ops/v1' });
    expect(unscopedRead).not.toHaveBeenCalled();
  });

  it('reports UNVERIFIED rather than healthy while relay and gateway proof sources are absent', async () => {
    const db = fakeDb();
    db.workerHeartbeat.findMany.mockResolvedValue([
      {
        taskQueue: 'acquisition',
        status: 'POLLING',
        lastSeenAt: new Date(NOW.getTime() - 1_000),
        workerBuildSha: 'a'.repeat(40),
      },
    ]);
    db.scheduleDriftReceipt.findMany.mockResolvedValue([
      {
        scheduleId: 'acq-sweep',
        disposition: 'IN_SYNC',
        desiredHash: 'a'.repeat(64),
        observedHash: 'a'.repeat(64),
        recordedAt: new Date(NOW.getTime() - 1_000),
        paused: false,
        nextActionAt: new Date(NOW.getTime() + 60_000),
        missedCatchupCount: 0,
        skippedOverlapCount: 0,
      },
    ]);
    db.workflowRunReceipt.count.mockResolvedValue(0);
    db.signalIngest.count.mockResolvedValue(0);
    db.outboxEvent.count.mockResolvedValue(0);
    db.outboxDelivery.count.mockResolvedValue(0);
    db.acquisitionBudgetAccount.count.mockResolvedValue(0);
    db.acquisitionBudgetReservation.count.mockResolvedValue(0);
    db.sourcePolicy.count.mockResolvedValue(0);
    const service = new RuntimeOpsReadService(db as never, {
      expectedTaskQueues: ['acquisition'],
      expectedWorkerBuildSha: 'a'.repeat(40),
      expectedScheduleIds: ['acq-sweep'],
      heartbeatFreshnessMs: 30_000,
      scheduleLatenessToleranceMs: 30_000,
      scheduleObservationFreshnessMs: 10 * 60_000,
    });

    const snapshot = await service.snapshotForWorkspace(
      '11111111-1111-4111-8111-111111111111',
      NOW,
    );
    expect(snapshot.runtime.status).toBe('UNVERIFIED');
    expect(snapshot.proof).toEqual({
      outboxRelay: 'UNVERIFIED',
      gatewayAdmission: 'UNVERIFIED',
      providerConsecutiveZeroResults: 'UNOBSERVABLE',
    });
  });

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
        queueStates: [
          { taskQueue: 'acquisition', state: 'BUILD_MISMATCH' },
          { taskQueue: 'site-builder', state: 'STALE' },
          { taskQueue: 'maintenance', state: 'MISSING' },
          { taskQueue: 'understanding', state: 'MISSING' },
        ],
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
        desiredHash: "a".repeat(64),
        observedHash: "a".repeat(64),
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
        desiredHash: "a".repeat(64),
        observedHash: "a".repeat(64),
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

  it("does not treat a RECONCILED receipt with a pre-repair hash as healthy", async () => {
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
        disposition: "RECONCILED",
        desiredHash: "a".repeat(64),
        observedHash: "b".repeat(64),
        recordedAt: new Date(NOW.getTime() - 1_000),
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

    expect(snapshot.schedules.drifted).toEqual(["acq-sweep"]);
    expect(snapshot.ready).toBe(false);
  });
});
