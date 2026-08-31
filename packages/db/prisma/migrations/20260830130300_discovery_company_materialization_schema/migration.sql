-- Release A additive schema for governed Discovery company materialization.
-- Release B alone may insert the activation singleton; this migration never activates C-TX.
-- Retained deployment gate: pause new Discovery runs and Canonical/Identity writers,
-- drain old API/Workers and apply from the exact Release A image. Existing hot
-- tables receive atomic constraints/indexes; lock_timeout aborts instead of waiting.
-- SHA-256(UTF-8 "discovery-company-materialization/v1", no newline):
-- 558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

DO $principal$
DECLARE principal_state RECORD; required_role TEXT;
BEGIN
  SELECT rolsuper,rolcreaterole INTO principal_state
  FROM pg_roles WHERE rolname=current_user;
  -- PostgreSQL SUPERUSER is sufficient even when the redundant rolcreaterole
  -- attribute is false; only a superuser may create/alter a BYPASSRLS role.
  IF NOT FOUND OR NOT principal_state.rolsuper THEN
    RAISE EXCEPTION 'DISCOVERY_COMPANY_MATERIALIZATION_MIGRATION_PRINCIPAL_INVALID'
      USING ERRCODE='P0001';
  END IF;
  FOREACH required_role IN ARRAY ARRAY[
    'app_user','execution_budget_platform_writer','runtime_api','runtime_worker','runtime_outbox_relay'
  ] LOOP
    IF to_regrole(required_role) IS NULL THEN
      RAISE EXCEPTION 'DISCOVERY_COMPANY_MATERIALIZATION_REQUIRED_ROLE_MISSING'
        USING ERRCODE='P0001';
    END IF;
  END LOOP;
  IF to_regclass('public.discovery_run') IS NULL
    OR to_regclass('public.discovery_query_attempt_item') IS NULL
    OR to_regclass('public.governed_subject_relation') IS NULL THEN
    RAISE EXCEPTION 'DISCOVERY_COMPANY_MATERIALIZATION_REQUIRED_TABLE_MISSING'
      USING ERRCODE='P0001';
  END IF;
END $principal$;

DO $role$
DECLARE role_state RECORD; reader_oid OID;
BEGIN
  SELECT oid,rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
    INTO role_state FROM pg_roles WHERE rolname='discovery_materialization_fact_reader';
  IF NOT FOUND THEN
    CREATE ROLE discovery_materialization_fact_reader
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
    SELECT oid INTO reader_oid FROM pg_roles
      WHERE rolname='discovery_materialization_fact_reader';
  ELSE
    reader_oid:=role_state.oid;
  END IF;
  IF role_state.oid IS NOT NULL AND (
    role_state.rolcanlogin OR role_state.rolinherit OR role_state.rolsuper OR role_state.rolcreatedb
    OR role_state.rolcreaterole OR role_state.rolreplication
    OR NOT role_state.rolbypassrls) THEN
    RAISE EXCEPTION 'DISCOVERY_MATERIALIZATION_FACT_READER_ROLE_INVALID'
      USING ERRCODE='P0001';
  END IF;
  IF EXISTS(
    SELECT 1 FROM pg_auth_members membership
    WHERE membership.roleid=reader_oid OR membership.member=reader_oid
  ) THEN
    RAISE EXCEPTION 'DISCOVERY_MATERIALIZATION_FACT_READER_MEMBERSHIP_INVALID'
      USING ERRCODE='P0001';
  END IF;
  IF EXISTS(
    SELECT 1 FROM pg_class object WHERE object.relowner=reader_oid
    UNION ALL SELECT 1 FROM pg_proc object WHERE object.proowner=reader_oid
    UNION ALL SELECT 1 FROM pg_namespace object WHERE object.nspowner=reader_oid
    UNION ALL SELECT 1 FROM pg_database object WHERE object.datdba=reader_oid
    UNION ALL SELECT 1 FROM pg_type object WHERE object.typowner=reader_oid
    UNION ALL SELECT 1 FROM pg_operator object WHERE object.oprowner=reader_oid
    UNION ALL SELECT 1 FROM pg_collation object WHERE object.collowner=reader_oid
    UNION ALL SELECT 1 FROM pg_conversion object WHERE object.conowner=reader_oid
    UNION ALL SELECT 1 FROM pg_language object WHERE object.lanowner=reader_oid
    UNION ALL SELECT 1 FROM pg_extension object WHERE object.extowner=reader_oid
    UNION ALL SELECT 1 FROM pg_foreign_data_wrapper object WHERE object.fdwowner=reader_oid
    UNION ALL SELECT 1 FROM pg_foreign_server object WHERE object.srvowner=reader_oid
    UNION ALL SELECT 1 FROM pg_largeobject_metadata object WHERE object.lomowner=reader_oid
    UNION ALL SELECT 1 FROM pg_event_trigger object WHERE object.evtowner=reader_oid
    UNION ALL SELECT 1 FROM pg_publication object WHERE object.pubowner=reader_oid
    UNION ALL SELECT 1 FROM pg_subscription object WHERE object.subowner=reader_oid
    UNION ALL SELECT 1 FROM pg_tablespace object WHERE object.spcowner=reader_oid
    UNION ALL SELECT 1 FROM pg_ts_config object WHERE object.cfgowner=reader_oid
    UNION ALL SELECT 1 FROM pg_ts_dict object WHERE object.dictowner=reader_oid
    UNION ALL SELECT 1 FROM pg_statistic_ext object WHERE object.stxowner=reader_oid
  ) THEN
    RAISE EXCEPTION 'DISCOVERY_MATERIALIZATION_FACT_READER_OWNERSHIP_INVALID'
      USING ERRCODE='P0001';
  END IF;
  IF EXISTS(
    SELECT 1 FROM information_schema.table_privileges
      WHERE grantee='discovery_materialization_fact_reader'
    UNION ALL SELECT 1 FROM information_schema.column_privileges
      WHERE grantee='discovery_materialization_fact_reader'
    UNION ALL SELECT 1 FROM information_schema.routine_privileges
      WHERE grantee='discovery_materialization_fact_reader'
    UNION ALL SELECT 1 FROM information_schema.usage_privileges
      WHERE grantee='discovery_materialization_fact_reader'
    UNION ALL SELECT 1 FROM pg_database database_object
      CROSS JOIN LATERAL aclexplode(database_object.datacl) privilege
      WHERE privilege.grantee=reader_oid
    UNION ALL SELECT 1 FROM pg_namespace schema_object
      CROSS JOIN LATERAL aclexplode(schema_object.nspacl) privilege
      WHERE privilege.grantee=reader_oid
    UNION ALL SELECT 1 FROM pg_default_acl defaults
      CROSS JOIN LATERAL aclexplode(defaults.defaclacl) privilege
      WHERE privilege.grantee=reader_oid
    UNION ALL SELECT 1 FROM pg_db_role_setting setting
      WHERE setting.setrole=reader_oid
  ) THEN
    RAISE EXCEPTION 'DISCOVERY_MATERIALIZATION_FACT_READER_GRANT_INVALID'
      USING ERRCODE='P0001';
  END IF;
