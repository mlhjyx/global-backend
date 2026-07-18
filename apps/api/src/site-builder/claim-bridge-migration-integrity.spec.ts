import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repo = path.resolve(import.meta.dirname, "../../../..");
const migrationsDir = path.join(repo, "packages/db/prisma/migrations");
const schema = readFileSync(
  path.join(repo, "packages/db/prisma/schema.prisma"),
  "utf8",
);
const r4a2MigrationDirs = readdirSync(migrationsDir).filter((entry) =>
  /site_builder_r4a2_claim_bridge$/.test(entry),
);
const migration =
  r4a2MigrationDirs.length === 1 &&
  existsSync(path.join(migrationsDir, r4a2MigrationDirs[0]!, "migration.sql"))
    ? readFileSync(
        path.join(migrationsDir, r4a2MigrationDirs[0]!, "migration.sql"),
        "utf8",
      )
    : "";
const hardeningMigrationDirs = readdirSync(migrationsDir).filter((entry) =>
  /site_builder_r4a2_claim_bridge_hardening$/.test(entry),
);
const hardeningMigration =
  hardeningMigrationDirs.length === 1 &&
  existsSync(
    path.join(migrationsDir, hardeningMigrationDirs[0]!, "migration.sql"),
  )
    ? readFileSync(
        path.join(migrationsDir, hardeningMigrationDirs[0]!, "migration.sql"),
        "utf8",
      )
    : "";
const originMigrationDirs = readdirSync(migrationsDir).filter((entry) =>
  /site_builder_r4a2_evidence_origin_exactness$/.test(entry),
);
const originMigration =
  originMigrationDirs.length === 1
    ? readFileSync(
        path.join(migrationsDir, originMigrationDirs[0]!, "migration.sql"),
        "utf8",
      )
    : "";
const cascadeMigrationDirs = readdirSync(migrationsDir).filter((entry) =>
  /site_builder_r4a2_site_company_deferred_delete$/.test(entry),
);
const cascadeMigration =
  cascadeMigrationDirs.length === 1
    ? readFileSync(
        path.join(migrationsDir, cascadeMigrationDirs[0]!, "migration.sql"),
        "utf8",
      )
    : "";
const timezoneMigrationDirs = readdirSync(migrationsDir).filter((entry) =>
  /site_builder_r4a2_evidence_fetched_at_utc$/.test(entry),
);
const timezoneMigration =
  timezoneMigrationDirs.length === 1
    ? readFileSync(
        path.join(migrationsDir, timezoneMigrationDirs[0]!, "migration.sql"),
        "utf8",
      )
    : "";
const siteWorkspaceMigrationDirs = readdirSync(migrationsDir).filter((entry) =>
  /site_builder_r4a2_site_workspace_cascade$/.test(entry),
);
const siteWorkspaceMigration =
  siteWorkspaceMigrationDirs.length === 1
    ? readFileSync(
        path.join(
          migrationsDir,
          siteWorkspaceMigrationDirs[0]!,
          "migration.sql",
        ),
        "utf8",
      )
    : "";
const classifierMigrationDirs = readdirSync(migrationsDir).filter((entry) =>
  /site_builder_r4a2_claim_type_token_boundaries$/.test(entry),
);
const classifierMigration =
  classifierMigrationDirs.length === 1
    ? readFileSync(
        path.join(migrationsDir, classifierMigrationDirs[0]!, "migration.sql"),
        "utf8",
      )
    : "";
const unicodeClassifierMigrationDirs = readdirSync(migrationsDir).filter(
  (entry) => /site_builder_r4a2_claim_type_unicode_boundaries$/.test(entry),
);
const unicodeClassifierMigration =
  unicodeClassifierMigrationDirs.length === 1
    ? readFileSync(
        path.join(
          migrationsDir,
          unicodeClassifierMigrationDirs[0]!,
          "migration.sql",
        ),
        "utf8",
      )
    : "";
const approvalAuditMigrationDirs = readdirSync(migrationsDir).filter((entry) =>
  /site_builder_r4a2_claim_approval_audit_hardening$/.test(entry),
);
const approvalAuditMigration =
  approvalAuditMigrationDirs.length === 1
    ? readFileSync(
        path.join(
          migrationsDir,
          approvalAuditMigrationDirs[0]!,
          "migration.sql",
        ),
        "utf8",
      )
    : "";
