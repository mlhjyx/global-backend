-- Close dynamic sitemap section keys before Canonical/FieldEvidence storage.
-- 0900-2200 are checksum-frozen. This migration is DDL/ACL only; historical
-- product-row correction is isolated in 2400.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

CREATE FUNCTION raw_source_site_section_key_valid_v1(p_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT normalize(p_key,NFKC)=p_key
    AND octet_length(p_key) BETWEEN 1 AND 24
    AND public.raw_source_text_contact_safe_v2(p_key)
    AND p_key = ANY (ARRAY[
      '.well-known','about','blog','careers','company','docs','downloads',
      'events','industries','insights','jobs','news','partners','press',
      'products','publications','resources','services','solutions','support',
      'sustainability','technology'
    ]::TEXT[])
$$;

CREATE FUNCTION raw_source_sanitize_site_sections_v1(p_value JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  sanitized JSONB;
BEGIN
  IF jsonb_typeof(p_value)<>'object'
    OR (SELECT count(*) FROM jsonb_object_keys(p_value)) NOT BETWEEN 1 AND 20
  THEN RETURN NULL; END IF;

  SELECT jsonb_object_agg(entry.key,entry.value ORDER BY entry.key)
  INTO sanitized
  FROM jsonb_each(p_value) AS entry
  WHERE public.raw_source_site_section_key_valid_v1(entry.key)
    AND jsonb_typeof(entry.value)='number'
    AND (entry.value #>> '{}')::NUMERIC BETWEEN 1 AND 5000
    AND trunc((entry.value #>> '{}')::NUMERIC)=(entry.value #>> '{}')::NUMERIC;
  RETURN sanitized;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION raw_source_sanitize_stored_company_field_evidence_v1(
  p_field TEXT,
  p_value JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  path_parts TEXT[];
  wrapped JSONB := p_value;
  sanitized JSONB;
  part TEXT;
  item_index INTEGER;
BEGIN
  IF p_field='attributes' THEN
    sanitized := public.sanitize_canonical_company_attributes_v3(p_value);
    RETURN CASE WHEN sanitized='{}'::jsonb THEN NULL ELSE sanitized END;
  ELSIF p_field='name' THEN
    IF jsonb_typeof(p_value)='string'
      AND public.raw_source_provider_company_name_valid_v2(p_value #>> '{}')
    THEN RETURN p_value; END IF;
    RETURN NULL;
  ELSIF p_field='domain' THEN
    IF jsonb_typeof(p_value)='string'
      AND normalize(p_value #>> '{}',NFKC)=p_value #>> '{}'
      AND lower(p_value #>> '{}')=p_value #>> '{}'
      AND octet_length(p_value #>> '{}') <= 253
      AND p_value #>> '{}' ~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
      AND public.raw_source_text_contact_safe_v2(p_value #>> '{}')
    THEN RETURN p_value; END IF;
    RETURN NULL;
  ELSIF p_field IN ('country','industry','region') THEN
    IF jsonb_typeof(p_value)='string'
      AND normalize(p_value #>> '{}',NFKC)=p_value #>> '{}'
      AND octet_length(p_value #>> '{}') <= 160
      AND public.raw_source_text_contact_safe_v2(p_value #>> '{}')
    THEN RETURN p_value; END IF;
    RETURN NULL;
  ELSIF p_field='employee_count' THEN
    IF jsonb_typeof(p_value)='number'
      AND (p_value #>> '{}')::NUMERIC BETWEEN 0 AND 2147483647
      AND trunc((p_value #>> '{}')::NUMERIC)=(p_value #>> '{}')::NUMERIC
    THEN RETURN p_value; END IF;
    RETURN NULL;
  ELSIF p_field='revenue_usd' THEN
    IF jsonb_typeof(p_value)='number'
      AND (p_value #>> '{}')::NUMERIC BETWEEN 0 AND 1000000000000000
    THEN RETURN p_value; END IF;
    RETURN NULL;
  ELSIF p_field='identity' THEN
    RETURN public.raw_source_sanitize_stored_identity_v1(p_value);
  ELSIF p_field IN (
    'intent.tender','intent.sources_sought','intent.website_change'
  ) THEN
    RETURN public.sanitize_canonical_company_attributes_v3(
      jsonb_build_object('intent',p_value)
    )->'intent';
  ELSIF p_field='intent.clearance' THEN
    RETURN public.sanitize_canonical_company_attributes_v3(
      jsonb_build_object('intent',jsonb_build_object(
        'events',jsonb_build_array(p_value)
      ))
    ) #> '{intent,events,0}';
  ELSIF p_field='structured_harvest.site_sections' THEN
    RETURN public.raw_source_sanitize_site_sections_v1(p_value);
  END IF;

  path_parts := public.raw_source_stored_field_attribute_path_v1(p_field);
  IF path_parts IS NULL THEN RETURN NULL; END IF;
  FOR item_index IN REVERSE array_upper(path_parts,1)..array_lower(path_parts,1)
  LOOP
    wrapped := jsonb_build_object(path_parts[item_index],wrapped);
  END LOOP;
  sanitized := public.sanitize_canonical_company_attributes_v3(wrapped);
  FOREACH part IN ARRAY path_parts LOOP
    sanitized := sanitized->part;
    IF sanitized IS NULL THEN RETURN NULL; END IF;
  END LOOP;
  RETURN sanitized;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END
$$;

CREATE FUNCTION raw_source_linked_site_sections_candidate_v1(
  p_provider_key TEXT,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN p_provider_key='structured_harvest'
      AND jsonb_typeof(p_payload)='object'
    THEN public.raw_source_sanitize_site_sections_v1(
      p_payload #> '{attributes,site_sections}'
    )
    ELSE NULL
  END
$$;

CREATE FUNCTION raw_source_current_site_sections_candidate_v1(
  p_provider_key TEXT,
  p_attributes JSONB
)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN p_provider_key='structured_harvest'
      AND jsonb_typeof(p_attributes)='object'
    THEN public.raw_source_sanitize_site_sections_v1(
      p_attributes #> '{structured_harvest,site_sections}'
    )
    ELSE NULL
  END
$$;

CREATE FUNCTION raw_source_site_section_cleanup_receipt_shape_valid_v1(
  p_value JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT CASE WHEN jsonb_typeof(p_value)='object' THEN
    public.raw_source_json_keys_within_v2(
      p_value,
      ARRAY['_historicalCleanup','reason','originalValueHash'],
      ARRAY['_historicalCleanup','reason','originalValueHash']
    )
    AND p_value->>'_historicalCleanup'=
      'structured-harvest-site-section-cleanup/v1'
    AND p_value->>'reason'='UNSAFE_SITE_SECTION_KEY_WITHHELD'
    AND jsonb_typeof(p_value->'originalValueHash')='string'
    AND p_value->>'originalValueHash' ~ '^[0-9a-f]{64}$'
  ELSE false END
$$;

CREATE OR REPLACE FUNCTION raw_source_known_cleanup_receipt_v1(p_value JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT public.raw_source_cleanup_receipt_v2_shape_valid_v1(p_value)
    OR public.raw_source_cleanup_receipt_v3_shape_valid_v1(p_value)
    OR public.raw_source_stored_cleanup_receipt_shape_valid_v1(p_value)
    OR public.raw_source_site_section_cleanup_receipt_shape_valid_v1(p_value)
    OR (
      jsonb_typeof(p_value)='object'
      AND public.raw_source_json_keys_within_v2(
        p_value,
        ARRAY['_historicalCleanup','reason','originalValueHash','retainedValue'],
        ARRAY['_historicalCleanup','reason','originalValueHash']
      )
      AND p_value->>'_historicalCleanup'='canonical-attribute-cleanup/v1'
      AND p_value->>'reason'='UNSAFE_HISTORICAL_CANONICAL_VALUE_WITHHELD'
      AND jsonb_typeof(p_value->'originalValueHash')='string'
      AND p_value->>'originalValueHash' ~ '^[0-9a-f]{64}$'
    )
$$;

ALTER TABLE raw_source_field_evidence_cleanup_audit
  DROP CONSTRAINT raw_source_field_evidence_cleanup_audit_contract_check,
  DROP CONSTRAINT raw_source_field_evidence_cleanup_audit_adapter_check,
  ADD CONSTRAINT raw_source_field_evidence_cleanup_audit_contract_adapter_check
    CHECK (
      (
        cleanup_contract='raw-source-stored-field-cleanup/v1'
        AND adapter_version='stored-company-field-evidence/v1'
      ) OR (
        cleanup_contract='raw-source-site-section-cleanup/v1'
        AND adapter_version='structured-harvest-site-sections/v1'
      )
    );

REVOKE ALL ON FUNCTION raw_source_site_section_key_valid_v1(TEXT)
  FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_sanitize_site_sections_v1(JSONB)
  FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_sanitize_stored_company_field_evidence_v1(TEXT,JSONB)
  FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_linked_site_sections_candidate_v1(TEXT,JSONB)
  FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_current_site_sections_candidate_v1(TEXT,JSONB)
  FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_site_section_cleanup_receipt_shape_valid_v1(JSONB)
  FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_known_cleanup_receipt_v1(JSONB)
  FROM PUBLIC, app_user;

COMMIT;
