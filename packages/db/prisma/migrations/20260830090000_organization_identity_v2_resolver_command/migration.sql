BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

CREATE OR REPLACE FUNCTION public.apply_organization_identity_resolution_v1(p_command jsonb)
RETURNS TABLE (
  outcome_kind text,
  raw_record_id uuid,
  company_id uuid,
  conflict_id uuid,
  match_rule text,
  input_hash text,
  conflict_fingerprint text,
  replayed boolean,
  identifier_count integer,
  party_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $function$
DECLARE
  command_keys text;
  command_workspace_id uuid;
  command_raw jsonb;
  command_blocker jsonb;
  command_authority jsonb;
  command_bindings jsonb;
  command_roots jsonb;
  command_plan jsonb;
  command_target_company_id uuid;
  binding_company_id uuid;
  party_company_id uuid;
  command_raw_record_id uuid;
  command_provider_key text;
  command_payload_hash text;
  command_ingest_version text;
  command_blocker_key text;
  command_blocker_rule text;
  command_legacy_company_id uuid;
  plan_kind text;
  plan_match_rule text;
  plan_input_hash text;
  plan_conflict_fingerprint text;
  plan_conflict_type text;
  derived_input_hash text;
  derived_conflict_fingerprint text;
  stored_raw record;
  stored_link record;
  stored_conflict record;
  identifier jsonb;
  binding jsonb;
  mapping jsonb;
  company_value jsonb;
  identifier_key text;
  identifier_scheme text;
  identifier_jurisdiction text;
  identifier_value text;
  identifier_provider text;
  expected_key text;
  expected_value text;
  expected_jurisdiction text;
  expected_validator text;
  payload_identifier jsonb;
  payload_scheme text;
  payload_value text;
  payload_country text;
  normalized_payload_value text;
  identifier_total integer;
  party_total integer;
  link_total integer;
  conflict_company_ids uuid[];
  expected_company_ids uuid[];
  bound_company_ids uuid[];
  legacy_root_company_id uuid;
  conflict_identifier_keys text[];
  expected_identifier_keys text[];
  existing_link_hashes text[];
  existing_link_versions text[];
  existing_link_statuses text[];
  existing_conflict_ids uuid[];
  inserted_count integer;
  lei_expanded text;
  lei_remainder integer;
  lei_character text;
  lei_digit text;
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
    OR current_user IS NOT DISTINCT FROM session_user
    OR current_setting('role', true) IS DISTINCT FROM 'none'
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_COMMAND_DENIED'
      USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_command) IS DISTINCT FROM 'object'
    OR octet_length(p_command::text) > 65536
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
      USING ERRCODE = '22023';
  END IF;

  SELECT string_agg(key, ',' ORDER BY key COLLATE "C")
  INTO command_keys
  FROM jsonb_object_keys(p_command) AS key;
  IF command_keys IS DISTINCT FROM
    'authorityIdentifiers,blocker,existingBindings,plan,raw,rootMappings,schemaVersion,targetCompanyId,workspaceId'
    OR p_command->>'schemaVersion' IS DISTINCT FROM
      'organization-identity-resolution-command/v1'
    OR jsonb_typeof(p_command->'raw') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_command->'blocker') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_command->'authorityIdentifiers') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_command->'existingBindings') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_command->'rootMappings') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_command->'plan') IS DISTINCT FROM 'object'
    OR jsonb_array_length(p_command->'authorityIdentifiers') > 32
    OR jsonb_array_length(p_command->'existingBindings') > 64
    OR jsonb_array_length(p_command->'rootMappings') > 64
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
      USING ERRCODE = '22023';
  END IF;

  command_raw := p_command->'raw';
  command_blocker := p_command->'blocker';
  command_authority := p_command->'authorityIdentifiers';
  command_bindings := p_command->'existingBindings';
  command_roots := p_command->'rootMappings';
  command_plan := p_command->'plan';

  SELECT string_agg(key, ',' ORDER BY key COLLATE "C")
  INTO command_keys FROM jsonb_object_keys(command_raw) AS key;
  IF command_keys IS DISTINCT FROM
    'ingestVersion,payloadHash,providerKey,rawRecordId'
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
      USING ERRCODE = '22023';
  END IF;
  SELECT string_agg(key, ',' ORDER BY key COLLATE "C")
  INTO command_keys FROM jsonb_object_keys(command_blocker) AS key;
  IF command_keys IS DISTINCT FROM
    'blockerKey,legacyCandidateCompanyId,matchRule'
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    command_workspace_id := (p_command->>'workspaceId')::uuid;
    command_raw_record_id := (command_raw->>'rawRecordId')::uuid;
    command_target_company_id := NULLIF(p_command->>'targetCompanyId', '')::uuid;
    command_legacy_company_id :=
      NULLIF(command_blocker->>'legacyCandidateCompanyId', '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
      USING ERRCODE = '22023';
  END;
  command_provider_key := command_raw->>'providerKey';
  command_payload_hash := command_raw->>'payloadHash';
  command_ingest_version := command_raw->>'ingestVersion';
  command_blocker_key := command_blocker->>'blockerKey';
  command_blocker_rule := command_blocker->>'matchRule';
  plan_kind := command_plan->>'kind';
  plan_match_rule := command_plan->>'matchRule';
  plan_input_hash := command_plan->>'inputHash';
  plan_conflict_fingerprint := command_plan->>'conflictFingerprint';
  plan_conflict_type := command_plan->>'conflictType';

  IF command_workspace_id IS DISTINCT FROM public.current_workspace_id() THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_COMMAND_DENIED'
      USING ERRCODE = '42501';
  END IF;
  IF command_provider_key !~ '^[a-z][a-z0-9_]{0,127}$'
    OR command_payload_hash !~ '^[0-9a-f]{64}$'
    OR command_ingest_version IS DISTINCT FROM 'raw-source/v2'
    OR char_length(command_blocker_key) NOT BETWEEN 1 AND 512
    OR command_blocker_rule NOT IN ('domain_exact', 'name_country')
    OR plan_kind NOT IN ('bind_existing', 'lazy_upgrade', 'create_new', 'conflict')
    OR plan_input_hash !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'acquisition-suppression-policy:' || command_workspace_id::text,
      0
    )
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'organization-identity:' || command_workspace_id::text,
      0
    )
  );

  SELECT
    r.id,
    r.workspace_id,
    r.provider_key,
    r.payload,
    r.payload_hash,
    r.ingest_version,
    r.ingest_status,
    r.expires_at
  INTO stored_raw
  FROM public.raw_source_record AS r
  WHERE r.workspace_id = command_workspace_id
    AND r.id = command_raw_record_id
  FOR KEY SHARE;
  IF NOT FOUND
    OR stored_raw.provider_key IS DISTINCT FROM command_provider_key
    OR stored_raw.payload_hash IS DISTINCT FROM command_payload_hash
    OR stored_raw.ingest_version IS DISTINCT FROM command_ingest_version
    OR stored_raw.ingest_status IS DISTINCT FROM 'ACCEPTED'
    OR (stored_raw.expires_at IS NOT NULL AND
      stored_raw.expires_at <= statement_timestamp())
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_PLAN_STALE'
      USING ERRCODE = '40001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.raw_source_governance_disposition AS d
    WHERE d.workspace_id = command_workspace_id
      AND d.raw_record_id = command_raw_record_id
      AND d.effect = 'RESTRICT_PROCESSING'
  ) THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_SUPPRESSED'
      USING ERRCODE = 'P0001';
  END IF;

  derived_input_hash := encode(
    public.digest(
      public.raw_source_canonical_json_v1(
        jsonb_build_object(
          'raw', command_raw,
          'resolverVersion', 'organization-identity-resolver/v1',
          'blocker', command_blocker,
          'authorityIdentifiers', command_authority,
          'bindings', command_bindings,
          'rootMappings', command_roots
        )
      ),
      'sha256'
    ),
    'hex'
  );
  IF derived_input_hash IS DISTINCT FROM plan_input_hash THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
      USING ERRCODE = '22023';
  END IF;

  SELECT
    array_agg(DISTINCT l.input_hash ORDER BY l.input_hash),
    array_agg(DISTINCT l.resolver_version ORDER BY l.resolver_version),
    array_agg(DISTINCT l.status::text ORDER BY l.status::text),
    array_agg(DISTINCT l.conflict_id ORDER BY l.conflict_id)
      FILTER (WHERE l.conflict_id IS NOT NULL),
    count(*)
  INTO
    existing_link_hashes,
    existing_link_versions,
    existing_link_statuses,
    existing_conflict_ids,
    link_total
  FROM public.identity_link AS l
  WHERE l.workspace_id = command_workspace_id
    AND l.raw_record_id = command_raw_record_id;
  IF link_total > 0 THEN
    IF 'identity-v1' = ANY(existing_link_versions)
      OR 'legacy' = ANY(existing_link_hashes)
    THEN
      RAISE EXCEPTION 'IDENTITY_LEGACY_LINK_ALREADY_RESOLVED'
        USING ERRCODE = 'P0001';
    END IF;
    IF array_length(existing_link_hashes, 1) IS DISTINCT FROM 1
      OR existing_link_hashes[1] IS DISTINCT FROM plan_input_hash
    THEN
      RAISE EXCEPTION 'IDENTITY_INPUT_DRIFT'
        USING ERRCODE = 'P0001';
    END IF;
    IF existing_link_statuses = ARRAY['ACTIVE'] THEN
      SELECT l.* INTO stored_link
      FROM public.identity_link AS l
      WHERE l.workspace_id = command_workspace_id
        AND l.raw_record_id = command_raw_record_id
      ORDER BY l.id
      LIMIT 1;
      RETURN QUERY SELECT
        'bound'::text,
        command_raw_record_id,
        stored_link.canonical_id,
        NULL::uuid,
        stored_link.match_rule,
        plan_input_hash,
        NULL::text,
        true,
        jsonb_array_length(command_authority),
        0;
      RETURN;
    END IF;
    IF existing_link_statuses = ARRAY['PENDING_CONFLICT']
      AND array_length(existing_conflict_ids, 1) = 1
    THEN
      SELECT c.* INTO stored_conflict
      FROM public.organization_identity_conflict AS c
      WHERE c.workspace_id = command_workspace_id
        AND c.id = existing_conflict_ids[1];
      RETURN QUERY SELECT
        'conflict'::text,
        command_raw_record_id,
        NULL::uuid,
        stored_conflict.id,
        'identity_conflict'::text,
        plan_input_hash,
        stored_conflict.fingerprint,
        true,
        0,
        (SELECT count(*)::integer
         FROM public.organization_identity_conflict_party AS p
         WHERE p.workspace_id = command_workspace_id
           AND p.conflict_id = stored_conflict.id);
      RETURN;
    END IF;
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  payload_identifier := stored_raw.payload->'identifier';
  payload_scheme := payload_identifier->>'scheme';
  payload_value := payload_identifier->>'value';
  payload_country := stored_raw.payload->>'country';
  identifier_total := 0;
  FOR identifier IN SELECT value FROM jsonb_array_elements(command_authority)
  LOOP
    SELECT string_agg(key, ',' ORDER BY key COLLATE "C")
    INTO command_keys FROM jsonb_object_keys(identifier) AS key;
    IF command_keys IS DISTINCT FROM
      'jurisdiction,key,normalizedValue,normalizerVersion,providerKey,scheme,validatorVersion'
      OR identifier->>'providerKey' IS DISTINCT FROM command_provider_key
      OR identifier->>'normalizerVersion' IS DISTINCT FROM
        'organization-identity-authority/v1'
    THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
        USING ERRCODE = '22023';
    END IF;
    identifier_scheme := identifier->>'scheme';
    identifier_jurisdiction := identifier->>'jurisdiction';
    identifier_value := identifier->>'normalizedValue';
    identifier_provider := identifier->>'providerKey';
    identifier_key := identifier->>'key';
    expected_key :=
      identifier_scheme || ':' || identifier_jurisdiction || ':' || identifier_value;
    IF identifier_key IS DISTINCT FROM expected_key THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
        USING ERRCODE = '22023';
    END IF;
    IF identifier_scheme = 'domain' THEN
      expected_value := lower(regexp_replace(stored_raw.payload->>'domain', '^www\.', ''));
      expected_jurisdiction := 'GLOBAL';
      expected_validator := 'domain-v1';
    ELSIF command_provider_key = 'registry' AND identifier_scheme = 'registry-id'
    THEN
      normalized_payload_value := upper(regexp_replace(payload_value, '[^[:alnum:]]+', '', 'g'));
      expected_value := normalized_payload_value;
      expected_jurisdiction :=
        CASE WHEN payload_country ~ '^[A-Z]{2}$' THEN payload_country ELSE 'GLOBAL' END;
      expected_validator := 'registry-id-v1';
    ELSIF command_provider_key = 'registry' AND identifier_scheme = 'lei'
    THEN
      normalized_payload_value := upper(regexp_replace(payload_value, '[^[:alnum:]]+', '', 'g'));
      IF normalized_payload_value !~ '^[A-Z0-9]{20}$' THEN
        RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
          USING ERRCODE = '22023';
      END IF;
      lei_expanded := '';
      FOREACH lei_character IN ARRAY regexp_split_to_array(normalized_payload_value, '')
      LOOP
        lei_expanded := lei_expanded ||
          CASE WHEN lei_character ~ '^[A-Z]$'
            THEN (ascii(lei_character) - 55)::text ELSE lei_character END;
      END LOOP;
      lei_remainder := 0;
      FOREACH lei_digit IN ARRAY regexp_split_to_array(lei_expanded, '')
      LOOP
        lei_remainder := (lei_remainder * 10 + lei_digit::integer) % 97;
      END LOOP;
      IF lei_remainder <> 1 THEN
        RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
          USING ERRCODE = '22023';
      END IF;
      expected_value := normalized_payload_value;
      expected_jurisdiction := 'GLOBAL';
      expected_validator := 'lei-v1';
    ELSIF command_provider_key = 'ted' AND identifier_scheme = 'ted-natid'
    THEN
      expected_value := upper(regexp_replace(payload_value, '[^[:alnum:]]+', '', 'g'));
      expected_jurisdiction :=
        CASE WHEN payload_country ~ '^[A-Z]{2}$' THEN payload_country ELSE 'GLOBAL' END;
      expected_validator := 'ted-natid-v1';
    ELSIF command_provider_key = 'openfda' AND identifier_scheme = 'fda-reg'
    THEN
      expected_value := payload_value;
      expected_jurisdiction := 'US';
      expected_validator := 'fda-reg-v1';
    ELSE
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
        USING ERRCODE = '22023';
    END IF;
    IF identifier_value IS DISTINCT FROM expected_value
      OR identifier_jurisdiction IS DISTINCT FROM expected_jurisdiction
      OR identifier->>'validatorVersion' IS DISTINCT FROM expected_validator
    THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
        USING ERRCODE = '22023';
    END IF;
    identifier_total := identifier_total + 1;
  END LOOP;
  IF identifier_total IS DISTINCT FROM
      (CASE WHEN stored_raw.payload ? 'domain' THEN 1 ELSE 0 END) +
      (CASE WHEN jsonb_typeof(payload_identifier) = 'object'
        AND command_provider_key IN ('registry', 'ted', 'openfda')
        THEN 1 ELSE 0 END)
    OR identifier_total IS DISTINCT FROM (
      SELECT count(DISTINCT item->>'key')::integer
      FROM jsonb_array_elements(command_authority) AS item
    )
    OR command_authority IS DISTINCT FROM coalesce((
      SELECT jsonb_agg(item.value ORDER BY item.value->>'key' COLLATE "C")
      FROM jsonb_array_elements(command_authority) AS item(value)
    ), '[]'::jsonb)
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
      USING ERRCODE = '22023';
  END IF;

  FOR binding IN SELECT value FROM jsonb_array_elements(command_bindings)
  LOOP
    SELECT string_agg(key, ',' ORDER BY key COLLATE "C")
    INTO command_keys FROM jsonb_object_keys(binding) AS key;
    BEGIN
      binding_company_id := (binding->>'companyId')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
        USING ERRCODE = '22023';
    END;
    IF command_keys IS DISTINCT FROM 'companyId,identifierKey'
      OR NOT EXISTS (
        SELECT 1
        FROM public.organization_identifier AS oi
        WHERE oi.workspace_id = command_workspace_id
          AND oi.status = 'ACTIVE'
          AND oi.company_id = binding_company_id
          AND oi.scheme || ':' || oi.jurisdiction || ':' || oi.normalized_value =
            binding->>'identifierKey'
      )
    THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_PLAN_STALE'
        USING ERRCODE = '40001';
    END IF;
  END LOOP;

  IF jsonb_array_length(command_bindings) IS DISTINCT FROM (
      SELECT count(*)::integer
      FROM (
        SELECT DISTINCT item->>'identifierKey', item->>'companyId'
        FROM jsonb_array_elements(command_bindings) AS item
      ) AS distinct_binding
    ) OR EXISTS (
      SELECT 1
      FROM (
        SELECT
          oi.scheme || ':' || oi.jurisdiction || ':' || oi.normalized_value
            AS identifier_key,
          oi.company_id::text AS company_id
        FROM public.organization_identifier AS oi
        JOIN jsonb_array_elements(command_authority) AS authority
          ON authority->>'key' =
            oi.scheme || ':' || oi.jurisdiction || ':' || oi.normalized_value
        WHERE oi.workspace_id = command_workspace_id
          AND oi.status = 'ACTIVE'
        EXCEPT
        SELECT item->>'identifierKey', item->>'companyId'
        FROM jsonb_array_elements(command_bindings) AS item
      ) AS missing_binding
    ) OR EXISTS (
      SELECT 1
      FROM (
        SELECT item->>'identifierKey', item->>'companyId'
        FROM jsonb_array_elements(command_bindings) AS item
        EXCEPT
        SELECT
          oi.scheme || ':' || oi.jurisdiction || ':' || oi.normalized_value,
          oi.company_id::text
        FROM public.organization_identifier AS oi
        JOIN jsonb_array_elements(command_authority) AS authority
          ON authority->>'key' =
            oi.scheme || ':' || oi.jurisdiction || ':' || oi.normalized_value
        WHERE oi.workspace_id = command_workspace_id
          AND oi.status = 'ACTIVE'
      ) AS extra_binding
    )
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_PLAN_STALE'
      USING ERRCODE = '40001';
  END IF;

  FOR mapping IN SELECT value FROM jsonb_array_elements(command_roots)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.organization_canonical_mapping AS m
      WHERE m.workspace_id = command_workspace_id
        AND m.status = 'ACTIVE'
        AND m.source_company_id = (mapping->>'sourceCompanyId')::uuid
        AND m.canonical_company_id = (mapping->>'rootCompanyId')::uuid
    ) THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_PLAN_STALE'
        USING ERRCODE = '40001';
    END IF;
  END LOOP;

  IF jsonb_array_length(command_roots) IS DISTINCT FROM (
      SELECT count(*)::integer
      FROM (
        SELECT DISTINCT item->>'sourceCompanyId', item->>'rootCompanyId'
        FROM jsonb_array_elements(command_roots) AS item
      ) AS distinct_mapping
    ) OR EXISTS (
      SELECT 1
      FROM (
        SELECT m.source_company_id::text, m.canonical_company_id::text
        FROM public.organization_canonical_mapping AS m
        JOIN (
          SELECT (item->>'companyId')::uuid AS company_id
          FROM jsonb_array_elements(command_bindings) AS item
          UNION
          SELECT command_legacy_company_id
          WHERE command_legacy_company_id IS NOT NULL
        ) AS source ON source.company_id = m.source_company_id
        WHERE m.workspace_id = command_workspace_id AND m.status = 'ACTIVE'
        EXCEPT
        SELECT item->>'sourceCompanyId', item->>'rootCompanyId'
        FROM jsonb_array_elements(command_roots) AS item
      ) AS missing_mapping
    ) OR EXISTS (
      SELECT 1
      FROM (
        SELECT item->>'sourceCompanyId', item->>'rootCompanyId'
        FROM jsonb_array_elements(command_roots) AS item
        EXCEPT
        SELECT m.source_company_id::text, m.canonical_company_id::text
        FROM public.organization_canonical_mapping AS m
        JOIN (
          SELECT (item->>'companyId')::uuid AS company_id
          FROM jsonb_array_elements(command_bindings) AS item
          UNION
          SELECT command_legacy_company_id
          WHERE command_legacy_company_id IS NOT NULL
        ) AS source ON source.company_id = m.source_company_id
        WHERE m.workspace_id = command_workspace_id AND m.status = 'ACTIVE'
      ) AS extra_mapping
    )
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_PLAN_STALE'
      USING ERRCODE = '40001';
  END IF;

  IF command_legacy_company_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.canonical_company AS c
    WHERE c.workspace_id = command_workspace_id
      AND c.id = command_legacy_company_id
      AND c.dedupe_key = command_blocker_key
  ) THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_PLAN_STALE'
      USING ERRCODE = '40001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.suppression_record AS s
    WHERE s.workspace_id = command_workspace_id
      AND (
        (s.type = 'domain' AND s.value = lower(stored_raw.payload->>'domain'))
        OR (s.type = 'company_name' AND s.value = lower(stored_raw.payload->>'name'))
      )
  ) THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_SUPPRESSED'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT array_agg(
    DISTINCT coalesce(
      m.canonical_company_id,
      (binding_fact.value->>'companyId')::uuid
    )
    ORDER BY coalesce(
      m.canonical_company_id,
      (binding_fact.value->>'companyId')::uuid
    )
  )
  INTO bound_company_ids
  FROM jsonb_array_elements(command_bindings) AS binding_fact(value)
  LEFT JOIN public.organization_canonical_mapping AS m
    ON m.workspace_id = command_workspace_id
    AND m.status = 'ACTIVE'
    AND m.source_company_id = (binding_fact.value->>'companyId')::uuid;
  SELECT coalesce(m.canonical_company_id, command_legacy_company_id)
  INTO legacy_root_company_id
  FROM (SELECT command_legacy_company_id AS company_id) AS legacy
  LEFT JOIN public.organization_canonical_mapping AS m
    ON m.workspace_id = command_workspace_id
    AND m.status = 'ACTIVE'
    AND m.source_company_id = legacy.company_id;

  IF plan_kind = 'conflict' THEN
    SELECT string_agg(key, ',' ORDER BY key COLLATE "C")
    INTO command_keys FROM jsonb_object_keys(command_plan) AS key;
    IF command_keys IS DISTINCT FROM
      'companyIds,conflictFingerprint,conflictType,identifierKeys,inputHash,kind,matchRule'
      OR plan_match_rule IS DISTINCT FROM 'identity_conflict'
      OR plan_conflict_type NOT IN ('identifier_split', 'blocking_key_disagreement')
      OR plan_conflict_fingerprint !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(command_plan->'companyIds') IS DISTINCT FROM 'array'
      OR jsonb_typeof(command_plan->'identifierKeys') IS DISTINCT FROM 'array'
      OR command_target_company_id IS NOT NULL
    THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
        USING ERRCODE = '22023';
    END IF;
    SELECT array_agg(value::uuid ORDER BY value::uuid)
    INTO conflict_company_ids
    FROM jsonb_array_elements_text(command_plan->'companyIds') AS value;
    SELECT array_agg(value ORDER BY value COLLATE "C")
    INTO conflict_identifier_keys
    FROM jsonb_array_elements_text(command_plan->'identifierKeys') AS value;
    SELECT array_agg(item->>'key' ORDER BY item->>'key' COLLATE "C")
    INTO expected_identifier_keys
    FROM jsonb_array_elements(command_authority) AS item;
    IF plan_conflict_type = 'identifier_split' THEN
      IF coalesce(cardinality(bound_company_ids), 0) < 2 THEN
        RAISE EXCEPTION 'IDENTITY_RESOLUTION_PLAN_STALE'
          USING ERRCODE = '40001';
      END IF;
      expected_company_ids := bound_company_ids;
    ELSE
      IF cardinality(bound_company_ids) IS DISTINCT FROM 1
        OR legacy_root_company_id IS NULL
        OR legacy_root_company_id = bound_company_ids[1]
      THEN
        RAISE EXCEPTION 'IDENTITY_RESOLUTION_PLAN_STALE'
          USING ERRCODE = '40001';
      END IF;
      SELECT array_agg(DISTINCT company ORDER BY company)
      INTO expected_company_ids
      FROM unnest(bound_company_ids || legacy_root_company_id) AS company;
    END IF;
    IF conflict_company_ids IS DISTINCT FROM expected_company_ids
      OR conflict_identifier_keys IS DISTINCT FROM expected_identifier_keys
      OR command_plan->'companyIds' IS DISTINCT FROM to_jsonb(conflict_company_ids)
      OR command_plan->'identifierKeys' IS DISTINCT FROM to_jsonb(conflict_identifier_keys)
      OR array_length(conflict_company_ids, 1) < 2
      OR EXISTS (
        SELECT 1
        FROM unnest(conflict_company_ids) AS candidate(candidate_id)
        LEFT JOIN public.canonical_company AS c
          ON c.workspace_id = command_workspace_id
          AND c.id = candidate.candidate_id
        WHERE c.id IS NULL OR c.status = 'SUPPRESSED'
      )
    THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_PLAN_STALE'
        USING ERRCODE = '40001';
    END IF;
    derived_conflict_fingerprint := encode(
      public.digest(
        public.raw_source_canonical_json_v1(
          jsonb_build_object(
            'resolverVersion', 'organization-identity-resolver/v1',
            'blocker', jsonb_build_object(
              'blockerKey', command_blocker_key,
              'matchRule', command_blocker_rule
            ),
            'conflictType', plan_conflict_type,
            'companyIds', to_jsonb(conflict_company_ids),
            'identifierKeys', to_jsonb(conflict_identifier_keys)
          )
        ),
        'sha256'
      ),
      'hex'
    );
    IF derived_conflict_fingerprint IS DISTINCT FROM plan_conflict_fingerprint
    THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
        USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.organization_identity_conflict(
      workspace_id, raw_record_id, conflict_type, fingerprint,
      status, revision, facts
    ) VALUES (
      command_workspace_id,
      command_raw_record_id,
      plan_conflict_type,
      plan_conflict_fingerprint,
      'OPEN',
      1,
      jsonb_build_object(
        'schemaVersion', 'organization-identity-conflict/v1',
        'resolverVersion', 'organization-identity-resolver/v1',
        'blockerKey', command_blocker_key,
        'blockerRule', command_blocker_rule,
        'conflictType', plan_conflict_type,
        'companyIds', to_jsonb(conflict_company_ids),
        'identifierKeys', to_jsonb(conflict_identifier_keys)
      )
    )
    ON CONFLICT (workspace_id, fingerprint) DO NOTHING;
    SELECT c.* INTO stored_conflict
    FROM public.organization_identity_conflict AS c
    WHERE c.workspace_id = command_workspace_id
      AND c.fingerprint = plan_conflict_fingerprint;
    IF stored_conflict.status IS DISTINCT FROM 'OPEN'
      OR stored_conflict.conflict_type IS DISTINCT FROM plan_conflict_type
    THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_STATE_INVALID'
        USING ERRCODE = 'P0001';
    END IF;
    FOREACH party_company_id IN ARRAY conflict_company_ids
    LOOP
      INSERT INTO public.organization_identity_conflict_party(
        workspace_id, conflict_id, company_id, role
      ) VALUES (
        command_workspace_id, stored_conflict.id,
        party_company_id, 'CANDIDATE'
      ) ON CONFLICT DO NOTHING;
      INSERT INTO public.identity_link(
        id, workspace_id, canonical_type, canonical_id, raw_record_id,
        match_rule, confidence, status, resolver_version, input_hash,
        conflict_id
      ) VALUES (
        gen_random_uuid(), command_workspace_id, 'company', party_company_id,
        command_raw_record_id, 'identity_conflict', 0,
        'PENDING_CONFLICT', 'organization-identity-resolver/v1',
        plan_input_hash, stored_conflict.id
      );
    END LOOP;
    SELECT count(*)::integer INTO party_total
    FROM public.organization_identity_conflict_party AS p
    WHERE p.workspace_id = command_workspace_id
      AND p.conflict_id = stored_conflict.id;
    RETURN QUERY SELECT
      'conflict'::text,
      command_raw_record_id,
      NULL::uuid,
      stored_conflict.id,
      'identity_conflict'::text,
      plan_input_hash,
      plan_conflict_fingerprint,
      false,
      0,
      party_total;
    RETURN;
  END IF;

  SELECT string_agg(key, ',' ORDER BY key COLLATE "C")
  INTO command_keys FROM jsonb_object_keys(command_plan) AS key;
  IF (
      plan_kind IN ('bind_existing', 'lazy_upgrade')
      AND command_keys IS DISTINCT FROM
        'companyId,identifiers,inputHash,kind,matchRule'
    ) OR (
      plan_kind = 'create_new'
      AND command_keys IS DISTINCT FROM
        'identifiers,inputHash,kind,matchRule'
    )
    OR plan_match_rule NOT IN ('identity_v2', 'domain_exact', 'name_country')
    OR jsonb_typeof(command_plan->'identifiers') IS DISTINCT FROM 'array'
    OR command_plan->'identifiers' IS DISTINCT FROM command_authority
    OR command_target_company_id IS NULL
    OR (plan_kind IN ('bind_existing', 'lazy_upgrade') AND
      (command_plan->>'companyId')::uuid IS DISTINCT FROM command_target_company_id)
    OR (identifier_total > 0 AND plan_match_rule IS DISTINCT FROM 'identity_v2')
    OR (identifier_total = 0 AND plan_match_rule IS DISTINCT FROM command_blocker_rule)
    OR (plan_kind = 'bind_existing' AND (
      cardinality(bound_company_ids) IS DISTINCT FROM 1
      OR command_target_company_id IS DISTINCT FROM bound_company_ids[1]
      OR (legacy_root_company_id IS NOT NULL AND
        legacy_root_company_id IS DISTINCT FROM command_target_company_id)
    ))
    OR (plan_kind = 'lazy_upgrade' AND (
      coalesce(cardinality(bound_company_ids), 0) <> 0
      OR legacy_root_company_id IS DISTINCT FROM command_target_company_id
    ))
    OR (plan_kind = 'create_new' AND (
      coalesce(cardinality(bound_company_ids), 0) <> 0
      OR legacy_root_company_id IS NOT NULL
    ))
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_INPUT_INVALID'
      USING ERRCODE = '22023';
  END IF;
  SELECT c.id INTO command_target_company_id
  FROM public.canonical_company AS c
  WHERE c.workspace_id = command_workspace_id
    AND c.id = command_target_company_id
    AND c.status <> 'SUPPRESSED'
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_PLAN_STALE'
      USING ERRCODE = '40001';
  END IF;
  IF plan_kind = 'lazy_upgrade'
    AND command_legacy_company_id IS DISTINCT FROM command_target_company_id
  THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_PLAN_STALE'
      USING ERRCODE = '40001';
  END IF;
  IF plan_kind = 'create_new' AND NOT EXISTS (
    SELECT 1 FROM public.canonical_company AS c
    WHERE c.workspace_id = command_workspace_id
      AND c.id = command_target_company_id
      AND c.dedupe_key = command_blocker_key
  ) THEN
    RAISE EXCEPTION 'IDENTITY_RESOLUTION_PLAN_STALE'
      USING ERRCODE = '40001';
  END IF;

  FOR identifier IN SELECT value FROM jsonb_array_elements(command_authority)
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.organization_identifier AS oi
      WHERE oi.workspace_id = command_workspace_id
        AND oi.scheme = identifier->>'scheme'
        AND oi.jurisdiction = identifier->>'jurisdiction'
        AND oi.normalized_value = identifier->>'normalizedValue'
        AND oi.status = 'ACTIVE'
        AND oi.company_id <> command_target_company_id
    ) THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_PLAN_STALE'
        USING ERRCODE = '40001';
    END IF;
    INSERT INTO public.organization_identifier(
      workspace_id, company_id, scheme, jurisdiction, normalized_value,
      authority_provider_key, raw_record_id, confidence,
      normalizer_version, validator_version, provenance, status
    ) VALUES (
      command_workspace_id,
      command_target_company_id,
      identifier->>'scheme',
      identifier->>'jurisdiction',
      identifier->>'normalizedValue',
      identifier->>'providerKey',
      command_raw_record_id,
      1,
      identifier->>'normalizerVersion',
      identifier->>'validatorVersion',
      jsonb_build_object(
        'schemaVersion', 'organization-identifier-provenance/v1',
        'rawRecordId', command_raw_record_id,
        'providerKey', command_provider_key
      ),
      'ACTIVE'
    )
    ON CONFLICT (
      workspace_id, scheme, jurisdiction, normalized_value
    ) WHERE status = 'ACTIVE'
    DO UPDATE SET last_seen_at = GREATEST(
      public.organization_identifier.last_seen_at,
      statement_timestamp()
    )
    WHERE public.organization_identifier.company_id =
      EXCLUDED.company_id;
    GET DIAGNOSTICS inserted_count = ROW_COUNT;
    IF inserted_count <> 1 THEN
      RAISE EXCEPTION 'IDENTITY_RESOLUTION_PLAN_STALE'
        USING ERRCODE = '40001';
    END IF;
  END LOOP;

  INSERT INTO public.identity_link(
    id, workspace_id, canonical_type, canonical_id, raw_record_id,
    match_rule, confidence, status, resolver_version, input_hash, conflict_id
  ) VALUES (
    gen_random_uuid(),
    command_workspace_id,
    'company',
    command_target_company_id,
    command_raw_record_id,
    plan_match_rule,
    CASE WHEN plan_match_rule = 'name_country' THEN 0.8 ELSE 1 END,
    'ACTIVE',
    'organization-identity-resolver/v1',
    plan_input_hash,
    NULL
  );
  RETURN QUERY SELECT
    'bound'::text,
    command_raw_record_id,
    command_target_company_id,
    NULL::uuid,
    plan_match_rule,
    plan_input_hash,
    NULL::text,
    false,
    identifier_total,
    0;
END
$function$;

REVOKE ALL ON FUNCTION public.apply_organization_identity_resolution_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_organization_identity_resolution_v1(jsonb) TO app_user;

COMMIT;
