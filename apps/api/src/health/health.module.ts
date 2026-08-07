import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RuntimeIdentityService } from '../runtime/runtime-admission';
import { TemporalModule } from '../temporal/temporal.module';
import {
  BuildIdentityReadinessProbe,
  ConfigurationReadinessProbe,
  DatabaseReadinessProbe,
  TemporalReadinessProbe,
  UnavailableProofReadinessProbe,
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
      provide: WORKER_HEARTBEAT_READINESS_PROBE,
      useFactory: () => new UnavailableProofReadinessProbe('worker_heartbeat'),
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
  exports: [ReadinessService],
})
export class HealthModule {}
