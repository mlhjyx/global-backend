-- M4 Deliverable A: scoped NOLOGIN runtime principals (NOSUPERUSER NOBYPASSRLS)
-- for OutboxRelayService, MemoryEpisodeConsumer, Temporal customer worker ops,
-- and platform-worker workspace enumeration + patent audit/policy reads.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL row_security = off;

DO $$
DECLARE
  missing_role BOOLEAN;
  can_create_role BOOLEAN;
  group_name TEXT;
  group_role pg_roles%ROWTYPE;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('runtime_outbox_relay_worker'),
        ('runtime_memory_outbox_reader'),
        ('runtime_customer_worker_ops')
    ) AS required(role_name)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_roles WHERE rolname = required.role_name
    )
  ) INTO missing_role;

  SELECT rolsuper OR rolcreaterole INTO can_create_role
  FROM pg_roles
  WHERE rolname = current_user;

  IF missing_role AND NOT COALESCE(can_create_role, false) THEN
    RAISE EXCEPTION 'RUNTIME_SCOPED_PRINCIPALS_MIGRATION_REQUIRES_CREATEROLE';
  END IF;

  FOREACH group_name IN ARRAY ARRAY[
    'runtime_outbox_relay_worker',
    'runtime_memory_outbox_reader',
    'runtime_customer_worker_ops'
  ]
  LOOP
    SELECT * INTO group_role FROM pg_roles WHERE rolname = group_name;
    IF group_role.oid IS NULL THEN
      EXECUTE format(
        'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
        group_name
      );
    ELSIF group_role.rolcanlogin
      OR group_role.rolsuper
      OR group_role.rolbypassrls
      OR group_role.rolcreaterole
      OR group_role.rolcreatedb
      OR group_role.rolreplication
      OR EXISTS (
        SELECT 1
        FROM pg_auth_members membership
        WHERE membership.member = group_role.oid
      )
    THEN
      RAISE EXCEPTION 'RUNTIME_SCOPED_PRINCIPAL_GROUP_INVALID: %', group_name;
    END IF;

    IF pg_has_role('app_user', group_name, 'member') THEN
      RAISE EXCEPTION 'RUNTIME_SCOPED_PRINCIPAL_APP_MEMBERSHIP_INVALID: %', group_name;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 1) runtime_outbox_relay_worker (OUTBOX_RELAY_DATABASE_URL)
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO runtime_outbox_relay_worker;
GRANT SELECT ON TABLE "_prisma_migrations" TO runtime_outbox_relay_worker;
GRANT SELECT, INSERT, UPDATE ON TABLE "outbox_event", "outbox_delivery" TO runtime_outbox_relay_worker;
GRANT USAGE, SELECT ON SEQUENCE "outbox_event_id_seq", "outbox_delivery_id_seq" TO runtime_outbox_relay_worker;
GRANT SELECT, UPDATE ON TABLE "claim" TO runtime_outbox_relay_worker;
-- Read-only startup catalog presence checks (no write privileges granted).
GRANT SELECT ON TABLE
  "data_provider",
  "source_policy",
  "sanctions_source",
  "skill_package",
  "skill_version",
  "pack_package",
  "pack_version",
  "pack_activation",
  "agent_profile"
TO runtime_outbox_relay_worker;

CREATE POLICY "outbox_event_outbox_relay_worker_select"
  ON "outbox_event" FOR SELECT TO runtime_outbox_relay_worker USING (true);
CREATE POLICY "outbox_event_outbox_relay_worker_insert"
  ON "outbox_event" FOR INSERT TO runtime_outbox_relay_worker WITH CHECK (true);
CREATE POLICY "outbox_event_outbox_relay_worker_update"
  ON "outbox_event" FOR UPDATE TO runtime_outbox_relay_worker USING (true) WITH CHECK (true);

CREATE POLICY "outbox_delivery_outbox_relay_worker_select"
  ON "outbox_delivery" FOR SELECT TO runtime_outbox_relay_worker USING (true);
CREATE POLICY "outbox_delivery_outbox_relay_worker_insert"
  ON "outbox_delivery" FOR INSERT TO runtime_outbox_relay_worker WITH CHECK (true);
CREATE POLICY "outbox_delivery_outbox_relay_worker_update"
  ON "outbox_delivery" FOR UPDATE TO runtime_outbox_relay_worker USING (true) WITH CHECK (true);

CREATE POLICY "claim_outbox_relay_worker_select"
  ON "claim" FOR SELECT TO runtime_outbox_relay_worker USING (true);
