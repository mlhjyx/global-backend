import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(
    process.cwd(),
    '../../packages/db/prisma/migrations/20261021032000_generic_operation_artifact_object_media_type_reuse/migration.sql',
  ),
  'utf8',
);

const schema = readFileSync(resolve(process.cwd(), '../../packages/db/prisma/schema.prisma'), 'utf8');

/** The SQL with comments removed, so prose cannot satisfy or break a statement check. */
const statements = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('generic operation artifact object media type migration', () => {
  it('runs in one transaction with a lock timeout and locks both tables in the append function\'s order first', () => {
    const begin = statements.indexOf('BEGIN;');
    const timeout = statements.indexOf("SET LOCAL lock_timeout = '5s';");
    const lock = statements.indexOf(
      'LOCK TABLE "generic_operation_artifact", "generic_operation_artifact_object"\n  IN ACCESS EXCLUSIVE MODE;',
    );
    const firstDdl = statements.indexOf('ALTER TABLE');
    expect(begin).toBeGreaterThan(-1);
    expect(begin).toBeLessThan(timeout);
    expect(timeout).toBeLessThan(lock);
    expect(lock).toBeLessThan(firstDdl);
    expect(statements.trimEnd().endsWith('COMMIT;')).toBe(true);
  });

  it('moves the artifact-to-object key to the content columns, adding the new constraints before dropping the old', () => {
    const addKey = statements.indexOf('ADD CONSTRAINT "generic_operation_artifact_object_content_key"');
    const addForeignKey = statements.indexOf('ADD CONSTRAINT "generic_operation_artifact_object_content_fkey"');
    const dropForeignKey = statements.indexOf('DROP CONSTRAINT "generic_operation_artifact_object_metadata_fkey"');
    const dropKey = statements.indexOf('DROP CONSTRAINT "generic_operation_artifact_object_metadata_key"');
    expect(addKey).toBeGreaterThan(-1);
    expect(addKey).toBeLessThan(addForeignKey);
    expect(addForeignKey).toBeLessThan(dropForeignKey);
    expect(dropForeignKey).toBeLessThan(dropKey);
    expect(statements).toContain('UNIQUE ("sha256", "object_key", "size_bytes", "privacy_class")');
    expect(statements).toContain('FOREIGN KEY ("sha256", "object_key", "size_bytes", "privacy_class")');
    expect(statements).not.toMatch(/FOREIGN KEY \([^)]*media_type/u);
  });

  it('removes only the object media type comparison from the append function, behind a drift check', () => {
    expect(statements).toContain(
      "'append_generic_operation_artifact_internal_v1(text,uuid,uuid,uuid,uuid,text,text,text,bigint,text,text,text,timestamptz,timestamptz)'::regprocedure",
    );
    expect(statements).toContain('GENERIC_OPERATION_ARTIFACT_APPEND_OBJECT_MEDIA_TYPE_SOURCE_DRIFT');
    expect(statements).toContain('GENERIC_OPERATION_ARTIFACT_APPEND_OBJECT_MEDIA_TYPE_REWRITE_FAILED');
    const oldFragment = statements.slice(statements.indexOf('$old$') + 5, statements.lastIndexOf('$old$'));
    const newFragment = statements.slice(statements.indexOf('$new$') + 5, statements.lastIndexOf('$new$'));
    expect(oldFragment.split('\n').filter(Boolean)).toEqual([
      '    OR bound_object."size_bytes" IS DISTINCT FROM p_size_bytes',
      '    OR bound_object."media_type" IS DISTINCT FROM p_media_type',
      '    OR bound_object."privacy_class" IS DISTINCT FROM p_privacy_class',
    ]);
    expect(newFragment.split('\n').filter(Boolean)).toEqual([
      '    OR bound_object."size_bytes" IS DISTINCT FROM p_size_bytes',
      '    OR bound_object."privacy_class" IS DISTINCT FROM p_privacy_class',
    ]);
  });

  it('keeps the Prisma schema on the same content key', () => {
    expect(schema).toContain(
      '@relation(fields: [sha256, objectKey, sizeBytes, privacyClass], references: [sha256, objectKey, sizeBytes, privacyClass], onDelete: NoAction, onUpdate: NoAction, map: "generic_operation_artifact_object_content_fkey")',
    );
    expect(schema).toContain(
      '@@unique([sha256, objectKey, sizeBytes, privacyClass], map: "generic_operation_artifact_object_content_key")',
    );
    expect(schema).not.toContain('generic_operation_artifact_object_metadata_fkey');
    expect(schema).not.toContain('generic_operation_artifact_object_metadata_key');
  });
});
