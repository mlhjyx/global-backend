/**
 * 外部付费 API 每日调用上限（按 UTC 自然日计数，fail-closed）。
 *
 * 设计目标：
 *  - 在物理出网（beforePhysicalWire）之前拦截超额调用，使 ToolBroker 释放预算预占、实际花费 0¢；
 *  - 默认使用进程内按 UTC 日分桶的有界计数器（自动清理历史日期桶防内存增长），
 *    也支持注入共享存储（如 Redis INCR + EXPIRE）以实现多副本集群级日限额；
 *  - env 配置值做严格纯整数校验与安全上界钳制，畸形值回退安全默认值，绝不静默放开。
 */

export const DEFAULT_GOOGLE_PLACES_DAILY_CALL_LIMIT = 200;
export const MAX_GOOGLE_PLACES_DAILY_CALL_LIMIT = 2_000;
const UTC_DAY_TTL_SECONDS = 90_000; // 25h，覆盖整日并留余量
const MAX_LOCAL_DAY_BUCKETS = 8;

export interface DailyCallQuotaResult {
  readonly allowed: boolean;
  readonly count: number;
  readonly limit: number;
  readonly day: string;
}

export interface DailyCallQuotaStore {
  consume(bucketKey: string, limit: number, ttlSeconds: number): Promise<{ allowed: boolean; count: number }>;
}

/**
 * 超出每日调用上限时抛出；仅保留标准 PLAIN_FAILURE_KEYS（name/code/message/stack），
 * 确保 isExecutionControlError 将其识别为普通业务降级错误而非控制面中止异常。
 */
export class DailyCallQuotaExceededError extends Error {
  readonly code: string;

  constructor(code: string, info: Readonly<{ day: string; limit: number; count: number }>) {
    super(`${code}: daily call limit ${info.limit} reached for ${info.day} (count=${info.count})`);
    this.name = 'DailyCallQuotaExceededError';
    this.code = code;
  }
}

/**
 * 解析每日调用上限：
 *  - `'0'` 显式表示当日禁调（0 次）；
 *  - 纯十进制正整数按 `[1, maximum]` 钳制；
 *  - 缺省或畸形值（小数、负数、科学计数、含字母）回退安全默认值 `fallback`。
 */
export function resolveDailyCallLimit(
  raw: string | undefined,
  fallback: number = DEFAULT_GOOGLE_PLACES_DAILY_CALL_LIMIT,
  maximum: number = MAX_GOOGLE_PLACES_DAILY_CALL_LIMIT,
): number {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return fallback;
  if (!/^\d+$/u.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, maximum);
}

export function resolveGooglePlacesDailyCallLimit(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return resolveDailyCallLimit(
    env.GOOGLE_PLACES_DAILY_CALL_LIMIT,
    DEFAULT_GOOGLE_PLACES_DAILY_CALL_LIMIT,
    MAX_GOOGLE_PLACES_DAILY_CALL_LIMIT,
  );
}

/** 进程内按日分桶计数器：同步原子递增（Node 单线程事件循环内无竞态），超限时回滚计数。 */
export function createInMemoryDailyCallQuotaStore(): DailyCallQuotaStore {
  const buckets = new Map<string, number>();

  function pruneOldBuckets(keepKey: string): void {
    if (buckets.size <= MAX_LOCAL_DAY_BUCKETS) return;
    for (const key of buckets.keys()) {
      if (key !== keepKey) {
        buckets.delete(key);
        if (buckets.size <= MAX_LOCAL_DAY_BUCKETS) break;
      }
    }
  }

  return {
    async consume(bucketKey: string, limit: number): Promise<{ allowed: boolean; count: number }> {
      const current = buckets.get(bucketKey) ?? 0;
      if (limit <= 0 || current >= limit) {
        return { allowed: false, count: current };
      }
      const next = current + 1;
      buckets.set(bucketKey, next);
      pruneOldBuckets(bucketKey);
      return { allowed: true, count: next };
    },
  };
}

export interface DailyCallQuotaLimiter {
  consume(): Promise<DailyCallQuotaResult>;
}

export function createDailyCallQuotaLimiter(options: {
  readonly scope: string;
  readonly resolveLimit: () => number;
  readonly store?: DailyCallQuotaStore;
  readonly now?: () => Date;
}): DailyCallQuotaLimiter {
  const store = options.store ?? createInMemoryDailyCallQuotaStore();
  const now = options.now ?? (() => new Date());

  return {
    async consume(): Promise<DailyCallQuotaResult> {
      const day = now().toISOString().slice(0, 10);
      const limit = options.resolveLimit();
      const bucketKey = `daily_quota:${options.scope}:${day}`;
      const outcome = await store.consume(bucketKey, limit, UTC_DAY_TTL_SECONDS);
      return {
        allowed: outcome.allowed,
        count: outcome.count,
        limit,
        day,
      };
    },
  };
}

/** 进程级默认 Google Places 日配额限流器（供默认工具实例共享）。 */
export const sharedGooglePlacesDailyQuota: DailyCallQuotaLimiter = createDailyCallQuotaLimiter({
  scope: 'google_places.discover',
  resolveLimit: () => resolveGooglePlacesDailyCallLimit(),
});
