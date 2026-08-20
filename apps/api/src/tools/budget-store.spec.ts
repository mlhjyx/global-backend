import { Prisma, type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { ExecutionBudgetGrantError } from '../execution-budget/execution-budget-authority.types';
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

function rawQueryMarkerError(marker: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('raw query failed', {
    code: 'P2010',
    clientVersion: 'test',
    meta: { code: 'P0001', message: `ERROR: ${marker}` },
  });
}

describe('PostgresBudgetStore', () => {
  it('opens an authority-bound account without accepting or sending a caller amount', async () => {
    const queries: Array<{ strings?: readonly string[]; values?: readonly unknown[] }> = [];
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId, fn) => fn({
        $queryRaw: vi.fn(async (query) => {
          queries.push(query);
          return [{
            account_id: '89528818-13ab-4a46-9dfd-6fbcdba6943e',
            generation: 2,
            authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
            authorized_cap_microusd: 2_000_000n,
          }];
        }),
      } as never)),
    } as unknown as PrismaService;
    const store = new PostgresBudgetStore(prisma);

    await expect(store.openAuthorized({
      authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      scopeKey: 'e03abddd-1307-47cb-a731-7e7a786615a0',
      accountKey: 'icp:design:req',
      replayScope: true,
    })).resolves.toEqual({
      accountId: '89528818-13ab-4a46-9dfd-6fbcdba6943e',
      authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      authorizedCapMicrousd: 2_000_000n,
      generation: 2,
    });

    const serializedQuery = queries[0]?.strings?.join('') ?? '';
    expect(serializedQuery).toContain('open_authorized_tool_budget_v1');
    expect(serializedQuery).not.toMatch(/capCents|capMicrousd|amount/i);
    expect(queries[0]?.values).toEqual([
      'e03abddd-1307-47cb-a731-7e7a786615a0',
      '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      'icp:design:req',
      true,
    ]);
  });

  it('does not treat the legacy owner connection as the platform authority writer', async () => {
    const ownerDb = {
      $transaction: vi.fn(async () => []),
    } as unknown as PrismaClient;
    const store = new PostgresBudgetStore(fakePrisma([]), ownerDb);

    await expect(store.openAuthorized({
      authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      scopeKey: 'platform',
      accountKey: 'acquisition-hourly:run-1',
    })).rejects.toEqual(
      new ExecutionBudgetGrantError('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE'),
    );
    expect(ownerDb.$transaction).not.toHaveBeenCalled();
  });

  it('opens platform authority only through the separately injected writer connection', async () => {
    const ownerDb = {
      $transaction: vi.fn(async () => []),
    } as unknown as PrismaClient;
    const platformWriter = {
      $transaction: vi.fn(async (fn) => fn({
        $queryRaw: vi.fn(async () => [{
          account_id: '89528818-13ab-4a46-9dfd-6fbcdba6943e',
          generation: 1,
          authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
          authorized_cap_microusd: 1_000_000n,
        }]),
      } as never)),
    } as unknown as PrismaClient;
    const store = new PostgresBudgetStore(fakePrisma([]), ownerDb, platformWriter);

    await expect(store.openAuthorized({
      authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      scopeKey: 'platform',
      accountKey: 'acquisition-hourly:run-1',
    })).resolves.toMatchObject({ authorizedCapMicrousd: 1_000_000n });
    expect(ownerDb.$transaction).not.toHaveBeenCalled();
    expect(platformWriter.$transaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    'EXECUTION_BUDGET_GRANT_INVALID',
    'EXECUTION_BUDGET_GRANT_EXPIRED',
    'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH',
    'EXECUTION_BUDGET_GRANT_REUSED',
    'EXECUTION_BUDGET_AUTHORITY_REVOKED',
    'EXECUTION_BUDGET_AUTHORITY_EXHAUSTED',
  ] as const)('maps authorized-open SQL marker %s without leaking database detail', async (marker) => {
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId, fn) => fn({
        $queryRaw: vi.fn(async () => {
          throw rawQueryMarkerError(marker);
        }),
      } as never)),
    } as unknown as PrismaService;
    const store = new PostgresBudgetStore(prisma);

    await expect(store.openAuthorized({
      authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      scopeKey: 'e03abddd-1307-47cb-a731-7e7a786615a0',
      accountKey: 'icp:design:req',
    })).rejects.toEqual(new ExecutionBudgetGrantError(marker));
  });

  it('trusts unsettled-operation markers only from the structured raw-query error', async () => {
    const input = {
      authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      scopeKey: 'e03abddd-1307-47cb-a731-7e7a786615a0',
      accountKey: 'icp:design:req',
    };
    const fake = (failure: Error) => new PostgresBudgetStore({
      withWorkspace: vi.fn(async (_workspaceId, fn) => fn({
        $queryRaw: vi.fn(async () => {
          throw failure;
        }),
      } as never)),
    } as unknown as PrismaService);

    await expect(
      fake(new Error('TOOL_BUDGET_UNSETTLED_OPERATIONS')).openAuthorized(input),
    ).rejects.toEqual(
      new ExecutionBudgetGrantError('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE'),
    );
    await expect(
      fake(rawQueryMarkerError('TOOL_BUDGET_UNSETTLED_OPERATIONS')).openAuthorized(input),
    ).rejects.toBeInstanceOf(BudgetUnsettledOperationsError);
  });

  it.each([
    { name: 'missing row', rows: [] },
    {
      name: 'multiple rows',
      rows: [
        {
          account_id: '89528818-13ab-4a46-9dfd-6fbcdba6943e', generation: 1,
          authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b', authorized_cap_microusd: 1n,
        },
        {
          account_id: '89528818-13ab-4a46-9dfd-6fbcdba6943e', generation: 1,
          authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b', authorized_cap_microusd: 1n,
        },
      ],
    },
    {
      name: 'malformed account UUID',
      rows: [{
        account_id: 'not-an-account', generation: 1,
        authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b', authorized_cap_microusd: 1n,
      }],
    },
    {
      name: 'non-positive generation',
      rows: [{
        account_id: '89528818-13ab-4a46-9dfd-6fbcdba6943e', generation: 0,
        authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b', authorized_cap_microusd: 1n,
      }],
    },
    {
      name: 'unsafe generation',
      rows: [{
        account_id: '89528818-13ab-4a46-9dfd-6fbcdba6943e', generation: Number.MAX_SAFE_INTEGER + 1,
        authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b', authorized_cap_microusd: 1n,
      }],
    },
    {
      name: 'malformed authority UUID',
      rows: [{
        account_id: '89528818-13ab-4a46-9dfd-6fbcdba6943e', generation: 1,
        authority_id: 'not-an-authority', authorized_cap_microusd: 1n,
      }],
    },
    {
      name: 'wrong authority UUID',
      rows: [{
        account_id: '89528818-13ab-4a46-9dfd-6fbcdba6943e', generation: 1,
        authority_id: '1b3d6096-b924-4bc8-bb4f-8436efb37b07', authorized_cap_microusd: 1n,
      }],
    },
    {
      name: 'non-bigint cap',
      rows: [{
        account_id: '89528818-13ab-4a46-9dfd-6fbcdba6943e', generation: 1,
        authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b', authorized_cap_microusd: 1,
      }],
    },
    {
      name: 'non-positive cap',
      rows: [{
        account_id: '89528818-13ab-4a46-9dfd-6fbcdba6943e', generation: 1,
        authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b', authorized_cap_microusd: 0n,
      }],
    },
  ])('fails authorized open closed for $name', async ({ rows }) => {
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId, fn) => fn({
        $queryRaw: vi.fn(async () => rows),
      } as never)),
    } as unknown as PrismaService;
    const store = new PostgresBudgetStore(prisma);

    await expect(store.openAuthorized({
      authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      scopeKey: 'e03abddd-1307-47cb-a731-7e7a786615a0',
      accountKey: 'icp:design:req',
    })).rejects.toEqual(
      new ExecutionBudgetGrantError('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE'),
    );
  });

  it.each([
    {
      name: 'malformed authority UUID',
      input: {
        authorityId: 'not-an-authority',
        scopeKey: 'e03abddd-1307-47cb-a731-7e7a786615a0',
      },
      code: 'EXECUTION_BUDGET_GRANT_INVALID',
    },
    {
      name: 'malformed workspace scope',
      input: {
        authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
        scopeKey: 'EXECUTION_BUDGET_GRANT_EXPIRED',
      },
      code: 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH',
    },
  ] as const)('rejects $name before authorized-open persistence', async ({ input, code }) => {
    const prisma = fakePrisma([]);
    const store = new PostgresBudgetStore(prisma);

    await expect(store.openAuthorized({
      ...input,
      accountKey: 'icp:design:req',
    })).rejects.toEqual(new ExecutionBudgetGrantError(code));
    expect(prisma.withWorkspace).not.toHaveBeenCalled();
  });

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
