-- Forward-only hardening: the schema owner's default privileges may grant CRUD
-- before the table-specific GRANT runs. Remove every mutable privilege explicitly.
SET LOCAL lock_timeout = '5s';

REVOKE UPDATE, DELETE ON TABLE "site_evidence_source_snapshot" FROM app_user;
REVOKE UPDATE, DELETE ON TABLE "brand_profile_evidence_ref" FROM app_user;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE "site_evidence_source_snapshot" FROM app_user;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE "brand_profile_evidence_ref" FROM app_user;

GRANT SELECT, INSERT ON TABLE "site_evidence_source_snapshot" TO app_user;
GRANT SELECT, INSERT ON TABLE "brand_profile_evidence_ref" TO app_user;
