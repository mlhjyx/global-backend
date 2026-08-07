import { Prisma } from '@prisma/client';

/** Stable signed 64-bit namespace for the global Outbox delivery-order writer. */
export const OUTBOX_RELAY_ADVISORY_LOCK_KEY = 7_004_276_319_420_091_101n;

export interface OutboxSingleWriterResult<T> {
  acquired: boolean;
  value?: T;
}

export interface OutboxSingleWriterPort {
  runExclusive<T>(work: () => Promise<T>): Promise<OutboxSingleWriterResult<T>>;
}

interface AdvisoryLockTransaction {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
}

interface AdvisoryLockDatabase {
  $transaction<T>(
    operation: (tx: AdvisoryLockTransaction) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T>;
}

/**
 * Holds pg_try_advisory_xact_lock for the complete callback. Transaction scope
 * is deliberate: success, callback failure, connection loss, and process death
 * all release the lock without depending on a pool returning the same session.
 */
export class PostgresOutboxSingleWriterRepository implements OutboxSingleWriterPort {
  constructor(private readonly db: AdvisoryLockDatabase) {}

  async runExclusive<T>(work: () => Promise<T>): Promise<OutboxSingleWriterResult<T>> {
    return this.db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<{ acquired: boolean }[]>(Prisma.sql`
          SELECT pg_try_advisory_xact_lock(${OUTBOX_RELAY_ADVISORY_LOCK_KEY}) AS acquired
        `);
        if (rows[0]?.acquired !== true) return { acquired: false };
        return { acquired: true, value: await work() };
      },
      // A webhook batch can legitimately span multiple 10s request timeouts.
      // The lock transaction contains no business writes, only lock lifetime.
      { maxWait: 5_000, timeout: 300_000 },
    );
  }
}
