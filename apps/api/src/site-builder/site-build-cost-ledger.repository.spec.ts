import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import {
  PaidCallDeniedError,
  PaidOperationUnknownError,
  PaidTaskBusyError,
  SiteBuildCostLedger,
} from './site-build-cost-ledger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakePrisma(tx: any): PrismaService {
  return {
    withWorkspace: vi.fn(async (_workspaceId, operation) => operation(tx)),
  } as unknown as PrismaService;
}

const SCOPE = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  siteId: '22222222-2222-4222-8222-222222222222',
  buildRunId: '33333333-3333-4333-8333-333333333333',
};

describe('SiteBuildCostLedger paid-operation replay gate', () => {
  it('returns an already-settled success without authorizing another execution', async () => {
    const tx = {
      $queryRaw: vi.fn(async () => [
        {
          decision: 'REPLAY',
          spend_id: '44444444-4444-4444-8444-444444444444',
          spend_status: 'SUCCEEDED',
          cached_result: { data: { ok: true } },
          cached_meta: { provider: 'gateway' },
          cached_error_code: null,
        },
      ]),
    };
    const ledger = new SiteBuildCostLedger(fakePrisma(tx));

    await expect(
      ledger.reserveOperation({
        ...SCOPE,
        operationKey: 'a'.repeat(64),
        kind: 'model',
        taskId: 'site_builder.brand_profile',
        subject: 'gpt-5.6-terra',
        reservationMicrousd: 800_000,
      }),
    ).resolves.toEqual({
      kind: 'replay',
      status: 'SUCCEEDED',
      result: { data: { ok: true } },
      meta: { provider: 'gateway' },
      errorCode: null,
    });
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
  });

  it('turns an ambiguous reserved row into a terminal unknown error instead of spending twice', async () => {
    const tx = {
      $queryRaw: vi.fn(async () => [
        {
          decision: 'UNKNOWN',
          spend_id: '44444444-4444-4444-8444-444444444444',
          spend_status: 'UNKNOWN',
          cached_result: null,
          cached_meta: null,
          cached_error_code: 'ACK_UNKNOWN',
        },
      ]),
    };
    const ledger = new SiteBuildCostLedger(fakePrisma(tx));

    await expect(
      ledger.reserveOperation({
        ...SCOPE,
        operationKey: 'b'.repeat(64),
        kind: 'tool',
        taskId: 'site_builder.brand_profile',
        subject: 'crawl4ai.fetch',
        reservationMicrousd: 10_000,
      }),
    ).rejects.toBeInstanceOf(PaidOperationUnknownError);
  });

  it('maps budget exhaustion and invalid run state to a fail-closed denial', async () => {
    for (const decision of [
      'DENIED_BUDGET_EXHAUSTED',
      'DENIED_STATE',
      'DENIED_NO_BUDGET',
      'DENIED_STALE_FENCE',
    ]) {
      const tx = {
        $queryRaw: vi.fn(async () => [
          {
            decision,
            spend_id: null,
            spend_status: null,
            cached_result: null,
            cached_meta: null,
            cached_error_code: null,
          },
        ]),
      };
      const ledger = new SiteBuildCostLedger(fakePrisma(tx));
      const error = await ledger
        .reserveOperation({
          ...SCOPE,
          operationKey: 'c'.repeat(64),
          kind: 'model',
          taskId: 'site_builder.brand_profile',
          subject: 'gpt-5.6-terra',
          reservationMicrousd: 800_000,
        })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PaidCallDeniedError);
      expect((error as PaidCallDeniedError).decision).toBe(decision);
    }
  });
});

