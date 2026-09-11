-- Additive ACK delivery persistence. A controlled caller signs and encrypts;
-- SQL binds the ciphertext to immutable committed revocation receipt facts.
-- Forward-only: rollback must never erase a delivered ACK or revocation fact.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE platform_fence_ack_delivery (
  receipt_id UUID PRIMARY KEY,
  command_token_sha256 VARCHAR(64) NOT NULL CHECK (command_token_sha256 ~ '^[0-9a-f]{64}$'),
  ack_token_sha256 VARCHAR(64) NOT NULL CHECK (ack_token_sha256 ~ '^[0-9a-f]{64}$'),
  signing_key_id VARCHAR(64) NOT NULL CHECK (signing_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  cipher_key_id VARCHAR(64) NOT NULL CHECK (cipher_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  ciphertext BYTEA NOT NULL CHECK (octet_length(ciphertext) BETWEEN 29 AND 16412),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT platform_fence_ack_delivery_receipt_fkey FOREIGN KEY (receipt_id)
    REFERENCES platform_revocation_receipt(id) ON DELETE NO ACTION ON UPDATE NO ACTION
);
COMMENT ON TABLE platform_fence_ack_delivery IS
  'First committed encrypted ACK wins. No raw JWS, and no change to revocation receipt facts. Crypto verification is caller-owned.';
ALTER TABLE platform_fence_ack_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_fence_ack_delivery FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform_fence_ack_delivery FROM PUBLIC, app_user, runtime_api,
  runtime_worker, runtime_outbox_relay, execution_budget_platform_writer;

CREATE FUNCTION reject_platform_fence_ack_mutation_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'PLATFORM_FENCE_ACK_IMMUTABLE' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER platform_fence_ack_delivery_immutable
  BEFORE UPDATE OR DELETE ON platform_fence_ack_delivery
  FOR EACH ROW EXECUTE FUNCTION reject_platform_fence_ack_mutation_v1();
CREATE TRIGGER platform_fence_ack_delivery_no_truncate
  BEFORE TRUNCATE ON platform_fence_ack_delivery
  FOR EACH STATEMENT EXECUTE FUNCTION reject_platform_fence_ack_mutation_v1();
REVOKE ALL ON FUNCTION reject_platform_fence_ack_mutation_v1() FROM PUBLIC;

CREATE FUNCTION read_platform_fence_ack_v1(p_receipt_id UUID, p_command_sha TEXT)
RETURNS TABLE(receipt_id UUID, command_token_sha256 TEXT, ack_token_sha256 TEXT,
  signing_key_id TEXT, cipher_key_id TEXT, ciphertext BYTEA)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  stored_command_sha TEXT;
BEGIN
  PERFORM assert_execution_budget_platform_writer_principal();
  IF p_receipt_id IS NULL OR p_command_sha IS NULL OR p_command_sha !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'PLATFORM_FENCE_ACK_INVALID' USING ERRCODE = 'P0001';
  END IF;
  -- Serialize readers and first writers on the immutable parent; never rewrite it.
  SELECT r.token_sha256 INTO stored_command_sha FROM platform_revocation_receipt r
    WHERE r.id = p_receipt_id FOR UPDATE;
  IF stored_command_sha IS NULL OR stored_command_sha IS DISTINCT FROM p_command_sha THEN
    RAISE EXCEPTION 'PLATFORM_FENCE_ACK_BINDING_INVALID' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY SELECT d.receipt_id, d.command_token_sha256::text, d.ack_token_sha256::text,
    d.signing_key_id::text, d.cipher_key_id::text, d.ciphertext
    FROM platform_fence_ack_delivery d WHERE d.receipt_id = p_receipt_id;
END $$;

CREATE FUNCTION store_platform_fence_ack_v1(
  p_receipt_id UUID, p_command_sha TEXT, p_ack_sha TEXT,
  p_signing_kid TEXT, p_cipher_kid TEXT, p_ciphertext BYTEA
)
RETURNS TABLE(receipt_id UUID, command_token_sha256 TEXT, ack_token_sha256 TEXT,
  signing_key_id TEXT, cipher_key_id TEXT, ciphertext BYTEA)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  stored_command_sha TEXT;
BEGIN
  PERFORM assert_execution_budget_platform_writer_principal();
  IF p_receipt_id IS NULL OR p_command_sha IS NULL OR p_command_sha !~ '^[0-9a-f]{64}$'
    OR p_ack_sha IS NULL OR p_ack_sha !~ '^[0-9a-f]{64}$'
    OR p_signing_kid IS NULL OR p_signing_kid !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    OR p_cipher_kid IS NULL OR p_cipher_kid !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 29 AND 16412 THEN
    RAISE EXCEPTION 'PLATFORM_FENCE_ACK_INVALID' USING ERRCODE = 'P0001';
  END IF;
  SELECT r.token_sha256 INTO stored_command_sha FROM platform_revocation_receipt r
    WHERE r.id = p_receipt_id FOR UPDATE;
  IF stored_command_sha IS NULL OR stored_command_sha IS DISTINCT FROM p_command_sha THEN
    RAISE EXCEPTION 'PLATFORM_FENCE_ACK_BINDING_INVALID' USING ERRCODE = 'P0001';
  END IF;
  -- An encrypted candidate is not replay authority. Concurrent retries may have
  -- different IV/signature/key ids; the first stored row is the only winner.
  IF NOT EXISTS (SELECT 1 FROM platform_fence_ack_delivery d WHERE d.receipt_id = p_receipt_id) THEN
    INSERT INTO platform_fence_ack_delivery(receipt_id, command_token_sha256,
      ack_token_sha256, signing_key_id, cipher_key_id, ciphertext)
    VALUES (p_receipt_id, p_command_sha, p_ack_sha, p_signing_kid, p_cipher_kid, p_ciphertext);
  END IF;
  RETURN QUERY SELECT d.receipt_id, d.command_token_sha256::text, d.ack_token_sha256::text,
    d.signing_key_id::text, d.cipher_key_id::text, d.ciphertext
    FROM platform_fence_ack_delivery d WHERE d.receipt_id = p_receipt_id;
END $$;

REVOKE ALL ON FUNCTION read_platform_fence_ack_v1(UUID,TEXT),
  store_platform_fence_ack_v1(UUID,TEXT,TEXT,TEXT,TEXT,BYTEA)
  FROM PUBLIC, app_user, runtime_api, runtime_worker, runtime_outbox_relay, execution_budget_platform_writer;
GRANT EXECUTE ON FUNCTION read_platform_fence_ack_v1(UUID,TEXT),
  store_platform_fence_ack_v1(UUID,TEXT,TEXT,TEXT,TEXT,BYTEA)
  TO execution_budget_platform_writer;
COMMIT;
