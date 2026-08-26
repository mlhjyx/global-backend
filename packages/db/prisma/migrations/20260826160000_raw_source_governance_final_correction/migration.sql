-- Forward-only final Raw Source correction. Migrations 0900-1500 are frozen.
-- Retained-size lock/timing validation remains HOLD; this migration is not a
-- retained-database or deployment authorization.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

-- A provider-classified organization name has a context-specific contract.
-- It must not inherit the generic free-text person-name marker list, while all
-- email, phone, credential, secret, URL, bounds, shape, and NFKC gates remain.
CREATE FUNCTION raw_source_provider_company_name_valid_v2(p_value TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT octet_length(p_value) BETWEEN 1 AND 160
    AND normalize(p_value,NFKC) = p_value
    AND p_value ~ '^[[:alnum:]][[:alnum:] ._+&''(),/#:-]*$'
    AND cardinality(regexp_split_to_array(trim(p_value),'\s+')) <= 16
    AND p_value !~ '[[:cntrl:]]'
    AND p_value !~* '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}'
    AND p_value !~* '(^|[^[:alnum:]])(bearer|basic auth|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|password|passwd|private[_ -]?key|first[_ -]?name|last[_ -]?name|full[_ -]?name|contact[_ -]?name|personal data|jane doe|john doe|john smith)($|[^[:alnum:]])'
    AND p_value !~* '(^|[^[:alnum:]])sk-[a-z0-9_-]{6,}'
    AND p_value !~* '([a-z][a-z0-9+.-]*://|(^|[^[:alnum:]])www\.)'
    AND public.raw_source_decimal_fold_v2(p_value)
      !~ '(^|[^[:alnum:]])([+]?[0-9][ ()\.-]*){7,}($|[^[:alnum:]])'
$$;

ALTER FUNCTION raw_source_provider_payload_valid_v2(TEXT,JSONB)
  RENAME TO raw_source_provider_payload_valid_v2_status_hardening;

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
  company_name TEXT;
  validation_payload JSONB;
BEGIN
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_payload->'name') IS DISTINCT FROM 'string'
  THEN RETURN false; END IF;
  company_name := p_payload->>'name';
  IF NOT public.raw_source_provider_company_name_valid_v2(company_name)
  THEN RETURN false; END IF;

  -- The frozen legacy validator still applies every non-name provider rule.
  -- Substitute only the already context-validated name so its old finite
  -- person-marker list cannot contradict provider classification.
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

