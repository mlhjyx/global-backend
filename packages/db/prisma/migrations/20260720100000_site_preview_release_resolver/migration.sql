-- Public preview requests intentionally carry no tenant bearer token. Expose only the immutable
-- Release selected by Site.active_version_id; no workspace ids, drafts, candidates, or arbitrary
-- object keys are enumerable through this fixed SECURITY DEFINER function.

SET LOCAL lock_timeout = '5s';

CREATE FUNCTION resolve_site_preview_release(p_slug TEXT)
RETURNS TABLE (
  "artifactKey" TEXT,
  "releaseId" UUID,
  "artifactPrefix" TEXT,
  "artifactDigest" VARCHAR(64),
  manifest JSONB,
  "manifestDigest" VARCHAR(64)
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
  SELECT
    v."artifact_key" AS "artifactKey",
    r."id" AS "releaseId",
    r."artifact_prefix" AS "artifactPrefix",
    r."artifact_digest" AS "artifactDigest",
    r."manifest",
    r."manifest_digest" AS "manifestDigest"
  FROM public."site" AS s
  JOIN public."site_version" AS v
    ON s."active_version_id" = v."id"
   AND s."workspace_id" = v."workspace_id"
   AND s."id" = v."site_id"
  JOIN public."site_release" AS r
    ON r."site_version_id" = v."id"
   AND r."workspace_id" = v."workspace_id"
   AND r."site_id" = v."site_id"
  WHERE s."slug" = p_slug
    AND v."build_status" = 'succeeded'
    AND v."artifact_key" = 'release:' || r."id"::text
    AND r."status" = 'ready'
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION resolve_site_preview_release(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_site_preview_release(TEXT) TO app_user;
