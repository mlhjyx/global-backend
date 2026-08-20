import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RuntimeAdmissionService } from './runtime-admission';
import {
  assertMigrationCompatible,
  RuntimeProcessLeaseService,
} from './runtime-process-lease';
import { RuntimeReleaseIdentityService } from './runtime-release-identity';
import {
  RuntimeReadinessContributorRegistry,
  type RuntimeComponentStatus,
} from './runtime-readiness-registry';

const HEARTBEAT_INTERVAL_MS = 10_000;

@Injectable()
export class ApiRuntimeProcessHeartbeat
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(ApiRuntimeProcessHeartbeat.name);
  private timer?: NodeJS.Timeout;
  private ready = false;
  private leaseReadiness: RuntimeComponentStatus = Object.freeze({
    status: 'failed',
    code: 'API_RUNTIME_LEASE_NOT_READY',
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly admission: RuntimeAdmissionService,
    private readonly releaseIdentity: RuntimeReleaseIdentityService,
    private readonly leases: RuntimeProcessLeaseService,
    registry: RuntimeReadinessContributorRegistry,
  ) {
    registry.register('api_runtime_lease', () => this.leaseReadiness);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.admission.current().admitted) {
      this.logger.error('API runtime admission is closed; readiness remains closed');
      return;
    }
    this.timer = setInterval(() => void this.publishReadyLease(), HEARTBEAT_INTERVAL_MS);
    this.timer.unref();
    await this.publishReadyLease();
  }

  getReadiness(): RuntimeComponentStatus {
    return this.leaseReadiness;
  }

  private async publishReadyLease(): Promise<void> {
    try {
      await assertMigrationCompatible(
        this.prisma,
        this.releaseIdentity.current(),
      );
      await this.leases.heartbeat('API', 'STARTING', null);
      await this.leases.heartbeat('API', 'READY', null);
      this.ready = true;
      this.leaseReadiness = Object.freeze({ status: 'ok' });
    } catch {
      this.logger.error('API runtime identity, migration, or lease admission failed');
      this.closeReadiness();
    }
  }

  private closeReadiness(): void {
    this.ready = false;
    this.leaseReadiness = Object.freeze({
      status: 'failed',
      code: 'API_RUNTIME_LEASE_NOT_READY',
    });
    this.logger.error('API runtime lease heartbeat failed; readiness is closed');
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.leaseReadiness = Object.freeze({
      status: 'failed',
      code: 'API_RUNTIME_LEASE_NOT_READY',
    });
    if (!this.ready) return;
    await this.leases
      .heartbeat('API', 'STOPPED', null)
      .catch(() => this.logger.error('API runtime stop heartbeat failed'));
  }
}
