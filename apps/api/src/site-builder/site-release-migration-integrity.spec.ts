import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = path.resolve(import.meta.dirname, '../../../..');
const migrationsDir = path.join(repo, 'packages/db/prisma/migrations');
const migrationDirs = readdirSync(migrationsDir).filter((entry) =>
  /site_builder_r1_release$/.test(entry),
);
const migration =
  migrationDirs.length === 1 &&
  existsSync(path.join(migrationsDir, migrationDirs[0]!, 'migration.sql'))
    ? readFileSync(
        path.join(migrationsDir, migrationDirs[0]!, 'migration.sql'),
        'utf8',
      )
    : '';
const schema = readFileSync(
  path.join(repo, 'packages/db/prisma/schema.prisma'),
  'utf8',
);

describe('R1 immutable SiteRelease database invariants', () => {
  it('ships one additive migration and a distinct Release persistence model', () => {
    expect(migrationDirs).toHaveLength(1);
    expect(schema).toContain('model SiteRelease {');
    expect(schema).toContain('releases                  SiteRelease[]');
    expect(schema).toMatch(/release\s+SiteRelease\?/);
    expect(migration).toContain('CREATE TABLE "site_release"');
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/i);
  });

  it('binds one release to one scoped version and build run with a monotonic site number', () => {
    expect(schema).toContain(
      '@@unique([siteId, releaseNumber], map: "site_release_site_number_key")',
    );
    expect(schema).toMatch(/siteVersionId\s+String\s+@unique/);
    expect(schema).toMatch(/buildRunId\s+String\s+@unique/);
    expect(migration).toMatch(
      /FOREIGN KEY \("site_version_id", "workspace_id", "site_id"\)[\s\S]*REFERENCES "site_version"\("id", "workspace_id", "site_id"\)/,
    );
    expect(migration).toMatch(
      /FOREIGN KEY \("build_run_id", "workspace_id", "site_id"\)[\s\S]*REFERENCES "site_build_run"\("id", "workspace_id", "site_id"\)/,
    );
    expect(migration).toContain(
      'UNIQUE ("site_id", "release_number")',
    );
  });

  it('persists producer and GC fences without creating a parallel paid-task ledger', () => {
    expect(schema).toMatch(
      /producerToken\s+String\s+@map\("producer_token"\)\s+@db\.Uuid/,
    );
    expect(schema).toMatch(
      /leaseUntil\s+DateTime\s+@map\("lease_until"\)/,
    );
    expect(schema).toMatch(
      /gcToken\s+String\?\s+@map\("gc_token"\)\s+@db\.Uuid/,
    );
    expect(schema).toMatch(
      /gcLeaseUntil\s+DateTime\?\s+@map\("gc_lease_until"\)/,
    );
    expect(migration).not.toContain('site_release_spend');
    expect(migration).not.toContain('site_release_task_attempt');
  });

  it('requires complete digest-bound metadata before a release can become READY', () => {
    expect(migration).toMatch(
      /status[\s\S]+candidate[\s\S]+ready[\s\S]+failed[\s\S]+deleting[\s\S]+deleted/is,
    );
    expect(migration).toMatch(
      /manifest_digest[\s\S]+\^\[0-9a-f\]\{64\}\$/is,
    );
    expect(migration).toMatch(
      /status" IN \('ready', 'deleting', 'deleted'\)[\s\S]+manifest" IS NOT NULL[\s\S]+manifest_digest" IS NOT NULL[\s\S]+ready_at" IS NOT NULL/is,
    );
    expect(migration).toContain('site_release_ready_payload_immutable');
  });

  it('keeps activeVersionId as the sole pointer and only accepts a READY release', () => {
    expect(schema).not.toContain('previewReleaseId');
    expect(migration).not.toContain('preview_release_id');
    expect(migration).toContain('site_active_version_scope_fkey');
    expect(migration).toContain('site_active_version_requires_ready_release');
    expect(migration).toMatch(
      /NEW\."active_version_id"[\s\S]+site_release[\s\S]+"status" = 'ready'/is,
    );
  });

  it('forces tenant RLS and denies arbitrary application deletes', () => {
    expect(migration).toContain(
      'ALTER TABLE "site_release" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toMatch(
      /CREATE POLICY "site_release_tenant_isolation"[\s\S]+USING \("workspace_id" = current_workspace_id\(\)\)[\s\S]+WITH CHECK \("workspace_id" = current_workspace_id\(\)\)/,
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE "site_release" TO app_user',
    );
    expect(migration).not.toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "site_release" TO app_user',
    );
  });

  it('does not fabricate releases for legacy local artifacts', () => {
    expect(migration).not.toMatch(/INSERT\s+INTO\s+"site_release"/i);
    expect(migration).not.toMatch(/artifact_key[\s\S]+local:/i);
  });
});
