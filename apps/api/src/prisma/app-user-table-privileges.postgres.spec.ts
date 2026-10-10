import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  enqueuePatentLookup,
  inventorErasureKeys,
  readPatentCache,
} from '../adapters/patent-inventor-cache';
import { WebsiteWatchService } from '../intent/website-watch.service';
import { SignalIngestService } from '../signals/signal-ingest.service';
import type { PrismaService } from './prisma.service';

// Explicitly opted-in, disposable and migrated PostgreSQL only. The owner connection reads the
// catalog and creates probe objects; the app_user connection performs the writes app_user's code
// paths perform and attempts the ones they never need. Every attempt runs in a transaction that is
// always rolled back, so nothing is written even where a write is allowed.
const ownerUrl = process.env.APP_USER_PRIVILEGES_TEST_DATABASE_URL;
const appUrl = process.env.APP_USER_PRIVILEGES_TEST_APP_DATABASE_URL;
if (Boolean(ownerUrl) !== Boolean(appUrl)) {
  throw new Error(
    'app_user table privilege test needs both APP_USER_PRIVILEGES_TEST_DATABASE_URL and APP_USER_PRIVILEGES_TEST_APP_DATABASE_URL',
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
    throw new Error('app_user table privilege test requires a loopback test database');
  }
}

/**
 * docs/governance/app-user-table-privileges.json: every relation in schema public mapped to the
 * privileges app_user holds on it (column-only privileges under `columns`), plus the owner's
 * default privileges for app_user. A new table or a changed grant fails this test until the
 * manifest is updated in the same change, so every privilege change is reviewed.
 */
interface DefaultPrivilege {
  owner: string;
  schema: string;
  objectType: 'tables' | 'sequences';
  privileges: string[];
}
interface Manifest {
  schemaVersion: string;
  role: string;
  schema: string;
  defaultPrivileges: DefaultPrivilege[];
  tables: Record<string, string[]>;
  columns: Record<string, Record<string, string[]>>;
}

const MANIFEST_PATH = path.resolve(
  import.meta.dirname,
  '../../../../docs/governance/app-user-table-privileges.json',
);
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;

const TABLE_PRIVILEGES = ['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'];
const COLUMN_PRIVILEGES = ['INSERT', 'REFERENCES', 'SELECT', 'UPDATE'];
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/u;

/** Byte-order sort, the order PostgreSQL's "C" collation and the manifest use. */
function sortedKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** relation (or relation.column) → comma-joined privileges, the shape the catalog query returns. */
function manifestEntries(source: Manifest): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const table of sortedKeys(source.tables)) entries[table] = source.tables[table].join(',');
  for (const table of sortedKeys(source.columns)) {
    for (const column of sortedKeys(source.columns[table])) {
      entries[`${table}.${column}`] = source.columns[table][column].join(',');
    }
  }
  return entries;
}

describe('app_user table privilege manifest', () => {
  it('is closed, sorted and names only known privileges', () => {
    expect(sortedKeys(manifest as unknown as Record<string, unknown>)).toEqual([
      'columns',
      'defaultPrivileges',
      'role',
      'schema',
      'schemaVersion',
      'tables',
    ]);
    expect(manifest.schemaVersion).toBe('app-user-table-privileges/v1');
    expect(manifest.role).toBe('app_user');
    expect(manifest.schema).toBe('public');
    expect(Object.keys(manifest.tables)).toEqual(sortedKeys(manifest.tables));
    expect(Object.keys(manifest.tables).length).toBeGreaterThan(100);
    for (const [table, privileges] of Object.entries(manifest.tables)) {
      expect(table, table).toMatch(IDENTIFIER);
      expect(privileges, table).toEqual([...new Set(privileges)].sort());
      for (const privilege of privileges) expect(TABLE_PRIVILEGES, table).toContain(privilege);
    }
    expect(Object.keys(manifest.columns)).toEqual(sortedKeys(manifest.columns));
    for (const [table, columns] of Object.entries(manifest.columns)) {
      expect(manifest.tables, table).toHaveProperty(table);
      expect(Object.keys(columns), table).toEqual(sortedKeys(columns));
      for (const [column, privileges] of Object.entries(columns)) {
        expect(column, `${table}.${column}`).toMatch(IDENTIFIER);
        expect(privileges.length, `${table}.${column}`).toBeGreaterThan(0);
        expect(privileges, `${table}.${column}`).toEqual([...new Set(privileges)].sort());
        for (const privilege of privileges) {
          expect(COLUMN_PRIVILEGES, `${table}.${column}`).toContain(privilege);
          // A column entry lists only what the table-level grant does not already give.
          expect(manifest.tables[table], `${table}.${column}`).not.toContain(privilege);
        }
      }
    }
    expect(manifest.defaultPrivileges).toEqual([
      { owner: 'global', schema: 'public', objectType: 'tables', privileges: ['SELECT'] },
      { owner: 'global', schema: 'public', objectType: 'sequences', privileges: ['SELECT', 'USAGE'] },
    ]);
  });
});

