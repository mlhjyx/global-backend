import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DOMAIN_RESOLUTION_ROUTES,
  DOMAIN_RESOLUTION_STATUSES,
} from './domain/domain-resolution-store';
import { DOMAIN_REVIEW_TASK_REASONS, DOMAIN_REVIEW_TASK_STATUSES } from './domain/domain-review-store';

/**
 * ch03 §3.9.4 执行面批次 3a 两表的静态契约（零容器）。行为面（app_user + set_config 下的
 * FORCE RLS 正/负向、业务唯一键、CHECK）由 domain-stores.postgres.spec.ts 在真库验证。
 */
const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/prisma/migrations/', import.meta.url));
const MIGRATION = '20261109185000_company_domain_resolution';
const PRIVILEGES = fileURLToPath(
  new URL('../../../../docs/governance/app-user-table-privileges.json', import.meta.url),
);
const SCHEMA = fileURLToPath(new URL('../../../../packages/db/prisma/schema.prisma', import.meta.url));

/** Top-level statements with comments dropped and whitespace folded. */
function topLevelStatements(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/--.*$/u, ''))
    .join('\n')
    .split(';')
    .map((statement) => statement.replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
}

describe('company_domain_resolution / domain_review_task migration (ch03 执行面 3a)', () => {
  const sql = readFileSync(`${MIGRATIONS}${MIGRATION}/migration.sql`, 'utf8');
  const statements = topLevelStatements(sql);
  /** Every statement with comments dropped and whitespace folded, for multi-line fragments. */
  const foldedSql = statements.join(' ');

  it('sorts after every earlier migration and runs additively in one bounded transaction', () => {
    const names = readdirSync(MIGRATIONS).filter((name) => /^\d{14}_/u.test(name)).sort();
    expect(names).toContain(MIGRATION);
    expect(names.indexOf(MIGRATION)).toBeGreaterThan(names.indexOf('20261109160000_measurement_core_v1'));
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements).toContain("SET LOCAL lock_timeout = '5s'");
    expect(statements).toContain("SET LOCAL statement_timeout = '30s'");
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE FROM|UPDATE "|INSERT INTO)\b/u);
  });

  it('closes both vocabularies to the code-level unions', () => {
    const statusList = DOMAIN_RESOLUTION_STATUSES.map((value) => `'${value}'`).join(', ');
    const routeList = DOMAIN_RESOLUTION_ROUTES.map((value) => `'${value}'`).join(', ');
    const reasonList = DOMAIN_REVIEW_TASK_REASONS.map((value) => `'${value}'`).join(', ');
    const taskStatusList = DOMAIN_REVIEW_TASK_STATUSES.map((value) => `'${value}'`).join(', ');
    expect(sql).toContain(`CHECK ("status" IN (${statusList}))`);
    expect(sql).toContain(`CHECK ("route" IN (${routeList}))`);
    expect(sql).toContain(`CHECK ("reason" IN (${reasonList}))`);
    expect(sql).toContain(`CHECK ("status" IN (${taskStatusList}))`);
    expect(sql).toContain('CHECK ("route_rank" >= 0)');
    expect(sql).toContain(
      'CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 100))',
    );
    // 只有 VERIFIED 可被选中；非 OPEN 的工单必须已经裁决（decided_at 非空）。
    expect(sql).toContain('CHECK ("selected" = false OR "status" = \'VERIFIED\')');
    expect(sql).toContain('CHECK ("status" = \'OPEN\' OR "decided_at" IS NOT NULL)');
    expect(sql).toContain('CHECK ("priority" >= 0 AND "priority" <= 100)');
  });

  it('keys the resolution row by (workspace, company, candidate domain, route) and binds both tables to their parents', () => {
    // 显式短索引名：默认名超 63 字符会被 PostgreSQL 静默截断，与 Prisma 期望名不符而触发漂移。
    expect(statements).toContain(
      'CREATE UNIQUE INDEX "company_domain_resolution_candidate_key" ' +
        'ON "company_domain_resolution"("workspace_id", "company_id", "candidate_domain", "route")',
    );
    expect(statements).toContain(
      'CREATE INDEX "company_domain_resolution_workspace_id_status_idx" ON "company_domain_resolution"("workspace_id", "status")',
    );
    expect(statements).toContain(
      'CREATE INDEX "company_domain_resolution_workspace_id_company_id_status_idx" ' +
        'ON "company_domain_resolution"("workspace_id", "company_id", "status")',
    );
    // 单选中兜底：部分唯一索引（datamodel 不可表达、漂移 diff 忽略部分索引）。
    expect(statements).toContain(
      'CREATE UNIQUE INDEX "company_domain_resolution_selected_key" ' +
        'ON "company_domain_resolution"("workspace_id", "company_id") WHERE "selected"',
    );
    expect(statements).toContain(
      'CREATE INDEX "domain_review_task_workspace_id_status_priority_idx" ' +
        'ON "domain_review_task"("workspace_id", "status", "priority")',
    );
    // 复合外键让「公司删除 → 候选与工单级联删除」，并杜绝跨工作区挂靠。
    expect(foldedSql).toContain(
      'CONSTRAINT "company_domain_resolution_company_fkey" FOREIGN KEY ("workspace_id", "company_id") ' +
        'REFERENCES "canonical_company"("workspace_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT',
    );
    expect(foldedSql).toContain(
      'CONSTRAINT "domain_review_task_resolution_fkey" FOREIGN KEY ("resolution_id") ' +
        'REFERENCES "company_domain_resolution"("id") ON DELETE CASCADE ON UPDATE RESTRICT',
    );
  });

  it('isolates both tenant tables under FORCE RLS with the current_workspace_id() policy', () => {
    for (const table of ['company_domain_resolution', 'domain_review_task']) {
      expect(statements).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(statements).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    }
    expect(statements).toContain(
      'CREATE POLICY "company_domain_resolution_tenant_isolation" ON "company_domain_resolution" ' +
        'USING ("workspace_id" = current_workspace_id()) WITH CHECK ("workspace_id" = current_workspace_id())',
    );
    expect(statements).toContain(
      'CREATE POLICY "domain_review_task_tenant_isolation" ON "domain_review_task" ' +
        'USING ("workspace_id" = current_workspace_id()) WITH CHECK ("workspace_id" = current_workspace_id())',
    );
  });

  it("grants app_user exactly the manifest's privileges on both tables", () => {
    const manifest = JSON.parse(readFileSync(PRIVILEGES, 'utf8')) as { tables: Record<string, string[]> };
    for (const table of ['company_domain_resolution', 'domain_review_task']) {
      expect(manifest.tables[table]).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      expect(statements).toContain(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${table}" TO app_user`,
      );
    }
  });

  it('mirrors the migration in the Prisma datamodel, including the relation maps', () => {
    const schema = readFileSync(SCHEMA, 'utf8');
    expect(schema).toContain('model CompanyDomainResolution {');
    expect(schema).toContain('model DomainReviewTask {');
    expect(schema).toContain('@@map("company_domain_resolution")');
    expect(schema).toContain('@@map("domain_review_task")');
    expect(schema).toContain(
      '@@unique([workspaceId, companyId, candidateDomain, route], map: "company_domain_resolution_candidate_key")',
    );
    expect(schema).toContain('@@index([workspaceId, status])');
    expect(schema).toContain('@@index([workspaceId, companyId, status])');
    expect(schema).toContain('@@index([workspaceId, status, priority])');
    expect(schema).toContain('map: "company_domain_resolution_company_fkey"');
    expect(schema).toContain('map: "domain_review_task_resolution_fkey"');
    expect(schema).toContain('domainResolutions       CompanyDomainResolution[]');
  });
});
