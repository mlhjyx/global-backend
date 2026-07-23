-- M1-e-B: expose DesignBrief production as a first-class build step and
-- admit the immutable ReleaseManifest v2 envelope while preserving v1.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE "site_build_step", "site_release" IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "site_build_step"
  DROP CONSTRAINT "site_build_step_key_check";

ALTER TABLE "site_build_step"
  ADD CONSTRAINT "site_build_step_key_check"
  CHECK (
    "key" IN (
      'kb_ingest',
      'brand_profile',
      'image_pipeline',
      'design_spec',
      'copy',
      'assemble_build',
      'quality_loop'
    )
  );

ALTER TABLE "site_release"
  DROP CONSTRAINT "site_release_manifest_envelope_check";

ALTER TABLE "site_release"
  ADD CONSTRAINT "site_release_manifest_envelope_check"
  CHECK (
    "manifest" IS NULL
    OR (
      "manifest"->>'releaseId' = "id"::text
      AND "manifest"->>'siteId' = "site_id"::text
      AND "manifest"->>'siteVersionId' = "site_version_id"::text
      AND "manifest"->>'buildRunId' = "build_run_id"::text
      AND "manifest"->>'artifactPrefix' = "artifact_prefix"
      AND "manifest"->>'artifactDigest' = "artifact_digest"
      AND jsonb_typeof("manifest"->'files') = 'array'
      AND (
        "manifest"->>'schemaVersion' = 'site-builder-release-manifest/v1'
        OR (
          "manifest"->>'schemaVersion' = 'site-builder-release-manifest/v2'
          AND "manifest"->>'specVersion' = '1.1.0'
          AND jsonb_typeof("manifest"->'designBrief') = 'object'
          AND "manifest"->>'designBriefDigest' ~ '^[0-9a-f]{64}$'
        )
      )
    )
  );

COMMIT;
