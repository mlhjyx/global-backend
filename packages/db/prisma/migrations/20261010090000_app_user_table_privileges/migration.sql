-- app_user privileges match what its code paths use, and new tables start read-only for it.
-- 20260706033625_rls_and_app_role granted app_user SELECT, INSERT, UPDATE and DELETE on every
-- table that existed then and made the same grant the owner's default for every later table. The
-- migrations that meant a platform table without RLS to be read-only for app_user mostly granted
-- SELECT without revoking the rest, so even a fresh database let app_user write them.
-- Design: docs/superpowers/plans/2026-10-09-app-user-platform-table-privileges.md (APPROVED).
--
-- 1. Sixteen platform tables without RLS get exactly the operations the app_user code paths use
--    (design section 2): SELECT on _prisma_migrations, canonical_taxonomy, jurisdiction_policy,
--    sanctions_source and sanctions_entity; nothing on patent_cache_refresh_audit; SELECT, INSERT
--    and UPDATE on monitored_source, source_fetch, source_entity, source_signal, signal_ingest,
--    term_alias and patent_lookup_request; SELECT, INSERT and DELETE on source_entity_change (the
--    90-day purge); SELECT and DELETE on patent_inventor_cache (Art.17 erasure); SELECT and INSERT
--    on patent_inventor_tombstone (an Art.17 tombstone is never changed or removed).
-- 2. Sixteen more tables get back the privileges their own migrations define (generated from a
--    fresh database migrated through 20261009190000). An existing database (xin global_dev) had
--    UPDATE and DELETE granted again on evidence, audit and deletion-receipt tables that earlier
--    hardening made append-only. On a fresh database this changes nothing.
-- 3. The owner's default privileges give app_user SELECT only on tables created from now on: a
--    migration that creates a table app_user writes must grant that write itself. Sequence
--    defaults (USAGE, SELECT) are unchanged.
-- 4. A final check compares app_user's effective privileges on every relation in schema public
--    (counting every role app_user reaches over role memberships) with the list below, identical
--    to docs/governance/app-user-table-privileges.json, and the default privileges with step 3;
--    any difference raises and rolls the whole migration back.
--
-- Each REVOKE ALL runs as the owner and removes every privilege the owner granted app_user and
-- PUBLIC on that table, column privileges included. A grant recorded under another grantor would
-- survive it, and the final check then rolls the migration back, so none can stay behind
-- silently. Privileges only: no data or schema change, no routine. The platform writer and the
-- runtime roles are not touched here.
-- Deploy in name order, in the same window as the image that carries this migration, with no
-- discovery run, deletion or platform schedule in flight: the runtime checks the most recently
-- finished migration against the newest one in its image. Deploy it after the earlier migrations
-- are live: if the check raises, this migration changes nothing, the previous image still matches
-- the database, and Prisma holds further deploys (P3009) until the reported difference is fixed
-- and the migration is marked rolled back.
-- Rollback: a later migration that grants back what is needed; in an emergency the owner can
-- GRANT by hand and a migration records it afterwards.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- 1. Platform tables without RLS.
REVOKE ALL ON TABLE
  public._prisma_migrations,
  public.canonical_taxonomy,
  public.jurisdiction_policy,
  public.sanctions_source,
  public.sanctions_entity,
  public.patent_cache_refresh_audit,
  public.monitored_source,
  public.source_fetch,
  public.source_entity,
  public.source_entity_change,
  public.source_signal,
  public.signal_ingest,
  public.term_alias,
  public.patent_inventor_cache,
  public.patent_lookup_request,
  public.patent_inventor_tombstone
  FROM PUBLIC, app_user;
GRANT SELECT ON TABLE
  public._prisma_migrations,
  public.canonical_taxonomy,
  public.jurisdiction_policy,
  public.sanctions_source,
  public.sanctions_entity
  TO app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE
  public.monitored_source,
  public.source_fetch,
  public.source_entity,
  public.source_signal,
  public.signal_ingest,
  public.term_alias,
  public.patent_lookup_request
  TO app_user;
GRANT SELECT, INSERT, DELETE ON TABLE public.source_entity_change TO app_user;
GRANT SELECT, DELETE ON TABLE public.patent_inventor_cache TO app_user;
GRANT SELECT, INSERT ON TABLE public.patent_inventor_tombstone TO app_user;

-- 2. Tables restored to the privileges their migrations define (no column privileges there).
REVOKE ALL ON TABLE
  public.article14_notice,
  public.brand_profile,
  public.brand_profile_claim_bridge,
  public.brand_profile_evidence_ref,
  public.claim,
  public.deletion_receipt,
  public.deletion_request,
  public.evidence,
  public.lia_record,
  public.policy_decision_log,
  public.site_build_task_attempt,
  public.site_copy_bundle,
  public.site_evidence_source_snapshot,
  public.site_publishable_claim_snapshot,
  public.site_publishable_claim_snapshot_item,
  public.site_release
  FROM PUBLIC, app_user;