CREATE POLICY "claim_outbox_relay_worker_update"
  ON "claim" FOR UPDATE TO runtime_outbox_relay_worker USING (true) WITH CHECK (true);

CREATE POLICY "skill_package_outbox_relay_worker_select"
  ON "skill_package" FOR SELECT TO runtime_outbox_relay_worker USING (true);
CREATE POLICY "skill_version_outbox_relay_worker_select"
  ON "skill_version" FOR SELECT TO runtime_outbox_relay_worker USING (true);
CREATE POLICY "pack_package_outbox_relay_worker_select"
  ON "pack_package" FOR SELECT TO runtime_outbox_relay_worker USING (true);
CREATE POLICY "pack_version_outbox_relay_worker_select"
  ON "pack_version" FOR SELECT TO runtime_outbox_relay_worker USING (true);
CREATE POLICY "pack_activation_outbox_relay_worker_select"
  ON "pack_activation" FOR SELECT TO runtime_outbox_relay_worker USING (true);
CREATE POLICY "agent_profile_outbox_relay_worker_select"
  ON "agent_profile" FOR SELECT TO runtime_outbox_relay_worker USING (true);

-- ---------------------------------------------------------------------------
-- 2) runtime_memory_outbox_reader (MEMORY_OUTBOX_DATABASE_URL)
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO runtime_memory_outbox_reader;
GRANT SELECT ON TABLE "outbox_event" TO runtime_memory_outbox_reader;
CREATE POLICY "outbox_event_memory_outbox_reader_select"
  ON "outbox_event" FOR SELECT TO runtime_memory_outbox_reader USING (true);

-- ---------------------------------------------------------------------------
-- 3) runtime_customer_worker_ops (CUSTOMER_WORKER_OPS_DATABASE_URL)
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO runtime_customer_worker_ops;

GRANT SELECT ON TABLE
  "data_provider",
  "icp_definition",
  "discovery_query_plan",
  "asset",
  "site",
  "site_build_provider_wire_attempt",
  "site_build_spend",
  "site_build_spend_reconciliation",
  "suppression_record",
  "canonical_company",
  "canonical_contact",
  "lead",
  "contact_enrichment_attempt",
  "field_evidence",
  "raw_source_record",
  "source_signal"
TO runtime_customer_worker_ops;

GRANT SELECT, UPDATE ON TABLE
  "site_release",
  "contact_point"
TO runtime_customer_worker_ops;

GRANT SELECT, INSERT ON TABLE
  "contact_point_verification_event",
  "contact_metrics_snapshot",
  "metric_observation"
TO runtime_customer_worker_ops;

GRANT SELECT, INSERT, UPDATE ON TABLE
  "metric_rollup_daily",
  "metric_rollup_weekly"
TO runtime_customer_worker_ops;

CREATE POLICY "icp_definition_customer_worker_ops_select"
  ON "icp_definition" FOR SELECT TO runtime_customer_worker_ops USING (true);
CREATE POLICY "discovery_query_plan_customer_worker_ops_select"
  ON "discovery_query_plan" FOR SELECT TO runtime_customer_worker_ops USING (true);
CREATE POLICY "asset_customer_worker_ops_select"
  ON "asset" FOR SELECT TO runtime_customer_worker_ops USING (true);
CREATE POLICY "site_customer_worker_ops_select"
  ON "site" FOR SELECT TO runtime_customer_worker_ops USING (true);
CREATE POLICY "site_build_wire_attempt_customer_worker_ops_select"
  ON "site_build_provider_wire_attempt" FOR SELECT TO runtime_customer_worker_ops USING (true);
CREATE POLICY "site_build_spend_customer_worker_ops_select"
  ON "site_build_spend" FOR SELECT TO runtime_customer_worker_ops USING (true);
CREATE POLICY "site_build_spend_recon_customer_worker_ops_select"
  ON "site_build_spend_reconciliation" FOR SELECT TO runtime_customer_worker_ops USING (true);
CREATE POLICY "suppression_record_customer_worker_ops_select"
  ON "suppression_record" FOR SELECT TO runtime_customer_worker_ops USING (true);
CREATE POLICY "canonical_company_customer_worker_ops_select"
  ON "canonical_company" FOR SELECT TO runtime_customer_worker_ops USING (true);
CREATE POLICY "canonical_contact_customer_worker_ops_select"
  ON "canonical_contact" FOR SELECT TO runtime_customer_worker_ops USING (true);
