#!/usr/bin/env bash
set -euo pipefail

[[ "${EXECUTION_BUDGET_PLATFORM_WRITER_DISPOSABLE_TEST:-}" == 1 ]] || {
  echo DISPOSABLE_MARKER_REQUIRED >&2
  exit 1
}
[[ "${EXECUTION_BUDGET_PLATFORM_WRITER_PROVISION_DATABASE_URL:-}" == *'/global_test' ]] || {
  echo DISPOSABLE_DATABASE_REQUIRED >&2
  exit 1
}
[[ -n "${EXECUTION_BUDGET_PLATFORM_WRITER_PASSWORD:-}" ]] || {
  echo DISPOSABLE_PASSWORD_REQUIRED >&2
  exit 1
}

declare -A admin
parsed="$(node - <<'NODE'
const value = process.env.EXECUTION_BUDGET_PLATFORM_WRITER_PROVISION_DATABASE_URL;
let url;
try { url = new URL(value); } catch { process.exit(1); }
if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname ||
    !url.username || !url.password || !url.pathname || url.search || url.hash) {
  process.exit(1);
}
for (const [key, item] of Object.entries({
  PGHOST: url.hostname,
  PGPORT: url.port || '5432',
  PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
})) {
  if (!item || /[\0\r\n]/.test(item)) process.exit(1);
  process.stdout.write(`${key}=${item}\n`);
}
NODE
)" || {
  echo DISPOSABLE_URL_INVALID >&2
  exit 1
}
while IFS= read -r item; do
  [[ "${item}" =~ ^PG(HOST|PORT|DATABASE|USER|PASSWORD)= ]] || exit 1
  admin["${item%%=*}"]="${item#*=}"
done <<< "${parsed}"

probe_role=task3_existing_writer_probe
member_role=task3_existing_writer_member
original_password="${EXECUTION_BUDGET_PLATFORM_WRITER_PASSWORD}"
candidate_password="${original_password}-candidate"

run_admin() {
  local sql="$1"
  (
    export PGHOST="${admin[PGHOST]}"
    export PGPORT="${admin[PGPORT]}"
    export PGDATABASE="${admin[PGDATABASE]}"
    export PGUSER="${admin[PGUSER]}"
    export PGPASSWORD="${admin[PGPASSWORD]}"
    psql --no-psqlrc --set ON_ERROR_STOP=1 --quiet --command "${sql}" >/dev/null
  )
}

admin_scalar() {
  local sql="$1"
  (
    export PGHOST="${admin[PGHOST]}"
    export PGPORT="${admin[PGPORT]}"
    export PGDATABASE="${admin[PGDATABASE]}"
    export PGUSER="${admin[PGUSER]}"
    export PGPASSWORD="${admin[PGPASSWORD]}"
    psql --no-psqlrc --set ON_ERROR_STOP=1 --quiet --tuples-only --no-align --command "${sql}"
  )
}

authenticate_probe() {
  local password="$1"
  (
    export PGHOST="${admin[PGHOST]}"
    export PGPORT="${admin[PGPORT]}"
    export PGDATABASE="${admin[PGDATABASE]}"
    export PGUSER="${probe_role}"
    export PGPASSWORD="${password}"
    psql --no-psqlrc --set ON_ERROR_STOP=1 --quiet --command 'SELECT 1' >/dev/null 2>&1
  )
}

provision_probe() {
  local password="$1"
  EXECUTION_BUDGET_PLATFORM_WRITER_LOGIN="${probe_role}" \
  EXECUTION_BUDGET_PLATFORM_WRITER_PASSWORD="${password}" \
    bash infra/postgres/provision-execution-budget-platform-writer.sh >/dev/null 2>&1
}

cleanup_probe() {
  run_admin "DROP SCHEMA IF EXISTS task3_existing_writer_owned CASCADE"
  if [[ "$(admin_scalar "SELECT count(*) FROM pg_roles WHERE rolname='${member_role}'")" == 1 ]]; then
    run_admin "DROP ROLE IF EXISTS ${member_role}"
  fi
  if [[ "$(admin_scalar "SELECT count(*) FROM pg_roles WHERE rolname='${probe_role}'")" == 1 ]]; then
    run_admin "DROP OWNED BY ${probe_role}; DROP ROLE ${probe_role}"
  fi
}
trap cleanup_probe EXIT

assert_rejected_before_password_change() {
  local label="$1"
  local failed=0
  if provision_probe "${candidate_password}"; then
    echo "PLATFORM_WRITER_PROVISION_ACCEPTED_${label}" >&2
    failed=1
  fi
  if ! authenticate_probe "${original_password}"; then
    echo "PLATFORM_WRITER_PROVISION_MUTATED_EXISTING_PASSWORD_${label}" >&2
    failed=1
  fi
  if authenticate_probe "${candidate_password}"; then
    echo "PLATFORM_WRITER_PROVISION_INSTALLED_REJECTED_PASSWORD_${label}" >&2
    failed=1
  fi
  return "${failed}"
}

prepare_probe() {
  cleanup_probe
  provision_probe "${original_password}"
}

# A new dedicated principal and an existing safe principal both support rotation.
prepare_probe
provision_probe "${candidate_password}"
authenticate_probe "${candidate_password}" || {
  echo PLATFORM_WRITER_SAFE_ROTATION_FAILED >&2
  exit 1
}
cleanup_probe

failures=0
for attribute in SUPERUSER BYPASSRLS CREATEDB CREATEROLE REPLICATION; do
  prepare_probe
  run_admin "ALTER ROLE ${probe_role} ${attribute}"
  assert_rejected_before_password_change "${attribute}" || failures=$((failures + 1))
  cleanup_probe
done

prepare_probe
run_admin "CREATE SCHEMA task3_existing_writer_owned AUTHORIZATION ${probe_role}"
assert_rejected_before_password_change OWNERSHIP || failures=$((failures + 1))
cleanup_probe

prepare_probe
run_admin "GRANT pg_monitor TO ${probe_role}"
assert_rejected_before_password_change UNEXPECTED_MEMBERSHIP || failures=$((failures + 1))
cleanup_probe

prepare_probe
run_admin "CREATE ROLE ${member_role} NOLOGIN; GRANT ${probe_role} TO ${member_role}"
assert_rejected_before_password_change OUTBOUND_MEMBERSHIP || failures=$((failures + 1))
cleanup_probe

prepare_probe
run_admin "GRANT CREATE ON SCHEMA public TO ${probe_role}"
assert_rejected_before_password_change DIRECT_ACL || failures=$((failures + 1))
cleanup_probe

prepare_probe
run_admin "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO ${probe_role}"
assert_rejected_before_password_change DEFAULT_ACL || failures=$((failures + 1))
cleanup_probe

((failures == 0)) || exit 1
echo "disposable platform writer provisioning safety checks passed"
