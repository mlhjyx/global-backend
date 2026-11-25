-- Batch 1.5-B:
-- 1) Make model_web_search.attributes.searchQuery truly optional in
--    raw_source_provider_payload_valid_v2_legacy to match TypeScript
--    raw-source-provider-normalizer.ts (live run d7cb9523 rolled back 33 real
--    Italian PV companies whose LLM candidates omitted searchQuery).
-- 2) Add three-tier fallback admission (`directory:public_b2b_listing`) to
--    raw_source_policy_binding_v3 for provider `directory`, mirroring
--    `public_web:company_site`:
--      Tier 1: explicit site policy covering host ALWAYS wins (incl. SUSPENDED)
--      Tier 2: closed deny-list of social/data-broker/paid-directory/marketplace
--              hosts never falls back
--      Tier 3: other public B2B listing hosts bind to `directory:public_b2b_listing`
--              when APPROVED with purpose `discovery`.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

CREATE OR REPLACE FUNCTION public.raw_source_provider_payload_valid_v2_legacy(p_provider_key text, p_payload jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  allowed_keys TEXT[];
  attributes JSONB;
  provenance JSONB;
  identifier JSONB;
  nested JSONB;
  external_id TEXT;
  company_name TEXT;
BEGIN
  IF jsonb_typeof(p_payload) <> 'object'
    OR NOT public.raw_source_json_shape_valid_v2(p_payload, 6, 256)
  THEN RETURN false; END IF;

  CASE p_provider_key
    WHEN 'registry' THEN allowed_keys := ARRAY[
      'attributes','country','domain','employeeCount','externalId','identifier',
      'license','name','provenance','revenueUsd'
    ];
    WHEN 'directory' THEN allowed_keys := ARRAY[
      'attributes','country','domain','externalId','name','provenance'
    ];
    WHEN 'wikidata' THEN allowed_keys := ARRAY[
      'attributes','country','domain','employeeCount','externalId','license',
      'name','provenance'
    ];
    WHEN 'openstreetmap' THEN allowed_keys := ARRAY[
      'attributes','country','domain','externalId','license','name','provenance'
    ];
    WHEN 'trade_fair' THEN allowed_keys := ARRAY[
      'attributes','country','domain','externalId','license','monitoredSource',
      'name','provenance'
    ];
    WHEN 'ted' THEN allowed_keys := ARRAY[
      'attributes','country','domain','externalId','identifier','license','name',
      'provenance'
    ];
    WHEN 'openfda' THEN allowed_keys := ARRAY[
      'attributes','country','domain','externalId','identifier','license','name',
      'provenance'
    ];
    WHEN 'public_web' THEN allowed_keys := ARRAY[
      'attributes','country','domain','employeeCount','externalId','license',
      'name','provenance'
    ];
    WHEN 'opencorporates' THEN allowed_keys := ARRAY[
      'attributes','country','domain','externalId','identifier','license','name',
      'provenance'
    ];
    WHEN 'model_web_search' THEN allowed_keys := ARRAY[
      'attributes','country','domain','externalId','name','provenance'
    ];
    WHEN 'companies_house_registry' THEN allowed_keys := ARRAY[
      'attributes','country','domain','externalId','identifier','license','name',
      'provenance'
    ];
    ELSE RETURN false;
  END CASE;
  IF NOT public.raw_source_json_keys_within_v2(
    p_payload, allowed_keys, ARRAY['attributes','name','provenance']
  ) THEN RETURN false; END IF;

  attributes := p_payload->'attributes';
  provenance := p_payload->'provenance';
  identifier := p_payload->'identifier';
  external_id := p_payload->>'externalId';
  company_name := p_payload->>'name';
  IF jsonb_typeof(attributes) <> 'object'
    OR company_name IS NULL
    OR octet_length(company_name) NOT BETWEEN 1 AND 160
    OR company_name !~ '^[[:alnum:]][[:alnum:] ._+&''(),/#:-]*$'
    OR NOT public.raw_source_text_contact_safe_v2(company_name)
    OR (external_id IS NOT NULL AND (
      octet_length(external_id) NOT BETWEEN 1 AND 256
      OR external_id !~ '^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$'
      OR NOT public.raw_source_text_secret_safe_v2(external_id)
      OR (p_provider_key NOT IN ('wikidata','openstreetmap','ted','openfda','opencorporates','companies_house_registry')
        AND NOT public.raw_source_text_contact_safe_v2(external_id))
    ))
    OR (p_payload ? 'domain' AND (
      p_payload->>'domain' <> lower(p_payload->>'domain')
      OR p_payload->>'domain' !~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
    ))
    OR (p_payload ? 'country' AND p_payload->>'country' !~ '^[A-Z]{2}$')
    OR (p_payload ? 'employeeCount' AND (
      jsonb_typeof(p_payload->'employeeCount') <> 'number'
      OR (p_payload->>'employeeCount')::NUMERIC NOT BETWEEN 0 AND 10000000000
      OR trunc((p_payload->>'employeeCount')::NUMERIC)
        <> (p_payload->>'employeeCount')::NUMERIC
    ))
    OR (p_payload ? 'revenueUsd' AND (
      jsonb_typeof(p_payload->'revenueUsd') <> 'number'
      OR (p_payload->>'revenueUsd')::NUMERIC NOT BETWEEN 0 AND 1000000000000000
    ))
    OR NOT public.raw_source_identifier_valid_v2(p_provider_key, identifier)
  THEN RETURN false; END IF;

  IF NOT public.raw_source_json_keys_within_v2(
    provenance,
    ARRAY['contentHash','fetchedAt','parserVersion','sourceUrl'],
    ARRAY['contentHash','fetchedAt','parserVersion','sourceUrl']
  ) OR provenance->>'contentHash' !~ '^[0-9a-f]{64}$'
    OR provenance->>'fetchedAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    OR provenance->>'parserVersion' !~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,63}$'
    OR NOT public.raw_source_text_contact_safe_v2(provenance->>'parserVersion')
    OR NOT public.raw_source_safe_https_url_v2(provenance->>'sourceUrl')
  THEN RETURN false; END IF;

  CASE p_provider_key
    WHEN 'registry' THEN
      IF NOT public.raw_source_json_keys_within_v2(
        attributes, ARRAY['employee_band','employees','products']
      ) OR (attributes ? 'employee_band' AND
          attributes->>'employee_band' !~ '^\d{1,7}(?:-\d{1,7}|\+)$')
        OR (attributes ? 'employees' AND (
          jsonb_typeof(attributes->'employees') <> 'number'
          OR (attributes->>'employees')::NUMERIC NOT BETWEEN 0 AND 10000000000
          OR trunc((attributes->>'employees')::NUMERIC)
            <> (attributes->>'employees')::NUMERIC
        ))
        OR (attributes ? 'products' AND (
          jsonb_typeof(attributes->'products') <> 'array'
          OR jsonb_array_length(attributes->'products') > 20
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(attributes->'products') item
            WHERE jsonb_typeof(item) <> 'string'
              OR NOT public.raw_source_controlled_business_term_v2(item #>> '{}')))
        )
        OR (p_payload ? 'license' AND p_payload->>'license' NOT IN ('public','licensed','byo'))
      THEN RETURN false; END IF;
    WHEN 'directory' THEN
      IF NOT public.raw_source_json_keys_within_v2(
        attributes,
        ARRAY['detail_url','source_class','source_directory','source_kind'],
        ARRAY['source_class','source_directory','source_kind']
      ) OR attributes->>'source_class' <> 'industry_data'
        OR attributes->>'source_kind' <> 'directory'
        OR attributes->>'source_directory' !~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
        OR (attributes ? 'detail_url'
          AND NOT public.raw_source_safe_https_url_v2(attributes->>'detail_url'))
        OR (
          p_payload ? 'domain'
          AND external_id IS DISTINCT FROM
            ('directory:' || (p_payload->>'domain'))
        )
        OR (
          NOT (p_payload ? 'domain')
          AND left(
            external_id,
            char_length('directory:' || (attributes->>'source_directory') || ':')
          ) IS DISTINCT FROM
            ('directory:' || (attributes->>'source_directory') || ':')
        )
      THEN RETURN false; END IF;
    WHEN 'wikidata' THEN
      IF NOT public.raw_source_json_keys_within_v2(
        attributes, ARRAY['latitude','longitude','source_class','wikidata_qid'],
        ARRAY['source_class','wikidata_qid']
      ) OR attributes->>'wikidata_qid' !~ '^Q[1-9]\d{0,15}$'
        OR external_id IS DISTINCT FROM
          ('wikidata:' || (attributes->>'wikidata_qid'))
        OR attributes->>'source_class' NOT IN ('company_registry','industry_data')
        OR (attributes ? 'latitude' AND (
          jsonb_typeof(attributes->'latitude') <> 'number'
          OR (attributes->>'latitude')::NUMERIC NOT BETWEEN -90 AND 90))
        OR (attributes ? 'longitude' AND (
          jsonb_typeof(attributes->'longitude') <> 'number'
          OR (attributes->>'longitude')::NUMERIC NOT BETWEEN -180 AND 180))
        OR p_payload->>'license' IS DISTINCT FROM 'CC0-1.0'
      THEN RETURN false; END IF;
    WHEN 'openstreetmap' THEN
      IF NOT public.raw_source_json_keys_within_v2(
        attributes, ARRAY['latitude','longitude','osm_id','source_class'],
        ARRAY['osm_id','source_class']
      ) OR attributes->>'osm_id' !~ '^(node|way|relation)/\d{1,20}$'
        OR external_id IS DISTINCT FROM ('osm:' || (attributes->>'osm_id'))
        OR attributes->>'source_class' <> 'industry_data'
        OR (attributes ? 'latitude' AND (
          jsonb_typeof(attributes->'latitude') <> 'number'
          OR (attributes->>'latitude')::NUMERIC NOT BETWEEN -90 AND 90))
        OR (attributes ? 'longitude' AND (
          jsonb_typeof(attributes->'longitude') <> 'number'
          OR (attributes->>'longitude')::NUMERIC NOT BETWEEN -180 AND 180))
        OR p_payload->>'license' IS DISTINCT FROM 'ODbL-1.0'
      THEN RETURN false; END IF;
    WHEN 'trade_fair' THEN
      IF NOT public.raw_source_json_keys_within_v2(
        attributes,
        ARRAY['hall','hiring_signal','products','source_class','source_fair',
          'source_kind','stand']
      ) OR (attributes ? 'source_class'
          AND attributes->>'source_class' <> 'industry_data')
        OR (attributes ? 'hall' AND (
          jsonb_typeof(attributes->'hall') <> 'string'
          OR octet_length(attributes->>'hall') > 40
          OR attributes->>'hall' !~ '^[[:alnum:]][[:alnum:] ._+&''(),/#:-]*$'
          OR NOT public.raw_source_text_contact_safe_v2(attributes->>'hall')))
        OR (attributes ? 'stand' AND (
          jsonb_typeof(attributes->'stand') <> 'string'
          OR octet_length(attributes->>'stand') > 40
          OR attributes->>'stand' !~ '^[[:alnum:]][[:alnum:] ._+&''(),/#:-]*$'
          OR NOT public.raw_source_text_contact_safe_v2(attributes->>'stand')))
        OR (attributes ? 'hiring_signal'
          AND jsonb_typeof(attributes->'hiring_signal') <> 'boolean')
        OR (attributes ? 'source_fair' AND (
          jsonb_typeof(attributes->'source_fair') <> 'string'
          OR octet_length(attributes->>'source_fair') > 80
          OR attributes->>'source_fair' !~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,79}$'
          OR NOT public.raw_source_text_contact_safe_v2(attributes->>'source_fair')))
        OR (attributes ? 'source_kind' AND (
          jsonb_typeof(attributes->'source_kind') <> 'string'
          OR octet_length(attributes->>'source_kind') > 80
          OR attributes->>'source_kind' !~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,79}$'
          OR NOT public.raw_source_text_contact_safe_v2(attributes->>'source_kind')))
        OR (attributes ? 'products' AND (
          jsonb_typeof(attributes->'products') <> 'array'
          OR jsonb_array_length(attributes->'products') > 20
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(attributes->'products') item
            WHERE jsonb_typeof(item) <> 'string'
              OR NOT public.raw_source_controlled_business_term_v2(item #>> '{}')))
        )
        OR (p_payload ? 'license' AND p_payload->>'license'
          NOT IN ('SOURCE_SPECIFIC_RESTRICTED','public'))
      THEN RETURN false; END IF;
      IF p_payload ? 'monitoredSource' AND NOT public.raw_source_json_keys_within_v2(
        p_payload->'monitoredSource',
        ARRAY['originProviderKey','sourceEntityId','sourceExternalId',
          'sourceFetchId','sourceId','sourceKey'],
        ARRAY['originProviderKey','sourceEntityId','sourceExternalId',
          'sourceFetchId','sourceId','sourceKey']
      ) THEN RETURN false; END IF;
      IF p_payload ? 'monitoredSource' THEN
        nested := p_payload->'monitoredSource';
        IF nested->>'sourceId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          OR nested->>'sourceEntityId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          OR nested->>'sourceFetchId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          OR nested->>'originProviderKey' NOT IN ('mapyourshow','trade_fair')
          OR NOT public.raw_source_text_contact_safe_v2(nested->>'sourceExternalId')
          OR octet_length(nested->>'sourceKey') > 128
          OR nested->>'sourceKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$'
          OR NOT public.raw_source_text_contact_safe_v2(nested->>'sourceKey')
          OR external_id !~ '^monitored:[0-9a-f]{64}$'
        THEN RETURN false; END IF;
      ELSIF NOT (attributes ? 'source_fair'
        AND attributes->>'source_class' = 'industry_data'
        AND left(
          external_id,
          char_length((attributes->>'source_fair') || ':')
        ) = (attributes->>'source_fair') || ':')
      THEN RETURN false;
      END IF;
    WHEN 'ted' THEN
      IF NOT public.raw_source_json_keys_within_v2(
        attributes, ARRAY['ted'], ARRAY['ted']
      ) THEN RETURN false; END IF;
      nested := attributes->'ted';
      IF NOT public.raw_source_json_keys_within_v2(
        nested, ARRAY['buyer_countries','cpv','notice_type','publication_date',
          'publication_number','winner_identifier'],
        ARRAY['notice_type','publication_date','publication_number']
      ) OR nested->>'publication_number' !~ '^\d{1,9}(?:-\d{4})?$'
        OR nested->>'publication_date' !~ '^\d{4}-\d{2}-\d{2}$'
        OR to_char((nested->>'publication_date')::DATE,'YYYY-MM-DD')
          <> nested->>'publication_date'
        OR nested->>'notice_type' !~ '^(award|can|cn|pin|veat)(?:-[a-z0-9]+)*$'
        OR p_payload->>'license' IS DISTINCT FROM 'CC BY 4.0'
        OR external_id !~
          ('^ted:' || (nested->>'publication_number') || ':\d+$')
        OR (nested ? 'cpv' AND (
          jsonb_typeof(nested->'cpv') <> 'array'
          OR jsonb_array_length(nested->'cpv') > 20
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(nested->'cpv') item
            WHERE jsonb_typeof(item) <> 'string'
              OR item #>> '{}' !~ '^\d{8}$')))
        OR (nested ? 'buyer_countries' AND (
          jsonb_typeof(nested->'buyer_countries') <> 'array'
          OR jsonb_array_length(nested->'buyer_countries') > 20
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(nested->'buyer_countries') item
            WHERE jsonb_typeof(item) <> 'string'
              OR item #>> '{}' !~ '^[A-Z]{2,3}$')))
        OR (nested ? 'winner_identifier' AND (
          jsonb_typeof(nested->'winner_identifier') <> 'string'
          OR octet_length(nested->>'winner_identifier') > 80
          OR NOT public.raw_source_text_secret_safe_v2(nested->>'winner_identifier')))
        OR (identifier IS NOT NULL AND identifier->>'value'
          IS DISTINCT FROM nested->>'winner_identifier')
      THEN RETURN false; END IF;
    WHEN 'openfda' THEN
      IF NOT public.raw_source_json_keys_within_v2(
        attributes, ARRAY['fda','products'], ARRAY['fda']
      ) THEN RETURN false; END IF;
      nested := attributes->'fda';
      IF NOT public.raw_source_json_keys_within_v2(
        nested, ARRAY['created_date','fei_number','initial_importer',
          'owner_operator_numbers','product_codes','registration_number',
          'state_code','status_code']
      ) OR p_payload->>'license' IS DISTINCT FROM 'CC0-1.0'
        OR NOT (nested ? 'registration_number' OR nested ? 'fei_number'
          OR jsonb_array_length(coalesce(nested->'product_codes','[]'::jsonb)) > 0)
        OR (nested ? 'registration_number'
          AND nested->>'registration_number' !~ '^\d{1,32}$')
        OR (identifier IS NOT NULL AND (
          identifier->>'value' IS DISTINCT FROM nested->>'registration_number'
          OR external_id IS DISTINCT FROM
            ('openfda:' || (identifier->>'value'))
        ))
        OR (nested ? 'registration_number' AND identifier IS NULL)
        OR external_id !~ '^openfda:(\d{1,32}|[0-9a-f]{64})$'
        OR (nested ? 'fei_number' AND nested->>'fei_number' !~ '^\d{1,32}$')
        OR (nested ? 'status_code' AND (
          jsonb_typeof(nested->'status_code') <> 'string'
          OR nested->>'status_code' !~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,31}$'
          OR NOT public.raw_source_text_contact_safe_v2(nested->>'status_code')))
        OR (nested ? 'state_code' AND nested->>'state_code' !~ '^[A-Z0-9]{2,3}$')
        OR (nested ? 'initial_importer'
          AND jsonb_typeof(nested->'initial_importer') <> 'boolean')
        OR (nested ? 'created_date' AND (
          nested->>'created_date' !~ '^\d{4}-\d{2}-\d{2}$'
          OR to_char((nested->>'created_date')::DATE,'YYYY-MM-DD')
            <> nested->>'created_date'))
        OR (nested ? 'product_codes' AND (
          jsonb_typeof(nested->'product_codes') <> 'array'
          OR jsonb_array_length(nested->'product_codes') > 20
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(nested->'product_codes') item
            WHERE jsonb_typeof(item) <> 'string'
              OR item #>> '{}' !~ '^[A-Z0-9]{2,10}$')))
        OR (nested ? 'owner_operator_numbers' AND (
          jsonb_typeof(nested->'owner_operator_numbers') <> 'array'
          OR jsonb_array_length(nested->'owner_operator_numbers') > 20
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(nested->'owner_operator_numbers') item
            WHERE jsonb_typeof(item) <> 'string'
              OR item #>> '{}' !~ '^\d{1,32}$')))
        OR (attributes ? 'products' AND (
          jsonb_typeof(attributes->'products') <> 'array'
          OR jsonb_array_length(attributes->'products') > 20
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(attributes->'products') item
            WHERE jsonb_typeof(item) <> 'string'
              OR item #>> '{}' !~ '^[A-Z0-9]{2,10}$')))
      THEN RETURN false; END IF;
    WHEN 'public_web' THEN
      IF NOT public.raw_source_json_keys_within_v2(
        attributes, ARRAY['extraction_confidence','extraction_evidence_digest',
          'keywords','products','source_class'],
        ARRAY['extraction_confidence','extraction_evidence_digest','keywords',
          'products','source_class']
      ) OR jsonb_typeof(attributes->'extraction_confidence') <> 'number'
        OR (attributes->>'extraction_confidence')::NUMERIC NOT BETWEEN 0 AND 1
        OR attributes->>'extraction_evidence_digest' !~ '^[0-9a-f]{64}$'
        OR attributes->>'source_class' NOT IN ('public_intelligence','industry_data')
        OR external_id IS DISTINCT FROM (p_payload->>'domain')
        OR (p_payload ? 'license' AND p_payload->>'license' NOT IN ('public','licensed','byo'))
        OR jsonb_typeof(attributes->'products') <> 'array'
        OR jsonb_array_length(attributes->'products') > 20
        OR jsonb_typeof(attributes->'keywords') <> 'array'
        OR jsonb_array_length(attributes->'keywords') > 20
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(
            (attributes->'products') || (attributes->'keywords')
          ) item WHERE jsonb_typeof(item) <> 'string'
            OR NOT public.raw_source_controlled_business_term_v2(item #>> '{}')
        )
      THEN RETURN false; END IF;
    WHEN 'opencorporates' THEN
      IF jsonb_typeof(attributes->'opencorporates') IS DISTINCT FROM 'object'
      THEN RETURN false; END IF;
      nested := attributes->'opencorporates';
      IF jsonb_typeof(nested->'company_number') IS DISTINCT FROM 'string'
        OR jsonb_typeof(nested->'jurisdiction_code') IS DISTINCT FROM 'string'
        OR NOT public.raw_source_optional_json_type_v2(nested,'status','string')
        OR NOT public.raw_source_optional_json_type_v2(nested,'company_type','string')
        OR NOT public.raw_source_optional_json_type_v2(nested,'incorporation_date','string')
        OR NOT public.raw_source_optional_json_type_v2(nested,'dissolution_date','string')
        OR NOT public.raw_source_optional_json_type_v2(nested,'registered_address','string')
        OR (p_payload ? 'license' AND p_payload->>'license' NOT IN ('ODbL-1.0'))
      THEN RETURN false; END IF;
    WHEN 'companies_house_registry' THEN
      IF jsonb_typeof(attributes->'ch_registry') IS DISTINCT FROM 'object'
      THEN RETURN false; END IF;
      nested := attributes->'ch_registry';
      IF jsonb_typeof(nested->'company_number') IS DISTINCT FROM 'string'
        OR NOT public.raw_source_optional_json_type_v2(nested,'company_status','string')
        OR (p_payload ? 'license' AND p_payload->>'license' NOT IN ('OGL-UK-3.0'))
      THEN RETURN false; END IF;
    WHEN 'model_web_search' THEN
      IF NOT public.raw_source_json_keys_within_v2(
        attributes,
        ARRAY['discoveredBy','evidenceUrls','searchExecutor','searchQuery'],
        ARRAY['discoveredBy','evidenceUrls','searchExecutor']
      ) THEN RETURN false; END IF;
      IF attributes->>'discoveredBy' IS DISTINCT FROM 'model_web_search'
        OR attributes->>'searchExecutor' NOT IN ('deepseek','searxng','serper','brave','exa')
        OR jsonb_typeof(attributes->'evidenceUrls') <> 'array'
        OR jsonb_array_length(attributes->'evidenceUrls') NOT BETWEEN 1 AND 3
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(attributes->'evidenceUrls') item
          WHERE jsonb_typeof(item) <> 'string'
            OR NOT public.raw_source_safe_https_url_v2(item #>> '{}'))
        OR (attributes ? 'searchQuery' AND jsonb_typeof(attributes->'searchQuery')
          IS DISTINCT FROM 'string' AND attributes->'searchQuery' <> 'null'::jsonb)
        OR p_payload ? 'identifier'
      THEN RETURN false; END IF;
  END CASE;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$function$;

REVOKE ALL ON FUNCTION public.raw_source_provider_payload_valid_v2_legacy(TEXT,JSONB) FROM PUBLIC, app_user;

CREATE OR REPLACE FUNCTION public.raw_source_policy_binding_v3(
  p_provider_key text,
  p_ingest_status text,
  p_source_host text,
  p_payload jsonb,
  p_policy_id uuid,
  p_retention_days integer
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  bound_policy RECORD;
  host_key TEXT;
  bound_key TEXT;
  covering_length INTEGER;
  covering_unapproved BOOLEAN;
  purpose_allowed BOOLEAN;
BEGIN
  IF p_policy_id IS NULL THEN
    IF p_ingest_status='ACCEPTED' THEN
      RAISE EXCEPTION 'RAW_SOURCE_WRITER_POLICY_BINDING_INVALID' USING ERRCODE='23514';
    END IF;
    RETURN jsonb_build_object(
      'kind','missing','retentionDays',p_retention_days,
      'allowedPurpose','[]'::jsonb,'minimizedFields','[]'::jsonb
    );
  END IF;

  SELECT policy."id",policy."domain",policy."retention_days",
    policy."review_status",policy."updated_at",policy."allowed_purpose"
  INTO bound_policy FROM public.source_policy policy
  WHERE policy."id"=p_policy_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_POLICY_BINDING_INVALID' USING ERRCODE='23514';
  END IF;
  IF p_source_host IS NULL
    OR p_retention_days IS DISTINCT FROM bound_policy.retention_days
  THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_POLICY_BINDING_INVALID'
    USING ERRCODE='23514'; END IF;

  -- The most specific site policies covering the host: equal to it or a parent domain of it,
  -- both sides with ASCII lower case and without one leading "www.".
  host_key := regexp_replace(p_source_host, '^www\.', '');
  SELECT covering.key_length, covering.unapproved
  INTO covering_length, covering_unapproved
  FROM (
    SELECT char_length(site.site_key) AS key_length,
      bool_or(site.review_status IS DISTINCT FROM 'APPROVED') AS unapproved
    FROM (
      SELECT regexp_replace(translate(candidate."domain",
        'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), '^www\.', '') AS site_key,
        candidate."review_status" AS review_status
      FROM public.source_policy candidate
      WHERE candidate."domain" NOT IN ('public_web:company_site', 'directory:public_b2b_listing')
    ) site
    WHERE site.site_key=host_key
      OR right(host_key,char_length(site.site_key)+1)='.' || site.site_key
    GROUP BY char_length(site.site_key)
    ORDER BY char_length(site.site_key) DESC
    LIMIT 1
  ) covering;

  IF bound_policy.domain='public_web:company_site' THEN
    -- The company-site policy: public_web / model_web_search only, never over a site
    -- policy, and an ACCEPTED record only on its own domain.
    IF p_provider_key NOT IN ('public_web','model_web_search')
      OR covering_length IS NOT NULL
      OR (p_ingest_status='ACCEPTED'
        AND regexp_replace(p_source_host,'^www\.','')
          IS DISTINCT FROM p_payload->>'domain')
    THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_POLICY_BINDING_INVALID'
      USING ERRCODE='23514'; END IF;
  ELSIF bound_policy.domain='directory:public_b2b_listing' THEN
    -- The public B2B listing fallback policy: directory only, never over a site policy,
    -- and never for social networks, commercial data brokers, paid/closed directories,
    -- marketplaces or search engines.
    IF p_provider_key IS DISTINCT FROM 'directory'
      OR covering_length IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM unnest(ARRAY[
          'linkedin.com','facebook.com','instagram.com','x.com','twitter.com',
          'xing.com','youtube.com','tiktok.com','reddit.com','pinterest.com',
          'wikipedia.org','zoominfo.com','apollo.io','lusha.com','rocketreach.co',
          'hunter.io','prospeo.io','clearbit.com','crunchbase.com','dnb.com',
          'pitchbook.com','bloomberg.com','statista.com','owler.com',
          'signalhire.com','contactout.com','kaspr.io','cognism.com',
          'kompass.com','europages.com','europages.co.uk','europages.de',
          'europages.fr','europages.it','europages.es','yelp.com','trustpilot.com',
          'glassdoor.com','indeed.com','yellowpages.com','paginegialle.it',
          'gelbeseiten.de','wlw.de','wlw.com','thomasnet.com','dunsguide.com',
          'amazon.com','amazon.it','amazon.de','ebay.com','alibaba.com',
          '1688.com','made-in-china.com','globalsources.com','indiamart.com',
          'google.com','bing.com','duckduckgo.com'
        ]) AS blocked(domain)
        WHERE host_key = blocked.domain
          OR right(host_key, char_length(blocked.domain) + 1) = '.' || blocked.domain
      )
    THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_POLICY_BINDING_INVALID'
      USING ERRCODE='23514'; END IF;
  ELSE
    -- A site policy: one of the most specific covering the host; an ACCEPTED record also
    -- needs every equally specific one APPROVED.
    bound_key := regexp_replace(translate(bound_policy.domain,
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), '^www\.', '');
    IF NOT (bound_key=host_key
        OR right(host_key,char_length(bound_key)+1)='.' || bound_key)
      OR char_length(bound_key) IS DISTINCT FROM covering_length
      OR (p_ingest_status='ACCEPTED' AND covering_unapproved)
    THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_POLICY_BINDING_INVALID'
      USING ERRCODE='23514'; END IF;
  END IF;

  purpose_allowed := CASE
    WHEN jsonb_typeof(bound_policy.allowed_purpose) IS DISTINCT FROM 'array' THEN false
    WHEN jsonb_array_length(bound_policy.allowed_purpose)=0 THEN false
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(bound_policy.allowed_purpose) item
      WHERE jsonb_typeof(item) <> 'string') THEN false
    ELSE bound_policy.allowed_purpose @> '["discovery"]'::jsonb
  END;
  IF p_ingest_status='ACCEPTED' AND (NOT purpose_allowed
    OR bound_policy.review_status IS DISTINCT FROM 'APPROVED')
  THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_POLICY_BINDING_INVALID'
    USING ERRCODE='23514'; END IF;

  RETURN jsonb_build_object(
    'kind','source_policy','id',bound_policy.id,'domain',bound_policy.domain,
    'retentionDays',bound_policy.retention_days,
    'reviewStatus',bound_policy.review_status,
    'allowedPurpose',CASE WHEN purpose_allowed
      THEN '["discovery"]'::jsonb ELSE '[]'::jsonb END,
    'updatedAt',to_char(bound_policy.updated_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'minimizedFields','[]'::jsonb
  );
END
$function$;

REVOKE ALL ON FUNCTION public.raw_source_policy_binding_v3(TEXT,TEXT,TEXT,JSONB,UUID,INTEGER) FROM PUBLIC, app_user;

COMMIT;
