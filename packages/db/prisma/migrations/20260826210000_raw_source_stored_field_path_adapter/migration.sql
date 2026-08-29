-- Closed stored-FieldEvidence adapter and value-free correction audit.
-- Migrations 0900-2000 are checksum-frozen. This migration is DDL/ACL only;
-- historical product-row correction is isolated in 2200. Retained-size
-- timing/lock rehearsal and retained application remain HOLD/unauthorized.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

-- Numeric TED notice ids can resemble local phone strings. Admit only the
-- closed `digits-(19|20)yy` form; every other code still passes the generic
-- secret/contact-safe code contract from 1900.
CREATE OR REPLACE FUNCTION raw_source_semantic_identifier_valid_v1(
  p_path TEXT[],
  p_value TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF normalize(p_value,NFKC) IS DISTINCT FROM p_value
    OR octet_length(p_value) > 1024
    OR NOT public.raw_source_text_secret_safe_v2(p_value)
  THEN RETURN false; END IF;

  CASE p_path
    WHEN ARRAY['wikidata_qid']::TEXT[] THEN
      RETURN p_value ~ '^Q[1-9][0-9]{0,15}$';
    WHEN ARRAY['osm_id']::TEXT[] THEN
      RETURN p_value ~ '^(node|way|relation)/[0-9]{1,20}$';
    WHEN ARRAY['ted','publication_number']::TEXT[] THEN
      RETURN p_value ~ '^[0-9]{1,9}(-[0-9]{4})?$';
    WHEN ARRAY['ted','cpv']::TEXT[] THEN
      RETURN p_value ~ '^[0-9]{8}$';
    WHEN ARRAY['ted','winner_identifier']::TEXT[] THEN
      RETURN octet_length(p_value) <= 80
        AND p_value ~ '^[[:alnum:]][[:alnum:] ._:/-]{0,79}$'
        AND public.raw_source_text_contact_safe_v2(p_value);
    WHEN ARRAY['fda','registration_number']::TEXT[],
         ARRAY['fda','fei_number']::TEXT[],
         ARRAY['fda','owner_operator_numbers']::TEXT[] THEN
      RETURN p_value ~ '^[0-9]{1,32}$';
    WHEN ARRAY['gleif','lei']::TEXT[],
         ARRAY['gleif','parent_lei']::TEXT[],
         ARRAY['gleif','ultimate_parent_lei']::TEXT[],
         ARRAY['wikidata','lei']::TEXT[] THEN
      RETURN p_value ~ '^[A-Z0-9]{20}$';
    WHEN ARRAY['gleif','legal_form_code']::TEXT[] THEN
      RETURN octet_length(p_value) <= 128
        AND p_value ~ '^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,127}$'
        AND public.raw_source_text_contact_safe_v2(p_value);
    WHEN ARRAY['wikidata','qid']::TEXT[],
         ARRAY['wikidata','parent_qid']::TEXT[] THEN
      RETURN p_value ~ '^Q[1-9][0-9]{0,15}$';
    WHEN ARRAY['wikidata','isin']::TEXT[] THEN
      RETURN p_value ~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$';
    WHEN ARRAY['structured_harvest','hiring_signal','source']::TEXT[] THEN
      RETURN p_value IN ('sitemap','ats:greenhouse','ats:lever','ats:ashby')
        OR (
          p_value ~ '^https://[A-Za-z0-9][A-Za-z0-9.\-]*(?::[0-9]{1,5})?(?:[/?#][^[:cntrl:]]*)?$'
          AND p_value !~ '^https://[^/]*@'
          AND public.raw_source_text_contact_safe_v2(p_value)
        );
    WHEN ARRAY['intent','events','evidence','source']::TEXT[] THEN
      RETURN p_value IN ('ted','samgov','openfda');
    WHEN ARRAY['intent','events','evidence','notice']::TEXT[] THEN
      RETURN (
          p_value ~ '^[0-9]{1,9}-(19|20)[0-9]{2}$'
          AND public.raw_source_text_secret_safe_v2(p_value)
        ) OR (
          octet_length(p_value) <= 128
          AND p_value ~ '^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,127}$'
          AND public.raw_source_text_contact_safe_v2(p_value)
        );
    WHEN ARRAY['intent','events','evidence','k_number']::TEXT[] THEN
      RETURN octet_length(p_value) <= 128
        AND p_value ~ '^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,127}$'
        AND public.raw_source_text_contact_safe_v2(p_value);
    WHEN ARRAY['intent','events','evidence','cpv']::TEXT[] THEN
      RETURN p_value ~ '^[0-9]{8}$';
    WHEN ARRAY['intent','events','evidence','naics']::TEXT[] THEN
      RETURN p_value ~ '^[0-9]{2,6}$';
    WHEN ARRAY['intent','events','evidence','product_code']::TEXT[] THEN
      RETURN p_value ~ '^[A-Z]{3}$';
    ELSE
      RETURN false;
  END CASE;
END
$$;

-- Explicit stored-field -> Canonical attribute path mapping. No field is
-- admitted by splitting arbitrary dots or matching a suffix/leaf key.
CREATE FUNCTION raw_source_stored_field_attribute_path_v1(p_field TEXT)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT CASE p_field
    WHEN 'digital_footprint.ad_pixels' THEN ARRAY['digital_footprint','ad_pixels']
    WHEN 'digital_footprint.email_provider' THEN ARRAY['digital_footprint','email_provider']
    WHEN 'digital_footprint.hiring_signal' THEN ARRAY['digital_footprint','hiring_signal']
    WHEN 'digital_footprint.is_advertiser' THEN ARRAY['digital_footprint','is_advertiser']
    WHEN 'digital_footprint.served_langs' THEN ARRAY['digital_footprint','served_langs']
    WHEN 'digital_footprint.served_markets' THEN ARRAY['digital_footprint','served_markets']
    WHEN 'digital_footprint.structured_org' THEN ARRAY['digital_footprint','structured_org']
    WHEN 'digital_footprint.structured_products' THEN ARRAY['digital_footprint','structured_products']
    WHEN 'digital_footprint.tech_platform' THEN ARRAY['digital_footprint','tech_platform']
    WHEN 'gleif.entity_status' THEN ARRAY['gleif','entity_status']
    WHEN 'gleif.is_subsidiary' THEN ARRAY['gleif','is_subsidiary']
    WHEN 'gleif.legal_form' THEN ARRAY['gleif','legal_form']
    WHEN 'gleif.legal_form_code' THEN ARRAY['gleif','legal_form_code']
    WHEN 'gleif.legal_name' THEN ARRAY['gleif','legal_name']
    WHEN 'gleif.lei' THEN ARRAY['gleif','lei']
    WHEN 'gleif.match_confidence' THEN ARRAY['gleif','match_confidence']
    WHEN 'gleif.parent_lei' THEN ARRAY['gleif','parent_lei']
    WHEN 'gleif.parent_name' THEN ARRAY['gleif','parent_name']
    WHEN 'gleif.registered_city' THEN ARRAY['gleif','registered_city']
    WHEN 'gleif.registered_country' THEN ARRAY['gleif','registered_country']
    WHEN 'gleif.registration_status' THEN ARRAY['gleif','registration_status']
    WHEN 'gleif.ultimate_parent_lei' THEN ARRAY['gleif','ultimate_parent_lei']
    WHEN 'gleif.ultimate_parent_name' THEN ARRAY['gleif','ultimate_parent_name']
    WHEN 'structured_harvest.careers_url' THEN ARRAY['structured_harvest','careers_url']
    WHEN 'structured_harvest.hiring_signal' THEN ARRAY['structured_harvest','hiring_signal']
    WHEN 'structured_harvest.site_sections' THEN ARRAY['structured_harvest','site_sections']
    WHEN 'structured_harvest.sitemap_url_count' THEN ARRAY['structured_harvest','sitemap_url_count']
    WHEN 'wikidata.country' THEN ARRAY['wikidata','country']
    WHEN 'wikidata.employees' THEN ARRAY['wikidata','employees']
    WHEN 'wikidata.headquarters' THEN ARRAY['wikidata','headquarters']
    WHEN 'wikidata.inception_year' THEN ARRAY['wikidata','inception_year']
    WHEN 'wikidata.industries' THEN ARRAY['wikidata','industries']
    WHEN 'wikidata.isin' THEN ARRAY['wikidata','isin']
    WHEN 'wikidata.label' THEN ARRAY['wikidata','label']
    WHEN 'wikidata.lei' THEN ARRAY['wikidata','lei']
    WHEN 'wikidata.match_confidence' THEN ARRAY['wikidata','match_confidence']
    WHEN 'wikidata.parent_name' THEN ARRAY['wikidata','parent_name']
    WHEN 'wikidata.parent_qid' THEN ARRAY['wikidata','parent_qid']
    WHEN 'wikidata.products' THEN ARRAY['wikidata','products']
    WHEN 'wikidata.qid' THEN ARRAY['wikidata','qid']
    WHEN 'wikidata.stock_exchange' THEN ARRAY['wikidata','stock_exchange']
    WHEN 'wikidata.subsidiary_count' THEN ARRAY['wikidata','subsidiary_count']
    WHEN 'wikidata.website' THEN ARRAY['wikidata','website']
    ELSE NULL
  END
$$;

CREATE FUNCTION raw_source_sanitize_stored_identity_v1(p_value JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  rendered JSONB;
BEGIN
  IF jsonb_typeof(p_value) <> 'object' THEN RETURN NULL; END IF;
  rendered := jsonb_strip_nulls(jsonb_build_object(
    'name', CASE
      WHEN jsonb_typeof(p_value->'name')='string'
        AND public.raw_source_provider_company_name_valid_v2(p_value->>'name')
      THEN p_value->'name' ELSE NULL END,
    'country', CASE
      WHEN jsonb_typeof(p_value->'country')='string'
        AND normalize(p_value->>'country',NFKC)=p_value->>'country'
        AND octet_length(p_value->>'country') <= 80
        AND public.raw_source_text_contact_safe_v2(p_value->>'country')
      THEN p_value->'country' ELSE NULL END,
    'source', CASE
      WHEN jsonb_typeof(p_value->'source')='string'
        AND p_value->>'source' IN ('openfda','samgov','ted')
      THEN p_value->'source' ELSE NULL END,
    'notice', CASE
      WHEN jsonb_typeof(p_value->'notice')='string'
        AND public.raw_source_semantic_identifier_valid_v1(
          ARRAY['intent','events','evidence','notice'],p_value->>'notice'
        )
      THEN p_value->'notice' ELSE NULL END,
    'k_number', CASE
      WHEN jsonb_typeof(p_value->'k_number')='string'
        AND public.raw_source_semantic_identifier_valid_v1(
          ARRAY['intent','events','evidence','k_number'],p_value->>'k_number'
        )
      THEN p_value->'k_number' ELSE NULL END,
    'attribution', CASE
      WHEN jsonb_typeof(p_value->'attribution')='string'
        AND normalize(p_value->>'attribution',NFKC)=p_value->>'attribution'
        AND octet_length(p_value->>'attribution') <= 1024
        AND public.raw_source_text_contact_safe_v2(p_value->>'attribution')
      THEN p_value->'attribution' ELSE NULL END,
    'disclaimer', CASE
      WHEN jsonb_typeof(p_value->'disclaimer')='string'
        AND normalize(p_value->>'disclaimer',NFKC)=p_value->>'disclaimer'
        AND octet_length(p_value->>'disclaimer') <= 1024
        AND public.raw_source_text_contact_safe_v2(p_value->>'disclaimer')
      THEN p_value->'disclaimer' ELSE NULL END
  ));
  RETURN CASE WHEN rendered='{}'::jsonb THEN NULL ELSE rendered END;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END
$$;

CREATE FUNCTION raw_source_sanitize_stored_company_field_evidence_v1(
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
    IF jsonb_typeof(p_value)<>'object'
      OR (SELECT count(*) FROM jsonb_object_keys(p_value)) > 20
    THEN RETURN NULL; END IF;
    SELECT jsonb_object_agg(entry.key,entry.value)
    INTO sanitized
    FROM jsonb_each(p_value) AS entry
    WHERE entry.key ~ '^[a-z0-9][a-z0-9_-]{0,23}$'
      AND jsonb_typeof(entry.value)='number'
      AND (entry.value #>> '{}')::NUMERIC BETWEEN 0 AND 1000000
      AND trunc((entry.value #>> '{}')::NUMERIC)=(entry.value #>> '{}')::NUMERIC;
    RETURN sanitized;
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

CREATE FUNCTION raw_source_linked_stored_field_candidate_v1(
  p_field TEXT,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate JSONB;
BEGIN
  IF jsonb_typeof(p_payload)<>'object' THEN RETURN NULL; END IF;
  candidate := CASE p_field
    WHEN 'name' THEN p_payload->'name'
    WHEN 'domain' THEN p_payload->'domain'
    WHEN 'country' THEN p_payload->'country'
    WHEN 'region' THEN p_payload->'region'
    WHEN 'industry' THEN p_payload->'industry'
    WHEN 'employee_count' THEN p_payload->'employeeCount'
    WHEN 'revenue_usd' THEN p_payload->'revenueUsd'
    WHEN 'attributes' THEN p_payload->'attributes'
    ELSE NULL
  END;
  RETURN public.raw_source_sanitize_stored_company_field_evidence_v1(
    p_field,candidate
  );
END
$$;

CREATE FUNCTION raw_source_current_stored_field_candidate_v1(
  p_field TEXT,
  p_provider_key TEXT,
  p_attributes JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  events JSONB;
BEGIN
  IF jsonb_typeof(p_attributes)<>'object' THEN RETURN NULL; END IF;
  IF p_field='intent.tender' AND p_provider_key='ted' THEN
    RETURN public.raw_source_sanitize_stored_company_field_evidence_v1(
      p_field,p_attributes->'intent'
    );
  ELSIF p_field='intent.website_change' AND p_provider_key='web_watch' THEN
    RETURN public.raw_source_sanitize_stored_company_field_evidence_v1(
      p_field,p_attributes->'intent'
    );
  ELSIF p_field='intent.clearance' AND p_provider_key='openfda' THEN
    IF jsonb_typeof(p_attributes #> '{intent,events}')<>'array'
    THEN RETURN NULL; END IF;
    SELECT jsonb_agg(event.value ORDER BY event.ordinality)
    INTO events
    FROM jsonb_array_elements(p_attributes #> '{intent,events}')
      WITH ORDINALITY AS event(value,ordinality)
    WHERE event.value #>> '{evidence,source}'='openfda';
    IF events IS NULL OR jsonb_array_length(events)<>1 THEN RETURN NULL; END IF;
    RETURN public.raw_source_sanitize_stored_company_field_evidence_v1(
      p_field,events->0
    );
  ELSIF p_field='intent.sources_sought' AND p_provider_key='samgov' THEN
    IF jsonb_typeof(p_attributes #> '{intent,events}')<>'array'
    THEN RETURN NULL; END IF;
    SELECT jsonb_agg(event.value ORDER BY event.ordinality)
    INTO events
    FROM jsonb_array_elements(p_attributes #> '{intent,events}')
      WITH ORDINALITY AS event(value,ordinality)
    WHERE event.value #>> '{evidence,source}'='samgov';
    IF events IS NULL THEN RETURN NULL; END IF;
    RETURN public.raw_source_sanitize_stored_company_field_evidence_v1(
      p_field,jsonb_build_object('events',events)
    );
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END
$$;

CREATE FUNCTION raw_source_stored_cleanup_receipt_shape_valid_v1(
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
    AND p_value->>'_historicalCleanup'='stored-field-evidence-cleanup/v1'
    AND p_value->>'reason'='UNRECOVERABLE_STORED_FIELD_VALUE_WITHHELD'
    AND jsonb_typeof(p_value->'originalValueHash')='string'
    AND p_value->>'originalValueHash' ~ '^[0-9a-f]{64}$'
  ELSE false END
$$;

CREATE FUNCTION raw_source_known_cleanup_receipt_v1(p_value JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT public.raw_source_cleanup_receipt_v2_shape_valid_v1(p_value)
    OR public.raw_source_cleanup_receipt_v3_shape_valid_v1(p_value)
    OR public.raw_source_stored_cleanup_receipt_shape_valid_v1(p_value)
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

CREATE UNIQUE INDEX field_evidence_workspace_id_id_key
  ON field_evidence(workspace_id,id);

CREATE TABLE raw_source_field_evidence_cleanup_audit (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  field_evidence_id UUID NOT NULL,
  raw_record_id UUID,
  cleanup_contract VARCHAR(64) NOT NULL,
  adapter_version VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  original_value_hash CHAR(64) NOT NULL,
  predecessor_receipt_hash CHAR(64),
  restored_value_hash CHAR(64),
  evidence_fetched_at TIMESTAMP(3) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT raw_source_field_evidence_cleanup_audit_pkey PRIMARY KEY (id),
  CONSTRAINT raw_source_field_evidence_cleanup_audit_contract_check
    CHECK (cleanup_contract='raw-source-stored-field-cleanup/v1'),
  CONSTRAINT raw_source_field_evidence_cleanup_audit_adapter_check
    CHECK (adapter_version='stored-company-field-evidence/v1'),
  CONSTRAINT raw_source_field_evidence_cleanup_audit_status_check
    CHECK (status IN ('RESTORED','UNRECOVERABLE_HOLD')),
  CONSTRAINT raw_source_field_evidence_cleanup_audit_original_hash_check
    CHECK (original_value_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT raw_source_field_evidence_cleanup_audit_predecessor_hash_check
    CHECK (predecessor_receipt_hash IS NULL OR predecessor_receipt_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT raw_source_field_evidence_cleanup_audit_restored_hash_check
    CHECK (restored_value_hash IS NULL OR restored_value_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT raw_source_field_evidence_cleanup_audit_restored_status_check
    CHECK (
      (status='RESTORED' AND restored_value_hash=original_value_hash)
      OR (status='UNRECOVERABLE_HOLD' AND restored_value_hash IS NULL)
    ),
  CONSTRAINT raw_source_field_evidence_cleanup_audit_evidence_fkey
    FOREIGN KEY (workspace_id,field_evidence_id)
    REFERENCES field_evidence(workspace_id,id)
    ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX raw_source_field_evidence_cleanup_audit_unique
  ON raw_source_field_evidence_cleanup_audit(
    field_evidence_id,cleanup_contract,adapter_version
  );
CREATE INDEX raw_source_field_evidence_cleanup_audit_workspace_created_idx
  ON raw_source_field_evidence_cleanup_audit(workspace_id,created_at);

ALTER TABLE raw_source_field_evidence_cleanup_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_source_field_evidence_cleanup_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY raw_source_field_evidence_cleanup_audit_tenant_isolation
  ON raw_source_field_evidence_cleanup_audit
  FOR SELECT
  USING (workspace_id=current_workspace_id());
CREATE POLICY raw_source_field_evidence_cleanup_audit_migration_insert
  ON raw_source_field_evidence_cleanup_audit
  FOR INSERT
  WITH CHECK (true);

REVOKE ALL ON TABLE raw_source_field_evidence_cleanup_audit FROM PUBLIC, app_user;
GRANT SELECT ON TABLE raw_source_field_evidence_cleanup_audit TO app_user;

REVOKE ALL ON FUNCTION raw_source_semantic_identifier_valid_v1(TEXT[],TEXT)
  FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_stored_field_attribute_path_v1(TEXT)
  FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_sanitize_stored_identity_v1(JSONB)
  FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_sanitize_stored_company_field_evidence_v1(TEXT,JSONB)
  FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_linked_stored_field_candidate_v1(TEXT,JSONB)
  FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_current_stored_field_candidate_v1(TEXT,TEXT,JSONB)
  FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_stored_cleanup_receipt_shape_valid_v1(JSONB)
  FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_known_cleanup_receipt_v1(JSONB)
  FROM PUBLIC, app_user;

COMMIT;
