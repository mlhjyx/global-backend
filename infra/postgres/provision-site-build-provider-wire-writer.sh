#!/usr/bin/env bash
set -euo pipefail

required=(
  SITE_BUILD_PROVIDER_WIRE_PROVISION_DATABASE_URL
  SITE_BUILD_PROVIDER_WIRE_LOGIN
  SITE_BUILD_PROVIDER_WIRE_PASSWORD
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "provider-wire writer provisioning requires ${name}" >&2
    exit 1
  fi
done

login="${SITE_BUILD_PROVIDER_WIRE_LOGIN}"
if [[ ! "${login}" =~ ^[a-z][a-z0-9_]{2,62}$ ]] ||
  [[ "${login}" == "app_user" || "${login}" == "global" ||
    "${login}" == "postgres" || "${login}" == "runtime_api" ||
    "${login}" == "runtime_worker" ||
    "${login}" == "runtime_outbox_relay" ]]; then
  echo "provider-wire writer login must be a bounded dedicated principal" >&2
  exit 1
fi
for reserved_login in \
  "${RUNTIME_API_LEASE_LOGIN:-}" \
  "${RUNTIME_WORKER_LEASE_LOGIN:-}" \
  "${RUNTIME_OUTBOX_RELAY_LEASE_LOGIN:-}" \
  "${EXECUTION_BUDGET_PLATFORM_WRITER_LOGIN:-}"; do
  if [[ -n "${reserved_login}" && "${login}" == "${reserved_login}" ]]; then
    echo "provider-wire writer login cannot reuse another runtime principal" >&2
    exit 1
  fi
done

connection="$(node - <<'NODE'
const value = process.env.SITE_BUILD_PROVIDER_WIRE_PROVISION_DATABASE_URL;
let url;
try { url = new URL(value); } catch { process.exit(1); }
if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || !/^\/[A-Za-z0-9_.-]+$/.test(url.pathname) || url.search || url.hash) process.exit(1);
const fields = { PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password) };
for (const [name, field] of Object.entries(fields)) {
  if (!field || /[\0\r\n]/.test(field)) process.exit(1);
  process.stdout.write(`${name}=${field}\n`);
}
NODE
)" || { echo "provider-wire provisioning database URL is invalid" >&2; exit 1; }
while IFS= read -r setting; do
  [[ "${setting}" =~ ^PG(HOST|PORT|DATABASE|USER|PASSWORD)= ]] || {
    echo "provider-wire provisioning URL parser emitted invalid data" >&2
    exit 1
  }
  export "${setting}"
done <<< "${connection}"

psql --no-psqlrc --set ON_ERROR_STOP=1 --set provider_wire_login="${login}" <<'SQL'
\getenv provider_wire_password SITE_BUILD_PROVIDER_WIRE_PASSWORD
BEGIN;

SELECT 1 / ((EXISTS (
  SELECT 1 FROM pg_roles role
  WHERE role.rolname = 'app_user'
    AND NOT role.rolsuper AND NOT role.rolbypassrls
    AND NOT role.rolcreatedb AND NOT role.rolcreaterole
    AND NOT role.rolreplication
) AND EXISTS (
  SELECT 1 FROM pg_roles role
  WHERE role.rolname = 'runtime_worker'
    AND NOT role.rolcanlogin AND NOT role.rolsuper
    AND NOT role.rolbypassrls AND NOT role.rolcreatedb
    AND NOT role.rolcreaterole AND NOT role.rolreplication
))::integer);

SELECT 1 / ((
  NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'provider_wire_login')
  OR EXISTS (
    SELECT 1 FROM pg_roles principal
    WHERE principal.rolname = :'provider_wire_login'
      AND principal.rolcanlogin AND principal.rolinherit
      AND NOT principal.rolsuper AND NOT principal.rolbypassrls
      AND NOT principal.rolcreatedb AND NOT principal.rolcreaterole
      AND NOT principal.rolreplication
      AND NOT EXISTS (
        SELECT 1 FROM pg_auth_members membership
        JOIN pg_roles granted ON granted.oid = membership.roleid
        WHERE membership.member = principal.oid
          AND (
            granted.rolname NOT IN ('app_user', 'runtime_worker')
            OR membership.admin_option
            OR NOT membership.inherit_option
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_auth_members membership
        WHERE membership.roleid = principal.oid
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_shdepend dependency
        WHERE dependency.refclassid = 'pg_authid'::regclass
          AND dependency.refobjid = principal.oid
      )
  )
)::integer);

SELECT format(
  'CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'provider_wire_login', :'provider_wire_password'
) WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = :'provider_wire_login'
) \gexec
SELECT format(
  'ALTER ROLE %I WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'provider_wire_login', :'provider_wire_password'
) \gexec
SELECT format('GRANT app_user, runtime_worker TO %I', :'provider_wire_login') \gexec

SELECT 1 / ((
  SELECT array_agg(granted.rolname ORDER BY granted.rolname)
  FROM pg_auth_members membership
  JOIN pg_roles member_role ON member_role.oid = membership.member
  JOIN pg_roles granted ON granted.oid = membership.roleid
  WHERE member_role.rolname = :'provider_wire_login'
) = ARRAY['app_user','runtime_worker']::name[] AND NOT EXISTS (
  SELECT 1 FROM pg_auth_members membership
  JOIN pg_roles member_role ON member_role.oid = membership.member
  WHERE member_role.rolname = :'provider_wire_login'
    AND (membership.admin_option OR NOT membership.inherit_option)
))::integer;
COMMIT;
SQL

echo "provider-wire writer principal provisioned with exact dual membership"
