ALTER TABLE public.discovery_v3_operation ADD COLUMN gateway_readback jsonb;
ALTER TABLE public.discovery_v3_operation ADD CONSTRAINT discovery_v3_gateway_binding_check CHECK (
  gateway_readback IS NULL OR (
    kind = 'MODEL' AND send_authorized_at IS NOT NULL
    AND jsonb_typeof(gateway_readback) = 'object'
    AND octet_length(gateway_readback::text) <= 2048
    AND NOT (gateway_readback #> '{identity}' ? 'nonce')
    AND (gateway_readback #>> '{identity,requestId}') IS NOT NULL
  )
);
CREATE UNIQUE INDEX discovery_v3_gateway_binding_request_key ON public.discovery_v3_operation
  ((gateway_readback #>> '{identity,requestId}')) WHERE gateway_readback IS NOT NULL;

CREATE FUNCTION public.freeze_discovery_v3_gateway_readback() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.gateway_readback IS DISTINCT FROM NEW.gateway_readback AND
    (OLD.gateway_readback IS NOT NULL OR OLD.send_authorized_at IS NOT NULL OR NEW.status <> 'IN_FLIGHT') THEN
    RAISE EXCEPTION 'DISCOVERY_V3_GATEWAY_BINDING_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER freeze_discovery_v3_gateway_readback BEFORE UPDATE ON public.discovery_v3_operation
  FOR EACH ROW EXECUTE FUNCTION public.freeze_discovery_v3_gateway_readback();

CREATE TABLE public.discovery_v3_gateway_probe (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  sequence smallint NOT NULL CHECK (sequence IN (1, 2)),
  claimed_at timestamptz(3) NOT NULL,
  observed_at timestamptz(3),
  phase varchar(40),
  http_status_class smallint CHECK (http_status_class IN (2, 4, 5)),
  evidence jsonb CHECK (evidence IS NULL OR (jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 2048)),
  CONSTRAINT discovery_v3_gateway_probe_sequence_key UNIQUE (workspace_id, operation_id, sequence),
  FOREIGN KEY (workspace_id, operation_id) REFERENCES public.discovery_v3_operation(workspace_id, id) ON DELETE CASCADE,
  CHECK ((observed_at IS NULL AND phase IS NULL AND http_status_class IS NULL AND evidence IS NULL) OR
    (observed_at IS NOT NULL AND observed_at >= claimed_at AND phase IS NOT NULL AND phase IN (
      'gateway_log_observed', 'gateway_log_pending', 'gateway_log_missing', 'gateway_log_unavailable',
      'gateway_log_invalid', 'gateway_log_ambiguous'
    ) AND (evidence IS NULL OR phase = 'gateway_log_observed')))
);

CREATE FUNCTION public.freeze_discovery_v3_gateway_probe() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF ROW(OLD.id, OLD.workspace_id, OLD.operation_id, OLD.sequence, OLD.claimed_at) IS DISTINCT FROM
    ROW(NEW.id, NEW.workspace_id, NEW.operation_id, NEW.sequence, NEW.claimed_at)
    OR (OLD.observed_at IS NOT NULL AND OLD IS DISTINCT FROM NEW) THEN
    RAISE EXCEPTION 'DISCOVERY_V3_GATEWAY_PROBE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER freeze_discovery_v3_gateway_probe BEFORE UPDATE ON public.discovery_v3_gateway_probe
  FOR EACH ROW EXECUTE FUNCTION public.freeze_discovery_v3_gateway_probe();

ALTER TABLE public.discovery_v3_gateway_probe ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discovery_v3_gateway_probe FORCE ROW LEVEL SECURITY;
CREATE POLICY discovery_v3_gateway_probe_workspace ON public.discovery_v3_gateway_probe
  USING (workspace_id = public.current_workspace_id()) WITH CHECK (workspace_id = public.current_workspace_id());
REVOKE ALL ON TABLE public.discovery_v3_gateway_probe FROM PUBLIC, app_user;
GRANT SELECT, INSERT, UPDATE ON public.discovery_v3_gateway_probe TO app_user;
