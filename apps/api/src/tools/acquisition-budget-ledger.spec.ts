import { describe, expect, it } from 'vitest';
import {
  AcquisitionBudgetError,
  InMemoryAcquisitionBudgetLedger,
  ZERO_BUDGET_AMOUNT,
  type AcquisitionBudgetAuthorization,
  type BudgetAmount,
} from './acquisition-budget-ledger';

const NOW = new Date('2026-08-07T12:00:00.000Z');

function amount(over: Partial<BudgetAmount> = {}): BudgetAmount {
  return {
    requestCount: 0n,
    callCount: 0n,
    recordCount: 0n,
    modelCallCount: 0n,
    costMinor: 0n,
    ...over,
  };
}

function authorization(
  over: Partial<AcquisitionBudgetAuthorization> = {},
): AcquisitionBudgetAuthorization {
  return {
    accountId: 'budget-001',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    runId: '22222222-2222-4222-8222-222222222222',
    purpose: 'discovery',
    targetKind: 'TOOL',
    targetId: 'openfda.search',
    currency: 'USD',
    billingUnit: 'cent',
    limits: amount({
      requestCount: 2n,
      callCount: 2n,
      recordCount: 100n,
      costMinor: 20n,
    }),
    expiresAt: new Date('2026-08-07T12:15:00.000Z'),
    ...over,
  };
}

function reserveInput(over: Record<string, unknown> = {}) {
  return {
    accountId: 'budget-001',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    runId: '22222222-2222-4222-8222-222222222222',
    purpose: 'discovery',
    targetKind: 'TOOL' as const,
    targetId: 'openfda.search',
    executionId: 'workflow-123:activity-7',
    attempt: 1,
    requestFingerprint: 'a'.repeat(64),
    maximum: amount({
      requestCount: 1n,
      callCount: 1n,
      recordCount: 50n,
      costMinor: 10n,
    }),
    ...over,
  };
}

