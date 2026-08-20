import {
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
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
  capabilities: {
    execution_budget_jwks: ComponentStatus;
    workspace_budget_authority: ComponentStatus;
    platform_budget_authority: ComponentStatus;
  };
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
    auth_jwks: ComponentStatus;
    admission: ComponentStatus;
  };
}

type RuntimeHardReadiness = Readonly<{
  status: RuntimeReadinessReport['status'];
  components: RuntimeReadinessReport['components'];
}>;

const READINESS_REFRESH_INTERVAL_MS = 10_000;
const SNAPSHOT_UNAVAILABLE = 'RUNTIME_READINESS_SNAPSHOT_UNAVAILABLE';

function unavailableComponent(): ComponentStatus {
  return Object.freeze({ status: 'not_proven', code: SNAPSHOT_UNAVAILABLE });
}

function initialReadinessSnapshot(): RuntimeReadinessReport {
  return Object.freeze({
    status: 'not_ready' as const,
    service: 'global-api' as const,
    ts: new Date(0).toISOString(),
    capabilities: Object.freeze({
      execution_budget_jwks: unavailableComponent(),
      workspace_budget_authority: unavailableComponent(),
      platform_budget_authority: unavailableComponent(),
    }),
    components: Object.freeze({
      database: unavailableComponent(),
      migration: unavailableComponent(),
      temporal_control_plane: unavailableComponent(),
      worker: unavailableComponent(),
      outbox_relay: unavailableComponent(),
      api_runtime: unavailableComponent(),
      storage: unavailableComponent(),
      redis: unavailableComponent(),
      model_gateway: unavailableComponent(),
      renderer: unavailableComponent(),
      browser: unavailableComponent(),
      budget_grant_verification: unavailableComponent(),
      auth_jwks: unavailableComponent(),
      admission: unavailableComponent(),
    }),
  });
}

@Injectable()
export class RuntimeReadinessService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private snapshot: RuntimeReadinessReport = initialReadinessSnapshot();
  private refreshInFlight?: Promise<RuntimeReadinessReport>;
  private hardRefreshInFlight?: Promise<RuntimeHardReadiness>;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly temporal: TemporalClient,
    private readonly admission: RuntimeAdmissionService,
    private readonly releaseIdentity: RuntimeReleaseIdentityService,
    private readonly leases: RuntimeProcessLeaseService,
    private readonly contributors: RuntimeReadinessContributorRegistry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    void this.check();
    this.timer = setInterval(
      () => void this.check(),
      READINESS_REFRESH_INTERVAL_MS,
    );
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  current(): RuntimeReadinessReport {
    return this.snapshot;
  }

  async check(): Promise<RuntimeReadinessReport> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const refresh = this.calculate();
    this.refreshInFlight = refresh;
    try {
      const report = await refresh;
      this.snapshot = report;
      return report;
    } finally {
      this.refreshInFlight = undefined;
    }
  }

  async checkHardComponents(): Promise<RuntimeReadinessReport> {
    const hard = await this.refreshHardComponents();
    const report = this.report(hard, this.snapshot.capabilities);
    this.snapshot = report;
    return report;
  }

  private async calculate(): Promise<RuntimeReadinessReport> {
    const hard = await this.refreshHardComponents();
    const [executionBudgetJwks, platformBudgetAuthority] = await Promise.all([
      this.contributors.check('execution_budget_jwks'),
      this.contributors.check('platform_budget_authority'),
    ]);
    const workspaceBudgetAuthority: ComponentStatus =
      executionBudgetJwks.status !== 'ok'
        ? {
            status: 'failed',
            code: 'WORKSPACE_BUDGET_AUTHORITY_VERIFICATION_UNAVAILABLE',
          }
        : hard.components.database.status !== 'ok'
          ? {
              status: 'failed',
              code: 'WORKSPACE_BUDGET_AUTHORITY_DATABASE_UNAVAILABLE',
            }
          : hard.components.migration.status !== 'ok'
            ? {
                status: 'failed',
                code: 'WORKSPACE_BUDGET_AUTHORITY_MIGRATION_UNAVAILABLE',
              }
            : { status: 'ok' };
    return this.report(hard, {
      execution_budget_jwks: executionBudgetJwks,
      workspace_budget_authority: workspaceBudgetAuthority,
      platform_budget_authority: platformBudgetAuthority,
    });
  }

  private async refreshHardComponents(): Promise<RuntimeHardReadiness> {
    if (this.hardRefreshInFlight) return this.hardRefreshInFlight;
    const refresh = this.calculateHardComponents();
    this.hardRefreshInFlight = refresh;
    try {
      return await refresh;
    } finally {
      this.hardRefreshInFlight = undefined;
    }
  }

  private async calculateHardComponents(): Promise<RuntimeHardReadiness> {
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
      authJwks,
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
      this.contributors.check('auth_jwks'),
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
      auth_jwks: authJwks,
      admission: admissionStatus,
    } satisfies RuntimeReadinessReport['components'];
    const ready = Object.values(components).every(
      (component) => component.status === 'ok',
    );
    return {
      status: ready ? 'ready' : 'not_ready',
      components,
    };
  }

  private report(
    hard: RuntimeHardReadiness,
    capabilities: RuntimeReadinessReport['capabilities'],
  ): RuntimeReadinessReport {
    return {
      status: hard.status,
      service: 'global-api',
      ts: new Date().toISOString(),
      capabilities,
      components: hard.components,
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
      if (!expected.attested)
        throw new Error('RUNTIME_RELEASE_IDENTITY_UNAVAILABLE');
      const revision = await this.prisma.$transaction(
        async (transaction) => {
          await transaction.$executeRawUnsafe(
            'SET LOCAL statement_timeout = 2000',
          );
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
        migration: {
          status: 'not_proven',
          code: 'MIGRATION_REVISION_NOT_PROVEN',
        },
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
    inspect: () => Promise<
      { status: 'ok' } | { status: 'failed'; code: string }
    >,
  ): Promise<ComponentStatus> {
    try {
      return await inspect();
    } catch {
      return { status: 'failed', code: 'RUNTIME_PROCESS_LEASE_UNAVAILABLE' };
    }
  }
}
