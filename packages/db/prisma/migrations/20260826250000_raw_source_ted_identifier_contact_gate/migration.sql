-- Close TED national identifier contact-shaped plaintext at the Raw writer.
-- 1500/2200 are controller-authorized pre-release reissues; 2100/2300/2400
-- remain frozen. This forward migration is DDL/ACL-only and has never been
-- applied to retained data. Retained inventory/deployment remain HOLD.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

CREATE FUNCTION raw_source_ted_national_identifier_contact_valid_v1(
  p_value TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT normalize(p_value,NFKC)=p_value
    AND octet_length(p_value) BETWEEN 1 AND 80
    AND p_value ~ '^[[:alnum:]][[:alnum:] ._:/-]{0,79}$'
    AND public.raw_source_text_contact_safe_v2(p_value)
$$;

CREATE OR REPLACE FUNCTION raw_source_identifier_valid_v2(
  p_provider_key TEXT,
  p_identifier JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  identifier_scheme TEXT;
  identifier_value TEXT;
BEGIN
  IF p_identifier IS NULL THEN RETURN true; END IF;
  IF NOT public.raw_source_json_keys_within_v2(
    p_identifier, ARRAY['scheme','value'], ARRAY['scheme','value']
  ) THEN RETURN false; END IF;
  identifier_scheme := p_identifier->>'scheme';
  identifier_value := p_identifier->>'value';
  IF NOT public.raw_source_text_secret_safe_v2(identifier_value)
    OR octet_length(identifier_value) > 128
  THEN RETURN false; END IF;
  CASE p_provider_key
    WHEN 'registry' THEN
      RETURN (identifier_scheme = 'registry-id'
          AND identifier_value ~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$'
          AND public.raw_source_text_contact_safe_v2(identifier_value))
        OR (identifier_scheme = 'lei'
          AND identifier_value ~ '^[A-Z0-9]{20}$');
    WHEN 'ted' THEN
      RETURN identifier_scheme ~ '^ted-natid(?::[a-z]{2})?$'
        AND public.raw_source_ted_national_identifier_contact_valid_v1(
          identifier_value
        );
    WHEN 'openfda' THEN
      RETURN identifier_scheme = 'fda-reg'
        AND identifier_value ~ '^[0-9]{1,32}$';
    ELSE RETURN false;
  END CASE;
END
$$;

-- Preserve the current provider-company wrapper installed by 1600 while
-- applying the TED contact gate before its frozen validation chain.
CREATE OR REPLACE FUNCTION raw_source_provider_payload_valid_v2(
  p_provider_key TEXT,
  p_payload JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  company_name TEXT;
  validation_payload JSONB;
  ted_attributes JSONB;
BEGIN
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_payload->'name') IS DISTINCT FROM 'string'
  THEN RETURN false; END IF;
  company_name := p_payload->>'name';
  IF NOT public.raw_source_provider_company_name_valid_v2(company_name)
  THEN RETURN false; END IF;

  IF p_provider_key='ted' THEN
    ted_attributes := p_payload #> '{attributes,ted}';
    IF ted_attributes ? 'winner_identifier' AND (
      jsonb_typeof(ted_attributes->'winner_identifier') IS DISTINCT FROM
        'string'
      OR NOT public.raw_source_ted_national_identifier_contact_valid_v1(
        ted_attributes->>'winner_identifier'
      )
    ) THEN RETURN false; END IF;
    IF p_payload ? 'identifier'
      AND NOT public.raw_source_identifier_valid_v2(
        'ted',p_payload->'identifier'
      )
    THEN RETURN false; END IF;
  END IF;

  validation_payload := jsonb_set(
    p_payload,'{name}',to_jsonb('Provider Company'::TEXT),false
  );
  RETURN public.raw_source_provider_payload_valid_v2_status_hardening(
    p_provider_key,validation_payload
  );
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$$;

REVOKE ALL ON FUNCTION raw_source_ted_national_identifier_contact_valid_v1(TEXT)
  FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_identifier_valid_v2(TEXT,JSONB)
  FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_provider_payload_valid_v2(TEXT,JSONB)
  FROM PUBLIC, app_user;

COMMIT;
