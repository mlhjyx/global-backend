import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Formal-window real-schema checks for migration 20261123074206. Nothing here
// touches the private pure/fake layer: owner reads the catalog, and every
// app_user privilege assertion is answered by PostgreSQL's ACL functions.
const ownerUrl = process.env.CONTACT_ENRICHMENT_TEST_DATABASE_URL;
const appUrl = process.env.CONTACT_ENRICHMENT_TEST_APP_DATABASE_URL;
if (Boolean(ownerUrl) !== Boolean(appUrl)) {
  throw new Error(
    'contact enrichment migration test needs both CONTACT_ENRICHMENT_TEST_DATABASE_URL and CONTACT_ENRICHMENT_TEST_APP_DATABASE_URL',
  );
}
for (const value of [ownerUrl, appUrl]) {
  if (!value) continue;
  const url = new URL(value);
  if (
    url.protocol !== 'postgresql:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/global_test' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('contact enrichment migration test requires a loopback test database');
  }
}

const HEAD = 'contact_enrichment_execution';
const STEP = 'contact_enrichment_execution_step';
const HEAD_UPDATE_COLUMNS = ['result_revision', 'result_snapshot', 'status', 'target_snapshot'];
const STEP_UPDATE_COLUMNS = [
  'artifact_reference',
  'budget_operation_id',
  'candidate_ref',
  'contact_id',
  'dispatch_phase',
  'domain_state',
  'input_fingerprint',
  'operation_key',
  'reason',
  'receipt',
  'result_digest',
  'revision',
];

