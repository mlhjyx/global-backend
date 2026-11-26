-- MT-P2: Widen source_channel_record PII columns from VARCHAR to TEXT so enc:v2 ciphertexts
-- (platform:source_channel_record scope with random 12B IVs) fit without truncation.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "source_channel_record"
  ALTER COLUMN "contact_name" TYPE TEXT,
  ALTER COLUMN "contact_title" TYPE TEXT,
  ALTER COLUMN "email" TYPE TEXT,
  ALTER COLUMN "phone" TYPE TEXT;

COMMIT;
