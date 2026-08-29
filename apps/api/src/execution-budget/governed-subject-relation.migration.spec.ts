import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../../../packages/db/prisma/migrations/20260830120000_governed_subject_relation_schema/migration.sql',
  import.meta.url,
);
const schemaUrl = new URL(
  '../../../../packages/db/prisma/schema.prisma',
  import.meta.url,
);

const TABLES = [
  'governed_subject',
  'tool_operation_subject',
  'governed_subject_relation',
  'governed_subject_tombstone',
  'governed_subject_tombstone_audit',
] as const;

const MODELS = [
  'GovernedSubject',
  'ToolOperationSubject',
  'GovernedSubjectRelation',
  'GovernedSubjectTombstone',
  'GovernedSubjectTombstoneAudit',
] as const;

async function migration(): Promise<string> {
  return readFile(migrationUrl, 'utf8');
}

describe('governed subject relation schema migration', () => {
  it('is one additive bounded transaction and creates exactly the five product-neutral tables', async () => {
    const sql = await migration();

    expect(sql).toMatch(/^--[^]*?\nBEGIN;\n/);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s'");
    expect(sql).toContain("SET LOCAL statement_timeout = '30s'");
    expect(sql).not.toMatch(/\b(?:DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE)\b/i);

    for (const table of TABLES) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE (?:public\\.)?"?${table}"?\\s*\\(`));
    }
    expect([...sql.matchAll(/CREATE TABLE\s+(?:public\.)?"?([a-z0-9_]+)"?\s*\(/g)]
      .map((match) => match[1]))
      .toEqual([...TABLES]);
  });

  it('locks the subject, operation-root, relation identity and immutable DSR audit constraints', async () => {
    const sql = await migration();

    expect(sql).toMatch(/governed_subject_workspace_subject_key[^]*?UNIQUE\s*\(\s*"?workspace_id"?\s*,\s*"?subject_type"?\s*,\s*"?subject_id"?\s*\)/i);
    expect(sql).toMatch(/governed_subject_workspace_id_key[^]*?UNIQUE\s*\(\s*"?workspace_id"?\s*,\s*"?id"?\s*\)/i);
    expect(sql).toContain("^[a-z][a-z0-9_.]{0,190}$");
    expect(sql).toMatch(/data_class[^]*?NON_PERSONAL[^]*?PERSONAL/i);
    expect(sql).toMatch(/PERSONAL[^]*?dsr_subject_type[^]*?dsr_subject_id/i);

    expect(sql).toMatch(/tool_operation_subject_workspace_operation_key[^]*?UNIQUE\s*\(\s*"?workspace_id"?\s*,\s*"?operation_id"?\s*\)/i);
    expect(sql).toMatch(/tool_operation_subject_workspace_generation_subject_key[^]*?UNIQUE\s*\(\s*"?workspace_id"?\s*,\s*"?operation_generation"?\s*,\s*"?subject_id"?\s*\)/i);
    expect(sql).toMatch(/governed_subject_relation_workspace_operation_relation_key[^]*?UNIQUE\s*\(\s*"?workspace_id"?\s*,\s*"?operation_id"?\s*,\s*"?relation_key"?\s*\)/i);
    expect(sql).toMatch(/relation_kind[^]*?MATERIALIZED_CHILD[^]*?DERIVED_FROM/i);
    expect(sql).toMatch(/source_ref_uuid[^]*?source_ref_sha256/i);
    expect(sql).toMatch(/contract_sha256[^]*?\^\[0-9a-f\]\{64\}\$/i);

    expect(sql).toMatch(/governed_subject_tombstone_pkey[^]*?PRIMARY KEY\s*\(\s*"?workspace_id"?\s*,\s*"?governed_subject_id"?\s*\)/i);
    expect(sql).toMatch(/governed_subject_tombstone_audit_pkey[^]*?PRIMARY KEY\s*\(\s*"?deletion_request_id"?\s*\)/i);
    expect(sql).toMatch(/governed_subject_tombstone_audit_request_fkey[^]*?REFERENCES\s+(?:public\.)?"?deletion_request"?\s*\(\s*"?id"?\s*\)/i);
  });

  it('forces workspace RLS and leaves every table function-only and append-only for managed principals', async () => {
    const sql = await migration();
    const deniedPrincipals = [
      'PUBLIC',
      'app_user',
      'execution_budget_platform_writer',
      'runtime_api',
      'runtime_worker',
      'runtime_outbox_relay',
    ];

    for (const table of TABLES) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE (?:public\\.)?"?${table}"? ENABLE ROW LEVEL SECURITY`, 'i'));
      expect(sql).toMatch(new RegExp(`ALTER TABLE (?:public\\.)?"?${table}"? FORCE ROW LEVEL SECURITY`, 'i'));
      expect(sql).toMatch(new RegExp(
        `CREATE POLICY "?${table}_workspace_isolation"? ON (?:public\\.)?"?${table}"?[^]*?workspace_id[^]*?current_workspace_id\\(\\)`,
        'i',
      ));
      for (const principal of deniedPrincipals) {
        expect(sql).toMatch(new RegExp(
          `REVOKE ALL ON TABLE (?:public\\.)?"?${table}"? FROM[^;]*\\b${principal}\\b`,
          'i',
        ));
      }
      expect(sql).not.toMatch(new RegExp(
        `GRANT [^;]* ON TABLE (?:public\\.)?"?${table}"? TO (?:app_user|execution_budget_platform_writer|runtime_api|runtime_worker|runtime_outbox_relay)`,
        'i',
      ));
    }
  });

  it('does not take ownership of Program B or Program C business objects', async () => {
    const sql = (await migration()).toLowerCase();
    for (const forbidden of [
      'discovery',
      'raw_source_record',
      'identity_link',
      'canonical_company',
      'canonical_contact',
      'provider_key',
      'producer_id',
      'opportunity',
    ]) {
      expect(sql).not.toContain(forbidden);
    }
    expect(sql).not.toMatch(/\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i);
  });

  it('projects all five append-only tables into Prisma without runtime relations to business models', async () => {
    const schema = await readFile(schemaUrl, 'utf8');
    for (const model of MODELS) {
      expect(schema).toMatch(new RegExp(`model ${model} \\{`));
    }

    const governedStart = schema.indexOf('model GovernedSubject {');
    const auditEnd = schema.indexOf('\n}', schema.indexOf('model GovernedSubjectTombstoneAudit {'));
    expect(governedStart).toBeGreaterThan(-1);
    expect(auditEnd).toBeGreaterThan(governedStart);
    const projection = schema.slice(governedStart, auditEnd + 2).toLowerCase();
    for (const forbidden of [
      'rawsourcerecord',
      'identitylink',
      'canonicalcompany',
      'canonicalcontact',
      'provider',
      'opportunity',
    ]) {
      expect(projection).not.toContain(forbidden);
    }
  });
});
