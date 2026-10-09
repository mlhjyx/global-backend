import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Explicitly opted-in, disposable and migrated PostgreSQL only. The owner connection reads the
// catalog; the app_user connection attempts writes that must be refused. Every attempt runs in a
// transaction that is always rolled back, so nothing is written even where a write is allowed.
const ownerUrl = process.env.GOVERNANCE_TABLES_TEST_DATABASE_URL;
const appUrl = process.env.GOVERNANCE_TABLES_TEST_APP_DATABASE_URL;
if (Boolean(ownerUrl) !== Boolean(appUrl)) {
  throw new Error(
    'governance table privilege test needs both GOVERNANCE_TABLES_TEST_DATABASE_URL and GOVERNANCE_TABLES_TEST_APP_DATABASE_URL',
  );
}
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
type Table = (typeof TABLES)[number];

/** The column that opens or closes each gate. */
const GATE_COLUMN: Readonly<Record<Table, string>> = {
  source_policy: 'review_status',
  data_provider: 'status',
};

/**
 * Each statement needs its privilege. INSERT, UPDATE and DELETE touch no row; TRUNCATE would
 * empty the table, which is why every attempt runs in a transaction that is always rolled back.
 */
const ATTEMPTS: ReadonlyArray<readonly [string, (table: Table) => string]> = [
  ['INSERT', (table) => `INSERT INTO public.${table} SELECT * FROM public.${table} WHERE false`],
  [
    'UPDATE',
    (table) =>
      `UPDATE public.${table} SET ${GATE_COLUMN[table]} = ${GATE_COLUMN[table]} WHERE false`,
  ],
  ['DELETE', (table) => `DELETE FROM public.${table} WHERE false`],
  ['TRUNCATE', (table) => `TRUNCATE public.${table}`],
];

class WriteAllowed extends Error {}

/** The table PostgreSQL refused with 42501, or null for any other outcome. */
function permissionDeniedTable(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2010') {
    return null;
  }
  const meta = error.meta as { code?: unknown; message?: unknown } | undefined;
  if (meta?.code !== '42501' || typeof meta.message !== 'string') return null;
  return /^ERROR: permission denied for table (\w+)$/u.exec(meta.message)?.[1] ?? null;
}

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

  it('gives app_user SELECT and nothing else on either table, column grants included', async () => {
    const rows = await owner.$queryRaw<{ table: string; privilege: string; granted: boolean }[]>`
      SELECT t.name AS "table", p.privilege,
        CASE WHEN p.privilege IN ('INSERT', 'UPDATE', 'REFERENCES')
          THEN pg_catalog.has_any_column_privilege('app_user', 'public.' || t.name, p.privilege)
          ELSE pg_catalog.has_table_privilege('app_user', 'public.' || t.name, p.privilege)
        END AS granted
      FROM unnest(ARRAY['source_policy', 'data_provider']) AS t(name)
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
        AS p(privilege)
      ORDER BY 1, 2`;
    expect(rows).toHaveLength(TABLES.length * 7);
    expect(rows.filter(({ granted }) => granted).map(({ table, privilege }) => `${table} ${privilege}`))
      .toEqual(['data_provider SELECT', 'source_policy SELECT']);
  }, 30_000);

  it('lets no role but the table owner write either table, directly or with SET ROLE', async () => {
    // Every role except superusers, PostgreSQL's predefined pg_* roles and the owner: app_user,
    // the runtime roles and their logins, and anything that inherits from them. A role counts as
    // a writer when it holds the privilege on the table or on any of its columns, or can SET ROLE
    // to a role that does, to the owner or to a superuser.
    const writers = await owner.$queryRaw<{ entry: string }[]>`
      SELECT DISTINCT format('%s %s %s',
          CASE WHEN assumed.oid = member.oid THEN member.rolname::text
            ELSE format('%s (SET ROLE %s)', member.rolname, assumed.rolname) END,
          c.relname, p.privilege) AS entry
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN pg_catalog.pg_roles member
      CROSS JOIN pg_catalog.pg_roles assumed
      CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
        AS p(privilege)
      WHERE n.nspname = 'public'
        AND c.relname IN ('source_policy', 'data_provider')
        AND NOT member.rolsuper
        AND left(member.rolname, 3) <> 'pg_'
        AND member.oid <> c.relowner
        AND pg_catalog.pg_has_role(member.oid, assumed.oid, 'SET')
        AND (assumed.rolsuper
          OR assumed.oid = c.relowner
          OR CASE WHEN p.privilege IN ('INSERT', 'UPDATE', 'REFERENCES')
            THEN pg_catalog.has_any_column_privilege(assumed.oid, c.oid, p.privilege)
            ELSE pg_catalog.has_table_privilege(assumed.oid, c.oid, p.privilege) END)
      ORDER BY 1`;
    expect(writers.map(({ entry }) => entry)).toEqual([]);
  }, 30_000);

  it('exposes neither table through a view or rule', async () => {
    // The owner's default privileges give app_user write access to every new view as well, and a
    // view writes its base table with the view owner's rights.
    const dependents = await owner.$queryRaw<{ relation: string }[]>`
      SELECT DISTINCT dependent.oid::regclass::text AS relation
      FROM pg_catalog.pg_depend d
      JOIN pg_catalog.pg_rewrite rw ON rw.oid = d.objid
      JOIN pg_catalog.pg_class dependent ON dependent.oid = rw.ev_class
      WHERE d.classid = 'pg_catalog.pg_rewrite'::regclass
        AND d.refclassid = 'pg_catalog.pg_class'::regclass
        AND d.refobjid IN ('public.source_policy'::regclass, 'public.data_provider'::regclass)
      ORDER BY 1`;
    expect(dependents.map(({ relation }) => relation)).toEqual([]);
  }, 30_000);

  it('refuses every write app_user attempts and still lets it read', async () => {
    const [identity] = await app.$queryRaw<{ current: string; session: string }[]>`
      SELECT current_user::text AS current, session_user::text AS session`;
    expect(identity).toEqual({ current: 'app_user', session: 'app_user' });

    const outcomes: string[] = [];
    for (const table of TABLES) {
      for (const [privilege, statement] of ATTEMPTS) {
        try {
          await app.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(statement(table));
            throw new WriteAllowed();
          });
        } catch (error) {
          const denied = permissionDeniedTable(error);
          outcomes.push(
            error instanceof WriteAllowed
              ? `${table} ${privilege} allowed`
              : denied === table
                ? `${table} ${privilege} denied`
                : `${table} ${privilege} failed otherwise: ${error instanceof Error ? error.message : String(error)}`,
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
