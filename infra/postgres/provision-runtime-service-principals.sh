#!/usr/bin/env bash
set -euo pipefail

# Provisions the dedicated least-privilege PostgreSQL LOGIN principals for
# OutboxRelayService, MemoryEpisodeConsumer, and customer worker ops.
#
# Credentials come from:
#   RUNTIME_SERVICE_PROVISION_DATABASE_URL (or DATABASE_URL fallback)
#   OUTBOX_RELAY_DATABASE_URL        -> group runtime_outbox_relay_worker
#   MEMORY_OUTBOX_DATABASE_URL       -> group runtime_memory_outbox_reader
#   CUSTOMER_WORKER_OPS_DATABASE_URL -> group runtime_customer_worker_ops
#
# Passwords never appear in command-line arguments or logs.

ADMIN_URL="${RUNTIME_SERVICE_PROVISION_DATABASE_URL:-${DATABASE_URL:-}}"
if [[ -z "${ADMIN_URL}" ]]; then
  echo "RUNTIME_SERVICE_PROVISION_DATABASE_URL (or DATABASE_URL) is required" >&2
  exit 1
fi

if [[ -z "${OUTBOX_RELAY_DATABASE_URL:-}" || -z "${MEMORY_OUTBOX_DATABASE_URL:-}" || -z "${CUSTOMER_WORKER_OPS_DATABASE_URL:-}" ]]; then
  echo "OUTBOX_RELAY_DATABASE_URL, MEMORY_OUTBOX_DATABASE_URL, and CUSTOMER_WORKER_OPS_DATABASE_URL are required" >&2
  exit 1
fi

parsed="$(
  ADMIN_URL="${ADMIN_URL}" node - <<'NODE'
const entries = [
  ["OUTBOX_RELAY", process.env.OUTBOX_RELAY_DATABASE_URL, "runtime_outbox_relay_worker"],
  ["MEMORY_OUTBOX", process.env.MEMORY_OUTBOX_DATABASE_URL, "runtime_memory_outbox_reader"],
  ["CUSTOMER_WORKER_OPS", process.env.CUSTOMER_WORKER_OPS_DATABASE_URL, "runtime_customer_worker_ops"],
];
const forbidden = new Set([
  "global",
  "app_user",
  "postgres",
  "runtime_api",
  "runtime_worker",
  "runtime_outbox_relay",
  "runtime_platform_worker",
  "execution_budget_platform_writer",
  "runtime_outbox_relay_worker",
  "runtime_memory_outbox_reader",
  "runtime_customer_worker_ops",
]);
const admin = new URL(process.env.ADMIN_URL);
if (!["postgres:", "postgresql:"].includes(admin.protocol) || !admin.hostname || !admin.username || !admin.password || !admin.pathname) {
  process.exit(1);
}
const adminDb = decodeURIComponent(admin.pathname.slice(1));
const adminUser = decodeURIComponent(admin.username);
const adminFields = {
  PGHOST: admin.hostname,
  PGPORT: admin.port || "5432",
  PGDATABASE: adminDb,
  PGUSER: adminUser,
  PGPASSWORD: decodeURIComponent(admin.password),
};
for (const [key, val] of Object.entries(adminFields)) {
  if (!val || /[\0\r\n]/.test(val)) process.exit(1);
  process.stdout.write(`${key}=${val}\n`);
}
const seenLogins = new Set();
for (const [prefix, rawUrl] of entries) {
  const u = new URL(rawUrl);
  if (!["postgres:", "postgresql:"].includes(u.protocol) || !u.hostname || !u.pathname) process.exit(1);
  const login = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  const db = decodeURIComponent(u.pathname.slice(1));
  if (!login || !password || /[\0\r\n]/.test(login) || /[\0\r\n]/.test(password)) process.exit(1);
  if (!/^[a-z_][a-z0-9_]{2,62}$/u.test(login)) process.exit(1);
  if (forbidden.has(login) || login === adminUser || seenLogins.has(login) || db !== adminDb) process.exit(1);
  seenLogins.add(login);
  process.stdout.write(`${prefix}_LOGIN=${login}\n`);
  process.stdout.write(`${prefix}_PASSWORD=${password}\n`);
}
NODE
)" || { echo "[provision-runtime-service-principals] invalid database URL configuration" >&2; exit 1; }

