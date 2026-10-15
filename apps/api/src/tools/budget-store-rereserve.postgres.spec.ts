import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { BudgetExceededError, PostgresBudgetStore } from './budget-store';
import { ExecutionBudgetAuthorityRepository } from '../execution-budget/execution-budget-authority.repository';
import { ExecutionBudgetAuthorityService } from '../execution-budget/execution-budget-authority.service';
import type { VerifiedExecutionBudgetAuthority } from '../execution-budget/execution-budget-authority.types';
import type { ExecutionBudgetBinding } from '../execution-budget/execution-budget-binding';
import type { ExecutionBudgetGrantVerifier } from '../execution-budget/execution-budget-grant.verifier';
import { workspaceExecutionBudgetRequestScope } from '../execution-budget/execution-budget-request-scope';
import { RouterModelGateway } from '../model-gateway/router-model-gateway';
import type { ModelProvider } from '../model-gateway/model-provider';
import type { ModelRouter } from '../model-gateway/model-router';
import { ProviderHttpError } from '../model-gateway/providers/provider-output-error';

const OWNER_DATABASE_URL = process.env.DATABASE_URL?.trim();
const APP_DATABASE_URL = process.env.APP_DATABASE_URL?.trim();
const REQUESTED = process.env.TOOL_BUDGET_RERESERVE_DATABASE_TEST === '1';

/** Fixtures are written for real, so only an explicitly named *_test database qualifies. */
function isDisposableTestDatabase(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).pathname.replace(/^\//, '').endsWith('_test');
  } catch {
    return false;
  }
}

if (
  REQUESTED &&
  !(isDisposableTestDatabase(OWNER_DATABASE_URL) && isDisposableTestDatabase(APP_DATABASE_URL))
) {
  throw new Error(
    'TOOL_BUDGET_RERESERVE_DATABASE_TEST needs DATABASE_URL and APP_DATABASE_URL on a database named *_test',
  );
}

/*
 * D13 (migration 20261015045032): a RELEASED operation incurred no physical
 * cost, so reserving its key again reopens the same row as a new attempt, at
 * most three attempts per (account, generation, operation key). Every other
 * existing row (RESERVED, RESULT_UNKNOWN, SETTLED with or without a result)
 * still replays, so an operation whose outcome is unknown is never paid twice.
 */
const liveDatabaseIt = REQUESTED ? it : it.skip;
const TIMEOUT = 60_000;
const ISSUER = 'https://control.example.test';
const CAP_MICROUSD = 2_000_000n;

type OperationRow = {
  id: string;
  status: string;
  attempt: number;
  reserved_microusd: bigint;
  charged_microusd: bigint | null;
  settled_at: Date | null;
};