GRANT INSERT, SELECT ON TABLE
  public.brand_profile,
  public.brand_profile_claim_bridge,
  public.brand_profile_evidence_ref,
  public.deletion_receipt,
  public.evidence,
  public.policy_decision_log,
  public.site_copy_bundle,
  public.site_evidence_source_snapshot,
  public.site_publishable_claim_snapshot,
  public.site_publishable_claim_snapshot_item
  TO app_user;
GRANT INSERT, SELECT, UPDATE ON TABLE
  public.article14_notice,
  public.claim,
  public.deletion_request,
  public.lia_record,
  public.site_build_task_attempt,
  public.site_release
  TO app_user;

-- 3. New tables: SELECT only.
ALTER DEFAULT PRIVILEGES FOR ROLE global IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM app_user;

-- 4. app_user's effective privileges on every relation in schema public must equal the list
--    below. A privilege counts when app_user holds it directly, through PUBLIC, on a single
--    column, or through any role it reaches over role memberships, directly or indirectly and
--    whatever their INHERIT, SET and ADMIN options: a role it only administers can still be
--    granted to itself and switched to, and onward from there. A superuser or the relation's owner
--    among those roles holds every privilege. None of those roles may hold a privilege WITH GRANT
--    OPTION, and the default privileges given to any of them or to PUBLIC must be exactly step 3
--    plus the unchanged sequence defaults. The list was generated from a database migrated through
--    this migration.
DO $$
DECLARE
  differences TEXT;
