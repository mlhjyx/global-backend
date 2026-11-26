-- MT-P1 PR2: Async Tenant Data Export (`data_export_job`) + Whole-Workspace Physical Purge
-- (`workspace_purge_receipt`, `workspace_purge_tx_fence`, 5 immutable trigger fence updates,
--  and M4-compliant app_user-callable SECURITY DEFINER RPCs).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- 1. Async tenant data export job table (workspace-isolated, FORCE RLS)
CREATE TABLE public."data_export_job" (
  "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "requested_by" UUID NOT NULL,
  "scope"        VARCHAR(32) NOT NULL,
  "format"       VARCHAR(16) NOT NULL,
  "status"       VARCHAR(24) NOT NULL DEFAULT 'pending',
  "object_key"   VARCHAR(256),
  "content_type" VARCHAR(120),
  "filename"     VARCHAR(255),
  "byte_size"    BIGINT,
  "row_count"    INTEGER,
  "error_code"   VARCHAR(120),
  "expires_at"   TIMESTAMPTZ(3),
  "completed_at" TIMESTAMPTZ(3),
  "created_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "data_export_job_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "data_export_job_scope_check" CHECK (
    "scope" IN ('leads', 'companies', 'contacts', 'outreach', 'full_archive')
  ),
  CONSTRAINT "data_export_job_format_check" CHECK (
    "format" IN ('csv', 'jsonl')
  ),
  CONSTRAINT "data_export_job_status_check" CHECK (
    "status" IN ('pending', 'processing', 'ready', 'failed', 'expired')
  ),
  CONSTRAINT "data_export_job_object_key_check" CHECK (
    "object_key" IS NULL OR "object_key" ~ '^ws/[0-9a-f-]+/exports/'
  )
);

CREATE INDEX "data_export_job_workspace_created_id_idx"
  ON public."data_export_job" ("workspace_id", "created_at" DESC, "id" DESC);

CREATE INDEX "data_export_job_status_expires_idx"
  ON public."data_export_job" ("status", "expires_at");

ALTER TABLE public."data_export_job" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."data_export_job" FORCE ROW LEVEL SECURITY;

CREATE POLICY "data_export_job_tenant_isolation"
  ON public."data_export_job"
  USING ("workspace_id" = public.current_workspace_id())
  WITH CHECK ("workspace_id" = public.current_workspace_id());

GRANT SELECT, INSERT, UPDATE ON TABLE public."data_export_job" TO app_user;

-- 2. Whole-workspace purge receipt (NO FK to workspace so receipt remains auditable post-purge)
CREATE TABLE public."workspace_purge_receipt" (
  "id"                           UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id"                 UUID NOT NULL,
  "idempotency_key"              VARCHAR(128) NOT NULL,
  "status"                       VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  "requested_by"                 UUID,
  "cleanup_manifest"             JSONB NOT NULL DEFAULT '{}'::jsonb,
  "db_rows_deleted"              JSONB,
  "minio_objects_deleted"        JSONB,
  "redis_keys_deleted"           INTEGER NOT NULL DEFAULT 0,
  "temporal_workflows_cancelled" INTEGER NOT NULL DEFAULT 0,
  "error_code"                   VARCHAR(120),
  "rule_version"                 VARCHAR(64) NOT NULL DEFAULT 'workspace-purge/v1',
  "started_at"                   TIMESTAMPTZ(3),
  "completed_at"                 TIMESTAMPTZ(3),
  "created_at"                   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "workspace_purge_receipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workspace_purge_receipt_status_check" CHECK (
    "status" IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')
  )
);

CREATE UNIQUE INDEX "workspace_purge_receipt_workspace_id_key"
  ON public."workspace_purge_receipt" ("workspace_id");

ALTER TABLE public."workspace_purge_receipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."workspace_purge_receipt" FORCE ROW LEVEL SECURITY;

CREATE POLICY "workspace_purge_receipt_tenant_select"
  ON public."workspace_purge_receipt"
  FOR SELECT
  USING ("workspace_id" = public.current_workspace_id());

GRANT SELECT ON TABLE public."workspace_purge_receipt" TO app_user;

-- 3. Per-transaction fence table (owner_only: RLS enabled + forced, 0 policies, 0 app_user grants)
CREATE TABLE public."workspace_purge_tx_fence" (
  "pid"                 INTEGER NOT NULL,
  "xid"                 TEXT NOT NULL,
  "target_workspace_id" UUID NOT NULL,
  "nonce"               UUID NOT NULL,

  CONSTRAINT "workspace_purge_tx_fence_pkey" PRIMARY KEY ("pid", "xid", "target_workspace_id")
);

ALTER TABLE public."workspace_purge_tx_fence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."workspace_purge_tx_fence" FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public."workspace_purge_tx_fence"
  FROM PUBLIC,
       app_user,
       execution_budget_platform_writer,
       runtime_api,
       runtime_worker,
       runtime_outbox_relay,
       runtime_platform_worker,
       runtime_outbox_relay_worker,
       runtime_memory_outbox_reader,
       runtime_customer_worker_ops;

-- 4. Fence check helper + 5 immutable trigger updates (allow DELETE only inside active purge fence)
CREATE FUNCTION public.workspace_purge_fence_active_v1(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_workspace_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public."workspace_purge_tx_fence" f
      WHERE f."pid" = pg_backend_pid()
        AND f."xid" = pg_current_xact_id_if_assigned()::text
        AND f."target_workspace_id" = p_workspace_id
        AND f."nonce"::text = NULLIF(current_setting('app.workspace_purge_nonce', true), '')
    );
$$;

