import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Static contract of the L1 delivery-loop migration (zero containers): the nullable
 * source_url on field_evidence that keeps the page a fact came from. Behaviour on a real
 * database is exercised by the weekly-report postgres spec's evidence reads in CI.
 */
const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/prisma/migrations/', import.meta.url));
const MIGRATION = '20261028120000_field_evidence_source_url';
const PRISMA_SCHEMA = fileURLToPath(new URL('../../../../packages/db/prisma/schema.prisma', import.meta.url));
const PRIVILEGES = fileURLToPath(
  new URL('../../../../docs/governance/app-user-table-privileges.json', import.meta.url),
);

function topLevelStatements(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/--.*$/u, ''))
    .join('\n')
    .split(';')
    .map((statement) => statement.replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
}

describe('field_evidence.source_url migration (L1)', () => {
  const sql = readFileSync(`${MIGRATIONS}${MIGRATION}/migration.sql`, 'utf8');
  const statements = topLevelStatements(sql);

  it('runs additively in one bounded transaction after the delivery-loop migration', () => {
    const names = readdirSync(MIGRATIONS).filter((name) => /^\d{14}_/u.test(name)).sort();
    expect(names).toContain(MIGRATION);
    expect(names.indexOf(MIGRATION)).toBeGreaterThan(names.indexOf('20261027120000_lead_delivery_loop'));
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements).toContain("SET LOCAL lock_timeout = '5s'");
    expect(statements).toContain("SET LOCAL statement_timeout = '30s'");
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE FROM|UPDATE "|INSERT INTO)\b/u);
  });

  it('adds a nullable https-only source url the model maps and the manifest keeps at table grants', () => {
    expect(statements).toContain('ALTER TABLE "field_evidence" ADD COLUMN "source_url" TEXT');
    const check = statements.find((statement) => statement.startsWith('ALTER TABLE "field_evidence" ADD CONSTRAINT'));
    expect(check).toContain('"field_evidence_source_url_check"');
    expect(check).toContain(`CHECK ("source_url" IS NULL OR ("source_url" LIKE 'https://%' AND char_length("source_url") <= 2048))`);
    const schema = readFileSync(PRISMA_SCHEMA, 'utf8');
    const fieldEvidence = /model FieldEvidence \{[\s\S]*?\n\}/u.exec(schema)?.[0] ?? '';
    expect(fieldEvidence).toMatch(/sourceUrl\s+String\?\s+@map\("source_url"\)/u);
    // No new object, so the app_user manifest keeps field_evidence at its table-level grants.
    const manifest = JSON.parse(readFileSync(PRIVILEGES, 'utf8')) as { tables: Record<string, string[]> };
    expect(manifest.tables.field_evidence).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });
});