const claimFactKeyMigrationDirs = readdirSync(migrationsDir).filter((entry) =>
  /site_builder_r4a2_claim_fact_key$/.test(entry),
);
const claimFactKeyMigration =
  claimFactKeyMigrationDirs.length === 1
    ? readFileSync(
        path.join(migrationsDir, claimFactKeyMigrationDirs[0]!, "migration.sql"),
        "utf8",
      )
    : "";

describe("R4-A2 Claim/Evidence truth bridge database invariants", () => {
  it("ships one additive R4-A2 migration and leaves historical Site links nullable", () => {
    expect(r4a2MigrationDirs).toHaveLength(1);
    expect(schema).toMatch(
      /companyProfileId\s+String\?\s+@map\("company_profile_id"\)\s+@db\.Uuid/,
    );
    expect(migration).toContain('ADD COLUMN "company_profile_id" UUID');
    expect(migration).not.toMatch(
      /ALTER COLUMN\s+"company_profile_id"\s+SET NOT NULL/i,
    );
    expect(migration).not.toMatch(
      /UPDATE\s+"site"[\s\S]+(?:LOWER|ILIKE|name)/i,
    );
  });

  it("binds Site to CompanyProfile with a same-workspace composite foreign key", () => {
    expect(schema).toContain(
      '@@unique([id, workspaceId], map: "company_profile_id_workspace_id_key")',
    );
    expect(schema).toMatch(
      /companyProfile\s+CompanyProfile\?\s+@relation\(fields: \[companyProfileId, workspaceId\], references: \[id, workspaceId\]/,
    );
    expect(migration).toMatch(
      /FOREIGN KEY \("company_profile_id", "workspace_id"\)[\s\S]+REFERENCES "company_profile"\("id", "workspace_id"\)/,
    );
  });

  it("creates a dedicated immutable BrandProfileClaimBridge with a stable domain bridge key", () => {
    expect(schema).toContain("model BrandProfileClaimBridge {");
    expect(schema).toMatch(
      /bridgeKey\s+String\s+@map\("bridge_key"\)\s+@db\.VarChar\(64\)/,
    );
    expect(schema).toContain(
      '@@unique([workspaceId, siteId, bridgeKey], map: "brand_profile_claim_bridge_scope_key")',
    );
    expect(migration).toContain('CREATE TABLE "brand_profile_claim_bridge"');
    expect(migration).toMatch(
      /"bridge_key"\s+(?:VARCHAR|CHARACTER VARYING)\(64\)/i,
    );
    expect(migration).toMatch(
      /bridge_key[\s\S]+CHECK[\s\S]+\^\[0-9a-f\]\{64\}\$/i,
    );
    expect(migration).toContain(
      "CREATE TRIGGER brand_profile_claim_bridge_immutable",
    );
    expect(migration).toContain(
      'REVOKE UPDATE, DELETE ON TABLE "brand_profile_claim_bridge" FROM app_user',
    );
  });

  it("makes every bridge edge tenant/site/company scoped instead of trusting globally-shaped ids", () => {
    for (const columns of [
      '"brand_profile_id", "workspace_id", "site_id"',
      '"evidence_ref_id", "workspace_id", "site_id", "brand_profile_id"',
      '"claim_id", "workspace_id", "company_profile_id"',
      '"evidence_id", "workspace_id", "claim_id"',
    ]) {
      expect(migration).toContain(`FOREIGN KEY (${columns})`);
    }
    expect(schema).toContain(
      '@@unique([id, workspaceId, companyId], map: "claim_id_workspace_company_key")',
    );
    expect(schema).toContain(
      '@@unique([id, workspaceId, claimId], map: "evidence_id_workspace_claim_key")',
    );
    expect(schema).toContain(
      '@@unique([id, workspaceId, siteId, brandProfileId], map: "brand_profile_evidence_ref_scope_profile_key")',
    );
  });

  it("forces bridge RLS and grants app_user append/read only", () => {
    expect(migration).toContain(
      'ALTER TABLE "brand_profile_claim_bridge" ENABLE ROW LEVEL SECURITY',
    );
    expect(migration).toContain(
      'ALTER TABLE "brand_profile_claim_bridge" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toMatch(
      /CREATE POLICY "brand_profile_claim_bridge_tenant_isolation"[\s\S]+USING \("workspace_id" = current_workspace_id\(\)\)[\s\S]+WITH CHECK \("workspace_id" = current_workspace_id\(\)\)/,
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT ON TABLE "brand_profile_claim_bridge" TO app_user',
    );
    expect(migration).not.toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "brand_profile_claim_bridge" TO app_user',
    );
  });

  it("records durable human verification provenance on Claim", () => {
    expect(schema).toMatch(/verifiedBy\s+String\?\s+@map\("verified_by"\)/);
    expect(schema).toMatch(/verifiedAt\s+DateTime\?\s+@map\("verified_at"\)/);
    expect(schema).toMatch(
      /verificationMethod\s+String\?\s+@map\("verification_method"\)/,
    );
    expect(schema).toMatch(
      /verificationProof\s+Json\?\s+@map\("verification_proof"\)/,
    );
    for (const column of [
      "verified_by",
      "verified_at",
      "verification_method",
      "verification_proof",
    ]) {
      expect(migration).toContain(`"${column}"`);
    }
    expect(migration).toMatch(/verification_method[\s\S]+human_review/i);
    expect(migration).toMatch(/REVOKED[\s\S]+verified_by[\s\S]+verified_at/i);
  });

  it("hardens the exact graph after the additive migration was applied", () => {
    expect(hardeningMigrationDirs).toHaveLength(1);
    expect(schema).toContain(
      '@@unique([id, workspaceId, companyProfileId], map: "site_id_workspace_company_key")',
    );
    expect(schema).toMatch(
      /site\s+Site\s+@relation\(fields: \[siteId, workspaceId, companyProfileId\], references: \[id, workspaceId, companyProfileId\]/,
    );
    expect(hardeningMigration).toContain(
      'FOREIGN KEY ("site_id", "workspace_id", "company_profile_id")',
    );
    expect(hardeningMigration).toContain(
      "CREATE TRIGGER bridged_claim_identity_immutable",
    );
    expect(hardeningMigration).toContain(
      "CREATE TRIGGER bridged_evidence_immutable",
    );
    expect(hardeningMigration).toContain(
      "CREATE TRIGGER brand_profile_claim_bridge_exact_evidence",
    );
    for (const exactField of [
      "source_snapshot_id",
      "source_content_hash",
      "fact_index",
      "quote_start",
      "quote_end",
      "cert_asset_id",
      "processing_status",
    ]) {
      expect(hardeningMigration).toContain(exactField);
    }
    expect(hardeningMigration).toContain(
      'REVOKE UPDATE, DELETE ON TABLE "evidence" FROM app_user',
    );
    expect(hardeningMigration).toContain(
      'REVOKE DELETE ON TABLE "claim" FROM app_user',
    );
    expect(hardeningMigration).toMatch(
      /quote_start" IS NULL AND "quote_end" IS NULL[\s\S]+"quote_start" IS NOT NULL AND "quote_end" IS NOT NULL/,
    );
  });

  it("binds optional EvidenceRefV2 URL/fetch-time origin at both JSON and Evidence layers", () => {
    expect(originMigrationDirs).toHaveLength(1);
    expect(originMigration).toContain(
      "CREATE FUNCTION assert_brand_profile_claim_evidence_origin_v2",
    );
    for (const field of [
      "display_url",
      "fetched_at",
      "source_url",
      "url",
      "fetchedAt",
    ]) {
      expect(originMigration).toContain(field);
    }
    expect(originMigration).toContain(
      "claim bridge Evidence origin does not match source snapshot",
    );
  });

  it("keeps workspace cascade deletion while deferring the Site-to-Company check", () => {
    expect(cascadeMigrationDirs).toHaveLength(1);
    expect(schema).toMatch(
      /companyProfile\s+CompanyProfile\?\s+@relation\([^\n]+onDelete: NoAction/,
    );
    expect(cascadeMigration).toMatch(
      /FOREIGN KEY \("company_profile_id", "workspace_id"\)[\s\S]+ON DELETE NO ACTION[\s\S]+DEFERRABLE INITIALLY DEFERRED/,
    );
  });

  it("normalizes ISO-Z EvidenceRef fetch times before comparing timestamp columns", () => {
    expect(timezoneMigrationDirs).toHaveLength(1);
    expect(timezoneMigration).toContain(
      "CREATE OR REPLACE FUNCTION assert_brand_profile_claim_evidence_origin_v2",
    );
    expect(timezoneMigration).toMatch(
      /::timestamptz\s+AT TIME ZONE 'UTC'/,
    );
  });

  it("cascades Site before Workspace deletion without inventing legacy tenant anchors", () => {
    expect(siteWorkspaceMigrationDirs).toHaveLength(1);
    expect(siteWorkspaceMigration).toMatch(
      /CREATE FUNCTION cascade_workspace_sites\(\)[\s\S]+DELETE FROM "site" WHERE "workspace_id" = OLD\."id"/,
    );
    expect(siteWorkspaceMigration).toContain(
      "CREATE TRIGGER workspace_sites_cascade",
    );
  });

  it("keeps the SQL claim classifier aligned on complete case tokens", () => {
    expect(classifierMigrationDirs).toHaveLength(1);
    expect(classifierMigration).toContain(
      "CREATE OR REPLACE FUNCTION claim_type_for_brand_fact_v1",
    );
    expect(classifierMigration).toMatch(
      /normalized_key[\s\S]+\(\^\|\[\^a-z0-9\]\)\(case\|customer\|client\|project\)\(\[\^a-z0-9\]\|\$\)/,
    );
    expect(classifierMigration).toContain("案例|客户|项目");
  });

  it("treats non-ASCII letters as letters at claim-type token boundaries", () => {
    expect(unicodeClassifierMigrationDirs).toHaveLength(1);
    expect(unicodeClassifierMigration).toContain(
      "CREATE OR REPLACE FUNCTION claim_type_for_brand_fact_v1",
    );
    expect(unicodeClassifierMigration).toContain(
      "(^|[^[:alnum:]])(case|customer|client|project)([^[:alnum:]]|$)",
    );
    expect(unicodeClassifierMigration).toContain(
      "normalized_key ~ '(certif|certificate|accredit|compliance",
    );
    expect(unicodeClassifierMigration).toContain(
      "ELSIF normalized_key ~",
    );
    expect(unicodeClassifierMigration).not.toContain(
      "(ce|fda|ul|rohs|reach|gmp|tüv)",
    );
  });

  it("requires a complete immutable v2 audit on every new APPROVED transition", () => {
    expect(approvalAuditMigrationDirs).toHaveLength(1);
    expect(approvalAuditMigration).toContain(
      'DROP CONSTRAINT "claim_human_verification_check"',
    );
    for (const column of [
      '"verified_by" IS NOT NULL',
      '"verified_at" IS NOT NULL',
      '"verification_method" IS NOT NULL',
      '"verification_proof" IS NOT NULL',
    ]) {
      expect(approvalAuditMigration).toContain(column);
    }
    expect(approvalAuditMigration).toMatch(
      /OLD\."status" = 'NEEDS_REVIEW'[\s\S]+NEW\."status" = 'APPROVED'/,
    );
    expect(approvalAuditMigration).toContain(
      `NEW."verification_proof" ->> 'claimDigest' ~ '^[0-9a-f]{64}$'`,
    );
    expect(approvalAuditMigration).not.toMatch(
      /IF\s+audit_changed\s+AND\s+NOT\s*\(/i,
    );
  });

  it("backfills a canonical immutable Claim fact key and requires v3 for new approvals", () => {
    expect(claimFactKeyMigrationDirs).toHaveLength(1);
    expect(schema).toMatch(/factKey\s+String\?\s+@map\("fact_key"\)/);
    expect(claimFactKeyMigration).toContain('ADD COLUMN "fact_key" TEXT');
    expect(claimFactKeyMigration).toContain("SET LOCAL lock_timeout = '5s'");
    expect(claimFactKeyMigration).toMatch(
      /origin-keyed Claim is missing its exact bridge fact key/i,
    );
    expect(claimFactKeyMigration).toMatch(
      /origin-keyed Claim has ambiguous normalized bridge fact keys/i,
    );
    expect(claimFactKeyMigration).toMatch(
      /approved bridged Claim still carries a v2 proof/i,
    );
    expect(claimFactKeyMigration).toMatch(
      /"origin_key" IS NULL AND "fact_key" IS NULL[\s\S]+"origin_key" IS NOT NULL AND "fact_key" IS NOT NULL/,
    );
    expect(claimFactKeyMigration).toContain(
      '"fact_key" = normalize_brand_claim_identity("fact_key")',
    );
    expect(claimFactKeyMigration).toContain(
      'claim_row."fact_key" IS DISTINCT FROM normalize_brand_claim_identity(ref_row."fact_key")',
    );
    expect(claimFactKeyMigration).toMatch(
      /NEW\."workspace_id", NEW\."company_id", NEW\."source_id", NEW\."origin_key",\s+NEW\."fact_key"/,
    );
    expect(claimFactKeyMigration).toContain(
      `NEW."verification_proof" -> 'proofVersion' = '3'::jsonb`,
    );
    expect(claimFactKeyMigration).toContain(
      "Claim approval requires a complete v3 human verification proof",
    );
  });
});
