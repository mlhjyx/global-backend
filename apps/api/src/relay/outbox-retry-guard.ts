/**
 * OutboxRelay Ring-1 P0 护栏（Batch 1.3-B）：
 *  1. OutboxDispatchBackoff：有界每事件指数退避（5s → 5min，上限 1000 条），
 *     防止前 20 条失败的 internal command 永久霸占 `take: BATCH_SIZE` 饿死后续所有事件（队头阻塞）；
 *  2. tryWithOutboxAdvisoryLock：可选 PG 会话咨询锁（OUTBOX_RELAY_ADVISORY_LOCK_ENABLED=true），
 *     保证多副本部署下 `outbox_delivery` 游标严格单写有序。
 */

const DEFAULT_BASE_BACKOFF_MS = 5_000;
const DEFAULT_MAX_BACKOFF_MS = 300_000;
const DEFAULT_MAX_ENTRIES = 1_000;
const OUTBOX_ADVISORY_LOCK_KEY = 927_143_209;

interface BackoffEntry {
  failures: number;
  nextRetryAtMs: number;
}

export class OutboxDispatchBackoff {
  private readonly entries = new Map<string, BackoffEntry>();

  constructor(
    private readonly baseMs = DEFAULT_BASE_BACKOFF_MS,
    private readonly maxMs = DEFAULT_MAX_BACKOFF_MS,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
  ) {}

  recordFailure(eventId: string, nowMs = Date.now()): number {
    this.prune(nowMs);
    const prev = this.entries.get(eventId);
    const failures = (prev?.failures ?? 0) + 1;
    const delayMs = Math.min(this.baseMs * 2 ** (failures - 1), this.maxMs);
    const nextRetryAtMs = nowMs + delayMs;
    if (this.entries.size >= this.maxEntries && !this.entries.has(eventId)) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    this.entries.set(eventId, { failures, nextRetryAtMs });
    return nextRetryAtMs;
  }

  clear(eventId: string): void {
    this.entries.delete(eventId);
  }

  coolingEventIds(nowMs = Date.now()): string[] {
    this.prune(nowMs);
    const cooling: string[] = [];
    for (const [eventId, entry] of this.entries) {
      if (entry.nextRetryAtMs > nowMs) cooling.push(eventId);
    }
    return cooling;
  }

  private prune(nowMs: number): void {
    for (const [eventId, entry] of this.entries) {
      if (entry.nextRetryAtMs <= nowMs) this.entries.delete(eventId);
    }
  }
}

export interface AdvisoryLockDb {
  $queryRaw?: <T = unknown>(query: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
}

/** 多副本单写保护：开启 OUTBOX_RELAY_ADVISORY_LOCK_ENABLED=true 且 DB 支持 $queryRaw 时串行化 tick。 */
export async function tryWithOutboxAdvisoryLock(
  db: AdvisoryLockDb,
  fn: () => Promise<void>,
  enabled = /^(1|true|on|yes)$/i.test(process.env.OUTBOX_RELAY_ADVISORY_LOCK_ENABLED ?? ''),
): Promise<boolean> {
  if (!enabled || typeof db.$queryRaw !== 'function') {
    await fn();
    return true;
  }
  const rows = (await db.$queryRaw<Array<{ locked?: boolean }>>`
    SELECT pg_try_advisory_lock(${OUTBOX_ADVISORY_LOCK_KEY}) AS locked
  `) as Array<{ locked?: boolean }>;
  if (!rows?.[0]?.locked) return false;
  try {
    await fn();
    return true;
  } finally {
    await db.$queryRaw`SELECT pg_advisory_unlock(${OUTBOX_ADVISORY_LOCK_KEY})`.catch(() => undefined);
  }
}
