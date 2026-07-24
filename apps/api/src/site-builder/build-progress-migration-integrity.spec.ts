import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repo = path.resolve(import.meta.dirname, "../../../..");
const migration = readFileSync(
  path.join(
    repo,
    "packages/db/prisma/migrations/20260717070000_site_builder_r3b2_progress/migration.sql",
  ),
  "utf8",
);
const m1ebMigration = readFileSync(
  path.join(
    repo,
    "packages/db/prisma/migrations/20260724010000_site_builder_m1eb_progress/migration.sql",
  ),
  "utf8",
);
const schema = readFileSync(
  path.join(repo, "packages/db/prisma/schema.prisma"),
  "utf8",
);

describe("R3-B2 SiteBuildStep database invariants", () => {
  it("keeps Prisma defaults aligned with the database-owned row defaults", () => {
    expect(migration).toContain(
      '"id" UUID NOT NULL DEFAULT gen_random_uuid()',
    );
    expect(migration).toContain(
      '"updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP',
    );
    expect(schema).toMatch(
      /model SiteBuildStep \{[\s\S]+id\s+String\s+@id @default\(dbgenerated\("gen_random_uuid\(\)"\)\) @db\.Uuid/,
    );
    expect(schema).toMatch(
      /model SiteBuildStep \{[\s\S]+updatedAt\s+DateTime\s+@default\(now\(\)\) @updatedAt @map\("updated_at"\)/,
    );
  });

  it("binds every step to the same-workspace BuildRun without mutable provenance", () => {
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'");
    expect(migration).toContain('LOCK TABLE "site_build_run"');
    expect(migration).toMatch(
      /FOREIGN KEY \("build_run_id", "workspace_id"\)[\s\S]+REFERENCES "site_build_run"\("id", "workspace_id"\)[\s\S]+ON DELETE CASCADE[\s\S]+ON UPDATE NO ACTION/,
    );
    expect(schema).toMatch(
      /buildRun SiteBuildRun @relation\(fields: \[buildRunId, workspaceId\], references: \[id, workspaceId\][\s\S]+onUpdate: NoAction\)/,
    );
  });

  it("enforces bounded legal state, progress and one record per logical attempt", () => {
    expect(migration).toMatch(
      /status" IN \('queued', 'running', 'done', 'degraded', 'failed', 'skipped', 'aborted'\)/,
    );
    expect(migration).toContain('"attempt" >= 1');
    expect(migration).toContain('"progress" >= 0 AND "progress" <= 1');
    expect(migration).toContain("site_build_step_key_check");
    expect(migration).toContain("site_build_step_phase_check");
    expect(migration).toContain("site_build_step_terminal_time_check");
    expect(migration).toContain('char_length("item_key") <= 512');
    expect(migration).toContain('char_length("error_code") <= 128');
    expect(migration).toMatch(
      /UNIQUE INDEX "site_build_step_build_run_id_key_item_key_attempt_key"[\s\S]+"build_run_id", "key", "item_key", "attempt"/,
    );
  });

  it("adds design_spec and admits only the v1/v2 ReleaseManifest envelopes", () => {
    expect(m1ebMigration).toContain("SET LOCAL lock_timeout = '5s'");
    expect(m1ebMigration).toContain('LOCK TABLE "site_build_step"');
    expect(m1ebMigration).toContain(
      'DROP CONSTRAINT "site_build_step_key_check"',
    );
    expect(m1ebMigration).toMatch(
      /ADD CONSTRAINT "site_build_step_key_check"[\s\S]+CHECK \([\s\S]+'kb_ingest'[\s\S]+'brand_profile'[\s\S]+'image_pipeline'[\s\S]+'design_spec'[\s\S]+'copy'[\s\S]+'assemble_build'[\s\S]+'quality_loop'/,
    );
    expect(m1ebMigration).toContain(
      'DROP CONSTRAINT "site_release_manifest_envelope_check"',
    );
    expect(m1ebMigration).toMatch(
      /ADD CONSTRAINT "site_release_manifest_envelope_check"[\s\S]+'site-builder-release-manifest\/v1'[\s\S]+'site-builder-release-manifest\/v2'[\s\S]+'specVersion' = '1\.1\.0'[\s\S]+jsonb_typeof\("manifest"->'designBrief'\) = 'object'[\s\S]+'designBriefDigest' ~ '\^\[0-9a-f\]\{64\}\$'/,
    );
    expect(m1ebMigration).not.toMatch(
      /\bCREATE\s+(?:TABLE|TYPE)\b|\bADD\s+COLUMN\b/i,
    );
  });

  it("forces workspace RLS and grants only the workspace-scoped application role", () => {
    expect(migration).toContain(
      'ALTER TABLE "site_build_step" ENABLE ROW LEVEL SECURITY',
    );
    expect(migration).toContain(
      'ALTER TABLE "site_build_step" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toMatch(
      /USING \("workspace_id" = current_workspace_id\(\)\)/,
    );
    expect(migration).toMatch(
      /WITH CHECK \("workspace_id" = current_workspace_id\(\)\)/,
    );
    expect(migration).toContain("TO app_user");
  });
});
