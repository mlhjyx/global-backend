import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = path.resolve(import.meta.dirname, '../../../..');
const migration = readFileSync(
  path.join(
    repo,
    'packages/db/prisma/migrations/20260717120000_site_builder_r4a1_evidence_v2/migration.sql',
  ),
  'utf8',
);
const schema = readFileSync(
  path.join(repo, 'packages/db/prisma/schema.prisma'),
  'utf8',
);

describe('R4-A1 Evidence 2.0 database invariants', () => {
  it('fails closed on historical BrandProfile tenant mismatches before replacing the FK', () => {
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'");
    expect(migration).toContain('SET LOCAL row_security = off');
    expect(migration).toMatch(
      /brand_profile[\s\S]+JOIN "site"[\s\S]+workspace_id[\s\S]+RAISE EXCEPTION/i,
    );
    expect(migration).toContain(
      'DROP CONSTRAINT "brand_profile_site_id_fkey"',
    );
    expect(migration).toMatch(
      /FOREIGN KEY \("site_id", "workspace_id"\)[\s\S]+REFERENCES "site"\("id", "workspace_id"\)/,
    );
  });

  it('stores immutable frozen source snapshots with bounded roles, hashes and provenance', () => {
    expect(migration).toContain('CREATE TABLE "site_evidence_source_snapshot"');
    for (const column of [
      'workspace_id',
      'site_id',
      'source_key',
      'source_type',
      'source_role',
      'hash_algorithm',
      'content_hash',
      'upstream_content_hash',
      'normalization_version',
      'snapshot_text',
      'display_url',
      'fetched_at',
      'provenance',
      'dedupe_key',
    ]) {
      expect(migration).toContain(`"${column}"`);
    }
    expect(migration).toMatch(/source_role.+fact_candidate.+research_hint/is);
    expect(migration).toMatch(/content_hash.+\^\[0-9a-f\]\{64\}\$/is);
    expect(migration).toMatch(/upstream_content_hash.+\^\[0-9a-f\]\{64\}\$/is);
    expect(migration).toMatch(/CREATE TRIGGER.+evidence.+immutable/is);
  });

  it('binds every EvidenceRef to the same profile/site/workspace and exact source hash', () => {
    expect(migration).toContain('CREATE TABLE "brand_profile_evidence_ref"');
    expect(migration).toMatch(
      /FOREIGN KEY \("brand_profile_id", "workspace_id", "site_id"\)[\s\S]+REFERENCES "brand_profile"\("id", "workspace_id", "site_id"\)/,
    );
    expect(migration).toMatch(
      /FOREIGN KEY \("source_snapshot_id", "workspace_id", "site_id", "source_content_hash"\)[\s\S]+REFERENCES "site_evidence_source_snapshot"\("id", "workspace_id", "site_id", "content_hash"\)/,
    );
    expect(migration).toMatch(/quote_start.+>= 0/is);
    expect(migration).toMatch(/quote_end.+quote_start/is);
  });

  it('forces symmetric RLS and gives app_user no arbitrary source/ref update or delete', () => {
    for (const table of [
      'site_evidence_source_snapshot',
      'brand_profile_evidence_ref',
    ]) {
      expect(migration).toContain(
        `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`,
      );
      expect(migration).toMatch(
        new RegExp(
          `CREATE POLICY "${table}_tenant_isolation"[\\s\\S]+USING \\(\\"workspace_id\\" = current_workspace_id\\(\\)\\)[\\s\\S]+WITH CHECK \\(\\"workspace_id\\" = current_workspace_id\\(\\)\\)`,
        ),
      );
      expect(migration).toContain(
        `GRANT SELECT, INSERT ON TABLE "${table}" TO app_user`,
      );
      expect(migration).not.toContain(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${table}" TO app_user`,
      );
    }
  });

  it('keeps existing rows on v1 and makes only new writes opt into v2', () => {
    expect(migration).toContain(
      '"evidence_schema_version" INTEGER NOT NULL DEFAULT 1',
    );
    expect(migration).not.toMatch(/UPDATE\s+"brand_profile"/i);
    expect(schema).toContain('evidenceSchemaVersion Int');
    expect(schema).toContain('model SiteEvidenceSourceSnapshot {');
    expect(schema).toContain('model BrandProfileEvidenceRef {');
  });
});
