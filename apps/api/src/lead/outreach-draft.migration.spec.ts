import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Static contract of the L5 migration (zero containers): the append-only
 * lead_outreach_draft table. Its behaviour on PostgreSQL as app_user under RLS is
 * exercised by app-user-table-privileges.postgres.spec.ts in CI.
 */
const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/prisma/migrations/', import.meta.url));
const MIGRATION = '20261028180000_lead_outreach_draft';
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

describe('lead outreach draft migration (L5)', () => {
  const sql = readFileSync(`${MIGRATIONS}${MIGRATION}/migration.sql`, 'utf8');
  const statements = topLevelStatements(sql);
  const table = statements.find((statement) => statement.startsWith('CREATE TABLE')) ?? '';

  it('runs additively in one bounded transaction after the migrations it was written against', () => {
    const names = readdirSync(MIGRATIONS).filter((name) => /^\d{14}_/u.test(name)).sort();
    expect(names).toContain(MIGRATION);
    expect(names.indexOf(MIGRATION)).toBeGreaterThan(names.indexOf('20261027120000_lead_delivery_loop'));
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements).toContain("SET LOCAL lock_timeout = '5s'");
    expect(statements).toContain("SET LOCAL statement_timeout = '30s'");
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE FROM|UPDATE "|INSERT INTO)\b/u);
  });

  it('creates the append-only lead_outreach_draft table with only the design columns', () => {
    expect(table).toContain('CREATE TABLE "lead_outreach_draft"');
    const columns = [...table.matchAll(/"([a-z_]+)" (?:UUID|TEXT|VARCHAR\(16\)|VARCHAR\(200\)|VARCHAR\(120\)|INTEGER|JSONB|TIMESTAMP\(3\))/gu)].map(
      (match) => match[1],
    );
    expect(columns).toEqual([
      'id',
      'workspace_id',
      'lead_id',
      'version',
      'language',
      'subject',
      'body',
      'body_zh',
      'used_facts',
      'model',
      'created_at',
    ]);
    expect(table).toContain('CONSTRAINT "lead_outreach_draft_version_check" CHECK ("version" BETWEEN 1 AND 1000000)');
    expect(table).toContain(`CONSTRAINT "lead_outreach_draft_language_check" CHECK ("language" ~ '^[a-z]{2,3}$')`);
    expect(table).toContain('CONSTRAINT "lead_outreach_draft_subject_check" CHECK (char_length("subject") BETWEEN 1 AND 200)');
    expect(table).toContain('CONSTRAINT "lead_outreach_draft_body_check" CHECK (char_length("body") BETWEEN 1 AND 4000)');
    expect(table).toContain('CONSTRAINT "lead_outreach_draft_body_zh_check" CHECK (char_length("body_zh") BETWEEN 1 AND 4000)');
    expect(table).toContain(`jsonb_typeof("used_facts") = 'array' AND jsonb_array_length("used_facts") BETWEEN 1 AND 40`);
    // The stored model identity matches the durable-projection bound (120), not a shorter one.
    expect(table).toContain('CONSTRAINT "lead_outreach_draft_model_check" CHECK (char_length("model") BETWEEN 1 AND 120)');
  });

  it('binds each draft to a lead of the same workspace, one row per version, removed with the lead, under FORCE RLS', () => {
    expect(table).toContain(
      'CONSTRAINT "lead_outreach_draft_lead_fkey" FOREIGN KEY ("workspace_id", "lead_id") ' +
        'REFERENCES "lead"("workspace_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT',
    );
    expect(statements).toContain(
      'CREATE UNIQUE INDEX "lead_outreach_draft_workspace_id_lead_id_version_key" ON "lead_outreach_draft"("workspace_id", "lead_id", "version")',
    );
    // The weekly report's newest-version-per-lead lookup filters by lead_id under RLS.
    expect(statements).toContain(
      'CREATE INDEX "lead_outreach_draft_lead_id_version_idx" ON "lead_outreach_draft"("lead_id", "version")',
    );
    expect(statements).toContain('ALTER TABLE "lead_outreach_draft" ENABLE ROW LEVEL SECURITY');
    expect(statements).toContain('ALTER TABLE "lead_outreach_draft" FORCE ROW LEVEL SECURITY');
    expect(statements).toContain(
      'CREATE POLICY "lead_outreach_draft_tenant_isolation" ON "lead_outreach_draft" ' +
        'USING ("workspace_id" = current_workspace_id()) WITH CHECK ("workspace_id" = current_workspace_id())',
    );
  });

  it('grants app_user read and append only, and lists the same in the manifest', () => {
    const manifest = JSON.parse(readFileSync(PRIVILEGES, 'utf8')) as { tables: Record<string, string[]> };
    expect(manifest.tables.lead_outreach_draft).toEqual(['INSERT', 'SELECT']);
    expect(statements).toContain('GRANT SELECT, INSERT ON TABLE "lead_outreach_draft" TO app_user');
    expect(statements.join('\n')).not.toMatch(/GRANT [^;]*(?:UPDATE|DELETE)[^;]*lead_outreach_draft/u);
  });
});