REVOKE ALL ON FUNCTION public.workspace_purge_fence_active_v1(UUID)
  FROM PUBLIC,
       app_user,
       execution_budget_platform_writer,
       runtime_api,
       runtime_worker,
       runtime_outbox_relay,
       runtime_platform_worker,
       runtime_outbox_relay_worker,
       runtime_memory_outbox_reader,
       runtime_customer_worker_ops;

CREATE OR REPLACE FUNCTION public.reject_raw_source_record_delete_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND public.workspace_purge_fence_active_v1(OLD."workspace_id") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'raw source physical deletion is forbidden; use one-way expiry'
    USING ERRCODE = '55000';
END
$$;

CREATE OR REPLACE FUNCTION public.reject_raw_source_governance_mutation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND public.workspace_purge_fence_active_v1(OLD."workspace_id") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'raw source governance dispositions are permanent and append-only'
    USING ERRCODE = '55000';
END
$$;

CREATE OR REPLACE FUNCTION public.reject_discovery_query_lineage_mutation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND public.workspace_purge_fence_active_v1(OLD."workspace_id") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'DISCOVERY_QUERY_LINEAGE_IMMUTABLE' USING ERRCODE = 'P0001';
END
$$;

CREATE OR REPLACE FUNCTION public.reject_discovery_company_materialization_mutation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $body$
BEGIN
  IF TG_TABLE_NAME = 'discovery_company_materialization_activation' THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_IMMUTABLE'
      USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' AND public.workspace_purge_fence_active_v1(OLD."workspace_id") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_IMMUTABLE'
    USING ERRCODE = 'P0001';
END
$body$;

CREATE OR REPLACE FUNCTION public.deny_site_build_provider_append_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND public.workspace_purge_fence_active_v1(OLD."workspace_id") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'site build provider readback facts are append-only';
END
$$;

