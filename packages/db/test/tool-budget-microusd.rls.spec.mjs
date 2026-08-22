import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { PrismaClient } from '@prisma/client';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const OWNER_URL = process.env.DATABASE_URL;
const APP_URL = process.env.APP_DATABASE_URL;
const WORKSPACE_ID = '00000000-0000-4000-8000-00000000c001';
const MAX_BIGINT = 9_223_372_036_854_775_807n;

function requireUrl(name, value) {
  assert.ok(value, `${name} is required`);
  return value;
}

function client(url) {
  return new PrismaClient({ datasources: { db: { url } } });
}

async function inWorkspace(database, callback) {
  return database.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(
      "SELECT set_config('app.current_workspace_id', $1, true)",
      WORKSPACE_ID,
    );
    return callback(transaction);
  });
}

async function openLegacy(database, accountKey, capCents) {
  return inWorkspace(database, (transaction) => transaction.$queryRawUnsafe(
    'SELECT * FROM open_tool_budget($1,$2,$3::bigint,false)',
    WORKSPACE_ID,
    accountKey,
    capCents,
  ));
}

async function reserveMicrousd(database, accountKey, operationKey, amount) {
  return inWorkspace(database, (transaction) => transaction.$queryRawUnsafe(
    'SELECT * FROM reserve_tool_budget_microusd_v1($1,$2,$3,$4::bigint)',
    WORKSPACE_ID,
    accountKey,
    operationKey,
    amount,
  ));
}

async function openAuthority(database, accountKey) {
  return inWorkspace(database, async (transaction) => {
    const [authority] = await transaction.$queryRawUnsafe(
      `SELECT * FROM consume_workspace_execution_authority(
        $1,$2,$3::uuid,$4,$5,$6::execution_budget_purpose,
        $7::uuid,$8,$9,$10,$11,$12,$13::bigint,
        $14::timestamptz,$15::timestamptz,$16::timestamptz
      )`,
      'https://control.example.test',
      'global-backend:execution-budget',
      randomUUID(),
      'a'.repeat(64),
      'execution-budget-grant/v1',
      'icp.design',
      WORKSPACE_ID,
      'company',
      `company:${accountKey}`,
      'b'.repeat(64),
      'USD',
      'microusd',
      10_000n,
      new Date(Date.now() - 30_000),
      new Date(Date.now() - 20_000),
      new Date(Date.now() + 240_000),
    );
    return transaction.$queryRawUnsafe(
      'SELECT * FROM open_authorized_tool_budget_v1($1,$2::uuid,$3,false)',
      WORKSPACE_ID,
      authority.authority_id,
      accountKey,
    );
  });
}

