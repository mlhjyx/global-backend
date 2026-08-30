BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

DO $organization_identity_catalog_preflight$
DECLARE
  canonical_json_oid oid;
BEGIN
  IF current_user IS DISTINCT FROM 'global' THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_CATALOG_RESIDUE'
      USING ERRCODE = 'P0001';
  END IF;

  IF to_regrole('app_user') IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM pg_roles AS r
      WHERE r.rolname = 'app_user'
        AND NOT r.rolsuper
        AND NOT r.rolcreaterole
        AND NOT r.rolcreatedb
        AND NOT r.rolreplication
        AND NOT r.rolbypassrls
    )
    OR EXISTS (
      WITH RECURSIVE role_paths(member, roleid) AS (
        SELECT member, roleid FROM pg_auth_members
        UNION
        SELECT path.member, next_membership.roleid
        FROM role_paths AS path
        JOIN pg_auth_members AS next_membership
          ON next_membership.member = path.roleid
      )
      SELECT 1 FROM role_paths
      WHERE roleid = 'global'::regrole
        AND member <> 'global'::regrole
    )
    OR EXISTS (
      SELECT 1
      FROM pg_default_acl AS defaults
      CROSS JOIN LATERAL aclexplode(defaults.defaclacl) AS acl
      WHERE defaults.defaclrole = 'global'::regrole
        AND defaults.defaclobjtype = 'f'
        AND defaults.defaclnamespace IN (0, 'public'::regnamespace)
        AND acl.grantee <> 'global'::regrole::oid
        AND (acl.privilege_type = 'EXECUTE' OR acl.is_grantable)
    )
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_CATALOG_RESIDUE'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'apply_organization_identity_resolution_v1',
        'resolve_organization_identity_for_raw_v1',
        'organization_identity_authority_from_raw_v1',
        'organization_identity_blocker_from_raw_v1',
        'organization_identity_canonical_suppression_value_v1',
        'organization_identity_plan_from_snapshot_v1',
        'organization_identity_acquire_advisory_until_v1'
      )
  ) THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_CATALOG_RESIDUE'
      USING ERRCODE = 'P0001';
  END IF;

  canonical_json_oid := to_regprocedure(
    'public.raw_source_canonical_json_v1(jsonb)'
  );
  IF canonical_json_oid IS NULL
    OR NOT coalesce((
      SELECT
        n.nspname = 'public'
        AND p.proname = 'raw_source_canonical_json_v1'
        AND oidvectortypes(p.proargtypes) = 'jsonb'
        AND p.pronargs = 1
        AND NOT p.proretset
        AND pg_get_function_result(p.oid) = 'text'
        AND language.lanname = 'plpgsql'
        AND pg_get_userbyid(p.proowner) = 'global'
        AND NOT p.prosecdef
        AND p.provolatile = 'i'
        AND p.proparallel = 'u'
        AND NOT p.proleakproof
        AND p.proisstrict
        AND p.prokind = 'f'
        AND p.proconfig IS NOT DISTINCT FROM
          ARRAY['search_path=pg_catalog, public']::text[]
        AND p.proacl IS NOT NULL
        AND (
          SELECT count(*) = 1
            AND bool_and(
              acl.grantee = p.proowner
              AND acl.grantor = p.proowner
              AND acl.privilege_type = 'EXECUTE'
              AND NOT acl.is_grantable
            )
          FROM aclexplode(p.proacl) AS acl
        )
        AND encode(
          sha256(convert_to(pg_get_functiondef(p.oid), 'UTF8')),
          'hex'
        ) = 'e9e958c0823409435f4bc1aa093b9c6bd1851eb401b5f07278c224992317ca16'
      FROM pg_proc AS p
      JOIN pg_namespace AS n ON n.oid = p.pronamespace
      JOIN pg_language AS language ON language.oid = p.prolang
      WHERE p.oid = canonical_json_oid
    ), false)
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_CATALOG_RESIDUE'
      USING ERRCODE = 'P0001';
  END IF;
END
$organization_identity_catalog_preflight$;