/**
 * app_user's effective privileges on every relation in schema public, the same reading as the
 * self-check in 20261010090000_app_user_table_privileges: a privilege counts when app_user holds it
 * directly, through PUBLIC or an inherited membership, or through a role it can SET ROLE to or
 * administers (it could grant itself that role and switch to it); a superuser or the relation's
 * owner among those roles holds every privilege. A privilege held only on columns is reported per
 * column, as relation.column.
 */
const EFFECTIVE_PRIVILEGES_SQL = `
  WITH reach AS (
    SELECT r.oid, r.rolsuper
    FROM pg_catalog.pg_roles AS r
    WHERE pg_catalog.pg_has_role('app_user', r.oid, 'SET')
      OR pg_catalog.pg_has_role('app_user', r.oid, 'MEMBER WITH ADMIN OPTION')
  ),
  relation AS (
    SELECT c.oid, c.relname::text AS relname, c.relowner
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  ),
  privilege(p) AS (
    SELECT unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
    UNION ALL
    SELECT 'MAINTAIN' WHERE pg_catalog.current_setting('server_version_num')::int >= 170000
  ),
  table_level AS (
    SELECT rel.oid, rel.relname, pr.p AS privilege
    FROM relation AS rel
    CROSS JOIN privilege AS pr
    WHERE EXISTS (
      SELECT 1 FROM reach AS a
      WHERE a.rolsuper
        OR a.oid = rel.relowner
        OR pg_catalog.has_table_privilege(a.oid, rel.oid, pr.p))
  ),
  column_level AS (
    SELECT rel.relname || '.' || att.attname AS target, p.privilege
    FROM relation AS rel
    JOIN pg_catalog.pg_attribute AS att
      ON att.attrelid = rel.oid AND att.attnum > 0 AND NOT att.attisdropped
    CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p(privilege)
    WHERE NOT EXISTS (
        SELECT 1 FROM table_level AS t WHERE t.oid = rel.oid AND t.privilege = p.privilege)
      AND EXISTS (
        SELECT 1 FROM reach AS a
        WHERE pg_catalog.has_column_privilege(a.oid, rel.oid, att.attnum, p.privilege))
  )
  SELECT rel.relname AS target,
    coalesce((SELECT string_agg(t.privilege, ',' ORDER BY t.privilege COLLATE "C")
      FROM table_level AS t WHERE t.oid = rel.oid), '') AS privileges
  FROM relation AS rel
  UNION ALL
  SELECT target, string_agg(privilege, ',' ORDER BY privilege COLLATE "C")
  FROM column_level
  GROUP BY target`;

class RolledBack extends Error {}

