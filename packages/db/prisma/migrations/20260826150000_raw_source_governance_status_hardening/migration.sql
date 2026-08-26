-- Pre-release reissue: close every remaining Raw status/scalar boundary
-- without rewriting 0900-1400. The prior 1500 checksum was never pushed or
-- applied to a retained database and is forbidden by the experiment checker.
-- This migration keeps the proven 1300 relational writer as an uncallable
-- implementation detail behind stricter 1500 validation.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

CREATE FUNCTION raw_source_decimal_fold_v2(p_value TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
DECLARE
  character TEXT;
  codepoint INTEGER;
  digit_zero INTEGER;
  folded TEXT := '';
  decimal_zeroes CONSTANT INTEGER[] := ARRAY[
    48,1632,1776,1984,2406,2534,2662,2790,2918,3046,3174,3302,3430,
    3558,3664,3792,3872,4160,4240,6112,6160,6470,6608,6784,6800,6992,
    7088,7232,7248,42528,43216,43264,43472,43504,43600,44016,65296,
    66720,68912,68928,69734,69872,69942,70096,70384,70736,70864,71248,
    71360,71376,71386,71472,71904,72016,72688,72784,73040,73120,73184,
    73552,90416,92768,92864,93008,93552,118000,120782,120792,120802,
    120812,120822,123200,123632,124144,124401,125264,130032
  ];
BEGIN
  FOREACH character IN ARRAY regexp_split_to_array(p_value, '') LOOP
    codepoint := ascii(character);
    digit_zero := NULL;
    SELECT candidate INTO digit_zero
    FROM unnest(decimal_zeroes) AS candidate
    WHERE codepoint BETWEEN candidate AND candidate + 9
    LIMIT 1;
    folded := folded || CASE
      WHEN digit_zero IS NULL THEN character
      ELSE chr(48 + codepoint - digit_zero)
    END;
  END LOOP;
  RETURN folded;
END
$$;

CREATE OR REPLACE FUNCTION raw_source_text_contact_safe_v2(p_value TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT public.raw_source_text_secret_safe_v2(p_value)
    AND public.raw_source_decimal_fold_v2(p_value)
      !~ '(^|[^[:alnum:]])([+]?[0-9][ ()\.-]*){7,}($|[^[:alnum:]])'
$$;

CREATE OR REPLACE FUNCTION raw_source_safe_https_url_v2(p_value TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT octet_length(p_value) BETWEEN 1 AND 2048
    AND p_value ~ '^https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?:\:443)?(?:/|$)'
    AND p_value !~ '[?#]'
    AND p_value !~ '^https://[^/]*@'
    AND p_value !~* '%25'
    AND regexp_replace(p_value, '%20', '', 'gi') !~ '%'
    AND public.raw_source_text_contact_safe_v2(
      regexp_replace(p_value, '%20', ' ', 'gi')
    )
$$;

CREATE FUNCTION raw_source_optional_json_type_v2(
  p_value JSONB,
  p_key TEXT,
  p_type TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT NOT p_value ? p_key OR jsonb_typeof(p_value->p_key) = p_type
$$;

CREATE FUNCTION raw_source_string_array_type_v2(p_value JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_typeof(p_value) = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_value) AS item(value)
      WHERE jsonb_typeof(item.value) <> 'string'
    )
$$;

CREATE FUNCTION raw_source_provider_payload_types_valid_v2(
  p_provider_key TEXT,
  p_payload JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  attributes JSONB;
  provenance JSONB;
  identifier JSONB;
  nested JSONB;
BEGIN
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_payload->'attributes') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_payload->'name') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'provenance') IS DISTINCT FROM 'object'
  THEN RETURN false; END IF;

  FOREACH nested IN ARRAY ARRAY[
    p_payload->'externalId',p_payload->'domain',p_payload->'country',
    p_payload->'license'
  ] LOOP
    IF nested IS NOT NULL AND jsonb_typeof(nested) IS DISTINCT FROM 'string'
    THEN RETURN false; END IF;
  END LOOP;
  IF NOT public.raw_source_optional_json_type_v2(p_payload,'employeeCount','number')
    OR NOT public.raw_source_optional_json_type_v2(p_payload,'revenueUsd','number')
    OR NOT public.raw_source_optional_json_type_v2(p_payload,'identifier','object')
    OR NOT public.raw_source_optional_json_type_v2(p_payload,'monitoredSource','object')
  THEN RETURN false; END IF;

  provenance := p_payload->'provenance';
  IF jsonb_typeof(provenance->'sourceUrl') IS DISTINCT FROM 'string'
    OR jsonb_typeof(provenance->'fetchedAt') IS DISTINCT FROM 'string'
    OR jsonb_typeof(provenance->'contentHash') IS DISTINCT FROM 'string'
    OR jsonb_typeof(provenance->'parserVersion') IS DISTINCT FROM 'string'
  THEN RETURN false; END IF;

  identifier := p_payload->'identifier';
  IF identifier IS NOT NULL AND (
    jsonb_typeof(identifier->'scheme') IS DISTINCT FROM 'string'
    OR jsonb_typeof(identifier->'value') IS DISTINCT FROM 'string'
  ) THEN RETURN false; END IF;

  attributes := p_payload->'attributes';
  CASE p_provider_key
    WHEN 'registry' THEN
      IF NOT public.raw_source_optional_json_type_v2(attributes,'employee_band','string')
        OR NOT public.raw_source_optional_json_type_v2(attributes,'employees','number')
        OR (attributes ? 'products' AND NOT
          public.raw_source_string_array_type_v2(attributes->'products'))
      THEN RETURN false; END IF;
    WHEN 'directory' THEN
      IF NOT public.raw_source_optional_json_type_v2(attributes,'detail_url','string')
        OR jsonb_typeof(attributes->'source_class') IS DISTINCT FROM 'string'
        OR jsonb_typeof(attributes->'source_directory') IS DISTINCT FROM 'string'
        OR jsonb_typeof(attributes->'source_kind') IS DISTINCT FROM 'string'
      THEN RETURN false; END IF;
    WHEN 'wikidata' THEN
      IF NOT public.raw_source_optional_json_type_v2(attributes,'latitude','number')
        OR NOT public.raw_source_optional_json_type_v2(attributes,'longitude','number')
        OR jsonb_typeof(attributes->'source_class') IS DISTINCT FROM 'string'
        OR jsonb_typeof(attributes->'wikidata_qid') IS DISTINCT FROM 'string'
      THEN RETURN false; END IF;
    WHEN 'openstreetmap' THEN
      IF NOT public.raw_source_optional_json_type_v2(attributes,'latitude','number')
        OR NOT public.raw_source_optional_json_type_v2(attributes,'longitude','number')
        OR jsonb_typeof(attributes->'source_class') IS DISTINCT FROM 'string'
        OR jsonb_typeof(attributes->'osm_id') IS DISTINCT FROM 'string'
      THEN RETURN false; END IF;
    WHEN 'trade_fair' THEN
      IF NOT public.raw_source_optional_json_type_v2(attributes,'hall','string')
        OR NOT public.raw_source_optional_json_type_v2(attributes,'stand','string')
        OR NOT public.raw_source_optional_json_type_v2(attributes,'source_class','string')
        OR NOT public.raw_source_optional_json_type_v2(attributes,'source_fair','string')
        OR NOT public.raw_source_optional_json_type_v2(attributes,'source_kind','string')
        OR NOT public.raw_source_optional_json_type_v2(attributes,'hiring_signal','boolean')
        OR (attributes ? 'products' AND NOT
          public.raw_source_string_array_type_v2(attributes->'products'))
      THEN RETURN false; END IF;
      nested := p_payload->'monitoredSource';
      IF nested IS NOT NULL AND (
        jsonb_typeof(nested->'originProviderKey') IS DISTINCT FROM 'string'
        OR jsonb_typeof(nested->'sourceEntityId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(nested->'sourceExternalId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(nested->'sourceFetchId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(nested->'sourceId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(nested->'sourceKey') IS DISTINCT FROM 'string'
      ) THEN RETURN false; END IF;
    WHEN 'ted' THEN
      IF jsonb_typeof(attributes->'ted') IS DISTINCT FROM 'object'
      THEN RETURN false; END IF;
      nested := attributes->'ted';
      IF jsonb_typeof(nested->'publication_number') IS DISTINCT FROM 'string'
        OR jsonb_typeof(nested->'publication_date') IS DISTINCT FROM 'string'
        OR jsonb_typeof(nested->'notice_type') IS DISTINCT FROM 'string'
        OR NOT public.raw_source_optional_json_type_v2(nested,'winner_identifier','string')
        OR (nested ? 'cpv' AND NOT
          public.raw_source_string_array_type_v2(nested->'cpv'))
        OR (nested ? 'buyer_countries' AND NOT
          public.raw_source_string_array_type_v2(nested->'buyer_countries'))
      THEN RETURN false; END IF;
    WHEN 'openfda' THEN
      IF jsonb_typeof(attributes->'fda') IS DISTINCT FROM 'object'
      THEN RETURN false; END IF;
      nested := attributes->'fda';
      IF NOT public.raw_source_optional_json_type_v2(nested,'created_date','string')
        OR NOT public.raw_source_optional_json_type_v2(nested,'fei_number','string')
        OR NOT public.raw_source_optional_json_type_v2(nested,'registration_number','string')
        OR NOT public.raw_source_optional_json_type_v2(nested,'state_code','string')
        OR NOT public.raw_source_optional_json_type_v2(nested,'status_code','string')
        OR NOT public.raw_source_optional_json_type_v2(nested,'initial_importer','boolean')
        OR (nested ? 'owner_operator_numbers' AND NOT
          public.raw_source_string_array_type_v2(nested->'owner_operator_numbers'))
        OR (nested ? 'product_codes' AND NOT
          public.raw_source_string_array_type_v2(nested->'product_codes'))
        OR (attributes ? 'products' AND NOT
          public.raw_source_string_array_type_v2(attributes->'products'))
      THEN RETURN false; END IF;
      IF (nested ? 'product_codes' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(nested->'product_codes') code
          WHERE code !~ '^[A-Z]{3}$'
            OR NOT public.raw_source_text_contact_safe_v2(code)
        )) OR (attributes ? 'products' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(attributes->'products') code
          WHERE code !~ '^[A-Z]{3}$'
            OR NOT public.raw_source_text_contact_safe_v2(code)
        )) OR (nested ? 'status_code' AND nested->>'status_code' !~ '^\d{1,3}$')
        OR (nested ? 'state_code' AND nested->>'state_code' !~ '^[A-Z]{2}$')
      THEN RETURN false; END IF;
    WHEN 'public_web' THEN
      IF NOT public.raw_source_optional_json_type_v2(attributes,'extraction_confidence','number')
        OR jsonb_typeof(attributes->'extraction_evidence_digest')
          IS DISTINCT FROM 'string'
        OR jsonb_typeof(attributes->'source_class') IS DISTINCT FROM 'string'
        OR (attributes ? 'products' AND NOT
          public.raw_source_string_array_type_v2(attributes->'products'))
        OR (attributes ? 'keywords' AND NOT
          public.raw_source_string_array_type_v2(attributes->'keywords'))
      THEN RETURN false; END IF;
    ELSE RETURN false;
  END CASE;
  RETURN true;
END
$$;

ALTER FUNCTION raw_source_provider_payload_valid_v2(TEXT,JSONB)
  RENAME TO raw_source_provider_payload_valid_v2_legacy;

CREATE FUNCTION raw_source_provider_payload_valid_v2(
  p_provider_key TEXT,
  p_payload JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT public.raw_source_provider_payload_types_valid_v2(
    p_provider_key,p_payload
  ) THEN RETURN false; END IF;
  RETURN public.raw_source_provider_payload_valid_v2_legacy(
    p_provider_key,p_payload
  );
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$$;

CREATE FUNCTION raw_source_sanitize_derived_json_v3(
  p_value JSONB,
  p_key TEXT,
  p_depth INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  rendered JSONB;
  normalized_key TEXT := lower(regexp_replace(p_key,'[^a-z0-9]','','g'));
  semantic_identifier BOOLEAN := p_key IN (
    'cpv','fei_number','isin','k_number','lei','legal_form_code','naics',
    'notice','osm_id','owner_operator_numbers','parent_lei','parent_qid',
    'product_code','publication_number','qid','registration_number','source',
    'ultimate_parent_lei','wikidata_qid','winner_identifier'
  );
BEGIN
  IF p_depth > 6 OR normalized_key IN (
    'address','contact','contactemail','contactname','contactpoint','email',
    'firstname','fullname','lastname','mobile','ownername','person','persons',
    'phone','publicemail','publicphone','recipientname','telephone','usagent'
  ) THEN RETURN NULL; END IF;

  IF p_key IN ('products','keywords') THEN
    IF jsonb_typeof(p_value) <> 'array' OR jsonb_array_length(p_value) > 50
    THEN RETURN NULL; END IF;
    SELECT jsonb_agg(to_jsonb(item.term) ORDER BY item.first_ordinality)
    INTO rendered
    FROM (
      SELECT term.value AS term, min(term.ordinality) AS first_ordinality
      FROM jsonb_array_elements_text(p_value) WITH ORDINALITY
        AS term(value,ordinality)
      WHERE public.raw_source_controlled_business_term_v2(term.value)
        OR (p_key='products' AND term.value ~ '^[A-Z]{3}$'
          AND public.raw_source_text_contact_safe_v2(term.value))
      GROUP BY term.value
    ) AS item;
    RETURN rendered;
  END IF;

  CASE jsonb_typeof(p_value)
    WHEN 'object' THEN
      IF (SELECT count(*) FROM jsonb_object_keys(p_value)) > 64
      THEN RETURN NULL; END IF;
      SELECT coalesce(jsonb_object_agg(item.key,item.safe_value),'{}'::jsonb)
      INTO rendered
      FROM (
        SELECT entry.key,
          public.raw_source_sanitize_derived_json_v3(
            entry.value,entry.key,p_depth+1
          ) AS safe_value
        FROM jsonb_each(p_value) AS entry
      ) AS item
      WHERE item.safe_value IS NOT NULL;
      RETURN rendered;
    WHEN 'array' THEN
      IF jsonb_array_length(p_value) > 50 THEN RETURN NULL; END IF;
      SELECT coalesce(
        jsonb_agg(item.safe_value ORDER BY item.ordinality),'[]'::jsonb
      ) INTO rendered
      FROM (
        SELECT entry.ordinality,
          public.raw_source_sanitize_derived_json_v3(
            entry.value,p_key,p_depth+1
          ) AS safe_value
        FROM jsonb_array_elements(p_value) WITH ORDINALITY
          AS entry(value,ordinality)
      ) AS item
      WHERE item.safe_value IS NOT NULL;
      RETURN rendered;
    WHEN 'string' THEN
      IF normalize(p_value #>> '{}',NFKC) = (p_value #>> '{}')
        AND octet_length(p_value #>> '{}') <= 1024 AND (
        (semantic_identifier
          AND public.raw_source_text_secret_safe_v2(p_value #>> '{}'))
        OR (NOT semantic_identifier
          AND public.raw_source_text_contact_safe_v2(p_value #>> '{}'))
      ) THEN RETURN p_value; END IF;
      RETURN NULL;
    WHEN 'number' THEN RETURN p_value;
    WHEN 'boolean' THEN RETURN p_value;
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
      public.raw_source_sanitize_derived_json_v3(entry.value,entry.key,0)
        AS safe_value
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

CREATE FUNCTION raw_source_writer_command_types_valid_v2(p_command JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  field_name TEXT;
BEGIN
  IF jsonb_typeof(p_command) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_command->'schemaVersion') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_command->'recordId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_command->'workspaceId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_command->'providerKey') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_command->'sourceClass') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_command->'payload') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_command->'ingestKey') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_command->'ingestStatus') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_command->'retentionDays') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_command->'costCents') IS DISTINCT FROM 'number'
    OR p_command->>'retentionDays' !~ '^[0-9]+$'
    OR p_command->>'costCents' !~ '^[0-9]+$'
  THEN RETURN false; END IF;

  FOREACH field_name IN ARRAY ARRAY[
    'runId','sourceEntityId','externalId','sourceUrl','fetchedAt','contentHash',
    'parserVersion','dispositionCode','sourcePolicyId'
  ] LOOP
    IF jsonb_typeof(p_command->field_name) IS DISTINCT FROM 'string'
      AND jsonb_typeof(p_command->field_name) IS DISTINCT FROM 'null'
    THEN RETURN false; END IF;
  END LOOP;

  IF p_command->>'schemaVersion'='raw-source-writer/v1' THEN
    IF jsonb_typeof(p_command->'expectedPayloadHash') IS DISTINCT FROM 'string'
      OR p_command->>'expectedPayloadHash' !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(p_command->'expectedPayloadBytes') IS DISTINCT FROM 'number'
      OR p_command->>'expectedPayloadBytes' !~ '^[0-9]+$'
      OR (p_command->>'expectedPayloadBytes')::NUMERIC NOT BETWEEN 1 AND 4194304
    THEN RETURN false; END IF;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$$;

CREATE FUNCTION raw_source_nonaccepted_receipt_valid_v2(
  p_status TEXT,
  p_disposition TEXT,
  p_payload JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  has_conflict BOOLEAN := p_payload ? 'conflictWithRawId';
BEGIN
  IF NOT public.raw_source_json_keys_within_v2(
    p_payload,
    ARRAY['_rawReceipt','reason','originalPayloadHash','originalPayloadBytes',
      'conflictWithRawId'],
    ARRAY['_rawReceipt','reason','originalPayloadHash','originalPayloadBytes']
  ) OR jsonb_typeof(p_payload->'_rawReceipt') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'reason') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'originalPayloadHash') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'originalPayloadBytes') IS DISTINCT FROM 'number'
    OR p_payload->>'originalPayloadHash' !~ '^[0-9a-f]{64}$'
    OR p_payload->>'originalPayloadBytes' !~ '^[0-9]+$'
    OR (p_payload->>'originalPayloadBytes')::NUMERIC NOT BETWEEN 1 AND 2147483647
    OR p_payload->>'reason' IS DISTINCT FROM p_disposition
  THEN RETURN false; END IF;

  IF has_conflict AND (
    p_disposition <> 'PROCESSING_KEY_DRIFT'
    OR jsonb_typeof(p_payload->'conflictWithRawId') IS DISTINCT FROM 'string'
    OR p_payload->>'conflictWithRawId' !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) THEN RETURN false; END IF;

  IF p_status='REJECTED' THEN
    RETURN p_payload->>'_rawReceipt'='raw-source/rejected/v1'
      AND NOT has_conflict
      AND p_disposition IN (
        'INVALID_JSON','MALFORMED_PAYLOAD','UNKNOWN_PAYLOAD_FIELD',
        'UNGOVERNED_PROVIDER_PAYLOAD','PROVIDER_PAYLOAD_SCHEMA_INVALID'
      );
  ELSIF p_status='QUARANTINED' THEN
    RETURN p_payload->>'_rawReceipt'='raw-source/quarantine/v1'
      AND p_disposition IN (
        'INVALID_PROVENANCE','SOURCE_POLICY_MISSING',
        'SOURCE_POLICY_PURPOSE_NOT_ALLOWED','SOURCE_POLICY_SUSPENDED',
        'PAYLOAD_TOO_LARGE','BATCH_LIMIT_EXCEEDED','PROCESSING_KEY_DRIFT'
      );
  END IF;
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$$;

