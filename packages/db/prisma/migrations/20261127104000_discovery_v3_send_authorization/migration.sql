ALTER TABLE public.discovery_v3_operation ADD COLUMN send_authorized_at timestamptz(3);
ALTER TABLE public.discovery_v3_operation ADD CONSTRAINT discovery_v3_send_authorization_check CHECK (
  send_authorized_at IS NULL OR (send_authorized_at >= claimed_at AND send_authorized_at < deadline)
);

CREATE FUNCTION public.freeze_discovery_v3_send_authorization()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.send_authorized_at IS DISTINCT FROM NEW.send_authorized_at
     AND (OLD.send_authorized_at IS NOT NULL OR OLD.status <> 'IN_FLIGHT' OR NEW.status <> 'IN_FLIGHT')
  THEN
    RAISE EXCEPTION 'DISCOVERY_V3_SEND_AUTHORIZATION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER freeze_discovery_v3_send_authorization BEFORE UPDATE ON public.discovery_v3_operation
  FOR EACH ROW EXECUTE FUNCTION public.freeze_discovery_v3_send_authorization();
