import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { RuntimeIdentityService } from '../runtime/runtime-admission';
import { RuntimeOpsReadService } from '../runtime-ops/runtime-ops-read.service';
import { TemporalModule } from '../temporal/temporal.module';
import { PLATFORM_SCHEDULES } from '../temporal/schedule-governance';
import {
  parseBoundedIntervalMs,
  WORKER_DOMAINS,
} from '../temporal/worker-topology';
import {
  BuildIdentityReadinessProbe,
  ConfigurationReadinessProbe,
  DatabaseReadinessProbe,
  TemporalReadinessProbe,
  UnavailableProofReadinessProbe,
  WorkerHeartbeatReadinessProbe,
} from './readiness.probes';
import {
  READINESS_PROBES,
  READINESS_SERVICE_OPTIONS,
  ReadinessService,
  type ReadinessProbePort,
} from './readiness.service';

export const WORKER_HEARTBEAT_READINESS_PROBE = Symbol(
  'WORKER_HEARTBEAT_READINESS_PROBE',
);
export const OUTBOX_RELAY_READINESS_PROBE = Symbol(
  'OUTBOX_RELAY_READINESS_PROBE',
);
export const GATEWAY_ADMISSION_READINESS_PROBE = Symbol(
  'GATEWAY_ADMISSION_READINESS_PROBE',
);

@Module({
  imports: [PrismaModule, TemporalModule],
  providers: [
    {
      provide: READINESS_SERVICE_OPTIONS,
      useFactory: (runtime: RuntimeIdentityService) =>
        Object.freeze({
          deploymentStage: runtime.getSnapshot().deploymentStage,
        }),
      inject: [RuntimeIdentityService],
    },
    ConfigurationReadinessProbe,
    BuildIdentityReadinessProbe,
    DatabaseReadinessProbe,
    TemporalReadinessProbe,
    {
      provide: RuntimeOpsReadService,
      useFactory: (
        prisma: PrismaService,
        runtime: RuntimeIdentityService,
      ) => {
        const process = runtime.getProcessSnapshot();
        const heartbeatIntervalMs = parseBoundedIntervalMs(
          process.environment.WORKER_HEARTBEAT_INTERVAL_MS,
          'WORKER_HEARTBEAT_INTERVAL_MS',
          15_000,
          5_000,
          60_000,
        );
        const scheduleObservationIntervalMs = parseBoundedIntervalMs(
          process.environment.SCHEDULE_OBSERVATION_INTERVAL_MS,
          'SCHEDULE_OBSERVATION_INTERVAL_MS',
          5 * 60_000,
          60_000,
          60 * 60_000,
        );
        const buildIdentity = runtime.getSnapshot().buildIdentity;
        return new RuntimeOpsReadService(prisma, {
          expectedTaskQueues: WORKER_DOMAINS.map(({ taskQueue }) => taskQueue),
          expectedWorkerBuildSha:
            buildIdentity.status === 'VERIFIED'
              ? buildIdentity.buildSha
              : 'development-unattested',
          expectedScheduleIds: PLATFORM_SCHEDULES.map(({ id }) => id),
          heartbeatFreshnessMs: heartbeatIntervalMs * 3,
          scheduleLatenessToleranceMs: scheduleObservationIntervalMs,
          scheduleObservationFreshnessMs:
            scheduleObservationIntervalMs * 3,
        });
      },
      inject: [PrismaService, RuntimeIdentityService],
    },
    {
      provide: WORKER_HEARTBEAT_READINESS_PROBE,
      useFactory: (
        prisma: PrismaService,
        runtime: RuntimeIdentityService,
      ) => {
        const heartbeatIntervalMs = parseBoundedIntervalMs(
          runtime.getProcessSnapshot().environment.WORKER_HEARTBEAT_INTERVAL_MS,
          'WORKER_HEARTBEAT_INTERVAL_MS',
          15_000,
          5_000,
          60_000,
        );
        return new WorkerHeartbeatReadinessProbe(prisma, runtime, {
          freshnessMs: heartbeatIntervalMs * 3,
        });
      },
      inject: [PrismaService, RuntimeIdentityService],
    },
    {
      provide: OUTBOX_RELAY_READINESS_PROBE,
      useFactory: () => new UnavailableProofReadinessProbe('outbox_relay'),
    },
    {
      provide: GATEWAY_ADMISSION_READINESS_PROBE,
      useFactory: () => new UnavailableProofReadinessProbe('gateway_admission'),
    },
    {
      provide: READINESS_PROBES,
      useFactory: (
        configuration: ConfigurationReadinessProbe,
        buildIdentity: BuildIdentityReadinessProbe,
        database: DatabaseReadinessProbe,
        temporal: TemporalReadinessProbe,
        workerHeartbeat: ReadinessProbePort,
        outboxRelay: ReadinessProbePort,
        gatewayAdmission: ReadinessProbePort,
      ): readonly ReadinessProbePort[] =>
        Object.freeze([
          configuration,
          buildIdentity,
          database,
          temporal,
          workerHeartbeat,
          outboxRelay,
          gatewayAdmission,
        ]),
      inject: [
        ConfigurationReadinessProbe,
        BuildIdentityReadinessProbe,
        DatabaseReadinessProbe,
        TemporalReadinessProbe,
        WORKER_HEARTBEAT_READINESS_PROBE,
        OUTBOX_RELAY_READINESS_PROBE,
        GATEWAY_ADMISSION_READINESS_PROBE,
      ],
    },
    ReadinessService,
  ],
  exports: [ReadinessService, RuntimeOpsReadService],
})
export class HealthModule {}
