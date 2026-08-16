import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../../packages/db/prisma/migrations/20260812090000_organization_identity_v2/migration.sql'),
  'utf8',
);
const legacyDomainIndexMigration = readFileSync(
  resolve(process.cwd(), '../../packages/db/prisma/migrations/20260813060000_canonical_company_normalized_domain_index/migration.sql'),
  'utf8',
);
const conflictClaimMigration = readFileSync(
  resolve(process.cwd(), '../../packages/db/prisma/migrations/20260813070000_organization_identifier_conflict_claim/migration.sql'),
  'utf8',
);

describe('organization identity v2 migration invariants', () => {
  it('is additive and contains no historical company backfill', () => {
    expect(migration).not.toMatch(/UPDATE\s+"canonical_company"/iu);
    expect(migration).not.toMatch(/DELETE\s+FROM\s+"canonical_company"/iu);
    expect(migration).toContain('intentionally does not backfill existing companies');
  });

  it('indexes legacy URL-shaped domains without rewriting or locking the company table', () => {
    expect(legacyDomainIndexMigration).toContain('CREATE INDEX CONCURRENTLY');
    expect(legacyDomainIndexMigration).not.toContain('IF NOT EXISTS');
    expect(legacyDomainIndexMigration).toContain('WHERE "domain" IS NOT NULL');
    expect(legacyDomainIndexMigration).not.toMatch(/UPDATE\s+"canonical_company"/iu);
    expect(legacyDomainIndexMigration).not.toMatch(/ADD COLUMN|CREATE TRIGGER/iu);
  });

  it('forces symmetric workspace RLS on every new tenant table', () => {
    for (const table of [
      'organization_identifier',
      'organization_identity_conflict',
      'organization_identity_conflict_party',
      'organization_identity_decision',
      'organization_canonical_mapping',
      'organization_identity_replay',
    ]) {
      expect(migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(migration).toMatch(new RegExp(`CREATE POLICY "${table}_tenant_isolation"[\\s\\S]+WITH CHECK`, 'u'));
    }
  });

  it('makes active identifiers unique and decisions append-only', () => {
    expect(migration).toMatch(/organization_identifier_active_authority_key[\s\S]+WHERE "status" = 'ACTIVE'/u);
    expect(migration).toContain('organization_identity_decision_append_only_guard');
    expect(migration).toContain('REVOKE UPDATE, DELETE ON TABLE "organization_identity_decision" FROM app_user');
  });

  it('requires every pending identifier claim to name its deterministic conflict owner', () => {
    expect(conflictClaimMigration).toContain('SET LOCAL row_security = off');
    expect(conflictClaimMigration).toContain('organization_identifier_pending_conflict_owner_check');
    expect(conflictClaimMigration).toMatch(/"status" <> 'PENDING_CONFLICT' OR "conflict_id" IS NOT NULL/u);
    expect(conflictClaimMigration).toContain('organization_identifier_conflict_claim_key');
    expect(conflictClaimMigration).toMatch(/FOREIGN KEY \("workspace_id", "conflict_id"\)/u);
    expect(conflictClaimMigration).toContain('pending claim without a deterministic conflict owner');
  });

  it('denies app_user physical deletion and guards every identity audit fact at the database boundary', () => {
    for (const table of [
      'organization_identifier',
      'organization_identity_conflict',
      'organization_identity_conflict_party',
      'organization_canonical_mapping',
      'organization_identity_replay',
    ]) {
      expect(migration).toMatch(new RegExp(`REVOKE DELETE[\\s\\S]+"${table}"[\\s\\S]+FROM app_user`, 'u'));
      expect(migration).toContain(`CREATE TRIGGER "${table}_delete_guard"`);
      expect(migration).toContain(`BEFORE DELETE ON "${table}"`);
    }
    expect(migration).toContain('reject_organization_identity_delete');
  });

  it('rejects self, multi-root and cross-workspace mappings', () => {
    expect(migration).toContain('organization_canonical_mapping_not_self_check');
    expect(migration).toContain('organization_canonical_mapping_active_source_key');
    expect(migration).toContain('organization_canonical_mapping_root_guard');
    expect(migration).toMatch(/FOREIGN KEY \("workspace_id", "source_company_id"\)/u);
    expect(migration).toMatch(/FOREIGN KEY \("workspace_id", "canonical_company_id"\)/u);
  });
});
