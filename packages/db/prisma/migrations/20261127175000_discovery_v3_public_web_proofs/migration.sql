-- Native public_web Raw can only be read after its search and model results
-- are acknowledged together. The raw link points at the exact model result.
CREATE FUNCTION public.discovery_v3_public_web_raw_proof(p_link public.discovery_v3_raw_link)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.raw_source_record AS raw
    JOIN public.discovery_v3_operation AS model
      ON (model.workspace_id, model.run_id) = (raw.workspace_id, raw.run_id)
    JOIN public.discovery_run AS run
      ON (run.workspace_id, run.id) = (model.workspace_id, model.run_id)
    CROSS JOIN LATERAL (
      SELECT 'query/' || p_link.query_ordinal::text || '/public_web' AS step,
        regexp_replace(substring(raw.source_url FROM '^https://([^/:?#]+)'), '^www\.', '') AS domain
    ) AS proof
    JOIN public.discovery_v3_operation AS plan
      ON (plan.workspace_id, plan.run_id) = (run.workspace_id, run.id)
      AND plan.step = proof.step || '/plan'
    WHERE raw.workspace_id = p_link.workspace_id AND raw.id = p_link.raw_record_id
      AND raw.payload_hash = p_link.raw_payload_sha256 AND raw.provider_key = 'public_web'
      AND raw.parser_version = 'public_web/v3' AND p_link.record_index = 0
      AND raw.source_class IN ('public_intelligence', 'industry_data')
      AND run.execution_contract_version = 3 AND run.v3_worker_accepted_at IS NOT NULL
      AND (run.v3_source_routes -> p_link.query_ordinal) ? 'public_web'
      AND model.id = p_link.operation_id AND model.kind = 'MODEL'
      AND model.action = 'discovery.extract_company' AND model.method = 'generateStructured'
      AND model.step = proof.step || '/company/' || encode(public.digest(proof.domain, 'sha256'), 'hex') || '/model/1'
      AND model.status = 'SUCCEEDED' AND model.ack IS NOT NULL AND model.send_authorized_at IS NOT NULL
      AND model.result_sha256 = model.result->>'digest'
      AND model.result->>'schema' = 'discovery-extract-company/v1' AND model.result->>'kind' = 'model'
      AND model.result#>'{data,result,data,data,isCompanySite}' = 'true'::jsonb
      AND jsonb_typeof(model.result#>'{data,result,data,data,name}') = 'string'
      AND raw.content_hash = encode(public.digest('public-web-v3' || chr(10) ||
        model.result_sha256 || chr(10) || raw.source_url, 'sha256'), 'hex')
      AND (raw.ingest_status <> 'ACCEPTED' OR (raw.external_id = proof.domain AND raw.payload->>'domain' = proof.domain))
      AND plan.kind = 'TOOL' AND plan.action = 'public_web.search_plan' AND plan.provider = plan.action
      AND plan.method = 'local-query' AND plan.send_authorized_at IS NULL AND plan.ordinal = 1
      AND plan.status = 'SUCCEEDED' AND plan.ack = model.ack
      AND plan.result_sha256 = plan.result->>'digest'
      AND plan.result->>'schema' = 'discovery-v3-public-web-search-plan/v1' AND plan.result->>'kind' = 'tool'
      AND jsonb_typeof(plan.result#>'{data,includeSerper}') = 'boolean'
      AND EXISTS (
        SELECT 1
        FROM public.discovery_v3_operation AS search
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(search.result#>'{data,data,data,results}') = 'array'
            THEN search.result#>'{data,data,data,results}' ELSE '[]'::jsonb END
        ) AS hit(result)
        WHERE (search.workspace_id, search.run_id) = (run.workspace_id, run.id)
          AND search.kind = 'TOOL' AND search.method = 'invoke' AND search.ordinal = 1
          AND search.status = 'SUCCEEDED' AND search.ack = model.ack AND search.send_authorized_at IS NOT NULL
          AND search.provider = search.action AND search.result_sha256 = search.result->>'digest'
          AND search.result->>'kind' = 'tool'
          AND CASE search.action
            WHEN 'searxng.search' THEN search.result->>'schema' = 'searxng-search/v1'
              AND search.step ~ ('^' || proof.step || '/search/[1-9][0-9]?/tool/1$')
            WHEN 'serper.search' THEN search.result->>'schema' = 'serper-search/v1'
              AND plan.result#>'{data,includeSerper}' = 'true'::jsonb
              AND search.step ~ ('^' || proof.step || '/search/[1-9][0-9]?/tool/2$')
            ELSE false
          END
          AND search.claimed_at = raw.fetched_at
          AND jsonb_typeof(hit.result->'title') = 'string' AND btrim(hit.result->>'title') <> ''
          AND split_part(split_part(hit.result->>'url', '#', 1), '?', 1) = raw.source_url
      )
  )
$$;

REVOKE ALL ON FUNCTION public.discovery_v3_public_web_raw_proof(public.discovery_v3_raw_link) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.discovery_v3_public_web_raw_proof(public.discovery_v3_raw_link) TO app_user;

-- Preserve the existing exact guards for every other native producer.
DO $patch$
DECLARE
  body text := pg_get_functiondef('public.check_discovery_v3_raw_link()'::regprocedure);
  kind_guard text := 'AND operation.kind = ''TOOL'' AND operation.status = ''SUCCEEDED''';
  case_guard text := 'WHEN ''channel_catalog'' THEN';
BEGIN
  IF (length(body) - length(replace(body, kind_guard, ''))) <> length(kind_guard)
    OR (length(body) - length(replace(body, case_guard, ''))) <> length(case_guard) THEN
    RAISE EXCEPTION 'DISCOVERY_V3_PUBLIC_WEB_PROOF_INSTALL_MISMATCH';
  END IF;
  body := replace(body, kind_guard, 'AND (operation.kind = ''TOOL'' OR raw.provider_key = ''public_web'') AND operation.status = ''SUCCEEDED''');
  EXECUTE replace(body, case_guard, 'WHEN ''public_web'' THEN public.discovery_v3_public_web_raw_proof(NEW)' || chr(10) || '        ' || case_guard);
END
$patch$;

CREATE FUNCTION public.check_discovery_v3_public_web_raw_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.discovery_v3_raw_link AS link
    WHERE (link.workspace_id, link.raw_record_id) = (NEW.workspace_id, NEW.id)
      AND public.discovery_v3_public_web_raw_proof(link)
  ) THEN
    RAISE EXCEPTION 'DISCOVERY_V3_PUBLIC_WEB_RAW_REQUIRES_PROOF' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER check_discovery_v3_public_web_raw_write
AFTER INSERT ON public.raw_source_record DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.provider_key = 'public_web' AND NEW.parser_version = 'public_web/v3')
EXECUTE FUNCTION public.check_discovery_v3_public_web_raw_write();

REVOKE ALL ON FUNCTION public.check_discovery_v3_public_web_raw_write() FROM PUBLIC;
