import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Explicitly opted-in, disposable and migrated PostgreSQL only. The owner connection reads the
// catalog; the app_user connection attempts writes that must be refused. Every attempt runs in a
// transaction that is always rolled back, so nothing is written even where a write is allowed.
const ownerUrl = process.env.GOVERNANCE_TABLES_TEST_DATABASE_URL;
const appUrl = process.env.GOVERNANCE_TABLES_TEST_APP_DATABASE_URL;
for (const value of [ownerUrl, appUrl]) {
  if (!value) continue;
  const url = new URL(value);
  if (
    url.protocol !== 'postgresql:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/global_test'
  ) {
    throw new Error('governance table privilege test requires a loopback test database');
  }
}

/**
 * source_policy is the per-domain allow/block list for Raw ingestion and the ToolBroker;
 * data_provider.status turns a data provider on or off. Only the owner connection writes them
 * (the provider-registry and sanctions seeds, operator scripts). Every other role reads at most.
 */
const TABLES = ['source_policy', 'data_provider'] as const;

/** Zero-row statements: each needs its privilege and changes nothing where it is granted. */
const ATTEMPTS: ReadonlyArray<readonly [string, (table: string) => string]> = [
  ['INSERT', (table) => `INSERT INTO public.${table} SELECT * FROM public.${table} WHERE false`],
  ['UPDATE', (table) => `UPDATE public.${table} SET id = id WHERE false`],
  ['DELETE', (table) => `DELETE FROM public.${table} WHERE false`],
  ['TRUNCATE', (table) => `TRUNCATE public.${table}`],
];

class WriteAllowed extends Error {}

describe.runIf(Boolean(ownerUrl && appUrl))('governance tables are read-only for app_user', () => {
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

  it('gives app_user SELECT and nothing else on either table', async () => {
    const rows = await owner.$queryRaw<{ table: string; privilege: string; granted: boolean }[]>`
      SELECT t.name AS "table", p.privilege,
        pg_catalog.has_table_privilege('app_user', 'public.' || t.name, p.privilege) AS granted
      FROM unnest(ARRAY['source_policy', 'data_provider']) AS t(name)
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
        AS p(privilege)
      ORDER BY 1, 2`;
    expect(rows).toHaveLength(TABLES.length * 7);
    expect(rows.filter(({ granted }) => granted).map(({ table, privilege }) => `${table} ${privilege}`))
      .toEqual(['data_provider SELECT', 'source_policy SELECT']);
  }, 30_000);

  it('lets no role but the table owner write either table', async () => {
    // Every role except superusers, PostgreSQL's predefined pg_* roles and the owner: app_user,
    // the runtime roles and their logins, and anything that inherits from them.
    const writers = await owner.$queryRaw<{ role: string; table: string; privilege: string }[]>`
      SELECT r.rolname::text AS role, c.relname::text AS "table", p.privilege
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN pg_catalog.pg_roles r
      CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
        AS p(privilege)
      WHERE n.nspname = 'public'
        AND c.relname IN ('source_policy', 'data_provider')
        AND NOT r.rolsuper
        AND left(r.rolname, 3) <> 'pg_'
        AND r.oid <> c.relowner
        AND pg_catalog.has_table_privilege(r.oid, c.oid, p.privilege)
      ORDER BY 1, 2, 3`;
    expect(writers.map(({ role, table, privilege }) => `${role} ${table} ${privilege}`)).toEqual([]);
  }, 30_000);

  it('refuses every write app_user attempts and still lets it read', async () => {
    const outcomes: string[] = [];
    for (const table of TABLES) {
      for (const [privilege, statement] of ATTEMPTS) {
        try {
          await app.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(statement(table));
            throw new WriteAllowed();
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          outcomes.push(
            error instanceof WriteAllowed
              ? `${table} ${privilege} allowed`
              : /\b42501\b/u.test(message) && message.includes(`permission denied for table ${table}`)
                ? `${table} ${privilege} denied`
                : `${table} ${privilege} failed otherwise: ${message}`,
          );
        }
      }
      const counted = await app.$queryRawUnsafe<{ total: number }[]>(
        `SELECT count(*)::int AS total FROM public.${table}`,
      );
      expect(counted, `${table} readable`).toHaveLength(1);
    }
    expect(outcomes).toEqual(
      TABLES.flatMap((table) => ATTEMPTS.map(([privilege]) => `${table} ${privilege} denied`)),
    );
  }, 60_000);
});