describe.runIf(Boolean(ownerUrl && appUrl))('contact enrichment safety schema on PostgreSQL', { timeout: 60_000 }, () => {
  let owner: PrismaClient;
  let app: PrismaClient;

  beforeAll(async () => {
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    app = new PrismaClient({ datasourceUrl: appUrl });
    const [identity] = await app.$queryRaw<{ current: string; superuser: string; bypassrls: boolean }[]>`
      SELECT current_user::text AS current, current_setting('is_superuser') AS superuser,
        (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls`;
    if (identity?.current !== 'app_user' || identity.superuser !== 'off' || identity.bypassrls !== false) {
      throw new Error('contact enrichment migration test must connect the app side as app_user without RLS bypass');
    }
  });

  afterAll(async () => {
    await Promise.all([owner?.$disconnect(), app?.$disconnect()]);
  });

  it('both tables exist with FORCE RLS and one workspace policy', async () => {
    const rows = await owner.$queryRaw<
      Array<{ relname: string; rls: boolean; force: boolean; policies: number }>
    >`
      SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
        (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN (${HEAD}, ${STEP})
      ORDER BY c.relname`;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.rls).toBe(true);
      expect(row.force).toBe(true);
      expect(row.policies).toBe(1);
    }
  });

  it('policy predicates bind current_workspace_id on both read and write', async () => {
    const rows = await owner.$queryRaw<
      Array<{ relname: string; using: string; check: string }>
    >`
      SELECT c.relname,
        pg_get_expr(p.polqual, p.polrelid) AS "using",
        pg_get_expr(p.polwithcheck, p.polrelid) AS "check"
      FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
      WHERE c.relname IN (${HEAD}, ${STEP})`;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.using).toContain('workspace_id');
      expect(row.using).toContain('current_workspace_id()');
      expect(row.check).toContain('workspace_id');
      expect(row.check).toContain('current_workspace_id()');
    }
  });

  it('app_user holds SELECT/INSERT only and exactly the narrow UPDATE column sets', async () => {
    for (const table of [HEAD, STEP]) {
      const grants = await owner.$queryRaw<Array<{ privilege: string }>>`
        SELECT privilege_type AS privilege
        FROM information_schema.role_table_grants
        WHERE grantee = 'app_user' AND table_schema = 'public' AND table_name = ${table}
        ORDER BY privilege_type`;
      expect(grants.map((row) => row.privilege)).toEqual(['INSERT', 'SELECT']);
      for (const privilege of ['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'UPDATE']) {
        const [row] = await owner.$queryRaw<Array<{ allowed: boolean }>>`
          SELECT has_table_privilege('app_user', ${`public.${table}`}, ${privilege}) AS allowed`;
        expect(row.allowed, `${table} ${privilege}`).toBe(false);
      }
    }
    const columns = await owner.$queryRaw<Array<{ table: string; column: string }>>`
      SELECT c.relname AS table, a.attname AS column
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relname IN (${HEAD}, ${STEP})
        AND has_column_privilege('app_user', c.oid, a.attnum, 'UPDATE')
      ORDER BY c.relname, a.attname`;
    expect(columns.filter((row) => row.table === HEAD).map((row) => row.column)).toEqual(HEAD_UPDATE_COLUMNS);
    expect(columns.filter((row) => row.table === STEP).map((row) => row.column)).toEqual(STEP_UPDATE_COLUMNS);
  });

  it('nullable identity and in-flight fences are partial/expression unique indexes', async () => {
    const rows = await owner.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename IN (${HEAD}, ${STEP})`;
    const defs = new Map(rows.map((row) => [row.indexname, row.indexdef]));
    const http = defs.get('contact_enrichment_execution_http_identity_key');
    expect(http).toContain('UNIQUE INDEX');
    expect(http).toContain("WHERE ((entrypoint)::text = 'http'::text)");
    const run = defs.get('contact_enrichment_execution_run_identity_key');
    expect(run).toContain('business_run_id');
    expect(run).toContain("WHERE ((entrypoint)::text = 'discovery_run'::text)");
    const fence = defs.get('contact_enrichment_execution_step_inflight_fence_key');
    expect(fence).toContain('UNIQUE INDEX');
    expect(fence).toContain("COALESCE(input_fingerprint, ''::bpchar)");
    for (const phase of ['ADMITTED', 'RESERVED', 'RESULT_UNKNOWN', 'SETTLED_WAITING_APPLY']) {
      expect(fence).toContain(phase);
    }
    expect(fence).toContain('contact_id IS NOT NULL');
    const operation = defs.get('contact_enrichment_execution_step_budget_operation_key');
    expect(operation).toContain('budget_operation_id IS NOT NULL');
    expect(defs.has('contact_enrichment_execution_step_execution_slot_ordinal_key')).toBe(true);
    expect(defs.has('contact_enrichment_execution_step_execution_slot_key_key')).toBe(true);
  });

  it('scoped foreign keys pin SET NULL to the personal column and cascade execution deletion', async () => {
    const rows = await owner.$queryRaw<
      Array<{ conname: string; confdeltype: string; setcols: string[]; target: string; columns: string[] }>
    >`
      SELECT con.conname,
        con.confdeltype::text AS confdeltype,
        COALESCE((SELECT array_agg(a.attname ORDER BY a.attname)
          FROM unnest(con.confdelsetcols) AS setcol(num)
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = setcol.num), '{}') AS setcols,
        con.confrelid::regclass::text AS target,
        (SELECT array_agg(a.attname ORDER BY a.attname)
          FROM unnest(con.conkey) AS col(num)
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = col.num) AS columns
      FROM pg_constraint con
      WHERE con.conname IN (
        'contact_enrichment_execution_company_scope_fkey',
        'contact_enrichment_execution_step_contact_scope_fkey',
        'contact_enrichment_execution_step_execution_fkey',
        'contact_enrichment_execution_authority_scope_fkey',
        'contact_enrichment_execution_account_scope_fkey',
        'contact_enrichment_execution_step_operation_scope_fkey'
      )`;
    const byName = new Map(rows.map((row) => [row.conname, row]));
    const company = byName.get('contact_enrichment_execution_company_scope_fkey');
    expect(company).toMatchObject({ confdeltype: 'n', setcols: ['company_id'], target: 'canonical_company' });
    expect(company?.columns).toEqual(['company_id', 'workspace_id']);
    const contact = byName.get('contact_enrichment_execution_step_contact_scope_fkey');
    expect(contact).toMatchObject({ confdeltype: 'n', setcols: ['contact_id'], target: 'canonical_contact' });
    expect(contact?.columns).toEqual(['contact_id', 'workspace_id']);
    const execution = byName.get('contact_enrichment_execution_step_execution_fkey');
    expect(execution).toMatchObject({ confdeltype: 'c', target: 'contact_enrichment_execution' });
    expect(execution?.columns).toEqual(['execution_id', 'workspace_id']);
    expect(byName.get('contact_enrichment_execution_authority_scope_fkey')?.confdeltype).toBe('a');
    expect(byName.get('contact_enrichment_execution_account_scope_fkey')?.confdeltype).toBe('a');
    expect(byName.get('contact_enrichment_execution_step_operation_scope_fkey')?.confdeltype).toBe('a');
  });

  it('expected-facts validator admits only the allowlisted schemas with all six facts NULL', async () => {
    const [row] = await owner.$queryRaw<
      Array<{
        hunter_null_ok: boolean;
        hunter_fact_rejected: boolean;
        prospeo_null_ok: boolean;
        prospeo_fact_rejected: boolean;
        unknown_rejected: boolean;
        http_get_ok: boolean;
        http_get_bad: boolean;
      }>
    >`
      SELECT
        generic_operation_artifact_expected_facts_valid_v1(
          'contact-email-find-hunter/v1'::text,
          NULL::smallint, NULL::boolean, NULL::text, NULL::text, NULL::text, NULL::boolean) AS hunter_null_ok,
        NOT generic_operation_artifact_expected_facts_valid_v1(
          'contact-email-find-hunter/v1'::text,
          200::smallint, true::boolean, NULL::text, NULL::text, NULL::text, NULL::boolean) AS hunter_fact_rejected,
        generic_operation_artifact_expected_facts_valid_v1(
          'contact-email-find-prospeo/v1'::text,
          NULL::smallint, NULL::boolean, NULL::text, NULL::text, NULL::text, NULL::boolean) AS prospeo_null_ok,
        NOT generic_operation_artifact_expected_facts_valid_v1(
          'contact-email-find-prospeo/v1'::text,
          200::smallint, true::boolean, NULL::text, NULL::text, NULL::text, NULL::boolean) AS prospeo_fact_rejected,
        NOT generic_operation_artifact_expected_facts_valid_v1(
          'contact-email-unknown/v1'::text,
          NULL::smallint, NULL::boolean, NULL::text, NULL::text, NULL::text, NULL::boolean) AS unknown_rejected,
        generic_operation_artifact_expected_facts_valid_v1(
          'http-get/v1'::text, 200::smallint, true::boolean,
          'https://example.com/a'::text, NULL::text, NULL::text, NULL::boolean) AS http_get_ok,
        NOT generic_operation_artifact_expected_facts_valid_v1(
          'http-get/v1'::text, 200::smallint, false::boolean,
          'https://example.com/a'::text, NULL::text, NULL::text, NULL::boolean) AS http_get_bad`;
    expect(row).toEqual({
      hunter_null_ok: true,
      hunter_fact_rejected: true,
      prospeo_null_ok: true,
      prospeo_fact_rejected: true,
      unknown_rejected: true,
      http_get_ok: true,
      http_get_bad: true,
    });
  });

  it('typed verification receipts pass the generic receipt-facts gate', async () => {
    const [row] = await owner.$queryRaw<Array<{ mv: boolean; emailable: boolean; zerobounce: boolean }>>`
      SELECT
        execution_receipt_facts_valid_v1(
          'contact-email-verify-millionverifier/v1',
          '{"currency":"USD","unit":"microusd","callCount":1,"chargedMicrousd":"1000","upperBoundMicrousd":"1000"}'::jsonb,
          'provider_reported') AS mv,
        execution_receipt_facts_valid_v1(
          'contact-email-verify-emailable/v1',
          '{"currency":"USD","unit":"microusd","callCount":1,"chargedMicrousd":"7600","upperBoundMicrousd":"7600"}'::jsonb,
          'estimated_upper_bound') AS emailable,
        execution_receipt_facts_valid_v1(
          'contact-email-verify-zerobounce/v1',
          '{"currency":"USD","unit":"microusd","callCount":1,"chargedMicrousd":"9900","upperBoundMicrousd":"9900"}'::jsonb,
          'estimated_upper_bound') AS zerobounce`;
    expect(row).toEqual({ mv: true, emailable: true, zerobounce: true });
  });

  it('the privilege manifest names both new tables with the same column grants', async () => {
    const manifest = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, '../../../../../docs/governance/app-user-table-privileges.json'), 'utf8'),
    ) as { tables: Record<string, string[]>; columns: Record<string, Record<string, string[]>> };
    for (const table of [HEAD, STEP]) {
      expect(manifest.tables[table]).toEqual(['INSERT', 'SELECT']);
    }
    expect(Object.keys(manifest.columns[HEAD]).sort()).toEqual([...HEAD_UPDATE_COLUMNS].sort());
    expect(Object.keys(manifest.columns[STEP]).sort()).toEqual([...STEP_UPDATE_COLUMNS].sort());
  });
});

describe('Prospeo artifact expected-facts migration contract (20261125163000)', () => {
  const migrationPath = path.resolve(
    import.meta.dirname,
    '../../../../../packages/db/prisma/migrations/20261125163000_prospeo_artifact_expected_facts_allowlist/migration.sql',
  );

  it('adds contact-email-find-prospeo/v1 while preserving signature, search_path, invoker mode and zero grants', () => {
    const sql = readFileSync(migrationPath, 'utf8');
    expect(sql).toMatch(/^BEGIN;/mu);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '60s';");
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.generic_operation_artifact_expected_facts_valid_v1(');
    expect(sql).toContain('RETURNS BOOLEAN');
    expect(sql).toContain('LANGUAGE SQL');
    expect(sql).toContain('IMMUTABLE');
    expect(sql).not.toMatch(/SECURITY\s+DEFINER/iu);
    expect(sql).toContain('SET search_path = pg_catalog, public, pg_temp');
    expect(sql).toMatch(
      /WHEN 'contact-email-find-prospeo\/v1' THEN\s+p_expected_http_status IS NULL\s+AND p_expected_http_ok IS NULL\s+AND p_expected_sanitized_url IS NULL\s+AND p_expected_content_hash IS NULL\s+AND p_expected_blocked_code IS NULL\s+AND p_expected_robots_blocked IS NULL/su,
    );
    for (const schema of [
      'sanctions-download/v1',
      'contact-email-find-hunter/v1',
      'http-get/v1',
      'crawl4ai-fetch/v1',
      'crawl4ai-render/v1',
    ]) {
      expect(sql).toContain(`WHEN '${schema}' THEN`);
    }
    expect(sql).toContain('ELSE false');
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.generic_operation_artifact_expected_facts_valid_v1\(\s*TEXT,\s*SMALLINT,\s*BOOLEAN,\s*TEXT,\s*TEXT,\s*TEXT,\s*BOOLEAN\s*\)\s+FROM PUBLIC, app_user, execution_budget_platform_writer;/su,
    );
    expect(sql.trimEnd()).toMatch(/COMMIT;$/u);
  });
});
