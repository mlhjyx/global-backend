import { randomUUID } from "node:crypto";

export type RuntimeComponent = "WORKER" | "OUTBOX_RELAY";
export type RuntimeComponentState = "RUNNING" | "STOPPED";

interface LeaseDatabase {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
}

interface RuntimeComponentLeaseOptions {
  instanceId?: string;
  now?: () => Date;
}

/**
 * A durable process lease. Each process owns one immutable instance id and only
 * advances its own row. Health checks read the lease from PostgreSQL, so an API
 * process cannot claim a separate Worker is alive from local memory alone.
 */
export class RuntimeComponentLease {
  readonly instanceId: string;
  private readonly startedAt: Date;
  private readonly now: () => Date;
  private active = false;

  constructor(
    private readonly db: LeaseDatabase,
    readonly component: RuntimeComponent,
    options: RuntimeComponentLeaseOptions = {},
  ) {
    this.instanceId = options.instanceId ?? randomUUID();
    this.now = options.now ?? (() => new Date());
    this.startedAt = this.now();
  }

  async start(metadata: Record<string, unknown> = {}): Promise<void> {
    await this.write("RUNNING", metadata);
    this.active = true;
  }

  async renew(metadata: Record<string, unknown> = {}): Promise<void> {
    if (!this.active) return;
    await this.write("RUNNING", metadata);
  }

  async stop(metadata: Record<string, unknown> = {}): Promise<void> {
    if (!this.active) return;
    this.active = false;
    await this.write("STOPPED", metadata);
  }

  private async write(
    state: RuntimeComponentState,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const heartbeatAt = this.now();
    await this.db.$executeRawUnsafe(
      `INSERT INTO runtime_component_heartbeat
         (component, instance_id, state, started_at, heartbeat_at, metadata, updated_at)
       VALUES ($1, $2::uuid, $3, $4, $5, $6::jsonb, $5)
       ON CONFLICT (component, instance_id) DO UPDATE SET
         state = EXCLUDED.state,
         heartbeat_at = EXCLUDED.heartbeat_at,
         metadata = EXCLUDED.metadata,
         updated_at = EXCLUDED.updated_at`,
      this.component,
      this.instanceId,
      state,
      this.startedAt,
      heartbeatAt,
      JSON.stringify(metadata),
    );
  }
}

export const RUNTIME_HEARTBEAT_INTERVAL_MS = 5_000;
export const RUNTIME_HEARTBEAT_STALE_MS = 20_000;
