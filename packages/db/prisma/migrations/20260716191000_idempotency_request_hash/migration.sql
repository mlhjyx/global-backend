-- Existing company idempotency rows cannot reconstruct their original request body,
-- so the fingerprint is intentionally nullable and only new hash-aware endpoints set it.
ALTER TABLE "idempotency_key"
ADD COLUMN "request_hash" VARCHAR(64);

-- Defense in depth: application code writes a lowercase SHA-256 hex digest.
ALTER TABLE "idempotency_key"
ADD CONSTRAINT "idempotency_key_request_hash_format"
CHECK ("request_hash" IS NULL OR "request_hash" ~ '^[0-9a-f]{64}$');
