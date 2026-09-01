import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  OnModuleDestroy,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RuntimeAdmissionService } from "./runtime-admission";
import {
  assertMigrationCompatible,
  PrismaRuntimeProcessLeaseStore,
  RuntimeProcessLeaseService,
} from "./runtime-process-lease";
import { RuntimeReleaseIdentityService } from "./runtime-release-identity";
import {
  RuntimeReadinessContributorRegistry,
  type RuntimeComponentStatus,
} from "./runtime-readiness-registry";
import { completesWithin, settlesWithin } from "./bounded-settlement";

const HEARTBEAT_INTERVAL_MS = 10_000;

@Injectable()
export class ApiRuntimeProcessHeartbeat
  implements OnApplicationBootstrap, OnModuleDestroy, OnApplicationShutdown
{
  private readonly logger = new Logger(ApiRuntimeProcessHeartbeat.name);
  private timer?: NodeJS.Timeout;
  private startingAttempted = false;
  private startingPublished = false;
  private shuttingDown = false;
  private publishInFlight?: Promise<void>;
  private leaseReadiness: RuntimeComponentStatus = Object.freeze({
    status: "failed",
    code: "API_RUNTIME_LEASE_NOT_READY",
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly admission: RuntimeAdmissionService,
    private readonly releaseIdentity: RuntimeReleaseIdentityService,
    private readonly leases: RuntimeProcessLeaseService,
    registry: RuntimeReadinessContributorRegistry,
    private readonly leaseStore: PrismaRuntimeProcessLeaseStore,
  ) {
    registry.register("api_runtime_lease", () => this.leaseReadiness);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.admission.current().admitted) {
      this.logger.error(
        "API runtime admission is closed; readiness remains closed",
      );
      return;
    }
    this.timer = setInterval(
      () => void this.publishReadyLease(),
      HEARTBEAT_INTERVAL_MS,
    );
    this.timer.unref();
    await this.publishReadyLease();
  }

  getReadiness(): RuntimeComponentStatus {
    return this.leaseReadiness;
  }

  private publishReadyLease(): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    if (this.publishInFlight) return this.publishInFlight;
    const pending = this.publishReadyLeaseOnce().finally(() => {
      if (this.publishInFlight === pending) this.publishInFlight = undefined;
    });
    this.publishInFlight = pending;
    return pending;
  }

  private async publishReadyLeaseOnce(): Promise<void> {
    try {
      await assertMigrationCompatible(
        this.prisma,
        this.releaseIdentity.current(),
      );
      if (this.shuttingDown) return;
      if (!this.startingPublished) {
        this.startingAttempted = true;
        await this.leases.heartbeat("API", "STARTING", null);
        this.startingPublished = true;
      }
      if (this.shuttingDown) return;
      await this.leases.heartbeat("API", "READY", null);
      if (this.shuttingDown) return;
      this.leaseReadiness = Object.freeze({ status: "ok" });
    } catch {
      this.logger.error(
        "API runtime identity, migration, or lease admission failed",
      );
      this.closeReadiness();
    }
  }

  private closeReadiness(): void {
    this.leaseReadiness = Object.freeze({
      status: "failed",
      code: "API_RUNTIME_LEASE_NOT_READY",
    });
    this.logger.error(
      "API runtime lease heartbeat failed; readiness is closed",
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    if (this.timer) clearInterval(this.timer);
    this.leaseReadiness = Object.freeze({
      status: "failed",
      code: "API_RUNTIME_LEASE_NOT_READY",
    });
    if (this.publishInFlight) {
      await completesWithin(this.publishInFlight);
    }
    if (!this.startingPublished) return;
    const drainingPublished = await settlesWithin(
      this.leases.heartbeat("API", "DRAINING", null),
    );
    if (!drainingPublished) {
      this.logger.error("API runtime draining heartbeat failed");
    }
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      const inFlightSettled = this.publishInFlight
        ? await completesWithin(this.publishInFlight)
        : true;
      if (!this.startingAttempted) return;
      if (this.startingPublished && inFlightSettled) {
        const stoppedPublished = await settlesWithin(
          this.leases.heartbeat("API", "STOPPED", null),
        );
        if (stoppedPublished) return;
        this.logger.error("API runtime stop heartbeat failed");
      }
      const terminalized = await settlesWithin(
        this.leases.terminalize("API", null),
      );
      if (!terminalized) {
        this.logger.error("API runtime atomic terminalization failed");
      }
    } finally {
      const writersClosed = await completesWithin(
        this.leaseStore.disconnectWriters(),
      );
      if (!writersClosed) {
        this.logger.error("API runtime lease writer disconnect timed out");
      }
    }
  }
}
