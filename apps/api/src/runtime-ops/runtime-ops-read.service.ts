interface RuntimeOpsReadDb {
  workerHeartbeat: {
    findMany(input: Record<string, unknown>): Promise<
      Array<{
        taskQueue: string;
        status: string;
        lastSeenAt: Date;
        workerBuildSha: string;
      }>
    >;
  };
  scheduleDriftReceipt: {
    findMany(input: Record<string, unknown>): Promise<
      Array<{
        scheduleId: string;
        disposition: string;
        desiredHash: string;
        observedHash: string | null;
        recordedAt: Date;
        paused: boolean | null;
        nextActionAt: Date | null;
        missedCatchupCount: number | null;
        skippedOverlapCount: number | null;
      }>
    >;
  };
  workflowRunReceipt: {
    count(input: Record<string, unknown>): Promise<number>;
  };
  signalIngest: {
    count(input: Record<string, unknown>): Promise<number>;
  };
}

export interface RuntimeOpsSnapshot {
  observedAt: string;
  workers: {
    expected: number;
    polling: number;
    stale: number;
    missing: string[];
    buildShas: string[];
    unexpectedBuildShas: string[];
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

export interface RuntimeOpsReadPort {
  snapshot(now?: Date): Promise<RuntimeOpsSnapshot>;
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
      new Set(options.expectedTaskQueues).size !== options.expectedTaskQueues.length ||
      options.expectedScheduleIds.length === 0 ||
      new Set(options.expectedScheduleIds).size !== options.expectedScheduleIds.length ||
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
    if (!Number.isFinite(now.getTime())) throw new Error('INVALID_RUNTIME_OPS_READ_TIME');
    const freshnessCutoff = new Date(now.getTime() - this.options.heartbeatFreshnessMs);
    const recentCutoff = new Date(now.getTime() - 24 * 60 * 60_000);
    const [heartbeats, driftReceipts, recentFailed, recentBudgetTruncated, pending, expiredLeases, errors] =
      await Promise.all([
        this.db.workerHeartbeat.findMany({
          orderBy: { lastSeenAt: 'desc' },
          select: {
            taskQueue: true,
            status: true,
            lastSeenAt: true,
            workerBuildSha: true,
          },
        }),
        this.db.scheduleDriftReceipt.findMany({
          orderBy: { recordedAt: 'desc' },
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
        this.db.workflowRunReceipt.count({
          where: { phase: 'FAILED', recordedAt: { gte: recentCutoff } },
        }),
        this.db.workflowRunReceipt.count({
          where: { budgetTruncated: true, recordedAt: { gte: recentCutoff } },
        }),
        this.db.signalIngest.count({ where: { status: 'PENDING' } }),
        this.db.signalIngest.count({
          where: { status: 'PENDING', leaseExpiresAt: { lt: now } },
        }),
        this.db.signalIngest.count({ where: { status: 'ERROR' } }),
      ]);

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
      ...new Set(activeHeartbeats.map((heartbeat) => heartbeat.workerBuildSha)),
    ].sort();
    const unexpectedBuildShas = buildShas.filter(
      (buildSha) => buildSha !== this.options.expectedWorkerBuildSha,
    );

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
      [...receiptsBySchedule].map(([scheduleId, rows]) => [scheduleId, rows[0]!]),
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
      return latest !== null && latest !== undefined && latest > (previous ?? 0);
    };
    const missedCatchup = [...latestDrift.keys()]
      .filter((scheduleId) => counterAdvanced(scheduleId, 'missedCatchupCount'))
      .sort();
    const skippedOverlap = [...latestDrift.keys()]
      .filter((scheduleId) => counterAdvanced(scheduleId, 'skippedOverlapCount'))
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
