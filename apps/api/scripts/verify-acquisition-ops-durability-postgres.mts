import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  PrismaAcquisitionBudgetLedger,
  type WorkspaceTransactionRunner,
} from '../src/tools/prisma-acquisition-budget-ledger';
import type {
  AcquisitionBudgetAuthorization,
  AcquisitionBudgetReservationInput,
  BudgetAmount,
} from '../src/tools/acquisition-budget-ledger';
import { PostgresOutboxSingleWriterRepository } from '../src/relay/outbox-single-writer.repository';

const AUTHORIZATION = 'I_ACKNOWLEDGE_THIS_IS_AN_ISOLATED_DISPOSABLE_DATABASE';
const NOT_RUN = 'NOT_RUN_REQUIRES_ISOLATED_TEST_DB_AUTHORIZATION';
const MIGRATION_NAME = '20260807230000_acquisition_budget_ledger';

function requiredEnvironment(): { ownerUrl: string; appUrl: string } {
  const ownerUrl = process.env.ACQUISITION_LEDGER_TEST_OWNER_DATABASE_URL;
  const appUrl = process.env.ACQUISITION_LEDGER_TEST_APP_DATABASE_URL;
  if (
    process.env.ACQUISITION_LEDGER_TEST_DB_AUTHORIZATION !== AUTHORIZATION ||
    !ownerUrl ||
    !appUrl
  ) {
    throw new Error(NOT_RUN);
  }
  const owner = new URL(ownerUrl);
  const app = new URL(appUrl);
  const ownerDb = owner.pathname.replace(/^\//, '');
  const appDb = app.pathname.replace(/^\//, '');
  assert.match(
    ownerDb,
    /^codex_acquisition_ledger_test_[a-z0-9_]+$/,
    'owner database name must use the disposable verifier prefix',
  );
  assert.equal(appDb, ownerDb, 'owner/app URLs must address the same test database');
  assert.notEqual(owner.username, app.username, 'owner/app URLs must use distinct database roles');
  return { ownerUrl, appUrl };
}

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

function runner(client: PrismaClient): WorkspaceTransactionRunner {
  return {
    withWorkspace: async (workspaceId, operation) =>
      client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
        return operation(tx as never);
      }),
  };
}

async function seedWorkspace(client: PrismaClient, workspaceId: string): Promise<void> {
  await client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
    await tx.$executeRaw`
      INSERT INTO "workspace" ("id", "name", "created_at", "updated_at")
      VALUES (${workspaceId}::uuid, 'acquisition durability verifier', clock_timestamp(), clock_timestamp())
      ON CONFLICT ("id") DO NOTHING
    `;
  });
}

async function cleanupWorkspace(client: PrismaClient, workspaceId: string): Promise<void> {
  await client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
    await tx.$executeRaw`DELETE FROM "acquisition_budget_reservation" WHERE "workspace_id" = ${workspaceId}::uuid`;
    await tx.$executeRaw`DELETE FROM "acquisition_budget_account" WHERE "workspace_id" = ${workspaceId}::uuid`;
    await tx.$executeRaw`DELETE FROM "workspace" WHERE "id" = ${workspaceId}::uuid`;
  });
}

