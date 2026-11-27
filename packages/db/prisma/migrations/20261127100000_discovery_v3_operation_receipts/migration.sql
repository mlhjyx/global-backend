CREATE TABLE public.discovery_v3_operation (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  step varchar(240) NOT NULL,
  kind varchar(12) NOT NULL CHECK (kind IN ('MODEL', 'TOOL')),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 100),
  request_sha256 varchar(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  claim_proof_sha256 varchar(64) NOT NULL CHECK (claim_proof_sha256 ~ '^[0-9a-f]{64}$'),
  provider varchar(120) NOT NULL,
  action varchar(128) NOT NULL,
  method varchar(64) NOT NULL,
  status varchar(16) NOT NULL CHECK (status IN ('IN_FLIGHT', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
  claimed_at timestamptz(3) NOT NULL,
  deadline timestamptz(3) NOT NULL CHECK (deadline > claimed_at),
  finished_at timestamptz(3),
  receipt_sha256 varchar(64) CHECK (receipt_sha256 ~ '^[0-9a-f]{64}$'),
  recovery_receipt_sha256 varchar(64) CHECK (recovery_receipt_sha256 ~ '^[0-9a-f]{64}$'),
  recovered_at timestamptz(3),
  result jsonb CHECK (octet_length(result::text) <= 131072),
  result_sha256 varchar(64) CHECK (result_sha256 ~ '^[0-9a-f]{64}$'),
  cost jsonb,
  usage jsonb,
  model varchar(160),
  ack varchar(64) CHECK (ack ~ '^[0-9a-f]{64}$'),
  CONSTRAINT discovery_v3_operation_workspace_id_key UNIQUE (workspace_id, id),
  CONSTRAINT discovery_v3_operation_step_key UNIQUE (workspace_id, run_id, step, kind, ordinal),
  CONSTRAINT discovery_v3_operation_workspace_id_run_id_fkey
    FOREIGN KEY (workspace_id, run_id) REFERENCES public.discovery_run(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT discovery_v3_operation_receipt_check CHECK (
    (status = 'IN_FLIGHT' AND finished_at IS NULL AND receipt_sha256 IS NULL AND cost IS NULL AND result IS NULL)
    OR (status <> 'IN_FLIGHT' AND finished_at IS NOT NULL AND receipt_sha256 IS NOT NULL AND cost IS NOT NULL)
  ),
  CONSTRAINT discovery_v3_operation_bound_result_check CHECK (
    (result IS NULL AND result_sha256 IS NULL AND ack IS NULL)
    OR (status = 'SUCCEEDED' AND result IS NOT NULL AND result_sha256 IS NOT NULL)
  ),
  CONSTRAINT discovery_v3_operation_recovery_check CHECK (
    (recovery_receipt_sha256 IS NULL AND recovered_at IS NULL)
    OR (status IN ('SUCCEEDED', 'FAILED') AND recovery_receipt_sha256 IS NOT NULL AND recovered_at >= finished_at)
  )
);

CREATE INDEX discovery_v3_operation_run_status_idx
  ON public.discovery_v3_operation (workspace_id, run_id, status);

CREATE TABLE public.discovery_v3_cost_revision (
  workspace_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  digest varchar(64) NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz(3) NOT NULL,
  observation jsonb NOT NULL,
  supersedes varchar(64),
  PRIMARY KEY (workspace_id, operation_id, digest),
  FOREIGN KEY (workspace_id, operation_id)
    REFERENCES public.discovery_v3_operation(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, operation_id, supersedes)
    REFERENCES public.discovery_v3_cost_revision(workspace_id, operation_id, digest)
);

ALTER TABLE public.discovery_v3_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discovery_v3_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY discovery_v3_operation_workspace ON public.discovery_v3_operation
  USING (workspace_id = public.current_workspace_id())
  WITH CHECK (workspace_id = public.current_workspace_id());
ALTER TABLE public.discovery_v3_cost_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discovery_v3_cost_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY discovery_v3_cost_revision_workspace ON public.discovery_v3_cost_revision
  USING (workspace_id = public.current_workspace_id())
  WITH CHECK (workspace_id = public.current_workspace_id());

REVOKE ALL ON TABLE public.discovery_v3_operation, public.discovery_v3_cost_revision FROM PUBLIC, app_user;
GRANT SELECT, INSERT, UPDATE ON public.discovery_v3_operation TO app_user;
GRANT SELECT, INSERT ON public.discovery_v3_cost_revision TO app_user;

CREATE FUNCTION public.freeze_discovery_v3_operation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF (OLD.id, OLD.workspace_id, OLD.run_id, OLD.step, OLD.kind, OLD.ordinal, OLD.request_sha256,
      OLD.claim_proof_sha256, OLD.provider, OLD.action, OLD.method, OLD.claimed_at, OLD.deadline)
     IS DISTINCT FROM
     (NEW.id, NEW.workspace_id, NEW.run_id, NEW.step, NEW.kind, NEW.ordinal, NEW.request_sha256,
      NEW.claim_proof_sha256, NEW.provider, NEW.action, NEW.method, NEW.claimed_at, NEW.deadline)
     OR (OLD.status <> NEW.status AND OLD.status <> 'IN_FLIGHT'
         AND NOT (OLD.status = 'UNKNOWN' AND NEW.status IN ('SUCCEEDED', 'FAILED') AND NEW.recovered_at IS NOT NULL))
     OR (OLD.finished_at IS NOT NULL AND OLD.finished_at IS DISTINCT FROM NEW.finished_at)
     OR (OLD.receipt_sha256 IS NOT NULL AND OLD.receipt_sha256 IS DISTINCT FROM NEW.receipt_sha256)
     OR (OLD.recovered_at IS NOT NULL AND
         (OLD.recovered_at, OLD.recovery_receipt_sha256) IS DISTINCT FROM (NEW.recovered_at, NEW.recovery_receipt_sha256))
     OR (OLD.result_sha256 IS NOT NULL AND (OLD.result, OLD.result_sha256) IS DISTINCT FROM (NEW.result, NEW.result_sha256))
     OR (OLD.ack IS NOT NULL AND OLD.ack IS DISTINCT FROM NEW.ack)
  THEN
    RAISE EXCEPTION 'DISCOVERY_V3_OPERATION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER freeze_discovery_v3_operation BEFORE UPDATE ON public.discovery_v3_operation
  FOR EACH ROW EXECUTE FUNCTION public.freeze_discovery_v3_operation();
