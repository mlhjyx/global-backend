import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = fileURLToPath(
  new URL('../../../../packages/db/prisma/migrations/', import.meta.url),
);
const MIGRATION = '20261110080000_source_compliance_matrix';
const PRIVILEGES = fileURLToPath(
  new URL('../../../../docs/governance/app-user-table-privileges.json', import.meta.url),
);

describe('source compliance matrix migration（获客 vNext W4）', () => {
  const sql = readFileSync(`${MIGRATIONS}${MIGRATION}/migration.sql`, 'utf8');

  it('is transactional and creates the closed platform table', () => {
    expect(sql.trim().startsWith('BEGIN;')).toBe(true);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain('CREATE TABLE "source_compliance_matrix"');
    expect(sql).toContain('"id" UUID NOT NULL');
    for (const column of [
      'source_key', 'license_classification', 'robots_status', 'terms_status',
      'personal_data_class', 'retention_days', 'owner', 'approved_at', 'notes',
    ]) {
      expect(sql).toContain(`"${column}"`);
    }
    expect(sql).toContain('CREATE UNIQUE INDEX "source_compliance_matrix_source_key_key"');
    // 取值受控：三个状态列与个人数据分级都有 CHECK（与既有 source_policy/provider registry 词表一致）。
    expect(sql).toContain(`CHECK ("robots_status" IN ('ALLOWS', 'RESTRICTS', 'UNREVIEWED'))`);
    expect(sql).toContain(
      `CHECK ("terms_status" IN ('REVIEWED_OK', 'REVIEWED_RESTRICTED', 'UNREVIEWED'))`,
    );
    expect(sql).toContain(
      `CHECK ("personal_data_class" IN ('NONE', 'COMPANY_ONLY', 'RESTRICTED_POSSIBLE', 'PERSONAL_DATA'))`,
    );
    expect(sql).toContain('CHECK ("retention_days" BETWEEN 1 AND 3650)');
    // 平台治理表：app_user 只读。
    expect(sql).toContain('GRANT SELECT ON "source_compliance_matrix" TO app_user');
  });

  it('seeds the existing main sources plus opencorporates, with an honest unapproved row for it', () => {
    for (const key of [
      'openstreetmap', 'wikidata', 'ted', 'openfda', 'companies_house',
      'inpi_rne', 'gleif', 'google_patents', 'opencorporates',
    ]) {
      expect(sql).toContain(`'${key}'`);
    }
    // approved_at 留空 = 未批准：商用订阅与合规签署前不得上线（enforce 下被拒即预期行为）。
    // 取 opencorporates 行所在的多行 VALUES 片段（该行跨多行，NULL 在 approved_at 一列）。
    const lines = sql.split('\n');
    const start = lines.findIndex((line) => line.includes("'opencorporates'"));
    expect(start).toBeGreaterThan(0);
    const row = lines.slice(start, start + 6).join('\n');
    expect(row).toContain("'REVIEWED_RESTRICTED'");
    expect(row).toContain('NULL');
  });

  it('widens the governed discovery lineage allowlist with opencorporates (pure widen)', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.append_discovery_query_lineage_v1');
    expect(sql).toContain(`'opencorporates'`);
    expect(sql).toContain(`attempt_provider_key='opencorporates'`);
    expect(sql).toContain(`attempt_value->>'producerId'='opencorporates.search'`);
    expect(sql).toContain(`attempt_consumer='OpenCorporatesDiscoveryProvider'`);
    expect(sql).toContain(`attempt_result_schema='opencorporates-search/v1'`);
    // 合同哈希与命令/回执字段不变（v2 委托路径依赖这两个常量）。
    expect(sql).toContain('eb5f6f09da3e68694b43070eabf2f76340d2c84c8ff6712486495aa64d1630c0');
    expect(sql).toContain('dd2f4144f58de22f7415dfc11be56c4828c137e52d34e916852e64cfde38a2e1');
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.append_discovery_query_lineage_v1(JSONB) TO app_user");
  });

  it('is registered in the app-user privilege manifest as read-only', () => {
    const manifest = JSON.parse(readFileSync(PRIVILEGES, 'utf8')) as {
      tables: Record<string, string[]>;
    };
    expect(manifest.tables.source_compliance_matrix).toEqual(['SELECT']);
  });
});