BEGIN
  WITH RECURSIVE expected_relation(relname, privileges) AS (
    VALUES
      ('_prisma_migrations', 'SELECT'),
      ('ai_trace', 'DELETE,INSERT,SELECT,UPDATE'),
      ('article14_notice', 'INSERT,SELECT,UPDATE'),
      ('asset', 'DELETE,INSERT,SELECT,UPDATE'),
      ('asset_variant', 'DELETE,INSERT,SELECT,UPDATE'),
      ('brand_profile', 'INSERT,SELECT'),
      ('brand_profile_claim_bridge', 'INSERT,SELECT'),
      ('brand_profile_evidence_ref', 'INSERT,SELECT'),
      ('buying_committee_role', 'DELETE,INSERT,SELECT,UPDATE'),
      ('canonical_company', 'DELETE,INSERT,SELECT,UPDATE'),
      ('canonical_contact', 'DELETE,INSERT,SELECT,UPDATE'),
      ('canonical_taxonomy', 'SELECT'),
      ('citation', 'DELETE,INSERT,SELECT,UPDATE'),
      ('claim', 'INSERT,SELECT,UPDATE'),
      ('company_profile', 'DELETE,INSERT,SELECT,UPDATE'),
      ('contact_point', 'DELETE,INSERT,SELECT,UPDATE'),
      ('data_provider', 'SELECT'),
      ('deletion_receipt', 'INSERT,SELECT'),
      ('deletion_request', 'INSERT,SELECT,UPDATE'),
      ('discovery_company_materialization_activation', ''),
      ('discovery_company_materialization_admission', 'SELECT'),
      ('discovery_company_materialization_batch_receipt', 'SELECT'),
      ('discovery_company_materialization_outcome', 'SELECT'),
      ('discovery_company_materialization_query_receipt', 'SELECT'),
      ('discovery_company_materialization_run_receipt', 'SELECT'),
      ('discovery_company_materialization_tx_fence', ''),
      ('discovery_query_attempt_item', 'SELECT'),
      ('discovery_query_execution_outcome', 'SELECT'),
      ('discovery_query_operation_attempt', 'SELECT'),
      ('discovery_query_plan', 'DELETE,INSERT,SELECT,UPDATE'),
      ('discovery_query_receipt', 'SELECT'),
      ('discovery_run', 'DELETE,INSERT,SELECT,UPDATE'),
      ('evidence', 'INSERT,SELECT'),
      ('execution_budget_authority', 'SELECT'),
      ('execution_budget_authority_revocation', 'INSERT,SELECT'),
      ('execution_domain_ack', 'SELECT'),
      ('field_evidence', 'DELETE,INSERT,SELECT,UPDATE'),
      ('generic_operation_artifact', ''),
      ('generic_operation_artifact_object', ''),
      ('generic_operation_artifact_subject', ''),
      ('generic_operation_artifact_subject_tombstone', ''),
      ('generic_operation_artifact_subject_tombstone_audit', ''),
      ('governed_subject', ''),
      ('governed_subject_relation', ''),
      ('governed_subject_tombstone', ''),
      ('governed_subject_tombstone_audit', ''),
      ('icp_backtest', 'DELETE,INSERT,SELECT,UPDATE'),
      ('icp_definition', 'DELETE,INSERT,SELECT,UPDATE'),
      ('idempotency_key', 'DELETE,INSERT,SELECT,UPDATE'),
      ('identity_link', 'INSERT,SELECT'),
      ('jurisdiction_policy', 'SELECT'),
      ('kb_chunk', 'DELETE,INSERT,SELECT,UPDATE'),
      ('kb_document', 'DELETE,INSERT,SELECT,UPDATE'),
      ('knowledge_conflict', 'DELETE,INSERT,SELECT,UPDATE'),
      ('knowledge_source', 'DELETE,INSERT,SELECT,UPDATE'),
      ('lead', 'DELETE,INSERT,SELECT,UPDATE'),
      ('lead_decision', 'DELETE,INSERT,SELECT,UPDATE'),
      ('lia_record', 'INSERT,SELECT,UPDATE'),
      ('monitored_source', 'INSERT,SELECT,UPDATE'),
      ('offering', 'DELETE,INSERT,SELECT,UPDATE'),
      ('outbox_delivery', 'DELETE,INSERT,SELECT,UPDATE'),
      ('outbox_event', 'DELETE,INSERT,SELECT,UPDATE'),
      ('patent_cache_refresh_audit', ''),
      ('patent_inventor_cache', 'DELETE,SELECT'),
      ('patent_inventor_tombstone', 'INSERT,SELECT'),
      ('patent_lookup_request', 'INSERT,SELECT,UPDATE'),
      ('persona', 'DELETE,INSERT,SELECT,UPDATE'),
      ('personal_artifact_cleanup_command', ''),
      ('platform_egress_attempt', ''),
      ('platform_egress_schedule_fence', ''),
      ('platform_fence_ack_delivery', ''),
      ('platform_revocation_receipt', ''),
      ('policy_decision_log', 'INSERT,SELECT'),
      ('qualification_rule', 'DELETE,INSERT,SELECT,UPDATE'),
      ('raw_source_field_evidence_cleanup_audit', 'SELECT'),
      ('raw_source_governance_disposition', 'SELECT'),
      ('raw_source_record', 'SELECT'),
      ('runtime_process_lease', 'SELECT'),
      ('sanctions_entity', 'SELECT'),
      ('sanctions_screening_result', 'DELETE,INSERT,SELECT,UPDATE'),
      ('sanctions_source', 'SELECT'),
      ('signal_ingest', 'INSERT,SELECT,UPDATE'),
      ('site', 'DELETE,INSERT,SELECT,UPDATE'),
      ('site_build_budget', 'SELECT'),
      ('site_build_budget_grant', 'INSERT,SELECT'),
      ('site_build_provider_readback_probe', 'SELECT'),
      ('site_build_provider_readback_probe_observation', 'SELECT'),
      ('site_build_provider_wire_attempt', 'SELECT'),
      ('site_build_provider_wire_receipt', 'SELECT'),
      ('site_build_run', 'DELETE,INSERT,SELECT,UPDATE'),
      ('site_build_spend', 'SELECT'),
      ('site_build_spend_reconciliation', 'INSERT,SELECT'),
      ('site_build_step', 'DELETE,INSERT,SELECT,UPDATE'),
      ('site_build_task_attempt', 'INSERT,SELECT,UPDATE'),
      ('site_copy_bundle', 'INSERT,SELECT'),
      ('site_evidence_source_snapshot', 'INSERT,SELECT'),
      ('site_publishable_claim_snapshot', 'INSERT,SELECT'),
      ('site_publishable_claim_snapshot_item', 'INSERT,SELECT'),
      ('site_release', 'INSERT,SELECT,UPDATE'),
      ('site_version', 'DELETE,INSERT,SELECT,UPDATE'),
      ('source_entity', 'INSERT,SELECT,UPDATE'),
      ('source_entity_change', 'DELETE,INSERT,SELECT'),
      ('source_fetch', 'INSERT,SELECT,UPDATE'),
      ('source_policy', 'SELECT'),
      ('source_signal', 'INSERT,SELECT,UPDATE'),
      ('suppression_decision', 'INSERT,SELECT'),
      ('suppression_record', 'INSERT,SELECT,UPDATE'),
      ('term_alias', 'INSERT,SELECT,UPDATE'),
      ('tool_budget_account', 'SELECT'),
      ('tool_budget_operation', 'SELECT'),
      ('tool_operation_subject', ''),
      ('usage_ledger', 'DELETE,INSERT,SELECT,UPDATE'),
      ('workspace', 'DELETE,INSERT,SELECT,UPDATE')
  ),
  expected AS (
    SELECT e.relname || ' ' || p.privilege AS entry
    FROM expected_relation AS e
    CROSS JOIN LATERAL unnest(string_to_array(NULLIF(e.privileges, ''), ',')) AS p(privilege)
  ),
  reach(oid, rolsuper) AS (
    SELECT r.oid, r.rolsuper FROM pg_catalog.pg_roles AS r WHERE r.rolname = 'app_user'
    UNION
    SELECT r.oid, r.rolsuper
    FROM reach AS a
    JOIN pg_catalog.pg_auth_members AS m ON m.member = a.oid
    JOIN pg_catalog.pg_roles AS r ON r.oid = m.roleid
  ),
  relation AS (
    SELECT c.oid, c.relname::text AS relname, c.relowner
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  ),
  privilege(p) AS (
    SELECT unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
    UNION ALL
    SELECT 'MAINTAIN' WHERE pg_catalog.current_setting('server_version_num')::int >= 170000
  ),
  table_level AS (
    SELECT rel.oid, rel.relname, pr.p AS privilege
    FROM relation AS rel
    CROSS JOIN privilege AS pr
    WHERE EXISTS (
      SELECT 1 FROM reach AS a
      WHERE a.rolsuper
        OR a.oid = rel.relowner
        OR pg_catalog.has_table_privilege(a.oid, rel.oid, pr.p))
  ),
  column_level AS (
    SELECT rel.relname || '.' || att.attname || ' ' || p.privilege AS entry
    FROM relation AS rel
    JOIN pg_catalog.pg_attribute AS att
      ON att.attrelid = rel.oid AND att.attnum > 0 AND NOT att.attisdropped
    CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p(privilege)
    WHERE NOT EXISTS (
        SELECT 1 FROM table_level AS t WHERE t.oid = rel.oid AND t.privilege = p.privilege)
      AND EXISTS (
        SELECT 1 FROM reach AS a
        WHERE pg_catalog.has_column_privilege(a.oid, rel.oid, att.attnum, p.privilege))
  ),
  actual AS (
    SELECT relname || ' ' || privilege AS entry FROM table_level
    UNION ALL
    SELECT entry FROM column_level
  ),
  default_expected(entry) AS (
    VALUES
      ('global public tables app_user SELECT'),
      ('global public sequences app_user SELECT'),
      ('global public sequences app_user USAGE')
  ),
  default_actual AS (
    SELECT format('%s %s %s %s %s',
        pg_catalog.pg_get_userbyid(d.defaclrole),
        coalesce(nsp.nspname::text, '*'),
        CASE d.defaclobjtype WHEN 'r' THEN 'tables' ELSE 'sequences' END,
        CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END,
        a.privilege_type || CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END) AS entry
    FROM pg_catalog.pg_default_acl AS d
    LEFT JOIN pg_catalog.pg_namespace AS nsp ON nsp.oid = d.defaclnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) AS a
    WHERE d.defaclobjtype IN ('r', 'S')
      AND (a.grantee = 0 OR a.grantee IN (SELECT oid FROM reach))
  ),
  difference(entry) AS (
    SELECT 'unlisted relation ' || rel.relname
    FROM relation AS rel
    WHERE NOT EXISTS (SELECT 1 FROM expected_relation AS e WHERE e.relname = rel.relname)
    UNION ALL
    SELECT 'missing relation ' || e.relname
    FROM expected_relation AS e
    WHERE NOT EXISTS (SELECT 1 FROM relation AS rel WHERE rel.relname = e.relname)
    UNION ALL
    SELECT 'unexpected ' || x.entry FROM (SELECT entry FROM actual EXCEPT SELECT entry FROM expected) AS x
    UNION ALL
    SELECT 'missing ' || x.entry FROM (SELECT entry FROM expected EXCEPT SELECT entry FROM actual) AS x
    UNION ALL
    SELECT 'grant option ' || rel.relname || ' ' || pr.p
    FROM relation AS rel
    CROSS JOIN privilege AS pr
    WHERE EXISTS (
      SELECT 1 FROM reach AS a
      WHERE CASE WHEN pr.p IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
        THEN pg_catalog.has_any_column_privilege(a.oid, rel.oid, pr.p || ' WITH GRANT OPTION')
        ELSE pg_catalog.has_table_privilege(a.oid, rel.oid, pr.p || ' WITH GRANT OPTION') END)
    UNION ALL
    SELECT 'unexpected default ' || x.entry
    FROM (SELECT entry FROM default_actual EXCEPT SELECT entry FROM default_expected) AS x
    UNION ALL
    SELECT 'missing default ' || x.entry
    FROM (SELECT entry FROM default_expected EXCEPT SELECT entry FROM default_actual) AS x
  )
  SELECT string_agg(entry, ', ' ORDER BY entry) INTO differences FROM difference;
  IF differences IS NOT NULL THEN
    RAISE EXCEPTION 'APP_USER_PRIVILEGE_MISMATCH: %', left(differences, 4000);
  END IF;
END $$;

COMMIT;
