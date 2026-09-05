#!/usr/bin/env bash
set -euo pipefail

required=(
  SITE_BUILD_PROVIDER_WIRE_PROVISION_DATABASE_URL
  SITE_BUILD_PROVIDER_WIRE_DATABASE_URL
  SITE_BUILD_PROVIDER_WIRE_LOGIN
  SITE_BUILD_PROVIDER_WIRE_EXPECTED_MIGRATION_REVISION
  APP_DATABASE_URL
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "provider-wire writer verification requires ${name}" >&2
    exit 1
  fi
done

parse_url() {
  local prefix="$1"
  local variable="$2"
  PREFIX="${prefix}" VALUE="${!variable}" node - <<'NODE'
const prefix = process.env.PREFIX;
let url;
try { url = new URL(process.env.VALUE); } catch { process.exit(1); }
if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || !/^\/[A-Za-z0-9_.-]+$/.test(url.pathname) || url.hash) process.exit(1);
const fields = { HOST: url.hostname, PORT: url.port || '5432', DATABASE: decodeURIComponent(url.pathname.slice(1)), USER: decodeURIComponent(url.username), PASSWORD: decodeURIComponent(url.password) };
for (const [name, field] of Object.entries(fields)) {
  if (!field || /[\0\r\n]/.test(field)) process.exit(1);
  process.stdout.write(`${prefix}_${name}=${field}\n`);
}
NODE
}

admin_connection="$(
  parse_url ADMIN SITE_BUILD_PROVIDER_WIRE_PROVISION_DATABASE_URL
)" || { echo "provider-wire admin URL invalid" >&2; exit 1; }
writer_connection="$(
  parse_url WRITER SITE_BUILD_PROVIDER_WIRE_DATABASE_URL
)" || { echo "provider-wire writer URL invalid" >&2; exit 1; }
app_connection="$(
  parse_url APP APP_DATABASE_URL
)" || { echo "provider-wire app URL invalid" >&2; exit 1; }
while IFS= read -r setting; do export "${setting}"; done <<< "${admin_connection}"
while IFS= read -r setting; do export "${setting}"; done <<< "${writer_connection}"
while IFS= read -r setting; do export "${setting}"; done <<< "${app_connection}"

if [[ "${WRITER_USER}" != "${SITE_BUILD_PROVIDER_WIRE_LOGIN}" ||
  "${APP_USER}" != "app_user" ||
  "${WRITER_HOST}" != "${APP_HOST}" ||
  "${WRITER_PORT}" != "${APP_PORT}" ||
  "${WRITER_DATABASE}" != "${APP_DATABASE}" ||
  "${WRITER_HOST}" != "${ADMIN_HOST}" ||
  "${WRITER_PORT}" != "${ADMIN_PORT}" ||
  "${WRITER_DATABASE}" != "${ADMIN_DATABASE}" ]]; then
  echo "provider-wire writer URL/login target mismatch" >&2
  exit 1
