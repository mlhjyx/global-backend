-- Forward-only compatibility for the role metadata already emitted by the TED mapper.
-- Keep every original payload, receipt, operation, name/identifier guard and private ACL.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.raw_source_provider_payload_valid_v2(
  p_provider_key TEXT,
  p_payload JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  company_name TEXT;
  validation_payload JSONB;
  ted_attributes JSONB;
  relation JSONB;
  relation_identifier TEXT;
BEGIN
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_payload->'name') IS DISTINCT FROM 'string'
  THEN RETURN false; END IF;
  company_name := p_payload->>'name';
  IF NOT public.raw_source_provider_company_name_valid_v2(company_name)
  THEN RETURN false; END IF;

  IF p_provider_key='ted' THEN
    -- Validate the full input before removing new fields from the legacy-only copy.
    IF public.raw_source_json_shape_valid_v2(p_payload,6,256) IS NOT TRUE
    THEN RETURN false; END IF;
    ted_attributes := p_payload #> '{attributes,ted}';
    IF ted_attributes ? 'winner_identifier' AND (
      jsonb_typeof(ted_attributes->'winner_identifier') IS DISTINCT FROM 'string'
      OR NOT public.raw_source_ted_national_identifier_contact_valid_v1(
        ted_attributes->>'winner_identifier'
      )
    ) THEN RETURN false; END IF;
    IF p_payload ? 'identifier'
      AND NOT public.raw_source_identifier_valid_v2('ted',p_payload->'identifier')
    THEN RETURN false; END IF;

    IF ted_attributes ? 'self_role' AND (
      jsonb_typeof(ted_attributes->'self_role') IS DISTINCT FROM 'string'
      OR ted_attributes->>'self_role' NOT IN ('buyer','winner')
    ) THEN RETURN false; END IF;
    IF ted_attributes ? 'relationships' THEN
      IF jsonb_typeof(ted_attributes->'relationships') IS DISTINCT FROM 'array'
      THEN RETURN false; END IF;
      -- withoutUndefined() applies the existing 20-item bound before TS validation.
      IF jsonb_array_length(ted_attributes->'relationships') NOT BETWEEN 1 AND 20
      THEN RETURN false; END IF;
      FOR relation IN SELECT value FROM jsonb_array_elements(ted_attributes->'relationships') LOOP
        -- Raw minimization deliberately removes names and contact fields.
        IF public.raw_source_json_keys_within_v2(relation,
          ARRAY['role','country','identifier'],ARRAY['role']) IS NOT TRUE
          OR jsonb_typeof(relation->'role') IS DISTINCT FROM 'string'
          OR relation->>'role' NOT IN ('buyer','winner')
        THEN RETURN false; END IF;
        IF relation ? 'country' AND (
          jsonb_typeof(relation->'country') IS DISTINCT FROM 'string'
          OR relation->>'country' !~ '^[A-Z]{2}$'
        ) THEN RETURN false; END IF;
        IF relation ? 'identifier' THEN
          IF jsonb_typeof(relation->'identifier') IS DISTINCT FROM 'string'
          THEN RETURN false; END IF;
          relation_identifier := relation->>'identifier';
          IF normalize(relation_identifier,NFKC) IS DISTINCT FROM relation_identifier
            OR octet_length(relation_identifier) NOT BETWEEN 1 AND 80
            OR relation_identifier !~ '^[[:alnum:]][[:alnum:] ._:/-]*$'
            OR public.raw_source_text_secret_safe_v2(relation_identifier) IS NOT TRUE
            OR public.raw_source_text_contact_safe_v2(relation_identifier) IS NOT TRUE
          THEN RETURN false; END IF;
        END IF;
      END LOOP;
    END IF;
  END IF;

  validation_payload := jsonb_set(
    p_payload,'{name}',to_jsonb('Provider Company'::TEXT),false
  );
  IF p_provider_key='ted' THEN
    validation_payload := (validation_payload #- '{attributes,ted,self_role}')
      #- '{attributes,ted,relationships}';
  END IF;
  RETURN public.raw_source_provider_payload_valid_v2_status_hardening(
    p_provider_key,validation_payload
  );
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$$;

REVOKE ALL ON FUNCTION public.raw_source_provider_payload_valid_v2(TEXT,JSONB)
  FROM PUBLIC, app_user;
COMMIT;
