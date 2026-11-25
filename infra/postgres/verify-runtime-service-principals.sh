#!/usr/bin/env bash
set -euo pipefail

# Verifies that runtime service principals connect cleanly with exact
# NOSUPERUSER/NOBYPASSRLS/single-group-membership invariants and that
# app_user has zero write/delete privileges on the 16 un-RLS'd platform tables.

for var in OUTBOX_RELAY_DATABASE_URL MEMORY_OUTBOX_DATABASE_URL CUSTOMER_WORKER_OPS_DATABASE_URL; do
  if [[ -z "${!var:-}" ]]; then
    echo "${var} is required" >&2
    exit 1
  fi
done

run_psql_from_env() {
  local env_name="$1"
  shift
  local parsed
  parsed="$(node - "$env_name" <<'NODE'
const value = process.env[process.argv[2]];
let url;
try { url = new URL(value); } catch { process.exit(1); }
if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || !url.pathname) process.exit(1);
const fields = {
  PGHOST: url.hostname,
  PGPORT: url.port || '5432',
  PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
};
for (const [key, field] of Object.entries(fields)) {
  if (!field || /[\0\r\n]/.test(field)) process.exit(1);
  process.stdout.write(`${key}=${field}\n`);
}
NODE
)" || { echo "${env_name} is invalid" >&2; exit 1; }
  (
    while IFS= read -r line; do
      [[ "${line}" =~ ^PG(HOST|PORT|DATABASE|USER|PASSWORD)= ]] || exit 1
      export "${line}"
    done <<< "${parsed}"
    psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 "$@" >/dev/null
  )
}

verify_one() {
  local label="$1"
  local expected_group="$2"

  run_psql_from_env "${label}" -v expected_group="${expected_group}" <<'SQL'
BEGIN;
SELECT set_config('global.expected_group', :'expected_group', true);
DO $$
DECLARE
  expected_group TEXT := current_setting('global.expected_group');
  principal pg_roles%ROWTYPE;
  memberships TEXT[];
BEGIN
  SELECT * INTO principal FROM pg_roles WHERE rolname = session_user;
  IF principal.oid IS NULL THEN
    RAISE EXCEPTION 'RUNTIME_PRINCIPAL_MISSING: %', session_user;
  END IF;
  IF current_user IS DISTINCT FROM session_user OR COALESCE(current_setting('role', true), '') IS DISTINCT FROM 'none' THEN
    RAISE EXCEPTION 'RUNTIME_PRINCIPAL_SET_ROLE_ACTIVE: % / %', current_user, session_user;
  END IF;
  IF NOT principal.rolcanlogin
     OR NOT principal.rolinherit
     OR principal.rolsuper
     OR principal.rolbypassrls
     OR principal.rolcreatedb
     OR principal.rolcreaterole
     OR principal.rolreplication
     OR session_user IN ('global', 'app_user', 'postgres')
  THEN
    RAISE EXCEPTION 'RUNTIME_PRINCIPAL_ATTRIBUTES_INVALID: %', session_user;
  END IF;

  SELECT COALESCE(array_agg(granted.rolname::text ORDER BY granted.rolname), ARRAY[]::text[])
  INTO memberships
  FROM pg_auth_members m
  JOIN pg_roles granted ON granted.oid = m.roleid
  WHERE m.member = principal.oid;

  IF memberships IS DISTINCT FROM ARRAY[expected_group]::text[] THEN
    RAISE EXCEPTION 'RUNTIME_PRINCIPAL_MEMBERSHIP_MISMATCH: expected [%], got [%]',
      expected_group, array_to_string(memberships, ',');
  END IF;
END $$;
ROLLBACK;
SQL
  echo "[verify-runtime-service-principals] ${label} (${expected_group}) ok"
}

verify_one "OUTBOX_RELAY_DATABASE_URL" "runtime_outbox_relay_worker"
verify_one "MEMORY_OUTBOX_DATABASE_URL" "runtime_memory_outbox_reader"
verify_one "CUSTOMER_WORKER_OPS_DATABASE_URL" "runtime_customer_worker_ops"

if [[ -n "${APP_DATABASE_URL:-}" ]]; then
  run_psql_from_env "APP_DATABASE_URL" <<'SQL'
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'public.monitored_source',
    'public.outreach_global_suppression',
    'public.patent_inventor_cache',
    'public.patent_inventor_tombstone',
    'public.patent_lookup_request',
    'public.signal_ingest',
    'public.source_channel',
    'public.source_channel_health_event',
    'public.source_channel_probe',
    'public.source_channel_record',
    'public.source_channel_run',
    'public.source_entity',
    'public.source_entity_change',
    'public.source_fetch',
    'public.source_signal',
    'public.term_alias'
  ]
  LOOP
    IF has_table_privilege(current_user, tbl, 'INSERT')
       OR has_table_privilege(current_user, tbl, 'UPDATE')
       OR has_table_privilege(current_user, tbl, 'DELETE')
    THEN
      RAISE EXCEPTION 'APP_USER_FORBIDDEN_WRITE_PRIVILEGE: %', tbl;
    END IF;
  END LOOP;
END $$;
SQL
  echo "[verify-runtime-service-principals] app_user 16-table write revocation ok"
fi
