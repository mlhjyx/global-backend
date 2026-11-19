-- DDL only: align the existing run-event vocabulary and country-identity sanitizers.
-- No retained rows, operation status, grants or role privileges are changed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE public.run_event DROP CONSTRAINT run_event_type_check;
ALTER TABLE public.run_event ADD CONSTRAINT run_event_type_check CHECK (
  type IN ('phase_started','phase_completed','company_entered_stage','company_done',
    'company_failed','company_enrichment_observed','budget_exhausted','lease_skipped',
    'pool_cap_reached','run_finished','qualification_batch_scored')
);

-- Preserve existing signature, owner and ACL; retain the later 20261009160000 pg_temp-last hardening. Source: packages/db/prisma/migrations/20260826210000_raw_source_stored_field_path_adapter/migration.sql
CREATE OR REPLACE FUNCTION public.raw_source_semantic_identifier_valid_v1(
  p_path TEXT[],
  p_value TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public, pg_temp
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
         ARRAY['wikidata','country_qid']::TEXT[],
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

-- Preserve existing signature, owner and ACL; retain the later 20261009160000 pg_temp-last hardening. Source: packages/db/prisma/migrations/20260826210000_raw_source_stored_field_path_adapter/migration.sql
CREATE OR REPLACE FUNCTION public.raw_source_stored_field_attribute_path_v1(p_field TEXT)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public, pg_temp
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
    WHEN 'wikidata.country_qid' THEN ARRAY['wikidata','country_qid']
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

-- Preserve existing signature, owner and ACL; retain the later 20261009160000 pg_temp-last hardening. Source: packages/db/prisma/migrations/20260826190000_raw_source_governance_path_sanitizer/migration.sql
CREATE OR REPLACE FUNCTION public.raw_source_sanitize_derived_json_v4(
  p_value JSONB,
  p_path TEXT[],
  p_depth INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  rendered JSONB;
  leaf_key TEXT := p_path[array_length(p_path,1)];
  normalized_key TEXT := lower(regexp_replace(
    p_path[array_length(p_path,1)],'[^a-z0-9]','','g'
  ));
  semantic_identifier BOOLEAN := leaf_key IN (
    'cpv','fei_number','isin','k_number','lei','legal_form_code','naics',
    'notice','osm_id','owner_operator_numbers','parent_lei','parent_qid','country_qid',
    'product_code','publication_number','qid','registration_number','source',
    'ultimate_parent_lei','wikidata_qid','winner_identifier'
  );
  semantic_array BOOLEAN := p_path IN (
    ARRAY['ted','cpv']::TEXT[],
    ARRAY['fda','owner_operator_numbers']::TEXT[],
    ARRAY['intent','events','evidence','cpv']::TEXT[],
    ARRAY['intent','events','evidence','naics']::TEXT[]
  );
BEGIN
  IF p_depth > 6 OR normalized_key IN (
    'address','contact','contactemail','contactname','contactpoint','email',
    'firstname','fullname','lastname','mobile','ownername','person','persons',
    'phone','publicemail','publicphone','recipientname','telephone','usagent'
  ) THEN RETURN NULL; END IF;

  IF leaf_key IN ('products','keywords') THEN
    IF jsonb_typeof(p_value) <> 'array' OR jsonb_array_length(p_value) > 50
    THEN RETURN NULL; END IF;
    SELECT jsonb_agg(to_jsonb(item.term) ORDER BY item.first_ordinality)
    INTO rendered
    FROM (
      SELECT term.value AS term, min(term.ordinality) AS first_ordinality
      FROM jsonb_array_elements_text(p_value) WITH ORDINALITY
        AS term(value,ordinality)
      WHERE public.raw_source_controlled_business_term_v2(term.value)
        OR (leaf_key='products' AND term.value ~ '^[A-Z]{3}$'
          AND public.raw_source_text_contact_safe_v2(term.value))
      GROUP BY term.value
    ) AS item;
    RETURN rendered;
  END IF;

  CASE jsonb_typeof(p_value)
    WHEN 'object' THEN
      IF semantic_identifier OR
        (SELECT count(*) FROM jsonb_object_keys(p_value)) > 64
      THEN RETURN NULL; END IF;
      SELECT coalesce(jsonb_object_agg(item.key,item.safe_value),'{}'::jsonb)
      INTO rendered
      FROM (
        SELECT entry.key,
          public.raw_source_sanitize_derived_json_v4(
            entry.value,p_path || entry.key,p_depth+1
          ) AS safe_value
        FROM jsonb_each(p_value) AS entry
      ) AS item
      WHERE item.safe_value IS NOT NULL;
      RETURN rendered;
    WHEN 'array' THEN
      IF (semantic_identifier AND NOT semantic_array)
        OR jsonb_array_length(p_value) > 50
      THEN RETURN NULL; END IF;
      SELECT coalesce(
        jsonb_agg(item.safe_value ORDER BY item.ordinality),'[]'::jsonb
      ) INTO rendered
      FROM (
        SELECT entry.ordinality,
          public.raw_source_sanitize_derived_json_v4(
            entry.value,p_path,p_depth+1
          ) AS safe_value
        FROM jsonb_array_elements(p_value) WITH ORDINALITY
          AS entry(value,ordinality)
      ) AS item
      WHERE item.safe_value IS NOT NULL;
      RETURN rendered;
    WHEN 'string' THEN
      IF normalize(p_value #>> '{}',NFKC) = (p_value #>> '{}')
        AND octet_length(p_value #>> '{}') <= 1024
        AND (
          (semantic_identifier AND
            public.raw_source_semantic_identifier_valid_v1(
              p_path,p_value #>> '{}'
            ))
          OR (NOT semantic_identifier AND
            public.raw_source_text_contact_safe_v2(p_value #>> '{}'))
        )
      THEN RETURN p_value; END IF;
      RETURN NULL;
    WHEN 'number' THEN
      IF semantic_identifier THEN RETURN NULL; END IF;
      RETURN p_value;
    WHEN 'boolean' THEN
      IF semantic_identifier THEN RETURN NULL; END IF;
      RETURN p_value;
    WHEN 'null' THEN RETURN p_value;
    ELSE RETURN NULL;
  END CASE;
END
$$;

COMMIT;