CREATE FUNCTION public.organization_identity_canonical_suppression_value_v1(
  p_type text,
  p_value text
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $organization_identity_suppression$
DECLARE
  canonical text;
  labels text[];
  label text;
BEGIN
  IF p_type IS NULL OR p_value IS NULL
    OR octet_length(p_value) > 2048
  THEN
    RETURN NULL;
  END IF;

  IF p_type = 'company_name' THEN
    IF p_value ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' THEN
      RETURN NULL;
    END IF;
    canonical := lower(normalize(p_value, NFC));
    canonical := btrim(regexp_replace(
      canonical, '[[:space:]]+', ' ', 'g'
    ));
    IF canonical = '' OR char_length(canonical) > 256 THEN
      RETURN NULL;
    END IF;
    RETURN canonical;
  END IF;

  IF p_type IS DISTINCT FROM 'domain' OR btrim(p_value) = '' THEN
    RETURN NULL;
  END IF;
  canonical := lower(btrim(p_value));
  canonical := regexp_replace(canonical, '^https?://', '');
  canonical := regexp_replace(canonical, '^www\.', '');
  canonical := split_part(
    split_part(split_part(canonical, '/', 1), '?', 1), '#', 1
  );
  canonical := regexp_replace(canonical, '\.+$', '');
  IF canonical = ''
    OR char_length(canonical) > 253
    OR canonical !~ '^[a-z0-9.-]+$'
    OR position('.' IN canonical) = 0
    OR canonical ~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
  THEN
    RETURN NULL;
  END IF;
  labels := string_to_array(canonical, '.');
  IF cardinality(labels) NOT BETWEEN 2 AND 128 THEN
    RETURN NULL;
  END IF;
  FOREACH label IN ARRAY labels LOOP
    IF char_length(label) NOT BETWEEN 1 AND 63
      OR label !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
    THEN
      RETURN NULL;
    END IF;
  END LOOP;
  RETURN canonical;
END
$organization_identity_suppression$;

REVOKE ALL ON FUNCTION
  public.organization_identity_canonical_suppression_value_v1(text, text)
FROM PUBLIC, app_user;

CREATE FUNCTION public.organization_identity_authority_from_raw_v1(
  p_provider_key text,
  p_raw jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $organization_identity_authority$
DECLARE
  identifier jsonb;
  identifier_keys text;
  raw_scheme text;
  canonical_scheme text;
  raw_value text;
  normalized_value text;
  raw_country text;
  jurisdiction text;
  suffix_jurisdiction text;
  validator_version text;
  domain_value text;
  authority jsonb := '[]'::jsonb;
  lei_expanded text := '';
  lei_remainder integer := 0;
  lei_character text;
  lei_digit text;
BEGIN
  IF p_provider_key IS NULL
    OR octet_length(p_provider_key) NOT BETWEEN 1 AND 128
    OR p_provider_key NOT IN (
      'registry', 'directory', 'wikidata', 'openstreetmap',
      'trade_fair', 'ted', 'openfda', 'public_web'
    )
    OR jsonb_typeof(p_raw) IS DISTINCT FROM 'object'
    OR octet_length(p_raw::text) > 65536
  THEN
    RAISE EXCEPTION 'IDENTITY_RAW_PAYLOAD_NOT_GOVERNED'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_raw ? 'domain' THEN
    IF jsonb_typeof(p_raw->'domain') IS DISTINCT FROM 'string'
      OR octet_length(p_raw->>'domain') NOT BETWEEN 1 AND 253
    THEN
      RAISE EXCEPTION 'IDENTITY_IDENTIFIER_INVALID'
        USING ERRCODE = 'P0001';
    END IF;
    domain_value :=
      public.organization_identity_canonical_suppression_value_v1(
        'domain', p_raw->>'domain'
      );
    IF domain_value IS NULL
      OR domain_value IS DISTINCT FROM p_raw->>'domain'
    THEN
      RAISE EXCEPTION 'IDENTITY_IDENTIFIER_INVALID'
        USING ERRCODE = 'P0001';
    END IF;
    authority := authority || jsonb_build_array(jsonb_build_object(
      'providerKey', p_provider_key,
      'scheme', 'domain',
      'jurisdiction', 'GLOBAL',
      'normalizedValue', domain_value,
      'validatorVersion', 'domain-v1',
      'normalizerVersion', 'organization-identity-authority/v1',
      'key', 'domain:GLOBAL:' || domain_value
    ));
  END IF;

  IF p_raw ? 'identifier' THEN
    IF jsonb_typeof(p_raw->'identifier') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'IDENTITY_IDENTIFIER_INVALID'
        USING ERRCODE = 'P0001';
    END IF;
    identifier := p_raw->'identifier';
    SELECT string_agg(key, ',' ORDER BY key COLLATE "C")
    INTO identifier_keys
    FROM jsonb_object_keys(identifier) AS key;
    IF identifier_keys IS DISTINCT FROM 'scheme,value'
      OR jsonb_typeof(identifier->'scheme') IS DISTINCT FROM 'string'
      OR jsonb_typeof(identifier->'value') IS DISTINCT FROM 'string'
    THEN
      RAISE EXCEPTION 'IDENTITY_IDENTIFIER_INVALID'
        USING ERRCODE = 'P0001';
    END IF;

    raw_scheme := identifier->>'scheme';
    raw_value := identifier->>'value';
    raw_country := p_raw->>'country';

    IF p_provider_key = 'registry'
      AND raw_scheme IN ('registry-id', 'lei')
    THEN
      canonical_scheme := raw_scheme;
      IF octet_length(raw_value) NOT BETWEEN 1 AND 80
        OR raw_value !~ '^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,79}$'
      THEN
        RAISE EXCEPTION 'IDENTITY_IDENTIFIER_INVALID'
          USING ERRCODE = 'P0001';
      END IF;
      normalized_value := upper(regexp_replace(
        normalize(raw_value, NFC), '[^[:alnum:]]+', '', 'g'
      ));
      IF canonical_scheme = 'registry-id' THEN
        jurisdiction := CASE
          WHEN raw_country ~ '^[A-Z]{2}$' THEN raw_country
          ELSE 'GLOBAL'
        END;
        validator_version := 'registry-id-v1';
      ELSE
        jurisdiction := 'GLOBAL';
        validator_version := 'lei-v1';
        IF normalized_value !~ '^[A-Z0-9]{20}$' THEN
          RAISE EXCEPTION 'IDENTITY_IDENTIFIER_INVALID'
            USING ERRCODE = 'P0001';
        END IF;
        FOREACH lei_character IN ARRAY regexp_split_to_array(
          normalized_value, ''
        ) LOOP
          lei_expanded := lei_expanded || CASE
            WHEN lei_character ~ '^[A-Z]$'
              THEN (ascii(lei_character) - 55)::text
            ELSE lei_character
          END;
        END LOOP;
        FOREACH lei_digit IN ARRAY regexp_split_to_array(lei_expanded, '')
        LOOP
          lei_remainder := (
            lei_remainder * 10 + lei_digit::integer
          ) % 97;
        END LOOP;
        IF lei_remainder <> 1 THEN
          RAISE EXCEPTION 'IDENTITY_IDENTIFIER_INVALID'
            USING ERRCODE = 'P0001';
        END IF;
      END IF;
    ELSIF p_provider_key = 'ted'
      AND raw_scheme ~ '^ted-natid(:[a-z]{2})?$'
    THEN
      canonical_scheme := 'ted-natid';
      IF octet_length(raw_value) NOT BETWEEN 1 AND 80
        OR raw_value !~ '^[[:alnum:]][[:alnum:] ._+&''(),/#:\-]{0,79}$'
      THEN
        RAISE EXCEPTION 'IDENTITY_IDENTIFIER_INVALID'
          USING ERRCODE = 'P0001';
      END IF;
      suffix_jurisdiction := upper(
        substring(raw_scheme FROM '^ted-natid:([a-z]{2})$')
      );
      IF raw_country !~ '^[A-Z]{2}$' THEN
        raw_country := NULL;
      END IF;
      IF suffix_jurisdiction IS NOT NULL
        AND raw_country IS NOT NULL
        AND suffix_jurisdiction IS DISTINCT FROM raw_country
      THEN
        RAISE EXCEPTION 'IDENTITY_IDENTIFIER_INVALID'
          USING ERRCODE = 'P0001';
      END IF;
      jurisdiction := coalesce(suffix_jurisdiction, raw_country);
      IF jurisdiction IS NULL THEN
        RAISE EXCEPTION 'IDENTITY_IDENTIFIER_INVALID'
          USING ERRCODE = 'P0001';
      END IF;
      normalized_value := upper(regexp_replace(
        normalize(raw_value, NFC), '[^[:alnum:]]+', '', 'g'
      ));
      validator_version := 'ted-natid-v1';
    ELSIF p_provider_key = 'openfda'
      AND raw_scheme = 'fda-reg'
    THEN
      canonical_scheme := 'fda-reg';
      IF raw_value !~ '^[0-9]{1,32}$' THEN
        RAISE EXCEPTION 'IDENTITY_IDENTIFIER_INVALID'
          USING ERRCODE = 'P0001';
      END IF;
      jurisdiction := 'US';
      normalized_value := raw_value;
      validator_version := 'fda-reg-v1';
    ELSE
      RAISE EXCEPTION 'IDENTITY_IDENTIFIER_NOT_AUTHORIZED'
        USING ERRCODE = 'P0001';
    END IF;

    IF normalized_value IS NULL OR normalized_value = '' THEN
      RAISE EXCEPTION 'IDENTITY_IDENTIFIER_INVALID'
        USING ERRCODE = 'P0001';
    END IF;
    authority := authority || jsonb_build_array(jsonb_build_object(
      'providerKey', p_provider_key,
      'scheme', canonical_scheme,
      'jurisdiction', jurisdiction,
      'normalizedValue', normalized_value,
      'validatorVersion', validator_version,
      'normalizerVersion', 'organization-identity-authority/v1',
      'key', canonical_scheme || ':' || jurisdiction || ':' || normalized_value
    ));
  END IF;

  SELECT coalesce(jsonb_agg(value ORDER BY value->>'key' COLLATE "C"), '[]')
  INTO authority
  FROM (
    SELECT DISTINCT item.value
    FROM jsonb_array_elements(authority) AS item(value)
  ) AS canonical;
  RETURN authority;
END
$organization_identity_authority$;

REVOKE ALL ON FUNCTION public.organization_identity_authority_from_raw_v1(
  text, jsonb
) FROM PUBLIC, app_user;

CREATE FUNCTION public.organization_identity_blocker_from_raw_v1(p_raw jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $organization_identity_blocker$
DECLARE
  domain_value text;
  name_value text;
  country_value text;
  blocker_key text;
BEGIN
  IF jsonb_typeof(p_raw) IS DISTINCT FROM 'object'
    OR octet_length(p_raw::text) > 8192
    OR jsonb_typeof(p_raw->'name') IS DISTINCT FROM 'string'
    OR octet_length(p_raw->>'name') NOT BETWEEN 1 AND 2048
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_raw ? 'country' THEN
    IF jsonb_typeof(p_raw->'country') IS DISTINCT FROM 'string' THEN
      RETURN jsonb_build_object(
        'kind', 'HOLD',
        'reason', 'IDENTITY_BLOCKER_INPUT_INVALID'
      );
    END IF;
    country_value := p_raw->>'country';
    IF country_value <> '' AND country_value !~ '^[A-Za-z]{2}$' THEN
      RETURN jsonb_build_object(
        'kind', 'HOLD',
        'reason', 'IDENTITY_BLOCKER_INPUT_INVALID'
      );
    END IF;
    country_value := lower(country_value);
  ELSE
    country_value := '';
  END IF;

  IF p_raw ? 'domain' THEN
    IF jsonb_typeof(p_raw->'domain') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
        USING ERRCODE = 'P0001';
    END IF;
    domain_value :=
      public.organization_identity_canonical_suppression_value_v1(
        'domain', p_raw->>'domain'
      );
    IF domain_value IS NULL THEN
      RETURN jsonb_build_object(
        'kind', 'HOLD',
        'reason', 'IDENTITY_BLOCKER_INPUT_INVALID'
      );
    END IF;
    blocker_key := 'd:' || domain_value;
    IF octet_length(blocker_key) > 512 THEN
      RETURN jsonb_build_object(
        'kind', 'HOLD',
        'reason', 'IDENTITY_BLOCKER_INPUT_INVALID'
      );
    END IF;
    RETURN jsonb_build_object(
      'blockerKey', blocker_key,
      'matchRule', 'domain_exact'
    );
  END IF;

  name_value := lower(normalize(p_raw->>'name', NFC));
  name_value := regexp_replace(
    name_value,
    '\y(gmbh|ag|kg|co\.?|ltd\.?|llc|inc\.?|corp\.?|s\.?a\.?|s\.?r\.?l\.?|b\.?v\.?|oy|ab|as|plc|pty|limited|company|holdings?)\y|有限公司|株式会社|주식회사',
    ' ',
    'gi'
  );
  name_value := btrim(regexp_replace(
    name_value, '[^[:alnum:]]+', ' ', 'g'
  ));
  name_value := regexp_replace(name_value, '[[:space:]]+', ' ', 'g');
  IF name_value = '' THEN
    RETURN jsonb_build_object(
      'kind', 'HOLD',
      'reason', 'IDENTITY_BLOCKER_EMPTY_NORMALIZED_NAME'
    );
  END IF;
  blocker_key := 'n:' || name_value || ':' || country_value;
  IF octet_length(blocker_key) > 512 THEN
    RETURN jsonb_build_object(
      'kind', 'HOLD',
      'reason', 'IDENTITY_BLOCKER_INPUT_INVALID'
    );
  END IF;
  RETURN jsonb_build_object(
    'blockerKey', blocker_key,
    'matchRule', 'name_country'
  );
END
$organization_identity_blocker$;

REVOKE ALL ON FUNCTION
  public.organization_identity_blocker_from_raw_v1(jsonb)
FROM PUBLIC, app_user;

CREATE FUNCTION public.organization_identity_plan_from_snapshot_v1(
  p_snapshot jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $organization_identity_plan$
DECLARE
  snapshot_keys text;
  raw_keys text;
  blocker_keys text;
  raw_fact jsonb;
  blocker_fact jsonb;
  authority_input jsonb;
  bindings_input jsonb;
  mappings_input jsonb;
  canonical_authority jsonb;
  canonical_bindings jsonb;
  canonical_mappings jsonb;
  canonical_blocker jsonb;
  canonical_raw jsonb;
  input_hash text;
  conflict_fingerprint text;
  legacy_company_id text;
  legacy_root text;
  bound_roots text[];
  identifiers jsonb;
  identifier_keys jsonb;
  company_ids jsonb;
  plan_kind text;
  conflict_type text;
  target_company_id text;
  match_rule text;
BEGIN
  IF jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object'
    OR octet_length(p_snapshot::text) > 65536
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT string_agg(key, ',' ORDER BY key COLLATE "C")
  INTO snapshot_keys
  FROM jsonb_object_keys(p_snapshot) AS key;
  IF snapshot_keys IS DISTINCT FROM
      'authorityIdentifiers,blocker,existingBindings,raw,resolverVersion,rootMappings'
    OR jsonb_typeof(p_snapshot->'resolverVersion') IS DISTINCT FROM 'string'
    OR p_snapshot->>'resolverVersion' IS DISTINCT FROM
      'organization-identity-resolver/v1'
    OR jsonb_typeof(p_snapshot->'raw') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_snapshot->'blocker') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_snapshot->'authorityIdentifiers') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_snapshot->'existingBindings') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_snapshot->'rootMappings') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_snapshot->'authorityIdentifiers') > 32
    OR jsonb_array_length(p_snapshot->'existingBindings') > 64
    OR jsonb_array_length(p_snapshot->'rootMappings') > 64
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  raw_fact := p_snapshot->'raw';
  blocker_fact := p_snapshot->'blocker';
  authority_input := p_snapshot->'authorityIdentifiers';
  bindings_input := p_snapshot->'existingBindings';
  mappings_input := p_snapshot->'rootMappings';

  SELECT string_agg(key, ',' ORDER BY key COLLATE "C")
  INTO raw_keys FROM jsonb_object_keys(raw_fact) AS key;
  IF raw_keys IS DISTINCT FROM
      'ingestVersion,payloadHash,providerKey,rawRecordId'
    OR jsonb_typeof(raw_fact->'rawRecordId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(raw_fact->'providerKey') IS DISTINCT FROM 'string'
    OR jsonb_typeof(raw_fact->'payloadHash') IS DISTINCT FROM 'string'
    OR jsonb_typeof(raw_fact->'ingestVersion') IS DISTINCT FROM 'string'
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  IF raw_fact->>'rawRecordId' !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR (
      raw_fact->>'providerKey' IS DISTINCT FROM 'registry'
      AND raw_fact->>'providerKey' IS DISTINCT FROM 'directory'
      AND raw_fact->>'providerKey' IS DISTINCT FROM 'wikidata'
      AND raw_fact->>'providerKey' IS DISTINCT FROM 'openstreetmap'
      AND raw_fact->>'providerKey' IS DISTINCT FROM 'trade_fair'
      AND raw_fact->>'providerKey' IS DISTINCT FROM 'ted'
      AND raw_fact->>'providerKey' IS DISTINCT FROM 'openfda'
      AND raw_fact->>'providerKey' IS DISTINCT FROM 'public_web'
    )
    OR raw_fact->>'payloadHash' !~ '^[0-9a-f]{64}$'
    OR octet_length(raw_fact->>'ingestVersion') NOT BETWEEN 1 AND 128
    OR raw_fact->>'ingestVersion' !~ '^[a-z0-9][a-z0-9._/-]*$'
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  canonical_raw := jsonb_build_object(
    'rawRecordId', raw_fact->>'rawRecordId',
    'providerKey', raw_fact->>'providerKey',
    'payloadHash', raw_fact->>'payloadHash',
    'ingestVersion', raw_fact->>'ingestVersion'
  );

  SELECT string_agg(key, ',' ORDER BY key COLLATE "C")
  INTO blocker_keys FROM jsonb_object_keys(blocker_fact) AS key;
  IF (
      blocker_keys IS DISTINCT FROM
        'blockerKey,legacyCandidateCompanyId,matchRule'
      AND blocker_keys IS DISTINCT FROM 'blockerKey,matchRule'
    )
    OR jsonb_typeof(blocker_fact->'blockerKey') IS DISTINCT FROM 'string'
    OR jsonb_typeof(blocker_fact->'matchRule') IS DISTINCT FROM 'string'
    OR (
      blocker_fact ? 'legacyCandidateCompanyId'
      AND jsonb_typeof(blocker_fact->'legacyCandidateCompanyId')
        IS DISTINCT FROM 'string'
      AND jsonb_typeof(blocker_fact->'legacyCandidateCompanyId')
        IS DISTINCT FROM 'null'
    )
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  IF octet_length(blocker_fact->>'blockerKey') NOT BETWEEN 1 AND 512
    OR (
      blocker_fact->>'matchRule' IS DISTINCT FROM 'domain_exact'
      AND blocker_fact->>'matchRule' IS DISTINCT FROM 'name_country'
    )
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  legacy_company_id := CASE
    WHEN jsonb_typeof(blocker_fact->'legacyCandidateCompanyId') = 'string'
      THEN blocker_fact->>'legacyCandidateCompanyId'
    ELSE NULL
  END;
  IF legacy_company_id IS NOT NULL
    AND legacy_company_id !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  canonical_blocker := jsonb_build_object(
    'blockerKey', blocker_fact->>'blockerKey',
    'matchRule', blocker_fact->>'matchRule',
    'legacyCandidateCompanyId', to_jsonb(legacy_company_id)
  );

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(authority_input) AS item(value)
    WHERE jsonb_typeof(item.value) IS DISTINCT FROM 'object'
      OR (
        SELECT string_agg(key, ',' ORDER BY key COLLATE "C")
        FROM jsonb_object_keys(item.value) AS key
      ) IS DISTINCT FROM
        'jurisdiction,key,normalizedValue,normalizerVersion,providerKey,scheme,validatorVersion'
      OR jsonb_typeof(item.value->'providerKey') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item.value->'scheme') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item.value->'jurisdiction') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item.value->'normalizedValue') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item.value->'validatorVersion') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item.value->'normalizerVersion') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item.value->'key') IS DISTINCT FROM 'string'
  ) THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(authority_input) AS item(value)
    WHERE item.value->>'providerKey' IS DISTINCT FROM raw_fact->>'providerKey'
      OR item.value->>'normalizerVersion' IS DISTINCT FROM
        'organization-identity-authority/v1'
      OR octet_length(item.value->>'key') NOT BETWEEN 1 AND 512
      OR item.value->>'key' IS DISTINCT FROM
        (item.value->>'scheme') || ':' ||
        (item.value->>'jurisdiction') || ':' ||
        (item.value->>'normalizedValue')
      OR NOT (
        (
          item.value->>'scheme' = 'domain'
          AND item.value->>'jurisdiction' = 'GLOBAL'
          AND item.value->>'validatorVersion' = 'domain-v1'
          AND item.value->>'normalizedValue' ~
            '^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
        ) OR (
          raw_fact->>'providerKey' = 'registry'
          AND item.value->>'scheme' = 'registry-id'
          AND item.value->>'jurisdiction' ~ '^(GLOBAL|[A-Z]{2})$'
          AND item.value->>'validatorVersion' = 'registry-id-v1'
          AND item.value->>'normalizedValue' ~ '^[[:alnum:]]+$'
        ) OR (
          raw_fact->>'providerKey' = 'registry'
          AND item.value->>'scheme' = 'lei'
          AND item.value->>'jurisdiction' = 'GLOBAL'
          AND item.value->>'validatorVersion' = 'lei-v1'
          AND item.value->>'normalizedValue' ~ '^[A-Z0-9]{20}$'
        ) OR (
          raw_fact->>'providerKey' = 'ted'
          AND item.value->>'scheme' = 'ted-natid'
          AND item.value->>'jurisdiction' ~ '^[A-Z]{2}$'
          AND item.value->>'validatorVersion' = 'ted-natid-v1'
          AND octet_length(item.value->>'normalizedValue') BETWEEN 1 AND 80
          AND item.value->>'normalizedValue' ~ '^[[:alnum:]]+$'
        ) OR (
          raw_fact->>'providerKey' = 'openfda'
          AND item.value->>'scheme' = 'fda-reg'
          AND item.value->>'jurisdiction' = 'US'
          AND item.value->>'validatorVersion' = 'fda-reg-v1'
          AND item.value->>'normalizedValue' ~ '^[0-9]{1,32}$'
        )
      )
  ) THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(authority_input) AS item(value)
    GROUP BY item.value->>'key'
    HAVING count(DISTINCT item.value) > 1
  ) THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_CONTRADICTORY'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT coalesce(jsonb_agg(value ORDER BY value->>'key' COLLATE "C"), '[]')
  INTO canonical_authority
  FROM (
    SELECT DISTINCT item.value
    FROM jsonb_array_elements(authority_input) AS item(value)
  ) AS unique_authority;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(bindings_input) AS item(value)
    WHERE jsonb_typeof(item.value) IS DISTINCT FROM 'object'
      OR (
        SELECT string_agg(key, ',' ORDER BY key COLLATE "C")
        FROM jsonb_object_keys(item.value) AS key
      ) IS DISTINCT FROM 'companyId,identifierKey'
      OR jsonb_typeof(item.value->'identifierKey') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item.value->'companyId') IS DISTINCT FROM 'string'
  ) THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(bindings_input) AS item(value)
    WHERE octet_length(item.value->>'identifierKey') NOT BETWEEN 1 AND 512
      OR item.value->>'companyId' !~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(canonical_authority) AS authority
        WHERE authority->>'key' = item.value->>'identifierKey'
      )
  ) THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(bindings_input) AS item(value)
    GROUP BY item.value->>'identifierKey'
    HAVING count(DISTINCT item.value->>'companyId') > 1
  ) THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_CONTRADICTORY'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT coalesce(jsonb_agg(value ORDER BY value->>'identifierKey' COLLATE "C"), '[]')
  INTO canonical_bindings
  FROM (
    SELECT DISTINCT item.value
    FROM jsonb_array_elements(bindings_input) AS item(value)
  ) AS unique_bindings;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(mappings_input) AS item(value)
    WHERE jsonb_typeof(item.value) IS DISTINCT FROM 'object'
      OR (
        SELECT string_agg(key, ',' ORDER BY key COLLATE "C")
        FROM jsonb_object_keys(item.value) AS key
      ) IS DISTINCT FROM 'rootCompanyId,sourceCompanyId'
      OR jsonb_typeof(item.value->'sourceCompanyId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item.value->'rootCompanyId') IS DISTINCT FROM 'string'
  ) THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(mappings_input) AS item(value)
    WHERE item.value->>'sourceCompanyId' !~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR item.value->>'rootCompanyId' !~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR item.value->>'sourceCompanyId' = item.value->>'rootCompanyId'
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(mappings_input) AS item(value)
    GROUP BY item.value->>'sourceCompanyId'
    HAVING count(DISTINCT item.value->>'rootCompanyId') > 1
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(mappings_input) AS left_mapping(value)
    JOIN jsonb_array_elements(mappings_input) AS right_mapping(value)
      ON left_mapping.value->>'rootCompanyId' =
        right_mapping.value->>'sourceCompanyId'
  ) THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT coalesce(jsonb_agg(value ORDER BY value->>'sourceCompanyId' COLLATE "C"), '[]')
  INTO canonical_mappings
  FROM (
    SELECT DISTINCT item.value
    FROM jsonb_array_elements(mappings_input) AS item(value)
  ) AS unique_mappings;

  SELECT array_agg(root_company_id ORDER BY root_company_id COLLATE "C")
  INTO bound_roots
  FROM (
    SELECT DISTINCT coalesce(
      mapping->>'rootCompanyId', binding->>'companyId'
    ) AS root_company_id
    FROM jsonb_array_elements(canonical_bindings) AS binding
    LEFT JOIN jsonb_array_elements(canonical_mappings) AS mapping
      ON mapping->>'sourceCompanyId' = binding->>'companyId'
  ) AS roots;
  IF legacy_company_id IS NOT NULL THEN
    SELECT coalesce(mapping->>'rootCompanyId', legacy_company_id)
    INTO legacy_root
    FROM (SELECT 1) AS singleton
    LEFT JOIN jsonb_array_elements(canonical_mappings) AS mapping
      ON mapping->>'sourceCompanyId' = legacy_company_id;
  END IF;

  input_hash := encode(public.digest(
    public.raw_source_canonical_json_v1(jsonb_build_object(
      'raw', canonical_raw,
      'resolverVersion', 'organization-identity-resolver/v1',
      'blocker', canonical_blocker,
      'authorityIdentifiers', canonical_authority,
      'bindings', canonical_bindings,
      'rootMappings', canonical_mappings
    )),
    'sha256'
  ), 'hex');
  identifiers := canonical_authority;
  SELECT coalesce(jsonb_agg(item->>'key' ORDER BY item->>'key' COLLATE "C"), '[]')
  INTO identifier_keys
  FROM jsonb_array_elements(canonical_authority) AS item;

  IF coalesce(cardinality(bound_roots), 0) > 1 THEN
    plan_kind := 'conflict';
    conflict_type := 'identifier_split';
    company_ids := to_jsonb(bound_roots);
  ELSIF cardinality(bound_roots) = 1
    AND legacy_root IS NOT NULL
    AND bound_roots[1] IS DISTINCT FROM legacy_root
  THEN
    plan_kind := 'conflict';
    conflict_type := 'blocking_key_disagreement';
    SELECT jsonb_agg(value ORDER BY value COLLATE "C")
    INTO company_ids
    FROM (
      SELECT DISTINCT unnest(ARRAY[bound_roots[1], legacy_root]) AS value
    ) AS parties;
  ELSIF cardinality(bound_roots) = 1 THEN
    plan_kind := 'bind_existing';
    target_company_id := bound_roots[1];
  ELSIF legacy_root IS NOT NULL THEN
    plan_kind := 'lazy_upgrade';
    target_company_id := legacy_root;
  ELSE
    plan_kind := 'create_new';
  END IF;

  IF plan_kind = 'conflict' THEN
    conflict_fingerprint := encode(public.digest(
      public.raw_source_canonical_json_v1(jsonb_build_object(
        'resolverVersion', 'organization-identity-resolver/v1',
        'blocker', jsonb_build_object(
          'blockerKey', canonical_blocker->>'blockerKey',
          'matchRule', canonical_blocker->>'matchRule'
        ),
        'conflictType', conflict_type,
        'companyIds', company_ids,
        'identifierKeys', identifier_keys
      )),
      'sha256'
    ), 'hex');
    RETURN jsonb_build_object(
      'kind', 'conflict',
      'matchRule', 'identity_conflict',
      'conflictType', conflict_type,
      'companyIds', company_ids,
      'identifierKeys', identifier_keys,
      'inputHash', input_hash,
      'conflictFingerprint', conflict_fingerprint
    );
  END IF;

  match_rule := CASE
    WHEN jsonb_array_length(identifiers) > 0 THEN 'identity_v2'
    ELSE canonical_blocker->>'matchRule'
  END;
  IF plan_kind IN ('bind_existing', 'lazy_upgrade') THEN
    RETURN jsonb_build_object(
      'kind', plan_kind,
      'companyId', target_company_id,
      'matchRule', match_rule,
      'identifiers', identifiers,
      'inputHash', input_hash
    );
  END IF;
  RETURN jsonb_build_object(
    'kind', 'create_new',
    'matchRule', match_rule,
    'identifiers', identifiers,
    'inputHash', input_hash
  );
