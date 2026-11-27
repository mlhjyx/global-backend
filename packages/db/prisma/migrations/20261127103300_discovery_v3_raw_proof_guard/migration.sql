CREATE FUNCTION public.check_discovery_v3_raw_link()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.discovery_v3_operation AS operation
    JOIN public.raw_source_record AS raw
      ON raw.workspace_id = operation.workspace_id AND raw.run_id = operation.run_id
    WHERE operation.workspace_id = NEW.workspace_id AND operation.id = NEW.operation_id
      AND raw.id = NEW.raw_record_id AND raw.payload_hash = NEW.raw_payload_sha256
      AND operation.kind = 'TOOL' AND operation.status = 'SUCCEEDED' AND operation.ack IS NOT NULL
      AND split_part(operation.step, '/', 1) = 'query'
      AND split_part(operation.step, '/', 2) = NEW.query_ordinal::text
      AND split_part(operation.step, '/', 3) = raw.provider_key
      AND raw.provider_key = 'wikidata' AND operation.action = 'wikidata.sparql'
      AND operation.result->>'schema' = 'wikidata-sparql/v1'
      AND jsonb_typeof(operation.result#>'{data,data,data,companies}') = 'array'
      AND operation.result#>'{data,data,data,companies}'->NEW.record_index->>'qid' IS NOT NULL
      AND (CASE WHEN raw.ingest_status = 'ACCEPTED'
        THEN raw.external_id = 'wikidata:' || (operation.result#>'{data,data,data,companies}'->NEW.record_index->>'qid')
        ELSE raw.content_hash = (operation.result#>'{data,data,data,companies}'->NEW.record_index->>'qid')
      END)
  ) THEN
    RAISE EXCEPTION 'DISCOVERY_V3_RAW_LINK_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE CONSTRAINT TRIGGER check_discovery_v3_raw_link
  AFTER INSERT ON public.discovery_v3_raw_link DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.check_discovery_v3_raw_link();
