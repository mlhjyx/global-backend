ALTER TABLE public.discovery_run ADD COLUMN v3_worker_attempt integer;
UPDATE public.discovery_run SET v3_worker_attempt = 1 WHERE v3_worker_accepted_at IS NOT NULL;
ALTER TABLE public.discovery_run ADD CONSTRAINT discovery_run_v3_worker_attempt_check CHECK (
  (v3_worker_accepted_at IS NULL AND v3_worker_attempt IS NULL)
  OR (v3_worker_accepted_at IS NOT NULL AND v3_worker_attempt IS NOT NULL AND v3_worker_attempt > 0)
);

CREATE FUNCTION public.guard_discovery_v3_worker_attempt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.v3_worker_attempt IS NOT NULL AND (
       NEW.v3_worker_accepted_at IS DISTINCT FROM OLD.v3_worker_accepted_at
       OR NEW.v3_worker_attempt IS NULL OR NEW.v3_worker_attempt < OLD.v3_worker_attempt
       OR (NEW.v3_worker_attempt > OLD.v3_worker_attempt AND OLD.status <> 'RUNNING')
  )
  THEN
    RAISE EXCEPTION 'DISCOVERY_V3_WORKER_ATTEMPT_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER guard_discovery_v3_worker_attempt BEFORE UPDATE ON public.discovery_run
  FOR EACH ROW EXECUTE FUNCTION public.guard_discovery_v3_worker_attempt();
