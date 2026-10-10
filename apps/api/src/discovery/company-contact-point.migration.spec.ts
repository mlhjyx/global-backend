import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMPANY_CONTACT_POINT_KINDS } from './website-profile/contact-paths';

/**
 * Static contract of the BI-14 company_contact_point migration (zero containers). Its
 * behaviour on PostgreSQL, as app_user under RLS, is checked by
 * company-contact-point.postgres.spec.ts (CI step "Raw SQL parameter types on PostgreSQL").
 */
const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/prisma/migrations/', import.meta.url));
const MIGRATION = '20261011090000_company_contact_point';
const PRIVILEGES = fileURLToPath(
  new URL('../../../../docs/governance/app-user-table-privileges.json', import.meta.url),
);

/** Top-level statements with comments dropped and whitespace folded. */
function topLevelStatements(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/--.*$/u, ''))
    .join('\n')
    .split(';')
    .map((statement) => statement.replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
}

describe('company_contact_point migration (BI-14)', () => {
  const sql = readFileSync(`${MIGRATIONS}${MIGRATION}/migration.sql`, 'utf8');
  const statements = topLevelStatements(sql);
  const table = statements.find((statement) => statement.startsWith('CREATE TABLE')) ?? '';

  it('is the newest migration and runs additively in one bounded transaction', () => {
    const names = readdirSync(MIGRATIONS).filter((name) => /^\d{14}_/u.test(name)).sort();
    expect(names.at(-1)).toBe(MIGRATION);
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements).toContain("SET LOCAL lock_timeout = '5s'");
    expect(statements).toContain("SET LOCAL statement_timeout = '30s'");
    expect(statements.map((statement) => statement.split(' ').slice(0, 2).join(' '))).toEqual([
      'BEGIN',
      'SET LOCAL',
      'SET LOCAL',
      'CREATE TABLE',
      'CREATE UNIQUE',
      'ALTER TABLE',
      'ALTER TABLE',
      'CREATE POLICY',
      'GRANT SELECT,',
      'COMMIT',
    ]);
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE FROM|UPDATE "|INSERT INTO)\b/u);
  });

  it('creates a table with no column for an email address, phone number or name', () => {
    const columns = [...table.matchAll(/"([a-z_]+)" (?:UUID|TEXT|TIMESTAMP)/gu)].map((match) => match[1]);
    expect(columns).toEqual([
      'id',
      'workspace_id',
      'company_id',
      'kind',
      'value',
      'status',
      'status_reason',
      'data_class',
      'source_kind',
      'provider_key',
      'parser_version',
      'first_seen_at',
      'last_seen_at',
      'updated_by',
    ]);
  });

  it('admits exactly the six link kinds, green data and https links without query, fragment or @', () => {
    const kinds = /CONSTRAINT "company_contact_point_kind_check" CHECK \("kind" IN \(([^)]*)\)\)/u.exec(table);
    expect(kinds?.[1]?.split(', ').map((kind) => kind.replaceAll("'", ''))).toEqual([
      ...COMPANY_CONTACT_POINT_KINDS,
    ]);
    expect(table).toContain(`CONSTRAINT "company_contact_point_data_class_check" CHECK ("data_class" = 'green')`);
    for (const fragment of [
      `"value" LIKE 'https://%'`,
      `strpos("value", '?') = 0`,
      `strpos("value", '#') = 0`,
      `strpos("value", '@') = 0`,
      `WHEN 'linkedin_company_page' THEN "value" ~ '^https://www\\.linkedin\\.com/(company|showcase)/[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$'`,
      `WHEN 'x_company_account' THEN "value" ~ '^https://x\\.com/[a-z0-9_]{1,15}$'`,
    ]) {
      expect(table, fragment).toContain(fragment);
    }
  });

  it('lets only a person make a point VALID or reject it, and keeps the automatic sources apart', () => {
    const status = /CONSTRAINT "company_contact_point_status_check" CHECK \((.*?)\), CONSTRAINT/u.exec(table)?.[1] ?? '';
    const branches = status.split(' OR ').map((branch) => branch.trim());
    expect(branches).toEqual([
      `("status" = 'UNVERIFIED' AND "status_reason" IS NULL)`,
      `("status" = 'VALID' AND "status_reason" IS NOT NULL AND "status_reason" = 'OPERATOR_CONFIRMED' AND "updated_by" IS NOT NULL)`,
      `("status" = 'INVALID' AND "status_reason" IS NOT NULL AND "status_reason" = 'OPERATOR_REJECTED' AND "updated_by" IS NOT NULL)`,
      `("status" = 'INVALID' AND "status_reason" IS NOT NULL AND "status_reason" IN ('REMOVED_FROM_SITE', 'CUSTOMER_BAD_CONTACT_PATH'))`,
    ]);
    expect(table).toContain(
      `("provider_key" = 'company_contact' AND "source_kind" IN ('homepage', 'contact_page'))`,
    );
  });

  it('binds each point to a company of the same workspace, removed with it, under FORCE RLS', () => {
    expect(table).toContain(
      'CONSTRAINT "company_contact_point_company_fkey" FOREIGN KEY ("workspace_id", "company_id") ' +
        'REFERENCES "canonical_company"("workspace_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT',
    );
    expect(statements).toContain(
      'CREATE UNIQUE INDEX "company_contact_point_workspace_id_company_id_kind_value_key" ' +
        'ON "company_contact_point"("workspace_id", "company_id", "kind", "value")',
    );
    expect(statements).toContain('ALTER TABLE "company_contact_point" ENABLE ROW LEVEL SECURITY');
    expect(statements).toContain('ALTER TABLE "company_contact_point" FORCE ROW LEVEL SECURITY');
    expect(statements).toContain(
      'CREATE POLICY "company_contact_point_tenant_isolation" ON "company_contact_point" ' +
        'USING ("workspace_id" = current_workspace_id()) WITH CHECK ("workspace_id" = current_workspace_id())',
    );
  });

  it("grants app_user exactly the manifest's privileges on the table", () => {
    const manifest = JSON.parse(readFileSync(PRIVILEGES, 'utf8')) as { tables: Record<string, string[]> };
    expect(manifest.tables.company_contact_point).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    expect(statements).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "company_contact_point" TO app_user');
  });
});
