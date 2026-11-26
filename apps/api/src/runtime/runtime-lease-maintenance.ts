import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

const logger = new Logger("RuntimeLeaseMaintenance");

export const DEFAULT_RUNTIME_LEASE_RETENTION_DAYS = 7;
export const DEFAULT_RUNTIME_LEASE_STALE_SECONDS = 300;
export const DEFAULT_RUNTIME_LEASE_SWEEP_BATCH = 200;
export const DEFAULT_RUNTIME_LEASE_SWEEP_INTERVAL_MS = 3_600_000;

export interface RuntimeLeaseMaintenanceDb {
  $executeRaw(query: Prisma.Sql): Promise<number>;
}

export interface RuntimeLeaseMaintenanceOptions {
  /** Number of days to retain terminal `STOPPED` lease rows before deletion (1..90). */
  readonly retentionDays?: number;
  /** Seconds after `last_seen_at` before a non-STOPPED lease is considered a zombie (60..86400). */
  readonly staleSeconds?: number;
  /** Maximum rows modified per sweep batch (10..2000). */
  readonly batchSize?: number;
  /** Override clock for deterministic unit tests. */
  readonly now?: () => Date;
}

export interface RuntimeLeaseSweepResult {
  readonly status: "ok" | "skipped_disabled" | "skipped_permission" | "failed";
  readonly staleReclaimed: number;
  readonly expiredDeleted: number;
}

function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw?.trim()) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function isRuntimeLeaseMaintenanceEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.RUNTIME_LEASE_MAINTENANCE_ENABLED?.trim().toLowerCase();
  return raw !== "off" && raw !== "false" && raw !== "0";
}

export function resolveRuntimeLeaseMaintenanceConfig(
  env: NodeJS.ProcessEnv = process.env,
): {
  readonly enabled: boolean;
  readonly retentionDays: number;
  readonly staleSeconds: number;
  readonly batchSize: number;
  readonly intervalMs: number;
} {
  return Object.freeze({
    enabled: isRuntimeLeaseMaintenanceEnabled(env),
    retentionDays: boundedInt(
      env.RUNTIME_LEASE_RETENTION_DAYS,
      DEFAULT_RUNTIME_LEASE_RETENTION_DAYS,
      1,
      90,
    ),
    staleSeconds: boundedInt(
      env.RUNTIME_LEASE_STALE_SECONDS,
      DEFAULT_RUNTIME_LEASE_STALE_SECONDS,
      60,
      86_400,
    ),
    batchSize: boundedInt(
      env.RUNTIME_LEASE_SWEEP_BATCH,
      DEFAULT_RUNTIME_LEASE_SWEEP_BATCH,
      10,
      2_000,
    ),
    intervalMs: boundedInt(
      env.RUNTIME_LEASE_SWEEP_INTERVAL_MS,
      DEFAULT_RUNTIME_LEASE_SWEEP_INTERVAL_MS,
      60_000,
      86_400_000,
    ),
  });
}

function isPermissionDeniedError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : String(error ?? "");
  return (
    /permission denied/iu.test(message) ||
    /\b42501\b/u.test(message) ||
    /insufficient privilege/iu.test(message)
  );
}

/**
 * Reclaims zombie non-STOPPED leases whose heartbeat has expired beyond `staleSeconds`,
 * then purges terminal `STOPPED` lease rows older than `retentionDays` in bounded batches.
 *
 * Fail-soft on `app_user` connections that lack UPDATE/DELETE privileges on
 * `runtime_process_lease` (logs once and returns `skipped_permission`).
 */
