import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LEGAL_ENTITY_SCHEMES,
  LEGAL_ENTITY_STATUSES,
  LEGAL_LINK_METHODS,
  LEGAL_LINK_STATUSES,
} from './entity-keys';

/**
 * 获客挖掘 vNext W2（2026-11-10）迁移 20261110120000_legal_entity_graph 的静态契约（零容器）。
 * 行为面（FORCE RLS 正/负向、唯一键、CHECK）由 CI 的 prisma-drift / rls-catalog /
 * app-user-table-privileges 三道门在真库复核。
 */
const MIGRATIONS = fileURLToPath(new URL('../../../../../packages/db/prisma/migrations/', import.meta.url));
const MIGRATION = '20261110120000_legal_entity_graph';
const PRIVILEGES = fileURLToPath(
  new URL('../../../../../docs/governance/app-user-table-privileges.json', import.meta.url),
);
const SCHEMA = fileURLToPath(new URL('../../../../../packages/db/prisma/schema.prisma', import.meta.url));

function topLevelStatements(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/--.*$/u, ''))
    .join('\n')
    .split(';')
    .map((statement) => statement.replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
}

describe('legal_entity / company_legal_link migration（vNext W2）', () => {
  const sql = readFileSync(`${MIGRATIONS}${MIGRATION}/migration.sql`, 'utf8');
  const statements = topLevelStatements(sql);
  const foldedSql = statements.join(' ');

  it('sorts after every earlier migration and runs additively in one bounded transaction', () => {
    const names = readdirSync(MIGRATIONS).filter((name) => /^\d{14}_/u.test(name)).sort();
    expect(names).toContain(MIGRATION);
    expect(names.indexOf(MIGRATION)).toBeGreaterThan(
      names.indexOf('20261110050000_discovery_query_lineage_provider_allowlist_widen'),
    );
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements).toContain("SET LOCAL lock_timeout = '5s'");
    expect(statements).toContain("SET LOCAL statement_timeout = '30s'");
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE FROM|UPDATE ")\b/u);
  });

  it('closes both vocabularies to the code-level unions', () => {
    const schemeList = LEGAL_ENTITY_SCHEMES.map((value) => `'${value}'`).join(', ');
    const entityStatusList = LEGAL_ENTITY_STATUSES.map((value) => `'${value}'`).join(', ');
    const methodList = LEGAL_LINK_METHODS.map((value) => `'${value}'`).join(', ');
    const linkStatusList = LEGAL_LINK_STATUSES.map((value) => `'${value}'`).join(', ');
    expect(sql).toContain(`CHECK ("scheme" IN (${schemeList}))`);
    expect(sql).toContain(`CHECK ("status" IN (${entityStatusList}))`);
    expect(sql).toContain(`CHECK ("match_method" IN (${methodList}))`);
    expect(sql).toContain(`CHECK ("status" IN (${linkStatusList}))`);
    expect(sql).toContain('CHECK ("confidence" >= 0 AND "confidence" <= 1)');
    expect(sql).toContain(`CHECK ("country" ~ '^[A-Z]{2}$')`);
  });

  it('keys legal entities by (workspace, scheme, country, value) and links by (workspace, company, entity)', () => {
    expect(statements).toContain(
      'CREATE INDEX "legal_entity_workspace_id_country_idx" ON "legal_entity"("workspace_id", "country")',
    );
    expect(statements).toContain(
      'CREATE INDEX "company_legal_link_workspace_id_company_id_idx" ' +
        'ON "company_legal_link"("workspace_id", "company_id")',
    );
    expect(foldedSql).toContain(
      'CONSTRAINT "legal_entity_workspace_id_scheme_country_value_key" UNIQUE ("workspace_id", "scheme", "country", "value")',
    );
    expect(foldedSql).toContain(
      'CONSTRAINT "company_legal_link_workspace_id_company_id_legal_entity_id_key" ' +
        'UNIQUE ("workspace_id", "company_id", "legal_entity_id")',
    );
    // 公司删除 → 链接级联删除；实体侧用复合外键杜绝跨租户挂靠。
    expect(foldedSql).toContain(
      'CONSTRAINT "company_legal_link_company_fkey" FOREIGN KEY ("company_id") ' +
        'REFERENCES "canonical_company"("id") ON DELETE CASCADE ON UPDATE CASCADE',
    );
    expect(foldedSql).toContain(
      'CONSTRAINT "company_legal_link_legal_entity_fkey" FOREIGN KEY ("workspace_id", "legal_entity_id") ' +
        'REFERENCES "legal_entity"("workspace_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT',
    );
  });

  it('isolates both tenant tables under FORCE RLS with the current_workspace_id() policy', () => {
    for (const table of ['legal_entity', 'company_legal_link']) {
      expect(statements).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(statements).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(statements).toContain(
        `CREATE POLICY "${table}_tenant_isolation" ON "${table}" ` +
          'USING ("workspace_id" = current_workspace_id()) WITH CHECK ("workspace_id" = current_workspace_id())',
      );
    }
  });

  it("grants app_user exactly the manifest's privileges on both tables", () => {
    const manifest = JSON.parse(readFileSync(PRIVILEGES, 'utf8')) as { tables: Record<string, string[]> };
    for (const table of ['legal_entity', 'company_legal_link']) {
      expect(manifest.tables[table]).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      expect(statements).toContain(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${table}" TO app_user`,
      );
    }
  });

  it('mirrors the migration in the Prisma datamodel, including relation maps', () => {
    const schema = readFileSync(SCHEMA, 'utf8');
    expect(schema).toContain('model LegalEntity {');
    expect(schema).toContain('model CompanyLegalLink {');
    expect(schema).toContain('@@map("legal_entity")');
    expect(schema).toContain('@@map("company_legal_link")');
    expect(schema).toContain('@@unique([workspaceId, scheme, country, value])');
    expect(schema).toContain('@@unique([workspaceId, id], map: "legal_entity_workspace_id_id_key")');
    expect(schema).toContain('@@index([workspaceId, country])');
    expect(schema).toContain('@@unique([workspaceId, companyId, legalEntityId])');
    expect(schema).toContain('map: "company_legal_link_company_fkey"');
    expect(schema).toContain('map: "company_legal_link_legal_entity_fkey"');
    expect(schema).toContain('legalLinks              CompanyLegalLink[]');
  });
});
