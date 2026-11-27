import { Logger } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';

export const TENANT_DAILY_COST_ANOMALY_USD_ENV = 'TENANT_DAILY_COST_ANOMALY_USD' as const;
export const TENANT_DAILY_COST_BREAKER = Symbol('TENANT_DAILY_COST_BREAKER');
export const DEFAULT_TENANT_DAILY_COST_ANOMALY_USD = 50;
const DEFAULT_CACHE_TTL_MS = 15_000;
const MAX_CACHED_WORKSPACES = 2_048;

export interface TenantDailyCostAlertEvent {
  readonly eventType: 'TenantDailyCostAnomalyTripped';
  readonly workspaceId: string;
  readonly dailySpendUsd: number;
  readonly thresholdUsd: number;
  readonly utcDay: string;
  readonly task: string;
  readonly observedAt: string;
}

export class TenantDailyCostAnomalyError extends Error {
  readonly code = 'TENANT_DAILY_COST_ANOMALY_TRIPPED' as const;
  readonly statusCode = 429;

  constructor(
    public readonly workspaceId: string,
    public readonly dailySpendUsd: number,
    public readonly thresholdUsd: number,
  ) {
    super(
      `tenant daily model cost anomaly circuit tripped: workspace=${workspaceId} spend=$${dailySpendUsd.toFixed(4)} >= threshold=$${thresholdUsd.toFixed(2)}`,
    );
    this.name = 'TenantDailyCostAnomalyError';
  }
}

export function resolveTenantDailyCostThresholdUsd(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = env[TENANT_DAILY_COST_ANOMALY_USD_ENV]?.trim();
  if (!raw) return DEFAULT_TENANT_DAILY_COST_ANOMALY_USD;
  if (raw.toLowerCase() === 'off' || raw === '0') return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_TENANT_DAILY_COST_ANOMALY_USD;
  }
  return parsed === 0 ? null : parsed;
}

export interface TenantDailyCostReader {
  readDailySpendUsd(workspaceId: string, dayStartUtc: Date): Promise<number>;
}

export function createPrismaTenantDailyCostReader(
  prisma: PrismaService,
): TenantDailyCostReader {
  return {
    async readDailySpendUsd(workspaceId: string, dayStartUtc: Date): Promise<number> {
      return prisma.withWorkspace(workspaceId, async (tx) => {
        // V3 records both estimates and non-model charges for reporting.
        // Only its confirmed model charges contribute to this breaker.
        const [spend] = await tx.$queryRaw<Array<{ total: number }>>`
          SELECT COALESCE(sum(cost_usd), 0) AS total
          FROM public.usage_ledger
          WHERE workspace_id = ${workspaceId}::uuid AND created_at >= ${dayStartUtc}
            AND (
              (meta->>'executionContractVersion') IS DISTINCT FROM '3'
              OR (resource_type = 'ai_tokens' AND meta->>'costSource' = 'provider')
            )
        `;
        const total = Number(spend?.total ?? 0);
        return Number.isFinite(total) && total > 0 ? total : 0;
      });
    },
  };
}

export interface TenantDailyCostBreakerOptions {
  readonly reader: TenantDailyCostReader;
  readonly thresholdUsd?: number | null;
  readonly cacheTtlMs?: number;
  readonly now?: () => Date;
  readonly onAlert?: (event: TenantDailyCostAlertEvent) => void | Promise<void>;
}

interface CacheEntry {
  readonly utcDay: string;
  readonly spendUsd: number;
  readonly fetchedAtMs: number;
}

function utcDayStart(now: Date): { utcDay: string; start: Date } {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
  return { utcDay: start.toISOString().slice(0, 10), start };
}

/**
 * Per-tenant UTC daily USD anomaly circuit breaker backed by `usage_ledger`.
 * - Short TTL in-memory cache avoids hammering PostgreSQL on every LLM call.
 * - Immediately reflects newly observed spend via `recordObservedSpend(...)`.
 * - Trips with `TenantDailyCostAnomalyError` + structured alert event when
 *   daily underlying USD spend reaches or exceeds the configured threshold.
 * - Fails open on transient DB read errors so observability DB blips do not
 *   cause a full platform outage (existing rate limits and task caps remain active).
 */
export class TenantDailyCostBreaker {
  private readonly logger = new Logger('TenantDailyCostBreaker');
  private readonly thresholdUsd: number | null;
  private readonly cacheTtlMs: number;
  private readonly now: () => Date;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly alertedDays = new Set<string>();

  constructor(private readonly options: TenantDailyCostBreakerOptions) {
    this.thresholdUsd =
      options.thresholdUsd !== undefined
        ? options.thresholdUsd
        : resolveTenantDailyCostThresholdUsd();
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
    this.now = options.now ?? (() => new Date());
  }

  getThresholdUsd(): number | null {
    return this.thresholdUsd;
  }

  recordObservedSpend(workspaceId: string, deltaUsd: number): void {
    if (!Number.isFinite(deltaUsd) || deltaUsd <= 0) return;
    const now = this.now();
    const { utcDay } = utcDayStart(now);
    const existing = this.cache.get(workspaceId);
    if (existing && existing.utcDay === utcDay) {
      this.cache.set(workspaceId, {
        utcDay,
        spendUsd: existing.spendUsd + deltaUsd,
        fetchedAtMs: existing.fetchedAtMs,
      });
    }
  }

  async assertAllowed(workspaceId: string, task: string): Promise<void> {
    if (this.thresholdUsd === null || !workspaceId || workspaceId === 'platform') {
      return;
    }
    const now = this.now();
    const nowMs = now.getTime();
    const { utcDay, start } = utcDayStart(now);
    let spendUsd: number;
    const cached = this.cache.get(workspaceId);
    if (
      cached &&
      cached.utcDay === utcDay &&
      nowMs - cached.fetchedAtMs < this.cacheTtlMs
    ) {
      spendUsd = cached.spendUsd;
    } else {
      try {
        spendUsd = await this.options.reader.readDailySpendUsd(workspaceId, start);
      } catch (err) {
        this.logger.warn(
          `daily cost breaker read failed for workspace=${workspaceId}: ${err instanceof Error ? err.message.slice(0, 160) : 'unknown'}`,
        );
        return;
      }
      if (!this.cache.has(workspaceId) && this.cache.size >= MAX_CACHED_WORKSPACES) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.set(workspaceId, { utcDay, spendUsd, fetchedAtMs: nowMs });
    }

    if (spendUsd >= this.thresholdUsd) {
      const alertKey = `${workspaceId}:${utcDay}`;
      if (!this.alertedDays.has(alertKey)) {
        if (this.alertedDays.size >= MAX_CACHED_WORKSPACES) {
          const oldestAlert = this.alertedDays.values().next().value;
          if (oldestAlert !== undefined) this.alertedDays.delete(oldestAlert);
        }
        this.alertedDays.add(alertKey);
        const event: TenantDailyCostAlertEvent = {
          eventType: 'TenantDailyCostAnomalyTripped',
          workspaceId,
          dailySpendUsd: spendUsd,
          thresholdUsd: this.thresholdUsd,
          utcDay,
          task,
          observedAt: now.toISOString(),
        };
        this.logger.error(
          `[cost-anomaly] workspace=${workspaceId} spend=$${spendUsd.toFixed(4)} >= threshold=$${this.thresholdUsd.toFixed(2)} task=${task}`,
        );
        try {
          await this.options.onAlert?.(event);
        } catch {
          // Alert sink error must never suppress the circuit breaker denial.
        }
      }
      throw new TenantDailyCostAnomalyError(workspaceId, spendUsd, this.thresholdUsd);
    }
  }
}
