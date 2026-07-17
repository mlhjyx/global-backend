import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = path.resolve(import.meta.dirname, '../../../..');
const migration = readFileSync(
  path.join(repo, 'packages/db/prisma/migrations/20260717050000_site_builder_mf0b_cleanup_gate/migration.sql'),
  'utf8',
);
const quarantineMigration = readFileSync(
  path.join(
    repo,
    'packages/db/prisma/migrations/20260717051000_site_builder_mf0b_legacy_cleanup_quarantine/migration.sql',
  ),
  'utf8',
);
const schema = readFileSync(path.join(repo, 'packages/db/prisma/schema.prisma'), 'utf8');

describe('MF0-B cleanup/write-side database gate', () => {
  it('adds durable cleanup ownership without rewriting historical tombstones', () => {
    expect(schema).toContain('cleanupEventId');
    expect(schema).toContain('cleanupCompletedAt');
    expect(migration).toContain('"asset_cleanup_event_id_key"');
    expect(migration).toMatch(/asset_cleanup_lifecycle_check[\s\S]+NOT VALID/);
    expect(migration).not.toMatch(/UPDATE\s+"asset"/i);
    expect(migration).not.toMatch(/DELETE\s+FROM/i);
    expect(quarantineMigration).toContain('"cleanup_legacy_unbound"');
    expect(quarantineMigration).toMatch(/^--[\s\S]+\nBEGIN;[\s\S]+COMMIT;\s*$/);
    expect(quarantineMigration).toMatch(/UPDATE "asset"[\s\S]+"deleted_at" IS NOT NULL/);
    expect(quarantineMigration).toContain('DROP CONSTRAINT "asset_cleanup_lifecycle_check"');
    expect(quarantineMigration.indexOf('DROP CONSTRAINT "asset_cleanup_lifecycle_check"')).toBeLessThan(
      quarantineMigration.indexOf('UPDATE "asset"'),
    );
    expect(quarantineMigration).not.toMatch(/asset_cleanup_lifecycle_check[\s\S]+NOT VALID/);
    expect(quarantineMigration).toContain('asset_cleanup_legacy_marker_guard_trigger');
  });

  it('serializes Variant writes on a live, ready, checksummed parent Asset', () => {
    expect(migration).toContain('CREATE TRIGGER "asset_variant_require_live_parent_trigger"');
    expect(migration).toMatch(/FROM public\.asset[\s\S]+FOR UPDATE/);
    expect(migration).toContain('a.deleted_at IS NULL');
    expect(migration).toContain('a.cleanup_event_id IS NULL');
    expect(migration).toContain("a.processing_status = 'ready'");
    expect(migration).toContain('a.content_hash IS NOT NULL');
    expect(migration).toContain("ERRCODE = '23514'");
  });
});
