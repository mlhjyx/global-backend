import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(
    process.cwd(),
    '../../packages/db/prisma/migrations/20260901060000_generic_operation_artifact_privacy_prefix/migration.sql',
  ),
  'utf8',
);

describe('generic operation artifact privacy-prefix migration', () => {
  it('fails closed instead of pretending PostgreSQL moved existing S3 versions', () => {
    expect(sql).toContain(
      'GENERIC_OPERATION_ARTIFACT_LAYOUT_MIGRATION_REQUIRED',
    );
    for (const table of [
      'generic_operation_artifact_object',
      'generic_operation_artifact',
      'personal_artifact_cleanup_command',
    ]) {
      expect(sql).toContain(`EXISTS (SELECT 1 FROM "${table}")`);
    }
  });

  it('binds both table checks and both database functions to the same privacy mapping', () => {
    for (const [privacyClass, prefix] of [
      ['PUBLIC_ORGANIZATION', 'public-organization'],
      ['CONFIDENTIAL_TENANT', 'confidential-tenant'],
      ['PERSONAL_DATA', 'personal-data'],
    ]) {
      expect(sql.match(new RegExp(`WHEN '${privacyClass}' THEN '${prefix}'`, 'g')))
        .toHaveLength(4);
    }
    expect(sql).toContain(
      'assert_generic_operation_artifact_manifest_v2(text,uuid,uuid,jsonb)',
    );
    expect(sql).toContain('append_generic_operation_artifact_internal_v1');
    expect(sql).toContain('GENERIC_OPERATION_ARTIFACT_ASSERTION_SOURCE_DRIFT');
    expect(sql).toContain('GENERIC_OPERATION_ARTIFACT_APPEND_SOURCE_DRIFT');
    expect(sql).toContain(
      'PRIMARY KEY ("sha256", "privacy_class")',
    );
    expect(sql).toContain(
      'GENERIC_OPERATION_ARTIFACT_OBJECT_IDENTITY_SOURCE_DRIFT',
    );
    expect(sql).toContain(
      'AND target."privacy_class" = artifact."privacy_class"',
    );
    expect(sql).toContain(
      'AND object."privacy_class" = NEW."privacy_class"',
    );
  });
});
