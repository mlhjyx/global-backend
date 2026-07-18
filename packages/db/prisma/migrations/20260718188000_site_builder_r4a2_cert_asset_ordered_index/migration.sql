-- The scanner filters by certification Asset + Site and then requests the
-- first 100 diagnostics in BrandProfile/fact order. INCLUDE covers reads but
-- cannot satisfy that ORDER BY, so PostgreSQL preferred a whole-table ordered
-- index. Put all four fields in key order while keeping the NULL population out.

SET LOCAL lock_timeout = '5s';

DROP INDEX "brand_profile_claim_bridge_cert_asset_lookup_idx";

CREATE INDEX "brand_profile_claim_bridge_cert_asset_lookup_idx"
  ON "brand_profile_claim_bridge" (
    "cert_asset_id",
    "site_id",
    "brand_profile_id",
    "fact_index"
  )
  WHERE "cert_asset_id" IS NOT NULL;