CREATE POLICY "lead_customer_worker_ops_select"
  ON "lead" FOR SELECT TO runtime_customer_worker_ops USING (true);
CREATE POLICY "contact_enrichment_attempt_customer_worker_ops_select"
  ON "contact_enrichment_attempt" FOR SELECT TO runtime_customer_worker_ops USING (true);
CREATE POLICY "field_evidence_customer_worker_ops_select"
  ON "field_evidence" FOR SELECT TO runtime_customer_worker_ops USING (true);
CREATE POLICY "raw_source_record_customer_worker_ops_select"
  ON "raw_source_record" FOR SELECT TO runtime_customer_worker_ops USING (true);

CREATE POLICY "site_release_customer_worker_ops_select"
  ON "site_release" FOR SELECT TO runtime_customer_worker_ops USING (true);
CREATE POLICY "site_release_customer_worker_ops_update"
  ON "site_release" FOR UPDATE TO runtime_customer_worker_ops USING (true) WITH CHECK (true);

CREATE POLICY "contact_point_customer_worker_ops_select"
  ON "contact_point" FOR SELECT TO runtime_customer_worker_ops USING (true);
CREATE POLICY "contact_point_customer_worker_ops_update"
  ON "contact_point" FOR UPDATE TO runtime_customer_worker_ops USING (true) WITH CHECK (true);

CREATE POLICY "cpve_customer_worker_ops_select"
  ON "contact_point_verification_event" FOR SELECT TO runtime_customer_worker_ops USING (true);
CREATE POLICY "cpve_customer_worker_ops_insert"
  ON "contact_point_verification_event" FOR INSERT TO runtime_customer_worker_ops WITH CHECK (true);

CREATE POLICY "cms_customer_worker_ops_select"
  ON "contact_metrics_snapshot" FOR SELECT TO runtime_customer_worker_ops USING (true);
CREATE POLICY "cms_customer_worker_ops_insert"
  ON "contact_metrics_snapshot" FOR INSERT TO runtime_customer_worker_ops WITH CHECK (true);

CREATE POLICY "metric_observation_customer_worker_ops_select"
  ON "metric_observation" FOR SELECT TO runtime_customer_worker_ops USING (true);
CREATE POLICY "metric_observation_customer_worker_ops_insert"
  ON "metric_observation" FOR INSERT TO runtime_customer_worker_ops WITH CHECK (true);

CREATE POLICY "metric_rollup_daily_customer_worker_ops_select"
  ON "metric_rollup_daily" FOR SELECT TO runtime_customer_worker_ops USING (true);
CREATE POLICY "metric_rollup_daily_customer_worker_ops_insert"
  ON "metric_rollup_daily" FOR INSERT TO runtime_customer_worker_ops WITH CHECK (true);
CREATE POLICY "metric_rollup_daily_customer_worker_ops_update"
  ON "metric_rollup_daily" FOR UPDATE TO runtime_customer_worker_ops USING (true) WITH CHECK (true);

CREATE POLICY "metric_rollup_weekly_customer_worker_ops_select"
  ON "metric_rollup_weekly" FOR SELECT TO runtime_customer_worker_ops USING (true);
CREATE POLICY "metric_rollup_weekly_customer_worker_ops_insert"
  ON "metric_rollup_weekly" FOR INSERT TO runtime_customer_worker_ops WITH CHECK (true);
CREATE POLICY "metric_rollup_weekly_customer_worker_ops_update"
  ON "metric_rollup_weekly" FOR UPDATE TO runtime_customer_worker_ops USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 4) execution_budget_platform_writer expansions for platform-worker.ts
-- ---------------------------------------------------------------------------
GRANT INSERT ON TABLE "patent_cache_refresh_audit" TO execution_budget_platform_writer;
GRANT SELECT ON TABLE "data_provider", "source_policy" TO execution_budget_platform_writer;

CREATE FUNCTION public.list_platform_workspace_ids_v1()
RETURNS TABLE(id UUID)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM public.assert_execution_budget_platform_writer_principal();
  RETURN QUERY
    SELECT w."id"
    FROM public."workspace" w
    ORDER BY w."id" ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.list_platform_workspace_ids_v1()
  FROM PUBLIC,
       app_user,
       runtime_api,
       runtime_worker,
       runtime_outbox_relay,
       runtime_platform_worker,
       runtime_outbox_relay_worker,
       runtime_memory_outbox_reader,
       runtime_customer_worker_ops;

GRANT EXECUTE ON FUNCTION public.list_platform_workspace_ids_v1()
  TO execution_budget_platform_writer;