async function verifyMigrationAndPrivileges(owner: PrismaClient, app: PrismaClient): Promise<void> {
  const migrations = await owner.$queryRaw<{ migration_name: string }[]>`
    SELECT "migration_name"
    FROM "_prisma_migrations"
    WHERE "migration_name" = ${MIGRATION_NAME}
      AND "finished_at" IS NOT NULL
      AND "rolled_back_at" IS NULL
  `;
  assert.equal(
    migrations.length,
    1,
    `run prisma migrate deploy against the isolated database before this verifier (${MIGRATION_NAME} missing)`,
  );

  const functions = await owner.$queryRaw<
    {
      proname: string;
      prosecdef: boolean;
      owner_name: string;
      owner_safe: boolean;
      proconfig: string[] | null;
    }[]
  >`
    SELECT
      p.proname,
      p.prosecdef,
      r.rolname AS owner_name,
      (
        NOT r.rolcanlogin AND NOT r.rolinherit AND NOT r.rolsuper
        AND NOT r.rolcreatedb AND NOT r.rolcreaterole
        AND NOT r.rolreplication AND NOT r.rolbypassrls
      ) AS owner_safe,
      p.proconfig
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'open_acquisition_budget_account',
        'reserve_acquisition_budget',
        'settle_acquisition_budget'
      )
    ORDER BY p.proname
  `;
  assert.equal(functions.length, 3, 'all three ledger transition functions must exist');
  for (const fn of functions) {
    assert.equal(fn.prosecdef, true, `${fn.proname} must be SECURITY DEFINER`);
    assert.equal(fn.owner_name, 'acquisition_budget_executor');
    assert.equal(fn.owner_safe, true, 'function owner must be non-login and non-bypass');
    assert.ok(
      fn.proconfig?.some((entry) => entry.startsWith('search_path=')),
      `${fn.proname} must pin search_path`,
    );
  }

  const privileges = await app.$queryRaw<
    {
      account_update: boolean;
      reservation_update: boolean;
      account_select: boolean;
    }[]
  >(Prisma.sql`
    SELECT
      has_table_privilege(current_user, 'public.acquisition_budget_account', 'UPDATE') AS account_update,
      has_table_privilege(current_user, 'public.acquisition_budget_reservation', 'UPDATE') AS reservation_update,
      has_table_privilege(current_user, 'public.acquisition_budget_account', 'SELECT') AS account_select
  `);
  assert.deepEqual(privileges[0], {
    account_update: false,
    reservation_update: false,
    account_select: true,
  });
}

async function verifySingleWriter(
  firstClient: PrismaClient,
  secondClient: PrismaClient,
): Promise<void> {
  const first = new PostgresOutboxSingleWriterRepository(firstClient as never);
  const second = new PostgresOutboxSingleWriterRepository(secondClient as never);
  let signalHeld!: () => void;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    signalHeld = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = first.runExclusive(async () => {
    signalHeld();
    await released;
    return 'holder';
  });
  await held;
  assert.deepEqual(await second.runExclusive(async () => 'should-not-run'), {
    acquired: false,
  });
  release();
  assert.deepEqual(await holder, { acquired: true, value: 'holder' });
  assert.deepEqual(await second.runExclusive(async () => 'next-holder'), {
    acquired: true,
    value: 'next-holder',
  });
}

