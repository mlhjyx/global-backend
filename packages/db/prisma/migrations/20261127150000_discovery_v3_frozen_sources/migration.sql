ALTER TABLE public.discovery_run ADD COLUMN v3_source_routes jsonb;
ALTER TABLE public.discovery_run ADD CONSTRAINT discovery_v3_source_routes_check CHECK (
  v3_source_routes IS NULL OR (
    execution_contract_version = 3 AND v3_worker_accepted_at IS NOT NULL
    AND jsonb_typeof(v3_source_routes) = 'array' AND octet_length(v3_source_routes::text) <= 32768
  )
);

CREATE FUNCTION public.freeze_discovery_v3_source_routes() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.v3_source_routes IS DISTINCT FROM NEW.v3_source_routes AND
    (OLD.v3_source_routes IS NOT NULL OR OLD.status <> 'RUNNING' OR NEW.status <> 'RUNNING') THEN
    RAISE EXCEPTION 'DISCOVERY_V3_SOURCE_ROUTES_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER freeze_discovery_v3_source_routes BEFORE UPDATE ON public.discovery_run
  FOR EACH ROW EXECUTE FUNCTION public.freeze_discovery_v3_source_routes();
