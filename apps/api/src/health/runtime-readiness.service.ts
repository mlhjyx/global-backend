import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RuntimeAdmissionService } from '../runtime/runtime-admission';
import { TemporalClient } from '../temporal/temporal.client';

type ComponentStatus =
  | { status: 'ok'; code?: never }
  | { status: 'failed'; code: string }
  | { status: 'not_proven'; code: string };

export interface RuntimeReadinessReport {
  status: 'ready' | 'not_ready';
  service: 'global-api';
  ts: string;
  components: {
    database: ComponentStatus;
    temporal_control_plane: ComponentStatus;
    worker: ComponentStatus;
    outbox_relay: ComponentStatus;
    admission: ComponentStatus;
  };
}

@Injectable()
export class RuntimeReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly temporal: TemporalClient,
    private readonly admission: RuntimeAdmissionService,
  ) {}

  async check(): Promise<RuntimeReadinessReport> {
    const admission = this.admission.current();
    const [database, temporalControlPlane] = await Promise.all([
      this.checkDatabase(),
      this.checkTemporal(),
    ]);
    const worker: ComponentStatus = {
      status: 'not_proven',
      code: 'DURABLE_HEARTBEAT_NOT_IMPLEMENTED',
    };
    const outboxRelay: ComponentStatus = {
      status: 'not_proven',
      code: 'DURABLE_RELAY_EVIDENCE_NOT_IMPLEMENTED',
    };
    const admissionStatus: ComponentStatus = admission.admitted
      ? { status: 'ok' }
      : { status: 'failed', code: 'RUNTIME_ADMISSION_FAILED' };
    const operationalEvidenceRequired =
      admission.mode === 'pilot' || admission.mode === 'production';
    const ready =
      database.status === 'ok' &&
      temporalControlPlane.status === 'ok' &&
      admissionStatus.status === 'ok' &&
      !operationalEvidenceRequired;
    return {
      status: ready ? 'ready' : 'not_ready',
      service: 'global-api',
      ts: new Date().toISOString(),
      components: {
        database,
        temporal_control_plane: temporalControlPlane,
        worker,
        outbox_relay: outboxRelay,
        admission: admissionStatus,
      },
    };
  }

  private async checkDatabase(): Promise<ComponentStatus> {
    try {
      await this.prisma.$transaction(
        async (transaction) => {
          await transaction.$executeRawUnsafe('SET LOCAL statement_timeout = 2000');
          await transaction.$queryRawUnsafe('SELECT 1');
        },
        { maxWait: 1_000, timeout: 2_500 },
      );
      return { status: 'ok' };
    } catch {
      return { status: 'failed', code: 'DATABASE_UNAVAILABLE' };
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
}
