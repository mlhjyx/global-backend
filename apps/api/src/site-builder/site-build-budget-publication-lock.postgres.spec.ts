import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Explicitly opted-in, disposable and migrated PostgreSQL only. The owner connection builds a
// workspace, site, build run and budget; two app_user connections play the publication step and
// a concurrent caller. Everything the owner creates is removed in afterAll.
const ownerUrl = process.env.SITE_BUILD_BUDGET_LOCK_TEST_DATABASE_URL;
const appUrl = process.env.SITE_BUILD_BUDGET_LOCK_TEST_APP_DATABASE_URL;
if (Boolean(ownerUrl) !== Boolean(appUrl)) {
  throw new Error(
    'site-build budget lock test needs both SITE_BUILD_BUDGET_LOCK_TEST_DATABASE_URL and SITE_BUILD_BUDGET_LOCK_TEST_APP_DATABASE_URL',
  );
}
for (const value of [ownerUrl, appUrl]) {
  if (!value) continue;
  const url = new URL(value);
  if (
    url.protocol !== 'postgresql:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/global_test' ||
    url.searchParams.has('host')
  ) {
    throw new Error('site-build budget lock test requires a loopback test database');
  }
}

/** The SQLSTATE PostgreSQL raised through a Prisma raw query, or null. */
function sqlState(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2010') {
    return null;
  }
  const code = (error.meta as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : null;
}

type BudgetFields = { paid_calls_enabled: boolean; disabled_reason: string | null };

