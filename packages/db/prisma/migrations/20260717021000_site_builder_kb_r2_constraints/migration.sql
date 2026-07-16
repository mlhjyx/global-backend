-- R2-A2 constraint/state-machine phase. The preceding data migration guarantees the
-- nullable unique and composite provenance FKs can be added without hiding bad history.

ALTER TABLE asset ADD COLUMN processing_error_code text;

ALTER TABLE asset DROP CONSTRAINT asset_processing_status_check;
ALTER TABLE asset ADD CONSTRAINT asset_processing_status_check CHECK (
  processing_status IN (
    'pending_upload', 'committing', 'queued', 'processing', 'ready', 'failed',
    'failed_retryable', 'failed_terminal', 'rejected', 'duplicate', 'deleted'
  )
) NOT VALID;
ALTER TABLE asset VALIDATE CONSTRAINT asset_processing_status_check;

ALTER TABLE asset DROP CONSTRAINT asset_commit_lease_shape_check;
ALTER TABLE asset ADD CONSTRAINT asset_processing_lease_shape_check CHECK (
  (processing_status IN ('committing', 'processing') AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
  OR
  (processing_status NOT IN ('committing', 'processing') AND lease_token IS NULL AND lease_until IS NULL)
) NOT VALID;
ALTER TABLE asset VALIDATE CONSTRAINT asset_processing_lease_shape_check;

ALTER TABLE asset ADD CONSTRAINT asset_processing_attempt_nonnegative_check
  CHECK (processing_attempt >= 0) NOT VALID;
ALTER TABLE asset VALIDATE CONSTRAINT asset_processing_attempt_nonnegative_check;

ALTER TABLE asset ADD CONSTRAINT asset_retry_at_shape_check
  CHECK (retry_at IS NULL OR processing_status IN ('queued', 'failed_retryable')) NOT VALID;
ALTER TABLE asset VALIDATE CONSTRAINT asset_retry_at_shape_check;

ALTER TABLE asset ADD CONSTRAINT asset_processing_error_code_shape_check
  CHECK (processing_error_code IS NULL OR processing_status IN ('queued', 'failed_terminal')) NOT VALID;
ALTER TABLE asset VALIDATE CONSTRAINT asset_processing_error_code_shape_check;

ALTER TABLE kb_document ADD CONSTRAINT kb_document_status_check
  CHECK (status IN ('queued', 'parsing', 'chunking', 'embedding', 'ready', 'failed')) NOT VALID;
ALTER TABLE kb_document VALIDATE CONSTRAINT kb_document_status_check;

ALTER TABLE kb_document ADD CONSTRAINT kb_document_upload_asset_shape_check
  CHECK ((source = 'upload') = (asset_id IS NOT NULL)) NOT VALID;
ALTER TABLE kb_document VALIDATE CONSTRAINT kb_document_upload_asset_shape_check;

CREATE UNIQUE INDEX asset_id_workspace_id_site_id_key
  ON asset(id, workspace_id, site_id);
CREATE UNIQUE INDEX kb_document_asset_id_key
  ON kb_document(asset_id);
CREATE UNIQUE INDEX kb_document_id_workspace_id_key
  ON kb_document(id, workspace_id);

ALTER TABLE kb_document ADD CONSTRAINT kb_document_asset_scope_fkey
  FOREIGN KEY (asset_id, workspace_id, site_id)
  REFERENCES asset(id, workspace_id, site_id)
  ON DELETE CASCADE
  NOT VALID;
ALTER TABLE kb_document VALIDATE CONSTRAINT kb_document_asset_scope_fkey;

ALTER TABLE kb_chunk DROP CONSTRAINT kb_chunk_document_id_fkey;
ALTER TABLE kb_chunk ADD CONSTRAINT kb_chunk_document_workspace_fkey
  FOREIGN KEY (document_id, workspace_id)
  REFERENCES kb_document(id, workspace_id)
  ON DELETE CASCADE
  NOT VALID;
ALTER TABLE kb_chunk VALIDATE CONSTRAINT kb_chunk_document_workspace_fkey;

CREATE INDEX asset_kb_queued_due_idx
  ON asset(workspace_id, site_id, retry_at, created_at)
  WHERE kind = 'doc' AND processing_status = 'queued' AND deleted_at IS NULL;
CREATE INDEX asset_kb_processing_expired_idx
  ON asset(workspace_id, lease_until, created_at)
  WHERE kind = 'doc' AND processing_status = 'processing' AND deleted_at IS NULL;
