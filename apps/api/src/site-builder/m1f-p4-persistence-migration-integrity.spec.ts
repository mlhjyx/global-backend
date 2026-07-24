import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repo = path.resolve(import.meta.dirname, "../../../..");
const migration = readFileSync(
  path.join(
    repo,
    "packages/db/prisma/migrations/20260724020000_site_builder_m1f_p4_persistence/migration.sql",
  ),
  "utf8",
);
const schema = readFileSync(
  path.join(repo, "packages/db/prisma/schema.prisma"),
  "utf8",
);

describe("M1-f P4 persistence expand migration", () => {
  it("adds private artifact metadata and the monotonic P4 phase", () => {
    expect(schema).toMatch(
      /model SiteBuildStep \{[\s\S]+artifactRefs\s+Json\?\s+@map\("artifact_refs"\)/,
    );
    expect(migration).toContain('ADD COLUMN "artifact_refs" JSONB');
    expect(migration).toMatch(
      /site_build_step_phase_check[\s\S]+'P3_assembly'[\s\S]+'P4_quality'[\s\S]+'P5_publish'/,
    );
    expect(migration).toMatch(
      /site_build_step_artifact_refs_check[\s\S]+site-builder-step-artifact-refs\/v1[\s\S]+collectionDigest[\s\S]+jsonb_array_length[\s\S]+BETWEEN 1 AND 128/,
    );
    expect(migration).toMatch(
      /site_build_step_artifact_refs_check[\s\S]+COALESCE[\s\S]+CASE[\s\S]+ELSE FALSE/,
    );
  });

  it("expands the manifest reader envelope to v3 while preserving v1/v2", () => {
    expect(migration).toContain(
      'DROP CONSTRAINT "site_release_manifest_envelope_check"',
    );
    expect(migration).toMatch(
      /site-builder-release-manifest\/v1[\s\S]+site-builder-release-manifest\/v2[\s\S]+site-builder-release-manifest\/v3/,
    );
    expect(migration).toMatch(
      /site-builder-release-quality\/v1[\s\S]+passed_with_minor_findings[\s\S]+passed_deterministic_aesthetic_unavailable/,
    );
    expect(migration).toMatch(
      /site_release_manifest_envelope_check[\s\S]+OR COALESCE[\s\S]+jsonb_typeof\("manifest"\) = 'object'[\s\S]+ELSE FALSE/,
    );
  });

  it("does not backfill history, create a Release, or enable the workflow writer", () => {
    expect(migration).not.toMatch(/\bINSERT\b|\bUPDATE\b/i);
    expect(migration).not.toMatch(/\bCREATE\s+TABLE\b/i);
    expect(migration).not.toContain("site-builder-m1f-quality-loop-v1");
  });
});
