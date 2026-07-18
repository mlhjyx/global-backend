-- The immutable bridge intentionally grants app_user SELECT+INSERT only, while
-- PostgreSQL row locks require UPDATE privilege. Keep that least-privilege
-- boundary: the fixed trigger function (no dynamic SQL, NEW/OLD ids only)
-- acquires the bridge row lock with owner rights and a pinned search path.

SET LOCAL lock_timeout = '5s';

ALTER FUNCTION reject_bridged_claim_identity_update()
  SECURITY DEFINER;

ALTER FUNCTION reject_bridged_claim_identity_update()
  SET search_path TO pg_catalog, public;