describe('SiteBuildCostLedger BrandProfile task attempt fencing', () => {
  it('replays a completed logical task even after the BuildRun became terminal', async () => {
    const tx = {
      $executeRaw: vi.fn(async () => 0),
      siteBuildTaskAttempt: {
        findUnique: vi.fn(async () => ({
          id: '44444444-4444-4444-8444-444444444444',
          status: 'SUCCEEDED',
          resultJson: { version: 3, factCount: 2 },
        })),
      },
      siteBuildRun: { findUnique: vi.fn() },
      siteBuildBudget: { findUnique: vi.fn() },
    };
    const ledger = new SiteBuildCostLedger(fakePrisma(tx));

    await expect(
      ledger.claimTaskAttempt({
        ...SCOPE,
        taskId: 'site_builder.brand_profile',
      }),
    ).resolves.toEqual({
      kind: 'completed',
      result: { version: 3, factCount: 2 },
    });
    expect(tx.siteBuildRun.findUnique).not.toHaveBeenCalled();
  });

  it('rejects an overlapping Activity while the prior lease is live', async () => {
    const now = new Date('2026-07-19T10:00:00.000Z');
    const tx = {
      $executeRaw: vi.fn(async () => 0),
      siteBuildTaskAttempt: {
        findUnique: vi.fn(async () => ({
          id: '44444444-4444-4444-8444-444444444444',
          status: 'CLAIMED',
          leaseUntil: new Date('2026-07-19T10:01:00.000Z'),
        })),
      },
    };
    const ledger = new SiteBuildCostLedger(fakePrisma(tx), {
      now: () => now,
      randomUUID: () => '55555555-5555-4555-8555-555555555555',
    });

    await expect(
      ledger.claimTaskAttempt({
        ...SCOPE,
        taskId: 'site_builder.brand_profile',
      }),
    ).rejects.toBeInstanceOf(PaidTaskBusyError);
  });

  it('takes over an expired attempt with a new monotonic fence and preserves prior output state', async () => {
    const now = new Date('2026-07-19T10:00:00.000Z');
    const update = vi.fn(async ({ data }) => ({
      id: '44444444-4444-4444-8444-444444444444',
      workspaceId: SCOPE.workspaceId,
      siteId: SCOPE.siteId,
      buildRunId: SCOPE.buildRunId,
      taskId: 'site_builder.brand_profile',
      status: 'MODEL_SUCCEEDED',
      attemptNo: 3,
      ...data,
    }));
    const tx = {
      $executeRaw: vi.fn(async () => 0),
      siteBuildTaskAttempt: {
        findUnique: vi.fn(async () => ({
          id: '44444444-4444-4444-8444-444444444444',
          status: 'MODEL_SUCCEEDED',
          attemptNo: 2,
          leaseUntil: new Date('2026-07-19T09:59:59.000Z'),
        })),
        update,
      },
      siteBuildRun: {
        findUnique: vi.fn(async () => ({ status: 'running' })),
      },
      siteBuildBudget: {
        findUnique: vi.fn(async () => ({ paidCallsEnabled: true })),
      },
    };
    const ledger = new SiteBuildCostLedger(fakePrisma(tx), {
      now: () => now,
      randomUUID: () => '55555555-5555-4555-8555-555555555555',
    });

    const claimed = await ledger.claimTaskAttempt({
      ...SCOPE,
      taskId: 'site_builder.brand_profile',
    });

    expect(claimed).toMatchObject({
      kind: 'claimed',
      attempt: {
        status: 'MODEL_SUCCEEDED',
        attemptNo: 3,
        fenceToken: '55555555-5555-4555-8555-555555555555',
      },
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          attemptNo: 3,
          fenceToken: '55555555-5555-4555-8555-555555555555',
        }),
      }),
    );
    expect(update.mock.calls[0]![0].data).not.toHaveProperty('status');
    expect(update.mock.calls[0]![0].data).not.toHaveProperty('outputJson');
  });

  it('freezes the first canonical task input and returns it on replay instead of accepting drift', async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce({
        id: '44444444-4444-4444-8444-444444444444',
        fenceToken: '55555555-5555-4555-8555-555555555555',
        leaseUntil: new Date('2026-07-19T10:10:00.000Z'),
        inputHash: null,
        inputJson: null,
      })
      .mockResolvedValueOnce({
        id: '44444444-4444-4444-8444-444444444444',
        fenceToken: '55555555-5555-4555-8555-555555555555',
        leaseUntil: new Date('2026-07-19T10:10:00.000Z'),
        inputHash: 'a'.repeat(64),
        inputJson: { companyName: 'Frozen Co' },
      });
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      siteBuildTaskAttempt: { findUnique, updateMany },
    };
    const ledger = new SiteBuildCostLedger(fakePrisma(tx), {
      now: () => new Date('2026-07-19T10:00:00.000Z'),
      randomUUID: () => 'unused',
    });
    const attempt = {
      workspaceId: SCOPE.workspaceId,
      attemptId: '44444444-4444-4444-8444-444444444444',
      fenceToken: '55555555-5555-4555-8555-555555555555',
    };

    const first = await ledger.freezeTaskInput(attempt, {
      companyName: 'First Co',
      nested: { z: 1, a: 2 },
    });
    const replay = await ledger.freezeTaskInput(attempt, {
      companyName: 'Drifted Co',
    });

    expect(first.input).toEqual({
      companyName: 'First Co',
      nested: { z: 1, a: 2 },
    });
    expect(first.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(updateMany).toHaveBeenCalledOnce();
    expect(replay).toEqual({
      inputHash: 'a'.repeat(64),
      input: { companyName: 'Frozen Co' },
      replayed: true,
    });
  });
});

