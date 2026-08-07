import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  PrismaAcquisitionBudgetLedger,
  type WorkspaceTransactionRunner,
} from './prisma-acquisition-budget-ledger';
import type { AcquisitionBudgetAuthorization, BudgetAmount } from './acquisition-budget-ledger';

const amount = (over: Partial<BudgetAmount> = {}): BudgetAmount => ({
  requestCount: 0n,
  callCount: 0n,
  recordCount: 0n,
  modelCallCount: 0n,
  costMinor: 0n,
  ...over,
});

const auth: AcquisitionBudgetAuthorization = {
  accountId: 'budget-prisma-1',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  purpose: 'discovery',
  targetKind: 'SOURCE',
  targetId: 'openfda',
  currency: 'USD',
  billingUnit: 'cent',
  limits: amount({ requestCount: 2n, callCount: 2n, recordCount: 100n, costMinor: 20n }),
  expiresAt: new Date('2027-08-07T12:15:00.000Z'),
};

function fakePrisma(rows: unknown[]) {
  const query = vi.fn(async (sql: Prisma.Sql) => {
    expect(sql).toEqual(expect.objectContaining({ strings: expect.any(Array), values: expect.any(Array) }));
    return rows;
  });
  const withWorkspace = vi.fn(async (_workspaceId: string, operation: (tx: unknown) => Promise<unknown>) =>
    operation({ $queryRaw: query }),
  );
  return {
    prisma: { withWorkspace } as WorkspaceTransactionRunner,
    query,
    withWorkspace,
  };
}

describe('PrismaAcquisitionBudgetLedger repository contract', () => {
  it('opens only through the workspace transaction and parameterized SQL function', async () => {
    const { prisma, query, withWorkspace } = fakePrisma([{ decision: 'OPENED' }]);
    const ledger = new PrismaAcquisitionBudgetLedger(prisma);

    await expect(ledger.openAccount(auth)).resolves.toEqual({ kind: 'opened' });
    expect(withWorkspace).toHaveBeenCalledWith(auth.workspaceId, expect.any(Function));
    const sql = query.mock.calls[0]?.[0] as Prisma.Sql;
    expect(sql.sql).toContain('open_acquisition_budget_account');
    expect(sql.values).toContain(auth.accountId);
    expect(sql.sql).not.toContain(auth.targetId);
  });

  it('maps an atomic reserve replay and sends all identity dimensions as values', async () => {
    const { prisma, query } = fakePrisma([
      {
        decision: 'REPLAY',
        reservation_id: 'reservation-1',
        account_status: 'ACTIVE',
      },
    ]);
    const ledger = new PrismaAcquisitionBudgetLedger(prisma);
    const input = {
      accountId: auth.accountId,
      workspaceId: auth.workspaceId,
      runId: auth.runId,
      purpose: auth.purpose,
      targetKind: auth.targetKind,
      targetId: auth.targetId,
      executionId: 'workflow-1:activity-2',
      attempt: 2,
      requestFingerprint: 'b'.repeat(64),
      maximum: amount({ requestCount: 1n, callCount: 1n, recordCount: 50n, costMinor: 10n }),
    } as const;

    await expect(ledger.reserve(input)).resolves.toMatchObject({
      kind: 'replay',
      reservationId: 'reservation-1',
    });
    const sql = query.mock.calls[0]?.[0] as Prisma.Sql;
    for (const value of [
      input.workspaceId,
      input.runId,
      input.accountId,
      input.purpose,
      input.targetKind,
      input.targetId,
      input.executionId,
      input.attempt,
    ]) {
      expect(sql.values).toContain(value);
    }
  });

  it('fails closed on EXHAUSTED/FROZEN/EXPIRED decisions without inventing a reservation', async () => {
    for (const decision of ['EXHAUSTED', 'FROZEN', 'EXPIRED'] as const) {
      const { prisma } = fakePrisma([{ decision, reservation_id: null, account_status: decision }]);
      const ledger = new PrismaAcquisitionBudgetLedger(prisma);
      await expect(
        ledger.reserve({
          accountId: auth.accountId,
          workspaceId: auth.workspaceId,
          runId: auth.runId,
          purpose: auth.purpose,
          targetKind: auth.targetKind,
          targetId: auth.targetId,
          executionId: `exec-${decision}`,
          attempt: 1,
          requestFingerprint: 'c'.repeat(64),
          maximum: amount({ requestCount: 1n }),
        }),
      ).rejects.toMatchObject({ code: `ACCOUNT_${decision}` });
    }
  });

  it('rejects incomplete reserve identity before opening a database transaction', async () => {
    const { prisma, withWorkspace } = fakePrisma([]);
    const ledger = new PrismaAcquisitionBudgetLedger(prisma);

    await expect(
      ledger.reserve({
        accountId: auth.accountId,
        workspaceId: auth.workspaceId,
        runId: auth.runId,
        purpose: auth.purpose,
        targetKind: auth.targetKind,
        targetId: '',
        executionId: 'exec-invalid',
        attempt: 1,
        requestFingerprint: 'c'.repeat(64),
        maximum: amount({ requestCount: 1n }),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESERVATION' });
    expect(withWorkspace).not.toHaveBeenCalled();
  });

  it('maps UNKNOWN settlement as a full charge and frozen account', async () => {
    const maximum = amount({ requestCount: 1n, callCount: 1n, recordCount: 50n, costMinor: 10n });
    const { prisma } = fakePrisma([
      {
        decision: 'UNKNOWN',
        reservation_status: 'UNKNOWN',
        account_status: 'FROZEN',
      },
    ]);
    const ledger = new PrismaAcquisitionBudgetLedger(prisma);
    const reservation = {
      kind: 'reserved' as const,
      reservationId: 'reservation-unknown',
      accountId: auth.accountId,
      workspaceId: auth.workspaceId,
      runId: auth.runId,
      purpose: auth.purpose,
      targetKind: auth.targetKind,
      targetId: auth.targetId,
      executionId: 'exec-unknown',
      attempt: 1,
      requestFingerprint: 'd'.repeat(64),
      maximum,
    };

    await expect(ledger.settle({ reservation, outcome: 'UNKNOWN' })).resolves.toMatchObject({
      kind: 'unknown',
      charged: maximum,
      accountStatus: 'FROZEN',
    });
  });
});
