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
      WITH RECURSIVE capability_paths(start_role, reached_role, mode) AS (
        SELECT membership.member, membership.roleid, capability.mode
        FROM pg_auth_members AS membership
        CROSS JOIN LATERAL (VALUES
          ('inherit'::text, membership.inherit_option),
          ('set_role'::text, membership.set_option)
        ) AS capability(mode, enabled)
        WHERE capability.enabled
        UNION
        SELECT path.start_role, next_membership.roleid, path.mode
        FROM capability_paths AS path
        JOIN pg_auth_members AS next_membership
          ON next_membership.member = path.reached_role
        WHERE (
          path.mode = 'inherit' AND next_membership.inherit_option
        ) OR (
          path.mode = 'set_role' AND next_membership.set_option
        )
      )
      SELECT 1 FROM capability_paths
      WHERE reached_role = 'global'::regrole
        AND start_role <> 'global'::regrole
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
        'organization_identity_acquire_advisory_until_v1',
        'organization_identity_resolve_for_raw_worker_v1'
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
REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION
  public.organization_identity_canonical_suppression_value_v1(text, text)
FROM global;

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
REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION
  public.organization_identity_authority_from_raw_v1(text, jsonb)
FROM global;

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
REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION
  public.organization_identity_blocker_from_raw_v1(jsonb)
FROM global;

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
REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION
  public.organization_identity_plan_from_snapshot_v1(jsonb)
FROM global;

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
REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION
  public.organization_identity_acquire_advisory_until_v1(bigint, timestamptz)
FROM global;

