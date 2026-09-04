#!/usr/bin/env bash
set -euo pipefail
[[ "${EXECUTION_BUDGET_PLATFORM_WRITER_DISPOSABLE_TEST:-}" == "1" ]] || { echo "disposable platform writer drift test marker required" >&2; exit 1; }
[[ "${EXECUTION_BUDGET_PLATFORM_WRITER_PROVISION_DATABASE_URL:-}" == *"/global_test" ]] || { echo "disposable platform writer drift test requires global_test" >&2; exit 1; }
admin="${EXECUTION_BUDGET_PLATFORM_WRITER_PROVISION_DATABASE_URL}"
writer="${EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL}"
app="${EXECUTION_BUDGET_PLATFORM_WRITER_APP_DATABASE_URL:-}"
[[ -n "$app" ]] || { echo "disposable platform writer app URL required" >&2; exit 1; }
ok(){ psql "$1" --no-psqlrc --set ON_ERROR_STOP=1 --quiet --command "$2" >/dev/null; }
denied(){ if ok "$1" "$2"; then echo "disposable platform writer drift unexpectedly allowed operation" >&2; exit 1; fi; }
expect_verify_fail(){ if bash infra/postgres/verify-execution-budget-platform-writer.sh >/dev/null 2>&1; then echo "drift unexpectedly verified" >&2; exit 1; fi; }
denied "$admin" "SELECT * FROM inspect_platform_execution_authority_freshness_v1(clock_timestamp());"
denied "$app" "SELECT * FROM inspect_platform_execution_authority_freshness_v1(clock_timestamp());"
denied "$app" "SELECT * FROM ingest_platform_execution_authority('x','x','00000000-0000-4000-8000-000000000001','a','x','platform.acquisition','schedule','x','x','USD','microusd',1,1,1,clock_timestamp(),clock_timestamp(),clock_timestamp());"
denied "$app" "SELECT * FROM revoke_platform_execution_authority_v1('00000000-0000-4000-8000-000000000001','x',clock_timestamp());"
for drift in "GRANT pg_monitor TO ${EXECUTION_BUDGET_PLATFORM_WRITER_LOGIN}" "GRANT pg_read_all_data TO execution_budget_platform_writer" "CREATE ROLE task3_nested NOLOGIN; GRANT task3_nested TO execution_budget_platform_writer" "ALTER ROLE ${EXECUTION_BUDGET_PLATFORM_WRITER_LOGIN} SUPERUSER" "ALTER ROLE ${EXECUTION_BUDGET_PLATFORM_WRITER_LOGIN} BYPASSRLS" "ALTER ROLE ${EXECUTION_BUDGET_PLATFORM_WRITER_LOGIN} CREATEROLE"; do
  ok "$admin" "$drift"; expect_verify_fail
  ok "$admin" "REVOKE pg_monitor FROM ${EXECUTION_BUDGET_PLATFORM_WRITER_LOGIN}; REVOKE pg_read_all_data FROM execution_budget_platform_writer; REVOKE task3_nested FROM execution_budget_platform_writer; ALTER ROLE ${EXECUTION_BUDGET_PLATFORM_WRITER_LOGIN} NOSUPERUSER NOBYPASSRLS NOCREATEROLE;"
done
echo "disposable platform writer drift checks passed"
