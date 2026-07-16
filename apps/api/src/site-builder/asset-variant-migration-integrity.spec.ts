import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function repositoryFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

const migrationPath =
  "packages/db/prisma/migrations/20260717040000_site_builder_asset_variant_mf0/migration.sql";

describe("MF0-A AssetVariant migration integrity", () => {
  it("adds the tenant-scoped materialized variant and its complete provenance", () => {
    const sql = repositoryFile(migrationPath);

    expect(sql).toContain('CREATE TABLE "asset_variant"');
    for (const column of [
      "workspace_id",
      "site_id",
      "asset_id",
      "variant_type",
      "mime",
      "width",
      "height",
      "duration_ms",
      "bitrate_kbps",
      "size_bytes",
      "object_key",
      "content_hash",
      "pipeline_version",
      "recipe_hash",
      "source_variant_id",
      "status",
      "error",
      "metadata",
    ]) {
      expect(sql).toContain(`"${column}"`);
    }

    expect(sql).toContain(
      'UNIQUE ("asset_id", "recipe_hash")',
    );
    expect(sql).toContain('UNIQUE ("object_key")');
    expect(sql).toContain(
      'FOREIGN KEY ("asset_id", "workspace_id", "site_id")',
    );
    expect(sql).toContain(
      'REFERENCES "asset"("id", "workspace_id", "site_id")',
    );
    expect(sql).toContain(
      'FOREIGN KEY ("source_variant_id", "workspace_id", "site_id", "asset_id")',
    );
    expect(sql).toContain(
      'REFERENCES "asset_variant"("id", "workspace_id", "site_id", "asset_id")',
    );
  });

  it("enforces materialization state, hashes, dimensions and canonical object-key scope", () => {
    const sql = repositoryFile(migrationPath);

    expect(sql).toMatch(/status.+processing.+ready.+failed/is);
    expect(sql).toMatch(/content_hash.+\^\[0-9a-f\]\{64\}\$/is);
    expect(sql).toMatch(/recipe_hash.+\^\[0-9a-f\]\{64\}\$/is);
    expect(sql).toMatch(/status.+ready.+content_hash.+IS NOT NULL/is);
    expect(sql).toMatch(/width.+IS NULL.+width.+> 0/is);
    expect(sql).toMatch(/height.+IS NULL.+height.+> 0/is);
    expect(sql).toMatch(/size_bytes.+IS NULL.+size_bytes.+> 0/is);
    expect(sql).toMatch(/object_key.+workspace_id.+site_id/is);
    expect(sql).toMatch(/object_key.+uploads/is);
  });

  it("enables and forces RLS with symmetric tenant checks and explicit app grants", () => {
    const sql = repositoryFile(migrationPath);

    expect(sql).toContain('ALTER TABLE "asset_variant" ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "asset_variant" FORCE ROW LEVEL SECURITY');
    expect(sql).toMatch(
      /CREATE POLICY "asset_variant_tenant_isolation"[\s\S]+USING \("workspace_id" = current_workspace_id\(\)\)[\s\S]+WITH CHECK \("workspace_id" = current_workspace_id\(\)\)/,
    );
    expect(sql).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "asset_variant" TO app_user',
    );
    expect(sql).not.toMatch(
      /DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY/i,
    );
  });

  it("keeps Prisma and SQL in one additive schema", () => {
    const schema = repositoryFile("packages/db/prisma/schema.prisma");

    expect(schema).toContain("model AssetVariant {");
    expect(schema).toContain("variants AssetVariant[]");
    expect(schema).toContain("@@unique([assetId, recipeHash]");
    expect(schema).toContain("@@map(\"asset_variant\")");
    expect(schema).not.toContain("model MediaJob {");
    expect(schema).not.toContain("model AssetUsage {");
  });
});