/** Runs body in one transaction on client and always rolls it back; other errors propagate. */
async function rolledBack(
  client: PrismaClient,
  body: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<void> {
  try {
    await client.$transaction(
      async (tx) => {
        await body(tx);
        throw new RolledBack();
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
  } catch (error) {
    if (!(error instanceof RolledBack)) throw error;
  }
}

/** The table PostgreSQL refused with 42501, or null for any other outcome. */
function permissionDeniedTable(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2010') {
    return null;
  }
  const meta = error.meta as { code?: unknown; message?: unknown } | undefined;
  if (meta?.code !== '42501' || typeof meta.message !== 'string') return null;
  return /^ERROR: permission denied for table (\w+)$/u.exec(meta.message)?.[1] ?? null;
}

const quoted = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

describe.runIf(Boolean(ownerUrl && appUrl))('app_user table privileges on PostgreSQL', () => {
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

  it('connects the app side as app_user without superuser rights', async () => {
    const [identity] = await app.$queryRaw<
      { current: string; session: string; superuser: string }[]
    >`SELECT current_user::text AS current, session_user::text AS session,
        current_setting('is_superuser') AS superuser`;
    expect(identity).toEqual({ current: 'app_user', session: 'app_user', superuser: 'off' });
  });

  it("gives app_user exactly the manifest's privileges on every relation in schema public", async () => {
    const rows = await owner.$queryRawUnsafe<{ target: string; privileges: string }[]>(
      EFFECTIVE_PRIVILEGES_SQL,
    );
    const actual = Object.fromEntries(rows.map(({ target, privileges }) => [target, privileges]));
    expect(actual).toEqual(manifestEntries(manifest));
  }, 30_000);

  it('lets app_user grant nothing onward', async () => {
    const held = await owner.$queryRaw<{ entry: string }[]>`
      SELECT c.relname || ' ' || p.privilege AS entry
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
        AS p(privilege)
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND CASE WHEN p.privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
          THEN pg_catalog.has_any_column_privilege('app_user', c.oid, p.privilege || ' WITH GRANT OPTION')
          ELSE pg_catalog.has_table_privilege('app_user', c.oid, p.privilege || ' WITH GRANT OPTION') END
      ORDER BY 1`;
    expect(held.map(({ entry }) => entry)).toEqual([]);
  }, 30_000);

  it("keeps the owner's default privileges for app_user and PUBLIC to the manifest's", async () => {
    // Every default-ACL entry, for any owner and in any or no schema, that names app_user or PUBLIC
    // for tables or sequences. A write here would reach every table created later.
    const rows = await owner.$queryRaw<{ entry: string }[]>`
      SELECT format('%s %s %s %s %s',
          pg_catalog.pg_get_userbyid(d.defaclrole),
          coalesce(nsp.nspname::text, '*'),
          CASE d.defaclobjtype WHEN 'r' THEN 'tables' ELSE 'sequences' END,
          CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END,
          a.privilege_type || CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END) AS entry
      FROM pg_catalog.pg_default_acl AS d
      LEFT JOIN pg_catalog.pg_namespace AS nsp ON nsp.oid = d.defaclnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) AS a
      WHERE d.defaclobjtype IN ('r', 'S')
        AND (a.grantee = 0 OR a.grantee = 'app_user'::regrole)`;
    const expected = manifest.defaultPrivileges
      .flatMap(({ owner: role, schema, objectType, privileges }) =>
        privileges.map((privilege) => `${role} ${schema} ${objectType} app_user ${privilege}`))
      .sort();
    expect(rows.map(({ entry }) => entry).sort()).toEqual(expected);
  }, 30_000);

  it('gives app_user SELECT only on a table the owner creates now, and keeps sequence defaults', async () => {
    const [{ owner: defaultOwner }] = manifest.defaultPrivileges;
    let granted: { object: string; privilege: string }[] = [];
    await rolledBack(owner, async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${quoted(defaultOwner)}`);
      await tx.$executeRawUnsafe('CREATE TABLE public.app_user_default_privilege_probe (id integer)');
      await tx.$executeRawUnsafe('CREATE SEQUENCE public.app_user_default_privilege_probe_seq');
      granted = await tx.$queryRaw<{ object: string; privilege: string }[]>`
        SELECT 'table' AS object, p.privilege
        FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
          AS p(privilege)
        WHERE pg_catalog.has_table_privilege(
          'app_user', 'public.app_user_default_privilege_probe', p.privilege)
        UNION ALL
        SELECT 'sequence', p.privilege
        FROM unnest(ARRAY['SELECT', 'USAGE', 'UPDATE']) AS p(privilege)
        WHERE pg_catalog.has_sequence_privilege(
          'app_user', 'public.app_user_default_privilege_probe_seq', p.privilege)
        ORDER BY 1, 2`;
    });
    expect(granted).toEqual([
      { object: 'sequence', privilege: 'SELECT' },
      { object: 'sequence', privilege: 'USAGE' },
      { object: 'table', privilege: 'SELECT' },
    ]);
  }, 30_000);

  // Positive: each write the app_user code paths perform on the ten platform tables they write,
  // with the same Prisma calls (or the production function itself), as app_user.
  it('lets app_user register, fetch, diff and purge website-watch and acquisition sources', async () => {
    const suffix = randomUUID();
    const now = new Date();
    await rolledBack(app, async (tx) => {
      const sourceKey = `web_watch:privileges-${suffix}.example`;
      // intent-projection.service.ts registerWatch: look up, create, merge pages.
      expect(await tx.monitoredSource.findUnique({ where: { sourceKey }, select: { id: true } }))
        .toBeNull();
      const source = await tx.monitoredSource.create({
        data: {
          providerKey: 'web_watch',
          sourceKey,
          label: 'privileges probe',
          config: { company: { name: 'Privileges Probe', domain: 'privileges.example' }, pages: [] },
          cadence: { kind: 'fixed', everyMs: 86_400_000 },
          region: 'DE',
          status: 'ACTIVE',
        },
      });
      await tx.monitoredSource.update({
        where: { id: source.id },
        data: {
          config: {
            company: { name: 'Privileges Probe', domain: 'privileges.example' },
            pages: [{ url: 'https://privileges.example/', kind: 'home' }],
          },
        },
      });
      // website-watch.service.ts watch / acquisition.service.ts acquire: open a fetch, write the
      // snapshot and its changes, close the fetch, move the schedule.
      const fetch = await tx.sourceFetch.create({
        data: { sourceId: source.id, status: 'RUNNING', parserVersion: 'web-watch/v1' },
      });
      expect(await tx.sourceEntity.findMany({ where: { sourceId: source.id } })).toEqual([]);
      await tx.sourceEntity.createMany({
        data: [{
          sourceId: source.id,
          externalId: 'privileges-company',
          entityKind: 'company',
          name: 'Privileges Probe',
          domain: 'privileges.example',
          country: 'DE',
          cleaned: {},
          contentHash: 'hash-1',
          firstSeenAt: now,
          lastSeenAt: now,
          lastSeenFetchId: fetch.id,
        }],
        skipDuplicates: true,
      });
      const page = await tx.sourceEntity.create({
        data: {
          sourceId: source.id,
          externalId: 'https://privileges.example/',
          entityKind: 'web_page',
          name: 'Privileges Probe',
          domain: 'privileges.example',
          country: 'DE',
          cleaned: { page_kind: 'home' },
          contentHash: 'hash-2',
          firstSeenAt: now,
          lastSeenAt: now,
        },
      });
      await tx.sourceEntity.update({
        where: { id: page.id },
        data: { lastSeenAt: now, missCount: 0, lastSeenFetchId: fetch.id },
      });
      await tx.sourceEntityChange.createMany({
        data: [{
          sourceId: source.id,
          fetchId: fetch.id,
          externalId: page.externalId,
          changeType: 'ADDED',
          detail: { page_kind: 'home' },
        }],
      });
      await tx.sourceFetch.update({
        where: { id: fetch.id },
        data: { status: 'DONE', total: 1, added: 1, updated: 0, finishedAt: now },
      });
      await tx.monitoredSource.update({
        where: { id: source.id },
        data: { lastFetchAt: now, nextFetchAt: new Date(now.getTime() + 86_400_000) },
      });
      // website-watch.service.ts purgeStaleEvents: the 90-day retention delete. A cutoff one minute
      // ahead reaches the change written above.
      const purged = await new WebsiteWatchService({
        prisma: tx as unknown as PrismaService,
        fetcher: { fetch: async () => null },
      }).purgeStaleEvents(-60_000);
      expect(purged.deleted).toBeGreaterThanOrEqual(1);
    });
  }, 60_000);

  it('lets app_user ingest, re-observe and expire source signals and keep the ingest ledger', async () => {
    const suffix = randomUUID();
    const now = new Date();
    await rolledBack(app, async (tx) => {
      const ledgerKey = { providerKey: 'ted', queryFingerprint: `privileges-${suffix}`, windowKey: now.toISOString() };
      // signal-ingest.service.ts ingest: ledger gate, idempotent signal upsert, ledger upsert.
      expect(await tx.signalIngest.findUnique({
        where: { providerKey_queryFingerprint_windowKey: ledgerKey },
      })).toBeNull();
      const signalKey = {
        providerKey: 'ted',
        externalId: `privileges-${suffix}`,
        signalType: 'TENDER_PUBLISHED',
        subjectKey: `privileges-${suffix}`,
      };
      for (const observedAt of [now, new Date(now.getTime() + 1_000)]) {
        await tx.sourceSignal.upsert({
          where: { providerKey_externalId_signalType_subjectKey: signalKey },
          create: {
            ...signalKey,
            subjectName: 'Privileges Probe',
            subjectCountry: 'DE',
            taxonomyKeys: ['cpv:42122000'],
            strength: 0.5,
            occurredAt: new Date(now.getTime() - 86_400_000),
            observedAt,
            payload: {},
            license: 'CC BY 4.0',
            jurisdiction: 'EU',
            expiresAt: new Date(now.getTime() - 1_000),
          },
          update: { observedAt },
        });
        await tx.signalIngest.upsert({
          where: { providerKey_queryFingerprint_windowKey: ledgerKey },
          create: {
            ...ledgerKey,
            querySpec: {},
            recordsFetched: 1,
            signalsUpserted: 1,
            status: 'OK',
            error: null,
            fetchedAt: observedAt,
          },
          update: { recordsFetched: 1, signalsUpserted: 1, status: 'OK', error: null, fetchedAt: observedAt },
        });
      }
      // writeLedgerError: never overwrite an OK row; otherwise record the error.
      const errorKey = { ...ledgerKey, queryFingerprint: `privileges-error-${suffix}` };
      const updated = await tx.signalIngest.updateMany({
        where: { ...errorKey, status: { not: 'OK' } },
        data: { status: 'ERROR', error: 'probe', recordsFetched: 0, signalsUpserted: 0, fetchedAt: now },
      });
      expect(updated.count).toBe(0);
      await tx.signalIngest.create({
        data: {
          ...errorKey,
          querySpec: {},
          recordsFetched: 0,
          signalsUpserted: 0,
          status: 'ERROR',
          error: 'probe',
          fetchedAt: now,
        },
      });
      // external-intent.activities.ts expireStale: ACTIVE past expiresAt becomes EXPIRED.
      const expired = await new SignalIngestService({
        prisma: tx as unknown as PrismaService,
      }).expireStale(now);
      expect(expired).toBeGreaterThanOrEqual(1);
    });
  }, 60_000);

  it('lets app_user add and refine taxonomy aliases', async () => {
    const term = `privileges probe ${randomUUID()}`;
    await rolledBack(app, async (tx) => {
      // taxonomy-resolver.ts: alias lookup, then the cold-path write-back (create, then refine).
      expect(await tx.termAlias.findUnique({ where: { kind_term: { kind: 'cpv', term } } })).toBeNull();
      for (const code of ['42122000', '42122130']) {
        await tx.termAlias.upsert({
          where: { kind_term: { kind: 'cpv', term } },
          update: { code, source: 'llm' },
          create: { kind: 'cpv', term, code, source: 'llm' },
        });
      }
    });
  }, 60_000);

  it('lets app_user queue patent lookups, read the cache and record an Art.17 erasure', async () => {
    const companyName = `Privilegesprobe${randomUUID().slice(0, 8)} GmbH`;
    const erasureKeys = inventorErasureKeys('Privilegesprobe Testperson');
    expect(erasureKeys.length).toBeGreaterThan(0);
    await rolledBack(app, async (tx) => {
      // discovery.activities.ts / provider.registry.ts: queue the lookup, then re-request it.
      for (let request = 0; request < 2; request += 1) {
        expect(await enqueuePatentLookup(tx, { companyName, country: 'DE' })).toEqual({ enqueued: true });
      }
      // provider.registry.ts: read the cache (no egress).
      expect(await readPatentCache(tx, companyName, { fromYear: 2021, toYear: 2026 })).toEqual([]);
      // deletion.activities.ts eraseSubject: tombstones first (idempotent), then the cache rows.
      for (let erasure = 0; erasure < 2; erasure += 1) {
        await tx.patentInventorTombstone.createMany({
          data: erasureKeys.map((inventorNameKey) => ({ inventorNameKey })),
          skipDuplicates: true,
        });
      }
      await tx.patentInventorCache.deleteMany({ where: { inventorNameKey: { in: erasureKeys } } });
    });
  }, 60_000);

  // Negative: every INSERT, UPDATE, DELETE and TRUNCATE (and SELECT where the manifest lists
  // none) outside the manifest is refused with 42501 on the relation itself. Each statement needs
  // only its own privilege and touches no row.
  it('refuses app_user every read and write the manifest does not list', async () => {
    const relations = await owner.$queryRaw<
      { relname: string; table: boolean; firstColumn: string }[]
    >`
      SELECT c.relname::text AS relname, c.relkind IN ('r', 'p') AS "table",
        (SELECT a.attname::text FROM pg_catalog.pg_attribute AS a
          WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum LIMIT 1) AS "firstColumn"
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      ORDER BY 1`;
    expect(sortedKeys(Object.fromEntries(relations.map(({ relname }) => [relname, true]))))
      .toEqual(sortedKeys(manifest.tables));

    const attempts: Array<readonly [string, string, string]> = [];
    // Views and foreign tables would need their own statements; the catalog test covers them.
    for (const { relname, firstColumn } of relations.filter(({ table }) => table)) {
      const table = `public.${quoted(relname)}`;
      const held = new Set([
        ...manifest.tables[relname],
        ...Object.values(manifest.columns[relname] ?? {}).flat(),
      ]);
      const statements: ReadonlyArray<readonly [string, string]> = [
        ['SELECT', `SELECT 1 FROM ${table} LIMIT 0`],
        ['INSERT', `INSERT INTO ${table} DEFAULT VALUES`],
        ['UPDATE', `UPDATE ${table} SET ${quoted(firstColumn)} = DEFAULT WHERE false`],
        ['DELETE', `DELETE FROM ${table} WHERE false`],
        ['TRUNCATE', `TRUNCATE ${table}`],
      ];
      for (const [privilege, statement] of statements) {
        if (!held.has(privilege)) attempts.push([relname, privilege, statement]);
      }
    }
    expect(attempts.length).toBeGreaterThan(0);

    const outcomes: string[] = [];
    for (const [relname, privilege, statement] of attempts) {
      try {
        await rolledBack(app, async (tx) => {
          await tx.$executeRawUnsafe(statement);
        });
        outcomes.push(`${relname} ${privilege} allowed`);
      } catch (error) {
        const denied = permissionDeniedTable(error);
        outcomes.push(
          denied === relname
            ? `${relname} ${privilege} denied`
            : `${relname} ${privilege} failed otherwise: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    expect(outcomes).toEqual(attempts.map(([relname, privilege]) => `${relname} ${privilege} denied`));
  }, 180_000);
});
