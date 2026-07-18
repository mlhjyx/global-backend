-- Close the fact-key identity split across model schema, application hashing,
-- frozen EvidenceRef rows, and Claim rows. Existing non-canonical data is not
-- rewritten: deployment stops so the affected fact can be reviewed explicitly.

SET LOCAL lock_timeout = '5s';
SET LOCAL row_security = off;

LOCK TABLE "brand_profile_evidence_ref" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "claim" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "brand_profile_claim_bridge" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  invalid_ref_id UUID;
  invalid_claim_id UUID;
BEGIN
  SELECT "id" INTO invalid_ref_id
  FROM "brand_profile_evidence_ref"
  WHERE "fact_key" !~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
    OR char_length("fact_key") NOT BETWEEN 1 AND 120
  ORDER BY "id"
  LIMIT 1;

  IF invalid_ref_id IS NOT NULL THEN
    RAISE EXCEPTION
      'non-canonical BrandProfile EvidenceRef fact_key requires review: %',
      invalid_ref_id;
  END IF;

  SELECT "id" INTO invalid_claim_id
  FROM "claim"
  WHERE "fact_key" IS NOT NULL
    AND (
      "fact_key" !~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
      OR char_length("fact_key") NOT BETWEEN 1 AND 120
    )
  ORDER BY "id"
  LIMIT 1;

  IF invalid_claim_id IS NOT NULL THEN
    RAISE EXCEPTION
      'non-canonical Claim fact_key requires review: %',
      invalid_claim_id;
  END IF;
END
$$;

ALTER TABLE "brand_profile_evidence_ref"
  ADD CONSTRAINT "brand_profile_evidence_ref_fact_key_canonical_check"
    CHECK (
      char_length("fact_key") BETWEEN 1 AND 120
      AND "fact_key" ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
    );

ALTER TABLE "claim"
  DROP CONSTRAINT "claim_fact_key_canonical_check",
  ADD CONSTRAINT "claim_fact_key_canonical_check"
    CHECK ((
      "fact_key" IS NULL
      OR (
        char_length("fact_key") BETWEEN 1 AND 120
        AND "fact_key" ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
      )
    ) IS TRUE);
