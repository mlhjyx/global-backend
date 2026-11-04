import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/prisma/migrations/', import.meta.url));
const MIGRATION = '20261104170000_icp_feedback';
const PRIVILEGES = fileURLToPath(
  new URL('../../../../docs/governance/app-user-table-privileges.json', import.meta.url),
);

describe('icp feedback migration (M2)', () => {
  const sql = readFileSync(`${MIGRATIONS}${MIGRATION}/migration.sql`, 'utf8');

  it('is additive and bounded', () => {
    expect(readdirSync(MIGRATIONS)).toContain(MIGRATION);
    expect(sql.trim().startsWith('--')).toBe(true);
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE FROM|UPDATE "|INSERT INTO)\b/u);
  });

  it('creates both tenant tables under RLS with the closed dimension vocabulary', () => {
    expect(sql).toContain('CREATE TABLE "icp_feedback"');
    expect(sql).toContain('CREATE TABLE "icp_query_performance"');
    expect(sql).toContain("\"dimension\" IN ('source', 'channel', 'industry', 'country')");
    for (const table of ['icp_feedback', 'icp_query_performance']) {
      expect(sql).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    }
    expect(sql).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "icp_feedback" TO app_user/u);
  });

  it('is registered in the privilege manifest', () => {
    const manifest = JSON.parse(readFileSync(PRIVILEGES, 'utf8')) as { tables: Record<string, string[]> };
    expect(manifest.tables.icp_feedback).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    expect(manifest.tables.icp_query_performance).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });
});