ALTER FUNCTION write_raw_source_record_v2(JSONB)
  RENAME TO write_raw_source_record_v2_legacy;

CREATE FUNCTION write_raw_source_record_v2(p_command JSONB)
RETURNS TABLE(
  raw_record_id UUID,
  payload_hash TEXT,
  payload_bytes INTEGER,
  ingest_status TEXT,
  inserted BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  original_statement_timeout TEXT;
  command_status TEXT;
  command_disposition TEXT;
  command_source_url TEXT;
  command_fetched_at TEXT;
  command_content_hash TEXT;
  command_parser_version TEXT;
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_user IS NOT DISTINCT FROM session_user
    OR current_setting('role',true) IS DISTINCT FROM 'none'
  THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_DENIED' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p_command) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_COMMAND_INVALID' USING ERRCODE='22023';
  END IF;
  IF pg_column_size(p_command) > 4 * 1024 * 1024 THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_COMMAND_BOUNDS' USING ERRCODE='54000';
  END IF;
  IF octet_length(p_command::text) > 4 * 1024 * 1024 THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_COMMAND_BOUNDS' USING ERRCODE='54000';
  END IF;
  IF NOT public.raw_source_writer_command_types_valid_v2(p_command) THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_COMMAND_INVALID' USING ERRCODE='22023';
  END IF;

  command_status := p_command->>'ingestStatus';
  command_disposition := p_command->>'dispositionCode';
  command_source_url := p_command->>'sourceUrl';
  command_fetched_at := p_command->>'fetchedAt';
  command_content_hash := p_command->>'contentHash';
  command_parser_version := p_command->>'parserVersion';

  IF command_status IN ('REJECTED','QUARANTINED') THEN
    IF jsonb_typeof(p_command->'externalId') IS DISTINCT FROM 'null'
      OR NOT public.raw_source_nonaccepted_receipt_valid_v2(
        command_status,command_disposition,p_command->'payload'
      )
      OR (command_source_url IS NOT NULL
        AND NOT public.raw_source_safe_https_url_v2(command_source_url))
      OR (command_fetched_at IS NOT NULL AND command_fetched_at !~
        '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')
      OR (command_content_hash IS NOT NULL
        AND command_content_hash !~ '^[0-9a-f]{64}$')
      OR (command_parser_version IS NOT NULL AND (
        octet_length(command_parser_version) NOT BETWEEN 1 AND 256
        OR command_parser_version !~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$'
        OR NOT public.raw_source_text_contact_safe_v2(command_parser_version)
      ))
    THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_RECEIPT_INVALID'
      USING ERRCODE='23514'; END IF;
  END IF;

  original_statement_timeout := current_setting('statement_timeout');
  BEGIN
    RETURN QUERY SELECT *
    FROM public.write_raw_source_record_v2_legacy(p_command);
    PERFORM set_config('statement_timeout',original_statement_timeout,true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('statement_timeout',original_statement_timeout,true);
    RAISE;
  END;
END
$$;

-- Re-run the historical Canonical projection with the corrected exact product
-- code predicate. FieldEvidence unsafe values were already value-free in 1400.
UPDATE canonical_company company
SET attributes = public.sanitize_canonical_company_attributes_v2(
  company.attributes
),
    version = company.version + 1,
    updated_at = statement_timestamp()
WHERE company.attributes IS DISTINCT FROM
  public.sanitize_canonical_company_attributes_v2(company.attributes);

REVOKE ALL ON FUNCTION raw_source_decimal_fold_v2(TEXT) FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_optional_json_type_v2(JSONB,TEXT,TEXT) FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_string_array_type_v2(JSONB) FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_provider_payload_types_valid_v2(TEXT,JSONB) FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_provider_payload_valid_v2_legacy(TEXT,JSONB) FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_provider_payload_valid_v2(TEXT,JSONB) FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_sanitize_derived_json_v3(JSONB,TEXT,INTEGER) FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION sanitize_canonical_company_attributes_v2(JSONB) FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_writer_command_types_valid_v2(JSONB) FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_nonaccepted_receipt_valid_v2(TEXT,TEXT,JSONB) FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION write_raw_source_record_v2_legacy(JSONB) FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION write_raw_source_record_v2(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION write_raw_source_record_v2(JSONB) TO app_user;

COMMIT;
