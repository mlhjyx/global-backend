-- M10-PR2: Outbox <1s PostgreSQL LISTEN/NOTIFY wakeup (additive, keeps polling fallback).
-- Emits transactional pg_notify('global_outbox_wakeup', workspace_id) when rows enter
-- public.outbox_event so OutboxRelayService wakes up immediately after COMMIT without
-- firing phantom notifications on rolled-back transactions.

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.notify_outbox_event_wakeup()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify('global_outbox_wakeup', NEW.workspace_id::text);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_outbox_event_notify_wakeup ON public.outbox_event;

CREATE TRIGGER trg_outbox_event_notify_wakeup
  AFTER INSERT ON public.outbox_event
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_outbox_event_wakeup();
