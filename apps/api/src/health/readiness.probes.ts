import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RuntimeIdentityService } from '../runtime/runtime-admission';
import { TemporalClient } from '../temporal/temporal.client';
import { WORKER_DOMAINS } from '../temporal/worker-topology';
import type {
  ReadinessCheckName,
  ReadinessProbePort,
  ReadinessProbeResult,
} from './readiness.service';

@Injectable()
export class ConfigurationReadinessProbe implements ReadinessProbePort {
  readonly name = 'configuration' as const;
  readonly required = true;

  constructor(private readonly runtime: RuntimeIdentityService) {}

  async check(): Promise<ReadinessProbeResult> {
    const snapshot = this.runtime.getSnapshot();
    if (
      snapshot.apiBindHost !== '127.0.0.1' ||
      !Number.isInteger(snapshot.port) ||
      snapshot.port < 1 ||
      snapshot.port > 65_535 ||
      (snapshot.deploymentStage !== 'development' &&
        snapshot.corsOrigins.length === 0)
    ) {
      throw new Error('runtime configuration is not admitted');
    }
    return { status: 'PASS', code: 'CONFIGURATION_VALID' };
  }
}

@Injectable()
export class BuildIdentityReadinessProbe implements ReadinessProbePort {
  readonly name = 'build_identity' as const;

  constructor(private readonly runtime: RuntimeIdentityService) {}

  get required(): boolean {
    return this.runtime.getSnapshot().deploymentStage !== 'development';
  }

  async check(): Promise<ReadinessProbeResult> {
    const identity = this.runtime.getSnapshot().buildIdentity;
    if (identity.status === 'VERIFIED') {
      return { status: 'PASS', code: 'BUILD_IDENTITY_VERIFIED' };
    }
    return {
      status: 'UNVERIFIED',
      code: this.required
        ? 'BUILD_IDENTITY_REQUIRED'
        : 'BUILD_IDENTITY_NOT_REQUIRED',
    };
  }
}

@Injectable()
export class DatabaseReadinessProbe implements ReadinessProbePort {
  readonly name = 'database' as const;
  readonly required = true;

  constructor(
    private readonly prisma: PrismaService,
    private readonly runtime: RuntimeIdentityService,
  ) {}

  async check(): Promise<ReadinessProbeResult> {
    const migrations = await this.prisma.$transaction(
      async (transaction) => {
        await transaction.$queryRaw`
          SELECT set_config('statement_timeout', ${'600ms'}, true) AS "statementTimeout"
        `;
        return transaction.$queryRaw<
          Array<{
            migrationName: string;
            checksum: string;
            finishedAt: Date | null;
            rolledBackAt: Date | null;
            appliedStepsCount: number;
          }>
        >`
          SELECT
            migration_name AS "migrationName",
            checksum,
            finished_at AS "finishedAt",
            rolled_back_at AS "rolledBackAt",
            applied_steps_count AS "appliedStepsCount"
          FROM "_prisma_migrations"
          ORDER BY started_at ASC
        `;
      },
      { maxWait: 100, timeout: 800 },
    );
    const active = migrations.filter(
      (migration) => migration.rolledBackAt === null,
    );
    if (
      active.some(
        (migration) =>
          migration.finishedAt === null || migration.appliedStepsCount < 1,
      )
    ) {
      return { status: 'FAIL', code: 'DATABASE_MIGRATION_DIRTY' };
    }
    const identity = this.runtime.getSnapshot().buildIdentity;
    if (identity.status !== 'VERIFIED') {
      return {
        status: 'UNVERIFIED',
        code: 'DATABASE_REACHABLE_MIGRATION_UNVERIFIED',
      };
    }
    const expected = identity.migrationManifest.entries;
    const observedNames = active.map(({ migrationName }) => migrationName);
    if (
      active.length !== expected.length ||
      new Set(observedNames).size !== observedNames.length ||
      expected.some(
        (entry, index) => active[index]?.migrationName !== entry.name,
      )
    ) {
      return { status: 'FAIL', code: 'MIGRATION_MANIFEST_MISMATCH' };
    }
    if (
      expected.some(
        (entry, index) => active[index]?.checksum !== entry.checksum,
      )
    ) {
      return { status: 'FAIL', code: 'MIGRATION_CHECKSUM_MISMATCH' };
    }
    return { status: 'PASS', code: 'DATABASE_REACHABLE_AND_MIGRATED' };
  }
}

