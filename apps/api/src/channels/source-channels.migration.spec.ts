import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/prisma/migrations/', import.meta.url));
const MIGRATION = '20261104150000_source_channels';
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

describe('source channels migration (M1)', () => {
  const sql = readFileSync(`${MIGRATIONS}${MIGRATION}/migration.sql`, 'utf8');
  const statements = topLevelStatements(sql);

  it('is additive and bounded', () => {
    expect(readdirSync(MIGRATIONS)).toContain(MIGRATION);
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE FROM|UPDATE "|INSERT INTO)\b/u);
  });

  it('creates the registry, enablement, run and import tables with governance checks', () => {
    for (const table of ['source_channel', 'source_channel_enablement', 'source_channel_run', 'imported_buyer']) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }
    expect(sql).toContain("\"robots_policy\" IN ('A', 'B', 'C')");
    expect(sql).toContain("\"status\" IN ('DISABLED', 'ENABLED', 'AUTO_DISABLED')");
    expect(sql).toContain("\"status\" IN ('MATERIALIZED', 'DUPLICATE', 'SUPPRESSED')");
    expect(sql).toContain('company_channel_sighting_channel_fkey');
  });

  it('keeps tenant tables under RLS and platform tables grant-gated', () => {
    for (const table of ['source_channel_enablement', 'imported_buyer']) {
      expect(statements).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(statements).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    }
    // 平台渠道注册表不含租户数据：不启用 RLS（无租户列），写入由 API scope 闸门把关。
    expect(sql).not.toMatch(/ALTER TABLE "source_channel" ENABLE ROW LEVEL SECURITY/u);
    expect(sql).toMatch(/GRANT SELECT, INSERT, UPDATE ON TABLE "source_channel" TO app_user/u);
    expect(sql).toMatch(/GRANT SELECT, INSERT, UPDATE ON TABLE "source_channel_run" TO app_user/u);
  });

  it('is registered in the app_user privilege manifest', () => {
    const manifest = JSON.parse(readFileSync(PRIVILEGES, 'utf8')) as {
      tables: Record<string, string[]>;
    };
    expect(manifest.tables.source_channel).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(manifest.tables.source_channel_run).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(manifest.tables.source_channel_enablement).toEqual(['DELETE', 'INSERT', 'SELECT']);
    expect(manifest.tables.imported_buyer).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });
});
