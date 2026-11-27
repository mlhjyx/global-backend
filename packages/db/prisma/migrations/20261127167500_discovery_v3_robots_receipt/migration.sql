CREATE OR REPLACE FUNCTION public.enforce_discovery_v3_artifact_receipt_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE schema_name text;
BEGIN
  IF NEW.method = 'robots' THEN
    IF NEW.status = 'SUCCEEDED' AND NOT coalesce(
      NEW.kind = 'TOOL' AND NEW.action = 'crawl4ai.fetch' AND NEW.provider = NEW.action
      AND right(NEW.step, 7) = '/robots' AND NEW.send_authorized_at IS NOT NULL
      AND jsonb_typeof(NEW.result#>'{data,allowed}') = 'boolean'
      AND NEW.result = jsonb_build_object(
        'schemaVersion', 'generic-operation-projection/v1', 'kind', 'tool',
        'schema', 'discovery-v3-robots/v1', 'digest', NEW.result_sha256,
        'data', jsonb_build_object('allowed', NEW.result#>'{data,allowed}')
      ), false
    ) THEN
      RAISE EXCEPTION 'DISCOVERY_V3_ROBOTS_RECEIPT_REQUIRED' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  schema_name := discovery_v3_artifact_result_schema_v1(NEW.action);
  IF NEW.status = 'SUCCEEDED' AND NEW.kind = 'TOOL'
    AND (schema_name IS NOT NULL OR NEW.result->>'schema' = 'discovery-v3-artifact-reference/v1')
    AND NOT EXISTS (
      SELECT 1 FROM public.generic_operation_artifact artifact
      WHERE artifact.workspace_id = NEW.workspace_id
        AND artifact.execution_contract_version = 3 AND artifact.discovery_v3_operation_id = NEW.id
        AND artifact.result_schema = schema_name
        AND NEW.result = jsonb_build_object(
          'schemaVersion', 'generic-operation-projection/v1', 'kind', 'tool',
          'schema', 'discovery-v3-artifact-reference/v1', 'digest', NEW.result_sha256,
          'data', discovery_v3_artifact_reference_v1(artifact)
        )
    )
  THEN
    RAISE EXCEPTION 'DISCOVERY_V3_ARTIFACT_RECEIPT_REQUIRED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
