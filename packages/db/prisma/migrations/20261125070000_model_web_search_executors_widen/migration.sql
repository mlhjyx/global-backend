-- Batch 1.4-D: widen model_web_search.searchExecutor in raw_source_provider_payload_valid_v2_legacy
-- to match TypeScript raw-source-provider-schema.ts (PR #1098 enabled MODEL_WEB_SEARCH_EXECUTOR=auto
-- with serper/brave/exa/kimi/auto, which live run 607b314d proved was rejected by the legacy
-- ('deepseek','searxng')-only SQL check). Pure widen; all other providers and rules unchanged.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

CREATE OR REPLACE FUNCTION public.raw_source_provider_payload_valid_v2_legacy(p_provider_key text, p_payload jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
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
        attributes, ARRAY['discoveredBy','evidenceUrls','searchExecutor','searchQuery'],
        ARRAY['discoveredBy','evidenceUrls','searchExecutor','searchQuery']
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

COMMIT;