describe('re-reserving a released operation key on PostgreSQL as the RLS-bound app principal (D13)', () => {
  let owner: PrismaClient;
  let app: PrismaService;
  let service: ExecutionBudgetAuthorityService;
  let store: PostgresBudgetStore;

  beforeAll(async () => {
    if (!REQUESTED) return;
    owner = new PrismaClient({ datasourceUrl: OWNER_DATABASE_URL });
    app = new PrismaService();
    const [principal] = await app.$queryRaw<Array<{ session: string; superuser: string; bypass: boolean }>>`
      SELECT session_user::text AS session, current_setting('is_superuser') AS superuser,
             (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`;
    if (principal?.session !== 'app_user' || principal.superuser !== 'off' || principal.bypass !== false) {
      throw new Error('APP_DATABASE_URL must log in as app_user, which RLS binds');
    }
    // Admission takes claims that were already verified; the verifier is never consulted.
    service = new ExecutionBudgetAuthorityService(
      {} as ExecutionBudgetGrantVerifier,
      new ExecutionBudgetAuthorityRepository(app),
    );
    store = new PostgresBudgetStore(app);
  }, TIMEOUT);

  afterAll(async () => {
    await app?.$disconnect();
    await owner?.$disconnect();
  });

  /** A fresh workspace with one admitted discovery-run account of CAP_MICROUSD. */
  async function account(): Promise<{ workspaceId: string; binding: ExecutionBudgetBinding }> {
    const workspaceId = randomUUID();
    await owner.workspace.create({ data: { id: workspaceId, name: 'D13 re-reservation integration' } });
    const scope = workspaceExecutionBudgetRequestScope({
      operation: 'POST /query-plans/:planId/execute',
      planId: randomUUID(),
    });
    const now = Math.floor(Date.now() / 1000);
    const claims: VerifiedExecutionBudgetAuthority = {
      schemaVersion: 'execution-budget-grant/v1',
      authorityKind: 'WORKSPACE_GRANT',
      issuer: ISSUER,
      audience: 'global-backend:execution-budget',
      jti: randomUUID(),
      purpose: scope.purpose,
      workspaceId,
      subjectType: scope.subjectType,
      subjectId: scope.subjectId,
      requestSha256: scope.requestSha256,
      scheduleId: null,
      currency: 'USD',
      unit: 'microusd',
      capMicrousd: CAP_MICROUSD,
      capPerRunMicrousd: null,
      campaignCapMicrousd: null,
      maxRuns: null,
      tokenSha256: randomBytes(32).toString('hex'),
      issuedAt: now - 5,
      notBefore: now - 5,
      expiresAt: now + 240,
    };
    const binding = await app.withWorkspace(workspaceId, (tx) =>
      service.consumeVerifiedWorkspaceGrantInTransaction(claims, tx),
    );
    return { workspaceId, binding };
  }

  async function operation(operationId: string): Promise<OperationRow> {
    const [row] = await owner.$queryRaw<OperationRow[]>`
      SELECT "id"::text AS id, "status"::text AS status, "attempt", "reserved_microusd",
             "charged_microusd", "settled_at"
        FROM "tool_budget_operation" WHERE "id" = ${operationId}::uuid`;
    return row!;
  }

  async function accountTotals(workspaceId: string, accountKey: string) {
    const [row] = await owner.$queryRaw<Array<{ reserved: bigint; charged: bigint; operations: number }>>`
      SELECT a."reserved_microusd" AS reserved, a."charged_microusd" AS charged,
             (SELECT count(*)::int FROM "tool_budget_operation" o WHERE o."account_id" = a."id") AS operations
        FROM "tool_budget_account" a
       WHERE a."scope_key" = ${workspaceId} AND a."account_key" = ${accountKey}`;
    return row!;
  }

  liveDatabaseIt(
    'reopens a released key as attempt 2 of the same row and settles it normally',
    async () => {
      const { workspaceId, binding } = await account();
      const operationKey = `d13-op-${randomUUID()}`;
      const request = { workspaceId, accountKey: binding.accountKey, operationKey, estimatedMicrousd: 400_000n };

      const first = await store.reserve(request);
      expect(first.replay).toBe(false);
      await expect(store.release(first)).resolves.toMatchObject({ chargedMicrousd: 0n, replay: false });
      expect(await operation(first.operationId)).toMatchObject({ status: 'RELEASED', attempt: 1 });

      const second = await store.reserve({ ...request, estimatedMicrousd: 300_000n });
      expect(second).toMatchObject({ replay: false, operationId: first.operationId, estimatedMicrousd: 300_000n });
      expect(second.replayResult).toBeUndefined();
      expect(await operation(first.operationId)).toMatchObject({
        status: 'RESERVED',
        attempt: 2,
        reserved_microusd: 300_000n,
        charged_microusd: null,
        settled_at: null,
      });
      expect(await accountTotals(workspaceId, binding.accountKey)).toEqual({
        reserved: 300_000n,
        charged: 0n,
        operations: 1,
      });

      await expect(store.settle(second, 120_000n)).resolves.toMatchObject({
        chargedMicrousd: 120_000n,
        replay: false,
      });
      expect(await operation(first.operationId)).toMatchObject({ status: 'SETTLED', attempt: 2 });
      expect(await accountTotals(workspaceId, binding.accountKey)).toEqual({
        reserved: 0n,
        charged: 120_000n,
        operations: 1,
      });
    },
    TIMEOUT,
  );

  liveDatabaseIt(
    'still replays an in-flight, an unknown and a settled operation, with or without a result',
    async () => {
      const { workspaceId, binding } = await account();
      const reserve = (operationKey: string) =>
        store.reserve({ workspaceId, accountKey: binding.accountKey, operationKey, estimatedMicrousd: 100_000n });

      const inFlight = await reserve(`d13-inflight-${randomUUID()}`);
      const settledNoResult = await reserve(`d13-settled-${randomUUID()}`);
      await store.settle(settledNoResult, 100_000n);
      const unknown = await reserve(`d13-unknown-${randomUUID()}`);
      await store.markResultUnknown(unknown);

      for (const [name, original, status] of [
        ['in flight', inFlight, 'RESERVED'],
        ['settled with no result', settledNoResult, 'SETTLED'],
        ['result unknown', unknown, 'RESULT_UNKNOWN'],
      ] as const) {
        const [row] = await owner.$queryRaw<Array<{ operation_key: string }>>`
          SELECT "operation_key"::text AS operation_key FROM "tool_budget_operation" WHERE "id" = ${original.operationId}::uuid`;
        const again = await reserve(row!.operation_key);
        expect(again, name).toMatchObject({ replay: true, operationId: original.operationId });
        expect(await operation(original.operationId), name).toMatchObject({ status, attempt: 1 });
      }
    },
    TIMEOUT,
  );

  liveDatabaseIt(
    'stops at three attempts per key: the fourth reservation replays the released row',
    async () => {
      const { workspaceId, binding } = await account();
      const request = {
        workspaceId,
        accountKey: binding.accountKey,
        operationKey: `d13-cap-${randomUUID()}`,
        estimatedMicrousd: 100_000n,
      };
      let operationId = '';
      for (const attempt of [1, 2, 3]) {
        const reservation = await store.reserve(request);
        expect(reservation.replay, `attempt ${attempt}`).toBe(false);
        operationId = reservation.operationId;
        expect(await operation(operationId)).toMatchObject({ status: 'RESERVED', attempt });
        await store.release(reservation);
      }

      const fourth = await store.reserve(request);
      expect(fourth).toMatchObject({ replay: true, operationId });
      expect(fourth.replayResult).toBeUndefined();
      expect(await operation(operationId)).toMatchObject({ status: 'RELEASED', attempt: 3 });
      expect(await accountTotals(workspaceId, binding.accountKey)).toEqual({
        reserved: 0n,
        charged: 0n,
        operations: 1,
      });
    },
    TIMEOUT,
  );

  liveDatabaseIt(
    'denies a re-reservation the account cannot cover and leaves the row released',
    async () => {
      const { workspaceId, binding } = await account();
      const released = await store.reserve({
        workspaceId,
        accountKey: binding.accountKey,
        operationKey: `d13-denied-${randomUUID()}`,
        estimatedMicrousd: 1_500_000n,
      });
      await store.release(released);
      await store.reserve({
        workspaceId,
        accountKey: binding.accountKey,
        operationKey: `d13-other-${randomUUID()}`,
        estimatedMicrousd: 1_000_000n,
      });
      const [row] = await owner.$queryRaw<Array<{ operation_key: string }>>`
        SELECT "operation_key"::text AS operation_key FROM "tool_budget_operation" WHERE "id" = ${released.operationId}::uuid`;

      await expect(
        store.reserve({
          workspaceId,
          accountKey: binding.accountKey,
          operationKey: row!.operation_key,
          estimatedMicrousd: 1_500_000n,
        }),
      ).rejects.toBeInstanceOf(BudgetExceededError);
      expect(await operation(released.operationId)).toMatchObject({ status: 'RELEASED', attempt: 1 });
      expect(await accountTotals(workspaceId, binding.accountKey)).toMatchObject({ reserved: 1_000_000n });
    },
    TIMEOUT,
  );

  liveDatabaseIt(
    'lets exactly one of two concurrent reservations reopen a released key',
    async () => {
      const { workspaceId, binding } = await account();
      const request = {
        workspaceId,
        accountKey: binding.accountKey,
        operationKey: `d13-race-${randomUUID()}`,
        estimatedMicrousd: 100_000n,
      };
      await store.release(await store.reserve(request));

      const outcomes = await Promise.all([store.reserve(request), store.reserve(request)]);

      expect(outcomes.map((reservation) => reservation.replay).sort()).toEqual([false, true]);
      expect(await operation(outcomes[0]!.operationId)).toMatchObject({ status: 'RESERVED', attempt: 2 });
      expect(await accountTotals(workspaceId, binding.accountKey)).toMatchObject({ reserved: 100_000n });
    },
    TIMEOUT,
  );

  liveDatabaseIt(
    'lets a gateway retry recover after HTTP 503 instead of replaying into BUDGET_OPERATION_REPLAY_UNAVAILABLE',
    async () => {
      const { workspaceId, binding } = await account();
      const generateText = vi
        .fn()
        .mockRejectedValueOnce(new ProviderHttpError({ status: 503, provider: 'gateway', model: 'm' }))
        .mockResolvedValueOnce({
          data: 'ok',
          provider: 'gateway',
          model: 'm',
          usage: { inputTokens: 10, outputTokens: 5 },
        });
      const provider = { id: 'gateway', generateText } as unknown as ModelProvider;
      const gateway = new RouterModelGateway(
        { route: () => [provider] } as unknown as ModelRouter,
        undefined,
        store,
      );
      // A retry of the same call derives the same operation key.
      const prompt = `d13-${randomUUID()}`;
      const callWith = () =>
        gateway.generateText(
          { task: 'discovery.qualify_fit', prompt, maxCostCents: 20 },
          { workspaceId, runId: binding.accountKey, correlationId: 'd13-retry' },
        );

      await expect(callWith()).rejects.toBeInstanceOf(ProviderHttpError);
      const [released] = await owner.$queryRaw<OperationRow[]>`
        SELECT o."id"::text AS id, o."status"::text AS status, o."attempt", o."reserved_microusd",
               o."charged_microusd", o."settled_at"
          FROM "tool_budget_operation" o
          JOIN "tool_budget_account" a ON a."id" = o."account_id"
         WHERE a."scope_key" = ${workspaceId} AND a."account_key" = ${binding.accountKey}`;
      expect(released).toMatchObject({ status: 'RELEASED', attempt: 1, charged_microusd: 0n });

      await expect(callWith()).resolves.toMatchObject({ data: 'ok' });
      expect(generateText).toHaveBeenCalledTimes(2);
      expect(await operation(released!.id)).toMatchObject({ status: 'SETTLED', attempt: 2 });
    },
    TIMEOUT,
  );
});