describe('additive tool budget microusd PostgreSQL arithmetic', () => {
  let owner;
  let app;

  before(async () => {
    owner = client(requireUrl('DATABASE_URL', OWNER_URL));
    app = client(requireUrl('APP_DATABASE_URL', APP_URL));
    await owner.$executeRawUnsafe(
      `INSERT INTO workspace (id,name,created_at,updated_at)
       VALUES ($1::uuid,'Task 1 microusd',now(),now())
       ON CONFLICT (id) DO NOTHING`,
      WORKSPACE_ID,
    );
  });

  after(async () => {
    await Promise.allSettled([app?.$disconnect(), owner?.$disconnect()]);
  });

  it('contains no cents-to-microusd integer division and does not wire product callers', async () => {
    const [sql, broker, router] = await Promise.all([
      readFile(resolve(repositoryRoot,
        'packages/db/prisma/migrations/20260822130000_tool_budget_microusd/migration.sql'), 'utf8'),
      readFile(resolve(repositoryRoot, 'apps/api/src/tools/tool-broker.ts'), 'utf8'),
      readFile(resolve(repositoryRoot,
        'apps/api/src/model-gateway/router-model-gateway.ts'), 'utf8'),
    ]);
    assert.doesNotMatch(sql, /\/\s*10_?000\b/i);
    assert.doesNotMatch(broker, /reserveMicrousd|settleMicrousd|_microusd_v1/);
    assert.doesNotMatch(router, /reserveMicrousd|settleMicrousd|_microusd_v1/);
  });

  for (const amount of [1n, 9_999n, 10_000n, MAX_BIGINT]) {
    it(`reserves exact ${amount} microusd on an unbound additive account`, async () => {
      const accountKey = `boundary:${amount}`;
      await openLegacy(app, accountKey, amount === MAX_BIGINT ? MAX_BIGINT : 1n);
      const [result] = await reserveMicrousd(app, accountKey, 'operation', amount);
      assert.equal(result.kind, 'EXECUTE');
      assert.equal(result.reserved_microusd, amount);
      assert.equal(
        result.remaining_microusd,
        amount === MAX_BIGINT ? 0n : 10_000n - amount,
      );
    });
  }

  it('rejects PostgreSQL BIGINT overflow before mutating an operation', async () => {
    const accountKey = 'overflow';
    await openLegacy(app, accountKey, MAX_BIGINT);
    await assert.rejects(
      reserveMicrousd(app, accountKey, 'overflow-operation', MAX_BIGINT + 1n),
      /out of range|Unable to fit integer value|Could not convert from `JSON bigint value`/i,
    );
    const [{ count }] = await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS count FROM tool_budget_operation
       WHERE scope_key=$1 AND operation_key='overflow-operation'`,
      WORKSPACE_ID,
    );
    assert.equal(count, 0);
  });

  for (const testCase of [
    { name: 'below', observed: 7_500n, charged: 7_500n, variance: false },
    { name: 'above', observed: 10_001n, charged: 10_000n, variance: true },
  ]) {
    it(`settles exact provider cost ${testCase.name} reservation`, async () => {
      const accountKey = `settle:${testCase.name}`;
      await openLegacy(app, accountKey, 1n);
      const [reservation] = await reserveMicrousd(app, accountKey, 'operation', 10_000n);
      const [settlement] = await inWorkspace(app, (transaction) =>
        transaction.$queryRawUnsafe(
          `SELECT * FROM settle_tool_budget_microusd_v1(
            $1,$2::uuid,$3::bigint,NULL,NULL,NULL,NULL
          )`,
          WORKSPACE_ID,
          reservation.operation_id,
          testCase.observed,
        ));
      assert.equal(settlement.charged_microusd, testCase.charged);
      assert.equal(settlement.observed_microusd, testCase.observed);
      assert.equal(settlement.cap_variance, testCase.variance);
    });
  }

  it('keeps charged + reserved within the cap under concurrency', async () => {
    const accountKey = 'concurrent-cap';
    await openLegacy(app, accountKey, 1n);
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        reserveMicrousd(app, accountKey, `operation:${index}`, 1_000n)),
    );
    assert.equal(outcomes.filter(([row]) => row.kind === 'EXECUTE').length, 10);
    assert.equal(outcomes.filter(([row]) => row.kind === 'DENIED').length, 10);
    const [account] = await owner.$queryRawUnsafe(
      `SELECT reserved_microusd,charged_microusd FROM tool_budget_account
       WHERE scope_key=$1 AND account_key=$2`,
      WORKSPACE_ID,
      accountKey,
    );
    assert.ok(account.charged_microusd + account.reserved_microusd <= 10_000n);
  });

  it('preserves legacy cents behavior and fences mixed-unit generations', async () => {
    const legacyKey = 'legacy-cent';
    await openLegacy(app, legacyKey, 2n);
    const [legacy] = await inWorkspace(app, (transaction) => transaction.$queryRawUnsafe(
      'SELECT * FROM reserve_tool_budget($1,$2,$3,1)',
      WORKSPACE_ID,
      legacyKey,
      'cent-operation',
    ));
    assert.equal(legacy.reserved_cents, 1n);
    await assert.rejects(
      reserveMicrousd(app, legacyKey, 'microusd-bypass', 1n),
      /TOOL_BUDGET_AMOUNT_UNIT_CONFLICT/,
    );
    await assert.rejects(
      reserveMicrousd(app, legacyKey, 'cent-operation', 1n),
      /TOOL_BUDGET_AMOUNT_UNIT_CONFLICT/,
    );

    const microusdKey = 'legacy-microusd';
    await openLegacy(app, microusdKey, 1n);
    await reserveMicrousd(app, microusdKey, 'microusd-operation', 1n);
    await assert.rejects(
      inWorkspace(app, (transaction) => transaction.$queryRawUnsafe(
        'SELECT * FROM reserve_tool_budget($1,$2,$3,1)',
        WORKSPACE_ID,
        microusdKey,
        'cent-bypass',
      )),
      /TOOL_BUDGET_AMOUNT_UNIT_CONFLICT/,
    );
    await assert.rejects(
      inWorkspace(app, (transaction) => transaction.$queryRawUnsafe(
        'SELECT * FROM reserve_tool_budget($1,$2,$3,1)',
        WORKSPACE_ID,
        microusdKey,
        'microusd-operation',
      )),
      /TOOL_BUDGET_AMOUNT_UNIT_CONFLICT/,
    );
  });

  it('keeps authority accounts NONSPENDABLE on old and additive functions', async () => {
    const accountKey = 'authority-hold';
    await openAuthority(app, accountKey);
    await assert.rejects(
      reserveMicrousd(app, accountKey, 'microusd-bypass', 1n),
      /EXECUTION_BUDGET_AUTHORITY_LIFECYCLE_UNAVAILABLE/,
    );
    await assert.rejects(
      inWorkspace(app, (transaction) => transaction.$queryRawUnsafe(
        'SELECT * FROM reserve_tool_budget($1,$2,$3,1)',
        WORKSPACE_ID,
        accountKey,
        'cent-bypass',
      )),
      /EXECUTION_BUDGET_AUTHORITY_LIFECYCLE_UNAVAILABLE/,
    );
    const [account] = await owner.$queryRawUnsafe(
      `SELECT reserved_cents,charged_cents,reserved_microusd,charged_microusd
       FROM tool_budget_account WHERE scope_key=$1 AND account_key=$2`,
      WORKSPACE_ID,
      accountKey,
    );
    assert.deepEqual(account, {
      reserved_cents: 0n,
      charged_cents: 0n,
      reserved_microusd: 0n,
      charged_microusd: 0n,
    });
  });

  it('does not grant the additive workspace ledger to the platform writer role', async () => {
    await assert.rejects(
      owner.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(
          'SET LOCAL ROLE execution_budget_platform_writer',
        );
        await transaction.$executeRawUnsafe(
          "SELECT set_config('app.current_workspace_id', $1, true)",
          WORKSPACE_ID,
        );
        return transaction.$queryRawUnsafe(
          'SELECT * FROM reserve_tool_budget_microusd_v1($1,$2,$3,1)',
          WORKSPACE_ID,
          'authority-hold',
          'platform-bypass',
        );
      }),
      /permission denied for function reserve_tool_budget_microusd_v1/,
    );
  });
});
