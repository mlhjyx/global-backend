import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/prisma/migrations/', import.meta.url));
const MIGRATION = '20261104130000_run_shadow_diff';
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

describe('run shadow diff migration (M0 finalize/shadow)', () => {
  const sql = readFileSync(`${MIGRATIONS}${MIGRATION}/migration.sql`, 'utf8');
  const statements = topLevelStatements(sql);

  it('is additive, bounded and free of data rewrites', () => {
    expect(readdirSync(MIGRATIONS)).toContain(MIGRATION);
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE FROM|UPDATE "|INSERT INTO)\b/u);
  });

  it('stores aggregate counts only, under tenant RLS; the follow-up migration adds UPDATE', () => {
    expect(sql).toContain('CREATE TABLE "run_shadow_diff"');
    for (const column of [
      '"legacy_judged"',
      '"legacy_positive"',
      '"shadow_judged"',
      '"shadow_positive"',
      '"agreement"',
      '"compared"',
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql).toContain('ALTER TABLE "run_shadow_diff" FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('USING ("workspace_id" = current_workspace_id())');
    // This migration's own grant is history and stays as written; recordRunShadowDiff's
    // upsert needs UPDATE, added by 20261104190000_run_shadow_diff_app_user_grants.
    expect(sql).toMatch(/GRANT SELECT, INSERT ON TABLE "run_shadow_diff" TO app_user/u);
    expect(sql).not.toMatch(/GRANT [^;]*(?:UPDATE|DELETE)[^;]* ON TABLE "run_shadow_diff"/u);
  });

  it('is registered in the app_user privilege manifest with the upsert UPDATE grant', () => {
    const manifest = JSON.parse(readFileSync(PRIVILEGES, 'utf8')) as {
      tables: Record<string, string[]>;
    };
    expect(manifest.tables.run_shadow_diff).toEqual(['INSERT', 'SELECT', 'UPDATE']);
  });
});
