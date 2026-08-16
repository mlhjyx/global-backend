-- raw-source/v2 predates source_entity_id. Preserve its immutable-origin
-- guarantee when monitored snapshots add the second allowed provenance root.
CREATE OR REPLACE FUNCTION reject_raw_source_record_origin_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."ingest_version" = 'raw-source/v2'
     AND NEW."source_entity_id" IS DISTINCT FROM OLD."source_entity_id"
  THEN
    RAISE EXCEPTION 'raw-source/v2 origin is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "raw_source_record_origin_immutable_guard"
BEFORE UPDATE ON "raw_source_record"
FOR EACH ROW EXECUTE FUNCTION reject_raw_source_record_origin_mutation();
