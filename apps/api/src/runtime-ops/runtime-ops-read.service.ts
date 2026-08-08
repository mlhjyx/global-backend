import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

const WORKSPACE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RuntimeOpsDelegate =
  | 'workerHeartbeat'
  | 'scheduleDriftReceipt'
  | 'workflowRunReceipt'
  | 'signalIngest'
  | 'outboxEvent'
  | 'outboxDelivery'
  | 'acquisitionBudgetAccount'
  | 'acquisitionBudgetReservation'
  | 'sourcePolicy';

type RuntimeOpsQueryDb = Pick<Prisma.TransactionClient, RuntimeOpsDelegate>;
type RuntimeOpsReadDb = Pick<
  PrismaService,
  RuntimeOpsDelegate | 'withWorkspace'
>;

export type RuntimeOpsWorkerQueueState =
  | 'POLLING'
  | 'STALE'
  | 'MISSING'
  | 'BUILD_MISMATCH';

export interface RuntimeOpsSnapshot {
  observedAt: string;
  workers: {
    expected: number;
    polling: number;
    stale: number;
    missing: string[];
    buildShas: string[];
    unexpectedBuildShas: string[];
    queueStates: Array<{
      taskQueue: string;
      state: RuntimeOpsWorkerQueueState;
    }>;
  };
  schedules: {
    expected: number;
    tracked: number;
    missing: string[];
    drifted: string[];
    paused: string[];
    late: string[];
    staleEvidence: string[];
    unobservable: string[];
    missedCatchup: string[];
    skippedOverlap: string[];
  };
  workflows: { recentFailed: number; recentBudgetTruncated: number };
  signalIngest: { pending: number; expiredLeases: number; errors: number };
  ready: boolean;
}

export interface RuntimeOpsHttpSnapshot {
  readonly schemaVersion: 'runtime-ops/v1';
  readonly observedAt: string;
  readonly runtime: Readonly<{
    status: 'UNVERIFIED' | 'DEGRADED';
    workers: Readonly<{
      expectedBuildSha: string;
      queues: readonly Readonly<{
        taskQueue: string;
        state: RuntimeOpsWorkerQueueState;
      }>[];
      observedBuildShas: readonly string[];
    }>;
    schedules: Readonly<{
      expected: number;
      tracked: number;
      drifted: number;
      paused: number;
      late: number;
      staleEvidence: number;
      unobservable: number;
      missedCatchup: number;
      skippedOverlap: number;
    }>;
    workflows: Readonly<{ failed24h: number; budgetTruncated24h: number }>;
    signalIngest: Readonly<{
      pending: number;
      expiredLeases: number;
      errors: number;
    }>;
  }>;
  readonly workspace: Readonly<{
    outbox: Readonly<{ parked: number; dead: number }>;
    acquisitionBudget: Readonly<{
      exhausted: number;
      frozen: number;
      unknownSettlement: number;
    }>;
  }>;
  readonly global: Readonly<{ suspendedSourcePolicies: number }>;
  readonly proof: Readonly<{
    outboxRelay: 'UNVERIFIED';
    gatewayAdmission: 'UNVERIFIED';
    providerConsecutiveZeroResults: 'UNOBSERVABLE';
  }>;
}

export interface RuntimeOpsReadPort {
  snapshot(now?: Date): Promise<RuntimeOpsSnapshot>;
  snapshotForWorkspace(
    workspaceId: string,
    now?: Date,
  ): Promise<RuntimeOpsHttpSnapshot>;
}

