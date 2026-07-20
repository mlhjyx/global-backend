SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

CREATE TABLE "site_release" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "site_id" UUID NOT NULL,
  "site_version_id" UUID NOT NULL,
  "build_run_id" UUID NOT NULL,
  "release_number" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'candidate',
  "artifact_prefix" TEXT NOT NULL,
  "artifact_digest" VARCHAR(64),
  "manifest" JSONB,
  "manifest_digest" VARCHAR(64),
  "producer_token" UUID NOT NULL,
  "lease_until" TIMESTAMP(3) NOT NULL,
  "gc_token" UUID,
  "gc_lease_until" TIMESTAMP(3),
  "created_by" TEXT,
  "ready_at" TIMESTAMP(3),
  "last_activated_at" TIMESTAMP(3),
  "deleted_at" TIMESTAMP(3),
  "error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "site_release_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "site_release_site_version_key" UNIQUE ("site_version_id"),
  CONSTRAINT "site_release_build_run_key" UNIQUE ("build_run_id"),
  CONSTRAINT "site_release_artifact_prefix_key" UNIQUE ("artifact_prefix"),
  CONSTRAINT "site_release_site_number_key" UNIQUE ("site_id", "release_number"),
  CONSTRAINT "site_release_id_workspace_site_key" UNIQUE ("id", "workspace_id", "site_id"),
  CONSTRAINT "site_release_version_scope_key" UNIQUE ("site_version_id", "workspace_id", "site_id"),
  CONSTRAINT "site_release_run_scope_key" UNIQUE ("build_run_id", "workspace_id", "site_id"),
  CONSTRAINT "site_release_number_check" CHECK ("release_number" > 0),
  CONSTRAINT "site_release_status_check"
    CHECK ("status" IN ('candidate', 'ready', 'failed', 'deleting', 'deleted')),
  CONSTRAINT "site_release_artifact_prefix_check"
    CHECK (
      "artifact_prefix" =
        'sites/' || "site_id"::text || '/releases/' || "id"::text
    ),
  CONSTRAINT "site_release_artifact_digest_check"
    CHECK ("artifact_digest" IS NULL OR "artifact_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "site_release_manifest_digest_check"
    CHECK ("manifest_digest" IS NULL OR "manifest_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "site_release_ready_payload_check"
    CHECK (
      "status" IN ('ready', 'deleting', 'deleted')
      AND (
        "manifest" IS NOT NULL
        AND "artifact_digest" IS NOT NULL
        AND "manifest_digest" IS NOT NULL
        AND "ready_at" IS NOT NULL
      )
      OR "status" IN ('candidate', 'failed')
    ),
  CONSTRAINT "site_release_manifest_envelope_check"
    CHECK (
      "manifest" IS NULL
      OR (
        "manifest"->>'schemaVersion' = 'site-builder-release-manifest/v1'
        AND "manifest"->>'releaseId' = "id"::text
        AND "manifest"->>'siteId' = "site_id"::text
        AND "manifest"->>'siteVersionId' = "site_version_id"::text
        AND "manifest"->>'buildRunId' = "build_run_id"::text
        AND "manifest"->>'artifactPrefix' = "artifact_prefix"
        AND "manifest"->>'artifactDigest' = "artifact_digest"
        AND jsonb_typeof("manifest"->'files') = 'array'
      )
    ),
  CONSTRAINT "site_release_gc_claim_check"
    CHECK (
      ("status" = 'deleting' AND "gc_token" IS NOT NULL AND "gc_lease_until" IS NOT NULL)
      OR ("status" <> 'deleting')
    ),
  CONSTRAINT "site_release_deleted_check"
    CHECK (("status" = 'deleted') = ("deleted_at" IS NOT NULL))
);

CREATE INDEX "site_release_workspace_site_status_created_idx"
  ON "site_release"("workspace_id", "site_id", "status", "created_at");
CREATE INDEX "site_release_status_lease_idx"
  ON "site_release"("status", "lease_until");
CREATE INDEX "site_release_status_gc_lease_idx"
  ON "site_release"("status", "gc_lease_until");

ALTER TABLE "site_release"
  ADD CONSTRAINT "site_release_site_scope_fkey"
  FOREIGN KEY ("site_id", "workspace_id")
  REFERENCES "site"("id", "workspace_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "site_release_version_scope_fkey"
  FOREIGN KEY ("site_version_id", "workspace_id", "site_id")
  REFERENCES "site_version"("id", "workspace_id", "site_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "site_release_run_scope_fkey"
  FOREIGN KEY ("build_run_id", "workspace_id", "site_id")
  REFERENCES "site_build_run"("id", "workspace_id", "site_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "site"
  ADD CONSTRAINT "site_active_version_scope_fkey"
  FOREIGN KEY ("active_version_id", "workspace_id", "id")
  REFERENCES "site_version"("id", "workspace_id", "site_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION
  NOT VALID;

ALTER TABLE "site" VALIDATE CONSTRAINT "site_active_version_scope_fkey";

CREATE FUNCTION enforce_site_release_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
    OR NEW."site_id" IS DISTINCT FROM OLD."site_id"
    OR NEW."site_version_id" IS DISTINCT FROM OLD."site_version_id"
    OR NEW."build_run_id" IS DISTINCT FROM OLD."build_run_id"
    OR NEW."release_number" IS DISTINCT FROM OLD."release_number"
    OR NEW."artifact_prefix" IS DISTINCT FROM OLD."artifact_prefix"
    OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'SiteRelease identity is immutable';
  END IF;

  IF OLD."status" = 'candidate' AND NEW."status" NOT IN ('candidate', 'ready', 'failed')
    OR OLD."status" = 'ready' AND NEW."status" NOT IN ('ready', 'deleting')
    OR OLD."status" = 'failed' AND NEW."status" NOT IN ('failed', 'deleting')
    OR OLD."status" = 'deleting' AND NEW."status" NOT IN ('deleting', 'deleted')
    OR OLD."status" = 'deleted' AND NEW."status" <> 'deleted'
  THEN
    RAISE EXCEPTION 'invalid SiteRelease status transition: % -> %', OLD."status", NEW."status";
  END IF;

  IF OLD."status" IN ('ready', 'deleting', 'deleted')
    AND (
      NEW."artifact_digest" IS DISTINCT FROM OLD."artifact_digest"
      OR NEW."manifest" IS DISTINCT FROM OLD."manifest"
      OR NEW."manifest_digest" IS DISTINCT FROM OLD."manifest_digest"
      OR NEW."producer_token" IS DISTINCT FROM OLD."producer_token"
      OR NEW."lease_until" IS DISTINCT FROM OLD."lease_until"
      OR NEW."ready_at" IS DISTINCT FROM OLD."ready_at"
    )
  THEN
    RAISE EXCEPTION 'READY SiteRelease payload is immutable';
  END IF;

  IF NEW."status" = 'deleting' AND OLD."status" <> 'deleting' THEN
    PERFORM pg_advisory_xact_lock(hashtext('site-release-pointer-' || OLD."site_id"::text));
    IF EXISTS (
      SELECT 1
      FROM "site"
      WHERE "id" = OLD."site_id"
        AND "workspace_id" = OLD."workspace_id"
        AND "active_version_id" = OLD."site_version_id"
    ) THEN
      RAISE EXCEPTION 'active SiteRelease cannot enter deleting';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER site_release_ready_payload_immutable
  BEFORE UPDATE ON "site_release"
  FOR EACH ROW EXECUTE FUNCTION enforce_site_release_update();

CREATE FUNCTION enforce_site_active_version_ready_release()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."active_version_id" IS NULL
    OR NEW."active_version_id" IS NOT DISTINCT FROM OLD."active_version_id"
  THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('site-release-pointer-' || NEW."id"::text));
  IF NOT EXISTS (
    SELECT 1
    FROM "site_release"
    WHERE "workspace_id" = NEW."workspace_id"
      AND "site_id" = NEW."id"
      AND "site_version_id" = NEW."active_version_id"
      AND "status" = 'ready'
  ) THEN
    RAISE EXCEPTION 'active SiteVersion requires a READY SiteRelease';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER site_active_version_requires_ready_release
  BEFORE UPDATE OF "active_version_id" ON "site"
  FOR EACH ROW EXECUTE FUNCTION enforce_site_active_version_ready_release();

ALTER TABLE "site_release" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_release" FORCE ROW LEVEL SECURITY;
CREATE POLICY "site_release_tenant_isolation"
  ON "site_release"
  USING ("workspace_id" = current_workspace_id())
  WITH CHECK ("workspace_id" = current_workspace_id());

REVOKE ALL ON TABLE "site_release" FROM PUBLIC;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "site_release" FROM app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE "site_release" TO app_user;