describe('InMemoryAcquisitionBudgetLedger — explicit finite authorization', () => {
  it('rejects a missing account and never creates one from reserve()', async () => {
    const ledger = new InMemoryAcquisitionBudgetLedger(() => NOW);

    await expect(ledger.reserve(reserveInput())).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_FOUND',
    });
    expect(await ledger.inspectAccount('budget-001')).toBeNull();
  });

  it('rejects expired, unbounded, or identity-incomplete authorization', async () => {
    const ledger = new InMemoryAcquisitionBudgetLedger(() => NOW);

    await expect(
      ledger.openAccount(authorization({ expiresAt: NOW })),
    ).rejects.toBeInstanceOf(AcquisitionBudgetError);
    await expect(
      ledger.openAccount(authorization({ accountId: 'budget-zero', limits: ZERO_BUDGET_AMOUNT })),
    ).rejects.toMatchObject({ code: 'INVALID_AUTHORIZATION' });
    await expect(
      ledger.openAccount(authorization({ accountId: 'budget-targetless', targetId: '' })),
    ).rejects.toMatchObject({ code: 'INVALID_AUTHORIZATION' });
    await expect(
      ledger.openAccount(
        authorization({
          accountId: 'budget-overflow',
          limits: amount({ requestCount: 1n << 63n }),
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_AUTHORIZATION' });
  });

  it('opens once and only replays byte-equivalent authorization', async () => {
    const ledger = new InMemoryAcquisitionBudgetLedger(() => NOW);
    expect(await ledger.openAccount(authorization())).toEqual({ kind: 'opened' });
    expect(await ledger.openAccount(authorization())).toEqual({ kind: 'replay' });

    await expect(
      ledger.openAccount(
        authorization({ limits: amount({ requestCount: 3n, callCount: 2n, recordCount: 100n, costMinor: 20n }) }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('canonicalizes authorization object key order before replay comparison', async () => {
    const ledger = new InMemoryAcquisitionBudgetLedger(() => NOW);
    const first = authorization();
    const reordered = {
      expiresAt: first.expiresAt,
      limits: {
        costMinor: first.limits.costMinor,
        modelCallCount: first.limits.modelCallCount,
        recordCount: first.limits.recordCount,
        callCount: first.limits.callCount,
        requestCount: first.limits.requestCount,
      },
      billingUnit: first.billingUnit,
      currency: first.currency,
      targetId: first.targetId,
      targetKind: first.targetKind,
      purpose: first.purpose,
      runId: first.runId,
      workspaceId: first.workspaceId,
      accountId: first.accountId,
    };

    await expect(ledger.openAccount(first)).resolves.toEqual({ kind: 'opened' });
    await expect(ledger.openAccount(reordered)).resolves.toEqual({ kind: 'replay' });
  });
});

describe('InMemoryAcquisitionBudgetLedger — atomic reserve and settle', () => {
  it('binds workspace/run/purpose/target/execution/attempt and rejects payload drift', async () => {
    const ledger = new InMemoryAcquisitionBudgetLedger(() => NOW);
    await ledger.openAccount(authorization());

    const first = await ledger.reserve(reserveInput());
    expect(first.kind).toBe('reserved');
    const replay = await ledger.reserve(reserveInput());
    expect(replay).toMatchObject({ kind: 'replay', reservationId: first.reservationId });

    await expect(
      ledger.reserve(
        reserveInput({ maximum: amount({ requestCount: 1n, callCount: 1n, recordCount: 49n, costMinor: 10n }) }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      ledger.reserve(reserveInput({ targetId: 'ted.search' })),
    ).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
  });

  it('serializes concurrent reservations and persists EXHAUSTED conservatively', async () => {
    const ledger = new InMemoryAcquisitionBudgetLedger(() => NOW);
    await ledger.openAccount(
      authorization({
        limits: amount({ requestCount: 1n, callCount: 1n, recordCount: 50n, costMinor: 10n }),
      }),
    );

    const results = await Promise.allSettled([
      ledger.reserve(reserveInput({ executionId: 'exec-a' })),
      ledger.reserve(reserveInput({ executionId: 'exec-b' })),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await ledger.inspectAccount('budget-001')).toMatchObject({ status: 'EXHAUSTED' });
    await expect(
      ledger.reserve(reserveInput({ executionId: 'exec-c' })),
    ).rejects.toMatchObject({ code: 'ACCOUNT_EXHAUSTED' });
  });

  it('settles actual integer usage, releases the unused maximum, and replays exactly', async () => {
    const ledger = new InMemoryAcquisitionBudgetLedger(() => NOW);
    await ledger.openAccount(authorization());
    const reservation = await ledger.reserve(reserveInput());
    const actual = amount({ requestCount: 1n, callCount: 1n, recordCount: 12n, costMinor: 4n });

    const settled = await ledger.settle({
      reservation,
      outcome: 'SETTLED',
      actual,
    });
    expect(settled).toMatchObject({ kind: 'settled', charged: actual });
    expect((await ledger.inspectAccount('budget-001'))?.remaining).toEqual(
      amount({ requestCount: 1n, callCount: 1n, recordCount: 88n, costMinor: 16n }),
    );
    expect(
      await ledger.settle({ reservation, outcome: 'SETTLED', actual }),
    ).toMatchObject({ kind: 'replay' });
    await expect(
      ledger.settle({ reservation, outcome: 'RELEASED', actual: ZERO_BUDGET_AMOUNT }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('unknown settlement charges the full reservation and freezes the authorization', async () => {
    const ledger = new InMemoryAcquisitionBudgetLedger(() => NOW);
    await ledger.openAccount(authorization());
    const reservation = await ledger.reserve(reserveInput());

    expect(
      await ledger.settle({ reservation, outcome: 'UNKNOWN' }),
    ).toMatchObject({ kind: 'unknown', charged: reservation.maximum });
    expect(await ledger.inspectAccount('budget-001')).toMatchObject({ status: 'FROZEN' });
    await expect(
      ledger.reserve(reserveInput({ executionId: 'next-exec', attempt: 2 })),
    ).rejects.toMatchObject({ code: 'ACCOUNT_FROZEN' });
    await expect(ledger.reserve(reserveInput())).resolves.toMatchObject({
      kind: 'replay',
      reservationId: reservation.reservationId,
    });
  });

  it('actual usage above the reservation is treated as unknown and freezes instead of overspending', async () => {
    const ledger = new InMemoryAcquisitionBudgetLedger(() => NOW);
    await ledger.openAccount(authorization());
    const reservation = await ledger.reserve(reserveInput());

    const result = await ledger.settle({
      reservation,
      outcome: 'SETTLED',
      actual: amount({ requestCount: 1n, callCount: 1n, recordCount: 51n, costMinor: 10n }),
    });
    expect(result).toMatchObject({ kind: 'unknown', charged: reservation.maximum });
    expect(await ledger.inspectAccount('budget-001')).toMatchObject({ status: 'FROZEN' });
  });

  it('rejects malformed runtime settlement values before state changes', async () => {
    const ledger = new InMemoryAcquisitionBudgetLedger(() => NOW);
    await ledger.openAccount(authorization());
    const reservation = await ledger.reserve(reserveInput());

    await expect(
      ledger.settle({
        reservation,
        outcome: 'NOT_AN_OUTCOME' as 'SETTLED',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESERVATION' });
    await expect(
      ledger.settle({
        reservation,
        outcome: 'RELEASED',
        actual: amount({ requestCount: 1n }),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESERVATION' });
    await expect(
      ledger.reserve(
        reserveInput({
          executionId: 'attempt-overflow',
          attempt: 2_147_483_648,
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_RESERVATION' });
  });
});
