-- R4-A2 Claim fact identity hardening. This forward-only migration adds the
-- canonical BrandProfile fact key to projected Claims and upgrades new human
-- approval proofs to v3 so the key is covered by the approval digest.
--
-- Rollout is deliberately fail-closed: an origin-keyed Claim without an exact
-- bridge, a Claim whose bridges disagree after normalization, or a currently
-- approved bridged Claim whose v2 proof never covered fact_key must be repaired
-- and re-reviewed before this migration can proceed.

SET LOCAL lock_timeout = '5s';
SET LOCAL row_security = off;

-- Keep the established R4-A2 reference/write order. The five-second lock gate
-- prevents a silent long blocking deployment; retry only after quiescing writers
-- or scheduling the documented maintenance window.
LOCK TABLE "brand_profile" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "brand_profile_evidence_ref" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "site_evidence_source_snapshot" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "claim" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "evidence" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "asset" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "brand_profile_claim_bridge" IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "claim"
  ADD COLUMN "fact_key" TEXT;

-- Validate the only trustworthy backfill source before changing a row. A Claim
-- may be shared across BrandProfile retries/sites, but every frozen EvidenceRef
-- must resolve to exactly one non-empty canonical fact key.
DO $$
DECLARE
  failed_claim_id UUID;
BEGIN
  SELECT c."id" INTO failed_claim_id
  FROM "claim" c
  WHERE c."origin_key" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM "brand_profile_claim_bridge" bridge
      WHERE bridge."claim_id" = c."id"
    )
  ORDER BY c."id"
  LIMIT 1;

  IF failed_claim_id IS NOT NULL THEN
    RAISE EXCEPTION
      'origin-keyed Claim is missing its exact bridge fact key: %',
      failed_claim_id;
  END IF;

  failed_claim_id := NULL;
  SELECT c."id" INTO failed_claim_id
  FROM "claim" c
  WHERE c."origin_key" IS NULL
    AND EXISTS (
      SELECT 1
      FROM "brand_profile_claim_bridge" bridge
      WHERE bridge."claim_id" = c."id"
    )
  ORDER BY c."id"
  LIMIT 1;

  IF failed_claim_id IS NOT NULL THEN
    RAISE EXCEPTION
      'bridged Claim is missing its origin identity: %',
      failed_claim_id;
  END IF;

  failed_claim_id := NULL;
  SELECT c."id" INTO failed_claim_id
  FROM "claim" c
  JOIN "brand_profile_claim_bridge" bridge
    ON bridge."claim_id" = c."id"
  JOIN "brand_profile_evidence_ref" ref
    ON ref."id" = bridge."evidence_ref_id"
   AND ref."workspace_id" = bridge."workspace_id"
   AND ref."site_id" = bridge."site_id"
   AND ref."brand_profile_id" = bridge."brand_profile_id"
  GROUP BY c."id"
  HAVING COUNT(DISTINCT normalize_brand_claim_identity(ref."fact_key")) <> 1
    OR bool_or(
      nullif(normalize_brand_claim_identity(ref."fact_key"), '') IS NULL
    )
  ORDER BY c."id"
  LIMIT 1;

  IF failed_claim_id IS NOT NULL THEN
    RAISE EXCEPTION
      'origin-keyed Claim has ambiguous normalized bridge fact keys: %',
      failed_claim_id;
  END IF;

  failed_claim_id := NULL;
  SELECT c."id" INTO failed_claim_id
  FROM "claim" c
  WHERE c."origin_key" IS NOT NULL
    AND c."status" = 'APPROVED'
    AND c."verification_proof" ->> 'proofVersion' = '2'
    AND EXISTS (
      SELECT 1
      FROM "brand_profile_claim_bridge" bridge
      WHERE bridge."claim_id" = c."id"
    )
  ORDER BY c."id"
  LIMIT 1;

  IF failed_claim_id IS NOT NULL THEN
    RAISE EXCEPTION
      'approved bridged Claim still carries a v2 proof and requires re-review: %',
      failed_claim_id;
  END IF;
END
$$;

