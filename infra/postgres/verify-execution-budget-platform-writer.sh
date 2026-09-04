#!/usr/bin/env bash
set -euo pipefail
for name in EXECUTION_BUDGET_PLATFORM_WRITER_PROVISION_DATABASE_URL EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL; do
  [[ -n "${!name:-}" ]] || { echo "platform writer verification requires ${name}" >&2; exit 1; }
done
declare -A connection
parse_url() {
  local prefix="$1" env_name="$2" parsed
  parsed="$(node - "$env_name" <<'NODE'
const value=process.env[process.argv[2]]; let url; try { url=new URL(value); } catch { process.exit(1); }
if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||!url.username||!url.password||!url.pathname||url.search||url.hash) process.exit(1);
for(const [key,item] of Object.entries({PGHOST:url.hostname,PGPORT:url.port||'5432',PGDATABASE:decodeURIComponent(url.pathname.slice(1)),PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password)})){if(!item||/[\0\r\n]/.test(item))process.exit(1);process.stdout.write(`${key}=${item}\n`)}
NODE
)" || { echo "platform writer verification database URL is invalid" >&2; exit 1; }
  while IFS= read -r item; do [[ "$item" =~ ^PG(HOST|PORT|DATABASE|USER|PASSWORD)= ]] || exit 1; connection["$prefix:${item%%=*}"]="${item#*=}"; done <<< "$parsed"
}
parse_url ADMIN EXECUTION_BUDGET_PLATFORM_WRITER_PROVISION_DATABASE_URL
parse_url WRITER EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL
run() { local which="$1" sql="$2"; (export PGHOST="${connection[$which:PGHOST]}" PGPORT="${connection[$which:PGPORT]}" PGDATABASE="${connection[$which:PGDATABASE]}" PGUSER="${connection[$which:PGUSER]}" PGPASSWORD="${connection[$which:PGPASSWORD]}"; psql --no-psqlrc --set ON_ERROR_STOP=1 --quiet --command "$sql" >/dev/null); }
ok(){ run "$1" "$2"; }
denied(){ if run "$1" "$2" 2>/dev/null; then echo "platform writer verification unexpectedly allowed a forbidden operation" >&2; exit 1; fi; }
ok ADMIN "SELECT 1 / ((EXISTS (SELECT 1 FROM pg_roles g WHERE g.rolname='execution_budget_platform_writer' AND NOT g.rolcanlogin AND NOT g.rolsuper AND NOT g.rolbypassrls AND NOT g.rolcreatedb AND NOT g.rolcreaterole AND NOT g.rolreplication) AND NOT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.member WHERE g.rolname='execution_budget_platform_writer') AND NOT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid JOIN pg_roles nested ON nested.oid=m.member WHERE g.rolname='execution_budget_platform_writer' AND NOT nested.rolcanlogin))::integer);"
ok WRITER "SELECT 1 / ((session_user=current_user AND p.rolcanlogin AND p.rolinherit AND NOT p.rolsuper AND NOT p.rolbypassrls AND NOT p.rolcreatedb AND NOT p.rolcreaterole AND NOT p.rolreplication AND (SELECT count(*)=1 AND bool_or(g.rolname='execution_budget_platform_writer') FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid WHERE m.member=p.oid))::integer) FROM pg_roles p WHERE p.rolname=session_user;"
ok WRITER "SELECT * FROM inspect_platform_execution_authority_freshness_v1(clock_timestamp());"
ok WRITER "BEGIN; SELECT * FROM ingest_platform_execution_authority('https://platform-writer-verification.invalid','global-backend:execution-budget','10000000-0000-4000-8000-000000000001','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','execution-budget-grant/v1','platform.acquisition','schedule','platform-writer-verification','platform-writer-verification','USD','microusd',1,1,1,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 minute'); ROLLBACK;"
denied WRITER "BEGIN; SET LOCAL ROLE execution_budget_platform_writer; SELECT * FROM inspect_platform_execution_authority_freshness_v1(clock_timestamp()); ROLLBACK;"
denied WRITER "INSERT INTO execution_budget_authority(scope_key) VALUES ('platform');"
denied WRITER "SELECT consume_workspace_execution_authority('x','x','10000000-0000-4000-8000-000000000001','a','x','understanding.run','10000000-0000-4000-8000-000000000001','company','x','a','USD','microusd',1,clock_timestamp(),clock_timestamp(),clock_timestamp());"
echo "platform writer principal positive and negative permission checks passed"
