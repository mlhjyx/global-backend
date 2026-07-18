-- An origin-keyed Claim is publishable only while at least one exact immutable
-- BrandProfile bridge still exists. Lock that bridge during the approval
-- transition so a concurrent Site cascade cannot invalidate the proof between
-- validation and the ClaimApproved write. Manual/legacy Claims retain the
-- origin_key=NULL/fact_key=NULL approval path.

SET LOCAL lock_timeout = '5s';
SET LOCAL row_security = off;

LOCK TABLE "brand_profile_evidence_ref" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "brand_profile_claim_bridge" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "claim" IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION reject_bridged_claim_identity_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  audit_changed BOOLEAN;
  approval_transition BOOLEAN;
BEGIN
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
      NEW."fact_key", NEW."type", NEW."statement", NEW."confidence", NEW."valid_until"
    ) IS DISTINCT FROM ROW(
      OLD."workspace_id", OLD."company_id", OLD."source_id", OLD."origin_key",
      OLD."fact_key", OLD."type", OLD."statement", OLD."confidence", OLD."valid_until"
    ) THEN
      RAISE EXCEPTION 'bridged or terminal Claim identity is immutable';
    END IF;
  END IF;

  IF NEW."status" = 'APPROVED'
    AND OLD."status" IS DISTINCT FROM 'APPROVED'
  THEN
    IF NEW."origin_key" IS NULL AND NEW."fact_key" IS NULL THEN
      NULL; -- Manual and historical Claim boundary.
    ELSIF NEW."origin_key" IS NOT NULL AND NEW."fact_key" IS NOT NULL THEN
      PERFORM 1
      FROM "brand_profile_claim_bridge" bridge
      JOIN "brand_profile_evidence_ref" ref
        ON ref."id" = bridge."evidence_ref_id"
       AND ref."workspace_id" = bridge."workspace_id"
       AND ref."site_id" = bridge."site_id"
       AND ref."brand_profile_id" = bridge."brand_profile_id"
      WHERE bridge."claim_id" = NEW."id"
        AND bridge."workspace_id" = NEW."workspace_id"
        AND bridge."company_profile_id" = NEW."company_id"
        AND ref."fact_key" = NEW."fact_key"
      LIMIT 1
      FOR SHARE OF bridge;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'origin-keyed Claim approval requires a surviving exact bridge';
      END IF;
    ELSE
      RAISE EXCEPTION 'origin-keyed Claim approval requires a surviving exact bridge';
    END IF;

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
      AND NEW."verification_proof" -> 'proofVersion' = '3'::jsonb
      AND jsonb_typeof(NEW."verification_proof" -> 'approvedVersion') = 'number'
      AND NEW."verification_proof" -> 'approvedVersion' = to_jsonb(NEW."version")
      AND jsonb_typeof(NEW."verification_proof" -> 'claimDigest') = 'string'
      AND NEW."verification_proof" ->> 'claimDigest' ~ '^[0-9a-f]{64}$'
    ) IS NOT TRUE THEN
      RAISE EXCEPTION 'Claim approval requires a complete v3 human verification proof';
    END IF;
  END IF;

  IF audit_changed AND NOT approval_transition THEN
    RAISE EXCEPTION 'Claim approval audit is immutable after initial approval';
  END IF;

  RETURN NEW;
END
$$;
