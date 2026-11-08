import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/prisma/migrations/', import.meta.url));
const MIGRATION = '20261109150000_channel_record_review';
const SCHEMA = fileURLToPath(new URL('../../../../packages/db/prisma/schema.prisma', import.meta.url));
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

describe('CH-7：渠道记录观察名单迁移', () => {
  const sql = readFileSync(`${MIGRATIONS}${MIGRATION}/migration.sql`, 'utf8');
  const statements = topLevelStatements(sql);

  it('存在、可重放、纯增量（不 UPDATE 存量、不删数据）', () => {
    expect(readdirSync(MIGRATIONS)).toContain(MIGRATION);
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(sql).not.toMatch(/\b(?:DROP TABLE|TRUNCATE|DELETE FROM|UPDATE ")\b/u);
    // 存量 48 行保持默认 PENDING（从未人工抽检，不伪造 APPROVED）。
    expect(sql).toContain("\"review_status\" VARCHAR(16) NOT NULL DEFAULT 'PENDING'");
  });

  it('审计足迹与三态约束、索引齐全', () => {
    for (const column of ['review_status', 'reviewed_by', 'reviewed_at', 'materialized_company_id']) {
      expect(sql).toContain(`"${column}"`);
    }
    expect(sql).toContain("\"review_status\" IN ('PENDING', 'APPROVED', 'REJECTED')");
    expect(sql).toContain('source_channel_record_review_audit_check');
    expect(sql).toContain('CREATE INDEX "source_channel_record_channel_id_review_status_idx"');
    expect(sql).toContain('ON "source_channel_record" ("channel_id", "review_status")');
  });

  it('Prisma schema 同步；app_user 权限不变（INSERT/SELECT/UPDATE 已有）', () => {
    const schema = readFileSync(SCHEMA, 'utf8');
    for (const field of ['reviewStatus', 'reviewedBy', 'reviewedAt', 'materializedCompanyId']) {
      expect(schema).toContain(field);
    }
    expect(schema).toContain('@@index([channelId, reviewStatus])');
    const manifest = JSON.parse(readFileSync(PRIVILEGES, 'utf8')) as { tables: Record<string, string[]> };
    expect(manifest.tables.source_channel_record).toEqual(['INSERT', 'SELECT', 'UPDATE']);
  });
});
