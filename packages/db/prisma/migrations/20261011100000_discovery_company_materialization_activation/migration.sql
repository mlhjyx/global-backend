-- Release B of governed Discovery company materialization (C-TX,
-- docs/superpowers/plans/2026-08-30-discovery-company-materialization-ctx.md): activates the
-- discovery-company-materialization/v1 contract that Release A (20260830130300 schema,
-- 20260830130400 functions) installed inactive.
--
-- Every run the API has created since Release A carries the v1 marker, and without this row
-- admit_discovery_company_materialization_v1 refuses each of them at canonicalize with the
-- non-retryable DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_UNAVAILABLE. After it, v1 runs are
-- admitted as GOVERNED_C_TX, runs without the marker keep the LEGACY path they were admitted
-- under, and the discovery_run insert guard requires the marker on every new run.
--
-- The only change is the activation singleton, written through the Release A insert guard
-- (transaction-local setting plus the exact row). No run, admission or receipt is backfilled
-- or rewritten. The row is immutable (UPDATE and DELETE are rejected), so the activation cannot
-- be rolled back: the rollback is not to deploy it.
--
-- Deploy in name order in the same maintenance window as the image that carries this migration
-- (that image writes the v1 marker), with the runtime stopped, no discovery run in flight and a
-- fresh database backup. SHA-256(UTF-8 "discovery-company-materialization/v1", no newline):
-- 558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL app.discovery_company_materialization_activation_v1 =
  '558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe';

INSERT INTO public.discovery_company_materialization_activation(
  activation_id,contract_version,contract_sha256)
VALUES(1,'discovery-company-materialization/v1',
  '558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe');

COMMIT;
