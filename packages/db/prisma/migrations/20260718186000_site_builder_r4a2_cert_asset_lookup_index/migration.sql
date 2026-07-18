-- Asset DELETE checks immutable certification bridges while holding the Asset
-- row lock. Keep that bounded lookup off a full append-only bridge-table scan;
-- non-certification bridges carry NULL and do not belong in this index.

SET LOCAL lock_timeout = '5s';

CREATE INDEX "brand_profile_claim_bridge_cert_asset_lookup_idx"
  ON "brand_profile_claim_bridge" ("cert_asset_id", "site_id")
  INCLUDE ("brand_profile_id", "fact_index")
  WHERE "cert_asset_id" IS NOT NULL;
