import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import {
  BudgetAccountUnavailableError,
  BudgetExceededError,
  BudgetUnsettledOperationsError,
  InMemoryBudgetStoreAdapter,
  PostgresBudgetStore,
  UnavailableBudgetStore,
} from './budget-store';
import { BudgetLedger } from './budget';
import { projectGenericOperationResult } from './generic-operation-projection';

function fakePrisma(rows: unknown[][]): PrismaService {
  const queue = [...rows];
  return {
    withWorkspace: vi.fn(async (_workspaceId, fn) =>
      fn({
        $queryRaw: vi.fn(async () => queue.shift() ?? []),
      } as never)),
  } as unknown as PrismaService;
}

describe('PostgresBudgetStore', () => {
  it('maps an atomic reservation into a durable handle', async () => {
    const store = new PostgresBudgetStore(
      fakePrisma([
        [
          {
            kind: 'EXECUTE',
            operation_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
            reserved_cents: 12n,
            remaining_cents: 88n,
            status: 'RESERVED',
          },
        ],
      ]),
    );

    await expect(
      store.reserve({
        workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0',
        accountKey: 'run-1',
        operationKey: 'tool:v1:request-1',
        estimatedCents: 12,
      }),
    ).resolves.toEqual({
      workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0',
      accountKey: 'run-1',
      operationId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      estimatedCents: 12,
      replay: false,
    });
  });

  it('fails closed when the account is absent and preserves a budget denial', async () => {
    const unavailable = new PostgresBudgetStore(
      fakePrisma([[{ kind: 'ACCOUNT_UNAVAILABLE', operation_id: null, reserved_cents: 0n, remaining_cents: 0n }]]),
    );
    await expect(
      unavailable.reserve({ workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0', accountKey: 'missing', operationKey: 'op', estimatedCents: 1 }),
    ).rejects.toBeInstanceOf(BudgetAccountUnavailableError);

    const exceeded = new PostgresBudgetStore(
      fakePrisma([[{ kind: 'DENIED', operation_id: null, reserved_cents: 0n, remaining_cents: 3n }]]),
    );
    await expect(
      exceeded.reserve({ workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0', accountKey: 'run-1', operationKey: 'op', estimatedCents: 9 }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('maps the database account guard to the stable unavailable-account error', async () => {
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId, fn) =>
        fn({
          $queryRaw: vi.fn(async () => {
            throw new Error('TOOL_BUDGET_ACCOUNT_UNAVAILABLE');
          }),
        } as never)),
    } as unknown as PrismaService;
    const store = new PostgresBudgetStore(prisma);

    await expect(
      store.reserve({
        workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0',
        accountKey: 'missing',
        operationKey: 'op',
        estimatedCents: 1,
      }),
    ).rejects.toBeInstanceOf(BudgetAccountUnavailableError);
  });

  it('settles through the database and reports an observed cap variance', async () => {
    const store = new PostgresBudgetStore(
      fakePrisma([[{ charged_cents: 10n, observed_cents: 14n, cap_variance: true, status: 'SETTLED' }]]),
    );
    await expect(
      store.settle(
        {
          workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0',
          accountKey: 'run-1',
          operationId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
          estimatedCents: 10,
          replay: false,
        },
        14,
      ),
    ).resolves.toEqual({ chargedCents: 10, observedCents: 14, capVariance: true, replay: false });
  });

  it('releases a reservation without charging when execution never starts', async () => {
    const store = new PostgresBudgetStore(
      fakePrisma([[{ charged_cents: 0n, observed_cents: 0n, cap_variance: false, status: 'RELEASED' }]]),
    );
    await expect(
      store.release({
        workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0',
        accountKey: 'run-1',
        operationId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
        estimatedCents: 10,
        replay: false,
      }),
    ).resolves.toMatchObject({ chargedCents: 0, observedCents: 0, replay: false });
  });

  it('preserves explicit database replay facts for repeated settle and release', async () => {
    const store = new PostgresBudgetStore(
      fakePrisma([
        [{ charged_cents: 7n, observed_cents: 7n, cap_variance: false, status: 'SETTLED', replay: true }],
        [{ charged_cents: 0n, observed_cents: 0n, cap_variance: false, status: 'RELEASED', replay: true }],
      ]),
    );
    const reservation = {
      workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0',
      accountKey: 'run-1',
      operationId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      estimatedCents: 7,
      replay: false,
    };

    await expect(store.settle(reservation, 7)).resolves.toMatchObject({ replay: true });
    await expect(store.release(reservation)).resolves.toMatchObject({ replay: true });
  });

  it('opens, reads status, and closes the same durable account', async () => {
    const prisma = fakePrisma([
      [{ account_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b', generation: 1 }],
      [{ remaining_cents: 44n, exhausted: true, ref_count: 2, generation: 1 }],
      [{ close_tool_budget: null }],
    ]);
    const store = new PostgresBudgetStore(prisma);
    const scope = { workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0', accountKey: 'run-1' };
    await store.open({ ...scope, capCents: 50 });
    await expect(store.status(scope)).resolves.toEqual({ remainingCents: 44, exhausted: true, open: true });
    await expect(store.close({ ...scope, force: true })).resolves.toBeUndefined();
  });

  it('force-closes references but refuses to reopen while an old reservation is unresolved', async () => {
    const calls: string[] = [];
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId, fn) =>
        fn({
          $queryRaw: vi.fn(async (query: { strings?: readonly string[] }) => {
            const sql = query.strings?.join('') ?? '';
            calls.push(sql);
            if (sql.includes('open_tool_budget')) throw new Error('TOOL_BUDGET_UNSETTLED_OPERATIONS');
            return [];
          }),
        } as never)),
    } as unknown as PrismaService;
    const store = new PostgresBudgetStore(prisma);
    const scope = { workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0', accountKey: 'run-unknown' };

    await store.close({ ...scope, force: true });
    const concurrentReopens = await Promise.allSettled(
      Array.from({ length: 20 }, () => store.open({ ...scope, capCents: 50 })),
    );
    expect(concurrentReopens).toHaveLength(20);
    for (const result of concurrentReopens) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(BudgetUnsettledOperationsError);
    }
    expect(calls.some((sql) => sql.includes('close_tool_budget'))).toBe(true);
  });

  it('allows a new generation after the old reservation has been settled', async () => {
    const prisma = fakePrisma([
      [{ charged_cents: 7n, observed_cents: 7n, cap_variance: false, status: 'SETTLED' }],
      [{ close_tool_budget: null }],
      [{ account_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b', generation: 2 }],
    ]);
    const store = new PostgresBudgetStore(prisma);
    const reservation = {
      workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0',
      accountKey: 'run-known',
      operationId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      estimatedCents: 7,
      replay: false,
    };

    await store.settle(reservation, 7);
    await store.close({ workspaceId: reservation.workspaceId, accountKey: reservation.accountKey, force: true });
    await expect(
      store.open({ workspaceId: reservation.workspaceId, accountKey: reservation.accountKey, capCents: 50 }),
    ).resolves.toBeUndefined();
  });

  it('allows a new generation after execution was proven not to have started and the reservation was released', async () => {
    const prisma = fakePrisma([
      [{ charged_cents: 0n, observed_cents: 0n, cap_variance: false, status: 'RELEASED' }],
      [{ close_tool_budget: null }],
      [{ account_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b', generation: 2 }],
    ]);
    const store = new PostgresBudgetStore(prisma);
    const reservation = {
      workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0',
      accountKey: 'run-not-started',
      operationId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      estimatedCents: 7,
      replay: false,
    };

    await store.release(reservation);
    await store.close({ workspaceId: reservation.workspaceId, accountKey: reservation.accountKey, force: true });
    await expect(
      store.open({ workspaceId: reservation.workspaceId, accountKey: reservation.accountKey, capCents: 50 }),
    ).resolves.toBeUndefined();
  });

  it('marks an existing operation as replay and rejects unsafe inputs', async () => {
    const projection = projectGenericOperationResult({
      kind: 'tool', schema: 'bounded-tool/v1', data: { ok: true },
    });
    const store = new PostgresBudgetStore(
      fakePrisma([[
        {
          kind: 'REPLAY',
          operation_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
          reserved_cents: 5n,
          remaining_cents: 10n,
          status: 'RESERVED',
          result_json: projection,
        },
      ]]),
    );
    await expect(
      store.reserve({ workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0', accountKey: 'run-1', operationKey: 'op', estimatedCents: 5 }),
    ).resolves.toMatchObject({ replay: true, replayProjection: projection });
    await expect(
      store.open({ workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0', accountKey: '', capCents: 1 }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      store.reserve({ workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0', accountKey: 'run', operationKey: 'op', estimatedCents: -1 }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('passes an approved projection into the atomic settlement function', async () => {
    const queries: Array<{ values?: unknown[] }> = [];
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId, fn) => fn({
        $queryRaw: vi.fn(async (query: { values?: unknown[] }) => {
          queries.push(query);
          return [{ charged_cents: 1n, observed_cents: 1n, cap_variance: false, status: 'SETTLED', replay: false }];
        }),
      } as never)),
    } as unknown as PrismaService;
    const store = new PostgresBudgetStore(prisma);
    const projection = projectGenericOperationResult({
      kind: 'model', schema: 'fit-judgment/v1', data: { verdict: 'match' },
    });

    await store.settle({
      workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0', accountKey: 'run',
      operationId: '42c863b9-7c7e-4d28-8678-60ef9a20219b', estimatedCents: 1, replay: false,
    }, 1, projection);

    expect(queries[0]?.values).toEqual(expect.arrayContaining([
      projection.schemaVersion, projection.schema, projection.digest,
    ]));
  });

  it('records zero-cost operations for durable idempotency without consuming budget', async () => {
    const store = new PostgresBudgetStore(
      fakePrisma([[
        {
          kind: 'EXECUTE',
          operation_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
          reserved_cents: 0n,
          remaining_cents: 10n,
          status: 'RESERVED',
        },
      ]]),
    );

    await expect(
      store.reserve({
        workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0',
        accountKey: 'run',
        operationKey: 'free-operation',
        estimatedCents: 0,
      }),
    ).resolves.toMatchObject({ estimatedCents: 0, replay: false });
  });

  it('requires the owner connection for the platform scope', async () => {
    const store = new PostgresBudgetStore(fakePrisma([]));
    await expect(store.open({ workspaceId: 'platform', accountKey: 'sweep', capCents: 1 })).rejects.toMatchObject({
      code: 'BUDGET_STORE_UNAVAILABLE',
    });
  });
});

describe('UnavailableBudgetStore', () => {
  it('never treats a missing authoritative store as unlimited budget', async () => {
    const store = new UnavailableBudgetStore('postgres not configured');
    await expect(
      store.reserve({ workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0', accountKey: 'run-1', operationKey: 'op', estimatedCents: 1 }),
    ).rejects.toMatchObject({ code: 'BUDGET_STORE_UNAVAILABLE' });
  });

  it('fails every lifecycle operation closed', async () => {
    const store = new UnavailableBudgetStore();
    const reservation = { workspaceId: 'w', accountKey: 'a', operationId: 'o', estimatedCents: 1, replay: false };
    await expect(store.open({ workspaceId: 'w', accountKey: 'a', capCents: 1 })).rejects.toMatchObject({ code: 'BUDGET_STORE_UNAVAILABLE' });
    await expect(store.settle(reservation, 1)).rejects.toMatchObject({ code: 'BUDGET_STORE_UNAVAILABLE' });
    await expect(store.release(reservation)).rejects.toMatchObject({ code: 'BUDGET_STORE_UNAVAILABLE' });
    await expect(store.status({ workspaceId: 'w', accountKey: 'a' })).rejects.toMatchObject({ code: 'BUDGET_STORE_UNAVAILABLE' });
    await expect(store.close({ workspaceId: 'w', accountKey: 'a' })).rejects.toMatchObject({ code: 'BUDGET_STORE_UNAVAILABLE' });
  });
});

describe('InMemoryBudgetStoreAdapter', () => {
  it('remains available only through explicit test injection', async () => {
    const store = new InMemoryBudgetStoreAdapter(new BudgetLedger());
    await store.open({ workspaceId: 'w', accountKey: 'run', capCents: 10 });
    const reservation = await store.reserve({ workspaceId: 'w', accountKey: 'run', operationKey: 'op', estimatedCents: 4 });
    await expect(store.status({ workspaceId: 'w', accountKey: 'run' })).resolves.toMatchObject({ remainingCents: 6, open: true });
    await expect(store.settle(reservation, 3)).resolves.toMatchObject({ chargedCents: 3 });
    const released = await store.reserve({ workspaceId: 'w', accountKey: 'run', operationKey: 'op-2', estimatedCents: 2 });
    await expect(store.release(released)).resolves.toMatchObject({ chargedCents: 0 });
    await store.close({ workspaceId: 'w', accountKey: 'run', force: true });
    await expect(store.status({ workspaceId: 'w', accountKey: 'run' })).resolves.toMatchObject({ open: false });
  });
});
