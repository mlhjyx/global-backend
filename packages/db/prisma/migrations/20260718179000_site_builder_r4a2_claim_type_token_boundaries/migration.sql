-- Keep the frozen PostgreSQL classifier aligned with the runtime classifier.
-- Case/customer/project prose in an otherwise public capability is not itself
-- a customer-case category; only the producer's fact key may select that type.

SET LOCAL lock_timeout = '5s';
SET LOCAL row_security = off;

CREATE OR REPLACE FUNCTION claim_type_for_brand_fact_v1(fact_key TEXT, fact_value TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  normalized_key TEXT := lower(normalize_brand_claim_identity(fact_key));
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
  ELSIF normalized_key ~
    '(^|[^a-z0-9])(case|customer|client|project)([^a-z0-9]|$)|案例|客户|项目'
  THEN
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
