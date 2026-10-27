import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OUTCOME_REASON_CODES } from './reason-codes';

/**
 * Static contract of the L2 delivery-loop migration (zero containers): the reason code on
 * lead_decision and the append-only lead_outcome table. Its behaviour on PostgreSQL as
 * app_user under RLS is exercised by app-user-table-privileges.postgres.spec.ts in CI.
 */
const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/prisma/migrations/', import.meta.url));
const MIGRATION = '20261027120000_lead_delivery_loop';
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

describe('lead delivery loop migration (L2)', () => {
  const sql = readFileSync(`${MIGRATIONS}${MIGRATION}/migration.sql`, 'utf8');
  const statements = topLevelStatements(sql);
  const table = statements.find((statement) => statement.startsWith('CREATE TABLE')) ?? '';

  it('runs additively in one bounded transaction after the migrations it was written against', () => {
    const names = readdirSync(MIGRATIONS).filter((name) => /^\d{14}_/u.test(name)).sort();
    expect(names).toContain(MIGRATION);
    expect(names.indexOf(MIGRATION)).toBeGreaterThan(names.indexOf('20261021032000_generic_operation_artifact_object_media_type_reuse'));
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements).toContain("SET LOCAL lock_timeout = '5s'");
    expect(statements).toContain("SET LOCAL statement_timeout = '30s'");
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE FROM|UPDATE "|INSERT INTO)\b/u);
  });

  it('adds a nullable reason code to lead_decision with the closed enum', () => {
    expect(statements).toContain('ALTER TABLE "lead_decision" ADD COLUMN "reason_code" VARCHAR(64)');
    const check = statements.find((statement) => statement.startsWith('ALTER TABLE "lead_decision" ADD CONSTRAINT'));
    expect(check).toContain('CHECK ("reason_code" IS NULL OR "reason_code" IN (');
    for (const code of OUTCOME_REASON_CODES) {
      expect(check).toContain(`'${code}'`);
    }
  });

  it('creates the append-only lead_outcome table with only the design columns', () => {
    const columns = [...table.matchAll(/"([a-z_]+)" (?:UUID|TEXT|VARCHAR\(64\)|INTEGER|BOOLEAN|TIMESTAMP\(3\))/gu)].map(
      (match) => match[1],
    );
    expect(columns).toEqual([
      'id',
      'workspace_id',
      'lead_id',
      'relevance',
      'willing_to_contact',
      'reason_code',
      'note',
      'contacted',
      'source',
      'created_at',
    ]);
    expect(table).toContain('CONSTRAINT "lead_outcome_relevance_check" CHECK ("relevance" IS NULL OR ("relevance" BETWEEN 1 AND 5))');
    expect(table).toContain(`CONSTRAINT "lead_outcome_source_check" CHECK ("source" IN ('customer', 'operator'))`);
    expect(table).toContain('CONSTRAINT "lead_outcome_note_check" CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 2000)');
    for (const code of OUTCOME_REASON_CODES) {
      expect(table).toContain(`'${code}'`);
    }
  });

  it('binds each outcome to a lead of the same workspace and removes it with the lead, under FORCE RLS', () => {
    expect(statements).toContain('CREATE UNIQUE INDEX "lead_workspace_id_id_key" ON "lead"("workspace_id", "id")');
    expect(table).toContain(
      'CONSTRAINT "lead_outcome_lead_fkey" FOREIGN KEY ("workspace_id", "lead_id") ' +
        'REFERENCES "lead"("workspace_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT',
    );
    expect(statements).toContain('ALTER TABLE "lead_outcome" ENABLE ROW LEVEL SECURITY');
    expect(statements).toContain('ALTER TABLE "lead_outcome" FORCE ROW LEVEL SECURITY');
    expect(statements).toContain(
      'CREATE POLICY "lead_outcome_tenant_isolation" ON "lead_outcome" ' +
        'USING ("workspace_id" = current_workspace_id()) WITH CHECK ("workspace_id" = current_workspace_id())',
    );
  });

  it('grants app_user read and append only, and lists the same in the manifest', () => {
    const manifest = JSON.parse(readFileSync(PRIVILEGES, 'utf8')) as { tables: Record<string, string[]> };
    expect(manifest.tables.lead_outcome).toEqual(['INSERT', 'SELECT']);
    expect(statements).toContain('GRANT SELECT, INSERT ON TABLE "lead_outcome" TO app_user');
    expect(statements.join('\n')).not.toMatch(/GRANT [^;]*(?:UPDATE|DELETE)[^;]*lead_outcome/u);
  });
});
