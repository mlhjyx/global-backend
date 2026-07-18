-- R4-A2 database-side semantic guard. The frozen claimType prevents historical
-- reinterpretation; this versioned classifier prevents an app-role INSERT from
-- initially forging a certification fact as a non-certification Claim.
-- TypeScript/PostgreSQL parity is exercised against the real database verifier.

SET LOCAL lock_timeout = '5s';
SET LOCAL row_security = off;

LOCK TABLE "brand_profile" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "brand_profile_claim_bridge" IN SHARE ROW EXCLUSIVE MODE;

CREATE FUNCTION claim_type_for_brand_fact_v1(fact_key TEXT, fact_value TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  normalized TEXT := lower(
    normalize_brand_claim_identity(fact_key || ' ' || fact_value)
  );
BEGIN
  IF normalized ~ '(certif|certificate|accredit|认证|证书|资质)'
    OR normalized ~
      '(^|[^a-z0-9])(iso|iec|en|din|iatf|as|api|astm|gb|ul)[[:space:]]*[-:/]?[[:space:]]*[0-9][0-9.-]*([^a-z0-9]|$)'
    OR normalized ~
      '(^|[^a-z0-9])(ce|fda|ul|rohs|reach|gmp|tüv)([^a-z0-9]|$)'
  THEN
    RETURN 'certification';
  ELSIF normalized ~ '(case|customer|client|project|案例|客户|项目)' THEN
    RETURN 'case';
  ELSIF normalized ~
    '(pressure|capacity|frequency|voltage|power|speed|temperature|dimension|weight|性能|参数|压力|产能|频率|电压|功率|转速|温度|尺寸|重量)'
    OR normalized ~
      '[0-9]+([.,][0-9]+)?[[:space:]]*(%|‰|℃|℉|°[[:space:]]*[cf]|bar|mbar|pa|kpa|mpa|psi|hz|khz|mhz|ghz|rpm|v|mv|kv|a|ma|w|kw|mw|wh|kwh|mah|nm|um|μm|mm|cm|m|km|in|ft|mg|g|kg|lb|oz|ml|l|m[23²³]|l[[:space:]]*[/⁄][[:space:]]*min|n[[:space:]]*[.·][[:space:]]*m)([^[:alnum:]]|$)'
  THEN
    RETURN 'param';
  ELSIF normalized ~ '(value[_[:space:]-]?prop|价值主张)' THEN
    RETURN 'value_prop';
  END IF;
  RETURN 'capability';
END
$$;

CREATE FUNCTION assert_brand_profile_frozen_claim_type(
  p_workspace_id UUID,
  p_site_id UUID,
  p_brand_profile_id UUID,
  p_fact_index INTEGER
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  fact_row JSONB;
  semantic_type TEXT;
BEGIN
  SELECT "fact_sheet" -> p_fact_index INTO fact_row
  FROM "brand_profile"
  WHERE "id" = p_brand_profile_id
    AND "workspace_id" = p_workspace_id
    AND "site_id" = p_site_id;

  IF jsonb_typeof(fact_row) IS DISTINCT FROM 'object'
    OR jsonb_typeof(fact_row -> 'key') IS DISTINCT FROM 'string'
    OR jsonb_typeof(fact_row -> 'value') IS DISTINCT FROM 'string'
    OR jsonb_typeof(fact_row -> 'claimType') IS DISTINCT FROM 'string'
  THEN
    RAISE EXCEPTION 'frozen Claim classification identity is incomplete';
  END IF;

  semantic_type := claim_type_for_brand_fact_v1(
    fact_row ->> 'key',
    fact_row ->> 'value'
  );
  IF fact_row ->> 'claimType' IS DISTINCT FROM semantic_type THEN
    RAISE EXCEPTION 'frozen Claim classification does not match fact semantics';
  END IF;
END
$$;

CREATE FUNCTION validate_brand_profile_frozen_claim_type()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM assert_brand_profile_frozen_claim_type(
    NEW."workspace_id",
    NEW."site_id",
    NEW."brand_profile_id",
    NEW."fact_index"
  );
  RETURN NEW;
END
$$;

CREATE TRIGGER brand_profile_claim_bridge_frozen_claim_type
  BEFORE INSERT ON "brand_profile_claim_bridge"
  FOR EACH ROW EXECUTE FUNCTION validate_brand_profile_frozen_claim_type();

-- Validate all committed edges while INSERT is excluded by the table lock.
DO $$
DECLARE
  bridge_row "brand_profile_claim_bridge"%ROWTYPE;
BEGIN
  FOR bridge_row IN SELECT * FROM "brand_profile_claim_bridge" LOOP
    PERFORM assert_brand_profile_frozen_claim_type(
      bridge_row."workspace_id",
      bridge_row."site_id",
      bridge_row."brand_profile_id",
      bridge_row."fact_index"
    );
  END LOOP;
END
$$;
