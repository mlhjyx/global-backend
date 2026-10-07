import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { ExecutionBudgetAuthorityRepository } from './execution-budget-authority.repository';
import {
  ExecutionBudgetGrantError,
  type VerifiedExecutionBudgetAuthority,
} from './execution-budget-authority.types';
import { resolveRetryableWorkspaceAccountKey } from './execution-budget-retry-account';

const OWNER_DATABASE_URL = process.env.DATABASE_URL?.trim();
const APP_DATABASE_URL = process.env.APP_DATABASE_URL?.trim();
const REQUEST_SHA256 = 'c'.repeat(64);
const GRANT_REUSED = new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_REUSED');

/** Fixtures are written for real, so only an explicitly named *_test database qualifies. */
function isDisposableTestDatabase(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).pathname.replace(/^\//, '').endsWith('_test');
  } catch {
    return false;
  }
}

const liveDatabaseIt =
  process.env.EXECUTION_BUDGET_RETRY_ACCOUNT_DATABASE_TEST === '1' &&
  isDisposableTestDatabase(OWNER_DATABASE_URL) &&
  isDisposableTestDatabase(APP_DATABASE_URL)
    ? it
    : it.skip;

type Seed = { workspaceId: string; icpId: string; primary: string };

function grant(seed: Seed): VerifiedExecutionBudgetAuthority {
  const now = Math.floor(Date.now() / 1000);
  return {
    schemaVersion: 'execution-budget-grant/v1',
    authorityKind: 'WORKSPACE_GRANT',
    issuer: 'https://control.example.test',
    audience: 'global-backend:execution-budget',
    jti: randomUUID(),
    purpose: 'icp.query_plan',
    workspaceId: seed.workspaceId,
    subjectType: 'icp',
    subjectId: seed.icpId,
    requestSha256: REQUEST_SHA256,
    scheduleId: null,
    currency: 'USD',
    unit: 'microusd',
    capMicrousd: 2_000_000n,
    capPerRunMicrousd: null,
    campaignCapMicrousd: null,
    maxRuns: null,
    tokenSha256: randomBytes(32).toString('hex'),
    issuedAt: now - 5,
    notBefore: now - 5,
    expiresAt: now + 240,
  };
}