export class RuntimeOpsReadService implements RuntimeOpsReadPort {
  constructor(
    private readonly db: RuntimeOpsReadDb,
    private readonly options: {
      expectedTaskQueues: readonly string[];
      expectedWorkerBuildSha: string;
      expectedScheduleIds: readonly string[];
      heartbeatFreshnessMs: number;
      scheduleLatenessToleranceMs: number;
      scheduleObservationFreshnessMs: number;
    },
  ) {
    if (
      !Number.isSafeInteger(options.heartbeatFreshnessMs) ||
      options.heartbeatFreshnessMs < 1_000 ||
      options.heartbeatFreshnessMs > 10 * 60_000
    ) {
      throw new Error('INVALID_RUNTIME_OPS_READ_CONFIG');
    }
    if (
      !/^(?:[a-f0-9]{40}(?:[a-f0-9]{24})?|development-unattested)$/.test(
        options.expectedWorkerBuildSha,
      ) ||
      options.expectedTaskQueues.length === 0 ||
      new Set(options.expectedTaskQueues).size !==
        options.expectedTaskQueues.length ||
      options.expectedScheduleIds.length === 0 ||
      new Set(options.expectedScheduleIds).size !==
        options.expectedScheduleIds.length ||
      !Number.isSafeInteger(options.scheduleLatenessToleranceMs) ||
      options.scheduleLatenessToleranceMs < 1_000 ||
      options.scheduleLatenessToleranceMs > 24 * 60 * 60_000 ||
      !Number.isSafeInteger(options.scheduleObservationFreshnessMs) ||
      options.scheduleObservationFreshnessMs < 60_000 ||
      options.scheduleObservationFreshnessMs > 24 * 60 * 60_000
    ) {
      throw new Error('INVALID_RUNTIME_OPS_READ_CONFIG');
    }
  }

  async snapshot(now: Date = new Date()): Promise<RuntimeOpsSnapshot> {
    return this.readSnapshot(this.db, now);
  }

  async snapshotForWorkspace(
    workspaceId: string,
    now: Date = new Date(),
  ): Promise<RuntimeOpsHttpSnapshot> {
    if (!WORKSPACE_ID.test(workspaceId)) {
      throw new Error('INVALID_RUNTIME_OPS_WORKSPACE');
    }
    this.assertTime(now);
    return this.db.withWorkspace(workspaceId, async (transaction) => {
      const [
        runtime,
        parked,
        dead,
        exhausted,
        frozen,
        unknownSettlement,
        suspendedSourcePolicies,
      ] = await Promise.all([
        this.readSnapshot(transaction, now),
        transaction.outboxEvent.count({ where: { parkedAt: { not: null } } }),
        transaction.outboxDelivery.count({ where: { status: 'DEAD' } }),
        transaction.acquisitionBudgetAccount.count({
          where: { status: 'EXHAUSTED' },
        }),
        transaction.acquisitionBudgetAccount.count({
          where: { status: 'FROZEN' },
        }),
        transaction.acquisitionBudgetReservation.count({
          where: { status: 'UNKNOWN' },
        }),
        transaction.sourcePolicy.count({
          where: { reviewStatus: 'SUSPENDED' },
        }),
      ]);
      const degraded =
        !runtime.ready ||
        parked > 0 ||
        dead > 0 ||
        exhausted > 0 ||
        frozen > 0 ||
        unknownSettlement > 0 ||
        suspendedSourcePolicies > 0;

      return Object.freeze({
        schemaVersion: 'runtime-ops/v1' as const,
        observedAt: runtime.observedAt,
        runtime: Object.freeze({
          status: degraded ? ('DEGRADED' as const) : ('UNVERIFIED' as const),
          workers: Object.freeze({
            expectedBuildSha: this.options.expectedWorkerBuildSha,
            queues: Object.freeze(
              runtime.workers.queueStates.map((queue) => Object.freeze({ ...queue })),
            ),
            observedBuildShas: Object.freeze([...runtime.workers.buildShas]),
          }),
          schedules: Object.freeze({
            expected: runtime.schedules.expected,
            tracked: runtime.schedules.tracked,
            drifted: runtime.schedules.drifted.length,
            paused: runtime.schedules.paused.length,
            late: runtime.schedules.late.length,
            staleEvidence: runtime.schedules.staleEvidence.length,
            unobservable: runtime.schedules.unobservable.length,
            missedCatchup: runtime.schedules.missedCatchup.length,
            skippedOverlap: runtime.schedules.skippedOverlap.length,
          }),
          workflows: Object.freeze({
            failed24h: runtime.workflows.recentFailed,
            budgetTruncated24h: runtime.workflows.recentBudgetTruncated,
          }),
          signalIngest: Object.freeze({ ...runtime.signalIngest }),
        }),
        workspace: Object.freeze({
          outbox: Object.freeze({ parked, dead }),
          acquisitionBudget: Object.freeze({
            exhausted,
            frozen,
            unknownSettlement,
          }),
        }),
        global: Object.freeze({ suspendedSourcePolicies }),
        proof: Object.freeze({
          outboxRelay: 'UNVERIFIED' as const,
          gatewayAdmission: 'UNVERIFIED' as const,
          providerConsecutiveZeroResults: 'UNOBSERVABLE' as const,
        }),
      });
    });
  }

