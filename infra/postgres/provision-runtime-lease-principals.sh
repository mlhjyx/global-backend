#!/usr/bin/env bash
set -euo pipefail

required=(
  RUNTIME_LEASE_PROVISION_DATABASE_URL
  RUNTIME_API_LEASE_LOGIN
  RUNTIME_API_LEASE_PASSWORD
  RUNTIME_WORKER_LEASE_LOGIN
  RUNTIME_WORKER_LEASE_PASSWORD
  RUNTIME_OUTBOX_RELAY_LEASE_LOGIN
  RUNTIME_OUTBOX_RELAY_LEASE_PASSWORD
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "runtime lease principal provisioning requires ${name}" >&2
    exit 1
  fi
done

logins=(
  "${RUNTIME_API_LEASE_LOGIN}"
  "${RUNTIME_WORKER_LEASE_LOGIN}"
  "${RUNTIME_OUTBOX_RELAY_LEASE_LOGIN}"
)
for login in "${logins[@]}"; do
  if [[ ! "${login}" =~ ^[a-z][a-z0-9_]{2,62}$ ]] ||
    [[ "${login}" == "app_user" || "${login}" == "global" ]]; then
    echo "runtime lease login names must be distinct bounded service principals" >&2
    exit 1
  fi
done
if [[ "${logins[0]}" == "${logins[1]}" ||
  "${logins[0]}" == "${logins[2]}" ||
  "${logins[1]}" == "${logins[2]}" ]]; then
  echo "one runtime lease login cannot own multiple process roles" >&2
  exit 1
fi

runtime_connection="$(node - <<'NODE'
const value = process.env.RUNTIME_LEASE_PROVISION_DATABASE_URL;
let url;
try {
  url = new URL(value);
} catch {
  process.exit(1);
}
if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || !url.pathname || url.search || url.hash) process.exit(1);
const output = {
  PGHOST: url.hostname,
  PGPORT: url.port || '5432',
  PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
};
for (const [name, entry] of Object.entries(output)) {
  if (/[\0\r\n]/.test(entry)) process.exit(1);
  process.stdout.write(`${name}=${entry}\n`);
}
NODE
)" || { echo "runtime lease provisioning database URL is invalid" >&2; exit 1; }

while IFS= read -r setting; do
  [[ "${setting}" =~ ^PG(HOST|PORT|DATABASE|USER|PASSWORD)= ]] || {
    echo "runtime lease provisioning database URL parser emitted invalid data" >&2
    exit 1
  }
  export "${setting}"
done <<< "${runtime_connection}"

psql \
  --no-psqlrc \
  --set ON_ERROR_STOP=1 \
  --set api_login="${RUNTIME_API_LEASE_LOGIN}" \
  --set worker_login="${RUNTIME_WORKER_LEASE_LOGIN}" \
  --set relay_login="${RUNTIME_OUTBOX_RELAY_LEASE_LOGIN}" <<'SQL'
\getenv api_password RUNTIME_API_LEASE_PASSWORD
\getenv worker_password RUNTIME_WORKER_LEASE_PASSWORD
\getenv relay_password RUNTIME_OUTBOX_RELAY_LEASE_PASSWORD
SELECT format(
  'CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'api_login', :'api_password'
) WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'api_login') \gexec
SELECT format(
  'CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'worker_login', :'worker_password'
) WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'worker_login') \gexec
SELECT format(
  'CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'relay_login', :'relay_password'
) WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'relay_login') \gexec

SELECT format(
  'ALTER ROLE %I WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'api_login', :'api_password'
) \gexec
SELECT format(
  'ALTER ROLE %I WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'worker_login', :'worker_password'
) \gexec
SELECT format(
  'ALTER ROLE %I WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'relay_login', :'relay_password'
) \gexec

SELECT format(
  'REVOKE runtime_api, runtime_worker, runtime_outbox_relay FROM %I',
  :'api_login'
) \gexec
SELECT format(
  'REVOKE runtime_api, runtime_worker, runtime_outbox_relay FROM %I',
  :'worker_login'
) \gexec
SELECT format(
  'REVOKE runtime_api, runtime_worker, runtime_outbox_relay FROM %I',
  :'relay_login'
) \gexec

-- Never silently retain an owner, monitoring, or other inherited role. An
-- operator must remove unexpected memberships explicitly after reviewing them.
SELECT 1 / ((NOT EXISTS (
  SELECT 1 FROM pg_auth_members membership
  JOIN pg_roles member_role ON member_role.oid = membership.member
  WHERE member_role.rolname = :'api_login'
))::integer);
SELECT 1 / ((NOT EXISTS (
  SELECT 1 FROM pg_auth_members membership
  JOIN pg_roles member_role ON member_role.oid = membership.member
  WHERE member_role.rolname = :'worker_login'
))::integer);
SELECT 1 / ((NOT EXISTS (
  SELECT 1 FROM pg_auth_members membership
  JOIN pg_roles member_role ON member_role.oid = membership.member
  WHERE member_role.rolname = :'relay_login'
))::integer);

SELECT format('GRANT runtime_api TO %I', :'api_login') \gexec
SELECT format('GRANT runtime_worker TO %I', :'worker_login') \gexec
SELECT format('GRANT runtime_outbox_relay TO %I', :'relay_login') \gexec
SQL

echo "runtime lease principals provisioned with exclusive role membership"
