import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * P1：contact_point 四态迁移（20261109120000）的静态契约——列/约束/回填口径/事件账
 * RLS 与授权。行为面（CHECK 真在 PostgreSQL 上生效、RLS 隔离、唯一键幂等）由
 * contact-point-four-state.postgres.spec.ts 在迁移后的真库验证（CI 的 Raw SQL 步骤）。
 */
const sql = readFileSync(
  join(
    import.meta.dirname,
    '../../../../packages/db/prisma/migrations/20261109120000_contact_point_four_state/migration.sql',
  ),
  'utf8',
);
const privileges = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '../../../../docs/governance/app-user-table-privileges.json'),
    'utf8',
  ),
) as { tables: Record<string, string[]> };

describe('contact_point 四态迁移的静态契约', () => {
  it('一个受限事务内完成，且只有加法（不删列、不删表、不改写既有列语义）', () => {
    const statements = sql
      .split('\n')
      .map((line) => line.replace(/--.*$/u, ''))
      .join('\n')
      .split(';')
      .map((statement) => statement.replace(/\s+/gu, ' ').trim())
      .filter(Boolean);
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements).toContain("SET LOCAL lock_timeout = '5s'");
    expect(statements).toContain("SET LOCAL statement_timeout = '30s'");
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE/iu);
  });

  it('四态列与全部形状约束', () => {
    for (const column of [
      'verification_state',
      'catch_all_class',
      'verification_provider',
      'confidence',
      'domain_blind_key',
      'last_seen_at',
      'next_reverify_at',
      'valid_since',
      'phone_type',
      'last_verification_event_id',
    ]) {
      expect(sql).toContain(`ADD COLUMN "${column}"`);
    }
    for (const constraint of [
      'contact_point_verification_state_check',
      'contact_point_catch_all_class_check',
      'contact_point_confidence_check',
      'contact_point_phone_type_check',
      'contact_point_valid_since_check',
      'contact_point_domain_blind_key_check',
      'contact_point_state_evidence_check',
    ]) {
      expect(sql).toContain(constraint);
    }
    expect(sql).toContain(`'VALID', 'INVALID', 'CATCH_ALL_RISKY', 'UNKNOWN'`);
    expect(sql).toContain(`("verification_state" = 'VALID') = ("valid_since" IS NOT NULL)`);
    expect(sql).toContain(`"verification_state" = 'UNKNOWN'`);
    expect(sql).toContain(
      `OR ("verification_method" IS NOT NULL AND "verification_provider" IS NOT NULL)`,
    );
  });

  it('source_type 收紧前先回填 legacy_unclassified；verification_method 增 third_party_api', () => {
    const backfillIndex = sql.indexOf(`SET "source_type" = 'legacy_unclassified' WHERE "source_type" IS NULL`);
    const notNullIndex = sql.indexOf(`ALTER COLUMN "source_type" SET NOT NULL`);
    expect(backfillIndex).toBeGreaterThan(-1);
    expect(notNullIndex).toBeGreaterThan(backfillIndex);
    expect(sql).toContain(`'legacy_unclassified')`);
    expect(sql).toContain(`'third_party_api'`);
  });

  it('四态回填口径与 legacyStatusToState 一致（RISKY 只有 catch_all 才进 CATCH_ALL_RISKY）', () => {
    expect(sql).toContain(`WHEN "status" = 'VALID' THEN 'VALID'`);
    expect(sql).toContain(`WHEN "status" = 'INVALID' THEN 'INVALID'`);
    expect(sql).toContain(`WHEN "status" = 'RISKY' AND "catch_all" = 'catch_all' THEN 'CATCH_ALL_RISKY'`);
    expect(sql).toContain('ELSE \'UNKNOWN\'');
    // valid_since 与状态同一条 UPDATE（约束已在列上生效，分离两条会撞 CHECK）。
    expect(sql).toContain(`WHEN "status" = 'VALID' THEN COALESCE("verified_at", "created_at")`);
    // 重验排期不许打成风暴：UNKNOWN 给 3 天缓冲。
    expect(sql).toContain(`WHEN 'UNKNOWN' THEN now() + interval '3 days'`);
  });

  it('验证事件账：唯一幂等键、值域 CHECK、RLS 强制与 append-only 授权', () => {
    expect(sql).toContain(`CREATE TABLE "contact_point_verification_event"`);
    expect(sql).toContain(`CONSTRAINT "cpve_unique_attempt" UNIQUE`);
    expect(sql).toContain(
      `("workspace_id", "contact_point_id", "provider_key", "request_hash")`,
    );
    expect(sql).toContain(`'valid', 'invalid', 'catch_all', 'unknown', 'blocked', 'error'`);
    expect(sql).toContain(`ON DELETE CASCADE`);
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('current_workspace_id()');
    expect(sql).toContain(`GRANT SELECT, INSERT ON TABLE "contact_point_verification_event" TO app_user`);
    expect(privileges.tables.contact_point_verification_event).toEqual(['INSERT', 'SELECT']);
  });
});
