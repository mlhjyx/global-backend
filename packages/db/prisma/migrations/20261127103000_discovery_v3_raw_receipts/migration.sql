ALTER TABLE public.discovery_run ADD COLUMN v3_plan_queries jsonb;
ALTER TABLE public.discovery_run ADD CONSTRAINT discovery_run_v3_plan_queries_check CHECK (
  v3_plan_queries IS NULL OR (execution_contract_version = 3 AND jsonb_typeof(v3_plan_queries) = 'array')
);
CREATE FUNCTION public.freeze_discovery_v3_plan_queries()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.v3_plan_queries IS DISTINCT FROM NEW.v3_plan_queries THEN
    RAISE EXCEPTION 'DISCOVERY_V3_PLAN_QUERIES_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER freeze_discovery_v3_plan_queries BEFORE UPDATE ON public.discovery_run
  FOR EACH ROW EXECUTE FUNCTION public.freeze_discovery_v3_plan_queries();

CREATE TABLE public.discovery_v3_raw_link (
  workspace_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  raw_record_id uuid NOT NULL,
  query_ordinal integer NOT NULL CHECK (query_ordinal >= 0),
  record_index integer NOT NULL CHECK (record_index >= 0),
  raw_payload_sha256 varchar(64) NOT NULL CHECK (raw_payload_sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (workspace_id, operation_id, record_index),
  FOREIGN KEY (workspace_id, operation_id)
    REFERENCES public.discovery_v3_operation(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, raw_record_id)
    REFERENCES public.raw_source_record(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX discovery_v3_raw_link_workspace_id_raw_record_id_idx
  ON public.discovery_v3_raw_link (workspace_id, raw_record_id);
ALTER TABLE public.discovery_v3_raw_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discovery_v3_raw_link FORCE ROW LEVEL SECURITY;
CREATE POLICY discovery_v3_raw_link_workspace ON public.discovery_v3_raw_link
  USING (workspace_id = public.current_workspace_id())
  WITH CHECK (workspace_id = public.current_workspace_id());
REVOKE ALL ON TABLE public.discovery_v3_raw_link FROM PUBLIC, app_user;
GRANT SELECT, INSERT ON public.discovery_v3_raw_link TO app_user;