describe('SiteBuildCostLedger terminal cost summary', () => {
  it('reconciles ambiguous reservations, closes paid calls and returns the stable v1 summary', async () => {
    const reconcile = vi.fn(async () => [{ reconciled: 1 }]);
    const disable = vi.fn(async () => ({ count: 1 }));
    const tx = {
      $queryRaw: reconcile,
      siteBuildBudget: {
        updateMany: disable,
        findUnique: vi.fn(async () => ({
          capMicrousd: 5_000_000n,
          reservedMicrousd: 0n,
          chargedMicrousd: 820_000n,
          paidCallsEnabled: false,
          disabledReason: 'run_succeeded',
          exhaustedAt: null,
        })),
      },
      siteBuildSpend: {
        findMany: vi.fn(async () => [
          {
            kind: 'model',
            status: 'SUCCEEDED',
            costBasis: 'token_pricing',
            budgetChargeMicrousd: 20_000n,
            reportedCostMicrousd: null,
            calculatedCostMicrousd: 20_000n,
            estimatedCostMicrousd: null,
            inputTokens: 10,
            outputTokens: 5,
            callCount: 1,
          },
          {
            kind: 'tool',
            status: 'UNKNOWN',
            costBasis: 'unknown',
            budgetChargeMicrousd: 800_000n,
            reportedCostMicrousd: null,
            calculatedCostMicrousd: null,
            estimatedCostMicrousd: null,
            inputTokens: null,
            outputTokens: null,
            callCount: null,
          },
        ]),
      },
    };
    const ledger = new SiteBuildCostLedger(fakePrisma(tx));

    await expect(
      ledger.closeAndSummarize({
        ...SCOPE,
        reason: 'run_succeeded',
      }),
    ).resolves.toMatchObject({
      schemaVersion: 'site-builder-cost-summary/v1',
      budget: {
        chargedMicrousd: 820_000,
        paidCallsEnabled: false,
        disabledReason: 'run_succeeded',
      },
      totals: {
        calculatedCostMicrousd: 20_000,
        unknownOperations: 1,
      },
      usage: { modelCalls: 1, toolCalls: 0 },
    });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(disable).toHaveBeenCalledWith({
      where: { buildRunId: SCOPE.buildRunId, paidCallsEnabled: true },
      data: {
        paidCallsEnabled: false,
        disabledReason: 'run_succeeded',
      },
    });
  });
});