async function main(): Promise<void> {
  const { ownerUrl, appUrl } = requiredEnvironment();
  const owner = new PrismaClient({ datasourceUrl: ownerUrl });
  let appA = new PrismaClient({ datasourceUrl: appUrl });
  let appB = new PrismaClient({ datasourceUrl: appUrl });
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const runId = randomUUID();
  const accountId = `verify-${randomUUID()}`;
  const unknownAccountId = `verify-${randomUUID()}`;
  try {
    await Promise.all([owner.$connect(), appA.$connect(), appB.$connect()]);
    await verifyMigrationAndPrivileges(owner, appA);
    await seedWorkspace(owner, workspaceId);
    await seedWorkspace(owner, otherWorkspaceId);

    const authorization: AcquisitionBudgetAuthorization = {
      accountId,
      workspaceId,
      runId,
      purpose: 'discovery',
      targetKind: 'TOOL',
      targetId: 'openfda.search',
      currency: 'USD',
      billingUnit: 'cent',
      limits: amount({ requestCount: 1n, callCount: 1n, recordCount: 10n }),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    };
    const ledgerA = new PrismaAcquisitionBudgetLedger(runner(appA));
    const ledgerB = new PrismaAcquisitionBudgetLedger(runner(appB));
    assert.deepEqual(await ledgerA.openAccount(authorization), {
      kind: 'opened',
    });
    assert.deepEqual(await ledgerB.openAccount(authorization), {
      kind: 'replay',
    });

    const reservationBase: Omit<AcquisitionBudgetReservationInput, 'executionId'> = {
      accountId,
      workspaceId,
      runId,
      purpose: authorization.purpose,
      targetKind: authorization.targetKind,
      targetId: authorization.targetId,
      attempt: 1,
      requestFingerprint: 'a'.repeat(64),
      maximum: amount({ requestCount: 1n, callCount: 1n, recordCount: 10n }),
    };
    const concurrent = await Promise.allSettled([
      ledgerA.reserve({ ...reservationBase, executionId: 'concurrency-a' }),
      ledgerB.reserve({ ...reservationBase, executionId: 'concurrency-b' }),
    ]);
    const fulfilled = concurrent.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof ledgerA.reserve>>> =>
        result.status === 'fulfilled',
    );
    const rejected = concurrent.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    assert.equal(fulfilled.length, 1, 'exactly one concurrent reservation must win');
    assert.equal(rejected.length, 1, 'exactly one concurrent reservation must fail');
    assert.equal(rejected[0]?.reason?.code, 'ACCOUNT_EXHAUSTED');
    const winner = fulfilled[0]!.value;
    await ledgerA.settle({
      reservation: winner,
      outcome: 'SETTLED',
      actual: amount({ requestCount: 1n, callCount: 1n, recordCount: 3n }),
    });

    await Promise.all([appA.$disconnect(), appB.$disconnect()]);
    appA = new PrismaClient({ datasourceUrl: appUrl });
    appB = new PrismaClient({ datasourceUrl: appUrl });
    await Promise.all([appA.$connect(), appB.$connect()]);
    const restartedLedger = new PrismaAcquisitionBudgetLedger(runner(appA));
    assert.deepEqual(await restartedLedger.openAccount(authorization), {
      kind: 'replay',
    });
    assert.equal(
      (
        await restartedLedger.reserve({
          ...reservationBase,
          executionId: winner.executionId,
        })
      ).kind,
      'replay',
      'reservation must survive client/process restart',
    );

    const unknownAuthorization: AcquisitionBudgetAuthorization = {
      ...authorization,
      accountId: unknownAccountId,
      targetId: 'ted.search',
    };
    await restartedLedger.openAccount(unknownAuthorization);
    const unknownReservation = await restartedLedger.reserve({
      ...reservationBase,
      accountId: unknownAccountId,
      targetId: 'ted.search',
      executionId: 'unknown-settlement',
    });
    assert.deepEqual(
      await restartedLedger.settle({
        reservation: unknownReservation,
        outcome: 'UNKNOWN',
      }),
      {
        kind: 'unknown',
        charged: unknownReservation.maximum,
        accountStatus: 'FROZEN',
      },
    );

    const crossTenantRows = await runner(appA).withWorkspace(otherWorkspaceId, (tx) =>
      tx.$queryRaw<{ count: number }>(Prisma.sql`
          SELECT count(*)::int AS count
          FROM "acquisition_budget_account"
          WHERE "workspace_id" = ${workspaceId}::uuid
        `),
    );
    assert.equal(crossTenantRows[0]?.count, 0, 'RLS must hide another tenant');

    await assert.rejects(
      appA.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
        await tx.$executeRaw`
          UPDATE "acquisition_budget_reservation"
          SET "status" = 'RELEASED'
          WHERE "id" = ${unknownReservation.reservationId}
        `;
      }),
      (error: unknown) =>
        (error as { code?: string }).code === '42501' || /permission denied/i.test(String(error)),
      'app_user must not bypass append-only settlement through direct UPDATE',
    );

    await verifySingleWriter(appA, appB);
    console.log(
      'PASS acquisition budget concurrency/persistence/RLS/privileges + outbox single-writer',
    );
  } finally {
    await cleanupWorkspace(owner, workspaceId).catch(() => undefined);
    await cleanupWorkspace(owner, otherWorkspaceId).catch(() => undefined);
    await Promise.allSettled([owner.$disconnect(), appA.$disconnect(), appB.$disconnect()]);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message === NOT_RUN ? NOT_RUN : `FAIL ${message}`);
  process.exitCode = 1;
});
