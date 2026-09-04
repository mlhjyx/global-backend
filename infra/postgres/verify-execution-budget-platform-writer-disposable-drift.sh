#!/usr/bin/env bash
set -euo pipefail
[[ "${EXECUTION_BUDGET_PLATFORM_WRITER_DISPOSABLE_TEST:-}" == 1 ]] || { echo DISPOSABLE_MARKER_REQUIRED >&2; exit 1; }
[[ "${EXECUTION_BUDGET_PLATFORM_WRITER_PROVISION_DATABASE_URL:-}" == *'/global_test' ]] || { echo DISPOSABLE_DATABASE_REQUIRED >&2; exit 1; }
declare -A c; ledger=()
parse(){ local p="$1" n="$2" o; o="$(node - "$n" <<'NODE'
const v=process.env[process.argv[2]];let u;try{u=new URL(v)}catch{process.exit(1)}if(!['postgres:','postgresql:'].includes(u.protocol)||!u.hostname||!u.username||!u.password||!u.pathname||u.search||u.hash)process.exit(1);for(const[k,x]of Object.entries({PGHOST:u.hostname,PGPORT:u.port||'5432',PGDATABASE:decodeURIComponent(u.pathname.slice(1)),PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password)})){if(!x||/[\0\r\n]/.test(x))process.exit(1);process.stdout.write(`${k}=${x}\n`)}
NODE
)" || { echo DISPOSABLE_URL_INVALID >&2; exit 1; }; while IFS= read -r x;do [[ "$x" =~ ^PG(HOST|PORT|DATABASE|USER|PASSWORD)= ]]||exit 1;c["$p:${x%%=*}"]="${x#*=}";done<<<"$o"; }
parse ADMIN EXECUTION_BUDGET_PLATFORM_WRITER_PROVISION_DATABASE_URL;parse WRITER EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL;parse APP EXECUTION_BUDGET_PLATFORM_WRITER_APP_DATABASE_URL
run(){ local w="$1" q="$2";(export PGHOST="${c[$w:PGHOST]}" PGPORT="${c[$w:PGPORT]}" PGDATABASE="${c[$w:PGDATABASE]}" PGUSER="${c[$w:PGUSER]}" PGPASSWORD="${c[$w:PGPASSWORD]}";psql --no-psqlrc --set ON_ERROR_STOP=1 --quiet --command "$q" >/dev/null); }
cleanup(){ local rc=0 i; for((i=${#ledger[@]}-1;i>=0;i--));do run ADMIN "${ledger[i]}"||rc=1;done;((rc==0))||{ echo DISPOSABLE_CLEANUP_FAILED >&2;return 1;}; }
trap 'cleanup || exit 1' EXIT;trap 'exit 1' INT TERM
deny(){ if run "$1" "$2" 2>/dev/null;then echo DISPOSABLE_DENY_FAILED >&2;exit 1;fi; }
expect_verifier_rejected(){
  local label="$1"; shift
  if env "$@" bash infra/postgres/verify-execution-budget-platform-writer.sh >/dev/null 2>&1; then
    echo "PLATFORM_WRITER_VERIFIER_ACCEPTED_${label}" >&2
    return 1
  fi
}
binding_failures=0
expect_verifier_rejected WRONG_LOGIN \
  EXECUTION_BUDGET_PLATFORM_WRITER_LOGIN=task3_wrong_expected || binding_failures=$((binding_failures + 1))
mismatched_host_url="$(node - <<'NODE'
const url = new URL(process.env.EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL);
url.hostname = url.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';
process.stdout.write(url.toString());
NODE
)"
expect_verifier_rejected WRONG_HOST \
  EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL="${mismatched_host_url}" || binding_failures=$((binding_failures + 1))
run ADMIN "DROP DATABASE IF EXISTS task3_writer_other_database"
run ADMIN "CREATE DATABASE task3_writer_other_database TEMPLATE global_test"
ledger+=("DROP DATABASE IF EXISTS task3_writer_other_database")
mismatched_database_url="$(node - <<'NODE'
const url = new URL(process.env.EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL);
url.pathname = '/task3_writer_other_database';
process.stdout.write(url.toString());
NODE
)"
expect_verifier_rejected WRONG_DATABASE \
  EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL="${mismatched_database_url}" || binding_failures=$((binding_failures + 1))
((binding_failures == 0)) || exit 1
drift(){ run ADMIN "$1";ledger+=("$2"); if bash infra/postgres/verify-execution-budget-platform-writer.sh >/dev/null 2>&1;then echo DRIFT_NOT_REJECTED >&2;exit 1;fi; run ADMIN "$2" || { echo DISPOSABLE_CLEANUP_FAILED >&2;exit 1; }; unset "ledger[$((${#ledger[@]}-1))]"; bash infra/postgres/verify-execution-budget-platform-writer.sh >/dev/null || { echo DRIFT_RESTORE_FAILED >&2;exit 1; }; }
deny ADMIN "SELECT * FROM inspect_platform_execution_authority_freshness_v1(clock_timestamp())";deny APP "SELECT * FROM inspect_platform_execution_authority_freshness_v1(clock_timestamp())";deny APP "SELECT * FROM revoke_platform_execution_authority_v1('00000000-0000-4000-8000-000000000001','x',clock_timestamp())"
drift "GRANT pg_monitor TO ${EXECUTION_BUDGET_PLATFORM_WRITER_LOGIN}" "REVOKE pg_monitor FROM ${EXECUTION_BUDGET_PLATFORM_WRITER_LOGIN}"
drift "GRANT pg_read_all_data TO execution_budget_platform_writer" "REVOKE pg_read_all_data FROM execution_budget_platform_writer"
drift "CREATE ROLE task3_nested NOLOGIN; GRANT task3_nested TO execution_budget_platform_writer" "REVOKE task3_nested FROM execution_budget_platform_writer"
if [[ "${EXECUTION_BUDGET_PLATFORM_WRITER_FAILURE_INJECT_AFTER_DRIFT:-}" == superuser ]]; then
  run ADMIN "ALTER ROLE ${EXECUTION_BUDGET_PLATFORM_WRITER_LOGIN} SUPERUSER"; ledger+=("ALTER ROLE ${EXECUTION_BUDGET_PLATFORM_WRITER_LOGIN} NOSUPERUSER"); exit 42
fi
drift "ALTER ROLE ${EXECUTION_BUDGET_PLATFORM_WRITER_LOGIN} SUPERUSER" "ALTER ROLE ${EXECUTION_BUDGET_PLATFORM_WRITER_LOGIN} NOSUPERUSER"
drift "ALTER ROLE ${EXECUTION_BUDGET_PLATFORM_WRITER_LOGIN} BYPASSRLS" "ALTER ROLE ${EXECUTION_BUDGET_PLATFORM_WRITER_LOGIN} NOBYPASSRLS"
drift "ALTER ROLE ${EXECUTION_BUDGET_PLATFORM_WRITER_LOGIN} CREATEROLE" "ALTER ROLE ${EXECUTION_BUDGET_PLATFORM_WRITER_LOGIN} NOCREATEROLE"
echo "disposable platform writer drift checks passed"
