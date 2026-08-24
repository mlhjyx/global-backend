import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const migration = await readFile(new URL(
  '../prisma/migrations/20260824130000_personal_artifact_cleanup/migration.sql',
  import.meta.url,
), 'utf8');
const schema = await readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
const repository = await readFile(new URL(
  '../../../apps/api/src/durable-results/artifact/personal-artifact-cleanup.repository.ts',
  import.meta.url,
), 'utf8');

describe('personal artifact cleanup forward migration', () => {
  it('keeps exact version identity internal and makes cleanup commands tenant-scoped', () => {
    assert.match(migration, /object_version_id/);
    assert.match(migration, /personal_artifact_cleanup_command/);
    assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
    assert.match(migration, /FORCE ROW LEVEL SECURITY/);
    assert.match(migration, /enqueue_workspace_personal_artifact_cleanup_v1/);
    assert.match(migration, /claim_workspace_personal_artifact_cleanup_v1/);
    assert.match(schema, /objectVersionId\s+String\?/);
    assert.match(schema, /model PersonalArtifactCleanupCommand/);
  });

  it('requires committed tombstone audit and rejects shared live references before command creation', () => {
    assert.match(migration, /generic_operation_artifact_subject_tombstone_audit/);
    assert.match(migration, /NOT EXISTS[\s\S]*generic_operation_artifact_subject_tombstone/);
    assert.match(migration, /generic-operation-artifact-object:/);
    assert.match(migration, /generic_operation_artifact_subject_cleanup_fence/);
    assert.match(repository, /SHARED_OBJECT_STILL_REFERENCED/);
    assert.match(repository, /EXACT_OBJECT_VERSION_UNAVAILABLE/);
    assert.doesNotMatch(migration, /object_body|email|full_name/i);
  });

  it('does not add VersionId to the public manifest contract', () => {
    const manifestModel = schema.slice(
      schema.indexOf('model GenericOperationArtifact {'),
      schema.indexOf('model GenericOperationArtifactSubject {'),
    );
    assert.doesNotMatch(manifestModel, /objectVersionId/);
  });
});
