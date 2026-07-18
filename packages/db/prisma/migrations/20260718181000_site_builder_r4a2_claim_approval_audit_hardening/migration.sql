-- R4-A2 approval audit hardening: PostgreSQL CHECK constraints accept UNKNOWN,
-- so the additive constraint's partial-audit branch could be bypassed. Keep
-- pre-migration all-null legacy terminal rows readable, but require every new
-- approval to enter through a complete NEEDS_REVIEW -> APPROVED v2 audit.

SET LOCAL lock_timeout = '5s';
SET LOCAL row_security = off;

LOCK TABLE "claim" IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "claim"
  DROP CONSTRAINT "claim_human_verification_check",
  ADD CONSTRAINT "claim_human_verification_check"
    CHECK ((
      (
        "verified_by" IS NULL
        AND "verified_at" IS NULL
        AND "verification_method" IS NULL
        AND "verification_proof" IS NULL
      )
      OR (
        "status" IN ('APPROVED', 'REVOKED', 'EXPIRED')
        AND "verified_by" IS NOT NULL
        AND nullif(btrim("verified_by"), '') IS NOT NULL
        AND "verified_at" IS NOT NULL
        AND "verification_method" IS NOT NULL
        AND "verification_method" = 'human_review'
        AND "verification_proof" IS NOT NULL
        AND jsonb_typeof("verification_proof") = 'object'
      )
    ) IS TRUE);

CREATE OR REPLACE FUNCTION reject_bridged_claim_identity_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  audit_changed BOOLEAN;
  approval_transition BOOLEAN;
BEGIN
  -- No runtime path creates an already-approved Claim. Deny new rows here so
  -- origin_key=NULL cannot masquerade as a pre-migration legacy approval.
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" = 'APPROVED' THEN
      RAISE EXCEPTION 'new Claim approval must transition from NEEDS_REVIEW';
    END IF;
    RETURN NEW;
  END IF;

  audit_changed := ROW(
    NEW."verified_by", NEW."verified_at", NEW."verification_method",
    NEW."verification_proof"
  ) IS DISTINCT FROM ROW(
    OLD."verified_by", OLD."verified_at", OLD."verification_method",
    OLD."verification_proof"
  );
  approval_transition :=
    OLD."status" = 'NEEDS_REVIEW' AND NEW."status" = 'APPROVED';

  IF EXISTS (
      SELECT 1 FROM "brand_profile_claim_bridge"
      WHERE "claim_id" = OLD."id"
    ) OR OLD."status" IN ('APPROVED', 'REVOKED', 'EXPIRED')
  THEN
    IF ROW(
      NEW."workspace_id", NEW."company_id", NEW."source_id", NEW."origin_key",
      NEW."type", NEW."statement", NEW."confidence", NEW."valid_until"
    ) IS DISTINCT FROM ROW(
      OLD."workspace_id", OLD."company_id", OLD."source_id", OLD."origin_key",
      OLD."type", OLD."statement", OLD."confidence", OLD."valid_until"
    ) THEN
      RAISE EXCEPTION 'bridged or terminal Claim identity is immutable';
    END IF;
  END IF;

  IF NEW."status" = 'APPROVED'
    AND OLD."status" IS DISTINCT FROM 'APPROVED'
  THEN
    IF (
      approval_transition
      AND NEW."version" = OLD."version" + 1
      AND OLD."verified_by" IS NULL
      AND OLD."verified_at" IS NULL
      AND OLD."verification_method" IS NULL
      AND OLD."verification_proof" IS NULL
      AND NEW."verified_by" IS NOT NULL
      AND nullif(btrim(NEW."verified_by"), '') IS NOT NULL
      AND NEW."verified_at" IS NOT NULL
      AND NEW."verification_method" IS NOT NULL
      AND NEW."verification_method" = 'human_review'
      AND NEW."verification_proof" IS NOT NULL
      AND jsonb_typeof(NEW."verification_proof") = 'object'
      AND jsonb_typeof(NEW."verification_proof" -> 'action') = 'string'
      AND NEW."verification_proof" ->> 'action' = 'claim_approval'
      AND jsonb_typeof(NEW."verification_proof" -> 'proofVersion') = 'number'
      AND NEW."verification_proof" -> 'proofVersion' = '2'::jsonb
      AND jsonb_typeof(NEW."verification_proof" -> 'approvedVersion') = 'number'
      AND NEW."verification_proof" -> 'approvedVersion' = to_jsonb(NEW."version")
      AND jsonb_typeof(NEW."verification_proof" -> 'claimDigest') = 'string'
      AND NEW."verification_proof" ->> 'claimDigest' ~ '^[0-9a-f]{64}$'
    ) IS NOT TRUE THEN
      RAISE EXCEPTION 'Claim approval requires a complete v2 human verification proof';
    END IF;
  END IF;

  IF audit_changed AND NOT approval_transition THEN
    RAISE EXCEPTION 'Claim approval audit is immutable after initial approval';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS claim_approval_insert_guard ON "claim";
CREATE TRIGGER claim_approval_insert_guard
  BEFORE INSERT ON "claim"
  FOR EACH ROW EXECUTE FUNCTION reject_bridged_claim_identity_update();
