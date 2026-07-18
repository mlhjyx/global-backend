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
});