-- 5. app_user-callable SECURITY DEFINER RPCs for workspace purge lifecycle
CREATE FUNCTION public.begin_workspace_purge_v1(
  p_workspace_id UUID,
  p_idempotency_key VARCHAR(128),
  p_requested_by UUID DEFAULT NULL
)
RETURNS TABLE(
  "id" UUID,
  "workspace_id" UUID,
  "idempotency_key" VARCHAR(128),
  "status" VARCHAR(16),
  "requested_by" UUID,
  "cleanup_manifest" JSONB,
  "db_rows_deleted" JSONB,
  "minio_objects_deleted" JSONB,
  "redis_keys_deleted" INTEGER,
  "temporal_workflows_cancelled" INTEGER,
  "error_code" VARCHAR(120),
  "rule_version" VARCHAR(64),
  "started_at" TIMESTAMPTZ(3),
  "completed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3),
  "updated_at" TIMESTAMPTZ(3)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_key VARCHAR(128);
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
     OR current_user IS NOT DISTINCT FROM session_user
     OR current_setting('role', true) IS DISTINCT FROM 'none'
  THEN
    RAISE EXCEPTION 'WORKSPACE_PURGE_DENIED' USING ERRCODE = '42501';
  END IF;

  IF p_workspace_id IS NULL OR p_workspace_id IS DISTINCT FROM public.current_workspace_id() THEN
    RAISE EXCEPTION 'WORKSPACE_PURGE_WORKSPACE_REQUIRED' USING ERRCODE = '42501';
  END IF;

  v_key := NULLIF(trim(p_idempotency_key), '');
  IF v_key IS NULL OR char_length(v_key) > 128 THEN
    RAISE EXCEPTION 'WORKSPACE_PURGE_IDEMPOTENCY_KEY_INVALID' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public."workspace_purge_receipt" (
    "workspace_id",
    "idempotency_key",
    "status",
    "requested_by"
  ) VALUES (
    p_workspace_id,
    v_key,
    'PENDING',
    p_requested_by
  )
  ON CONFLICT ("workspace_id") DO UPDATE
  SET
    "status" = CASE
      WHEN public."workspace_purge_receipt"."status" = 'FAILED' THEN 'PENDING'
      ELSE public."workspace_purge_receipt"."status"
    END,
    "idempotency_key" = CASE
      WHEN public."workspace_purge_receipt"."status" = 'FAILED' THEN EXCLUDED."idempotency_key"
      ELSE public."workspace_purge_receipt"."idempotency_key"
    END,
    "requested_by" = CASE
      WHEN public."workspace_purge_receipt"."status" = 'FAILED'
        THEN COALESCE(EXCLUDED."requested_by", public."workspace_purge_receipt"."requested_by")
      ELSE public."workspace_purge_receipt"."requested_by"
    END,
    "error_code" = CASE
      WHEN public."workspace_purge_receipt"."status" = 'FAILED' THEN NULL
      ELSE public."workspace_purge_receipt"."error_code"
    END,
    "updated_at" = CASE
      WHEN public."workspace_purge_receipt"."status" = 'FAILED' THEN clock_timestamp()
      ELSE public."workspace_purge_receipt"."updated_at"
    END;

  RETURN QUERY
  SELECT
    r."id", r."workspace_id", r."idempotency_key", r."status", r."requested_by",
    r."cleanup_manifest", r."db_rows_deleted", r."minio_objects_deleted",
    r."redis_keys_deleted", r."temporal_workflows_cancelled", r."error_code",
    r."rule_version", r."started_at", r."completed_at", r."created_at", r."updated_at"
  FROM public."workspace_purge_receipt" r
  WHERE r."workspace_id" = p_workspace_id;
END
$$;

CREATE FUNCTION public.mark_workspace_purge_running_v1(
  p_workspace_id UUID,
  p_cleanup_manifest JSONB DEFAULT '{}'::jsonb
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_updated BOOLEAN := FALSE;
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
     OR current_user IS NOT DISTINCT FROM session_user
     OR current_setting('role', true) IS DISTINCT FROM 'none'
  THEN
    RAISE EXCEPTION 'WORKSPACE_PURGE_DENIED' USING ERRCODE = '42501';
  END IF;

  IF p_workspace_id IS NULL OR p_workspace_id IS DISTINCT FROM public.current_workspace_id() THEN
    RAISE EXCEPTION 'WORKSPACE_PURGE_WORKSPACE_REQUIRED' USING ERRCODE = '42501';
  END IF;

  UPDATE public."workspace_purge_receipt" r
  SET
    "status" = 'RUNNING',
    "cleanup_manifest" = COALESCE(p_cleanup_manifest, '{}'::jsonb),
    "started_at" = COALESCE(r."started_at", clock_timestamp()),
    "error_code" = NULL,
    "updated_at" = clock_timestamp()
  WHERE r."workspace_id" = p_workspace_id
    AND r."status" <> 'COMPLETED'
  RETURNING TRUE INTO v_updated;

  RETURN COALESCE(v_updated, FALSE);
END
$$;

CREATE FUNCTION public.snapshot_workspace_purge_targets_v1(
  p_workspace_id UUID
)
RETURNS TABLE(
  "workflow_ids" TEXT[],
  "site_ids" UUID[],
  "legacy_release_prefixes" TEXT[],
  "export_object_keys" TEXT[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_wf_ids TEXT[];
  v_site_ids UUID[];
  v_release_prefixes TEXT[];
  v_export_keys TEXT[];
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
     OR current_user IS NOT DISTINCT FROM session_user
     OR current_setting('role', true) IS DISTINCT FROM 'none'
  THEN
    RAISE EXCEPTION 'WORKSPACE_PURGE_DENIED' USING ERRCODE = '42501';
  END IF;

  IF p_workspace_id IS NULL OR p_workspace_id IS DISTINCT FROM public.current_workspace_id() THEN
    RAISE EXCEPTION 'WORKSPACE_PURGE_WORKSPACE_REQUIRED' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(ARRAY_AGG(DISTINCT wf_id), ARRAY[]::TEXT[]) INTO v_wf_ids
  FROM (
    SELECT 'understanding-' || cp."id"::text AS wf_id
      FROM public."company_profile" cp WHERE cp."workspace_id" = p_workspace_id
    UNION ALL
    SELECT 'discovery-' || dr."id"::text
      FROM public."discovery_run" dr WHERE dr."workspace_id" = p_workspace_id
    UNION ALL
    SELECT 'qualify-' || icp."id"::text
      FROM public."icp_definition" icp WHERE icp."workspace_id" = p_workspace_id
    UNION ALL
    SELECT 'deletion-' || dreq."id"::text
      FROM public."deletion_request" dreq WHERE dreq."workspace_id" = p_workspace_id
    UNION ALL
    SELECT 'personal-artifact-cleanup-' || dreq."id"::text
      FROM public."deletion_request" dreq WHERE dreq."workspace_id" = p_workspace_id
    UNION ALL
    SELECT 'site-demo-' || sbr."id"::text
      FROM public."site_build_run" sbr WHERE sbr."workspace_id" = p_workspace_id
    UNION ALL
    SELECT 'site-refurbish-' || sbr."id"::text
      FROM public."site_build_run" sbr WHERE sbr."workspace_id" = p_workspace_id
    UNION ALL
    SELECT sbr."temporal_workflow_id"
      FROM public."site_build_run" sbr
      WHERE sbr."workspace_id" = p_workspace_id AND sbr."temporal_workflow_id" IS NOT NULL
    UNION ALL
    SELECT 'seller-document-' || sd."id"::text
      FROM public."seller_document" sd WHERE sd."workspace_id" = p_workspace_id
    UNION ALL
    SELECT 'data-export-' || dej."id"::text
      FROM public."data_export_job" dej WHERE dej."workspace_id" = p_workspace_id
    UNION ALL
    SELECT oe."id"::text
      FROM public."outbox_event" oe
      WHERE oe."workspace_id" = p_workspace_id
        AND oe."event_type" = 'AssetObjectCleanupRequested'
  ) t
  WHERE wf_id IS NOT NULL AND char_length(trim(wf_id)) > 0;

  SELECT COALESCE(ARRAY_AGG(s."id"), ARRAY[]::UUID[]) INTO v_site_ids
  FROM public."site" s
  WHERE s."workspace_id" = p_workspace_id;

  SELECT COALESCE(ARRAY_AGG(DISTINCT sr."artifact_prefix"), ARRAY[]::TEXT[]) INTO v_release_prefixes
  FROM public."site_release" sr
  WHERE sr."workspace_id" = p_workspace_id
    AND sr."artifact_prefix" LIKE 'sites/%';

  SELECT COALESCE(ARRAY_AGG(DISTINCT dej."object_key"), ARRAY[]::TEXT[]) INTO v_export_keys
  FROM public."data_export_job" dej
  WHERE dej."workspace_id" = p_workspace_id
    AND dej."object_key" IS NOT NULL;

  RETURN QUERY SELECT v_wf_ids, v_site_ids, v_release_prefixes, v_export_keys;
END
$$;

CREATE FUNCTION public.purge_workspace_tenant_data_v1(
  p_workspace_id UUID
)
RETURNS TABLE(
  "db_rows_deleted" JSONB,
  "personal_objects_to_erase" JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_receipt_ok INTEGER;
  v_nonce UUID;
  v_xid TEXT;
  v_pid INTEGER;
  v_counts JSONB := '{}'::jsonb;
  v_rows INTEGER;
  v_rows2 INTEGER;
  v_candidate_keys TEXT[];
  v_personal_objects JSONB := '[]'::jsonb;
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
     OR current_user IS NOT DISTINCT FROM session_user
     OR current_setting('role', true) IS DISTINCT FROM 'none'
  THEN
    RAISE EXCEPTION 'WORKSPACE_PURGE_DENIED' USING ERRCODE = '42501';
  END IF;

  IF p_workspace_id IS NULL OR p_workspace_id IS DISTINCT FROM public.current_workspace_id() THEN
    RAISE EXCEPTION 'WORKSPACE_PURGE_WORKSPACE_REQUIRED' USING ERRCODE = '42501';
  END IF;

  SELECT 1 INTO v_receipt_ok
  FROM public."workspace_purge_receipt" r
  WHERE r."workspace_id" = p_workspace_id
    AND r."status" = 'RUNNING';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WORKSPACE_PURGE_NOT_RUNNING' USING ERRCODE = '42501';
  END IF;

  v_nonce := gen_random_uuid();
  v_pid := pg_backend_pid();
  v_xid := pg_current_xact_id()::text;

  INSERT INTO public."workspace_purge_tx_fence" ("pid", "xid", "target_workspace_id", "nonce")
  VALUES (v_pid, v_xid, p_workspace_id, v_nonce)
  ON CONFLICT ("pid", "xid", "target_workspace_id") DO UPDATE
  SET "nonce" = EXCLUDED."nonce";

  PERFORM set_config('app.workspace_purge_nonce', v_nonce::text, true);

  -- Capture candidate PERSONAL_DATA object keys before deleting generic_operation_artifact
  SELECT COALESCE(ARRAY_AGG(DISTINCT a."object_key"), ARRAY[]::TEXT[])
  INTO v_candidate_keys
  FROM public."generic_operation_artifact" a
  WHERE a."workspace_id" = p_workspace_id
    AND a."privacy_class" = 'PERSONAL_DATA';

  -- Group A: Discovery materialization, raw source, governed subjects, artifacts, budgets
  DELETE FROM public."discovery_company_materialization_outcome" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('discovery_company_materialization_outcome', v_rows); END IF;

  DELETE FROM public."discovery_company_materialization_tx_fence" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('discovery_company_materialization_tx_fence', v_rows); END IF;

  DELETE FROM public."discovery_company_materialization_batch_receipt" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('discovery_company_materialization_batch_receipt', v_rows); END IF;

  DELETE FROM public."discovery_company_materialization_query_receipt" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('discovery_company_materialization_query_receipt', v_rows); END IF;

  DELETE FROM public."discovery_company_materialization_run_receipt" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('discovery_company_materialization_run_receipt', v_rows); END IF;

  DELETE FROM public."discovery_company_materialization_admission" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('discovery_company_materialization_admission', v_rows); END IF;

  DELETE FROM public."discovery_query_execution_outcome" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('discovery_query_execution_outcome', v_rows); END IF;

  DELETE FROM public."discovery_query_attempt_item" WHERE "workspace_id" = p_workspace_id AND "source_record_index" IS NOT NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  DELETE FROM public."discovery_query_attempt_item" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows2 = ROW_COUNT;
  v_rows := v_rows + v_rows2;
  IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('discovery_query_attempt_item', v_rows); END IF;

  DELETE FROM public."discovery_query_operation_attempt" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('discovery_query_operation_attempt', v_rows); END IF;

  DELETE FROM public."discovery_query_receipt" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('discovery_query_receipt', v_rows); END IF;

  DELETE FROM public."raw_source_governance_disposition" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('raw_source_governance_disposition', v_rows); END IF;

  DELETE FROM public."raw_source_field_evidence_cleanup_audit" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('raw_source_field_evidence_cleanup_audit', v_rows); END IF;

  DELETE FROM public."identity_link" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('identity_link', v_rows); END IF;

  DELETE FROM public."field_evidence" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('field_evidence', v_rows); END IF;

  DELETE FROM public."raw_source_record" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('raw_source_record', v_rows); END IF;

  DELETE FROM public."manufacturer_network_evidence" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('manufacturer_network_evidence', v_rows); END IF;

  DELETE FROM public."manufacturer_network_probe" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('manufacturer_network_probe', v_rows); END IF;

  DELETE FROM public."personal_artifact_cleanup_command" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('personal_artifact_cleanup_command', v_rows); END IF;

  DELETE FROM public."generic_operation_artifact_subject_tombstone_audit" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('generic_operation_artifact_subject_tombstone_audit', v_rows); END IF;

  DELETE FROM public."generic_operation_artifact_subject_tombstone" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('generic_operation_artifact_subject_tombstone', v_rows); END IF;

  DELETE FROM public."generic_operation_artifact_subject" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('generic_operation_artifact_subject', v_rows); END IF;

  DELETE FROM public."governed_subject_tombstone_audit" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('governed_subject_tombstone_audit', v_rows); END IF;

  DELETE FROM public."governed_subject_tombstone" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('governed_subject_tombstone', v_rows); END IF;

  DELETE FROM public."governed_subject_relation" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('governed_subject_relation', v_rows); END IF;

  DELETE FROM public."tool_operation_subject" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('tool_operation_subject', v_rows); END IF;

  DELETE FROM public."governed_subject" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('governed_subject', v_rows); END IF;

  DELETE FROM public."generic_operation_artifact" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('generic_operation_artifact', v_rows); END IF;

  -- Prune ONLY unreferenced PERSONAL_DATA objects/versions previously used by this workspace
  IF COALESCE(array_length(v_candidate_keys, 1), 0) > 0 THEN
    SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
    INTO v_personal_objects
    FROM (
      SELECT jsonb_build_object(
        'objectKey', o."object_key",
        'sha256', o."sha256",
        'versionId', COALESCE(
          NULLIF(v."object_version_id", ''),
          NULLIF(o."object_version_id", ''),
          'null'
        ),
        'objectScope', CASE
          WHEN o."object_key" LIKE ('generic-operation-results/v1/final/personal-data/ws/' || p_workspace_id::text || '/%')
            THEN 'workspace'
          ELSE 'legacy_global'
        END
      ) AS item
      FROM public."generic_operation_artifact_object" o
      LEFT JOIN public."generic_operation_artifact_object_version" v
        ON v."object_key" = o."object_key"
      WHERE o."object_key" = ANY(v_candidate_keys)
        AND o."privacy_class" = 'PERSONAL_DATA'
        AND NOT EXISTS (
          SELECT 1 FROM public."generic_operation_artifact" a
          WHERE a."object_key" = o."object_key"
        )
    ) sub;

    DELETE FROM public."generic_operation_artifact_object_version" v
    USING public."generic_operation_artifact_object" o
    WHERE v."object_key" = o."object_key"
      AND o."object_key" = ANY(v_candidate_keys)
      AND o."privacy_class" = 'PERSONAL_DATA'
      AND NOT EXISTS (
        SELECT 1 FROM public."generic_operation_artifact" a
        WHERE a."object_key" = o."object_key"
      );
    GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('generic_operation_artifact_object_version', v_rows); END IF;

    DELETE FROM public."generic_operation_artifact_object" o
    WHERE o."object_key" = ANY(v_candidate_keys)
      AND o."privacy_class" = 'PERSONAL_DATA'
      AND NOT EXISTS (
        SELECT 1 FROM public."generic_operation_artifact" a
        WHERE a."object_key" = o."object_key"
      );
    GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('generic_operation_artifact_object', v_rows); END IF;
  END IF;

  DELETE FROM public."contact_enrichment_execution_step" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('contact_enrichment_execution_step', v_rows); END IF;

  DELETE FROM public."contact_enrichment_execution" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('contact_enrichment_execution', v_rows); END IF;

  DELETE FROM public."execution_domain_ack" WHERE "scope_key" = p_workspace_id::text;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('execution_domain_ack', v_rows); END IF;

  DELETE FROM public."tool_budget_operation" WHERE "scope_key" = p_workspace_id::text;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('tool_budget_operation', v_rows); END IF;

  DELETE FROM public."market_candidate_generation_head" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('market_candidate_generation_head', v_rows); END IF;

  UPDATE public."market_candidate_generation"
  SET "active_attempt_id" = NULL
  WHERE "workspace_id" = p_workspace_id AND "active_attempt_id" IS NOT NULL;

  DELETE FROM public."market_candidate_generation_attempt" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('market_candidate_generation_attempt', v_rows); END IF;

  DELETE FROM public."market_candidate_generation" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('market_candidate_generation', v_rows); END IF;

  DELETE FROM public."market_candidate_feedback" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('market_candidate_feedback', v_rows); END IF;

  DELETE FROM public."market_candidate_set" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('market_candidate_set', v_rows); END IF;

  DELETE FROM public."market_candidate_set_revision" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('market_candidate_set_revision', v_rows); END IF;

  DELETE FROM public."execution_budget_authority_revocation" WHERE "scope_key" = p_workspace_id::text;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('execution_budget_authority_revocation', v_rows); END IF;

  DELETE FROM public."tool_budget_account" WHERE "scope_key" = p_workspace_id::text;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('tool_budget_account', v_rows); END IF;

  DELETE FROM public."execution_budget_authority" WHERE "workspace_id" = p_workspace_id OR "scope_key" = p_workspace_id::text;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('execution_budget_authority', v_rows); END IF;

  -- Group B: Site Builder (leaves -> site)
  DELETE FROM public."site_build_provider_readback_probe_observation" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('site_build_provider_readback_probe_observation', v_rows); END IF;

  DELETE FROM public."site_build_provider_readback_probe" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('site_build_provider_readback_probe', v_rows); END IF;

  DELETE FROM public."site_build_provider_wire_receipt" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('site_build_provider_wire_receipt', v_rows); END IF;

  DELETE FROM public."site_build_provider_wire_attempt" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('site_build_provider_wire_attempt', v_rows); END IF;

  DELETE FROM public."site_build_spend_reconciliation" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('site_build_spend_reconciliation', v_rows); END IF;

  DELETE FROM public."site_build_spend" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('site_build_spend', v_rows); END IF;

  DELETE FROM public."site_copy_bundle" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('site_copy_bundle', v_rows); END IF;

  DELETE FROM public."site_publishable_claim_snapshot_item" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('site_publishable_claim_snapshot_item', v_rows); END IF;

  DELETE FROM public."site_publishable_claim_snapshot" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('site_publishable_claim_snapshot', v_rows); END IF;

  DELETE FROM public."brand_profile_claim_bridge" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('brand_profile_claim_bridge', v_rows); END IF;

  DELETE FROM public."brand_profile_evidence_ref" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('brand_profile_evidence_ref', v_rows); END IF;

  DELETE FROM public."brand_profile" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('brand_profile', v_rows); END IF;

  DELETE FROM public."site_evidence_source_snapshot" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('site_evidence_source_snapshot', v_rows); END IF;

  DELETE FROM public."site_release" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('site_release', v_rows); END IF;

  DELETE FROM public."site_build_budget_grant" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('site_build_budget_grant', v_rows); END IF;

  DELETE FROM public."site_build_budget" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('site_build_budget', v_rows); END IF;

  DELETE FROM public."site_build_step" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('site_build_step', v_rows); END IF;

  DELETE FROM public."site_build_task_attempt" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('site_build_task_attempt', v_rows); END IF;

  DELETE FROM public."site_build_run" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('site_build_run', v_rows); END IF;

  DELETE FROM public."kb_chunk" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('kb_chunk', v_rows); END IF;

  DELETE FROM public."kb_document" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('kb_document', v_rows); END IF;

  v_rows := 0;
  LOOP
    DELETE FROM public."asset_variant" av
    WHERE av."workspace_id" = p_workspace_id
      AND NOT EXISTS (
        SELECT 1 FROM public."asset_variant" child
        WHERE child."source_variant_id" = av."id"
      );
    GET DIAGNOSTICS v_rows2 = ROW_COUNT;
    EXIT WHEN v_rows2 = 0;
    v_rows := v_rows + v_rows2;
  END LOOP;
  IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('asset_variant', v_rows); END IF;

  DELETE FROM public."asset" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('asset', v_rows); END IF;

  UPDATE public."site" SET "active_version_id" = NULL
  WHERE "workspace_id" = p_workspace_id AND "active_version_id" IS NOT NULL;

  DELETE FROM public."site_version" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('site_version', v_rows); END IF;

  DELETE FROM public."site" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('site', v_rows); END IF;

  -- Group C: Leads, Judgment, Evaluation, ICP, Discovery, Canonical Buyer/Contact, Compliance
  DELETE FROM public."lead_outreach_draft" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('lead_outreach_draft', v_rows); END IF;

  DELETE FROM public."lead_outcome" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('lead_outcome', v_rows); END IF;

  DELETE FROM public."lead_decision" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('lead_decision', v_rows); END IF;

  DELETE FROM public."lead" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('lead', v_rows); END IF;

  DELETE FROM public."judgment_golden_label" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('judgment_golden_label', v_rows); END IF;

  DELETE FROM public."judgment_review_task" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('judgment_review_task', v_rows); END IF;

  DELETE FROM public."judgment_record" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('judgment_record', v_rows); END IF;

  DELETE FROM public."evaluation_label" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('evaluation_label', v_rows); END IF;

  DELETE FROM public."evaluation_set" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('evaluation_set', v_rows); END IF;

  DELETE FROM public."gate_enrichment_task" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('gate_enrichment_task', v_rows); END IF;

  DELETE FROM public."hard_gate_result" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('hard_gate_result', v_rows); END IF;

  DELETE FROM public."sanctions_screening_result" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('sanctions_screening_result', v_rows); END IF;

  DELETE FROM public."domain_review_task" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('domain_review_task', v_rows); END IF;

  DELETE FROM public."company_domain_resolution" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('company_domain_resolution', v_rows); END IF;

  DELETE FROM public."company_signal" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('company_signal', v_rows); END IF;

  DELETE FROM public."company_legal_link" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('company_legal_link', v_rows); END IF;

  DELETE FROM public."legal_entity" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('legal_entity', v_rows); END IF;

  DELETE FROM public."company_channel_sighting" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('company_channel_sighting', v_rows); END IF;

  DELETE FROM public."company_contact_channel" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('company_contact_channel', v_rows); END IF;

  DELETE FROM public."company_contact_point" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('company_contact_point', v_rows); END IF;

  DELETE FROM public."contact_enrichment_attempt" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('contact_enrichment_attempt', v_rows); END IF;

  DELETE FROM public."contact_point_verification_event" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('contact_point_verification_event', v_rows); END IF;

  DELETE FROM public."contact_point" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('contact_point', v_rows); END IF;

  DELETE FROM public."canonical_contact" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('canonical_contact', v_rows); END IF;

  DELETE FROM public."canonical_company" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('canonical_company', v_rows); END IF;

  DELETE FROM public."contact_metrics_snapshot" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('contact_metrics_snapshot', v_rows); END IF;

  DELETE FROM public."discovery_company_job" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('discovery_company_job', v_rows); END IF;

  DELETE FROM public."discovery_run" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('discovery_run', v_rows); END IF;

  DELETE FROM public."discovery_query_plan" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('discovery_query_plan', v_rows); END IF;

  DELETE FROM public."icp_query_performance" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('icp_query_performance', v_rows); END IF;

  DELETE FROM public."icp_feedback" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('icp_feedback', v_rows); END IF;

  DELETE FROM public."icp_backtest" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('icp_backtest', v_rows); END IF;

  DELETE FROM public."qualification_rule" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('qualification_rule', v_rows); END IF;

  DELETE FROM public."buying_committee_role" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('buying_committee_role', v_rows); END IF;

  DELETE FROM public."persona" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('persona', v_rows); END IF;

  DELETE FROM public."icp_definition" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('icp_definition', v_rows); END IF;

  DELETE FROM public."deletion_receipt" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('deletion_receipt', v_rows); END IF;

  DELETE FROM public."deletion_request" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('deletion_request', v_rows); END IF;

  DELETE FROM public."suppression_decision" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('suppression_decision', v_rows); END IF;

  DELETE FROM public."suppression_record" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('suppression_record', v_rows); END IF;

  DELETE FROM public."article14_notice" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('article14_notice', v_rows); END IF;

  DELETE FROM public."personal_data_access_audit" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('personal_data_access_audit', v_rows); END IF;

  DELETE FROM public."lia_record" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('lia_record', v_rows); END IF;

  DELETE FROM public."policy_decision_log" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('policy_decision_log', v_rows); END IF;

  -- Group D: Seller Knowledge, Claims, CompanyProfile
  DELETE FROM public."claim_document_evidence" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('claim_document_evidence', v_rows); END IF;

  DELETE FROM public."knowledge_conflict" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('knowledge_conflict', v_rows); END IF;

  DELETE FROM public."citation" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('citation', v_rows); END IF;

  DELETE FROM public."evidence" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('evidence', v_rows); END IF;

  DELETE FROM public."claim" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('claim', v_rows); END IF;

  DELETE FROM public."knowledge_source" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('knowledge_source', v_rows); END IF;

  DELETE FROM public."seller_document_chunk" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('seller_document_chunk', v_rows); END IF;

  DELETE FROM public."seller_document" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('seller_document', v_rows); END IF;

  DELETE FROM public."offering" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('offering', v_rows); END IF;

  DELETE FROM public."company_profile" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('company_profile', v_rows); END IF;

  -- Group E: Exports, AI/Skills/Packs, Cache, Metrics, Outbox, Channels, Misc
  DELETE FROM public."data_export_job" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('data_export_job', v_rows); END IF;

  DELETE FROM public."agent_decision_trace" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('agent_decision_trace', v_rows); END IF;

  DELETE FROM public."skill_resolution_snapshot" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('skill_resolution_snapshot', v_rows); END IF;

  DELETE FROM public."skill_enablement" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('skill_enablement', v_rows); END IF;

  DELETE FROM public."skill_version" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('skill_version', v_rows); END IF;

  DELETE FROM public."skill_package" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('skill_package', v_rows); END IF;

  DELETE FROM public."pack_enablement" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('pack_enablement', v_rows); END IF;

  DELETE FROM public."pack_activation" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('pack_activation', v_rows); END IF;

  DELETE FROM public."strategy_resolution_snapshot" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('strategy_resolution_snapshot', v_rows); END IF;

  DELETE FROM public."source_channel_enablement" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('source_channel_enablement', v_rows); END IF;

  DELETE FROM public."source_yield_ledger" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('source_yield_ledger', v_rows); END IF;

  DELETE FROM public."coverage_estimate" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('coverage_estimate', v_rows); END IF;

  DELETE FROM public."imported_buyer" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('imported_buyer', v_rows); END IF;

  DELETE FROM public."mem_knowledge_stat" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('mem_knowledge_stat', v_rows); END IF;

  DELETE FROM public."mem_run_episode" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('mem_run_episode', v_rows); END IF;

  DELETE FROM public."run_event" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('run_event', v_rows); END IF;

  DELETE FROM public."run_shadow_diff" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('run_shadow_diff', v_rows); END IF;

  DELETE FROM public."url_content_cache" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('url_content_cache', v_rows); END IF;

  DELETE FROM public."llm_extraction_cache" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('llm_extraction_cache', v_rows); END IF;

  DELETE FROM public."ai_trace" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('ai_trace', v_rows); END IF;

  DELETE FROM public."usage_ledger" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('usage_ledger', v_rows); END IF;

  DELETE FROM public."idempotency_key" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('idempotency_key', v_rows); END IF;

  DELETE FROM public."outbox_delivery" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('outbox_delivery', v_rows); END IF;

  DELETE FROM public."outbox_event" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('outbox_event', v_rows); END IF;

  DELETE FROM public."metric_observation" WHERE "workspace_id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('metric_observation', v_rows); END IF;

  DELETE FROM public."metric_rollup_daily" WHERE "stratum"->>'workspace_id' = p_workspace_id::text;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('metric_rollup_daily', v_rows); END IF;

  DELETE FROM public."metric_rollup_weekly" WHERE "stratum"->>'workspace_id' = p_workspace_id::text;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('metric_rollup_weekly', v_rows); END IF;

  -- Clear workspace provenance reference on shared platform source_channel_run rows
  UPDATE public."source_channel_run"
  SET "triggered_by_workspace_id" = NULL
  WHERE "triggered_by_workspace_id" = p_workspace_id;

  -- Group F: Root workspace
  DELETE FROM public."workspace" WHERE "id" = p_workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; IF v_rows > 0 THEN v_counts := v_counts || jsonb_build_object('workspace', v_rows); END IF;

  -- Release transaction fence
  DELETE FROM public."workspace_purge_tx_fence"
  WHERE "pid" = v_pid
    AND "xid" = v_xid
    AND "target_workspace_id" = p_workspace_id;

  RETURN QUERY SELECT v_counts, COALESCE(v_personal_objects, '[]'::jsonb);
END
$$;

CREATE FUNCTION public.complete_workspace_purge_v1(
  p_workspace_id UUID,
  p_db_rows_deleted JSONB,
  p_minio_objects_deleted JSONB,
  p_redis_keys_deleted INTEGER,
  p_temporal_workflows_cancelled INTEGER
)
RETURNS TABLE(
  "id" UUID,
  "workspace_id" UUID,
  "idempotency_key" VARCHAR(128),
  "status" VARCHAR(16),
  "requested_by" UUID,
  "cleanup_manifest" JSONB,
  "db_rows_deleted" JSONB,
  "minio_objects_deleted" JSONB,
  "redis_keys_deleted" INTEGER,
  "temporal_workflows_cancelled" INTEGER,
  "error_code" VARCHAR(120),
  "rule_version" VARCHAR(64),
  "started_at" TIMESTAMPTZ(3),
  "completed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3),
  "updated_at" TIMESTAMPTZ(3)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
     OR current_user IS NOT DISTINCT FROM session_user
     OR current_setting('role', true) IS DISTINCT FROM 'none'
  THEN
    RAISE EXCEPTION 'WORKSPACE_PURGE_DENIED' USING ERRCODE = '42501';
  END IF;

  IF p_workspace_id IS NULL OR p_workspace_id IS DISTINCT FROM public.current_workspace_id() THEN
    RAISE EXCEPTION 'WORKSPACE_PURGE_WORKSPACE_REQUIRED' USING ERRCODE = '42501';
  END IF;

  UPDATE public."workspace_purge_receipt" r
  SET
    "status" = 'COMPLETED',
    "db_rows_deleted" = COALESCE(p_db_rows_deleted, '{}'::jsonb),
    "minio_objects_deleted" = COALESCE(p_minio_objects_deleted, '{}'::jsonb),
    "redis_keys_deleted" = GREATEST(COALESCE(p_redis_keys_deleted, 0), 0),
    "temporal_workflows_cancelled" = GREATEST(COALESCE(p_temporal_workflows_cancelled, 0), 0),
    "error_code" = NULL,
    "completed_at" = COALESCE(r."completed_at", clock_timestamp()),
    "updated_at" = clock_timestamp()
  WHERE r."workspace_id" = p_workspace_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WORKSPACE_PURGE_RECEIPT_MISSING' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT
    r."id", r."workspace_id", r."idempotency_key", r."status", r."requested_by",
    r."cleanup_manifest", r."db_rows_deleted", r."minio_objects_deleted",
    r."redis_keys_deleted", r."temporal_workflows_cancelled", r."error_code",
    r."rule_version", r."started_at", r."completed_at", r."created_at", r."updated_at"
  FROM public."workspace_purge_receipt" r
  WHERE r."workspace_id" = p_workspace_id;
END
$$;

CREATE FUNCTION public.fail_workspace_purge_v1(
  p_workspace_id UUID,
  p_error_code VARCHAR(120)
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF session_user IS DISTINCT FROM 'app_user'
     OR current_user IS NOT DISTINCT FROM session_user
     OR current_setting('role', true) IS DISTINCT FROM 'none'
  THEN
    RAISE EXCEPTION 'WORKSPACE_PURGE_DENIED' USING ERRCODE = '42501';
  END IF;

  IF p_workspace_id IS NULL OR p_workspace_id IS DISTINCT FROM public.current_workspace_id() THEN
    RAISE EXCEPTION 'WORKSPACE_PURGE_WORKSPACE_REQUIRED' USING ERRCODE = '42501';
  END IF;

  UPDATE public."workspace_purge_receipt" r
  SET
    "status" = 'FAILED',
    "error_code" = left(COALESCE(NULLIF(trim(p_error_code), ''), 'WORKSPACE_PURGE_FAILED'), 120),
    "updated_at" = clock_timestamp()
  WHERE r."workspace_id" = p_workspace_id
    AND r."status" <> 'COMPLETED';
END
$$;

REVOKE ALL ON FUNCTION public.begin_workspace_purge_v1(UUID, VARCHAR, UUID)
  FROM PUBLIC, app_user, execution_budget_platform_writer, runtime_api, runtime_worker, runtime_outbox_relay, runtime_platform_worker, runtime_outbox_relay_worker, runtime_memory_outbox_reader, runtime_customer_worker_ops;
GRANT EXECUTE ON FUNCTION public.begin_workspace_purge_v1(UUID, VARCHAR, UUID) TO app_user;

REVOKE ALL ON FUNCTION public.mark_workspace_purge_running_v1(UUID, JSONB)
  FROM PUBLIC, app_user, execution_budget_platform_writer, runtime_api, runtime_worker, runtime_outbox_relay, runtime_platform_worker, runtime_outbox_relay_worker, runtime_memory_outbox_reader, runtime_customer_worker_ops;
GRANT EXECUTE ON FUNCTION public.mark_workspace_purge_running_v1(UUID, JSONB) TO app_user;

REVOKE ALL ON FUNCTION public.snapshot_workspace_purge_targets_v1(UUID)
  FROM PUBLIC, app_user, execution_budget_platform_writer, runtime_api, runtime_worker, runtime_outbox_relay, runtime_platform_worker, runtime_outbox_relay_worker, runtime_memory_outbox_reader, runtime_customer_worker_ops;
GRANT EXECUTE ON FUNCTION public.snapshot_workspace_purge_targets_v1(UUID) TO app_user;

REVOKE ALL ON FUNCTION public.purge_workspace_tenant_data_v1(UUID)
  FROM PUBLIC, app_user, execution_budget_platform_writer, runtime_api, runtime_worker, runtime_outbox_relay, runtime_platform_worker, runtime_outbox_relay_worker, runtime_memory_outbox_reader, runtime_customer_worker_ops;
GRANT EXECUTE ON FUNCTION public.purge_workspace_tenant_data_v1(UUID) TO app_user;

REVOKE ALL ON FUNCTION public.complete_workspace_purge_v1(UUID, JSONB, JSONB, INTEGER, INTEGER)
  FROM PUBLIC, app_user, execution_budget_platform_writer, runtime_api, runtime_worker, runtime_outbox_relay, runtime_platform_worker, runtime_outbox_relay_worker, runtime_memory_outbox_reader, runtime_customer_worker_ops;
GRANT EXECUTE ON FUNCTION public.complete_workspace_purge_v1(UUID, JSONB, JSONB, INTEGER, INTEGER) TO app_user;

REVOKE ALL ON FUNCTION public.fail_workspace_purge_v1(UUID, VARCHAR)
  FROM PUBLIC, app_user, execution_budget_platform_writer, runtime_api, runtime_worker, runtime_outbox_relay, runtime_platform_worker, runtime_outbox_relay_worker, runtime_memory_outbox_reader, runtime_customer_worker_ops;
GRANT EXECUTE ON FUNCTION public.fail_workspace_purge_v1(UUID, VARCHAR) TO app_user;

COMMIT;
