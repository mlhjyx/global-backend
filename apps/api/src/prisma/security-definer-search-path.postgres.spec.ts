import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Explicitly opted-in, disposable and migrated PostgreSQL only. The owner connection reads
// the catalog; the app_user connection plays a session that can create temporary tables.
const ownerUrl = process.env.SECURITY_DEFINER_TEST_DATABASE_URL;
const appUrl = process.env.SECURITY_DEFINER_TEST_APP_DATABASE_URL;
for (const value of [ownerUrl, appUrl]) {
  if (!value) continue;
  const url = new URL(value);
  if (
    url.protocol !== 'postgresql:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !['/global_test', '/security_definer_test'].includes(url.pathname)
  ) {
    throw new Error('SECURITY DEFINER test requires a loopback test database');
  }
}

describe.runIf(Boolean(ownerUrl && appUrl))('SECURITY DEFINER routines on the migrated schema', () => {
  // Created only when the suite runs: collecting a skipped suite still executes this body.
  let owner: PrismaClient;
  let app: PrismaClient;

  beforeAll(() => {
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    app = new PrismaClient({ datasourceUrl: appUrl });
  });

  afterAll(async () => {
    await Promise.all([owner?.$disconnect(), app?.$disconnect()]);
  });

  it('lists pg_temp last wherever a routine sets its search_path, and every SECURITY DEFINER routine sets one', async () => {
    const routines = await owner.$queryRaw<
      { routine: string; definer: boolean; searchPath: string | null }[]
    >`
      SELECT p.oid::regprocedure::text AS routine, p.prosecdef AS definer,
        (SELECT setting FROM unnest(p.proconfig) AS setting
          WHERE left(setting, 12) = 'search_path=') AS "searchPath"
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE left(n.nspname, 3) <> 'pg_'
        AND n.nspname <> 'information_schema'
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
      ORDER BY 1`;
    // A migrated schema has well over a hundred SECURITY DEFINER routines; fewer means the
    // query read the wrong database.
    expect(routines.filter(({ definer }) => definer).length).toBeGreaterThan(100);
    const offenders = routines
      .filter(({ definer, searchPath }) =>
        searchPath === null ? definer : !searchPath.endsWith(', pg_temp'))
      .map(({ routine, searchPath }) => `${routine} ${searchPath ?? '<no search_path>'}`);
    expect(offenders).toEqual([]);
  });

  it('reads its own table even when the calling session shadows it with a temporary table', async () => {
    // tool_budget_status reads "tool_budget_account" unqualified. With pg_temp searched first
    // it read the forged row below and failed on it (TOOL_BUDGET_HISTORICAL_TERMINAL); with
    // pg_temp last it reads public, where no such account exists, and returns nothing.
    const workspaceId = randomUUID();
    const rows = await app.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
      await tx.$executeRawUnsafe(
        'CREATE TEMP TABLE tool_budget_account (LIKE public.tool_budget_account INCLUDING DEFAULTS) ON COMMIT DROP',
      );
      await tx.$executeRaw`
        INSERT INTO pg_temp.tool_budget_account (scope_key, account_key, cap_cents)
        VALUES (${workspaceId}, 'shadow-probe', 1000000)`;
      return tx.$queryRaw<unknown[]>`SELECT * FROM tool_budget_status(${workspaceId}, 'shadow-probe')`;
    });
    expect(rows).toEqual([]);
  });
});
