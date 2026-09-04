#!/usr/bin/env bash
set -euo pipefail

required=(
  EXECUTION_BUDGET_PLATFORM_WRITER_PROVISION_DATABASE_URL
  EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "platform writer verification requires ${name}" >&2
    exit 1
  fi
done

ok() { psql "$1" --no-psqlrc --set ON_ERROR_STOP=1 --quiet --command "$2" >/dev/null; }
denied() {
  if psql "$1" --no-psqlrc --set ON_ERROR_STOP=1 --quiet --command "$2" >/dev/null 2>&1; then
    echo "platform writer verification unexpectedly allowed a forbidden operation" >&2
    exit 1
  fi
}

ok "${EXECUTION_BUDGET_PLATFORM_WRITER_PROVISION_DATABASE_URL}" "SELECT 1 / ((EXISTS (SELECT 1 FROM pg_roles g WHERE g.rolname='execution_budget_platform_writer' AND NOT g.rolcanlogin AND NOT g.rolsuper AND NOT g.rolbypassrls AND NOT g.rolcreatedb AND NOT g.rolcreaterole AND NOT g.rolreplication) AND NOT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.member WHERE g.rolname='execution_budget_platform_writer') AND NOT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid JOIN pg_roles nested ON nested.oid=m.member WHERE g.rolname='execution_budget_platform_writer' AND NOT nested.rolcanlogin))::integer);"
ok "${EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL}" "SELECT 1 / ((session_user=current_user AND p.rolcanlogin AND p.rolinherit AND NOT p.rolsuper AND NOT p.rolbypassrls AND NOT p.rolcreatedb AND NOT p.rolcreaterole AND NOT p.rolreplication AND (SELECT count(*)=1 AND bool_or(g.rolname='execution_budget_platform_writer') FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid WHERE m.member=p.oid))::integer) FROM pg_roles p WHERE p.rolname=session_user;"
ok "${EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL}" "SELECT * FROM inspect_platform_execution_authority_freshness_v1(clock_timestamp());"
ok "${EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL}" "BEGIN; SELECT * FROM ingest_platform_execution_authority('https://platform-writer-verification.invalid','global-backend:execution-budget','10000000-0000-4000-8000-000000000001','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','execution-budget-grant/v1','platform.acquisition','schedule','platform-writer-verification','platform-writer-verification','USD','microusd',1,1,1,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 minute'); ROLLBACK;"
denied "${EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL}" "BEGIN; SET LOCAL ROLE execution_budget_platform_writer; SELECT * FROM inspect_platform_execution_authority_freshness_v1(clock_timestamp()); ROLLBACK;"
denied "${EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL}" "INSERT INTO execution_budget_authority(scope_key,authority_kind,issuer,audience,jti,token_sha256,schema_version,purpose,subject_type,subject_id,schedule_id,currency,unit,cap_per_run_microusd,campaign_cap_microusd,max_runs,issued_at,not_before,expires_at) VALUES ('platform','PLATFORM_GRANT','x','global-backend:execution-budget','00000000-0000-4000-8000-000000000001','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','execution-budget-grant/v1','platform.acquisition','schedule','x','x','USD','microusd',1,1,1,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 minute');"
denied "${EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL}" "SELECT consume_workspace_execution_authority('x','global-backend:execution-budget','00000000-0000-4000-8000-000000000001','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','execution-budget-grant/v1','understanding.run','00000000-0000-4000-8000-000000000001','company','x','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','USD','microusd',1,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 minute');"

echo "platform writer principal positive and negative permission checks passed"
