-- Extend the v3 proof check without changing v2 lineage or receipt identifiers.
CREATE OR REPLACE FUNCTION public.check_discovery_v3_raw_link()
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
    CROSS JOIN LATERAL (SELECT operation.result#>'{data,data,data}' AS body) AS projection
    WHERE operation.workspace_id = NEW.workspace_id AND operation.id = NEW.operation_id
      AND raw.id = NEW.raw_record_id AND raw.payload_hash = NEW.raw_payload_sha256
      AND operation.kind = 'TOOL' AND operation.status = 'SUCCEEDED' AND operation.ack IS NOT NULL
      AND split_part(operation.step, '/', 1) = 'query'
      AND split_part(operation.step, '/', 2) = NEW.query_ordinal::text
      AND split_part(operation.step, '/', 3) = raw.provider_key
      AND CASE raw.provider_key
        WHEN 'wikidata' THEN operation.action = 'wikidata.sparql'
          AND operation.result->>'schema' = 'wikidata-sparql/v1'
          AND CASE WHEN raw.ingest_status = 'ACCEPTED'
            THEN raw.external_id = 'wikidata:' || (projection.body->'companies'->NEW.record_index->>'qid')
            ELSE raw.content_hash = (projection.body->'companies'->NEW.record_index->>'qid') END
        WHEN 'openstreetmap' THEN operation.action = 'osm.overpass'
          AND operation.result->>'schema' = 'osm-overpass/v1'
          AND CASE WHEN raw.ingest_status = 'ACCEPTED'
            THEN raw.external_id = 'osm:' || (projection.body->'places'->NEW.record_index->>'osmId')
            ELSE raw.content_hash = (projection.body->'places'->NEW.record_index->>'osmId') END
        WHEN 'companies_house_registry' THEN operation.action = 'companies_house.search'
          AND operation.result->>'schema' = 'companies-house-search/v1'
          AND NOT (projection.body ? 'officers')
          AND raw.content_hash = encode(public.digest('companies_house_registry:' ||
            upper(btrim(projection.body->'companies'->NEW.record_index->>'companyNumber')) || ':' ||
            btrim(projection.body->'companies'->NEW.record_index->>'title'), 'sha256'), 'hex')
        WHEN 'opencorporates' THEN operation.action = 'opencorporates.search'
          AND operation.result->>'schema' = 'opencorporates-search/v1'
          AND raw.content_hash = encode(public.digest('opencorporates:' ||
            lower(btrim(projection.body->'companies'->NEW.record_index->>'jurisdictionCode')) || ':' ||
            btrim(projection.body->'companies'->NEW.record_index->>'companyNumber') || ':' ||
            btrim(projection.body->'companies'->NEW.record_index->>'name'), 'sha256'), 'hex')
        WHEN 'ted' THEN operation.action = 'ted.search'
          AND operation.result->>'schema' = 'ted-search/v1'
          AND NOT (projection.body ? 'notices')
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(projection.body->'awards') AS award
            CROSS JOIN LATERAL jsonb_array_elements(award->'winners') AS winner
            WHERE raw.content_hash = encode(public.digest('ted:' || coalesce(award->>'publicationNumber', '') || ':' ||
              (winner->>'name') || ':' || coalesce(winner->>'identifier', ''), 'sha256'), 'hex')
          )
        ELSE false END
  ) THEN
    RAISE EXCEPTION 'DISCOVERY_V3_RAW_LINK_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