-- ---------------------------------------------------------------------------
-- 5) Migration privilege self-checks (fail-closed)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  forbidden_table TEXT;
BEGIN
  IF has_table_privilege('runtime_outbox_relay_worker', 'public.outbox_event', 'DELETE')
     OR has_table_privilege('runtime_outbox_relay_worker', 'public.outbox_delivery', 'DELETE')
     OR has_table_privilege('runtime_outbox_relay_worker', 'public.claim', 'INSERT')
     OR has_table_privilege('runtime_outbox_relay_worker', 'public.claim', 'DELETE')
     OR has_table_privilege('runtime_outbox_relay_worker', 'public.source_policy', 'INSERT')
     OR has_table_privilege('runtime_outbox_relay_worker', 'public.source_policy', 'UPDATE')
     OR has_table_privilege('runtime_outbox_relay_worker', 'public.data_provider', 'INSERT')
     OR has_table_privilege('runtime_outbox_relay_worker', 'public.data_provider', 'UPDATE')
  THEN
    RAISE EXCEPTION 'RUNTIME_OUTBOX_RELAY_WORKER_EXCESS_PRIVILEGES';
  END IF;

  IF has_table_privilege('runtime_memory_outbox_reader', 'public.outbox_event', 'INSERT')
     OR has_table_privilege('runtime_memory_outbox_reader', 'public.outbox_event', 'UPDATE')
     OR has_table_privilege('runtime_memory_outbox_reader', 'public.outbox_event', 'DELETE')
     OR has_table_privilege('runtime_memory_outbox_reader', 'public.outbox_delivery', 'SELECT')
  THEN
    RAISE EXCEPTION 'RUNTIME_MEMORY_OUTBOX_READER_EXCESS_PRIVILEGES';
  END IF;

  FOREACH forbidden_table IN ARRAY ARRAY[
    'public.outbox_event',
    'public.outbox_delivery',
    'public.deletion_request',
    'public.lia_record',
    'public.policy_decision_log',
    'public.execution_budget_authority',
    'public.execution_budget_authority_revocation',
    'public.tool_budget_account',
    'public.tool_budget_operation',
    'public.site_build_budget_grant',
    'public.seller_document',
    'public.seller_document_chunk',
    'public.source_policy'
  ]
  LOOP
    IF has_table_privilege('runtime_customer_worker_ops', forbidden_table, 'SELECT')
       OR has_table_privilege('runtime_customer_worker_ops', forbidden_table, 'INSERT')
       OR has_table_privilege('runtime_customer_worker_ops', forbidden_table, 'UPDATE')
       OR has_table_privilege('runtime_customer_worker_ops', forbidden_table, 'DELETE')
    THEN
      RAISE EXCEPTION 'RUNTIME_CUSTOMER_WORKER_OPS_FORBIDDEN_TABLE_ACCESS: %', forbidden_table;
    END IF;
  END LOOP;

  IF has_table_privilege('runtime_customer_worker_ops', 'public.data_provider', 'INSERT')
     OR has_table_privilege('runtime_customer_worker_ops', 'public.data_provider', 'UPDATE')
     OR has_table_privilege('runtime_customer_worker_ops', 'public.data_provider', 'DELETE')
     OR has_table_privilege('runtime_customer_worker_ops', 'public.signal_ingest', 'INSERT')
     OR has_table_privilege('runtime_customer_worker_ops', 'public.signal_ingest', 'UPDATE')
     OR has_table_privilege('runtime_customer_worker_ops', 'public.signal_ingest', 'DELETE')
     OR has_table_privilege('runtime_customer_worker_ops', 'public.source_signal', 'INSERT')
     OR has_table_privilege('runtime_customer_worker_ops', 'public.source_signal', 'UPDATE')
     OR has_table_privilege('runtime_customer_worker_ops', 'public.source_signal', 'DELETE')
     OR has_table_privilege('execution_budget_platform_writer', 'public.source_policy', 'INSERT')
     OR has_table_privilege('execution_budget_platform_writer', 'public.source_policy', 'UPDATE')
     OR has_table_privilege('execution_budget_platform_writer', 'public.data_provider', 'INSERT')
     OR has_table_privilege('execution_budget_platform_writer', 'public.data_provider', 'UPDATE')
  THEN
    RAISE EXCEPTION 'GOVERNANCE_CATALOG_WRITE_PRIVILEGE_FORBIDDEN';
  END IF;
END $$;

COMMIT;