-- Remove recursively empty/null containers after the closed v2 sanitizer.
-- Empty structures are not governed facts and cannot support ENRICHED state.
CREATE FUNCTION raw_source_prune_empty_json_v4(p_value JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  rendered JSONB;
BEGIN
  CASE jsonb_typeof(p_value)
    WHEN 'object' THEN
      SELECT jsonb_object_agg(item.key,item.value)
      INTO rendered
      FROM (
        SELECT entry.key,
          public.raw_source_prune_empty_json_v4(entry.value) AS value
        FROM jsonb_each(p_value) AS entry
      ) AS item
      WHERE item.value IS NOT NULL
        AND item.value NOT IN ('{}'::jsonb,'[]'::jsonb);
      RETURN rendered;
    WHEN 'array' THEN
      SELECT jsonb_agg(item.value ORDER BY item.ordinality)
      INTO rendered
      FROM (
        SELECT entry.ordinality,
          public.raw_source_prune_empty_json_v4(entry.value) AS value
        FROM jsonb_array_elements(p_value) WITH ORDINALITY
          AS entry(value,ordinality)
      ) AS item
      WHERE item.value IS NOT NULL
        AND item.value NOT IN ('{}'::jsonb,'[]'::jsonb);
      RETURN rendered;
    WHEN 'null' THEN RETURN NULL;
    ELSE RETURN p_value;
  END CASE;
END
$$;

CREATE FUNCTION sanitize_canonical_company_attributes_v3(p_attributes JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(
    public.raw_source_prune_empty_json_v4(
      public.sanitize_canonical_company_attributes_v2(p_attributes)
    ),
    '{}'::jsonb
  )
$$;

-- Re-evaluate governed attribute evidence with the same path-aware sanitizer.
CREATE FUNCTION raw_source_sanitize_field_evidence_v4(
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
  normalized_field TEXT := lower(regexp_replace(p_field,'[^a-z0-9]','','g'));
BEGIN
  -- Preserve an exact prior cleanup receipt when its optional retained value
  -- already satisfies the current sanitizer. This avoids receipt-on-receipt
  -- churn while still reprocessing stale retained values.
  IF jsonb_typeof(p_value) = 'object'
    AND public.raw_source_json_keys_within_v2(
      p_value,
      ARRAY['_historicalCleanup','reason','originalValueHash','retainedValue'],
      ARRAY['_historicalCleanup','reason','originalValueHash']
    )
    AND p_value->>'_historicalCleanup' = 'canonical-attribute-cleanup/v1'
    AND p_value->>'reason' = 'UNSAFE_HISTORICAL_CANONICAL_VALUE_WITHHELD'
    AND p_value->>'originalValueHash' ~ '^[0-9a-f]{64}$'
    AND (
      NOT p_value ? 'retainedValue'
      OR p_value->'retainedValue' IS NOT DISTINCT FROM
        public.sanitize_canonical_company_attributes_v3(
          p_value->'retainedValue'
        )
    )
  THEN RETURN p_value; END IF;

  IF p_field = 'attributes' THEN
    RETURN public.sanitize_canonical_company_attributes_v3(p_value);
  END IF;
  IF normalized_field IN (
    'address','contact','contactemail','contactname','contactpoint','email',
    'firstname','fullname','lastname','mobile','ownername','person','persons',
    'phone','publicemail','publicphone','recipientname','telephone','usagent'
  ) THEN RETURN NULL; END IF;
  IF p_field = 'name' AND jsonb_typeof(p_value) = 'string' THEN
    IF public.raw_source_provider_company_name_valid_v2(p_value #>> '{}')
    THEN RETURN p_value; END IF;
    RETURN NULL;
  END IF;

  path_parts := string_to_array(p_field,'.');
  IF path_parts[1] IN (
    'digital_footprint','employee_band','employees','extraction_confidence',
    'extraction_evidence_digest','fda','fda_applicant','gleif',
    'government_buyer','hall','hiring_signal','intent','keywords','latitude',
    'longitude','osm_id','products','sam_disclaimer','sam_market_signal',
    'source_class','source_fair','source_kind','stand','structured_harvest',
    'ted','ted_buyer','wikidata','wikidata_qid'
  ) THEN
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
  END IF;
  RETURN p_value;
END
$$;

-- Advance projection provenance only when this correction changes attributes.
UPDATE canonical_company AS company
SET attributes = public.sanitize_canonical_company_attributes_v3(
      company.attributes
    ),
    version = company.version + 1,
    updated_at = statement_timestamp()
WHERE company.attributes IS DISTINCT FROM
  public.sanitize_canonical_company_attributes_v3(company.attributes);

-- Preserve evidence rows and restriction immutability. Only affected,
-- non-protected values become a value-free audit receipt; safe retained values
-- may be carried solely inside the closed sanitized namespace.
UPDATE field_evidence AS evidence
SET value = jsonb_strip_nulls(jsonb_build_object(
      '_historicalCleanup', 'canonical-attribute-cleanup/v2',
      'reason', 'UNSAFE_HISTORICAL_CANONICAL_VALUE_WITHHELD',
      'originalValueHash', encode(digest(
        raw_source_canonical_json_v1(evidence.value), 'sha256'
      ), 'hex'),
      'retainedValue', CASE
        WHEN public.raw_source_sanitize_field_evidence_v4(
          evidence.field,evidence.value
        ) NOT IN ('{}'::jsonb,'[]'::jsonb)
        THEN public.raw_source_sanitize_field_evidence_v4(
          evidence.field,evidence.value
        )
        ELSE NULL
      END
    )),
    allowed_actions = '[]'::jsonb,
    data_class = 'red'
WHERE evidence.entity_type = 'company'
  AND NOT EXISTS (
    SELECT 1
    FROM raw_source_governance_disposition AS disposition
    WHERE disposition.workspace_id = evidence.workspace_id
      AND disposition.raw_record_id = evidence.raw_record_id
      AND disposition.effect = 'RESTRICT_PROCESSING'
  )
  AND evidence.value IS DISTINCT FROM
    public.raw_source_sanitize_field_evidence_v4(
      evidence.field,evidence.value
    );

REVOKE ALL ON FUNCTION raw_source_provider_company_name_valid_v2(TEXT)
  FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_provider_payload_valid_v2_status_hardening(TEXT,JSONB)
  FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_provider_payload_valid_v2(TEXT,JSONB)
  FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_prune_empty_json_v4(JSONB)
  FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION sanitize_canonical_company_attributes_v3(JSONB)
  FROM PUBLIC, app_user;
REVOKE ALL ON FUNCTION raw_source_sanitize_field_evidence_v4(TEXT,JSONB)
  FROM PUBLIC, app_user;

COMMIT;
