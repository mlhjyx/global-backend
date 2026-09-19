CREATE UNIQUE INDEX lead_workspace_id_id_key ON lead(workspace_id,id);

CREATE TABLE qualification_feedback_receipt (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  event_id UUID NOT NULL,
  opportunity_id UUID NOT NULL,
  lead_id UUID NOT NULL,
  decision_id UUID NOT NULL,
  revision BIGINT NOT NULL CHECK(revision>0),
  decision VARCHAR(16) NOT NULL CHECK(decision IN ('REJECTED','CORRECTED')),
  schema_version VARCHAR(64) NOT NULL CHECK(schema_version='qualification-feedback-reference/v1'),
  event_type VARCHAR(64) NOT NULL CHECK(event_type='QUALIFICATION_DECISION_RECORDED'),
  producer VARCHAR(32) NOT NULL CHECK(producer='growthos-saas'),
  occurred_at VARCHAR(40) NOT NULL,
  event_digest VARCHAR(64) NOT NULL CHECK(event_digest ~ '^[a-f0-9]{64}$'),
  received_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT qualification_feedback_receipt_workspace_id_lead_id_fkey
    FOREIGN KEY(workspace_id,lead_id) REFERENCES lead(workspace_id,id)
    ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX qualification_feedback_event_key ON qualification_feedback_receipt(workspace_id,event_id);
CREATE UNIQUE INDEX qualification_feedback_decision_key ON qualification_feedback_receipt(workspace_id,decision_id);
CREATE UNIQUE INDEX qualification_feedback_revision_key ON qualification_feedback_receipt(workspace_id,opportunity_id,revision);
CREATE INDEX qualification_feedback_receipt_workspace_id_lead_id_idx ON qualification_feedback_receipt(workspace_id,lead_id);

ALTER TABLE qualification_feedback_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE qualification_feedback_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY qualification_feedback_tenant_isolation ON qualification_feedback_receipt
  USING(workspace_id=current_workspace_id()) WITH CHECK(workspace_id=current_workspace_id());
REVOKE ALL ON qualification_feedback_receipt FROM PUBLIC;
GRANT SELECT,INSERT,DELETE ON qualification_feedback_receipt TO app_user;
REVOKE UPDATE ON qualification_feedback_receipt FROM app_user;

-- Deletion remains available to existing tenant erasure/cascade paths.
-- Updating a received event would invalidate its durable acknowledgment.
CREATE FUNCTION prevent_qualification_feedback_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'qualification feedback receipts are immutable' USING ERRCODE='55000'; END
$$;
CREATE TRIGGER qualification_feedback_immutable BEFORE UPDATE ON qualification_feedback_receipt
  FOR EACH ROW EXECUTE FUNCTION prevent_qualification_feedback_update();
