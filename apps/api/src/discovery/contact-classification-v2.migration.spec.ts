import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A4：联系方式分类 v2 迁移的静态契约——值域 CHECK、数据分级纪律（公司层 email=amber 且
 * 不得 personal）、RLS/授权与 app_user 权限清单登记。改错即红。
 */
const sql = readFileSync(
  join(
    import.meta.dirname,
    '../../../../packages/db/prisma/migrations/20261108160000_contact_classification_v2/migration.sql',
  ),
  'utf8',
);
const privileges = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '../../../../docs/governance/app-user-table-privileges.json'),
    'utf8',
  ),
) as { tables: Record<string, string[]> };

describe('A4 联系方式分类 v2 迁移的静态契约', () => {
  it('contact_point 增九列且都有值域/形状 CHECK', () => {
    for (const column of [
      'email_type',
      'source_type',
      'source_url',
      'robots_status',
      'tos_status',
      'legal_basis',
      'verification_method',
      'catch_all',
      'consent_record',
    ]) {
      expect(sql).toContain(`ADD COLUMN "${column}"`);
    }
    // 九列每列都有值域/形状 CHECK——逐个点名，任何一个被删都会红。
    for (const constraint of [
      'contact_point_email_type_check',
      'contact_point_source_type_check',
      'contact_point_source_url_check',
      'contact_point_robots_status_check',
      'contact_point_tos_status_check',
      'contact_point_legal_basis_check',
      'contact_point_verification_method_check',
      'contact_point_catch_all_check',
      'contact_point_consent_record_check',
    ]) {
      expect(sql).toContain(constraint);
    }
    // personal 与 legal_basis 的纪律在应用层（allowPersonalWithoutBasis 是已批准逃生门，DB 不强制）。
    expect(sql).toContain('allowPersonalWithoutBasis');
  });

  it('公司层：email=amber 且不得 personal；phone/form_url=green', () => {
    expect(sql).toContain('company_contact_channel_class_check');
    expect(sql).toContain(`"channel" = 'email' AND "data_class" = 'amber'`);
    expect(sql).toContain(`"email_type" IN ('role', 'generic_sales', 'procurement', 'management', 'finance', 'support', 'other')`);
    expect(sql).toContain(`"channel" IN ('phone', 'form_url') AND "data_class" = 'green'`);
  });

  it('RLS 强制、租户策略与最小授权；权限清单同步登记', () => {
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('current_workspace_id()');
    expect(sql).toContain('REVOKE ALL ON TABLE "company_contact_channel" FROM PUBLIC');
    expect(privileges.tables.company_contact_channel).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });

  it('公司层唯一键与级联外键', () => {
    expect(sql).toContain('company_contact_channel_identity_key');
    expect(sql).toContain('ON DELETE CASCADE');
    // 复合外键必须引用 canonical_company(workspace_id, id)——租户内级联，不跨租户误删。
    expect(sql).toContain('REFERENCES "canonical_company"("workspace_id", "id")');
  });

  it('VALID 只能由人确认（updated_by 必填）与 source_url 形状 CHECK', () => {
    expect(sql).toContain('company_contact_channel_status_marker_check');
    expect(sql).toContain(`"status" <> 'VALID' OR "updated_by" IS NOT NULL`);
    // 与 contact_point_source_url_check 同源：https + 无空白。
    expect(sql).toContain(`"source_url" !~ '[[:space:]]'`);
  });
});