@Injectable()
export class TemporalReadinessProbe implements ReadinessProbePort {
  readonly name = 'temporal' as const;
  readonly required = true;

  constructor(private readonly temporal: TemporalClient) {}

  async check(signal?: AbortSignal): Promise<ReadinessProbeResult> {
    await this.temporal.checkSystemInfo({ timeoutMs: 750, signal });
    return { status: 'PASS', code: 'TEMPORAL_REACHABLE' };
  }
}

interface WorkerHeartbeatProbeOptions {
  readonly freshnessMs: number;
  readonly now?: () => Date;
}

/**
 * Durable worker proof. It deliberately selects no worker instance id and
 * returns one closed decision: every code-owned queue must have a fresh
 * POLLING heartbeat from the exact API build.
 */
export class WorkerHeartbeatReadinessProbe implements ReadinessProbePort {
  readonly name = 'worker_heartbeat' as const;
  readonly required = true;
  private readonly now: () => Date;

  constructor(
    private readonly prisma: Pick<PrismaService, 'workerHeartbeat'>,
    private readonly runtime: RuntimeIdentityService,
    private readonly options: WorkerHeartbeatProbeOptions,
  ) {
    if (
      !Number.isSafeInteger(options.freshnessMs) ||
      options.freshnessMs < 1_000 ||
      options.freshnessMs > 10 * 60_000
    ) {
      throw new Error('INVALID_WORKER_HEARTBEAT_READINESS_CONFIG');
    }
    this.now = options.now ?? (() => new Date());
  }

  async check(): Promise<ReadinessProbeResult> {
    const now = this.now();
    if (!Number.isFinite(now.getTime())) {
      return { status: 'FAIL', code: 'WORKER_HEARTBEAT_NOT_READY' };
    }
    const admission = this.runtime.getSnapshot();
    const expectedBuildSha =
      admission.buildIdentity.status === 'VERIFIED'
        ? admission.buildIdentity.buildSha
        : 'development-unattested';
    const freshnessCutoff = new Date(now.getTime() - this.options.freshnessMs);
    const expectedQueues = WORKER_DOMAINS.map(({ taskQueue }) => taskQueue);
    const rows = await this.prisma.workerHeartbeat.findMany({
      where: {
        taskQueue: { in: expectedQueues },
        status: 'POLLING',
        lastSeenAt: { gte: freshnessCutoff },
      },
      orderBy: { lastSeenAt: 'desc' },
      take: 256,
      select: {
        taskQueue: true,
        status: true,
        lastSeenAt: true,
        workerBuildSha: true,
      },
    });
    const healthyQueues = new Set(
      rows
        .filter(
          (row) =>
            row.status === 'POLLING' &&
            row.lastSeenAt >= freshnessCutoff &&
            row.workerBuildSha === expectedBuildSha,
        )
        .map((row) => row.taskQueue),
    );
    const hasUnexpectedActiveBuild = rows.some(
      (row) =>
        expectedQueues.includes(row.taskQueue) &&
        row.status === 'POLLING' &&
        row.lastSeenAt >= freshnessCutoff &&
        row.workerBuildSha !== expectedBuildSha,
    );
    if (
      hasUnexpectedActiveBuild ||
      expectedQueues.some((taskQueue) => !healthyQueues.has(taskQueue))
    ) {
      return { status: 'FAIL', code: 'WORKER_HEARTBEAT_NOT_READY' };
    }
    return { status: 'PASS', code: 'WORKER_HEARTBEAT_VERIFIED' };
  }
}

export type UnavailableProofName = Extract<
  ReadinessCheckName,
  'outbox_relay' | 'gateway_admission'
>;

export class UnavailableProofReadinessProbe implements ReadinessProbePort {
  readonly required = true;

  constructor(readonly name: UnavailableProofName) {}

  async check(): Promise<ReadinessProbeResult> {
    return { status: 'UNVERIFIED', code: 'PROOF_SOURCE_UNAVAILABLE' };
  }
}
