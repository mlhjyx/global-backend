import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/prisma/migrations/', import.meta.url));
const MIGRATION = '20261109140000_channel_run_dimensions';
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

describe('CH-6：source_channel_run 维度扩展迁移', () => {
  const sql = readFileSync(`${MIGRATIONS}${MIGRATION}/migration.sql`, 'utf8');
  const statements = topLevelStatements(sql);

  it('存在、可重放、无破坏性语句（唯一 UPDATE 是 mode 回填）', () => {
    expect(readdirSync(MIGRATIONS)).toContain(MIGRATION);
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(sql).not.toMatch(/\b(?:DROP TABLE|TRUNCATE|DELETE FROM)\b/u);
    expect(sql.match(/UPDATE "/gu)).toHaveLength(1);
    expect(sql).toMatch(/UPDATE "source_channel_run" SET "mode" = 'preview'/u);
  });

  it('新增两段式落账与运行维度列，约束与 schema 对齐', () => {
    for (const column of [
      'mode',
      'manifest_sha256',
      'plan_digest',
      'requests',
      'bytes_fetched',
      'http_4xx',
      'http_5xx',
      'http_429',
      'duration_ms',
      'circuit_state',
      'operator_note',
    ]) {
      expect(sql).toContain(`"${column}"`);
    }
    expect(sql).toContain("\"mode\" IN ('preview', 'run')");
    expect(sql).toContain("\"circuit_state\" IN ('closed', 'open', 'half_open')");
  });

  it('status 词表加入 PARTIAL（旧约束先删后建）', () => {
    expect(sql).toContain('ALTER TABLE "source_channel_run" DROP CONSTRAINT "source_channel_run_status_check"');
    expect(sql).toContain("\"status\" IN ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED')");
  });

  it('Prisma schema 同步（不制造表漂移），app_user 权限清单不变', () => {
    const schema = readFileSync(SCHEMA, 'utf8');
    for (const field of ['manifestSha256', 'planDigest', 'bytesFetched', 'circuitState', 'operatorNote', 'durationMs']) {
      expect(schema).toContain(field);
    }
    const manifest = JSON.parse(readFileSync(PRIVILEGES, 'utf8')) as { tables: Record<string, string[]> };
    expect(manifest.tables.source_channel_run).toEqual(['INSERT', 'SELECT', 'UPDATE']);
  });
});
