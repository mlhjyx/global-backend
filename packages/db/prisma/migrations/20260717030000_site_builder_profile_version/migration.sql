-- Profile is an independently versioned HTTP resource. The opaque UUID is used by
-- baseVersionId / strong ETag compare-and-swap and is intentionally unrelated to
-- site.updated_at or immutable site_version rows.
ALTER TABLE "site"
ADD COLUMN "profile_version_id" UUID NOT NULL DEFAULT gen_random_uuid();
