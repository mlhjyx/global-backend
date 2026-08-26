-- Harden the controlled Raw writer for a hostile app_user SQL principal.
-- 0900/1000/1100/1200 are immutable; this migration is DDL/privilege only.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

CREATE FUNCTION raw_source_text_secret_safe_v2(p_value TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT octet_length(p_value) BETWEEN 1 AND 2048
    AND p_value !~ '[[:cntrl:]]'
    AND p_value !~* '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}'
    AND p_value !~* '(^|[^[:alnum:]])(bearer|basic auth|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|password|passwd|private[_ -]?key|first[_ -]?name|last[_ -]?name|full[_ -]?name|contact[_ -]?name|personal data|jane doe|john doe|john smith|alice van smith)($|[^[:alnum:]])'
    AND p_value !~* '(^|[^[:alnum:]])sk-[a-z0-9_-]{6,}'
$$;

CREATE FUNCTION raw_source_text_contact_safe_v2(p_value TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT public.raw_source_text_secret_safe_v2(p_value)
    AND p_value !~ '(^|[^[:alnum:]])([+]?[0-9][ ()\.-]*){7,}($|[^[:alnum:]])'
$$;

CREATE FUNCTION raw_source_safe_https_url_v2(p_value TEXT)
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

CREATE FUNCTION raw_source_json_keys_within_v2(
  p_value JSONB,
  p_allowed TEXT[],
  p_required TEXT[] DEFAULT ARRAY[]::TEXT[]
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_typeof(p_value) = 'object'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_object_keys(p_value) AS item(key)
      WHERE NOT item.key = ANY(p_allowed)
    )
    AND NOT EXISTS (
      SELECT 1 FROM unnest(p_required) AS required(key)
      WHERE NOT p_value ? required.key
    )
$$;

CREATE FUNCTION raw_source_json_shape_valid_v2(
  p_value JSONB,
  p_max_depth INTEGER,
  p_max_nodes INTEGER
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  WITH RECURSIVE walk(value, depth) AS (
    SELECT p_value, 0
    UNION ALL
    SELECT child.value, walk.depth + 1
    FROM walk
    CROSS JOIN LATERAL (
      SELECT item.value
      FROM jsonb_each(
        CASE WHEN jsonb_typeof(walk.value) = 'object'
          THEN walk.value ELSE '{}'::jsonb END
      ) AS item
      UNION ALL
      SELECT item.value
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(walk.value) = 'array'
          THEN walk.value ELSE '[]'::jsonb END
      ) AS item
    ) AS child
    WHERE walk.depth <= p_max_depth
  ), bounded AS MATERIALIZED (
    SELECT depth FROM walk LIMIT p_max_nodes + 1
  )
  SELECT count(*) <= p_max_nodes AND coalesce(max(depth), 0) <= p_max_depth
  FROM bounded
$$;

CREATE FUNCTION raw_source_controlled_business_term_v2(p_value TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT octet_length(p_value) BETWEEN 1 AND 80
    AND public.raw_source_text_contact_safe_v2(p_value)
    AND (SELECT count(*) BETWEEN 1 AND 4
         FROM regexp_split_to_table(lower(p_value), '[[:space:]_-]+') AS token)
    AND NOT EXISTS (
      SELECT 1
      FROM regexp_split_to_table(lower(p_value), '[[:space:]_-]+') AS token
      WHERE token NOT IN (
        'aerospace','automation','brake','centrifugal','compressor','defense',
        'device','devices','electric','electronics','energy','engineering',
        'equipment','fabrication','hydraulic','imaging','industrial','machine',
        'machinery','manufacturing','medical','metal','motor','motors','press',
        'pump','pumps','radiological','service','services','software','system',
        'systems','technology','valve','valves'
      )
    )
$$;

CREATE FUNCTION raw_source_identifier_valid_v2(
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
        AND identifier_value ~ '^[[:alnum:]][[:alnum:] ._:/-]{0,79}$';
    WHEN 'openfda' THEN
      RETURN identifier_scheme = 'fda-reg'
        AND identifier_value ~ '^[0-9]{1,32}$';
    ELSE RETURN false;
  END CASE;
END
$$;

CREATE FUNCTION raw_source_provider_payload_valid_v2(
  p_provider_key TEXT,
  p_payload JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
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
      OR (p_provider_key NOT IN ('wikidata','openstreetmap','ted','openfda')
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
  END CASE;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$$;

CREATE FUNCTION raw_source_ingest_key_v2(p_payload JSONB, p_payload_hash TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
DECLARE
  identity_basis JSONB;
BEGIN
  IF nullif(p_payload->>'externalId','') IS NOT NULL THEN
    RETURN 'external:' || encode(public.digest(p_payload->>'externalId','sha256'),'hex');
  END IF;
  IF jsonb_typeof(p_payload->'identifier') = 'object' THEN
    identity_basis := jsonb_build_object(
      'scheme', lower(p_payload #>> '{identifier,scheme}'),
      'value', p_payload #>> '{identifier,value}'
    );
  ELSIF nullif(p_payload->>'domain','') IS NOT NULL
    OR nullif(p_payload->>'name','') IS NOT NULL
  THEN
    identity_basis := jsonb_strip_nulls(jsonb_build_object(
      'country', upper(nullif(p_payload->>'country','')),
      'domain', lower(nullif(p_payload->>'domain','')),
      'name', regexp_replace(lower(nullif(p_payload->>'name','')), '\s+', ' ', 'g')
    ));
  ELSE
    RETURN 'payload:' || p_payload_hash;
  END IF;
  RETURN 'identity:' || encode(public.digest(
    public.raw_source_canonical_json_v1(identity_basis), 'sha256'
  ), 'hex');
END
$$;

CREATE FUNCTION raw_source_sanitize_derived_json_v2(
  p_value JSONB,
  p_depth INTEGER DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  rendered JSONB;
BEGIN
  IF p_depth > 6 THEN RETURN NULL; END IF;
  CASE jsonb_typeof(p_value)
    WHEN 'object' THEN
      SELECT coalesce(jsonb_object_agg(item.key, item.safe_value), '{}'::jsonb)
      INTO rendered
      FROM (
        SELECT entry.key,
          CASE
            WHEN entry.key IN (
              'cpv','fei_number','isin','k_number','lei','legal_form_code',
              'naics','notice','osm_id','owner_operator_numbers','parent_lei',
              'parent_qid','product_code','publication_number','qid',
              'registration_number','source','ultimate_parent_lei',
              'wikidata_qid','winner_identifier'
            ) AND jsonb_typeof(entry.value) = 'string'
              AND public.raw_source_text_secret_safe_v2(entry.value #>> '{}')
              THEN entry.value
            WHEN entry.key IN (
              'cpv','owner_operator_numbers','product_code'
            ) AND jsonb_typeof(entry.value) = 'array'
              THEN (
                SELECT coalesce(jsonb_agg(code.value ORDER BY code.ordinality),'[]'::jsonb)
                FROM jsonb_array_elements(entry.value)
                  WITH ORDINALITY AS code(value, ordinality)
                WHERE jsonb_typeof(code.value) = 'string'
                  AND public.raw_source_text_secret_safe_v2(code.value #>> '{}')
              )
            ELSE public.raw_source_sanitize_derived_json_v2(
              entry.value, p_depth + 1
            )
          END AS safe_value
        FROM jsonb_each(p_value) AS entry
        WHERE regexp_replace(lower(entry.key), '[^a-z0-9]', '', 'g') NOT IN (
          'address','contact','contactemail','contactname','contactpoint','email',
          'firstname','fullname','lastname','mobile','ownername','person','persons',
          'phone','publicemail','publicphone','recipientname','telephone','usagent'
        )
      ) AS item
      WHERE item.safe_value IS NOT NULL;
      RETURN rendered;
    WHEN 'array' THEN
      IF jsonb_array_length(p_value) > 50 THEN RETURN NULL; END IF;
      SELECT coalesce(jsonb_agg(item.safe_value ORDER BY item.ordinality),'[]'::jsonb)
      INTO rendered
      FROM (
        SELECT entry.ordinality,
          public.raw_source_sanitize_derived_json_v2(entry.value, p_depth + 1)
            AS safe_value
        FROM jsonb_array_elements(p_value) WITH ORDINALITY AS entry(value, ordinality)
      ) AS item
      WHERE item.safe_value IS NOT NULL;
      RETURN rendered;
    WHEN 'string' THEN
      IF octet_length(p_value #>> '{}') <= 1024
        AND public.raw_source_text_contact_safe_v2(p_value #>> '{}')
      THEN RETURN p_value; END IF;
      RETURN NULL;
    WHEN 'number' THEN RETURN p_value;
    WHEN 'boolean' THEN RETURN p_value;
    WHEN 'null' THEN RETURN p_value;
    ELSE RETURN NULL;
  END CASE;
END
$$;

CREATE FUNCTION sanitize_canonical_company_attributes_v2(p_attributes JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  rendered JSONB;
BEGIN
  IF jsonb_typeof(p_attributes) <> 'object' THEN RETURN '{}'::jsonb; END IF;
  SELECT coalesce(jsonb_object_agg(item.key, item.safe_value), '{}'::jsonb)
  INTO rendered
  FROM (
    SELECT entry.key,
      CASE WHEN entry.key IN ('products','keywords') THEN (
        SELECT CASE WHEN count(*) = 0 THEN NULL ELSE jsonb_agg(term.value) END
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(entry.value) = 'array'
            THEN entry.value ELSE '[]'::jsonb END
        ) AS term(value)
        WHERE jsonb_typeof(term.value) = 'string'
          AND (
            public.raw_source_controlled_business_term_v2(term.value #>> '{}')
            OR (entry.key = 'products' AND term.value #>> '{}' ~ '^[A-Z0-9]{2,10}$')
          )
      ) ELSE public.raw_source_sanitize_derived_json_v2(entry.value, 0) END
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

CREATE OR REPLACE FUNCTION write_raw_source_record_v2(p_command JSONB)
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
  command_keys TEXT;
  command_workspace_id UUID;
  command_record_id UUID;
  command_run_id UUID;
  command_source_entity_id UUID;
  command_source_policy_id UUID;
  command_provider_key TEXT;
  command_source_class TEXT;
  command_external_id TEXT;
  command_payload JSONB;
  command_source_url TEXT;
  command_fetched_at_text TEXT;
  command_fetched_at TIMESTAMPTZ;
  command_content_hash TEXT;
  command_parser_version TEXT;
  command_ingest_key TEXT;
  command_ingest_status TEXT;
  command_disposition_code TEXT;
  command_retention_days INTEGER;
  command_cost_cents INTEGER;
  derived_hash TEXT;
  derived_bytes INTEGER;
  derived_ingest_key TEXT;
  derived_snapshot JSONB;
  derived_expires_at TIMESTAMPTZ;
  source_host TEXT;
  policy_row RECORD;
  monitored_row RECORD;
  stored_row RECORD;
  inserted_count INTEGER;
  was_inserted BOOLEAN;
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_user IS NOT DISTINCT FROM session_user
    OR current_setting('role', true) IS DISTINCT FROM 'none'
  THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_DENIED' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p_command) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_COMMAND_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('statement_timeout','5000',true);

  SELECT string_agg(key, ',' ORDER BY key COLLATE "C") INTO command_keys
  FROM jsonb_object_keys(p_command) AS key;
  IF p_command->>'schemaVersion' = 'raw-source-writer/v2' THEN
    IF command_keys IS DISTINCT FROM
      'contentHash,costCents,dispositionCode,externalId,fetchedAt,ingestKey,ingestStatus,parserVersion,payload,providerKey,recordId,retentionDays,runId,schemaVersion,sourceClass,sourceEntityId,sourcePolicyId,sourceUrl,workspaceId'
    THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_COMMAND_INVALID' USING ERRCODE='22023'; END IF;
  ELSIF p_command->>'schemaVersion' = 'raw-source-writer/v1' THEN
    IF command_keys IS DISTINCT FROM
      'contentHash,costCents,dispositionCode,expectedPayloadBytes,expectedPayloadHash,externalId,fetchedAt,ingestKey,ingestStatus,parserVersion,payload,providerKey,recordId,retentionDays,runId,schemaVersion,sourceClass,sourceEntityId,sourcePolicyId,sourceUrl,workspaceId'
    THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_COMMAND_INVALID' USING ERRCODE='22023'; END IF;
  ELSE RAISE EXCEPTION 'RAW_SOURCE_WRITER_COMMAND_INVALID' USING ERRCODE='22023';
  END IF;

  BEGIN
    command_workspace_id := (p_command->>'workspaceId')::UUID;
    command_record_id := (p_command->>'recordId')::UUID;
    command_run_id := NULLIF(p_command->>'runId','')::UUID;
    command_source_entity_id := NULLIF(p_command->>'sourceEntityId','')::UUID;
    command_source_policy_id := NULLIF(p_command->>'sourcePolicyId','')::UUID;
    command_retention_days := (p_command->>'retentionDays')::INTEGER;
    command_cost_cents := (p_command->>'costCents')::INTEGER;
    command_fetched_at_text := p_command->>'fetchedAt';
    command_fetched_at := NULLIF(command_fetched_at_text,'')::TIMESTAMPTZ;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_COMMAND_INVALID' USING ERRCODE='22023';
  END;
  command_provider_key := p_command->>'providerKey';
  command_source_class := p_command->>'sourceClass';
  command_external_id := p_command->>'externalId';
  command_payload := p_command->'payload';
  command_source_url := p_command->>'sourceUrl';
  command_content_hash := p_command->>'contentHash';
  command_parser_version := p_command->>'parserVersion';
  command_ingest_key := p_command->>'ingestKey';
  command_ingest_status := p_command->>'ingestStatus';
  command_disposition_code := p_command->>'dispositionCode';

  IF command_workspace_id IS DISTINCT FROM current_workspace_id() THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_DENIED' USING ERRCODE='42501';
  END IF;
  IF command_record_id IS NULL
    OR ((command_run_id IS NULL) = (command_source_entity_id IS NULL))
    OR jsonb_typeof(command_payload) IS DISTINCT FROM 'object'
    OR char_length(command_provider_key) NOT BETWEEN 1 AND 128
    OR char_length(command_source_class) NOT BETWEEN 1 AND 64
    OR char_length(command_ingest_key) NOT BETWEEN 1 AND 512
    OR command_retention_days NOT BETWEEN 1 AND 3650
    OR command_cost_cents NOT BETWEEN 0 AND 2147483647
    OR command_ingest_status NOT IN ('ACCEPTED','QUARANTINED','REJECTED')
    OR (command_fetched_at_text IS NOT NULL AND command_fetched_at_text !~
      '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')
    OR (command_fetched_at IS NOT NULL
      AND command_fetched_at > statement_timestamp() + interval '5 minutes')
    OR (command_ingest_status='ACCEPTED' AND command_disposition_code IS NOT NULL)
    OR (command_ingest_status IN ('QUARANTINED','REJECTED')
      AND char_length(command_disposition_code) NOT BETWEEN 1 AND 128)
  THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_COMMAND_INVALID' USING ERRCODE='22023';
  END IF;
  IF pg_column_size(command_payload) > 4 * 1024 * 1024
    OR octet_length(command_payload::text) > 4 * 1024 * 1024
    OR NOT public.raw_source_json_shape_valid_v2(
      command_payload,
      CASE WHEN command_ingest_status='ACCEPTED' THEN 6 ELSE 32 END,
      CASE WHEN command_ingest_status='ACCEPTED' THEN 256 ELSE 1000 END
    )
  THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_PAYLOAD_BOUNDS' USING ERRCODE='54000';
  END IF;

  derived_hash := public.raw_source_payload_hash_v2(command_payload);
  derived_bytes := public.raw_source_payload_bytes_v2(command_payload);
  IF derived_bytes NOT BETWEEN 1 AND 4 * 1024 * 1024 THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_PAYLOAD_BOUNDS' USING ERRCODE='54000';
  END IF;
  IF command_external_id IS DISTINCT FROM command_payload->>'externalId' THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_EXTERNAL_BINDING_INVALID' USING ERRCODE='23514';
  END IF;
  derived_ingest_key := public.raw_source_ingest_key_v2(command_payload,derived_hash);
  IF command_ingest_key IS DISTINCT FROM derived_ingest_key THEN
    RAISE EXCEPTION 'RAW_SOURCE_WRITER_INGEST_KEY_INVALID' USING ERRCODE='23514';
  END IF;

  PERFORM 1 FROM public.data_provider provider
  WHERE provider."key"=command_provider_key AND provider."status"='ENABLED'
    AND CASE command_provider_key
      WHEN 'registry' THEN command_source_class='company_registry'
      WHEN 'directory' THEN command_source_class='industry_data'
      WHEN 'wikidata' THEN command_source_class IN ('company_registry','industry_data')
      WHEN 'openstreetmap' THEN command_source_class='industry_data'
      WHEN 'trade_fair' THEN command_source_class='industry_data'
      WHEN 'ted' THEN command_source_class='public_intelligence'
      WHEN 'openfda' THEN command_source_class='public_intelligence'
      WHEN 'public_web' THEN command_source_class IN ('public_intelligence','industry_data')
      ELSE false END
  FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_PROVIDER_BINDING_INVALID'
    USING ERRCODE='23503'; END IF;
  IF command_ingest_status='ACCEPTED'
    AND NOT public.raw_source_provider_payload_valid_v2(
      command_provider_key, command_payload
    )
  THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_PAYLOAD_SCHEMA_INVALID' USING ERRCODE='23514';
  END IF;

  IF command_run_id IS NOT NULL THEN
    PERFORM 1 FROM public.discovery_run run
    WHERE run."workspace_id"=command_workspace_id AND run."id"=command_run_id
    FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_RUN_BINDING_INVALID'
      USING ERRCODE='23503'; END IF;
  ELSE
    SELECT entity."id" entity_id, entity."external_id" entity_external_id,
      entity."content_hash" entity_content_hash,
      entity."last_seen_fetch_id" fetch_id, source."id" source_id,
      source."source_key", source."provider_key" origin_provider_key,
      observed_fetch."finished_at" fetched_at, observed_fetch."parser_version"
    INTO monitored_row
    FROM public.source_entity entity
    JOIN public.monitored_source source ON source."id"=entity."source_id"
    JOIN public.source_fetch observed_fetch
      ON observed_fetch."id"=entity."last_seen_fetch_id"
     AND observed_fetch."source_id"=source."id"
     AND observed_fetch."status" IN ('DONE','PARTIAL')
    WHERE entity."id"=command_source_entity_id
    FOR KEY SHARE OF entity,source,observed_fetch;
    IF NOT FOUND OR command_provider_key IS DISTINCT FROM 'trade_fair'
      OR command_content_hash IS DISTINCT FROM monitored_row.entity_content_hash
      OR command_fetched_at IS DISTINCT FROM monitored_row.fetched_at
      OR command_parser_version IS DISTINCT FROM monitored_row.parser_version
      OR command_payload #>> '{monitoredSource,sourceId}'
        IS DISTINCT FROM monitored_row.source_id::text
      OR command_payload #>> '{monitoredSource,sourceEntityId}'
        IS DISTINCT FROM monitored_row.entity_id::text
      OR command_payload #>> '{monitoredSource,sourceExternalId}'
        IS DISTINCT FROM monitored_row.entity_external_id
      OR command_payload #>> '{monitoredSource,sourceFetchId}'
        IS DISTINCT FROM monitored_row.fetch_id::text
      OR command_payload #>> '{monitoredSource,sourceKey}'
        IS DISTINCT FROM monitored_row.source_key
      OR command_payload #>> '{monitoredSource,originProviderKey}'
        IS DISTINCT FROM monitored_row.origin_provider_key
    THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_SOURCE_BINDING_INVALID'
      USING ERRCODE='23503'; END IF;
  END IF;

  IF command_source_url IS NOT NULL THEN
    IF NOT public.raw_source_safe_https_url_v2(command_source_url) THEN
      RAISE EXCEPTION 'RAW_SOURCE_WRITER_POLICY_BINDING_INVALID' USING ERRCODE='23514';
    END IF;
    source_host := lower(substring(command_source_url FROM '^https://([^/:?#]+)'));
  END IF;
  IF command_ingest_status='ACCEPTED' AND (
    (command_provider_key='directory'
      AND source_host IS DISTINCT FROM command_payload #>> '{attributes,source_directory}')
    OR (command_provider_key='wikidata' AND source_host <> 'www.wikidata.org')
    OR (command_provider_key='openstreetmap' AND source_host <> 'overpass-api.de')
    OR (command_provider_key='ted' AND source_host <> 'api.ted.europa.eu')
    OR (command_provider_key='openfda' AND source_host <> 'api.fda.gov')
    OR (command_provider_key='public_web'
      AND source_host IS DISTINCT FROM command_payload->>'domain')
  ) THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_ORIGIN_BINDING_INVALID'
    USING ERRCODE='23514'; END IF;

  IF command_source_policy_id IS NULL THEN
    IF command_ingest_status='ACCEPTED' THEN
      RAISE EXCEPTION 'RAW_SOURCE_WRITER_POLICY_BINDING_INVALID' USING ERRCODE='23514';
    END IF;
    derived_snapshot := jsonb_build_object(
      'kind','missing','retentionDays',command_retention_days,
      'allowedPurpose','[]'::jsonb,'minimizedFields','[]'::jsonb
    );
  ELSE
    SELECT policy."id",policy."domain",policy."retention_days",
      policy."review_status",policy."updated_at",policy."allowed_purpose"
    INTO policy_row FROM public.source_policy policy
    WHERE policy."id"=command_source_policy_id FOR KEY SHARE;
    IF NOT FOUND OR source_host IS NULL
      OR NOT (source_host=lower(policy_row.domain)
        OR right(source_host,char_length(policy_row.domain)+1)
          = '.' || lower(policy_row.domain))
      OR command_retention_days IS DISTINCT FROM policy_row.retention_days
      OR jsonb_typeof(policy_row.allowed_purpose) IS DISTINCT FROM 'array'
      OR jsonb_array_length(policy_row.allowed_purpose)=0
      OR NOT policy_row.allowed_purpose @> '["discovery"]'::jsonb
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(policy_row.allowed_purpose) item
        WHERE jsonb_typeof(item) <> 'string')
      OR (command_ingest_status='ACCEPTED'
        AND policy_row.review_status IS DISTINCT FROM 'APPROVED')
    THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_POLICY_BINDING_INVALID'
      USING ERRCODE='23514'; END IF;
    derived_snapshot := jsonb_build_object(
      'kind','source_policy','id',policy_row.id,'domain',policy_row.domain,
      'retentionDays',policy_row.retention_days,
      'reviewStatus',policy_row.review_status,
      'allowedPurpose','["discovery"]'::jsonb,
      'updatedAt',to_char(policy_row.updated_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'minimizedFields','[]'::jsonb
    );
  END IF;

  IF command_ingest_status='ACCEPTED' AND (
    command_source_url IS NULL OR command_fetched_at IS NULL
    OR command_content_hash !~ '^[0-9a-f]{64}$'
    OR char_length(command_parser_version) NOT BETWEEN 1 AND 256
    OR command_payload #>> '{provenance,sourceUrl}' IS DISTINCT FROM command_source_url
    OR command_payload #>> '{provenance,fetchedAt}' IS DISTINCT FROM command_fetched_at_text
    OR command_payload #>> '{provenance,contentHash}' IS DISTINCT FROM command_content_hash
    OR command_payload #>> '{provenance,parserVersion}' IS DISTINCT FROM command_parser_version
  ) THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_PROVENANCE_BINDING_INVALID'
    USING ERRCODE='23514'; END IF;

  derived_expires_at := coalesce(command_fetched_at,statement_timestamp())
    + make_interval(days=>command_retention_days);
  INSERT INTO public.raw_source_record(
    "id","workspace_id","run_id","source_entity_id","provider_key",
    "source_class","external_id","payload","source_url","fetched_at",
    "content_hash","parser_version","cost_cents","ingest_key",
    "payload_hash","payload_bytes","ingest_version","ingest_status",
    "disposition_code","retention_days","expires_at","expired_at",
    "source_policy_snapshot","created_at"
  ) VALUES (
    command_record_id,command_workspace_id,command_run_id,
    command_source_entity_id,command_provider_key,command_source_class,
    command_external_id,command_payload,command_source_url,command_fetched_at,
    command_content_hash,command_parser_version,command_cost_cents,
    command_ingest_key,derived_hash,derived_bytes,'raw-source/v2',
    command_ingest_status,command_disposition_code,command_retention_days,
    derived_expires_at,NULL,derived_snapshot,statement_timestamp()
  ) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted_count=ROW_COUNT;
  was_inserted := inserted_count=1;

  SELECT raw.* INTO stored_row FROM public.raw_source_record raw
  WHERE raw."workspace_id"=command_workspace_id
    AND raw."ingest_version"='raw-source/v2'
    AND raw."ingest_key"=command_ingest_key
    AND ((command_run_id IS NOT NULL AND raw."run_id"=command_run_id
      AND raw."provider_key"=command_provider_key)
      OR (command_source_entity_id IS NOT NULL
        AND raw."source_entity_id"=command_source_entity_id))
  FOR UPDATE;
  IF NOT FOUND
    OR (was_inserted AND stored_row."id" IS DISTINCT FROM command_record_id)
    OR stored_row."provider_key" IS DISTINCT FROM command_provider_key
    OR stored_row."source_class" IS DISTINCT FROM command_source_class
    OR stored_row."external_id" IS DISTINCT FROM command_external_id
    OR stored_row."payload" IS DISTINCT FROM command_payload
    OR stored_row."source_url" IS DISTINCT FROM command_source_url
    OR stored_row."fetched_at" IS DISTINCT FROM command_fetched_at
    OR stored_row."content_hash" IS DISTINCT FROM command_content_hash
    OR stored_row."parser_version" IS DISTINCT FROM command_parser_version
    OR stored_row."cost_cents" IS DISTINCT FROM command_cost_cents
    OR stored_row."payload_hash" IS DISTINCT FROM derived_hash
    OR stored_row."payload_bytes" IS DISTINCT FROM derived_bytes
    OR stored_row."ingest_status" IS DISTINCT FROM command_ingest_status
    OR stored_row."disposition_code" IS DISTINCT FROM command_disposition_code
    OR stored_row."retention_days" IS DISTINCT FROM command_retention_days
    OR stored_row."source_policy_snapshot" IS DISTINCT FROM derived_snapshot
  THEN RAISE EXCEPTION 'RAW_SOURCE_WRITER_DRIFT' USING ERRCODE='23505'; END IF;
  RETURN QUERY SELECT stored_row."id",stored_row."payload_hash"::text,
    stored_row."payload_bytes",stored_row."ingest_status"::text,was_inserted;
END
$$;

REVOKE ALL ON FUNCTION raw_source_text_secret_safe_v2(TEXT) FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_text_contact_safe_v2(TEXT) FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_safe_https_url_v2(TEXT) FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_json_keys_within_v2(JSONB,TEXT[],TEXT[]) FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_json_shape_valid_v2(JSONB,INTEGER,INTEGER) FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_controlled_business_term_v2(TEXT) FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_identifier_valid_v2(TEXT,JSONB) FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_provider_payload_valid_v2(TEXT,JSONB) FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_ingest_key_v2(JSONB,TEXT) FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_sanitize_derived_json_v2(JSONB,INTEGER) FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION sanitize_canonical_company_attributes_v2(JSONB) FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION write_raw_source_record_v2(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION write_raw_source_record_v2(JSONB) TO app_user;

COMMIT;
