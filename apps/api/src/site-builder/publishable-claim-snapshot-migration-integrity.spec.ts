import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = path.resolve(import.meta.dirname, '../../../..');
const migrationsDir = path.join(repo, 'packages/db/prisma/migrations');
const migrationDirs = readdirSync(migrationsDir).filter((entry) =>
  /site_builder_m1d_claim_snapshot$/.test(entry),
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

describe('M1-d PublishableClaimSnapshot database invariants', () => {
  it('adds one forward-only snapshot header/item migration without backfill', () => {
    expect(migrationDirs).toHaveLength(1);
    expect(schema).toContain('model SitePublishableClaimSnapshot {');
    expect(schema).toContain('model SitePublishableClaimSnapshotItem {');
    expect(migration).toContain('CREATE TABLE "site_publishable_claim_snapshot"');
    expect(migration).toContain('CREATE TABLE "site_publishable_claim_snapshot_item"');
    expect(migration).not.toMatch(/UPDATE\s+"(?:brand_profile|site_version|claim)"/i);
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i);
  });

  it('binds one immutable snapshot to the exact BuildRun/Site/company scope', () => {
    expect(migration).toMatch(
      /UNIQUE\s*\("build_run_id"\)/i,
    );
    expect(migration).toMatch(
      /FOREIGN KEY \("build_run_id", "workspace_id", "site_id"\)[\s\S]+REFERENCES "site_build_run"\("id", "workspace_id", "site_id"\)/,
    );
    expect(migration).toMatch(
      /FOREIGN KEY \("site_id", "workspace_id", "company_profile_id"\)[\s\S]+REFERENCES "site"\("id", "workspace_id", "company_profile_id"\)/,
    );
    expect(migration).toMatch(/snapshot_digest[\s\S]+\^\[0-9a-f\]\{64\}\$/i);
    expect(migration).toMatch(/schema_version[\s\S]+site-builder-publishable-claim-snapshot\/v1/i);
  });

  it('freezes each Claim version and exact bridge/evidence/source provenance', () => {
    for (const column of [
      'claim_id',
      'claim_version',
      'fact_key',
      'claim_type',
      'statement',
      'valid_until',
      'approved_by',
      'approved_at',
      'bridge_id',
      'brand_profile_id',
      'evidence_ref_id',
      'evidence_id',
      'source_snapshot_id',
      'source_content_hash',
      'quote',
      'quote_start',
      'quote_end',
      'cert_asset_id',
    ]) {
      expect(migration).toContain(`"${column}"`);
    }
    expect(migration).toMatch(
      /FOREIGN KEY \("bridge_id", "workspace_id", "site_id"\)[\s\S]+REFERENCES "brand_profile_claim_bridge"/,
    );
    expect(migration).toMatch(
      /FOREIGN KEY \("claim_id", "workspace_id", "company_profile_id"\)[\s\S]+REFERENCES "claim"/,
    );
    expect(migration).toMatch(/UNIQUE\s*\("snapshot_id",\s*"claim_id"\)/i);
  });

  it('forces RLS and makes both snapshot tables append-only to app_user and owner updates', () => {
    for (const table of [
      'site_publishable_claim_snapshot',
      'site_publishable_claim_snapshot_item',
    ]) {
      expect(migration).toContain(
        `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`,
      );
      expect(migration).toContain(
        `GRANT SELECT, INSERT ON TABLE "${table}" TO app_user`,
      );
      expect(migration).toContain(
        `REVOKE UPDATE, DELETE ON TABLE "${table}" FROM app_user`,
      );
    }
    expect(migration).toContain('CREATE TRIGGER site_publishable_claim_snapshot_immutable');
    expect(migration).toContain('CREATE TRIGGER site_publishable_claim_snapshot_item_immutable');
  });
});