END $role$;

CREATE FUNCTION public.reject_discovery_company_materialization_mutation_v1()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $body$
BEGIN
  RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_IMMUTABLE'
    USING ERRCODE='P0001';
END $body$;

CREATE TABLE public.discovery_company_materialization_activation (
  activation_id SMALLINT NOT NULL,
  contract_version VARCHAR(64) NOT NULL,
  contract_sha256 CHAR(64) NOT NULL,
  activated_at TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT discovery_company_materialization_activation_pkey PRIMARY KEY(activation_id),
  CONSTRAINT discovery_company_materialization_activation_singleton_check CHECK(activation_id=1),
  CONSTRAINT discovery_company_materialization_activation_contract_check CHECK(
    contract_version='discovery-company-materialization/v1'
    AND contract_sha256='558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe'
  )
);
CREATE FUNCTION public.guard_discovery_company_materialization_activation_insert_v1()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $body$
BEGIN
  IF current_setting('app.discovery_company_materialization_activation_v1',true)
      IS DISTINCT FROM '558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe'
    OR NEW.activation_id IS DISTINCT FROM 1
    OR NEW.contract_version IS DISTINCT FROM 'discovery-company-materialization/v1'
    OR NEW.contract_sha256 IS DISTINCT FROM
      '558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe' THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_ACTIVATION_DENIED'
      USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $body$;
CREATE TRIGGER discovery_company_materialization_activation_insert_guard
  BEFORE INSERT ON public.discovery_company_materialization_activation
  FOR EACH ROW EXECUTE FUNCTION public.guard_discovery_company_materialization_activation_insert_v1();
CREATE TRIGGER discovery_company_materialization_activation_immutable
  BEFORE UPDATE OR DELETE ON public.discovery_company_materialization_activation
  FOR EACH ROW EXECUTE FUNCTION public.reject_discovery_company_materialization_mutation_v1();

ALTER TABLE public.discovery_run
  ADD COLUMN materialization_contract_version VARCHAR(64),
  ADD CONSTRAINT discovery_run_materialization_contract_check CHECK(
    materialization_contract_version IS NULL
    OR materialization_contract_version='discovery-company-materialization/v1'
  );

CREATE FUNCTION public.guard_discovery_materialization_marker_v1()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $body$
DECLARE activation_present BOOLEAN;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.materialization_contract_version IS DISTINCT FROM OLD.materialization_contract_version THEN
      RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_MARKER_IMMUTABLE'
        USING ERRCODE='P0001';
    END IF;
    RETURN NEW;
  END IF;
  SELECT EXISTS(
    SELECT 1 FROM public.discovery_company_materialization_activation activation
    WHERE activation.activation_id=1
      AND activation.contract_version='discovery-company-materialization/v1'
      AND activation.contract_sha256=
        '558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe'
  ) INTO activation_present;
  IF activation_present
    AND NEW.materialization_contract_version IS DISTINCT FROM
      'discovery-company-materialization/v1' THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_MARKER_REQUIRED'
      USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $body$;
CREATE TRIGGER discovery_run_materialization_insert_guard
  BEFORE INSERT ON public.discovery_run
  FOR EACH ROW EXECUTE FUNCTION public.guard_discovery_materialization_marker_v1();
