#!/usr/bin/env bash
set -euo pipefail

required=(
  EXECUTION_BUDGET_PLATFORM_WRITER_PROVISION_DATABASE_URL
  EXECUTION_BUDGET_PLATFORM_WRITER_LOGIN
  EXECUTION_BUDGET_PLATFORM_WRITER_PASSWORD
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "platform writer provisioning requires ${name}" >&2
    exit 1
  fi
done

login="${EXECUTION_BUDGET_PLATFORM_WRITER_LOGIN}"
if [[ ! "${login}" =~ ^[a-z][a-z0-9_]{2,62}$ ]] ||
  [[ "${login}" == "app_user" || "${login}" == "global" ||
    "${login}" == "execution_budget_platform_writer" ||
    "${login}" == "runtime_api" || "${login}" == "runtime_worker" ||
    "${login}" == "runtime_outbox_relay" ]]; then
  echo "platform writer login must be a bounded dedicated service principal" >&2
  exit 1
fi

connection="$(node - <<'NODE'
const value = process.env.EXECUTION_BUDGET_PLATFORM_WRITER_PROVISION_DATABASE_URL;
let url;
try { url = new URL(value); } catch { process.exit(1); }
if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || !url.pathname || url.search || url.hash) process.exit(1);
const fields = { PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password) };
for (const [name, field] of Object.entries(fields)) {
  if (!field || /[\0\r\n]/.test(field)) process.exit(1);
  process.stdout.write(`${name}=${field}\n`);
}
NODE
)" || { echo "platform writer provisioning database URL is invalid" >&2; exit 1; }
while IFS= read -r setting; do
  [[ "${setting}" =~ ^PG(HOST|PORT|DATABASE|USER|PASSWORD)= ]] || { echo "platform writer provisioning URL parser emitted invalid data" >&2; exit 1; }
  export "${setting}"
done <<< "${connection}"

psql --no-psqlrc --set ON_ERROR_STOP=1 --set platform_writer_login="${login}" <<'SQL'
\getenv platform_writer_password EXECUTION_BUDGET_PLATFORM_WRITER_PASSWORD
-- The migration-owned group is never repaired here: topology drift is a hard stop.
SELECT 1 / ((EXISTS (
  SELECT 1 FROM pg_roles group_role
  WHERE group_role.rolname = 'execution_budget_platform_writer'
    AND NOT group_role.rolcanlogin AND NOT group_role.rolsuper
    AND NOT group_role.rolbypassrls AND NOT group_role.rolcreatedb
    AND NOT group_role.rolcreaterole AND NOT group_role.rolreplication
) AND NOT EXISTS (
  SELECT 1 FROM pg_auth_members membership
  JOIN pg_roles group_role ON group_role.oid = membership.member
  WHERE group_role.rolname = 'execution_budget_platform_writer'
) AND NOT EXISTS (
  SELECT 1 FROM pg_auth_members membership
  JOIN pg_roles group_role ON group_role.oid = membership.roleid
  JOIN pg_roles nested_member ON nested_member.oid = membership.member
  WHERE group_role.rolname = 'execution_budget_platform_writer'
    AND NOT nested_member.rolcanlogin
))::integer);

-- An existing login may already have the one intended membership, but any
-- unexpected direct membership is an operator-reviewed failure, never auto-revoked.
SELECT 1 / ((NOT EXISTS (
  SELECT 1 FROM pg_auth_members membership
  JOIN pg_roles granted ON granted.oid = membership.roleid
  JOIN pg_roles principal ON principal.oid = membership.member
  WHERE principal.rolname = :'platform_writer_login'
    AND granted.rolname <> 'execution_budget_platform_writer'
))::integer);

SELECT format(
  'CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'platform_writer_login', :'platform_writer_password'
) WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'platform_writer_login') \gexec
SELECT format(
  'ALTER ROLE %I WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'platform_writer_login', :'platform_writer_password'
) \gexec
SELECT format('GRANT execution_budget_platform_writer TO %I', :'platform_writer_login')
WHERE NOT pg_has_role(:'platform_writer_login', 'execution_budget_platform_writer', 'member') \gexec
SQL

echo "platform writer principal provisioned with exclusive membership"
