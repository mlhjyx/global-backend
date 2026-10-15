import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION =
  '../../packages/db/prisma/migrations/20261014050000_generic_operation_artifact_object_version_ledger/migration.sql';
const sql = readFileSync(resolve(process.cwd(), MIGRATION), 'utf8');
const schema = readFileSync(
  resolve(process.cwd(), '../../packages/db/prisma/schema.prisma'),
  'utf8',
);
const budgetStore = readFileSync(
  resolve(process.cwd(), 'src/tools/budget-store.ts'),
  'utf8',
);
const privileges = JSON.parse(
  readFileSync(
    resolve(process.cwd(), '../../docs/governance/app-user-table-privileges.json'),
    'utf8',
  ),
) as { tables: Record<string, string[]> };

/*
 * A content object may now carry more than one S3 version (retention refresh on
 * reuse, re-write after a lifecycle deletion). The pin on
 * generic_operation_artifact_object follows the latest verified settlement, the
 * ledger keeps every version, and erasure addresses each of them exactly.
 */
describe('generic operation artifact object version ledger migration', () => {
  it('records every settled version instead of refusing a changed one', () => {
    expect(sql).toContain('CREATE TABLE "generic_operation_artifact_object_version"');
    expect(sql).toContain(
      'PRIMARY KEY ("sha256", "privacy_class", "object_version_id")',
    );
    expect(sql).toContain(
      'REFERENCES "generic_operation_artifact_object" ("sha256", "privacy_class")',
    );
    expect(sql).toContain(
      'CREATE FUNCTION record_generic_operation_artifact_object_version_v1(',
    );
    expect(sql).toContain(
      'CREATE FUNCTION settle_tool_budget_artifact_manifest_with_receipt_v4(',
    );
    const v4 = sql.slice(
      sql.indexOf('CREATE FUNCTION settle_tool_budget_artifact_manifest_with_receipt_v4('),
      sql.indexOf('CREATE OR REPLACE FUNCTION enqueue_workspace_personal_artifact_cleanup_v1('),
    );
    expect(v4).toContain('settle_tool_budget_artifact_manifest_with_receipt_v2(');
    expect(v4).toContain('PERFORM record_generic_operation_artifact_object_version_v1(');
    // v3's refusal of a different version is exactly what v4 drops.
    expect(v4).not.toContain('target."object_version_id" = p_object_version_id');
    const record = sql.slice(
      sql.indexOf('CREATE FUNCTION record_generic_operation_artifact_object_version_v1('),
      sql.indexOf('CREATE FUNCTION settle_tool_budget_artifact_manifest_with_receipt_v4('),
    );
    expect(record).toContain('SET "object_version_id" = p_object_version_id');
    expect(record).toContain('INSERT INTO "generic_operation_artifact_object_version"');
    expect(record).toContain('DO NOTHING');
  });

  it('backfills the ledger from the versions already pinned without rewriting a row', () => {
    expect(sql).toMatch(
      /INSERT INTO "generic_operation_artifact_object_version"[\s\S]*FROM "generic_operation_artifact_object" object\s+WHERE object\."object_version_id" IS NOT NULL/,
    );
    expect(sql).not.toMatch(/UPDATE "generic_operation_artifact"\s/);
    expect(sql).not.toMatch(/DELETE FROM/);
  });

  it('enqueues one exact-version cleanup command per version the ledger or the pin knows', () => {
    const enqueue = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION enqueue_workspace_personal_artifact_cleanup_v1('),
      sql.indexOf('REVOKE ALL ON FUNCTION\n  record_generic_operation_artifact_object_version_v1'),
    );
    expect(enqueue).toContain('FROM "generic_operation_artifact_object_version" ledger');
    expect(enqueue).toContain('UNION');
    expect(enqueue).toContain('ON CONFLICT ON CONSTRAINT\n      "personal_artifact_cleanup_command_request_object_key" DO NOTHING');
    // The fences that gate command creation are untouched.
    expect(enqueue).toContain("PERSONAL_ARTIFACT_CLEANUP_DENIED");
    expect(enqueue).toContain("PERSONAL_ARTIFACT_CLEANUP_TOMBSTONE_REQUIRED");
    expect(enqueue).toContain("'generic-operation-artifact-object:' || digest_row.\"sha256\"");
    expect(enqueue.match(/generic_operation_artifact_subject_tombstone" shared_tombstone/g)).toHaveLength(2);
  });

  it('keeps the ledger and the writer off app_user while settlement v4 stays callable', () => {
    expect(sql).toContain(
      'REVOKE ALL ON TABLE "generic_operation_artifact_object_version"\n  FROM PUBLIC, app_user, execution_budget_platform_writer;',
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION\s+settle_tool_budget_artifact_manifest_with_receipt_v4\([^)]*\)\s+TO app_user, execution_budget_platform_writer;/,
    );
    expect(sql).not.toMatch(
      /GRANT EXECUTE ON FUNCTION[^;]*record_generic_operation_artifact_object_version_v1/,
    );
    expect(privileges.tables['generic_operation_artifact_object_version']).toEqual([]);
  });

  it('is what the budget store settles artifacts through, and what Prisma models', () => {
    expect(budgetStore).toContain('settle_tool_budget_artifact_manifest_with_receipt_v4(');
    expect(budgetStore).not.toContain('settle_tool_budget_artifact_manifest_with_receipt_v3(');
    expect(schema).toContain('model GenericOperationArtifactObjectVersion {');
    expect(schema).toContain('@@map("generic_operation_artifact_object_version")');
  });
});
