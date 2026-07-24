-- M1-f expand phase: admit P4 progress, bounded private artifact references,
-- and ReleaseManifest v3. Existing writers continue producing v2 until the
-- quality-loop workflow is promoted in a later PR.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE "site_build_step", "site_release" IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "site_build_step"
  ADD COLUMN "artifact_refs" JSONB;

ALTER TABLE "site_build_step"
  DROP CONSTRAINT "site_build_step_phase_check";

ALTER TABLE "site_build_step"
  ADD CONSTRAINT "site_build_step_phase_check"
  CHECK (
    "phase" IN (
      'P1_understanding',
      'P2_assets',
      'P3_assembly',
      'P4_quality',
      'P5_publish'
    )
  );

ALTER TABLE "site_build_step"
  ADD CONSTRAINT "site_build_step_artifact_refs_check"
  CHECK (
    "artifact_refs" IS NULL
    OR (
      jsonb_typeof("artifact_refs") = 'object'
      AND COALESCE(
        "artifact_refs"->>'schemaVersion' =
          'site-builder-step-artifact-refs/v1',
        FALSE
      )
      AND COALESCE(
        "artifact_refs"->>'collectionDigest' ~ '^[0-9a-f]{64}$',
        FALSE
      )
      AND CASE
        WHEN jsonb_typeof("artifact_refs"->'artifacts') = 'array'
          THEN jsonb_array_length("artifact_refs"->'artifacts') BETWEEN 1 AND 128
        ELSE FALSE
      END
    )
  );

ALTER TABLE "site_release"
  DROP CONSTRAINT "site_release_manifest_envelope_check";

ALTER TABLE "site_release"
  ADD CONSTRAINT "site_release_manifest_envelope_check"
  CHECK (
    "manifest" IS NULL
    OR COALESCE((
      jsonb_typeof("manifest") = 'object'
      AND "manifest"->>'releaseId' = "id"::text
      AND "manifest"->>'siteId' = "site_id"::text
      AND "manifest"->>'siteVersionId' = "site_version_id"::text
      AND "manifest"->>'buildRunId' = "build_run_id"::text
      AND "manifest"->>'artifactPrefix' = "artifact_prefix"
      AND "manifest"->>'artifactDigest' = "artifact_digest"
      AND jsonb_typeof("manifest"->'files') = 'array'
      AND (
        "manifest"->>'schemaVersion' = 'site-builder-release-manifest/v1'
        OR (
          "manifest"->>'schemaVersion' IN (
            'site-builder-release-manifest/v2',
            'site-builder-release-manifest/v3'
          )
          AND "manifest"->>'specVersion' = '1.1.0'
          AND jsonb_typeof("manifest"->'designBrief') = 'object'
          AND "manifest"->>'designBriefDigest' ~ '^[0-9a-f]{64}$'
          AND (
            "manifest"->>'schemaVersion' = 'site-builder-release-manifest/v2'
            OR (
              jsonb_typeof("manifest"->'quality') = 'object'
              AND "manifest"->'quality'->>'schemaVersion' =
                'site-builder-release-quality/v1'
              AND "manifest"->'quality'->>'status' IN (
                'passed',
                'passed_with_minor_findings',
                'passed_deterministic_aesthetic_unavailable'
              )
              AND "manifest"->'quality'->>'designEvaluationDigest'
                ~ '^[0-9a-f]{64}$'
              AND "manifest"->'quality'->>'screenshotSetDigest'
                ~ '^[0-9a-f]{64}$'
              AND CASE
                WHEN jsonb_typeof("manifest"->'quality'->'rounds') = 'array'
                  THEN jsonb_array_length("manifest"->'quality'->'rounds')
                    BETWEEN 1 AND 4
                ELSE FALSE
              END
            )
          )
        )
      )
    ), FALSE)
  );

COMMIT;
