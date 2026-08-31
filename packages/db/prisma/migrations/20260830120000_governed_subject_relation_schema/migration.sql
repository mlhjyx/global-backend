-- Product-neutral governed subject and relation substrate (ADR-025).
-- This migration is schema-only: Task 2 and Task 3 own all public functions.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE public.governed_subject (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  scope_key VARCHAR(200) NOT NULL,
  workspace_id UUID NOT NULL,
  subject_type VARCHAR(191) NOT NULL,
  subject_id UUID NOT NULL,
  data_class VARCHAR(16) NOT NULL,
  dsr_subject_type VARCHAR(191),
  dsr_subject_id UUID,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT governed_subject_pkey PRIMARY KEY (id),
  CONSTRAINT governed_subject_workspace_subject_key
    UNIQUE (workspace_id, subject_type, subject_id),
  CONSTRAINT governed_subject_scope_id_key UNIQUE (scope_key, id),
  CONSTRAINT governed_subject_workspace_id_key UNIQUE (workspace_id, id),
  CONSTRAINT governed_subject_scope_check
    CHECK (scope_key = workspace_id::text),
  CONSTRAINT governed_subject_type_check
    CHECK (subject_type ~ '^[a-z][a-z0-9_.]{0,190}$'),
  CONSTRAINT governed_subject_dsr_type_check CHECK (
    dsr_subject_type IS NULL
    OR dsr_subject_type ~ '^[a-z][a-z0-9_.]{0,190}$'
  ),
  CONSTRAINT governed_subject_data_class_check CHECK (
    (
      data_class = 'PERSONAL'
      AND dsr_subject_type IS NOT NULL
      AND dsr_subject_id IS NOT NULL
    ) OR (
      data_class = 'NON_PERSONAL'
      AND dsr_subject_type IS NULL
      AND dsr_subject_id IS NULL
    )
  ),
  CONSTRAINT governed_subject_workspace_fkey
    FOREIGN KEY (workspace_id) REFERENCES public.workspace(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE public.tool_operation_subject (
  subject_id UUID NOT NULL,
  scope_key VARCHAR(200) NOT NULL,
  workspace_id UUID NOT NULL,
  authority_id UUID NOT NULL,
  account_id UUID NOT NULL,
  operation_id UUID NOT NULL,
  operation_generation INTEGER NOT NULL,
  root_subject_id UUID NOT NULL,
  ack_id CHAR(64) NOT NULL,
  result_digest CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT tool_operation_subject_pkey PRIMARY KEY (subject_id),
  CONSTRAINT tool_operation_subject_workspace_subject_key
    UNIQUE (workspace_id, subject_id),
  CONSTRAINT tool_operation_subject_workspace_operation_key
    UNIQUE (workspace_id, operation_id),
  CONSTRAINT tool_operation_subject_scope_operation_key
    UNIQUE (scope_key, operation_id),
  CONSTRAINT tool_operation_subject_workspace_generation_subject_key
    UNIQUE (workspace_id, operation_generation, subject_id),
  CONSTRAINT tool_operation_subject_scope_check
    CHECK (scope_key = workspace_id::text),
  CONSTRAINT tool_operation_subject_generation_check
    CHECK (operation_generation >= 1),
  CONSTRAINT tool_operation_subject_root_check
    CHECK (root_subject_id = subject_id),
  CONSTRAINT tool_operation_subject_ack_check
    CHECK (ack_id ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tool_operation_subject_result_digest_check
    CHECK (result_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tool_operation_subject_workspace_fkey
    FOREIGN KEY (workspace_id) REFERENCES public.workspace(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT tool_operation_subject_authority_fkey
    FOREIGN KEY (scope_key, authority_id)
    REFERENCES public.execution_budget_authority(scope_key, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT tool_operation_subject_account_fkey
    FOREIGN KEY (scope_key, account_id)
    REFERENCES public.tool_budget_account(scope_key, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT tool_operation_subject_operation_fkey
    FOREIGN KEY (scope_key, operation_id)
    REFERENCES public.tool_budget_operation(scope_key, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT tool_operation_subject_subject_fkey
    FOREIGN KEY (workspace_id, subject_id)
    REFERENCES public.governed_subject(workspace_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT tool_operation_subject_root_fkey
    FOREIGN KEY (workspace_id, root_subject_id)
    REFERENCES public.governed_subject(workspace_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT tool_operation_subject_ack_fkey
    FOREIGN KEY (ack_id) REFERENCES public.execution_domain_ack(ack_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE public.governed_subject_relation (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  scope_key VARCHAR(200) NOT NULL,
  workspace_id UUID NOT NULL,
  authority_id UUID NOT NULL,
  account_id UUID NOT NULL,
  operation_id UUID NOT NULL,
  operation_generation INTEGER NOT NULL,
  ack_id CHAR(64) NOT NULL,
  operation_subject_id UUID NOT NULL,
  parent_subject_id UUID NOT NULL,
  child_subject_id UUID NOT NULL,
  relation_key VARCHAR(200) NOT NULL,
  relation_kind VARCHAR(32) NOT NULL,
  source_ref_namespace VARCHAR(64) NOT NULL,
  source_ref_uuid UUID,
  source_ref_sha256 CHAR(64),
  contract_sha256 CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT governed_subject_relation_pkey PRIMARY KEY (id),
  CONSTRAINT governed_subject_relation_workspace_operation_relation_key
    UNIQUE (workspace_id, operation_id, relation_key),
  CONSTRAINT governed_subject_relation_scope_check
    CHECK (scope_key = workspace_id::text),
  CONSTRAINT governed_subject_relation_generation_check
    CHECK (operation_generation >= 1),
  CONSTRAINT governed_subject_relation_distinct_subjects_check
    CHECK (parent_subject_id <> child_subject_id),
  CONSTRAINT governed_subject_relation_key_check
    CHECK (relation_key ~ '^[a-z][a-z0-9_.:-]{0,199}$'),
  CONSTRAINT governed_subject_relation_kind_check
    CHECK (relation_kind IN ('MATERIALIZED_CHILD', 'DERIVED_FROM')),
  CONSTRAINT governed_subject_relation_source_namespace_check
    CHECK (source_ref_namespace ~ '^[a-z][a-z0-9_.]{0,63}$'),
  CONSTRAINT governed_subject_relation_source_ref_check CHECK (
    (
      source_ref_uuid IS NOT NULL
      AND source_ref_sha256 IS NULL
    ) OR (
      source_ref_uuid IS NULL
      AND source_ref_sha256 IS NOT NULL
    )
  ),
  CONSTRAINT governed_subject_relation_digest_check CHECK (
    ack_id ~ '^[0-9a-f]{64}$'
    AND contract_sha256 ~ '^[0-9a-f]{64}$'
    AND (
      source_ref_sha256 IS NULL
      OR source_ref_sha256 ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT governed_subject_relation_workspace_fkey
    FOREIGN KEY (workspace_id) REFERENCES public.workspace(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT governed_subject_relation_authority_fkey
    FOREIGN KEY (scope_key, authority_id)
    REFERENCES public.execution_budget_authority(scope_key, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT governed_subject_relation_account_fkey
    FOREIGN KEY (scope_key, account_id)
    REFERENCES public.tool_budget_account(scope_key, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT governed_subject_relation_operation_fkey
    FOREIGN KEY (scope_key, operation_id)
    REFERENCES public.tool_budget_operation(scope_key, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT governed_subject_relation_operation_subject_fkey
    FOREIGN KEY (workspace_id, operation_subject_id)
    REFERENCES public.tool_operation_subject(workspace_id, subject_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT governed_subject_relation_parent_fkey
    FOREIGN KEY (workspace_id, parent_subject_id)
    REFERENCES public.governed_subject(workspace_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT governed_subject_relation_child_fkey
    FOREIGN KEY (workspace_id, child_subject_id)
    REFERENCES public.governed_subject(workspace_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT governed_subject_relation_ack_fkey
    FOREIGN KEY (ack_id) REFERENCES public.execution_domain_ack(ack_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE public.governed_subject_tombstone (
  workspace_id UUID NOT NULL,
  governed_subject_id UUID NOT NULL,
  tombstoned_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT governed_subject_tombstone_pkey
    PRIMARY KEY (workspace_id, governed_subject_id),
  CONSTRAINT governed_subject_tombstone_workspace_fkey
    FOREIGN KEY (workspace_id) REFERENCES public.workspace(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT governed_subject_tombstone_subject_fkey
    FOREIGN KEY (workspace_id, governed_subject_id)
    REFERENCES public.governed_subject(workspace_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE public.governed_subject_tombstone_audit (
  deletion_request_id UUID NOT NULL,
  workspace_id UUID NOT NULL,
  governed_subject_id UUID NOT NULL,
  tombstoned_at TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT governed_subject_tombstone_audit_pkey
    PRIMARY KEY (deletion_request_id),
  CONSTRAINT governed_subject_tombstone_audit_request_fkey
    FOREIGN KEY (deletion_request_id) REFERENCES public.deletion_request(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT governed_subject_tombstone_audit_workspace_fkey
    FOREIGN KEY (workspace_id) REFERENCES public.workspace(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT governed_subject_tombstone_audit_subject_fkey
    FOREIGN KEY (workspace_id, governed_subject_id)
    REFERENCES public.governed_subject_tombstone(workspace_id, governed_subject_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX governed_subject_workspace_dsr_idx
  ON public.governed_subject (workspace_id, dsr_subject_type, dsr_subject_id);
CREATE INDEX tool_operation_subject_authority_operation_idx
  ON public.tool_operation_subject (scope_key, authority_id, account_id, operation_id, operation_generation);
CREATE INDEX governed_subject_relation_operation_parent_idx
  ON public.governed_subject_relation (workspace_id, operation_id, parent_subject_id);
CREATE INDEX governed_subject_relation_operation_child_idx
  ON public.governed_subject_relation (workspace_id, operation_id, child_subject_id);
CREATE INDEX governed_subject_tombstone_workspace_time_idx
  ON public.governed_subject_tombstone (workspace_id, tombstoned_at);
CREATE INDEX governed_subject_tombstone_audit_subject_idx
  ON public.governed_subject_tombstone_audit (workspace_id, governed_subject_id, tombstoned_at);

ALTER TABLE public.governed_subject ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.governed_subject FORCE ROW LEVEL SECURITY;
CREATE POLICY governed_subject_workspace_isolation ON public.governed_subject
  USING (workspace_id = public.current_workspace_id())
  WITH CHECK (workspace_id = public.current_workspace_id());

ALTER TABLE public.tool_operation_subject ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tool_operation_subject FORCE ROW LEVEL SECURITY;
CREATE POLICY tool_operation_subject_workspace_isolation ON public.tool_operation_subject
  USING (workspace_id = public.current_workspace_id())
  WITH CHECK (workspace_id = public.current_workspace_id());

ALTER TABLE public.governed_subject_relation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.governed_subject_relation FORCE ROW LEVEL SECURITY;
CREATE POLICY governed_subject_relation_workspace_isolation ON public.governed_subject_relation
  USING (workspace_id = public.current_workspace_id())
  WITH CHECK (workspace_id = public.current_workspace_id());

ALTER TABLE public.governed_subject_tombstone ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.governed_subject_tombstone FORCE ROW LEVEL SECURITY;
CREATE POLICY governed_subject_tombstone_workspace_isolation ON public.governed_subject_tombstone
  USING (workspace_id = public.current_workspace_id())
  WITH CHECK (workspace_id = public.current_workspace_id());

ALTER TABLE public.governed_subject_tombstone_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.governed_subject_tombstone_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY governed_subject_tombstone_audit_workspace_isolation ON public.governed_subject_tombstone_audit
  USING (workspace_id = public.current_workspace_id())
  WITH CHECK (workspace_id = public.current_workspace_id());

REVOKE ALL ON TABLE public.governed_subject FROM
  PUBLIC, app_user, execution_budget_platform_writer,
  runtime_api, runtime_worker, runtime_outbox_relay;
REVOKE ALL ON TABLE public.tool_operation_subject FROM
  PUBLIC, app_user, execution_budget_platform_writer,
  runtime_api, runtime_worker, runtime_outbox_relay;
REVOKE ALL ON TABLE public.governed_subject_relation FROM
  PUBLIC, app_user, execution_budget_platform_writer,
  runtime_api, runtime_worker, runtime_outbox_relay;
REVOKE ALL ON TABLE public.governed_subject_tombstone FROM
  PUBLIC, app_user, execution_budget_platform_writer,
  runtime_api, runtime_worker, runtime_outbox_relay;
REVOKE ALL ON TABLE public.governed_subject_tombstone_audit FROM
  PUBLIC, app_user, execution_budget_platform_writer,
  runtime_api, runtime_worker, runtime_outbox_relay;

COMMIT;