CREATE TRIGGER discovery_run_materialization_update_guard
  BEFORE UPDATE ON public.discovery_run
  FOR EACH ROW EXECUTE FUNCTION public.guard_discovery_materialization_marker_v1();

-- Upgrade inventories fail closed. No row is selected as a winner or rewritten.
DO $inventory$
BEGIN
  IF EXISTS(
    SELECT 1 FROM public.identity_link
    WHERE canonical_type='company'
    GROUP BY workspace_id,raw_record_id
    HAVING count(*)>1 OR count(DISTINCT canonical_id)>1
  ) THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_IDENTITY_INVENTORY_CONFLICT'
      USING ERRCODE='P0001';
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.identity_link link
    WHERE link.canonical_type NOT IN ('company','contact')
      OR link.canonical_type='company' AND NOT EXISTS(
        SELECT 1 FROM public.canonical_company company
        WHERE company.workspace_id=link.workspace_id AND company.id=link.canonical_id)
      OR link.canonical_type='contact' AND NOT EXISTS(
        SELECT 1 FROM public.canonical_contact contact
        WHERE contact.workspace_id=link.workspace_id AND contact.id=link.canonical_id)
  ) THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_IDENTITY_TARGET_INVENTORY_CONFLICT'
      USING ERRCODE='P0001';
  END IF;
  IF EXISTS(SELECT 1 FROM public.canonical_company WHERE status NOT IN ('NEW','ENRICHED','SUPPRESSED')) THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_STATUS_INVENTORY_CONFLICT'
      USING ERRCODE='P0001';
  END IF;
END $inventory$;

ALTER TABLE public.canonical_company
  ADD CONSTRAINT canonical_company_workspace_id_id_key UNIQUE(workspace_id,id),
  ADD CONSTRAINT canonical_company_status_check CHECK(status IN ('NEW','ENRICHED','SUPPRESSED'));
ALTER TABLE public.canonical_contact
  ADD CONSTRAINT canonical_contact_workspace_id_id_key UNIQUE(workspace_id,id);
ALTER TABLE public.identity_link
  ADD CONSTRAINT identity_link_workspace_id_id_key UNIQUE(workspace_id,id),
  ADD CONSTRAINT identity_link_exact_tuple_key
    UNIQUE(workspace_id,id,canonical_type,canonical_id,raw_record_id),
  ADD CONSTRAINT identity_link_canonical_type_check CHECK(canonical_type IN ('company','contact'));
CREATE UNIQUE INDEX identity_link_company_raw_unique
  ON public.identity_link(workspace_id,raw_record_id) WHERE canonical_type='company';
ALTER TABLE public.raw_source_governance_disposition
  ADD CONSTRAINT raw_source_governance_disposition_workspace_id_raw_key
    UNIQUE(workspace_id,id,raw_record_id);
ALTER TABLE public.discovery_query_attempt_item
  ADD CONSTRAINT discovery_query_attempt_item_materialization_tuple_key UNIQUE(
    workspace_id,id,run_id,query_key,provider_key,operation_id,record_index,
    raw_record_id,child_subject_id,relation_id
  );
ALTER TABLE public.governed_subject
  ADD CONSTRAINT governed_subject_materialization_exact_key
    UNIQUE(workspace_id,id,subject_type,subject_id);
ALTER TABLE public.governed_subject_relation
  ADD CONSTRAINT governed_subject_relation_materialization_exact_key
    UNIQUE(workspace_id,id,operation_id,relation_key);

CREATE FUNCTION public.validate_identity_link_typed_target_v1()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $body$
BEGIN
  IF NEW.canonical_type='company' THEN
    PERFORM 1 FROM public.canonical_company company
      WHERE company.workspace_id=NEW.workspace_id AND company.id=NEW.canonical_id;
  ELSIF NEW.canonical_type='contact' THEN
    PERFORM 1 FROM public.canonical_contact contact
      WHERE contact.workspace_id=NEW.workspace_id AND contact.id=NEW.canonical_id;
  ELSE
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_IDENTITY_TARGET_INVALID'
      USING ERRCODE='P0001';
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DOMAIN_ACK_DISCOVERY_COMPANY_IDENTITY_TARGET_INVALID'
      USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $body$;
CREATE TRIGGER identity_link_typed_target
  BEFORE INSERT ON public.identity_link
  FOR EACH ROW EXECUTE FUNCTION public.validate_identity_link_typed_target_v1();
CREATE TRIGGER identity_link_immutable
  BEFORE UPDATE OR DELETE ON public.identity_link
  FOR EACH ROW EXECUTE FUNCTION public.reject_discovery_company_materialization_mutation_v1();