describe('retry account selection against PostgreSQL as the RLS-bound app principal', () => {
  let owner: PrismaClient | undefined;
  let app: PrismaService | undefined;
  let repository: ExecutionBudgetAuthorityRepository | undefined;

  beforeAll(async () => {
    if (liveDatabaseIt === it.skip) return;
    owner = new PrismaClient({ datasourceUrl: OWNER_DATABASE_URL });
    app = new PrismaService();
    const [principal] = await app.$queryRaw<Array<{ superuser: string; bypass: boolean }>>`
      SELECT current_setting('is_superuser') AS superuser,
             (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`;
    if (principal?.superuser !== 'off' || principal.bypass !== false) {
      throw new Error('APP_DATABASE_URL must name a non-superuser principal bound by RLS');
    }
    repository = new ExecutionBudgetAuthorityRepository(app);
  });

  afterAll(async () => {
    await app?.$disconnect();
    await owner?.$disconnect();
  });

  async function seedWorkspace(): Promise<Seed> {
    const workspaceId = randomUUID();
    const icpId = randomUUID();
    await owner!.workspace.create({ data: { id: workspaceId, name: 'Retry account integration' } });
    return { workspaceId, icpId, primary: `icp.query_plan:icp:${icpId}:${REQUEST_SHA256}` };
  }

  const consume = (seed: Seed) => repository!.consumeWorkspaceAndOpen(grant(seed), seed.primary);

  async function reserve(seed: Seed, accountKey: string): Promise<string> {
    const rows = await app!.withWorkspace(seed.workspaceId, (tx) =>
      tx.$queryRaw<Array<{ operation_id: string }>>(
        Prisma.sql`SELECT operation_id::text AS operation_id FROM reserve_tool_budget(
          ${seed.workspaceId}, ${accountKey}, ${`op-${randomUUID()}`}, ${1_000n}
        )`,
      ),
    );
    return rows[0]!.operation_id;
  }

  async function finish(seed: Seed, operationId: string, how: 'release' | 'settle'): Promise<void> {
    await app!.withWorkspace(seed.workspaceId, (tx) =>
      how === 'release'
        ? tx.$queryRaw(Prisma.sql`SELECT 1 AS done FROM release_tool_budget(
            ${seed.workspaceId}, ${operationId}::uuid)`)
        : tx.$queryRaw(Prisma.sql`SELECT 1 AS done FROM settle_tool_budget(
            ${seed.workspaceId}, ${operationId}::uuid, ${1_000n},
            NULL::text, NULL::text, NULL::text, NULL::jsonb, NULL::jsonb, NULL::text)`),
    );
  }

  /** Moves a consumed grant into the past; the window keeps its 5-minute shape. */
  async function ageGrant(authorityId: string, seconds: number): Promise<void> {
    await owner!.$executeRaw`UPDATE "execution_budget_authority"
      SET "issued_at" = "issued_at" - make_interval(secs => ${seconds}),
          "not_before" = "not_before" - make_interval(secs => ${seconds}),
          "expires_at" = "expires_at" - make_interval(secs => ${seconds})
      WHERE "id" = ${authorityId}::uuid`;
  }

  async function accountState(seed: Seed, accountKey: string) {
    const rows = await owner!.$queryRaw<Array<{ ref_count: number; closed: boolean }>>`
      SELECT "ref_count", ("closed_at" IS NOT NULL) AS closed
        FROM "tool_budget_account"
       WHERE "scope_key" = ${seed.workspaceId} AND "account_key" = ${accountKey}`;
    return rows[0];
  }

  liveDatabaseIt('rotates only past the 60-second tolerance after an attempt that never dispatched, and fences the old account', async () => {
    const seed = await seedWorkspace();
    const first = await consume(seed);
    expect(first.accountKey).toBe(seed.primary);
    await finish(seed, await reserve(seed, seed.primary), 'release');

    await ageGrant(first.authorityId, 270);
    await expect(consume(seed)).rejects.toEqual(GRANT_REUSED);

    await ageGrant(first.authorityId, 60);
    const retry = await consume(seed);
    expect(retry.accountKey).toBe(`${seed.primary}:retry:${retry.authorityId}`);
    expect(await accountState(seed, seed.primary)).toEqual({ ref_count: 0, closed: true });
    await expect(reserve(seed, seed.primary)).rejects.toThrow(/TOOL_BUDGET_ACCOUNT_UNAVAILABLE/);
    await expect(reserve(seed, retry.accountKey)).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  liveDatabaseIt.each([
    ['settled without a result', 'settle'],
    ['still reserved', undefined],
  ] as const)('keeps the original account when an earlier operation was %s', async (_case, how) => {
    const seed = await seedWorkspace();
    const first = await consume(seed);
    const operationId = await reserve(seed, seed.primary);
    if (how) await finish(seed, operationId, how);
    await ageGrant(first.authorityId, 600);

    await expect(consume(seed)).rejects.toEqual(GRANT_REUSED);
    expect(await accountState(seed, seed.primary)).toEqual({ ref_count: 1, closed: false });
  });

  /** Polls until another session is queued on an advisory lock. */
  async function waitForLedgerLockWaiter(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [row] = await owner!.$queryRaw<Array<{ waiting: number }>>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock' AND wait_event = 'advisory'`;
      if ((row?.waiting ?? 0) > 0) return;
      await owner!.$executeRaw`SELECT pg_sleep(0.05)`;
    }
    throw new Error('the concurrent retry never queued behind a ledger lock');
  }

  liveDatabaseIt('makes a concurrent retry wait for the first one and then keep the original account', async () => {
    const seed = await seedWorkspace();
    const first = await consume(seed);
    await ageGrant(first.authorityId, 600);
    let concurrent: Promise<{ ok: true } | { ok: false; reason: unknown }> | undefined;

    const opened = await app!.withWorkspace(
      seed.workspaceId,
      async (tx) => {
        const retry = await repository!.consumeWorkspaceAndOpenInTransaction(tx, grant(seed), seed.primary);
        concurrent = consume(seed).then(
          () => ({ ok: true as const }),
          (reason: unknown) => ({ ok: false as const, reason }),
        );
        await waitForLedgerLockWaiter();
        return retry;
      },
      { timeout: 15_000 },
    );

    expect(opened.accountKey).toBe(`${seed.primary}:retry:${opened.authorityId}`);
    await expect(concurrent).resolves.toEqual({ ok: false, reason: GRANT_REUSED });
  });

  liveDatabaseIt('refuses to rotate inside a REPEATABLE READ transaction', async () => {
    const seed = await seedWorkspace();
    const first = await consume(seed);
    await ageGrant(first.authorityId, 600);
    const input = {
      scopeKey: seed.workspaceId,
      authorityId: randomUUID(),
      purpose: 'icp.query_plan' as const,
      subjectType: 'icp',
      subjectId: seed.icpId,
      requestSha256: REQUEST_SHA256,
      primaryAccountKey: seed.primary,
    };
    const resolveAt = (isolationLevel: Prisma.TransactionIsolationLevel) =>
      app!.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${seed.workspaceId}, true)`;
        return resolveRetryableWorkspaceAccountKey(tx, input);
      }, { isolationLevel });

    await expect(resolveAt(Prisma.TransactionIsolationLevel.RepeatableRead)).resolves.toBe(seed.primary);
    await expect(resolveAt(Prisma.TransactionIsolationLevel.ReadCommitted)).resolves.toBe(
      `${seed.primary}:retry:${input.authorityId}`,
    );
  });
});