export async function purgeExpiredRuntimeLeases(
  db: RuntimeLeaseMaintenanceDb,
  options: RuntimeLeaseMaintenanceOptions = {},
): Promise<RuntimeLeaseSweepResult> {
  const now = (options.now ?? (() => new Date()))();
  const retentionDays = Math.min(
    90,
    Math.max(1, Math.trunc(options.retentionDays ?? DEFAULT_RUNTIME_LEASE_RETENTION_DAYS)),
  );
  const staleSeconds = Math.min(
    86_400,
    Math.max(60, Math.trunc(options.staleSeconds ?? DEFAULT_RUNTIME_LEASE_STALE_SECONDS)),
  );
  const batchSize = Math.min(
    2_000,
    Math.max(10, Math.trunc(options.batchSize ?? DEFAULT_RUNTIME_LEASE_SWEEP_BATCH)),
  );

  const staleCutoff = new Date(now.getTime() - staleSeconds * 1000);
  const deleteCutoff = new Date(now.getTime() - retentionDays * 86_400_000);

  try {
    const staleReclaimed = await db.$executeRaw(Prisma.sql`
      WITH zombies AS (
        SELECT instance_id
        FROM public.runtime_process_lease
        WHERE state <> 'STOPPED'
          AND last_seen_at < ${staleCutoff}::timestamptz
        ORDER BY last_seen_at ASC
        LIMIT ${batchSize}::int
      )
      UPDATE public.runtime_process_lease
      SET state = 'STOPPED',
          stopped_at = COALESCE(stopped_at, ${now}::timestamptz)
      WHERE instance_id IN (SELECT instance_id FROM zombies)
    `);

    const expiredDeleted = await db.$executeRaw(Prisma.sql`
      WITH doomed AS (
        SELECT instance_id
        FROM public.runtime_process_lease
        WHERE state = 'STOPPED'
          AND last_seen_at < ${deleteCutoff}::timestamptz
        ORDER BY last_seen_at ASC
        LIMIT ${batchSize}::int
      )
      DELETE FROM public.runtime_process_lease
      WHERE instance_id IN (SELECT instance_id FROM doomed)
    `);

    if (staleReclaimed > 0 || expiredDeleted > 0) {
      logger.log(
        `runtime_process_lease sweep: reclaimed=${staleReclaimed} deleted=${expiredDeleted}`,
      );
    }

    return {
      status: "ok",
      staleReclaimed: Number(staleReclaimed) || 0,
      expiredDeleted: Number(expiredDeleted) || 0,
    };
  } catch (error) {
    if (isPermissionDeniedError(error)) {
      logger.warn(
        "runtime_process_lease sweep skipped: current DB role lacks maintenance privileges",
      );
      return {
        status: "skipped_permission",
        staleReclaimed: 0,
        expiredDeleted: 0,
      };
    }
    logger.warn(
      `runtime_process_lease sweep failed: ${String((error as Error)?.message ?? error).slice(0, 160)}`,
    );
    return {
      status: "failed",
      staleReclaimed: 0,
      expiredDeleted: 0,
    };
  }
}

export function startRuntimeLeaseMaintenance(
  db: RuntimeLeaseMaintenanceDb,
  env: NodeJS.ProcessEnv = process.env,
): { stop: () => void } {
  const cfg = resolveRuntimeLeaseMaintenanceConfig(env);
  if (!cfg.enabled) return { stop: () => undefined };

  let running = false;
  let permissionWarned = false;
  const runOnce = () => {
    if (running || permissionWarned) return;
    running = true;
    void purgeExpiredRuntimeLeases(db, {
      retentionDays: cfg.retentionDays,
      staleSeconds: cfg.staleSeconds,
      batchSize: cfg.batchSize,
    })
      .then((res) => {
        if (res.status === "skipped_permission") permissionWarned = true;
      })
      .finally(() => {
        running = false;
      });
  };

  runOnce();
  const timer = setInterval(runOnce, cfg.intervalMs);
  timer.unref();
  return {
    stop: () => clearInterval(timer),
  };
}

@Injectable()
export class RuntimeLeaseMaintenanceService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private handle: { stop: () => void } | null = null;

  constructor(@Optional() private readonly prisma?: PrismaService) {}

  onApplicationBootstrap(): void {
    if (!this.prisma) return;
    this.handle = startRuntimeLeaseMaintenance(this.prisma, process.env);
  }

  onModuleDestroy(): void {
    this.handle?.stop();
    this.handle = null;
  }
}
