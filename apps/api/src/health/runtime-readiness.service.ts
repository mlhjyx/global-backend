import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RuntimeAdmissionService } from '../runtime/runtime-admission';
import { TemporalClient } from '../temporal/temporal.client';
import { RUNTIME_HEARTBEAT_STALE_MS, type RuntimeComponent } from './runtime-component-lease';

interface ComponentEvidence {
  source: 'postgresql_lease';
  heartbeat_at: string;
  age_ms: number;
}

type ComponentStatus =
  | { status: 'ok'; code?: never; evidence?: ComponentEvidence }
  | { status: 'failed'; code: string; evidence?: ComponentEvidence }
  | { status: 'not_proven'; code: string };

interface HeartbeatRow {
  state: 'RUNNING' | 'STOPPED';
  heartbeat_at: Date;
  age_ms: number;
}

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
    const [database, temporalControlPlane, worker, outboxRelay] = await Promise.all([
      this.checkDatabase(),
      this.checkTemporal(),
      this.checkDurableComponent('WORKER'),
      this.checkDurableComponent('OUTBOX_RELAY'),
    ]);
    const admissionStatus: ComponentStatus = admission.admitted
      ? { status: 'ok' }
      : { status: 'failed', code: 'RUNTIME_ADMISSION_FAILED' };
    const ready =
      database.status === 'ok' &&
      temporalControlPlane.status === 'ok' &&
      worker.status === 'ok' &&
      outboxRelay.status === 'ok' &&
      admissionStatus.status === 'ok' &&
      admission.admitted;
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
      return result.connected ? { status: 'ok' } : { status: 'failed', code: 'TEMPORAL_UNAVAILABLE' };
    } catch {
      return { status: 'failed', code: 'TEMPORAL_UNAVAILABLE' };
    }
  }

  private async checkDurableComponent(component: RuntimeComponent): Promise<ComponentStatus> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<HeartbeatRow[]>(
        `SELECT state,
                heartbeat_at,
                GREATEST(
                  0,
                  EXTRACT(EPOCH FROM (clock_timestamp() - heartbeat_at)) * 1000
                )::double precision AS age_ms
           FROM runtime_component_heartbeat
          WHERE component = $1
          ORDER BY (state = 'RUNNING') DESC, heartbeat_at DESC
          LIMIT 1`,
        component,
      );
      const row = rows[0];
      if (!row) {
        return { status: 'failed', code: 'DURABLE_HEARTBEAT_MISSING' };
      }
      const evidence: ComponentEvidence = {
        source: 'postgresql_lease',
        heartbeat_at: row.heartbeat_at.toISOString(),
        age_ms: Math.round(Number(row.age_ms)),
      };
      if (row.state !== 'RUNNING') {
        return {
          status: 'failed',
          code: 'DURABLE_COMPONENT_STOPPED',
          evidence,
        };
      }
      if (evidence.age_ms > RUNTIME_HEARTBEAT_STALE_MS) {
        return {
          status: 'failed',
          code: 'DURABLE_HEARTBEAT_STALE',
          evidence,
        };
      }
      return { status: 'ok', evidence };
    } catch {
      return { status: 'failed', code: 'DURABLE_HEARTBEAT_UNAVAILABLE' };
    }
  }
}
