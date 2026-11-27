BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- The public receipt only contains audit metadata. Keep the exact versions
-- between database commit and storage completion in this private relation.
CREATE TABLE public.workspace_purge_db_checkpoint (
  receipt_id uuid PRIMARY KEY REFERENCES public.workspace_purge_receipt(id) ON DELETE CASCADE ON UPDATE CASCADE,
  db_rows_deleted jsonb NOT NULL CHECK (jsonb_typeof(db_rows_deleted) = 'object'),
  personal_objects_to_erase jsonb NOT NULL CHECK (jsonb_typeof(personal_objects_to_erase) = 'array')
);

ALTER TABLE public.workspace_purge_db_checkpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_purge_db_checkpoint FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.workspace_purge_db_checkpoint
  FROM PUBLIC, app_user, execution_budget_platform_writer, runtime_api, runtime_worker, runtime_outbox_relay,
       runtime_platform_worker, runtime_outbox_relay_worker, runtime_memory_outbox_reader, runtime_customer_worker_ops;

DO $migration$
DECLARE
  purge text := pg_get_functiondef('public.purge_workspace_tenant_data_v1(uuid)'::regprocedure);
  complete text := pg_get_functiondef(
    'public.complete_workspace_purge_v1(uuid,jsonb,jsonb,integer,integer)'::regprocedure);
  receipt_variable text := $old$  v_receipt_ok INTEGER;$old$;
  receipt_lock_anchor text := $old$  SELECT 1 INTO v_receipt_ok
  FROM public."workspace_purge_receipt" r
  WHERE r."workspace_id" = p_workspace_id
    AND r."status" = 'RUNNING';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WORKSPACE_PURGE_NOT_RUNNING' USING ERRCODE = '42501';
  END IF;$old$;
  receipt_lock text := $new$  SELECT r.id INTO v_receipt_id
  FROM public.workspace_purge_receipt r
  WHERE r.workspace_id = p_workspace_id AND r.status = 'RUNNING'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WORKSPACE_PURGE_NOT_RUNNING' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT c.db_rows_deleted, c.personal_objects_to_erase
  FROM public.workspace_purge_db_checkpoint c
  WHERE c.receipt_id = v_receipt_id;
  IF FOUND THEN
    RETURN;
  END IF;$new$;
  purge_return_anchor text := $old$  RETURN QUERY SELECT v_counts, COALESCE(v_personal_objects, '[]'::jsonb);$old$;
  purge_return text := $new$  INSERT INTO public.workspace_purge_db_checkpoint(receipt_id, db_rows_deleted, personal_objects_to_erase)
  VALUES (v_receipt_id, v_counts, COALESCE(v_personal_objects, '[]'::jsonb));

  RETURN QUERY SELECT v_counts, COALESCE(v_personal_objects, '[]'::jsonb);$new$;
  complete_update_anchor text := $old$  UPDATE public."workspace_purge_receipt" r
  SET
    "status" = 'COMPLETED',$old$;
  complete_update text := $new$  PERFORM 1 FROM public.workspace_purge_receipt r
  WHERE r.workspace_id = p_workspace_id
  FOR UPDATE;

  IF EXISTS (
    SELECT 1
    FROM public.workspace_purge_db_checkpoint c
    JOIN public.workspace_purge_receipt r ON r.id = c.receipt_id
    WHERE r.workspace_id = p_workspace_id
      AND (r.status <> 'RUNNING' OR c.db_rows_deleted IS DISTINCT FROM COALESCE(p_db_rows_deleted, '{}'::jsonb))
  ) THEN
    RAISE EXCEPTION 'WORKSPACE_PURGE_DB_CHECKPOINT_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public."workspace_purge_receipt" r
  SET
    "status" = 'COMPLETED',$new$;
  complete_return_anchor text := $old$  RETURN QUERY
  SELECT
    r."id", r."workspace_id", r."idempotency_key", r."status", r."requested_by",$old$;
  complete_return text := $new$  DELETE FROM public.workspace_purge_db_checkpoint c
  USING public.workspace_purge_receipt r
  WHERE c.receipt_id = r.id AND r.workspace_id = p_workspace_id AND r.status = 'COMPLETED';

  RETURN QUERY
  SELECT
    r."id", r."workspace_id", r."idempotency_key", r."status", r."requested_by",$new$;
BEGIN
  IF length(purge) - length(replace(purge, receipt_variable, '')) <> length(receipt_variable)
    OR length(purge) - length(replace(purge, receipt_lock_anchor, '')) <> length(receipt_lock_anchor)
    OR length(purge) - length(replace(purge, purge_return_anchor, '')) <> length(purge_return_anchor)
    OR length(complete) - length(replace(complete, complete_update_anchor, '')) <> length(complete_update_anchor)
    OR length(complete) - length(replace(complete, complete_return_anchor, '')) <> length(complete_return_anchor) THEN
    RAISE EXCEPTION 'WORKSPACE_PURGE_DB_CHECKPOINT_TARGET_MISMATCH';
  END IF;

  EXECUTE replace(replace(replace(purge, receipt_variable, '  v_receipt_id uuid;'),
    receipt_lock_anchor, receipt_lock), purge_return_anchor, purge_return);
  EXECUTE replace(replace(complete, complete_update_anchor, complete_update), complete_return_anchor, complete_return);
END
$migration$;

COMMIT;