END
$organization_identity_plan$;

REVOKE ALL ON FUNCTION
  public.organization_identity_plan_from_snapshot_v1(jsonb)
FROM PUBLIC, app_user;

CREATE FUNCTION public.organization_identity_acquire_advisory_until_v1(
  p_lock_key bigint,
  p_deadline timestamptz
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $organization_identity_advisory$
DECLARE
  attempts integer := 0;
  bounded_deadline timestamptz;
BEGIN
  IF p_lock_key IS NULL OR p_deadline IS NULL THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
      USING ERRCODE = '22023';
  END IF;
  bounded_deadline := least(
    p_deadline,
    clock_timestamp() + interval '60 seconds'
  );
  LOOP
    IF clock_timestamp() >= bounded_deadline THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_LOCK_TIMEOUT'
        USING ERRCODE = '55P03';
    END IF;
    IF pg_try_advisory_xact_lock(p_lock_key) THEN
      RETURN;
    END IF;
    attempts := attempts + 1;
    IF attempts >= 6000 THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_LOCK_TIMEOUT'
        USING ERRCODE = '55P03';
    END IF;
    PERFORM pg_sleep(0.01);
  END LOOP;
END
$organization_identity_advisory$;

REVOKE ALL ON FUNCTION
  public.organization_identity_acquire_advisory_until_v1(bigint, timestamptz)
FROM PUBLIC, app_user;

CREATE FUNCTION public.resolve_organization_identity_for_raw_v1(
  p_workspace_id text,
  p_raw_record_id text
)
RETURNS TABLE (
  outcome_kind text,
  raw_record_id uuid,
  company_id uuid,
  conflict_id uuid,
  match_rule text,
  input_hash text,
  conflict_fingerprint text,
  replayed boolean,
  company_created boolean,
  identifier_count integer,
  party_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET lock_timeout = '5s'
SET statement_timeout = '60s'
SET row_security = off
AS $organization_identity_command$
DECLARE
  v_workspace_id uuid;
  v_raw_record_id uuid;
  workspace_setting text;
  lock_deadline timestamptz;
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_user IS NOT DISTINCT FROM session_user
    OR current_setting('role', true) IS DISTINCT FROM 'none'
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_COMMAND_DENIED'
      USING ERRCODE = '42501';
  END IF;
  IF p_workspace_id IS NULL OR p_raw_record_id IS NULL
    OR octet_length(p_workspace_id) > 36
    OR octet_length(p_raw_record_id) > 36
    OR p_workspace_id !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR p_raw_record_id !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  workspace_setting := current_setting(
    'app.current_workspace_id', true
  );
  IF workspace_setting IS NULL
    OR workspace_setting !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR workspace_setting IS DISTINCT FROM p_workspace_id
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_COMMAND_DENIED'
      USING ERRCODE = '42501';
  END IF;
  v_workspace_id := p_workspace_id::uuid;
  v_raw_record_id := p_raw_record_id::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM public.workspace AS w WHERE w.id = v_workspace_id
  ) THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_COMMAND_DENIED'
      USING ERRCODE = '42501';
  END IF;

  lock_deadline := clock_timestamp() + interval '5 seconds';
  PERFORM public.organization_identity_acquire_advisory_until_v1(
    hashtextextended(
      'acquisition-suppression-policy:' || v_workspace_id::text, 0
    ),
    lock_deadline
  );
  PERFORM public.organization_identity_acquire_advisory_until_v1(
    hashtextextended('organization-identity:' || v_workspace_id::text, 0),
    lock_deadline
  );
  PERFORM 1
  FROM public.raw_source_record AS r
  WHERE r.workspace_id = v_workspace_id
    AND r.id = v_raw_record_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_PLAN_STALE'
      USING ERRCODE = '40001';
  END IF;

  RAISE EXCEPTION 'IDENTITY_RESOLUTION_COMMAND_INCOMPLETE'
    USING ERRCODE = 'P0001';
END
$organization_identity_command$;

REVOKE ALL ON FUNCTION
  public.resolve_organization_identity_for_raw_v1(text, text)
FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION
  public.resolve_organization_identity_for_raw_v1(text, text)
FROM app_user;
GRANT EXECUTE ON FUNCTION
  public.resolve_organization_identity_for_raw_v1(text, text)
TO app_user;

DO $organization_identity_final_catalog$
DECLARE
  expected record;
  function_oid oid;
  function_owner oid;
  catalog_matches boolean;
  acl_matches boolean;
BEGIN
  IF current_user IS DISTINCT FROM 'global'
    OR NOT EXISTS (
      SELECT 1
      FROM pg_roles AS r
      WHERE r.rolname = 'app_user'
        AND NOT r.rolsuper
        AND NOT r.rolcreaterole
        AND NOT r.rolcreatedb
        AND NOT r.rolreplication
        AND NOT r.rolbypassrls
    )
    OR EXISTS (
      WITH RECURSIVE role_paths(member, roleid) AS (
        SELECT member, roleid FROM pg_auth_members
        UNION
        SELECT path.member, next_membership.roleid
        FROM role_paths AS path
        JOIN pg_auth_members AS next_membership
          ON next_membership.member = path.roleid
      )
      SELECT 1 FROM role_paths
      WHERE roleid = 'global'::regrole
        AND member <> 'global'::regrole
    )
    OR EXISTS (
      SELECT 1
      FROM pg_default_acl AS defaults
      CROSS JOIN LATERAL aclexplode(defaults.defaclacl) AS acl
      WHERE defaults.defaclrole = 'global'::regrole
        AND defaults.defaclobjtype = 'f'
        AND defaults.defaclnamespace IN (0, 'public'::regnamespace)
        AND acl.grantee <> 'global'::regrole::oid
        AND (acl.privilege_type = 'EXECUTE' OR acl.is_grantable)
    )
    OR to_regprocedure(
      'public.apply_organization_identity_resolution_v1(jsonb)'
    ) IS NOT NULL
    OR (
      SELECT count(*)
      FROM pg_proc AS p
      JOIN pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN (
          'organization_identity_authority_from_raw_v1',
          'organization_identity_blocker_from_raw_v1',
          'organization_identity_canonical_suppression_value_v1',
          'organization_identity_plan_from_snapshot_v1',
          'organization_identity_acquire_advisory_until_v1',
          'resolve_organization_identity_for_raw_v1'
        )
    ) IS DISTINCT FROM 6
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_CATALOG_RESIDUE'
      USING ERRCODE = 'P0001';
  END IF;

  FOR expected IN
    SELECT * FROM (VALUES
      (
        'organization_identity_authority_from_raw_v1',
        'text, jsonb', 'jsonb', false, 'i'::"char",
        false,
        ARRAY['search_path=pg_catalog, public']::text[], false
      ),
      (
        'organization_identity_blocker_from_raw_v1',
        'jsonb', 'jsonb', false, 'i'::"char",
        false,
        ARRAY['search_path=pg_catalog, public']::text[], false
      ),
      (
        'organization_identity_canonical_suppression_value_v1',
        'text, text', 'text', false, 'i'::"char",
        false,
        ARRAY['search_path=pg_catalog, public']::text[], false
      ),
      (
        'organization_identity_plan_from_snapshot_v1',
        'jsonb', 'jsonb', false, 'i'::"char",
        false,
        ARRAY['search_path=pg_catalog, public']::text[], false
      ),
      (
        'organization_identity_acquire_advisory_until_v1',
        'bigint, timestamp with time zone', 'void', false, 'v'::"char",
        false,
        ARRAY['search_path=pg_catalog, public']::text[], false
      ),
      (
        'resolve_organization_identity_for_raw_v1',
        'text, text',
        'TABLE(outcome_kind text, raw_record_id uuid, company_id uuid, conflict_id uuid, match_rule text, input_hash text, conflict_fingerprint text, replayed boolean, company_created boolean, identifier_count integer, party_count integer)',
        true, 'v'::"char",
        true,
        ARRAY[
          'search_path=pg_catalog, public',
          'lock_timeout=5s',
          'statement_timeout=60s',
          'row_security=off'
        ]::text[],
        true
      )
    ) AS contract(
      function_name, identity_arguments, result_type, security_definer,
      volatility, returns_set, function_config, app_user_execute
    )
  LOOP
    SELECT
      p.oid,
      p.proowner,
      language.lanname = 'plpgsql'
        AND pg_get_userbyid(p.proowner) = 'global'
        AND p.prosecdef = expected.security_definer
        AND p.provolatile = expected.volatility
        AND p.proretset = expected.returns_set
        AND p.proparallel = 'u'
        AND NOT p.proleakproof
        AND NOT p.proisstrict
        AND p.prokind = 'f'
        AND p.proconfig IS NOT DISTINCT FROM expected.function_config
        AND pg_get_function_result(p.oid) = expected.result_type
        AND p.proacl IS NOT NULL
    INTO function_oid, function_owner, catalog_matches
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    JOIN pg_language AS language ON language.oid = p.prolang
    WHERE n.nspname = 'public'
      AND p.proname = expected.function_name
      AND oidvectortypes(p.proargtypes) = expected.identity_arguments;

    IF NOT FOUND OR NOT coalesce(catalog_matches, false) THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_CATALOG_RESIDUE'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT CASE
      WHEN expected.app_user_execute THEN
        count(*) = 2
        AND bool_and(
          acl.grantor = function_owner
          AND acl.privilege_type = 'EXECUTE'
          AND NOT acl.is_grantable
          AND acl.grantee IN (
            function_owner,
            to_regrole('app_user')::oid
          )
        )
        AND count(*) FILTER (
          WHERE acl.grantee = function_owner
        ) = 1
        AND count(*) FILTER (
          WHERE acl.grantee = to_regrole('app_user')::oid
        ) = 1
      ELSE
        count(*) = 1
        AND bool_and(
          acl.grantee = function_owner
          AND acl.grantor = function_owner
          AND acl.privilege_type = 'EXECUTE'
          AND NOT acl.is_grantable
        )
      END
    INTO acl_matches
    FROM pg_proc AS p
    CROSS JOIN LATERAL aclexplode(p.proacl) AS acl
    WHERE p.oid = function_oid;

    IF NOT coalesce(acl_matches, false) THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_CATALOG_RESIDUE'
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
END
$organization_identity_final_catalog$;

COMMIT;
