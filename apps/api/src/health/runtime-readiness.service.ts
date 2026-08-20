import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RuntimeAdmissionService } from '../runtime/runtime-admission';
import { RuntimeProcessLeaseService } from '../runtime/runtime-process-lease';
import { RuntimeReadinessContributorRegistry } from '../runtime/runtime-readiness-registry';
import { RuntimeReleaseIdentityService } from '../runtime/runtime-release-identity';
import { TemporalClient } from '../temporal/temporal.client';

export type ComponentStatus =
  | { status: 'ok'; code?: never }
  | { status: 'failed'; code: string }
  | { status: 'not_proven'; code: string };

export interface RuntimeReadinessReport {
  status: 'ready' | 'not_ready';
  service: 'global-api';
  ts: string;
  components: {
    database: ComponentStatus;
    migration: ComponentStatus;
    temporal_control_plane: ComponentStatus;
    worker: ComponentStatus;
    outbox_relay: ComponentStatus;
    api_runtime: ComponentStatus;
    storage: ComponentStatus;
    redis: ComponentStatus;
    model_gateway: ComponentStatus;
    renderer: ComponentStatus;
    browser: ComponentStatus;
    budget_grant_verification: ComponentStatus;
    admission: ComponentStatus;
  };
}

@Injectable()
export class RuntimeReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly temporal: TemporalClient,
    private readonly admission: RuntimeAdmissionService,
    private readonly releaseIdentity: RuntimeReleaseIdentityService,
    private readonly leases: RuntimeProcessLeaseService,
    private readonly contributors: RuntimeReadinessContributorRegistry,
  ) {}

  async check(): Promise<RuntimeReadinessReport> {
    const admission = this.admission.current();
    const identity = this.releaseIdentity.current();
    const [
      databaseAndMigration,
      temporalControlPlane,
      worker,
      outboxRelay,
      apiRuntime,
      storage,
      redis,
      modelGateway,
      renderer,
      browser,
      budgetGrantVerification,
    ] = await Promise.all([
        this.checkDatabaseAndMigration(),
        this.checkTemporal(),
        this.checkLease(() =>
          this.leases.inspectWorkerQueue(
            process.env.TEMPORAL_TASK_QUEUE ?? 'understanding',
          ),
        ),
        this.checkLease(() => this.leases.inspectRole('OUTBOX_RELAY')),
        this.contributors.check('api_runtime_lease'),
        this.contributors.check('storage'),
        this.contributors.check('redis'),
        this.contributors.check('model_gateway'),
        this.contributors.check('renderer'),
        this.contributors.check('browser'),
        this.contributors.check('budget_grant_verification'),
      ]);
    const admissionStatus: ComponentStatus =
      admission.admitted && identity.attested
        ? { status: 'ok' }
        : { status: 'failed', code: 'RUNTIME_ADMISSION_FAILED' };
    const components = {
      database: databaseAndMigration.database,
      migration: databaseAndMigration.migration,
      temporal_control_plane: temporalControlPlane,
      worker,
      outbox_relay: outboxRelay,
      api_runtime: apiRuntime,
      storage,
      redis,
      model_gateway: modelGateway,
      renderer,
      browser,
      budget_grant_verification: budgetGrantVerification,
      admission: admissionStatus,
    } satisfies RuntimeReadinessReport['components'];
    const ready = Object.values(components).every(
      (component) => component.status === 'ok',
    );
    return {
      status: ready ? 'ready' : 'not_ready',
      service: 'global-api',
      ts: new Date().toISOString(),
      components,
    };
  }

  private async checkDatabaseAndMigration(): Promise<{
    database: ComponentStatus;
    migration: ComponentStatus;
  }> {
    try {
      if (typeof this.prisma.reconnect === 'function') {
        const connection = await this.prisma.reconnect();
        if (connection.status !== 'ready') {
          return {
            database: { status: 'failed', code: connection.code },
            migration: {
              status: 'not_proven',
              code: 'MIGRATION_REVISION_NOT_PROVEN',
            },
          };
        }
      }
      const expected = this.releaseIdentity.current();
      if (!expected.attested) throw new Error('RUNTIME_RELEASE_IDENTITY_UNAVAILABLE');
      const revision = await this.prisma.$transaction(
        async (transaction) => {
          await transaction.$executeRawUnsafe('SET LOCAL statement_timeout = 2000');
          await transaction.$queryRawUnsafe('SELECT 1');
          return transaction.$queryRawUnsafe<Array<{ migration_name: string }>>(
            `SELECT migration_name
               FROM "_prisma_migrations"
              WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
              ORDER BY finished_at DESC, migration_name DESC
              LIMIT 1`,
          );
        },
        { maxWait: 1_000, timeout: 2_500 },
      );
      return {
        database: { status: 'ok' },
        migration:
          revision[0]?.migration_name === expected.migration_revision
            ? { status: 'ok' }
            : { status: 'failed', code: 'MIGRATION_REVISION_MISMATCH' },
      };
    } catch {
      return {
        database: { status: 'failed', code: 'DATABASE_UNAVAILABLE' },
        migration: { status: 'not_proven', code: 'MIGRATION_REVISION_NOT_PROVEN' },
      };
    }
  }

  private async checkTemporal(): Promise<ComponentStatus> {
    try {
      const result = await this.temporal.probe();
      return result.connected
        ? { status: 'ok' }
        : { status: 'failed', code: 'TEMPORAL_UNAVAILABLE' };
    } catch {
      return { status: 'failed', code: 'TEMPORAL_UNAVAILABLE' };
    }
  }

  private async checkLease(
    inspect: () => Promise<{ status: 'ok' } | { status: 'failed'; code: string }>,
  ): Promise<ComponentStatus> {
    try {
      return await inspect();
    } catch {
      return { status: 'failed', code: 'RUNTIME_PROCESS_LEASE_UNAVAILABLE' };
    }
  }
}
