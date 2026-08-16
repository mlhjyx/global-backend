import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    '../../packages/db/prisma/migrations/20260813020000_monitored_source_raw_bridge/migration.sql',
  ),
  'utf8',
);
const identityMigration = readFileSync(
  resolve(
    process.cwd(),
    '../../packages/db/prisma/migrations/20260812090000_organization_identity_v2/migration.sql',
  ),
  'utf8',
);
const immutableMigration = readFileSync(
  resolve(
    process.cwd(),
    '../../packages/db/prisma/migrations/20260813030000_monitored_source_raw_origin_immutable/migration.sql',
  ),
  'utf8',
);
const provenanceMigration = readFileSync(
  resolve(
    process.cwd(),
    '../../packages/db/prisma/migrations/20260813040000_source_entity_fetch_provenance/migration.sql',
  ),
  'utf8',
);

describe('monitored source raw bridge migration', () => {
  it('keeps discovery raws compatible while allowing monitored snapshots without a discovery run', () => {
    expect(identityMigration).toContain('SET LOCAL row_security = off');
    expect(identityMigration).toMatch(/LOCK TABLE[\s\S]+"source_entity"[\s\S]+"monitored_source"/u);
    expect(identityMigration).toContain('ALTER COLUMN "run_id" DROP NOT NULL');
    expect(identityMigration).toContain('ADD COLUMN "source_entity_id" UUID');
    expect(identityMigration).toMatch(/INSERT INTO "raw_source_record"[\s\S]+legacy-source-entity\/v1/u);
    expect(identityMigration).toMatch(/UPDATE "identity_link"[\s\S]+SET "raw_record_id" = raw\."id"/u);
    expect(identityMigration.indexOf('UPDATE "identity_link"')).toBeLessThan(
      identityMigration.indexOf('identity_link contains an unresolvable'),
    );
    expect(identityMigration).toMatch(/SELECT "workspace_id", "raw_record_id" FROM "identity_link"[\s\S]+UNION[\s\S]+SELECT "workspace_id", "raw_record_id" FROM "field_evidence"/u);
  });

  it('creates an explicit legacy reference receipt without inventing original raw provenance', () => {
    expect(identityMigration).toContain("'provenanceLevel', 'legacy_reference_only'");
    expect(identityMigration).toContain("'originKind', 'monitored_source_projection'");
    expect(identityMigration).not.toMatch(/'cleaned',\s*entity\."cleaned"/u);
    const insertColumns = identityMigration.match(
      /INSERT INTO "raw_source_record" \(([\s\S]*?)\)\s*SELECT/u,
    )?.[1];
    expect(insertColumns).toBeDefined();
    expect(insertColumns).not.toMatch(/"source_url"|"fetched_at"|"parser_version"/u);
  });

  it('makes a monitored snapshot idempotent per workspace and preserves the source relation', () => {
    expect(migration).toContain('raw_source_record_workspace_source_entity_ingest_key');
    expect(migration).toMatch(/UNIQUE \("workspace_id", "source_entity_id", "ingest_key"\)/u);
    expect(identityMigration).toMatch(/FOREIGN KEY \("source_entity_id"\)[\s\S]+REFERENCES "source_entity"\("id"\)[\s\S]+ON DELETE RESTRICT/u);
    expect(migration).toContain('raw_source_record_exactly_one_origin_check');
  });

  it('extends the existing raw-source/v2 immutability boundary to the monitored origin', () => {
    expect(immutableMigration).toContain('raw_source_record_origin_immutable_guard');
    expect(immutableMigration).toMatch(/NEW\."source_entity_id" IS DISTINCT FROM OLD\."source_entity_id"/u);
  });

  it('adds an exact fetch provenance relation and only backfills a uniquely provable completed fetch', () => {
    expect(provenanceMigration).toContain('ADD COLUMN "last_seen_fetch_id" UUID');
    expect(provenanceMigration).toContain('source_entity_last_seen_fetch_fkey');
    expect(provenanceMigration).toMatch(
      /FOREIGN KEY \("last_seen_fetch_id", "source_id"\)[\s\S]+REFERENCES "source_fetch"\("id", "source_id"\)/u,
    );
    expect(provenanceMigration).toMatch(/sf\."source_id" = se\."source_id"/u);
    expect(provenanceMigration).toMatch(/sf\."finished_at" = se\."last_seen_at"/u);
    expect(provenanceMigration).toMatch(/COUNT\(\*\) = 1/u);
  });

  it('makes bridge field evidence idempotent per Raw origin without rewriting existing facts', () => {
    expect(provenanceMigration).toContain('field_evidence_raw_field_unique');
    expect(provenanceMigration).toContain(
      'UNIQUE ("workspace_id", "entity_type", "entity_id", "field", "raw_record_id")',
    );
  });
});