WITH canonical_fact_key AS (
  SELECT
    c."id" AS claim_id,
    min(normalize_brand_claim_identity(ref."fact_key")) AS fact_key
  FROM "claim" c
  JOIN "brand_profile_claim_bridge" bridge
    ON bridge."claim_id" = c."id"
  JOIN "brand_profile_evidence_ref" ref
    ON ref."id" = bridge."evidence_ref_id"
   AND ref."workspace_id" = bridge."workspace_id"
   AND ref."site_id" = bridge."site_id"
   AND ref."brand_profile_id" = bridge."brand_profile_id"
  WHERE c."origin_key" IS NOT NULL
  GROUP BY c."id"
)
UPDATE "claim" c
SET "fact_key" = canonical_fact_key.fact_key
FROM canonical_fact_key
WHERE c."id" = canonical_fact_key.claim_id;

ALTER TABLE "claim"
  ADD CONSTRAINT "claim_origin_fact_key_pair_check"
    CHECK ((
      ("origin_key" IS NULL AND "fact_key" IS NULL)
      OR ("origin_key" IS NOT NULL AND "fact_key" IS NOT NULL)
    ) IS TRUE),
  ADD CONSTRAINT "claim_fact_key_canonical_check"
    CHECK ((
      "fact_key" IS NULL
      OR (
        nullif("fact_key", '') IS NOT NULL
        AND char_length("fact_key") BETWEEN 1 AND 120
        AND "fact_key" = normalize_brand_claim_identity("fact_key")
      )
    ) IS TRUE);

-- The append-only bridge must bind Claim.fact_key to the exact frozen ref, not
-- merely to another model-owned JSON field.
CREATE FUNCTION assert_brand_profile_claim_fact_key(
  p_workspace_id UUID,
  p_site_id UUID,
  p_company_profile_id UUID,
  p_brand_profile_id UUID,
  p_evidence_ref_id UUID,
  p_claim_id UUID
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  ref_row "brand_profile_evidence_ref"%ROWTYPE;
  claim_row "claim"%ROWTYPE;
BEGIN
  SELECT * INTO ref_row
  FROM "brand_profile_evidence_ref"
  WHERE "id" = p_evidence_ref_id
    AND "workspace_id" = p_workspace_id
    AND "site_id" = p_site_id
    AND "brand_profile_id" = p_brand_profile_id;

  SELECT * INTO claim_row
  FROM "claim"
  WHERE "id" = p_claim_id
    AND "workspace_id" = p_workspace_id
    AND "company_id" = p_company_profile_id;

  IF ref_row."id" IS NULL
    OR claim_row."id" IS NULL
    OR claim_row."origin_key" IS NULL
    OR claim_row."fact_key" IS DISTINCT FROM normalize_brand_claim_identity(ref_row."fact_key")
  THEN
    RAISE EXCEPTION 'claim bridge Claim fact key does not match its exact EvidenceRef';
  END IF;
END
$$;

CREATE FUNCTION validate_brand_profile_claim_fact_key()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM assert_brand_profile_claim_fact_key(
    NEW."workspace_id",
    NEW."site_id",
    NEW."company_profile_id",
    NEW."brand_profile_id",
    NEW."evidence_ref_id",
    NEW."claim_id"
  );
  RETURN NEW;
END
$$;

CREATE TRIGGER brand_profile_claim_bridge_fact_key
  BEFORE INSERT ON "brand_profile_claim_bridge"
  FOR EACH ROW EXECUTE FUNCTION validate_brand_profile_claim_fact_key();

DO $$
DECLARE
  bridge_row "brand_profile_claim_bridge"%ROWTYPE;
BEGIN
  FOR bridge_row IN SELECT * FROM "brand_profile_claim_bridge" LOOP
    PERFORM assert_brand_profile_claim_fact_key(
      bridge_row."workspace_id",
      bridge_row."site_id",
      bridge_row."company_profile_id",
      bridge_row."brand_profile_id",
      bridge_row."evidence_ref_id",
      bridge_row."claim_id"
    );
  END LOOP;
END
$$;

-- Supersede the v2 transition guard from 181 without mutating that already
-- applied migration. Legacy origin_key=NULL/fact_key=NULL v2 audit rows remain
-- untouched and readable; every new approval transition requires a v3 proof.
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