describe.runIf(Boolean(ownerUrl && appUrl))('site-build budget lock for publication', () => {
  // Created only when the suite runs: collecting a skipped suite still executes this body.
  let owner: PrismaClient;
  let app: PrismaClient;
  let concurrent: PrismaClient;
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const siteId = randomUUID();
  const buildRunId = randomUUID();

  beforeAll(async () => {
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    app = new PrismaClient({ datasourceUrl: appUrl });
    concurrent = new PrismaClient({ datasourceUrl: appUrl });
    await owner.$transaction([
      owner.$executeRaw`INSERT INTO workspace (id, updated_at) VALUES (${workspaceId}::uuid, now())`,
      owner.$executeRaw`
        INSERT INTO site (id, workspace_id, name, slug, intake, updated_at)
        VALUES (${siteId}::uuid, ${workspaceId}::uuid, 'budget lock spec', ${`budget-lock-${siteId}`},
          '{}'::jsonb, now())`,
      owner.$executeRaw`
        INSERT INTO site_build_run (id, workspace_id, site_id)
        VALUES (${buildRunId}::uuid, ${workspaceId}::uuid, ${siteId}::uuid)`,
      owner.$executeRaw`
        INSERT INTO site_build_budget (build_run_id, workspace_id, site_id, cap_microusd,
          paid_calls_enabled, disabled_reason, updated_at)
        VALUES (${buildRunId}::uuid, ${workspaceId}::uuid, ${siteId}::uuid, 1000000,
          false, 'run_succeeded', now())`,
    ]);
  });

  afterAll(async () => {
    if (owner) {
      // Deleting the site cascades to the build run and its budget.
      await owner.$executeRaw`DELETE FROM site WHERE id = ${siteId}::uuid`;
      await owner.$executeRaw`DELETE FROM workspace WHERE id = ${workspaceId}::uuid`;
    }
    await Promise.all([owner?.$disconnect(), app?.$disconnect(), concurrent?.$disconnect()]);
  });

  const lockAs = (
    client: Prisma.TransactionClient,
    workspace: string,
  ): Promise<BudgetFields[]> =>
    client.$queryRaw<BudgetFields[]>`
      SELECT paid_calls_enabled, disabled_reason
      FROM lock_site_build_budget_for_publication(${workspace}::uuid, ${buildRunId}::uuid)`;

  const inWorkspace = <T>(
    client: PrismaClient,
    workspace: string,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> =>
    client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspace}, true)`;
        return work(tx);
      },
      { timeout: 15_000 },
    );

  /** Holds the publication lock in one transaction until `release` is called. */
  const holdLock = (): { held: Promise<void>; done: Promise<BudgetFields[]>; release: () => void } => {
    let release!: () => void;
    const mayCommit = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const hasLock = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const done = inWorkspace(app, workspaceId, async (tx) => {
      const rows = await lockAs(tx, workspaceId);
      locked();
      await mayCommit;
      return rows;
    });
    // Fail fast instead of waiting for the timeout when the holder cannot lock at all.
    const held = Promise.race([
      hasLock,
      done.then(() => {
        throw new Error('the holding transaction ended before it held the lock');
      }),
    ]);
    return { held, done, release };
  };

  it('refuses app_user a row lock taken directly: budget rows change only through owner routines', async () => {
    const attempt = inWorkspace(app, workspaceId, (tx) =>
      tx.$queryRaw`
        SELECT paid_calls_enabled FROM site_build_budget
        WHERE build_run_id = ${buildRunId}::uuid
        FOR UPDATE`,
    );
    await expect(attempt).rejects.toSatisfy((error: unknown) => sqlState(error) === '42501');
  });

  it("returns the budget fields of the caller's own build run", async () => {
    const rows = await inWorkspace(app, workspaceId, (tx) => lockAs(tx, workspaceId));
    expect(rows).toEqual([{ paid_calls_enabled: false, disabled_reason: 'run_succeeded' }]);
  });

  it("holds the budget row lock until the caller's transaction ends", async () => {
    const holder = holdLock();
    await holder.held;

    const blocked = inWorkspace(concurrent, workspaceId, async (tx) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '200ms'`;
      return lockAs(tx, workspaceId);
    });
    await expect(blocked).rejects.toSatisfy((error: unknown) => sqlState(error) === '55P03');

    holder.release();
    await expect(holder.done).resolves.toHaveLength(1);
    await expect(inWorkspace(concurrent, workspaceId, (tx) => lockAs(tx, workspaceId))).resolves.toHaveLength(1);
  }, 20_000);

  it('makes budget settlement wait: disable_site_build_paid_calls cannot change the row while it is locked', async () => {
    const holder = holdLock();
    await holder.held;

    const settlement = inWorkspace(concurrent, workspaceId, async (tx) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '200ms'`;
      return tx.$queryRaw`
        SELECT disable_site_build_paid_calls(${workspaceId}::uuid, ${buildRunId}::uuid, 'manual'::text)`;
    });
    await expect(settlement).rejects.toSatisfy((error: unknown) => sqlState(error) === '55P03');

    holder.release();
    await expect(holder.done).resolves.toEqual([
      { paid_calls_enabled: false, disabled_reason: 'run_succeeded' },
    ]);
  }, 20_000);

  it('refuses a caller whose transaction is scoped to another workspace', async () => {
    const attempt = inWorkspace(app, otherWorkspaceId, (tx) => lockAs(tx, workspaceId));
    await expect(attempt).rejects.toSatisfy((error: unknown) => sqlState(error) === 'P0001');
  });

  it('returns nothing for a build run without a budget', async () => {
    const rows = await inWorkspace(app, workspaceId, (tx) =>
      tx.$queryRaw<BudgetFields[]>`
        SELECT paid_calls_enabled, disabled_reason
        FROM lock_site_build_budget_for_publication(${workspaceId}::uuid, ${randomUUID()}::uuid)`,
    );
    expect(rows).toEqual([]);
  });

  it('is executable by app_user only', async () => {
    const [grants] = await owner.$queryRaw<{ appUser: boolean; publicRole: boolean; definer: boolean }[]>`
      SELECT has_function_privilege('app_user', p.oid, 'EXECUTE') AS "appUser",
        EXISTS (
          SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
          WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS "publicRole",
        p.prosecdef AS definer
      FROM pg_proc p
      WHERE p.oid = 'public.lock_site_build_budget_for_publication(uuid, uuid)'::regprocedure`;
    expect(grants).toEqual({ appUser: true, publicRole: false, definer: true });
  });
});
