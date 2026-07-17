-- Forward-only R4-A1 hardening: a v2 fact and its relational EvidenceRef must
-- remain an immutable graph. BrandProfile versions are appended, never updated.
-- Owner-level deletion through the Site retention cascade remains available.
SET LOCAL lock_timeout = '5s';

LOCK TABLE "brand_profile" IN SHARE ROW EXCLUSIVE MODE;

REVOKE ALL ON TABLE "brand_profile" FROM PUBLIC;
REVOKE UPDATE, DELETE ON TABLE "brand_profile" FROM app_user;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE "brand_profile" FROM app_user;
GRANT SELECT, INSERT ON TABLE "brand_profile" TO app_user;

CREATE FUNCTION reject_brand_profile_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'BrandProfile versions are immutable after insert';
END
$$;

CREATE TRIGGER brand_profile_append_only
  BEFORE UPDATE ON "brand_profile"
  FOR EACH ROW EXECUTE FUNCTION reject_brand_profile_update();
