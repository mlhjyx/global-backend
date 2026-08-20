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

psql "${RUNTIME_LEASE_PROVISION_DATABASE_URL}" \
  --no-psqlrc \
  --set ON_ERROR_STOP=1 \
  --set api_login="${RUNTIME_API_LEASE_LOGIN}" \
  --set api_password="${RUNTIME_API_LEASE_PASSWORD}" \
  --set worker_login="${RUNTIME_WORKER_LEASE_LOGIN}" \
  --set worker_password="${RUNTIME_WORKER_LEASE_PASSWORD}" \
  --set relay_login="${RUNTIME_OUTBOX_RELAY_LEASE_LOGIN}" \
  --set relay_password="${RUNTIME_OUTBOX_RELAY_LEASE_PASSWORD}" <<'SQL'
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
