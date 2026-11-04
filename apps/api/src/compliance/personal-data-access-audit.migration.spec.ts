import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * PR0（Q25 补偿控制）迁移的静态契约：个人数据访问审计表、租户 RLS、append-only 授权与
 * 180 天保留期清理函数。行为（app_user 走 RLS 写入/读取、清理函数按保留期删除）由
 * app-user-table-privileges.postgres.spec.ts 与真实 run 验收覆盖。
 */
const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/prisma/migrations/', import.meta.url));
const MIGRATION = '20261104100000_personal_data_access_audit';
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

describe('personal data access audit migration (Q25)', () => {
  const sql = readFileSync(`${MIGRATIONS}${MIGRATION}/migration.sql`, 'utf8');
  const statements = topLevelStatements(sql);
  const table = statements.find((statement) => statement.startsWith('CREATE TABLE')) ?? '';

  it('runs additively in one bounded transaction after the migrations it was written against', () => {
    const names = readdirSync(MIGRATIONS).filter((name) => /^\d{14}_/u.test(name)).sort();
    expect(names).toContain(MIGRATION);
    expect(names.indexOf(MIGRATION)).toBeGreaterThan(
      names.indexOf('20261028180000_lead_outreach_draft'),
    );
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements).toContain("SET LOCAL lock_timeout = '5s'");
    expect(statements).toContain("SET LOCAL statement_timeout = '30s'");
    // Deletes exist only inside the SECURITY DEFINER retention function (its body is
    // dollar-quoted); no top-level data mutation belongs in an additive migration.
    const outsideFunctions = sql.replace(/\$\$[\s\S]*?\$\$/gu, '');
    expect(outsideFunctions).not.toMatch(
      /\b(?:DROP|TRUNCATE|DELETE FROM|UPDATE "|INSERT INTO)\b/u,
    );
    expect(outsideFunctions).toMatch(/CREATE FUNCTION expire_personal_data_access_audit_v1/u);
  });

  it('creates the audit table with the who/when/company/field-class/purpose columns only', () => {
    expect(table).toContain('"personal_data_access_audit"');
    for (const column of [
      '"workspace_id"',
      '"actor_id"',
      '"actor_kind"',
      '"purpose"',
      '"company_id"',
      '"field_classes"',
      '"subject_count"',
      '"lawful_basis_ref"',
      '"correlation_id"',
      '"created_at"',
    ]) {
      expect(table).toContain(column);
    }
    // Content minimisation: no field-value column may ever exist on this table.
    expect(table).not.toMatch(/"value"|"full_name"|"email"|"phone"/u);
  });

  it('enforces tenant RLS and append-only app_user grants', () => {
    expect(statements).toContain(
      'ALTER TABLE "personal_data_access_audit" ENABLE ROW LEVEL SECURITY',
    );
    expect(statements).toContain(
      'ALTER TABLE "personal_data_access_audit" FORCE ROW LEVEL SECURITY',
    );
    const policy = statements.find((statement) =>
      statement.startsWith('CREATE POLICY'),
    );
    expect(policy).toContain(
      'USING ("workspace_id" = current_workspace_id())',
    );
    expect(policy).toContain(
      'WITH CHECK ("workspace_id" = current_workspace_id())',
    );
    expect(sql).toMatch(
      /GRANT SELECT, INSERT ON TABLE "personal_data_access_audit" TO app_user/u,
    );
    expect(sql).not.toMatch(
      /GRANT [^;]*(?:UPDATE|DELETE)[^;]* ON TABLE "personal_data_access_audit"/u,
    );
  });

  it('adds the 180-day retention function with the raw-retention security pattern', () => {
    expect(sql).toContain('CREATE FUNCTION expire_personal_data_access_audit_v1(');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain("session_user IS DISTINCT FROM 'app_user'");
    expect(sql).toContain('p_workspace_id IS DISTINCT FROM current_workspace_id()');
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION expire_personal_data_access_audit_v1(',
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION expire_personal_data_access_audit_v1\([^)]*\) FROM PUBLIC/u,
    );
  });

  it('lists SELECT and INSERT in the app_user privilege manifest', () => {
    const manifest = JSON.parse(readFileSync(PRIVILEGES, 'utf8')) as {
      tables: Record<string, string[]>;
    };
    expect(manifest.tables.personal_data_access_audit).toEqual(['INSERT', 'SELECT']);
  });
});
