import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assertWorkspaceSuppressionPolicyLock,
  lockWorkspaceSuppressionPolicy,
} from './suppression-policy-lock';

// Explicitly opted-in, disposable PostgreSQL only. No tables or migrations required.
const databaseUrl = process.env.SUPPRESSION_LOCK_TEST_DATABASE_URL;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (
    url.protocol !== 'postgresql:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !['/suppression_lock_test', '/global_test'].includes(url.pathname)
  ) {
    throw new Error('suppression lock test requires a loopback test database');
  }
}

describe.runIf(Boolean(databaseUrl))('Prisma suppression lock on PostgreSQL', () => {
  const holder = new PrismaClient({ datasourceUrl: databaseUrl });
  const contender = new PrismaClient({ datasourceUrl: databaseUrl });
  afterAll(async () => {
    await Promise.all([holder.$disconnect(), contender.$disconnect()]);
  });

  async function canAcquire(workspaceId: string): Promise<boolean> {
    const rows = await contender.$queryRaw<Array<{ acquired: boolean }>>`
      SELECT pg_try_advisory_xact_lock(
        hashtextextended(${'acquisition-suppression-policy:' + workspaceId}, 0)
      ) AS acquired`;
    return rows[0].acquired;
  }

  it.each(['commit', 'rollback'] as const)(
    'isolates workspace locks and releases them after %s',
    async (outcome) => {
      const workspaceId = randomUUID();
      const rollback = new Error('intentional test rollback');
      const transaction = holder.$transaction(async (tx) => {
        const receipt = await lockWorkspaceSuppressionPolicy(tx, workspaceId);
        expect(Object.isFrozen(receipt)).toBe(true);
        expect(() => assertWorkspaceSuppressionPolicyLock(receipt, workspaceId)).not.toThrow();
        expect(await canAcquire(workspaceId)).toBe(false);
        expect(await canAcquire(randomUUID())).toBe(true);
        if (outcome === 'rollback') throw rollback;
      });
      if (outcome === 'rollback') await expect(transaction).rejects.toBe(rollback);
      else await transaction;
      expect(await canAcquire(workspaceId)).toBe(true);
    },
  );
});
