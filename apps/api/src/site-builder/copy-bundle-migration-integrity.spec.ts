import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../../..");
const SCHEMA = resolve(ROOT, "packages/db/prisma/schema.prisma");
const MIGRATION = resolve(
  ROOT,
  "packages/db/prisma/migrations/20260719223000_site_builder_m1d_copy_bundle/migration.sql",
);

describe("M1-d CopyBundle migration integrity", () => {
  it("declares the immutable CopyBundle model in Prisma", () => {
    const schema = readFileSync(SCHEMA, "utf8");
    expect(schema).toContain("model SiteCopyBundle {");
    expect(schema).toContain('@@map("site_copy_bundle")');
    expect(schema).toMatch(/@@unique\(\[siteVersionId, locale\]/);
  });

  it("ships an additive scoped migration with exact provenance FKs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toContain('CREATE TABLE "site_copy_bundle"');
    expect(sql).toMatch(
      /FOREIGN KEY \("site_version_id", "workspace_id", "site_id"\)[\s\S]*REFERENCES "site_version"\("id", "workspace_id", "site_id"\)/,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \("claim_snapshot_id", "workspace_id", "site_id"\)[\s\S]*REFERENCES "site_publishable_claim_snapshot"\("id", "workspace_id", "site_id"\)/,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \("task_attempt_id", "workspace_id", "site_id"\)[\s\S]*REFERENCES "site_build_task_attempt"\("id", "workspace_id", "site_id"\)/,
    );
    expect(sql).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/i);
  });

  it("enforces versions, hashes, locale uniqueness, and immutability", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toContain("site-builder-copy-bundle/v1");
    expect(sql).toContain("site-builder-copy-slots/v1");
    expect(sql).toContain(
      'UNIQUE ("site_version_id", "locale")',
    );
    expect(sql).toContain("site_copy_bundle_immutable");
    expect(sql).toMatch(/REVOKE UPDATE, DELETE[\s\S]*site_copy_bundle/);
  });

  it("forces workspace RLS and grants app_user only read/insert", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toContain(
      'ALTER TABLE "site_copy_bundle" FORCE ROW LEVEL SECURITY',
    );
    expect(sql).toContain('"workspace_id" = current_workspace_id()');
    expect(sql).toContain(
      'GRANT SELECT, INSERT ON TABLE "site_copy_bundle" TO app_user',
    );
  });
});
