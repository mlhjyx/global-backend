import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/prisma/migrations/', import.meta.url));
const MIGRATION = '20261109100000_channel_manifest_v1';
const PRIVILEGES = fileURLToPath(
  new URL('../../../../docs/governance/app-user-table-privileges.json', import.meta.url),
);
const SCHEMA = fileURLToPath(new URL('../../../../packages/db/prisma/schema.prisma', import.meta.url));

function topLevelStatements(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/--.*$/u, ''))
    .join('\n')
    .split(';')
    .map((statement) => statement.replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
}

describe('渠道 manifest/健康迁移（v3.0 第 6 章数据层）', () => {
  const sql = readFileSync(`${MIGRATIONS}${MIGRATION}/migration.sql`, 'utf8');
  const statements = topLevelStatements(sql);

  it('迁移存在、可重放、无破坏性语句（唯一 UPDATE 是 probe_required 新列回填）', () => {
    expect(readdirSync(MIGRATIONS)).toContain(MIGRATION);
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE FROM)\b/u);
    expect(sql).toMatch(/UPDATE "source_channel" SET "probe_required" = false WHERE "status" = 'ENABLED'/u);
    expect(sql.match(/UPDATE "/gu)).toHaveLength(1);
  });

  it('扩展列齐全且与章节一致', () => {
    for (const column of [
      'manifest',
      'manifest_sha256',
      'manifest_version',
      'connector_kind',
      'adapter_key',
      'base_url',
      'auth_ref',
      'rate_limit',
      'pagination',
      'field_mapping',
      'health_state',
      'consecutive_failures',
      'last_success_at',
      'disabled_reason',
      'quota_policy',
      'probe_required',
    ]) {
      expect(sql).toContain(`"${column}"`);
    }
    expect(sql).toContain("\"connector_kind\" IN ('manifest', 'adapter')");
    expect(sql).toContain("\"disabled_reason\" IN ('OPERATOR', 'AUTO_STREAK', 'AUTO_FAILURE_RATE', 'GOVERNANCE')");
    expect(sql).toContain('"manifest" IS NULL OR (jsonb_typeof("manifest") = \'object\'');
  });

  it('两新表：probe 与 health_event，事件词表受 CHECK 约束', () => {
    expect(sql).toContain('CREATE TABLE "source_channel_probe"');
    expect(sql).toContain('CREATE TABLE "source_channel_health_event"');
    for (const event of [
      'CIRCUIT_OPEN',
      'CIRCUIT_HALF_OPEN',
      'CIRCUIT_CLOSED',
      'WARNING_20_4D',
      'AUTO_DISABLED_30_7D',
      'MANUAL_ENABLE',
      'MANUAL_DISABLE',
      'PROBE_PASSED',
      'PROBE_FAILED',
    ]) {
      expect(sql).toContain(`'${event}'`);
    }
    // probe 与 run 分开：不计入 failure streak 的语义由代码保证，表层各自独立计数列。
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON TABLE "source_channel_probe" TO app_user');
    expect(sql).toContain('GRANT SELECT, INSERT ON TABLE "source_channel_health_event" TO app_user');
  });

  it('平台表无 RLS（与 source_channel 同层惯例），但权限清单同步登记', () => {
    expect(sql).not.toMatch(/ALTER TABLE "source_channel_probe" ENABLE ROW LEVEL SECURITY/u);
    const manifest = JSON.parse(readFileSync(PRIVILEGES, 'utf8')) as { tables: Record<string, string[]> };
    expect(manifest.tables.source_channel_probe).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(manifest.tables.source_channel_health_event).toEqual(['INSERT', 'SELECT']);
  });

  it('Prisma schema 与 SQL 同步（不制造表漂移）', () => {
    const schema = readFileSync(SCHEMA, 'utf8');
    expect(schema).toContain('model SourceChannelProbe');
    expect(schema).toContain('model SourceChannelHealthEvent');
    expect(schema).toContain('@@map("source_channel_probe")');
    expect(schema).toContain('@@map("source_channel_health_event")');
    for (const field of ['manifest', 'manifestSha256', 'connectorKind', 'probeRequired', 'consecutiveFailures']) {
      expect(schema).toContain(field);
    }
  });
});
