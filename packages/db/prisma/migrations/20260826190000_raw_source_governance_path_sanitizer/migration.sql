-- Full-path Canonical/FieldEvidence semantic-identifier sanitizer.
-- Migrations 0900-1800 are checksum-frozen. This migration contains DDL/ACL
-- only; historical product-row correction is isolated in 2000. Retained-size
-- timing/lock rehearsal and retained application remain HOLD/unauthorized.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

CREATE FUNCTION raw_source_semantic_identifier_valid_v1(
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
    WHEN ARRAY['intent','events','evidence','notice']::TEXT[],
         ARRAY['intent','events','evidence','k_number']::TEXT[] THEN
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

CREATE FUNCTION raw_source_sanitize_derived_json_v4(
  p_value JSONB,
  p_path TEXT[],
  p_depth INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  rendered JSONB;
  leaf_key TEXT := p_path[array_length(p_path,1)];
  normalized_key TEXT := lower(regexp_replace(
    p_path[array_length(p_path,1)],'[^a-z0-9]','','g'
  ));
  semantic_identifier BOOLEAN := leaf_key IN (
    'cpv','fei_number','isin','k_number','lei','legal_form_code','naics',
    'notice','osm_id','owner_operator_numbers','parent_lei','parent_qid',
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

CREATE OR REPLACE FUNCTION sanitize_canonical_company_attributes_v2(
  p_attributes JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  rendered JSONB;
BEGIN
  IF jsonb_typeof(p_attributes) <> 'object'
    OR NOT public.raw_source_json_shape_valid_v2(p_attributes,7,512)
  THEN RETURN '{}'::jsonb; END IF;
  SELECT coalesce(jsonb_object_agg(item.key,item.safe_value),'{}'::jsonb)
  INTO rendered
  FROM (
    SELECT entry.key,
      public.raw_source_sanitize_derived_json_v4(
        entry.value,ARRAY[entry.key]::TEXT[],0
      ) AS safe_value
    FROM jsonb_each(p_attributes) AS entry
    WHERE entry.key IN (
      'digital_footprint','employee_band','employees','extraction_confidence',
      'extraction_evidence_digest','fda','fda_applicant','gleif',
      'government_buyer','hall','hiring_signal','intent','keywords','latitude',
      'longitude','osm_id','products','sam_disclaimer','sam_market_signal',
      'source_class','source_fair','source_kind','stand','structured_harvest',
      'ted','ted_buyer','wikidata','wikidata_qid'
    )
  ) AS item
  WHERE item.safe_value IS NOT NULL;
  RETURN rendered;
END
$$;

CREATE FUNCTION raw_source_cleanup_receipt_v3_shape_valid_v1(p_value JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT CASE WHEN jsonb_typeof(p_value) = 'object' THEN
    public.raw_source_json_keys_within_v2(
      p_value,
      ARRAY['_historicalCleanup','reason','originalValueHash',
        'predecessorReceiptHash','retainedValue'],
      ARRAY['_historicalCleanup','reason','originalValueHash',
        'predecessorReceiptHash']
    )
    AND p_value->>'_historicalCleanup' = 'canonical-attribute-cleanup/v3'
    AND p_value->>'reason' = 'UNSAFE_HISTORICAL_CANONICAL_VALUE_WITHHELD'
    AND jsonb_typeof(p_value->'originalValueHash') = 'string'
    AND p_value->>'originalValueHash' ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(p_value->'predecessorReceiptHash') = 'string'
    AND p_value->>'predecessorReceiptHash' ~ '^[0-9a-f]{64}$'
  ELSE false END
$$;

CREATE OR REPLACE FUNCTION raw_source_sanitize_field_evidence_v4(
  p_field TEXT,
  p_value JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF jsonb_typeof(p_value) = 'object'
    AND public.raw_source_json_keys_within_v2(
      p_value,
      ARRAY['_historicalCleanup','reason','originalValueHash','retainedValue'],
      ARRAY['_historicalCleanup','reason','originalValueHash']
    )
    AND p_value->>'_historicalCleanup' = 'canonical-attribute-cleanup/v1'
    AND p_value->>'reason' = 'UNSAFE_HISTORICAL_CANONICAL_VALUE_WITHHELD'
    AND jsonb_typeof(p_value->'originalValueHash') = 'string'
    AND p_value->>'originalValueHash' ~ '^[0-9a-f]{64}$'
    AND (
      NOT p_value ? 'retainedValue'
      OR p_value->'retainedValue' IS NOT DISTINCT FROM
        public.raw_source_sanitize_field_evidence_plain_v5(
          p_field,p_value->'retainedValue'
        )
    )
  THEN RETURN p_value; END IF;

  IF public.raw_source_cleanup_receipt_v2_shape_valid_v1(p_value)
    OR public.raw_source_cleanup_receipt_v3_shape_valid_v1(p_value)
  THEN
    IF (
      NOT p_value ? 'retainedValue'
      OR p_value->'retainedValue' IS NOT DISTINCT FROM
        public.raw_source_sanitize_field_evidence_plain_v5(
          p_field,p_value->'retainedValue'
        )
    ) THEN RETURN p_value; END IF;
    RETURN NULL;
  END IF;

  RETURN public.raw_source_sanitize_field_evidence_plain_v5(p_field,p_value);
END
$$;

REVOKE ALL ON FUNCTION raw_source_semantic_identifier_valid_v1(TEXT[],TEXT)
  FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_sanitize_derived_json_v4(JSONB,TEXT[],INTEGER)
  FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION sanitize_canonical_company_attributes_v2(JSONB)
  FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_cleanup_receipt_v3_shape_valid_v1(JSONB)
  FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_sanitize_field_evidence_v4(TEXT,JSONB)
  FROM PUBLIC, app_user;

COMMIT;