CREATE TABLE public.discovery_company_materialization_admission (
  admission_id UUID NOT NULL DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  run_id UUID NOT NULL,
  materialization_contract_version VARCHAR(64),
  mode VARCHAR(32) NOT NULL,
  reason_code VARCHAR(64) NOT NULL,
  q_contract_sha256 CHAR(64),
  contract_sha256 CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT discovery_company_materialization_admission_pkey PRIMARY KEY(admission_id),
  CONSTRAINT discovery_company_materialization_admission_workspace_id_key UNIQUE(workspace_id,admission_id),
  CONSTRAINT discovery_company_materialization_admission_workspace_run_key UNIQUE(workspace_id,run_id),
  CONSTRAINT discovery_company_materialization_admission_exact_key UNIQUE(workspace_id,admission_id,run_id),
  CONSTRAINT discovery_company_materialization_admission_run_fkey
    FOREIGN KEY(workspace_id,run_id) REFERENCES public.discovery_run(workspace_id,id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT discovery_company_materialization_admission_shape_check CHECK(
    contract_sha256='558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe' AND (
      mode='GOVERNED_C_TX'
      AND materialization_contract_version='discovery-company-materialization/v1'
      AND reason_code='GOVERNED_Q_V2_COMPLETE'
      AND q_contract_sha256='c665fc06432925532b3caa20824f9b9a310ce0bdfc497b3c0e688527badcbe0c'
      OR mode='LEGACY'
      AND materialization_contract_version IS NULL
      AND reason_code='PRE_C_NULL_MARKER'
      AND q_contract_sha256 IS NULL
    )
  )
);

CREATE TABLE public.discovery_company_materialization_batch_receipt (
  workspace_id UUID NOT NULL,
  admission_id UUID NOT NULL,
  run_id UUID NOT NULL,
  query_key CHAR(64) NOT NULL,
  batch_ordinal INTEGER NOT NULL,
  first_item_key VARCHAR(512) NOT NULL,
  last_item_key VARCHAR(512) NOT NULL,
  expected_item_count INTEGER NOT NULL,
  item_set_sha256 CHAR(64) NOT NULL,
  outcome_canonicalized_count BIGINT NOT NULL,
  outcome_raw_quarantined_count BIGINT NOT NULL,
  outcome_raw_rejected_count BIGINT NOT NULL,
  outcome_restricted_processing_count BIGINT NOT NULL,
  outcome_suppressed_count BIGINT NOT NULL,
  outcome_not_canonicalizable_count BIGINT NOT NULL,
  outcome_expired_before_canonicalization_count BIGINT NOT NULL,
  mutation_created_count BIGINT NOT NULL,
  mutation_updated_count BIGINT NOT NULL,
  mutation_linked_count BIGINT NOT NULL,
  mutation_reused_count BIGINT NOT NULL,
  evidence_manifest_count BIGINT NOT NULL,
  evidence_manifest_sha256 CHAR(64) NOT NULL,
  contract_sha256 CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT discovery_company_materialization_batch_receipt_pkey
    PRIMARY KEY(workspace_id,run_id,query_key,batch_ordinal),
  CONSTRAINT discovery_company_materialization_batch_receipt_admission_fkey
    FOREIGN KEY(workspace_id,admission_id,run_id)
    REFERENCES public.discovery_company_materialization_admission(workspace_id,admission_id,run_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT discovery_company_materialization_batch_receipt_query_fkey
    FOREIGN KEY(workspace_id,run_id,query_key)
    REFERENCES public.discovery_query_receipt(workspace_id,run_id,query_key)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT discovery_company_materialization_batch_receipt_shape_check CHECK(
    batch_ordinal BETWEEN 0 AND 4095 AND expected_item_count BETWEEN 1 AND 128
    AND item_set_sha256 ~ '^[0-9a-f]{64}$'
    AND evidence_manifest_sha256 ~ '^[0-9a-f]{64}$'
    AND contract_sha256='558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe'
    AND outcome_canonicalized_count + outcome_raw_quarantined_count
      + outcome_raw_rejected_count + outcome_restricted_processing_count
      + outcome_suppressed_count + outcome_not_canonicalizable_count
      + outcome_expired_before_canonicalization_count = expected_item_count
    AND mutation_created_count + mutation_updated_count + mutation_linked_count
      + mutation_reused_count = outcome_canonicalized_count
    AND LEAST(outcome_canonicalized_count,outcome_raw_quarantined_count,
      outcome_raw_rejected_count,outcome_restricted_processing_count,
      outcome_suppressed_count,outcome_not_canonicalizable_count,
      outcome_expired_before_canonicalization_count,mutation_created_count,
      mutation_updated_count,mutation_linked_count,mutation_reused_count,
      evidence_manifest_count)>=0
  )
);

CREATE TABLE public.discovery_company_materialization_outcome (
  workspace_id UUID NOT NULL, admission_id UUID NOT NULL, run_id UUID NOT NULL,
  query_item_id UUID NOT NULL, query_key CHAR(64) NOT NULL, query_ordinal INTEGER NOT NULL,
  provider_key VARCHAR(128) NOT NULL, operation_id UUID NOT NULL, record_index INTEGER NOT NULL,
  raw_record_id UUID NOT NULL, raw_governed_subject_id UUID NOT NULL, q_relation_id UUID NOT NULL,
  q_ingest_status VARCHAR(32) NOT NULL, batch_ordinal INTEGER NOT NULL, outcome VARCHAR(64) NOT NULL,
  canonical_company_id UUID, identity_link_id UUID, identity_canonical_type VARCHAR(32),
  canonical_governed_subject_id UUID, canonical_governed_subject_type VARCHAR(191),
  c_relation_id UUID, c_relation_key VARCHAR(200),
  match_rule VARCHAR(64), confidence DOUBLE PRECISION, mutation_class VARCHAR(32),
  evidence_count INTEGER, evidence_manifest_sha256 CHAR(64),
  restricted_disposition_id UUID, suppression_match_sha256 CHAR(64), suppression_match_count INTEGER,
  raw_expired_at TIMESTAMPTZ(3), not_canonicalizable_reason_code VARCHAR(64),
  contract_sha256 CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT discovery_company_materialization_outcome_pkey PRIMARY KEY(workspace_id,query_item_id),
  CONSTRAINT discovery_company_materialization_outcome_provider_index_key
    UNIQUE(workspace_id,run_id,query_key,provider_key,record_index),
  CONSTRAINT discovery_company_materialization_outcome_exact_item_key UNIQUE(
    workspace_id,query_item_id,run_id,query_key,provider_key,operation_id,
    record_index,raw_record_id,raw_governed_subject_id,q_relation_id),
  CONSTRAINT discovery_company_materialization_outcome_q_item_fkey FOREIGN KEY(
    workspace_id,query_item_id,run_id,query_key,provider_key,operation_id,
    record_index,raw_record_id,raw_governed_subject_id,q_relation_id
  ) REFERENCES public.discovery_query_attempt_item(
    workspace_id,id,run_id,query_key,provider_key,operation_id,
    record_index,raw_record_id,child_subject_id,relation_id
  ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT discovery_company_materialization_outcome_admission_fkey
    FOREIGN KEY(workspace_id,admission_id,run_id)
    REFERENCES public.discovery_company_materialization_admission(workspace_id,admission_id,run_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT discovery_company_materialization_outcome_batch_fkey
    FOREIGN KEY(workspace_id,run_id,query_key,batch_ordinal)
    REFERENCES public.discovery_company_materialization_batch_receipt(workspace_id,run_id,query_key,batch_ordinal)
    ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT discovery_company_materialization_outcome_company_fkey
    FOREIGN KEY(workspace_id,canonical_company_id)
    REFERENCES public.canonical_company(workspace_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT discovery_company_materialization_outcome_identity_fkey FOREIGN KEY(
    workspace_id,identity_link_id,identity_canonical_type,canonical_company_id,raw_record_id
  ) REFERENCES public.identity_link(workspace_id,id,canonical_type,canonical_id,raw_record_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT discovery_company_materialization_outcome_raw_subject_fkey
    FOREIGN KEY(workspace_id,raw_governed_subject_id)
    REFERENCES public.governed_subject(workspace_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT discovery_company_mat_outcome_canonical_subject_fkey FOREIGN KEY(
    workspace_id,canonical_governed_subject_id,canonical_governed_subject_type,
    canonical_company_id
  ) REFERENCES public.governed_subject(workspace_id,id,subject_type,subject_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT discovery_company_materialization_outcome_q_relation_fkey
    FOREIGN KEY(q_relation_id) REFERENCES public.governed_subject_relation(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT discovery_company_materialization_outcome_c_relation_fkey FOREIGN KEY(
    workspace_id,c_relation_id,operation_id,c_relation_key
  ) REFERENCES public.governed_subject_relation(workspace_id,id,operation_id,relation_key)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT discovery_company_materialization_outcome_disposition_fkey
    FOREIGN KEY(workspace_id,restricted_disposition_id,raw_record_id)
    REFERENCES public.raw_source_governance_disposition(workspace_id,id,raw_record_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT discovery_company_materialization_outcome_shape_check CHECK(
    query_ordinal BETWEEN 0 AND 1023 AND record_index BETWEEN 0 AND 999999
    AND batch_ordinal BETWEEN 0 AND 4095
    AND contract_sha256='558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe'
    AND q_ingest_status IN ('ACCEPTED','QUARANTINED','REJECTED')
    AND (q_ingest_status='QUARANTINED' AND outcome='RAW_QUARANTINED'
      OR q_ingest_status='REJECTED' AND outcome='RAW_REJECTED'
      OR q_ingest_status='ACCEPTED' AND outcome NOT IN ('RAW_QUARANTINED','RAW_REJECTED'))
    AND (
      outcome='CANONICALIZED'
      AND canonical_company_id IS NOT NULL AND identity_link_id IS NOT NULL
      AND identity_canonical_type='company' AND canonical_governed_subject_id IS NOT NULL
      AND canonical_governed_subject_type='canonical_company'
      AND c_relation_id IS NOT NULL
      AND c_relation_key='discovery.canonical_company:'||record_index::text
      AND match_rule IN ('domain_exact','identifier_exact','name_country')
      AND confidence IS NOT NULL AND confidence>=0 AND confidence<=1
      AND confidence <> 'NaN'::DOUBLE PRECISION
      AND confidence <> 'Infinity'::DOUBLE PRECISION
      AND confidence <> '-Infinity'::DOUBLE PRECISION
      AND mutation_class IN ('CREATED','UPDATED','LINKED','REUSED')
      AND evidence_count BETWEEN 0 AND 1000000
      AND evidence_manifest_sha256 ~ '^[0-9a-f]{64}$'
      AND restricted_disposition_id IS NULL AND suppression_match_sha256 IS NULL
      AND suppression_match_count IS NULL AND raw_expired_at IS NULL
      AND not_canonicalizable_reason_code IS NULL
      OR outcome IN ('RAW_QUARANTINED','RAW_REJECTED','RESTRICTED_PROCESSING',
        'SUPPRESSED','NOT_CANONICALIZABLE','EXPIRED_BEFORE_CANONICALIZATION')
      AND canonical_company_id IS NULL AND identity_link_id IS NULL
      AND identity_canonical_type IS NULL AND canonical_governed_subject_id IS NULL
      AND canonical_governed_subject_type IS NULL
      AND c_relation_id IS NULL AND c_relation_key IS NULL AND match_rule IS NULL
      AND confidence IS NULL AND mutation_class IS NULL AND evidence_count IS NULL
      AND evidence_manifest_sha256 IS NULL
      AND (outcome='RESTRICTED_PROCESSING' AND restricted_disposition_id IS NOT NULL
        AND suppression_match_sha256 IS NULL AND suppression_match_count IS NULL
        AND raw_expired_at IS NULL AND not_canonicalizable_reason_code IS NULL
        OR outcome='SUPPRESSED' AND restricted_disposition_id IS NULL
        AND suppression_match_sha256 ~ '^[0-9a-f]{64}$'
        AND suppression_match_count BETWEEN 1 AND 64 AND raw_expired_at IS NULL
        AND not_canonicalizable_reason_code IS NULL
        OR outcome='EXPIRED_BEFORE_CANONICALIZATION' AND restricted_disposition_id IS NULL
        AND suppression_match_sha256 IS NULL AND suppression_match_count IS NULL
        AND raw_expired_at IS NOT NULL AND not_canonicalizable_reason_code IS NULL
        OR outcome='NOT_CANONICALIZABLE' AND restricted_disposition_id IS NULL
        AND suppression_match_sha256 IS NULL AND suppression_match_count IS NULL
        AND raw_expired_at IS NULL AND not_canonicalizable_reason_code IN(
          'MISSING_NAME','NON_PRODUCT_PROVENANCE','COMPANY_IDENTITY_INVALID')
        OR outcome IN ('RAW_QUARANTINED','RAW_REJECTED')
        AND restricted_disposition_id IS NULL AND suppression_match_sha256 IS NULL
        AND suppression_match_count IS NULL AND raw_expired_at IS NULL
        AND not_canonicalizable_reason_code IS NULL)
    )
  )
);

CREATE TABLE public.discovery_company_materialization_query_receipt (
  workspace_id UUID NOT NULL, admission_id UUID NOT NULL, run_id UUID NOT NULL,
  query_key CHAR(64) NOT NULL, batch_count INTEGER NOT NULL, item_count BIGINT NOT NULL,
  outcome_canonicalized_count BIGINT NOT NULL, outcome_raw_quarantined_count BIGINT NOT NULL,
  outcome_raw_rejected_count BIGINT NOT NULL, outcome_restricted_processing_count BIGINT NOT NULL,
  outcome_suppressed_count BIGINT NOT NULL, outcome_not_canonicalizable_count BIGINT NOT NULL,
  outcome_expired_before_canonicalization_count BIGINT NOT NULL,
  mutation_created_count BIGINT NOT NULL, mutation_updated_count BIGINT NOT NULL,
  mutation_linked_count BIGINT NOT NULL, mutation_reused_count BIGINT NOT NULL,
  companies_count BIGINT NOT NULL, contract_sha256 CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT discovery_company_materialization_query_receipt_pkey PRIMARY KEY(workspace_id,run_id,query_key),
  CONSTRAINT discovery_company_materialization_query_receipt_admission_fkey
    FOREIGN KEY(workspace_id,admission_id,run_id)
    REFERENCES public.discovery_company_materialization_admission(workspace_id,admission_id,run_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT discovery_company_materialization_query_receipt_query_fkey
    FOREIGN KEY(workspace_id,run_id,query_key)
    REFERENCES public.discovery_query_receipt(workspace_id,run_id,query_key)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT discovery_company_materialization_query_receipt_shape_check CHECK(
    batch_count BETWEEN 0 AND 4096 AND item_count BETWEEN 0 AND 524160
    AND batch_count=CASE WHEN item_count=0 THEN 0 ELSE ((item_count-1)/128+1)::INTEGER END
    AND outcome_canonicalized_count + outcome_raw_quarantined_count
      + outcome_raw_rejected_count + outcome_restricted_processing_count
      + outcome_suppressed_count + outcome_not_canonicalizable_count
      + outcome_expired_before_canonicalization_count=item_count
    AND mutation_created_count + mutation_updated_count + mutation_linked_count
      + mutation_reused_count=outcome_canonicalized_count
    AND companies_count=mutation_created_count+mutation_updated_count
    AND LEAST(outcome_canonicalized_count,outcome_raw_quarantined_count,
      outcome_raw_rejected_count,outcome_restricted_processing_count,
      outcome_suppressed_count,outcome_not_canonicalizable_count,
      outcome_expired_before_canonicalization_count,mutation_created_count,
      mutation_updated_count,mutation_linked_count,mutation_reused_count,companies_count)>=0
    AND contract_sha256='558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe'
  )
);

CREATE TABLE public.discovery_company_materialization_run_receipt (
  workspace_id UUID NOT NULL, admission_id UUID NOT NULL, run_id UUID NOT NULL,
  expected_query_count INTEGER NOT NULL, completed_query_count INTEGER NOT NULL,
  total_batch_count BIGINT NOT NULL, total_item_count BIGINT NOT NULL,
  outcome_canonicalized_count BIGINT NOT NULL, outcome_raw_quarantined_count BIGINT NOT NULL,
  outcome_raw_rejected_count BIGINT NOT NULL, outcome_restricted_processing_count BIGINT NOT NULL,
  outcome_suppressed_count BIGINT NOT NULL, outcome_not_canonicalizable_count BIGINT NOT NULL,
  outcome_expired_before_canonicalization_count BIGINT NOT NULL,
  mutation_created_count BIGINT NOT NULL, mutation_updated_count BIGINT NOT NULL,
  mutation_linked_count BIGINT NOT NULL, mutation_reused_count BIGINT NOT NULL,
  companies_count BIGINT NOT NULL, suppressed_count BIGINT NOT NULL,
  query_header_set_sha256 CHAR(64) NOT NULL, contract_sha256 CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT discovery_company_materialization_run_receipt_pkey PRIMARY KEY(workspace_id,run_id),
  CONSTRAINT discovery_company_materialization_run_receipt_admission_key
    UNIQUE(workspace_id,admission_id,run_id),
  CONSTRAINT discovery_company_materialization_run_receipt_admission_fkey
    FOREIGN KEY(workspace_id,admission_id,run_id)
    REFERENCES public.discovery_company_materialization_admission(workspace_id,admission_id,run_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT discovery_company_materialization_run_receipt_run_fkey
    FOREIGN KEY(workspace_id,run_id) REFERENCES public.discovery_run(workspace_id,id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT discovery_company_materialization_run_receipt_shape_check CHECK(
    expected_query_count BETWEEN 0 AND 1024 AND completed_query_count=expected_query_count
    AND total_batch_count>=0 AND total_item_count BETWEEN 0 AND 536739840
    AND outcome_canonicalized_count + outcome_raw_quarantined_count
      + outcome_raw_rejected_count + outcome_restricted_processing_count
      + outcome_suppressed_count + outcome_not_canonicalizable_count
      + outcome_expired_before_canonicalization_count=total_item_count
    AND mutation_created_count + mutation_updated_count + mutation_linked_count
      + mutation_reused_count=outcome_canonicalized_count
    AND companies_count=mutation_created_count+mutation_updated_count
    AND suppressed_count=outcome_suppressed_count
    AND LEAST(outcome_canonicalized_count,outcome_raw_quarantined_count,
      outcome_raw_rejected_count,outcome_restricted_processing_count,
      outcome_suppressed_count,outcome_not_canonicalizable_count,
      outcome_expired_before_canonicalization_count,mutation_created_count,
      mutation_updated_count,mutation_linked_count,mutation_reused_count,
      companies_count,suppressed_count)>=0
    AND query_header_set_sha256 ~ '^[0-9a-f]{64}$'
    AND contract_sha256='558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe'
  )
);

CREATE TABLE public.discovery_company_materialization_tx_fence (
  fence_id UUID NOT NULL DEFAULT gen_random_uuid(), backend_pid INTEGER NOT NULL,
  transaction_id XID8 NOT NULL, workspace_id UUID NOT NULL, admission_id UUID NOT NULL,
  run_id UUID NOT NULL, query_key CHAR(64) NOT NULL, batch_ordinal INTEGER NOT NULL,
  snapshot_sha256 CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT discovery_company_materialization_tx_fence_pkey PRIMARY KEY(fence_id),
  CONSTRAINT discovery_company_materialization_tx_fence_exact_key UNIQUE(
    backend_pid,transaction_id,workspace_id,admission_id,run_id,query_key,batch_ordinal),
  CONSTRAINT discovery_company_materialization_tx_fence_admission_fkey
    FOREIGN KEY(workspace_id,admission_id,run_id)
    REFERENCES public.discovery_company_materialization_admission(workspace_id,admission_id,run_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT discovery_company_materialization_tx_fence_query_fkey
    FOREIGN KEY(workspace_id,run_id,query_key)
    REFERENCES public.discovery_query_receipt(workspace_id,run_id,query_key)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT discovery_company_materialization_tx_fence_shape_check CHECK(
    backend_pid>0 AND batch_ordinal BETWEEN 0 AND 4095
    AND snapshot_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX discovery_company_materialization_outcome_run_idx
  ON public.discovery_company_materialization_outcome(workspace_id,run_id,query_key,batch_ordinal);
CREATE INDEX discovery_company_materialization_outcome_raw_idx
  ON public.discovery_company_materialization_outcome(workspace_id,raw_record_id);
CREATE INDEX discovery_company_materialization_admission_created_idx
  ON public.discovery_company_materialization_admission(workspace_id,created_at);

-- Workspace C tables are read-only to app_user; C3 definer functions own all writes.
ALTER TABLE public.discovery_company_materialization_admission ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discovery_company_materialization_admission FORCE ROW LEVEL SECURITY;
CREATE POLICY discovery_company_materialization_admission_workspace
  ON public.discovery_company_materialization_admission
  USING(workspace_id=public.current_workspace_id())
  WITH CHECK(workspace_id=public.current_workspace_id());
ALTER TABLE public.discovery_company_materialization_batch_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discovery_company_materialization_batch_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY discovery_company_materialization_batch_receipt_workspace
  ON public.discovery_company_materialization_batch_receipt
  USING(workspace_id=public.current_workspace_id())
  WITH CHECK(workspace_id=public.current_workspace_id());
ALTER TABLE public.discovery_company_materialization_outcome ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discovery_company_materialization_outcome FORCE ROW LEVEL SECURITY;
CREATE POLICY discovery_company_materialization_outcome_workspace
  ON public.discovery_company_materialization_outcome
  USING(workspace_id=public.current_workspace_id())
  WITH CHECK(workspace_id=public.current_workspace_id());
ALTER TABLE public.discovery_company_materialization_query_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discovery_company_materialization_query_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY discovery_company_materialization_query_receipt_workspace
  ON public.discovery_company_materialization_query_receipt
  USING(workspace_id=public.current_workspace_id())
  WITH CHECK(workspace_id=public.current_workspace_id());
ALTER TABLE public.discovery_company_materialization_run_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discovery_company_materialization_run_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY discovery_company_materialization_run_receipt_workspace
  ON public.discovery_company_materialization_run_receipt
  USING(workspace_id=public.current_workspace_id())
  WITH CHECK(workspace_id=public.current_workspace_id());

CREATE TRIGGER discovery_company_materialization_admission_immutable
  BEFORE UPDATE OR DELETE ON public.discovery_company_materialization_admission
  FOR EACH ROW EXECUTE FUNCTION public.reject_discovery_company_materialization_mutation_v1();
CREATE TRIGGER discovery_company_materialization_batch_receipt_immutable
  BEFORE UPDATE OR DELETE ON public.discovery_company_materialization_batch_receipt
  FOR EACH ROW EXECUTE FUNCTION public.reject_discovery_company_materialization_mutation_v1();
CREATE TRIGGER discovery_company_materialization_outcome_immutable
  BEFORE UPDATE OR DELETE ON public.discovery_company_materialization_outcome
  FOR EACH ROW EXECUTE FUNCTION public.reject_discovery_company_materialization_mutation_v1();
CREATE TRIGGER discovery_company_materialization_query_receipt_immutable
  BEFORE UPDATE OR DELETE ON public.discovery_company_materialization_query_receipt
  FOR EACH ROW EXECUTE FUNCTION public.reject_discovery_company_materialization_mutation_v1();
CREATE TRIGGER discovery_company_materialization_run_receipt_immutable
  BEFORE UPDATE OR DELETE ON public.discovery_company_materialization_run_receipt
  FOR EACH ROW EXECUTE FUNCTION public.reject_discovery_company_materialization_mutation_v1();

ALTER TABLE public.discovery_company_materialization_tx_fence
  OWNER TO discovery_materialization_fact_reader;
GRANT SELECT ON public.discovery_run,public.discovery_query_receipt,
  public.discovery_query_operation_attempt,public.discovery_query_attempt_item,
  public.raw_source_record,
  public.raw_source_governance_disposition,
  public.discovery_company_materialization_activation,
  public.discovery_company_materialization_admission
  TO discovery_materialization_fact_reader;

REVOKE ALL ON TABLE public.discovery_company_materialization_activation FROM PUBLIC,
  app_user,execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
REVOKE ALL ON TABLE public.discovery_company_materialization_tx_fence FROM PUBLIC,
  app_user,execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;

REVOKE ALL ON TABLE public.discovery_company_materialization_admission FROM PUBLIC;
REVOKE ALL ON TABLE public.discovery_company_materialization_admission FROM app_user,
  execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
GRANT SELECT ON TABLE public.discovery_company_materialization_admission TO app_user;
REVOKE ALL ON TABLE public.discovery_company_materialization_batch_receipt FROM PUBLIC;
REVOKE ALL ON TABLE public.discovery_company_materialization_batch_receipt FROM app_user,
  execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
GRANT SELECT ON TABLE public.discovery_company_materialization_batch_receipt TO app_user;
REVOKE ALL ON TABLE public.discovery_company_materialization_outcome FROM PUBLIC;
REVOKE ALL ON TABLE public.discovery_company_materialization_outcome FROM app_user,
  execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
GRANT SELECT ON TABLE public.discovery_company_materialization_outcome TO app_user;
REVOKE ALL ON TABLE public.discovery_company_materialization_query_receipt FROM PUBLIC;
REVOKE ALL ON TABLE public.discovery_company_materialization_query_receipt FROM app_user,
  execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
GRANT SELECT ON TABLE public.discovery_company_materialization_query_receipt TO app_user;
REVOKE ALL ON TABLE public.discovery_company_materialization_run_receipt FROM PUBLIC;
REVOKE ALL ON TABLE public.discovery_company_materialization_run_receipt FROM app_user,
  execution_budget_platform_writer,runtime_api,runtime_worker,runtime_outbox_relay;
GRANT SELECT ON TABLE public.discovery_company_materialization_run_receipt TO app_user;

REVOKE UPDATE,DELETE ON TABLE public.identity_link FROM app_user;
REVOKE ALL ON FUNCTION public.reject_discovery_company_materialization_mutation_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_discovery_company_materialization_activation_insert_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_discovery_materialization_marker_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_identity_link_typed_target_v1() FROM PUBLIC;

COMMIT;
