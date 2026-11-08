/**
 * ch08 §3.1.12 制裁陈旧门：名单新鲜度判定（纯函数，可单测）。
 *
 * 三档（阈值 env 可配，默认 7 / 14 天）：
 *  - fresh：ageDays <= maxAgeDays 且无 FAILED 源 → 正常筛查；
 *  - stale（降级）：ageDays > maxAgeDays 或任一源 last_fetch_status=FAILED → 筛查仍跑，
 *    但结果不得自动清白（qualify 不产 recommended；accept 不认 clear）；
 *  - blocked（熔断）：ageDays > blockAgeDays，或任一 ENABLED 源从未刷新（无新鲜度证据）
 *    → qualify 整批进 sanctions_hold。
 *
 * 无 ENABLED 源 → inactive：筛查门本身未启用（设计决策⑤ fail-open），本门不改变现状。
 */

export interface SanctionsSourceFreshnessRow {
  readonly key: string;
  readonly lastRefreshedAt: Date | null;
  readonly lastFetchStatus: string | null;
}

export interface SanctionsFreshnessThresholds {
  readonly maxAgeDays: number;
  readonly blockAgeDays: number;
}

export type SanctionsListFreshnessReason = 'inactive' | 'fresh' | 'stale' | 'blocked';

export interface SanctionsListFreshness {
  readonly active: boolean;
  readonly ageDays: number | null;
  readonly maxAgeDays: number;
  readonly blockAgeDays: number;
  readonly stale: boolean;
  readonly blocked: boolean;
  readonly reason: SanctionsListFreshnessReason;
  readonly sources: ReadonlyArray<{
    readonly key: string;
    readonly lastRefreshedAt: string | null;
    readonly lastFetchStatus: string | null;
  }>;
}

export const SANCTIONS_LIST_MAX_AGE_DAYS_DEFAULT = 7;
export const SANCTIONS_LIST_BLOCK_AGE_DAYS_DEFAULT = 14;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function sanctionsFreshnessThresholds(
  env: NodeJS.ProcessEnv = process.env,
): SanctionsFreshnessThresholds {
  const maxAgeDays = positiveInt(
    env.SANCTIONS_LIST_MAX_AGE_DAYS,
    SANCTIONS_LIST_MAX_AGE_DAYS_DEFAULT,
  );
  const blockAgeDaysRaw = positiveInt(
    env.SANCTIONS_LIST_BLOCK_AGE_DAYS,
    SANCTIONS_LIST_BLOCK_AGE_DAYS_DEFAULT,
  );
  // 熔断阈值不得小于降级阈值；配置写错时取两者较大值（更保守）。
  const blockAgeDays = Math.max(blockAgeDaysRaw, maxAgeDays);
  return { maxAgeDays, blockAgeDays };
}

const DAY_MS = 86_400_000;

export function evaluateSanctionsFreshness(
  rows: readonly SanctionsSourceFreshnessRow[],
  now: Date,
  thresholds: SanctionsFreshnessThresholds,
): SanctionsListFreshness {
  const sources = rows.map((row) => ({
    key: row.key,
    lastRefreshedAt: row.lastRefreshedAt?.toISOString() ?? null,
    lastFetchStatus: row.lastFetchStatus,
  }));
  const base = {
    maxAgeDays: thresholds.maxAgeDays,
    blockAgeDays: thresholds.blockAgeDays,
    sources,
  };
  if (rows.length === 0) {
    return { active: false, ageDays: null, stale: false, blocked: false, reason: 'inactive', ...base };
  }

  let newest: number | null = null;
  let neverRefreshed = false;
  for (const row of rows) {
    if (row.lastRefreshedAt === null) {
      neverRefreshed = true;
      continue;
    }
    const ms = row.lastRefreshedAt.getTime();
    if (newest === null || ms > newest) newest = ms;
  }
  const ageDays = newest === null ? null : Math.floor((now.getTime() - newest) / DAY_MS);
  const anyFailed = rows.some((row) => row.lastFetchStatus === 'FAILED');

  const blocked = neverRefreshed || (ageDays !== null && ageDays > thresholds.blockAgeDays);
  const stale =
    blocked || anyFailed || (ageDays !== null && ageDays > thresholds.maxAgeDays);

  return {
    active: true,
    ageDays,
    stale,
    blocked,
    reason: blocked ? 'blocked' : stale ? 'stale' : 'fresh',
    ...base,
  };
}