  private assertTime(now: Date): void {
    if (!Number.isFinite(now.getTime())) {
      throw new Error('INVALID_RUNTIME_OPS_READ_TIME');
    }
  }

  private async readSnapshot(
    db: RuntimeOpsQueryDb,
    now: Date,
  ): Promise<RuntimeOpsSnapshot> {
    this.assertTime(now);
    const freshnessCutoff = new Date(
      now.getTime() - this.options.heartbeatFreshnessMs,
    );
    const recentCutoff = new Date(now.getTime() - 24 * 60 * 60_000);
    const [
      heartbeatGroups,
      driftReceiptGroups,
      recentFailed,
      recentBudgetTruncated,
      pending,
      expiredLeases,
      errors,
    ] = await Promise.all([
      Promise.all(
        this.options.expectedTaskQueues.map((taskQueue) =>
          db.workerHeartbeat.findMany({
            where: { taskQueue },
            orderBy: { lastSeenAt: 'desc' },
            take: 64,
            select: {
              taskQueue: true,
              status: true,
              lastSeenAt: true,
              workerBuildSha: true,
            },
          }),
        ),
      ),
      Promise.all(
        this.options.expectedScheduleIds.map((scheduleId) =>
          db.scheduleDriftReceipt.findMany({
            where: { scheduleId },
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
          }),
        ),
      ),
      db.workflowRunReceipt.count({
        where: { phase: 'FAILED', recordedAt: { gte: recentCutoff } },
      }),
      db.workflowRunReceipt.count({
        where: { budgetTruncated: true, recordedAt: { gte: recentCutoff } },
      }),
      db.signalIngest.count({ where: { status: 'PENDING' } }),
      db.signalIngest.count({
        where: { status: 'PENDING', leaseExpiresAt: { lt: now } },
      }),
      db.signalIngest.count({ where: { status: 'ERROR' } }),
    ]);
    const heartbeats = heartbeatGroups.flat();
    const driftReceipts = driftReceiptGroups.flat();

    const expectedSet = new Set(this.options.expectedTaskQueues);
    const heartbeatQueues = new Set(
      heartbeats
        .filter((heartbeat) => expectedSet.has(heartbeat.taskQueue))
        .map((heartbeat) => heartbeat.taskQueue),
    );
    const activeHeartbeats = heartbeats.filter(
      (heartbeat) =>
        expectedSet.has(heartbeat.taskQueue) &&
        heartbeat.status === 'POLLING' &&
        heartbeat.lastSeenAt >= freshnessCutoff,
    );
    const activeQueues = new Set(
      activeHeartbeats.map((heartbeat) => heartbeat.taskQueue),
    );
    const polling = activeQueues.size;
    const stale = this.options.expectedTaskQueues.filter(
      (taskQueue) =>
        heartbeatQueues.has(taskQueue) && !activeQueues.has(taskQueue),
    ).length;
    const missing = this.options.expectedTaskQueues.filter(
      (taskQueue) => !heartbeatQueues.has(taskQueue),
    );
    const buildShas = [
      ...new Set(
        activeHeartbeats.map((heartbeat) => heartbeat.workerBuildSha),
      ),
    ].sort();
    const unexpectedBuildShas = buildShas.filter(
      (buildSha) => buildSha !== this.options.expectedWorkerBuildSha,
    );
    const queueStates = this.options.expectedTaskQueues.map((taskQueue) => {
      const queueRows = heartbeats.filter(
        (heartbeat) => heartbeat.taskQueue === taskQueue,
      );
      const activeRows = activeHeartbeats.filter(
        (heartbeat) => heartbeat.taskQueue === taskQueue,
      );
      let state: RuntimeOpsWorkerQueueState = 'POLLING';
      if (queueRows.length === 0) state = 'MISSING';
      else if (activeRows.length === 0) state = 'STALE';
      else if (
        activeRows.some(
          (heartbeat) =>
            heartbeat.workerBuildSha !== this.options.expectedWorkerBuildSha,
        )
      ) {
        state = 'BUILD_MISMATCH';
      }
      return { taskQueue, state };
    });

    const expectedScheduleSet = new Set(this.options.expectedScheduleIds);
    const receiptsBySchedule = new Map<
      string,
      Array<(typeof driftReceipts)[number]>
    >();
    for (const receipt of driftReceipts) {
      if (!expectedScheduleSet.has(receipt.scheduleId)) continue;
      const rows = receiptsBySchedule.get(receipt.scheduleId) ?? [];
      rows.push(receipt);
      receiptsBySchedule.set(receipt.scheduleId, rows);
    }
    const latestDrift = new Map(
      [...receiptsBySchedule].map(([scheduleId, rows]) => [
        scheduleId,
        rows[0]!,
      ]),
    );
    const scheduleMissing = this.options.expectedScheduleIds.filter(
      (scheduleId) => !latestDrift.has(scheduleId),
    );
    const drifted = [...latestDrift.values()]
      .filter(
        (receipt) =>
          receipt.disposition === 'FAILED' ||
          receipt.observedHash === null ||
          receipt.observedHash !== receipt.desiredHash,
      )
      .map((receipt) => receipt.scheduleId)
      .sort();
    const paused = [...latestDrift.values()]
      .filter((receipt) => receipt.paused === true)
      .map((receipt) => receipt.scheduleId)
      .sort();
    const lateCutoff = new Date(
      now.getTime() - this.options.scheduleLatenessToleranceMs,
    );
    const late = [...latestDrift.values()]
      .filter(
        (receipt) =>
          receipt.paused === false &&
          receipt.nextActionAt !== null &&
          receipt.nextActionAt < lateCutoff,
      )
      .map((receipt) => receipt.scheduleId)
      .sort();
    const observationCutoff = new Date(
      now.getTime() - this.options.scheduleObservationFreshnessMs,
    );
    const staleEvidence = [...latestDrift.values()]
      .filter((receipt) => receipt.recordedAt < observationCutoff)
      .map((receipt) => receipt.scheduleId)
      .sort();
    const unobservable = [...latestDrift.values()]
      .filter(
        (receipt) =>
          receipt.paused === null ||
          (receipt.paused === false && receipt.nextActionAt === null) ||
          receipt.missedCatchupCount === null ||
          receipt.skippedOverlapCount === null,
      )
      .map((receipt) => receipt.scheduleId)
      .sort();
    const counterAdvanced = (
      scheduleId: string,
      field: 'missedCatchupCount' | 'skippedOverlapCount',
    ): boolean => {
      const rows = receiptsBySchedule.get(scheduleId) ?? [];
      const latest = rows[0]?.[field];
      const previous = rows[1]?.[field] ?? 0;
      return (
        latest !== null &&
        latest !== undefined &&
        latest > (previous ?? 0)
      );
    };
    const missedCatchup = [...latestDrift.keys()]
      .filter((scheduleId) =>
        counterAdvanced(scheduleId, 'missedCatchupCount'),
      )
      .sort();
    const skippedOverlap = [...latestDrift.keys()]
      .filter((scheduleId) =>
        counterAdvanced(scheduleId, 'skippedOverlapCount'),
      )
      .sort();

    return {
      observedAt: now.toISOString(),
      workers: {
        expected: this.options.expectedTaskQueues.length,
        polling,
        stale,
        missing,
        buildShas,
        unexpectedBuildShas,
        queueStates,
      },
      schedules: {
        expected: this.options.expectedScheduleIds.length,
        tracked: latestDrift.size,
        missing: scheduleMissing,
        drifted,
        paused,
        late,
        staleEvidence,
        unobservable,
        missedCatchup,
        skippedOverlap,
      },
      workflows: { recentFailed, recentBudgetTruncated },
      signalIngest: { pending, expiredLeases, errors },
      ready:
        polling === this.options.expectedTaskQueues.length &&
        stale === 0 &&
        missing.length === 0 &&
        unexpectedBuildShas.length === 0 &&
        scheduleMissing.length === 0 &&
        drifted.length === 0 &&
        paused.length === 0 &&
        late.length === 0 &&
        staleEvidence.length === 0 &&
        unobservable.length === 0 &&
        missedCatchup.length === 0 &&
        skippedOverlap.length === 0 &&
        recentFailed === 0 &&
        recentBudgetTruncated === 0 &&
        expiredLeases === 0 &&
        errors === 0,
    };
  }
}
