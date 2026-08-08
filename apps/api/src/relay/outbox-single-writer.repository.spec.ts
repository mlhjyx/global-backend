import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  OUTBOX_RELAY_ADVISORY_LOCK_KEY,
  PostgresOutboxSingleWriterRepository,
} from './outbox-single-writer.repository';

function repositoryWithLocks(sequence: boolean[]) {
  const query = vi.fn(async (sql: Prisma.Sql) => {
    expect(sql).toEqual(expect.objectContaining({ strings: expect.any(Array), values: expect.any(Array) }));
    return [{ acquired: sequence.shift() ?? false }];
  });
  const transaction = vi.fn(async (operation: (tx: unknown) => Promise<unknown>) =>
    operation({ $queryRaw: query }),
  );
  return {
    repository: new PostgresOutboxSingleWriterRepository({ $transaction: transaction }),
    query,
    transaction,
  };
}

describe('PostgresOutboxSingleWriterRepository', () => {
  it('does not run a relay tick when this replica is not the lock holder', async () => {
    const { repository } = repositoryWithLocks([false]);
    const work = vi.fn(async () => 'must-not-run');

    await expect(repository.runExclusive(work)).resolves.toEqual({ acquired: false });
    expect(work).not.toHaveBeenCalled();
  });

  it('holds a transaction-scoped advisory lock for the complete tick', async () => {
    const { repository, query } = repositoryWithLocks([true]);
    const work = vi.fn(async () => 'done');

    await expect(repository.runExclusive(work)).resolves.toEqual({ acquired: true, value: 'done' });
    expect(work).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0]?.[0] as Prisma.Sql;
    expect(sql.sql).toContain('pg_try_advisory_xact_lock');
    expect(sql.values).toEqual([OUTBOX_RELAY_ADVISORY_LOCK_KEY]);
  });

  it('releases on work failure because the lock lifetime is the transaction, then allows a later holder', async () => {
    const { repository, transaction } = repositoryWithLocks([true, true]);
    await expect(
      repository.runExclusive(async () => {
        throw new Error('relay tick failed');
      }),
    ).rejects.toThrow('relay tick failed');

    await expect(repository.runExclusive(async () => 'recovered')).resolves.toEqual({
      acquired: true,
      value: 'recovered',
    });
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('fails closed when lock acquisition itself fails', async () => {
    const transaction = vi.fn(async () => {
      throw new Error('postgres unavailable');
    });
    const repository = new PostgresOutboxSingleWriterRepository({ $transaction: transaction });
    const work = vi.fn(async () => undefined);

    await expect(repository.runExclusive(work)).rejects.toThrow('postgres unavailable');
    expect(work).not.toHaveBeenCalled();
  });
});