fi
if [[ ! "${SITE_BUILD_PROVIDER_WIRE_EXPECTED_MIGRATION_REVISION}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{2,190}$ ]]; then
  echo "provider-wire expected migration revision is invalid" >&2
  exit 1
fi

run_psql() {
  local prefix="$1"
  shift
  PGHOST="${prefix}_HOST"
  PGPORT="${prefix}_PORT"
  PGDATABASE="${prefix}_DATABASE"
  PGUSER="${prefix}_USER"
  PGPASSWORD="${prefix}_PASSWORD"
  export PGHOST="${!PGHOST}" PGPORT="${!PGPORT}" PGDATABASE="${!PGDATABASE}"
  export PGUSER="${!PGUSER}" PGPASSWORD="${!PGPASSWORD}"
  PGOPTIONS='-c statement_timeout=4000' psql --no-psqlrc --set ON_ERROR_STOP=1 "$@"
}

run_psql WRITER --quiet \
  --set expected_login="${SITE_BUILD_PROVIDER_WIRE_LOGIN}" \
  --set expected_migration="${SITE_BUILD_PROVIDER_WIRE_EXPECTED_MIGRATION_REVISION}" <<'SQL'
SELECT 1 / ((
  SELECT p.rolname = :'expected_login'
    AND current_user = session_user
    AND current_setting('statement_timeout') = '4s'
    AND p.rolcanlogin AND p.rolinherit
    AND NOT p.rolsuper AND NOT p.rolbypassrls
    AND NOT p.rolcreatedb AND NOT p.rolcreaterole AND NOT p.rolreplication
  FROM pg_roles p WHERE p.rolname = session_user
) AND (
  SELECT array_agg(granted.rolname ORDER BY granted.rolname)
  FROM pg_auth_members membership
  JOIN pg_roles granted ON granted.oid = membership.roleid
  WHERE membership.member = (SELECT oid FROM pg_roles WHERE rolname=session_user)
) = ARRAY['app_user','runtime_worker']::name[] AND NOT EXISTS (
  SELECT 1 FROM pg_auth_members membership
  WHERE membership.member = (SELECT oid FROM pg_roles WHERE rolname=session_user)
    AND (membership.admin_option OR NOT membership.inherit_option)
))::integer;

SELECT 1 / ((
  SELECT migration_name = :'expected_migration'
  FROM "_prisma_migrations"
  WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
  ORDER BY finished_at DESC, migration_name DESC LIMIT 1
))::integer;

SELECT 1 / ((
  has_function_privilege(session_user, 'reserve_site_build_model_spend_v1(UUID,UUID,UUID,UUID,VARCHAR,TEXT,TEXT,BIGINT,JSONB,VARCHAR,VARCHAR,VARCHAR,VARCHAR,VARCHAR,VARCHAR,INTEGER,INTEGER,INTEGER,INTEGER,INTEGER,BIGINT,VARCHAR,VARCHAR,VARCHAR,BIGINT,BIGINT,BIGINT)', 'EXECUTE')
  AND has_function_privilege(session_user, 'allocate_site_build_provider_wire_v1(UUID,UUID,UUID,VARCHAR,UUID,VARCHAR,VARCHAR,VARCHAR)', 'EXECUTE')
  AND has_function_privilege(session_user, 'begin_site_build_provider_wire_v1(UUID,UUID,UUID)', 'EXECUTE')
  AND has_function_privilege(session_user, 'claim_site_build_provider_readback_probe_v1(UUID,UUID,INTEGER)', 'EXECUTE')
  AND has_function_privilege(session_user, 'record_site_build_provider_readback_probe_v1(UUID,UUID,VARCHAR,INTEGER,TIMESTAMPTZ)', 'EXECUTE')
  AND has_function_privilege(session_user, 'record_site_build_provider_wire_receipt_v1(UUID,UUID,VARCHAR,VARCHAR,VARCHAR,INTEGER,BIGINT,INTEGER,INTEGER,BIGINT,VARCHAR,TIMESTAMPTZ)', 'EXECUTE')
  AND has_function_privilege(session_user, 'finalize_site_build_provider_wire_v1(UUID,UUID,VARCHAR,VARCHAR,VARCHAR,VARCHAR,VARCHAR,TIMESTAMPTZ)', 'EXECUTE')
  AND has_function_privilege(session_user, 'finalize_site_build_provider_wire_from_receipt_v1(UUID,UUID)', 'EXECUTE')
  AND has_function_privilege(session_user, 'finalize_site_build_provider_wire_not_dispatched_v1(UUID,UUID)', 'EXECUTE')
  AND NOT has_table_privilege(session_user, 'site_build_provider_wire_attempt', 'INSERT,UPDATE,DELETE')
  AND NOT has_table_privilege(session_user, 'site_build_provider_wire_receipt', 'INSERT,UPDATE,DELETE')
  AND NOT has_table_privilege(session_user, 'site_build_provider_readback_probe', 'INSERT,UPDATE,DELETE')
  AND NOT has_table_privilege(session_user, 'site_build_provider_readback_probe_observation', 'INSERT,UPDATE,DELETE')
  AND has_table_privilege(session_user, 'site_build_provider_wire_attempt', 'SELECT')
  AND has_table_privilege(session_user, 'site_build_provider_wire_receipt', 'SELECT')
  AND has_table_privilege(session_user, 'site_build_provider_readback_probe', 'SELECT')
  AND has_table_privilege(session_user, 'site_build_provider_readback_probe_observation', 'SELECT')
))::integer;

SELECT 1 / ((
  SELECT count(*) = 4 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity)
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname = ANY(ARRAY[
    'site_build_provider_wire_attempt','site_build_provider_wire_receipt',
    'site_build_provider_readback_probe','site_build_provider_readback_probe_observation'
  ])
))::integer;
SQL

run_psql ADMIN --quiet <<'SQL'
SELECT 1 / ((
  NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('runtime_api'),
      ('runtime_outbox_relay')
    ) AS denied_roles(role_name)
    CROSS JOIN (VALUES
      ('reserve_site_build_model_spend_v1(UUID,UUID,UUID,UUID,VARCHAR,TEXT,TEXT,BIGINT,JSONB,VARCHAR,VARCHAR,VARCHAR,VARCHAR,VARCHAR,VARCHAR,INTEGER,INTEGER,INTEGER,INTEGER,INTEGER,BIGINT,VARCHAR,VARCHAR,VARCHAR,BIGINT,BIGINT,BIGINT)'),
      ('allocate_site_build_provider_wire_v1(UUID,UUID,UUID,VARCHAR,UUID,VARCHAR,VARCHAR,VARCHAR)'),
      ('begin_site_build_provider_wire_v1(UUID,UUID,UUID)'),
      ('claim_site_build_provider_readback_probe_v1(UUID,UUID,INTEGER)'),
      ('record_site_build_provider_readback_probe_v1(UUID,UUID,VARCHAR,INTEGER,TIMESTAMPTZ)'),
      ('record_site_build_provider_wire_receipt_v1(UUID,UUID,VARCHAR,VARCHAR,VARCHAR,INTEGER,BIGINT,INTEGER,INTEGER,BIGINT,VARCHAR,TIMESTAMPTZ)'),
      ('finalize_site_build_provider_wire_v1(UUID,UUID,VARCHAR,VARCHAR,VARCHAR,VARCHAR,VARCHAR,TIMESTAMPTZ)'),
      ('finalize_site_build_provider_wire_from_receipt_v1(UUID,UUID)'),
      ('finalize_site_build_provider_wire_not_dispatched_v1(UUID,UUID)')
    ) AS worker_functions(signature)
    WHERE has_function_privilege(
      denied_roles.role_name,
      worker_functions.signature,
      'EXECUTE'
    )
  )
))::integer;
SQL

echo "provider-wire writer principal and cross-role denials verified"