while IFS= read -r line; do
  [[ "${line}" =~ ^(PG(HOST|PORT|DATABASE|USER|PASSWORD)|(OUTBOX_RELAY|MEMORY_OUTBOX|CUSTOMER_WORKER_OPS)_(LOGIN|PASSWORD))= ]] || exit 1
  export "${line}"
done <<< "${parsed}"

psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 >/dev/null <<'SQL'
\getenv outbox_login OUTBOX_RELAY_LOGIN
\getenv outbox_pw OUTBOX_RELAY_PASSWORD
\getenv memory_login MEMORY_OUTBOX_LOGIN
\getenv memory_pw MEMORY_OUTBOX_PASSWORD
\getenv worker_ops_login CUSTOMER_WORKER_OPS_LOGIN
\getenv worker_ops_pw CUSTOMER_WORKER_OPS_PASSWORD

BEGIN;
SET LOCAL lock_timeout = '5s';

SELECT
  set_config('global.outbox_login', :'outbox_login', true),
  set_config('global.outbox_pw', :'outbox_pw', true),
  set_config('global.memory_login', :'memory_login', true),
  set_config('global.memory_pw', :'memory_pw', true),
  set_config('global.worker_ops_login', :'worker_ops_login', true),
  set_config('global.worker_ops_pw', :'worker_ops_pw', true);

DO $$
DECLARE
  spec RECORD;
  existing pg_roles%ROWTYPE;
  granted_role RECORD;
  db_name TEXT := current_database();
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      (current_setting('global.outbox_login'), current_setting('global.outbox_pw'), 'runtime_outbox_relay_worker'),
      (current_setting('global.memory_login'), current_setting('global.memory_pw'), 'runtime_memory_outbox_reader'),
      (current_setting('global.worker_ops_login'), current_setting('global.worker_ops_pw'), 'runtime_customer_worker_ops')
    ) AS s(login_name, login_password, group_name)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = spec.group_name) THEN
      RAISE EXCEPTION 'FIXED_GROUP_ROLE_MISSING: %', spec.group_name;
    END IF;

    SELECT * INTO existing FROM pg_roles WHERE rolname = spec.login_name;
    IF existing.oid IS NULL THEN
      EXECUTE format(
        'CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
        spec.login_name,
        spec.login_password
      );
    ELSE
      FOR granted_role IN
        SELECT r.rolname
        FROM pg_auth_members m
        JOIN pg_roles r ON r.oid = m.roleid
        WHERE m.member = existing.oid
          AND r.rolname <> spec.group_name
      LOOP
        EXECUTE format('REVOKE %I FROM %I', granted_role.rolname, spec.login_name);
      END LOOP;

      EXECUTE format(
        'ALTER ROLE %I WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
        spec.login_name,
        spec.login_password
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_auth_members m
      JOIN pg_roles mem ON mem.oid = m.member
      JOIN pg_roles grp ON grp.oid = m.roleid
      WHERE mem.rolname = spec.login_name
        AND grp.rolname = spec.group_name
    ) THEN
      EXECUTE format('GRANT %I TO %I', spec.group_name, spec.login_name);
    END IF;
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', db_name, spec.login_name);
  END LOOP;
END $$;

COMMIT;
SQL

unset PGPASSWORD OUTBOX_RELAY_LOGIN OUTBOX_RELAY_PASSWORD MEMORY_OUTBOX_LOGIN MEMORY_OUTBOX_PASSWORD CUSTOMER_WORKER_OPS_LOGIN CUSTOMER_WORKER_OPS_PASSWORD
echo "[provision-runtime-service-principals] provisioned and verified login roles"