CREATE FUNCTION public.organization_identity_resolve_for_raw_worker_v1(
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
SECURITY INVOKER
SET search_path = pg_catalog, public
SET row_security = off
AS $organization_identity_worker$
DECLARE
  v_workspace_id uuid;
  v_raw_record_id uuid;
  lock_deadline timestamptz;
  stored_raw record;
  stored_company record;
  stored_identifier record;
  stored_link record;
  stored_conflict record;
  stored_owner_raw record;
  authority_identifiers jsonb;
  owner_authority_identifiers jsonb;
  blocker jsonb;
  owner_blocker jsonb;
  resolution_plan jsonb;
  owner_resolution_plan jsonb;
  existing_bindings jsonb := '[]'::jsonb;
  owner_existing_bindings jsonb := '[]'::jsonb;
  root_mappings jsonb := '[]'::jsonb;
  owner_root_mappings jsonb := '[]'::jsonb;
  all_root_mappings jsonb := '[]'::jsonb;
  expected_conflict_facts jsonb;
  blocker_company_id uuid;
  owner_blocker_company_id uuid;
  legacy_company_id uuid;
  legacy_dedupe_key text;
  legacy_match_rule text;
  target_company_id uuid;
  existing_identifier_root uuid;
  planner_company_ids uuid[] := ARRAY[]::uuid[];
  owner_planner_company_ids uuid[] := ARRAY[]::uuid[];
  owner_involved_company_ids uuid[] := ARRAY[]::uuid[];
  mapping_source_company_ids uuid[] := ARRAY[]::uuid[];
  locked_company_ids uuid[] := ARRAY[]::uuid[];
  conflict_company_ids uuid[] := ARRAY[]::uuid[];
  actual_party_ids uuid[] := ARRAY[]::uuid[];
  expected_identifier_keys text[] := ARRAY[]::text[];
  actual_link_company_ids uuid[] := ARRAY[]::uuid[];
  owner_link_company_ids uuid[] := ARRAY[]::uuid[];
  raw_name text;
  raw_domain text;
  raw_country text;
  canonical_raw_name text;
  canonical_raw_domain text;
  legacy_identifier_value text;
  plan_kind text;
  plan_match_rule text;
  plan_input_hash text;
  plan_conflict_fingerprint text;
  plan_conflict_type text;
  owner_input_hash text;
  identifier_fact jsonb;
  conflict_company_id uuid;
  locked_company_count integer := 0;
  link_total integer := 0;
  owner_link_total integer := 0;
  identifier_total integer := 0;
  party_total integer := 0;
  conflict_created boolean := false;
  raw_processing_restricted boolean := false;
  owner_processing_restricted boolean := false;
  owner_raw_found boolean := false;
  command_admission_open boolean := true;
  error_state text;
  error_message text;
BEGIN
  IF p_workspace_id IS NULL OR p_raw_record_id IS NULL
    OR octet_length(p_workspace_id) > 36
    OR octet_length(p_raw_record_id) > 36
    OR p_workspace_id !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR p_raw_record_id !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  v_workspace_id := p_workspace_id::uuid;
  v_raw_record_id := p_raw_record_id::uuid;
  BEGIN
    IF NOT EXISTS (
    SELECT 1 FROM public.workspace AS w WHERE w.id = v_workspace_id
    ) THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_COMMAND_DENIED'
        USING ERRCODE = '42501';
    END IF;

    lock_deadline := least(
      statement_timestamp() + current_setting('statement_timeout')::interval,
      clock_timestamp() + current_setting('lock_timeout')::interval
    );
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
    FROM public.workspace AS w
    WHERE w.id = v_workspace_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_COMMAND_DENIED'
        USING ERRCODE = '42501';
    END IF;
    command_admission_open := false;

    SELECT
      r.id,
      r.workspace_id,
      r.provider_key,
      r.payload,
      r.payload_hash,
      r.ingest_version,
      r.ingest_status,
      r.disposition_code,
      r.expires_at,
      r.expired_at
    INTO stored_raw
    FROM public.raw_source_record AS r
    WHERE r.workspace_id = v_workspace_id
      AND r.id = v_raw_record_id
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_PLAN_STALE'
        USING ERRCODE = '40001';
    END IF;
    IF stored_raw.workspace_id IS DISTINCT FROM v_workspace_id
      OR stored_raw.id IS DISTINCT FROM v_raw_record_id
      OR stored_raw.ingest_status IS DISTINCT FROM 'ACCEPTED'
      OR stored_raw.ingest_version IS DISTINCT FROM 'raw-source/v2'
      OR stored_raw.payload_hash IS NULL
      OR stored_raw.payload_hash !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(stored_raw.payload) IS DISTINCT FROM 'object'
      OR octet_length(stored_raw.payload::text) > 65536
      OR stored_raw.expired_at IS NOT NULL
      OR (
        stored_raw.expires_at IS NOT NULL
        AND stored_raw.expires_at <= statement_timestamp()
      )
    THEN
      RAISE EXCEPTION 'IDENTITY_RAW_NOT_RESOLVABLE'
        USING ERRCODE = 'P0001';
    END IF;
    EXECUTE $restricted_raw$
      SELECT EXISTS (
        SELECT 1
        FROM public.raw_source_governance_disposition AS disposition
        WHERE disposition.workspace_id = $1
          AND disposition.raw_record_id = $2
          AND disposition.effect = 'RESTRICT_PROCESSING'
      )
    $restricted_raw$
    INTO raw_processing_restricted
    USING v_workspace_id, v_raw_record_id;
    IF raw_processing_restricted THEN
      RAISE EXCEPTION 'IDENTITY_RAW_PROCESSING_RESTRICTED'
        USING ERRCODE = 'P0001';
    END IF;

    BEGIN
      authority_identifiers :=
        public.organization_identity_authority_from_raw_v1(
          stored_raw.provider_key,
          stored_raw.payload
        );
      blocker := public.organization_identity_blocker_from_raw_v1(
        stored_raw.payload
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'IDENTITY_RAW_NOT_RESOLVABLE'
        USING ERRCODE = 'P0001';
    END;
    IF jsonb_typeof(authority_identifiers) IS DISTINCT FROM 'array'
      OR jsonb_array_length(authority_identifiers) > 32
      OR jsonb_typeof(blocker) IS DISTINCT FROM 'object'
      OR blocker ? 'kind'
      OR blocker->>'matchRule' IS NULL
      OR blocker->>'matchRule' NOT IN ('domain_exact', 'name_country')
      OR octet_length(blocker->>'blockerKey') NOT BETWEEN 1 AND 512
    THEN
      RAISE EXCEPTION 'IDENTITY_RAW_NOT_RESOLVABLE'
        USING ERRCODE = 'P0001';
    END IF;

    raw_name := stored_raw.payload->>'name';
    raw_domain := CASE
      WHEN jsonb_typeof(stored_raw.payload->'domain') = 'string'
        THEN stored_raw.payload->>'domain'
      ELSE NULL
    END;
    raw_country := CASE
      WHEN jsonb_typeof(stored_raw.payload->'country') = 'string'
        THEN stored_raw.payload->>'country'
      ELSE NULL
    END;
    canonical_raw_name :=
      public.organization_identity_canonical_suppression_value_v1(
        'company_name', raw_name
      );
    canonical_raw_domain := CASE
      WHEN raw_domain IS NULL THEN NULL
      ELSE public.organization_identity_canonical_suppression_value_v1(
        'domain', raw_domain
      )
    END;
    IF canonical_raw_name IS NULL
      OR (raw_domain IS NOT NULL AND canonical_raw_domain IS NULL)
    THEN
      RAISE EXCEPTION 'IDENTITY_RAW_NOT_RESOLVABLE'
        USING ERRCODE = 'P0001';
    END IF;

    legacy_dedupe_key := blocker->>'blockerKey';
    legacy_match_rule := blocker->>'matchRule';
    IF raw_domain IS NULL
      AND jsonb_typeof(stored_raw.payload->'identifier') = 'object'
      AND jsonb_typeof(stored_raw.payload->'identifier'->'scheme') = 'string'
      AND jsonb_typeof(stored_raw.payload->'identifier'->'value') = 'string'
    THEN
      legacy_identifier_value := lower(regexp_replace(
        normalize(stored_raw.payload->'identifier'->>'value', NFC),
        '[^[:alnum:]]+',
        '',
        'g'
      ));
      IF legacy_identifier_value <> '' THEN
        legacy_dedupe_key :=
          'id:' || lower(stored_raw.payload->'identifier'->>'scheme') ||
          ':' || legacy_identifier_value;
        legacy_match_rule := 'identifier_exact';
      END IF;
    END IF;

    SELECT c.id
    INTO blocker_company_id
    FROM public.canonical_company AS c
    WHERE c.workspace_id = v_workspace_id
      AND c.dedupe_key = blocker->>'blockerKey';
    SELECT c.id
    INTO legacy_company_id
    FROM public.canonical_company AS c
    WHERE c.workspace_id = v_workspace_id
      AND c.dedupe_key = legacy_dedupe_key;

    IF EXISTS (
      SELECT 1
      FROM public.organization_identifier AS oi
      JOIN jsonb_array_elements(authority_identifiers) AS authority(value)
        ON oi.scheme = authority.value->>'scheme'
        AND oi.jurisdiction = authority.value->>'jurisdiction'
        AND oi.normalized_value = authority.value->>'normalizedValue'
      WHERE oi.workspace_id = v_workspace_id
        AND oi.status = 'ACTIVE'
        AND (
          oi.conflict_id IS NOT NULL
          OR oi.revoked_at IS NOT NULL
          OR oi.confidence IS DISTINCT FROM 1
          OR oi.authority_provider_key IS DISTINCT FROM
            authority.value->>'providerKey'
          OR oi.normalizer_version IS DISTINCT FROM
            authority.value->>'normalizerVersion'
          OR oi.validator_version IS DISTINCT FROM
            authority.value->>'validatorVersion'
        )
    ) THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
        USING ERRCODE = 'P0001';
    END IF;
    SELECT coalesce(jsonb_agg(
      jsonb_build_object(
        'identifierKey',
          oi.scheme || ':' || oi.jurisdiction || ':' || oi.normalized_value,
        'companyId', oi.company_id::text
      ) ORDER BY
        oi.scheme || ':' || oi.jurisdiction || ':' || oi.normalized_value
        COLLATE "C"
    ), '[]'::jsonb)
    INTO existing_bindings
    FROM public.organization_identifier AS oi
    JOIN jsonb_array_elements(authority_identifiers) AS authority(value)
      ON oi.scheme = authority.value->>'scheme'
      AND oi.jurisdiction = authority.value->>'jurisdiction'
      AND oi.normalized_value = authority.value->>'normalizedValue'
    WHERE oi.workspace_id = v_workspace_id
      AND oi.status = 'ACTIVE';
    IF jsonb_array_length(existing_bindings) > 64 THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT coalesce(
      array_agg(involved.involved_company_id ORDER BY involved.involved_company_id),
      ARRAY[]::uuid[]
    )
    INTO planner_company_ids
    FROM (
      SELECT DISTINCT blocker_company_id AS involved_company_id
      WHERE blocker_company_id IS NOT NULL
      UNION
      SELECT DISTINCT (binding.value->>'companyId')::uuid
      FROM jsonb_array_elements(existing_bindings) AS binding(value)
    ) AS involved;
    SELECT coalesce(
      array_agg(involved.involved_company_id ORDER BY involved.involved_company_id),
      ARRAY[]::uuid[]
    )
    INTO mapping_source_company_ids
    FROM (
      SELECT DISTINCT planner_id AS involved_company_id
      FROM unnest(planner_company_ids) AS planner(planner_id)
      UNION
      SELECT DISTINCT legacy_company_id
      WHERE legacy_company_id IS NOT NULL
    ) AS involved;
    IF EXISTS (
      SELECT 1
      FROM public.organization_canonical_mapping AS m
      WHERE m.workspace_id = v_workspace_id
        AND m.status = 'ACTIVE'
        AND m.source_company_id = ANY(mapping_source_company_ids)
        AND (
          m.source_company_id = m.canonical_company_id
          OR m.revision < 1
          OR m.revoked_at IS NOT NULL
          OR m.split_decision_id IS NOT NULL
        )
    ) OR EXISTS (
      SELECT 1
      FROM public.organization_canonical_mapping AS first_mapping
      JOIN public.organization_canonical_mapping AS next_mapping
        ON next_mapping.workspace_id = v_workspace_id
        AND next_mapping.status = 'ACTIVE'
        AND next_mapping.source_company_id =
          first_mapping.canonical_company_id
      WHERE first_mapping.workspace_id = v_workspace_id
        AND first_mapping.status = 'ACTIVE'
        AND first_mapping.source_company_id = ANY(mapping_source_company_ids)
    ) THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
        USING ERRCODE = 'P0001';
    END IF;
    SELECT coalesce(jsonb_agg(
      jsonb_build_object(
        'sourceCompanyId', m.source_company_id::text,
        'rootCompanyId', m.canonical_company_id::text
      ) ORDER BY m.source_company_id
    ), '[]'::jsonb)
    INTO all_root_mappings
    FROM public.organization_canonical_mapping AS m
    WHERE m.workspace_id = v_workspace_id
      AND m.status = 'ACTIVE'
      AND m.source_company_id = ANY(mapping_source_company_ids);
    IF jsonb_array_length(all_root_mappings) > 64 THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
        USING ERRCODE = 'P0001';
    END IF;
    SELECT coalesce(jsonb_agg(
      mapping.value ORDER BY mapping.value->>'sourceCompanyId' COLLATE "C"
    ), '[]'::jsonb)
    INTO root_mappings
    FROM jsonb_array_elements(all_root_mappings) AS mapping(value)
    WHERE (mapping.value->>'sourceCompanyId')::uuid =
      ANY(planner_company_ids);

    SELECT coalesce(
      array_agg(involved.involved_company_id ORDER BY involved.involved_company_id),
      ARRAY[]::uuid[]
    )
    INTO locked_company_ids
    FROM (
      SELECT DISTINCT source_id AS involved_company_id
      FROM unnest(mapping_source_company_ids) AS source(source_id)
      UNION
      SELECT DISTINCT (mapping.value->>'rootCompanyId')::uuid
      FROM jsonb_array_elements(all_root_mappings) AS mapping(value)
    ) AS involved;
    locked_company_count := 0;
    FOR stored_company IN
      SELECT c.*
      FROM public.canonical_company AS c
      WHERE c.workspace_id = v_workspace_id
        AND c.id = ANY(locked_company_ids)
      ORDER BY c.id
      FOR UPDATE
    LOOP
      locked_company_count := locked_company_count + 1;
      IF stored_company.name IS NULL
        OR public.organization_identity_canonical_suppression_value_v1(
          'company_name', stored_company.name
        ) IS NULL
        OR (
          stored_company.domain IS NOT NULL
          AND public.organization_identity_canonical_suppression_value_v1(
            'domain', stored_company.domain
          ) IS NULL
        )
      THEN
        RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
          USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
    IF locked_company_count IS DISTINCT FROM cardinality(locked_company_ids)
    THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
        USING ERRCODE = 'P0001';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.suppression_record AS s
      WHERE s.workspace_id = v_workspace_id
        AND (
          (
            s.type = 'company_name'
            AND public.organization_identity_canonical_suppression_value_v1(
              'company_name', s.value
            ) = canonical_raw_name
          ) OR (
            s.type = 'domain'
            AND canonical_raw_domain IS NOT NULL
            AND public.organization_identity_canonical_suppression_value_v1(
              'domain', s.value
            ) = canonical_raw_domain
          )
        )
    ) OR EXISTS (
      SELECT 1
      FROM public.canonical_company AS c
      WHERE c.workspace_id = v_workspace_id
        AND c.id = ANY(locked_company_ids)
        AND (
          c.status = 'SUPPRESSED'
          OR EXISTS (
            SELECT 1
            FROM public.suppression_record AS s
            WHERE s.workspace_id = v_workspace_id
              AND (
                (
                  s.type = 'company_name'
                  AND public.organization_identity_canonical_suppression_value_v1(
                    'company_name', s.value
                  ) =
                    public.organization_identity_canonical_suppression_value_v1(
                      'company_name', c.name
                    )
                ) OR (
                  s.type = 'domain'
                  AND c.domain IS NOT NULL
                  AND public.organization_identity_canonical_suppression_value_v1(
                    'domain', s.value
                  ) =
                    public.organization_identity_canonical_suppression_value_v1(
                      'domain', c.domain
                    )
                )
              )
          )
        )
    ) THEN
      RETURN QUERY SELECT
        'suppressed'::text,
        v_raw_record_id,
        NULL::uuid,
        NULL::uuid,
        NULL::text,
        NULL::text,
        NULL::text,
        false,
        false,
        0,
        0;
      RETURN;
    END IF;

    BEGIN
      resolution_plan := public.organization_identity_plan_from_snapshot_v1(
        jsonb_build_object(
          'raw', jsonb_build_object(
            'rawRecordId', stored_raw.id::text,
            'providerKey', stored_raw.provider_key,
            'payloadHash', stored_raw.payload_hash,
            'ingestVersion', stored_raw.ingest_version
          ),
          'resolverVersion', 'organization-identity-resolver/v1',
          'blocker', jsonb_build_object(
            'blockerKey', blocker->>'blockerKey',
            'matchRule', blocker->>'matchRule',
            'legacyCandidateCompanyId', blocker_company_id
          ),
          'authorityIdentifiers', authority_identifiers,
          'existingBindings', existing_bindings,
          'rootMappings', root_mappings
        )
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
        USING ERRCODE = 'P0001';
    END;
    plan_kind := resolution_plan->>'kind';
    plan_match_rule := resolution_plan->>'matchRule';
    plan_input_hash := resolution_plan->>'inputHash';
    plan_conflict_fingerprint := resolution_plan->>'conflictFingerprint';
    plan_conflict_type := resolution_plan->>'conflictType';
    IF plan_kind IS NULL
      OR plan_kind NOT IN (
        'bind_existing', 'lazy_upgrade', 'create_new', 'conflict'
      )
      OR plan_input_hash IS NULL
      OR plan_input_hash !~ '^[0-9a-f]{64}$'
    THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
        USING ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM public.identity_link AS l
    WHERE l.workspace_id = v_workspace_id
      AND l.raw_record_id = v_raw_record_id
    ORDER BY l.id
    FOR UPDATE;
    SELECT count(*)::integer
    INTO link_total
    FROM public.identity_link AS l
    WHERE l.workspace_id = v_workspace_id
      AND l.raw_record_id = v_raw_record_id;

    IF plan_kind <> 'conflict' AND link_total > 0 THEN
      IF link_total <> 1 THEN
        RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
          USING ERRCODE = 'P0001';
      END IF;
      SELECT l.*
      INTO stored_link
      FROM public.identity_link AS l
      WHERE l.workspace_id = v_workspace_id
        AND l.raw_record_id = v_raw_record_id;
      IF stored_link.resolver_version = 'identity-v1' THEN
        IF stored_link.canonical_type IS DISTINCT FROM 'company'
          OR stored_link.canonical_id IS DISTINCT FROM legacy_company_id
          OR stored_link.match_rule IS DISTINCT FROM legacy_match_rule
          OR stored_link.confidence IS DISTINCT FROM (CASE
            WHEN legacy_match_rule = 'name_country' THEN 0.8
            ELSE 1
          END)
          OR stored_link.status IS DISTINCT FROM 'ACTIVE'
          OR stored_link.input_hash IS DISTINCT FROM 'legacy'
          OR stored_link.conflict_id IS NOT NULL
          OR legacy_company_id IS NULL
        THEN
          RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
            USING ERRCODE = 'P0001';
        END IF;
        RETURN QUERY SELECT
          'legacy_bound'::text,
          v_raw_record_id,
          stored_link.canonical_id,
          NULL::uuid,
          legacy_match_rule,
          'legacy'::text,
          NULL::text,
          true,
          false,
          0,
          0;
        RETURN;
      END IF;
      IF stored_link.resolver_version IS DISTINCT FROM
          'organization-identity-resolver/v1'
        OR stored_link.canonical_type IS DISTINCT FROM 'company'
        OR stored_link.status IS DISTINCT FROM 'ACTIVE'
        OR stored_link.conflict_id IS NOT NULL
        OR plan_kind NOT IN ('bind_existing', 'lazy_upgrade')
      THEN
        RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
          USING ERRCODE = 'P0001';
      END IF;
      target_company_id := (resolution_plan->>'companyId')::uuid;
      IF stored_link.canonical_id IS DISTINCT FROM target_company_id
        OR stored_link.match_rule IS DISTINCT FROM plan_match_rule
        OR stored_link.confidence IS DISTINCT FROM (CASE
          WHEN plan_match_rule = 'name_country' THEN 0.8
          ELSE 1
        END)
      THEN
        RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
          USING ERRCODE = 'P0001';
      END IF;
      IF stored_link.input_hash IS DISTINCT FROM plan_input_hash THEN
        RAISE EXCEPTION 'IDENTITY_INPUT_DRIFT'
          USING ERRCODE = 'P0001';
      END IF;
      RETURN QUERY SELECT
        'bound'::text,
        v_raw_record_id,
        target_company_id,
        NULL::uuid,
        plan_match_rule,
        plan_input_hash,
        NULL::text,
        true,
        false,
        jsonb_array_length(authority_identifiers),
        0;
      RETURN;
    END IF;

    IF plan_kind = 'conflict' THEN
      IF plan_match_rule IS DISTINCT FROM 'identity_conflict'
        OR plan_conflict_type NOT IN (
          'identifier_split', 'blocking_key_disagreement'
        )
        OR plan_conflict_fingerprint !~ '^[0-9a-f]{64}$'
        OR jsonb_typeof(resolution_plan->'companyIds') IS DISTINCT FROM 'array'
        OR jsonb_typeof(resolution_plan->'identifierKeys') IS DISTINCT FROM 'array'
      THEN
        RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
          USING ERRCODE = 'P0001';
      END IF;
      SELECT coalesce(array_agg(value::uuid ORDER BY value::uuid), ARRAY[]::uuid[])
      INTO conflict_company_ids
      FROM jsonb_array_elements_text(
        resolution_plan->'companyIds'
      ) AS value;
      SELECT coalesce(array_agg(value ORDER BY value COLLATE "C"), ARRAY[]::text[])
      INTO expected_identifier_keys
      FROM jsonb_array_elements_text(
        resolution_plan->'identifierKeys'
      ) AS value;
      IF cardinality(conflict_company_ids) NOT BETWEEN 2 AND 64
        OR conflict_company_ids IS DISTINCT FROM ARRAY(
          SELECT DISTINCT candidate_id
          FROM unnest(conflict_company_ids) AS candidate(candidate_id)
          ORDER BY candidate_id
        )
        OR expected_identifier_keys IS DISTINCT FROM ARRAY(
          SELECT DISTINCT identifier_key COLLATE "C"
          FROM unnest(expected_identifier_keys) AS item(identifier_key)
          ORDER BY identifier_key COLLATE "C"
        )
        OR EXISTS (
          SELECT 1
          FROM unnest(conflict_company_ids) AS candidate(candidate_id)
          WHERE NOT candidate.candidate_id = ANY(locked_company_ids)
        )
      THEN
        RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
          USING ERRCODE = 'P0001';
      END IF;
      expected_conflict_facts := jsonb_build_object(
        'schemaVersion', 'organization-identity-conflict/v1',
        'resolverVersion', 'organization-identity-resolver/v1',
        'blockerKey', blocker->>'blockerKey',
        'blockerRule', blocker->>'matchRule',
        'conflictType', plan_conflict_type,
        'companyIds', to_jsonb(conflict_company_ids),
        'identifierKeys', to_jsonb(expected_identifier_keys)
      );

      SELECT c.*
      INTO stored_conflict
      FROM public.organization_identity_conflict AS c
      WHERE c.workspace_id = v_workspace_id
        AND c.fingerprint = plan_conflict_fingerprint
      FOR UPDATE;
      IF FOUND THEN
        IF stored_conflict.conflict_type IS DISTINCT FROM plan_conflict_type
          OR stored_conflict.status IS DISTINCT FROM 'OPEN'
          OR stored_conflict.revision IS DISTINCT FROM 1
          OR stored_conflict.facts IS DISTINCT FROM expected_conflict_facts
          OR stored_conflict.resolved_at IS NOT NULL
          OR stored_conflict.raw_record_id IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM public.raw_source_record AS conflict_raw
            WHERE conflict_raw.workspace_id = v_workspace_id
              AND conflict_raw.id = stored_conflict.raw_record_id
          )
        THEN
          RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
            USING ERRCODE = 'P0001';
        END IF;
      ELSE
        INSERT INTO public.organization_identity_conflict(
          workspace_id,
          raw_record_id,
          conflict_type,
          fingerprint,
          status,
          revision,
          facts
        ) VALUES (
          v_workspace_id,
          v_raw_record_id,
          plan_conflict_type,
          plan_conflict_fingerprint,
          'OPEN',
          1,
          expected_conflict_facts
        )
        RETURNING * INTO stored_conflict;
        conflict_created := true;
      END IF;

      IF conflict_created THEN
        FOREACH conflict_company_id IN ARRAY conflict_company_ids LOOP
          INSERT INTO public.organization_identity_conflict_party(
            workspace_id, conflict_id, company_id, role
          ) VALUES (
            v_workspace_id,
            stored_conflict.id,
            conflict_company_id,
            'CANDIDATE'
          );
        END LOOP;
      ELSE
        PERFORM 1
        FROM public.organization_identity_conflict_party AS party
        WHERE party.workspace_id = v_workspace_id
          AND party.conflict_id = stored_conflict.id
        ORDER BY party.company_id, party.role
        FOR UPDATE;
        SELECT
          coalesce(
            array_agg(party.company_id ORDER BY party.company_id),
            ARRAY[]::uuid[]
          ),
          count(*)::integer
        INTO actual_party_ids, party_total
        FROM public.organization_identity_conflict_party AS party
        WHERE party.workspace_id = v_workspace_id
          AND party.conflict_id = stored_conflict.id
          AND party.role = 'CANDIDATE';
        IF party_total IS DISTINCT FROM cardinality(conflict_company_ids)
          OR actual_party_ids IS DISTINCT FROM conflict_company_ids
          OR EXISTS (
            SELECT 1
            FROM public.organization_identity_conflict_party AS party
            WHERE party.workspace_id = v_workspace_id
              AND party.conflict_id = stored_conflict.id
              AND party.role IS DISTINCT FROM 'CANDIDATE'
          )
        THEN
          RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
            USING ERRCODE = 'P0001';
        END IF;
      END IF;
      party_total := cardinality(conflict_company_ids);

      IF NOT conflict_created THEN
        IF stored_conflict.raw_record_id = v_raw_record_id THEN
          owner_resolution_plan := resolution_plan;
        ELSE
          SELECT
            owner_raw.id,
            owner_raw.workspace_id,
            owner_raw.provider_key,
            owner_raw.payload,
            owner_raw.payload_hash,
            owner_raw.ingest_version,
            owner_raw.ingest_status,
            owner_raw.expires_at,
            owner_raw.expired_at
          INTO stored_owner_raw
          FROM public.raw_source_record AS owner_raw
          WHERE owner_raw.workspace_id = v_workspace_id
            AND owner_raw.id = stored_conflict.raw_record_id
          FOR KEY SHARE;
          owner_raw_found := FOUND;
          EXECUTE $restricted_owner_raw$
            SELECT EXISTS (
              SELECT 1
              FROM public.raw_source_governance_disposition AS disposition
              WHERE disposition.workspace_id = $1
                AND disposition.raw_record_id = $2
                AND disposition.effect = 'RESTRICT_PROCESSING'
            )
          $restricted_owner_raw$
          INTO owner_processing_restricted
          USING v_workspace_id, stored_conflict.raw_record_id;
          IF NOT owner_raw_found
            OR stored_owner_raw.workspace_id IS DISTINCT FROM v_workspace_id
            OR stored_owner_raw.id IS DISTINCT FROM
              stored_conflict.raw_record_id
            OR stored_owner_raw.ingest_status IS DISTINCT FROM 'ACCEPTED'
            OR stored_owner_raw.ingest_version IS DISTINCT FROM
              'raw-source/v2'
            OR stored_owner_raw.payload_hash IS NULL
            OR stored_owner_raw.payload_hash !~ '^[0-9a-f]{64}$'
            OR jsonb_typeof(stored_owner_raw.payload) IS DISTINCT FROM
              'object'
            OR octet_length(stored_owner_raw.payload::text) > 65536
            OR stored_owner_raw.expired_at IS NOT NULL
            OR (
              stored_owner_raw.expires_at IS NOT NULL
              AND stored_owner_raw.expires_at <= statement_timestamp()
            )
            OR owner_processing_restricted
          THEN
            RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
              USING ERRCODE = 'P0001';
          END IF;

          BEGIN
            owner_authority_identifiers :=
              public.organization_identity_authority_from_raw_v1(
                stored_owner_raw.provider_key,
                stored_owner_raw.payload
              );
            owner_blocker :=
              public.organization_identity_blocker_from_raw_v1(
                stored_owner_raw.payload
              );
          EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
              USING ERRCODE = 'P0001';
          END;
          IF jsonb_typeof(owner_authority_identifiers) IS DISTINCT FROM 'array'
            OR jsonb_array_length(owner_authority_identifiers) > 32
            OR jsonb_typeof(owner_blocker) IS DISTINCT FROM 'object'
            OR owner_blocker ? 'kind'
            OR owner_blocker->>'matchRule' IS NULL
            OR owner_blocker->>'matchRule' NOT IN (
              'domain_exact', 'name_country'
            )
            OR octet_length(owner_blocker->>'blockerKey') NOT BETWEEN 1 AND 512
          THEN
            RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
              USING ERRCODE = 'P0001';
          END IF;

          SELECT owner_company.id
          INTO owner_blocker_company_id
          FROM public.canonical_company AS owner_company
          WHERE owner_company.workspace_id = v_workspace_id
            AND owner_company.dedupe_key = owner_blocker->>'blockerKey';
          IF EXISTS (
            SELECT 1
            FROM public.organization_identifier AS owner_identifier
            JOIN jsonb_array_elements(
              owner_authority_identifiers
            ) AS owner_authority(value)
              ON owner_identifier.scheme = owner_authority.value->>'scheme'
              AND owner_identifier.jurisdiction =
                owner_authority.value->>'jurisdiction'
              AND owner_identifier.normalized_value =
                owner_authority.value->>'normalizedValue'
            WHERE owner_identifier.workspace_id = v_workspace_id
              AND owner_identifier.status = 'ACTIVE'
              AND (
                owner_identifier.conflict_id IS NOT NULL
                OR owner_identifier.revoked_at IS NOT NULL
                OR owner_identifier.confidence IS DISTINCT FROM 1
                OR owner_identifier.authority_provider_key IS DISTINCT FROM
                  owner_authority.value->>'providerKey'
                OR owner_identifier.normalizer_version IS DISTINCT FROM
                  owner_authority.value->>'normalizerVersion'
                OR owner_identifier.validator_version IS DISTINCT FROM
                  owner_authority.value->>'validatorVersion'
              )
          ) THEN
            RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
              USING ERRCODE = 'P0001';
          END IF;
          SELECT coalesce(jsonb_agg(
            jsonb_build_object(
              'identifierKey',
                owner_identifier.scheme || ':' ||
                owner_identifier.jurisdiction || ':' ||
                owner_identifier.normalized_value,
              'companyId', owner_identifier.company_id::text
            ) ORDER BY
              owner_identifier.scheme || ':' ||
              owner_identifier.jurisdiction || ':' ||
              owner_identifier.normalized_value COLLATE "C"
          ), '[]'::jsonb)
          INTO owner_existing_bindings
          FROM public.organization_identifier AS owner_identifier
          JOIN jsonb_array_elements(
            owner_authority_identifiers
          ) AS owner_authority(value)
            ON owner_identifier.scheme = owner_authority.value->>'scheme'
            AND owner_identifier.jurisdiction =
              owner_authority.value->>'jurisdiction'
            AND owner_identifier.normalized_value =
              owner_authority.value->>'normalizedValue'
          WHERE owner_identifier.workspace_id = v_workspace_id
            AND owner_identifier.status = 'ACTIVE';
          IF jsonb_array_length(owner_existing_bindings) > 64 THEN
            RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
              USING ERRCODE = 'P0001';
          END IF;

          SELECT coalesce(
            array_agg(owner_involved.company_id ORDER BY owner_involved.company_id),
            ARRAY[]::uuid[]
          )
          INTO owner_planner_company_ids
          FROM (
            SELECT DISTINCT owner_blocker_company_id AS company_id
            WHERE owner_blocker_company_id IS NOT NULL
            UNION
            SELECT DISTINCT (owner_binding.value->>'companyId')::uuid
            FROM jsonb_array_elements(
              owner_existing_bindings
            ) AS owner_binding(value)
          ) AS owner_involved;
          IF EXISTS (
            SELECT 1
            FROM public.organization_canonical_mapping AS owner_mapping
            WHERE owner_mapping.workspace_id = v_workspace_id
              AND owner_mapping.status = 'ACTIVE'
              AND owner_mapping.source_company_id =
                ANY(owner_planner_company_ids)
              AND (
                owner_mapping.source_company_id =
                  owner_mapping.canonical_company_id
                OR owner_mapping.revision < 1
                OR owner_mapping.revoked_at IS NOT NULL
                OR owner_mapping.split_decision_id IS NOT NULL
              )
          ) OR EXISTS (
            SELECT 1
            FROM public.organization_canonical_mapping AS owner_first_mapping
            JOIN public.organization_canonical_mapping AS owner_next_mapping
              ON owner_next_mapping.workspace_id = v_workspace_id
              AND owner_next_mapping.status = 'ACTIVE'
              AND owner_next_mapping.source_company_id =
                owner_first_mapping.canonical_company_id
            WHERE owner_first_mapping.workspace_id = v_workspace_id
              AND owner_first_mapping.status = 'ACTIVE'
              AND owner_first_mapping.source_company_id =
                ANY(owner_planner_company_ids)
          ) THEN
            RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
              USING ERRCODE = 'P0001';
          END IF;
          SELECT coalesce(jsonb_agg(
            jsonb_build_object(
              'sourceCompanyId', owner_mapping.source_company_id::text,
              'rootCompanyId', owner_mapping.canonical_company_id::text
            ) ORDER BY owner_mapping.source_company_id
          ), '[]'::jsonb)
          INTO owner_root_mappings
          FROM public.organization_canonical_mapping AS owner_mapping
          WHERE owner_mapping.workspace_id = v_workspace_id
            AND owner_mapping.status = 'ACTIVE'
            AND owner_mapping.source_company_id =
              ANY(owner_planner_company_ids);
          SELECT coalesce(
            array_agg(owner_involved.company_id ORDER BY owner_involved.company_id),
            ARRAY[]::uuid[]
          )
          INTO owner_involved_company_ids
          FROM (
            SELECT DISTINCT owner_id AS company_id
            FROM unnest(owner_planner_company_ids) AS owner_source(owner_id)
            UNION
            SELECT DISTINCT (owner_mapping.value->>'rootCompanyId')::uuid
            FROM jsonb_array_elements(
              owner_root_mappings
            ) AS owner_mapping(value)
          ) AS owner_involved;
          IF cardinality(owner_involved_company_ids) > 64
            OR EXISTS (
              SELECT 1
              FROM unnest(
                owner_involved_company_ids
              ) AS owner_involved(owner_id)
              WHERE NOT owner_involved.owner_id = ANY(locked_company_ids)
            )
          THEN
            RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
              USING ERRCODE = 'P0001';
          END IF;

          BEGIN
            owner_resolution_plan :=
              public.organization_identity_plan_from_snapshot_v1(
                jsonb_build_object(
                  'raw', jsonb_build_object(
                    'rawRecordId', stored_owner_raw.id::text,
                    'providerKey', stored_owner_raw.provider_key,
                    'payloadHash', stored_owner_raw.payload_hash,
                    'ingestVersion', stored_owner_raw.ingest_version
                  ),
                  'resolverVersion', 'organization-identity-resolver/v1',
                  'blocker', jsonb_build_object(
                    'blockerKey', owner_blocker->>'blockerKey',
                    'matchRule', owner_blocker->>'matchRule',
                    'legacyCandidateCompanyId', owner_blocker_company_id
                  ),
                  'authorityIdentifiers', owner_authority_identifiers,
                  'existingBindings', owner_existing_bindings,
                  'rootMappings', owner_root_mappings
                )
              );
          EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
              USING ERRCODE = 'P0001';
          END;
        END IF;

        owner_input_hash := owner_resolution_plan->>'inputHash';
        IF owner_resolution_plan->>'kind' IS DISTINCT FROM 'conflict'
          OR owner_resolution_plan->>'matchRule' IS DISTINCT FROM
            'identity_conflict'
          OR owner_resolution_plan->>'conflictType' IS DISTINCT FROM
            plan_conflict_type
          OR owner_resolution_plan->>'conflictFingerprint' IS DISTINCT FROM
            plan_conflict_fingerprint
          OR owner_resolution_plan->'companyIds' IS DISTINCT FROM
            to_jsonb(conflict_company_ids)
          OR owner_resolution_plan->'identifierKeys' IS DISTINCT FROM
            to_jsonb(expected_identifier_keys)
          OR owner_input_hash !~ '^[0-9a-f]{64}$'
        THEN
          RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
            USING ERRCODE = 'P0001';
        END IF;

        PERFORM 1
        FROM public.identity_link AS owner_link
        WHERE owner_link.workspace_id = v_workspace_id
          AND owner_link.raw_record_id = stored_conflict.raw_record_id
        ORDER BY owner_link.id
        FOR UPDATE;
        SELECT count(*)::integer
        INTO owner_link_total
        FROM public.identity_link AS owner_link
        WHERE owner_link.workspace_id = v_workspace_id
          AND owner_link.raw_record_id = stored_conflict.raw_record_id;
        SELECT coalesce(
          array_agg(owner_link.canonical_id ORDER BY owner_link.canonical_id),
          ARRAY[]::uuid[]
        )
        INTO owner_link_company_ids
        FROM public.identity_link AS owner_link
        WHERE owner_link.workspace_id = v_workspace_id
          AND owner_link.raw_record_id = stored_conflict.raw_record_id
          AND owner_link.canonical_type = 'company'
          AND owner_link.match_rule = 'identity_conflict'
          AND owner_link.confidence = 0
          AND owner_link.status = 'PENDING_CONFLICT'
          AND owner_link.resolver_version =
            'organization-identity-resolver/v1'
          AND owner_link.input_hash = owner_input_hash
          AND owner_link.conflict_id = stored_conflict.id;
        IF owner_link_total IS DISTINCT FROM cardinality(conflict_company_ids)
          OR owner_link_company_ids IS DISTINCT FROM conflict_company_ids
        THEN
          RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
            USING ERRCODE = 'P0001';
        END IF;
      END IF;

      IF link_total > 0 THEN
        SELECT
          coalesce(
            array_agg(l.canonical_id ORDER BY l.canonical_id),
            ARRAY[]::uuid[]
          )
        INTO actual_link_company_ids
        FROM public.identity_link AS l
        WHERE l.workspace_id = v_workspace_id
          AND l.raw_record_id = v_raw_record_id
          AND l.canonical_type = 'company'
          AND l.match_rule = 'identity_conflict'
          AND l.confidence = 0
          AND l.status = 'PENDING_CONFLICT'
          AND l.resolver_version = 'organization-identity-resolver/v1'
          AND l.input_hash = plan_input_hash
          AND l.conflict_id = stored_conflict.id;
        IF link_total IS DISTINCT FROM cardinality(conflict_company_ids)
          OR actual_link_company_ids IS DISTINCT FROM conflict_company_ids
        THEN
          RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
            USING ERRCODE = 'P0001';
        END IF;
        RETURN QUERY SELECT
          'conflict'::text,
          v_raw_record_id,
          NULL::uuid,
          stored_conflict.id,
          'identity_conflict'::text,
          plan_input_hash,
          plan_conflict_fingerprint,
          true,
          false,
          0,
          party_total;
        RETURN;
      END IF;

      FOREACH conflict_company_id IN ARRAY conflict_company_ids LOOP
        INSERT INTO public.identity_link(
          id,
          workspace_id,
          canonical_type,
          canonical_id,
          raw_record_id,
          match_rule,
          confidence,
          status,
          resolver_version,
          input_hash,
          conflict_id
        ) VALUES (
          gen_random_uuid(),
          v_workspace_id,
          'company',
          conflict_company_id,
          v_raw_record_id,
          'identity_conflict',
          0,
          'PENDING_CONFLICT',
          'organization-identity-resolver/v1',
          plan_input_hash,
          stored_conflict.id
        );
      END LOOP;
      RETURN QUERY SELECT
        'conflict'::text,
        v_raw_record_id,
        NULL::uuid,
        stored_conflict.id,
        'identity_conflict'::text,
        plan_input_hash,
        plan_conflict_fingerprint,
        false,
        false,
        0,
        party_total;
      RETURN;
    END IF;

    IF link_total <> 0
      OR plan_match_rule NOT IN ('identity_v2', 'domain_exact', 'name_country')
      OR jsonb_typeof(resolution_plan->'identifiers') IS DISTINCT FROM 'array'
      OR resolution_plan->'identifiers' IS DISTINCT FROM authority_identifiers
    THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
        USING ERRCODE = 'P0001';
    END IF;
    IF plan_kind = 'create_new' THEN
      INSERT INTO public.canonical_company(
        id,
        workspace_id,
        name,
        domain,
        country,
        region,
        industry,
        employee_count,
        revenue_usd,
        attributes,
        status,
        dedupe_key,
        version,
        created_at,
        updated_at
      ) VALUES (
        gen_random_uuid(),
        v_workspace_id,
        raw_name,
        raw_domain,
        raw_country,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        'NEW',
        blocker->>'blockerKey',
        1,
        statement_timestamp(),
        statement_timestamp()
      )
      RETURNING id INTO target_company_id;
    ELSIF plan_kind IN ('bind_existing', 'lazy_upgrade') THEN
      target_company_id := (resolution_plan->>'companyId')::uuid;
      IF NOT target_company_id = ANY(locked_company_ids) THEN
        RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
          USING ERRCODE = 'P0001';
      END IF;
    ELSE
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
        USING ERRCODE = 'P0001';
    END IF;

    identifier_total := 0;
    FOR identifier_fact IN
      SELECT value
      FROM jsonb_array_elements(authority_identifiers) AS item(value)
      ORDER BY value->>'key' COLLATE "C"
    LOOP
      identifier_total := identifier_total + 1;
      SELECT oi.*
      INTO stored_identifier
      FROM public.organization_identifier AS oi
      WHERE oi.workspace_id = v_workspace_id
        AND oi.scheme = identifier_fact->>'scheme'
        AND oi.jurisdiction = identifier_fact->>'jurisdiction'
        AND oi.normalized_value = identifier_fact->>'normalizedValue'
        AND oi.status = 'ACTIVE'
      FOR UPDATE;
      IF FOUND THEN
        SELECT coalesce(
          (
            SELECT (mapping.value->>'rootCompanyId')::uuid
            FROM jsonb_array_elements(root_mappings) AS mapping(value)
            WHERE (mapping.value->>'sourceCompanyId')::uuid =
              stored_identifier.company_id
          ),
          stored_identifier.company_id
        )
        INTO existing_identifier_root;
        IF existing_identifier_root IS DISTINCT FROM target_company_id THEN
          RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
            USING ERRCODE = 'P0001';
        END IF;
        UPDATE public.organization_identifier AS oi
        SET last_seen_at = greatest(oi.last_seen_at, statement_timestamp())
        WHERE oi.workspace_id = v_workspace_id
          AND oi.id = stored_identifier.id;
      ELSE
        INSERT INTO public.organization_identifier(
          workspace_id,
          company_id,
          scheme,
          jurisdiction,
          normalized_value,
          authority_provider_key,
          raw_record_id,
          conflict_id,
          confidence,
          normalizer_version,
          validator_version,
          provenance,
          status,
          first_seen_at,
          last_seen_at,
          created_at,
          revoked_at
        ) VALUES (
          v_workspace_id,
          target_company_id,
          identifier_fact->>'scheme',
          identifier_fact->>'jurisdiction',
          identifier_fact->>'normalizedValue',
          identifier_fact->>'providerKey',
          v_raw_record_id,
          NULL,
          1,
          identifier_fact->>'normalizerVersion',
          identifier_fact->>'validatorVersion',
          jsonb_build_object(
            'schemaVersion', 'organization-identifier-provenance/v1',
            'rawRecordId', v_raw_record_id,
            'providerKey', stored_raw.provider_key
          ),
          'ACTIVE',
          statement_timestamp(),
          statement_timestamp(),
          statement_timestamp(),
          NULL
        );
      END IF;
    END LOOP;

    INSERT INTO public.identity_link(
      id,
      workspace_id,
      canonical_type,
      canonical_id,
      raw_record_id,
      match_rule,
      confidence,
      status,
      resolver_version,
      input_hash,
      conflict_id
    ) VALUES (
      gen_random_uuid(),
      v_workspace_id,
      'company',
      target_company_id,
      v_raw_record_id,
      plan_match_rule,
      CASE WHEN plan_match_rule = 'name_country' THEN 0.8 ELSE 1 END,
      'ACTIVE',
      'organization-identity-resolver/v1',
      plan_input_hash,
      NULL
    );
    RETURN QUERY SELECT
      CASE WHEN plan_kind = 'create_new' THEN 'created' ELSE 'bound' END,
      v_raw_record_id,
      target_company_id,
      NULL::uuid,
      plan_match_rule,
      plan_input_hash,
      NULL::text,
      false,
      plan_kind = 'create_new',
      identifier_total,
      0;
    RETURN;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_LOCK_TIMEOUT'
      USING ERRCODE = '55P03';
  WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS
      error_state = RETURNED_SQLSTATE,
      error_message = MESSAGE_TEXT;
    IF error_state = '40001'
      AND error_message = 'IDENTITY_RESOLUTION_PLAN_STALE'
    THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_PLAN_STALE'
        USING ERRCODE = '40001';
    ELSIF error_state = '42501'
      AND error_message = 'IDENTITY_RESOLUTION_COMMAND_DENIED'
      AND command_admission_open
    THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_COMMAND_DENIED'
        USING ERRCODE = '42501';
    ELSIF error_state = 'P0001'
      AND error_message IN (
        'IDENTITY_RAW_NOT_RESOLVABLE',
        'IDENTITY_RAW_PROCESSING_RESTRICTED',
        'IDENTITY_INPUT_DRIFT',
        'IDENTITY_RESOLUTION_STATE_INVALID'
      )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = error_message;
    END IF;
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
      USING ERRCODE = 'P0001';
  END;
END
$organization_identity_worker$;

REVOKE ALL ON FUNCTION
  public.organization_identity_resolve_for_raw_worker_v1(text, text)
FROM PUBLIC, app_user;
REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION
  public.organization_identity_resolve_for_raw_worker_v1(text, text)
FROM global;

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
SET row_security = off
AS $organization_identity_command$
DECLARE
  v_workspace_id uuid;
  v_raw_record_id uuid;
  workspace_setting text;
  caller_lock_timeout text;
  caller_statement_timeout text;
  lock_timeout_seconds numeric;
  statement_timeout_seconds numeric;
  statement_deadline timestamptz;
  worker_invoked boolean := false;
  error_state text;
  error_message text;
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
  caller_lock_timeout := current_setting('lock_timeout', true);
  caller_statement_timeout := current_setting('statement_timeout', true);
  BEGIN
    IF caller_lock_timeout IS NULL
      OR caller_statement_timeout IS NULL
      OR octet_length(caller_lock_timeout) NOT BETWEEN 1 AND 64
      OR octet_length(caller_statement_timeout) NOT BETWEEN 1 AND 64
    THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_COMMAND_DENIED'
        USING ERRCODE = '42501';
    END IF;
    lock_timeout_seconds := extract(
      epoch FROM caller_lock_timeout::interval
    );
    statement_timeout_seconds := extract(
      epoch FROM caller_statement_timeout::interval
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_COMMAND_DENIED'
      USING ERRCODE = '42501';
  END;
  IF lock_timeout_seconds NOT BETWEEN 0.001 AND 5
    OR statement_timeout_seconds NOT BETWEEN 0.001 AND 60
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_COMMAND_DENIED'
      USING ERRCODE = '42501';
  END IF;
  statement_deadline :=
    statement_timestamp() + caller_statement_timeout::interval;
  worker_invoked := true;
  RETURN QUERY EXECUTE $organization_identity_worker_call$
    SELECT *
    FROM public.organization_identity_resolve_for_raw_worker_v1($1, $2)
  $organization_identity_worker_call$
  USING v_workspace_id::text, v_raw_record_id::text;
  RETURN;
EXCEPTION WHEN query_canceled THEN
  IF statement_deadline IS NOT NULL
    AND clock_timestamp() >= statement_deadline - interval '10 milliseconds'
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATEMENT_TIMEOUT'
      USING ERRCODE = '57014';
  END IF;
  RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
    USING ERRCODE = 'P0001';
WHEN assert_failure THEN
  RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
    USING ERRCODE = 'P0001';
WHEN lock_not_available THEN
  RAISE EXCEPTION 'IDENTITY_RESOLUTION_LOCK_TIMEOUT'
    USING ERRCODE = '55P03';
WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS
    error_state = RETURNED_SQLSTATE,
    error_message = MESSAGE_TEXT;
  IF NOT worker_invoked
    AND error_state = '42501'
    AND error_message = 'IDENTITY_RESOLUTION_COMMAND_DENIED'
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_COMMAND_DENIED'
      USING ERRCODE = '42501';
  ELSIF NOT worker_invoked
    AND error_state = 'P0001'
    AND error_message = 'IDENTITY_RESOLUTION_INPUT_INVALID'
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
      USING ERRCODE = 'P0001';
  ELSIF worker_invoked
    AND error_state = '40001'
    AND error_message = 'IDENTITY_RESOLUTION_PLAN_STALE'
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_PLAN_STALE'
      USING ERRCODE = '40001';
  ELSIF worker_invoked
    AND error_state = '42501'
    AND error_message = 'IDENTITY_RESOLUTION_COMMAND_DENIED'
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_COMMAND_DENIED'
      USING ERRCODE = '42501';
  ELSIF worker_invoked
    AND error_state = 'P0001'
    AND error_message IN (
      'IDENTITY_RAW_NOT_RESOLVABLE',
      'IDENTITY_RAW_PROCESSING_RESTRICTED',
      'IDENTITY_INPUT_DRIFT',
      'IDENTITY_RESOLUTION_STATE_INVALID'
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = error_message;
  END IF;
  RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
    USING ERRCODE = 'P0001';
END
$organization_identity_command$;

REVOKE ALL ON FUNCTION
  public.resolve_organization_identity_for_raw_v1(text, text)
FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION
  public.resolve_organization_identity_for_raw_v1(text, text)
FROM app_user;
REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION
  public.resolve_organization_identity_for_raw_v1(text, text)
FROM global;
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
      WITH RECURSIVE capability_paths(start_role, reached_role, mode) AS (
        SELECT membership.member, membership.roleid, capability.mode
        FROM pg_auth_members AS membership
        CROSS JOIN LATERAL (VALUES
          ('inherit'::text, membership.inherit_option),
          ('set_role'::text, membership.set_option)
        ) AS capability(mode, enabled)
        WHERE capability.enabled
        UNION
        SELECT path.start_role, next_membership.roleid, path.mode
        FROM capability_paths AS path
        JOIN pg_auth_members AS next_membership
          ON next_membership.member = path.reached_role
        WHERE (
          path.mode = 'inherit' AND next_membership.inherit_option
        ) OR (
          path.mode = 'set_role' AND next_membership.set_option
        )
      )
      SELECT 1 FROM capability_paths
      WHERE reached_role = 'global'::regrole
        AND start_role <> 'global'::regrole
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
          'organization_identity_resolve_for_raw_worker_v1',
          'resolve_organization_identity_for_raw_v1'
        )
    ) IS DISTINCT FROM 7
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
        'organization_identity_resolve_for_raw_worker_v1',
        'text, text',
        'TABLE(outcome_kind text, raw_record_id uuid, company_id uuid, conflict_id uuid, match_rule text, input_hash text, conflict_fingerprint text, replayed boolean, company_created boolean, identifier_count integer, party_count integer)',
        false, 'v'::"char",
        true,
        ARRAY[
          'search_path=pg_catalog, public',
          'row_security=off'
        ]::text[],
        false
      ),
      (
        'resolve_organization_identity_for_raw_v1',
        'text, text',
        'TABLE(outcome_kind text, raw_record_id uuid, company_id uuid, conflict_id uuid, match_rule text, input_hash text, conflict_fingerprint text, replayed boolean, company_created boolean, identifier_count integer, party_count integer)',
        true, 'v'::"char",
        true,
        ARRAY[
          'search_path=pg_catalog, public',
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
