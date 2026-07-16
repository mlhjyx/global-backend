-- Keep validation behind a separate migration transaction. The preceding ADD COLUMN and
-- ADD CONSTRAINT NOT VALID migration must commit before PostgreSQL scans the existing ledger.
ALTER TABLE "idempotency_key"
VALIDATE CONSTRAINT "idempotency_key_request_hash_format";
