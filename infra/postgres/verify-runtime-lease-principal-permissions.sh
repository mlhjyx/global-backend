#!/usr/bin/env bash
set -euo pipefail

required=(
  RUNTIME_LEASE_PROVISION_DATABASE_URL
  APP_DATABASE_URL
  RUNTIME_API_LEASE_DATABASE_URL
  RUNTIME_WORKER_LEASE_DATABASE_URL
  RUNTIME_PLATFORM_WORKER_LEASE_DATABASE_URL
  RUNTIME_OUTBOX_RELAY_LEASE_DATABASE_URL
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "runtime lease permission verification requires ${name}" >&2
    exit 1
  fi
done

psql_ok() {
  local url="$1"
  local sql="$2"
  psql "${url}" --no-psqlrc --set ON_ERROR_STOP=1 --quiet --command "${sql}" >/dev/null
}

psql_denied() {
  local url="$1"
  local sql="$2"
  if psql "${url}" --no-psqlrc --set ON_ERROR_STOP=1 --quiet --command "${sql}" \
    >/dev/null 2>&1; then
    echo "runtime lease permission unexpectedly allowed a forbidden operation" >&2
    exit 1
  fi
}

worker_cycle() {
  local url="$1" instance="$2" writer="$3" namespace="$4" workload="$5"
  local identity="'${instance}','understanding','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','20260919210100_runtime_worker_namespace_leases','2026-09-01T00:00:00Z'::timestamptz"
  local binding="'verification-cluster','${namespace}','${workload}','sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'"
  psql_ok "${url}" "BEGIN; SELECT register_${writer}_runtime_process_lease_v2(${identity},${binding}); SELECT heartbeat_${writer}_runtime_process_lease('${instance}','READY',clock_timestamp()); SELECT terminalize_${writer}_runtime_process_lease_v2(${identity},clock_timestamp(),${binding}); ROLLBACK;"
}

psql_ok "${RUNTIME_API_LEASE_DATABASE_URL}" \
  "BEGIN; SELECT register_api_runtime_process_lease('10000000-0000-4000-8000-000000000001',NULL,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','20260816220000_production_parity_budget_runtime','2026-09-01T00:00:00Z'::timestamptz); SELECT heartbeat_api_runtime_process_lease('10000000-0000-4000-8000-000000000001','READY',clock_timestamp()); SELECT terminalize_api_runtime_process_lease('10000000-0000-4000-8000-000000000001',NULL,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','20260816220000_production_parity_budget_runtime','2026-09-01T00:00:00Z'::timestamptz,clock_timestamp()); ROLLBACK;"
worker_cycle "${RUNTIME_WORKER_LEASE_DATABASE_URL}" '20000000-0000-4000-8000-000000000002' worker default customer-worker
worker_cycle "${RUNTIME_PLATFORM_WORKER_LEASE_DATABASE_URL}" '21000000-0000-4000-8000-000000000002' platform_worker platform-automation platform-worker
psql_ok "${RUNTIME_OUTBOX_RELAY_LEASE_DATABASE_URL}" \
  "BEGIN; SELECT register_outbox_relay_runtime_process_lease('30000000-0000-4000-8000-000000000003',NULL,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','20260816220000_production_parity_budget_runtime','2026-09-01T00:00:00Z'::timestamptz); SELECT heartbeat_outbox_relay_runtime_process_lease('30000000-0000-4000-8000-000000000003','READY',clock_timestamp()); SELECT terminalize_outbox_relay_runtime_process_lease('30000000-0000-4000-8000-000000000003',NULL,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','20260816220000_production_parity_budget_runtime','2026-09-01T00:00:00Z'::timestamptz,clock_timestamp()); ROLLBACK;"

psql_ok "${RUNTIME_API_LEASE_DATABASE_URL}" \
  "SELECT 1 / ((NOT principal.rolsuper AND NOT principal.rolbypassrls AND NOT principal.rolcreatedb AND NOT principal.rolcreaterole AND NOT principal.rolreplication AND principal.rolinherit AND (SELECT count(*)=1 AND bool_or(granted.rolname='runtime_api') FROM pg_auth_members membership JOIN pg_roles granted ON granted.oid=membership.roleid WHERE membership.member=principal.oid))::integer) FROM pg_roles principal WHERE principal.rolname=session_user;"
psql_ok "${RUNTIME_WORKER_LEASE_DATABASE_URL}" \
  "SELECT 1 / ((NOT principal.rolsuper AND NOT principal.rolbypassrls AND NOT principal.rolcreatedb AND NOT principal.rolcreaterole AND NOT principal.rolreplication AND principal.rolinherit AND (SELECT count(*)=1 AND bool_or(granted.rolname='runtime_worker') FROM pg_auth_members membership JOIN pg_roles granted ON granted.oid=membership.roleid WHERE membership.member=principal.oid))::integer) FROM pg_roles principal WHERE principal.rolname=session_user;"
psql_ok "${RUNTIME_OUTBOX_RELAY_LEASE_DATABASE_URL}" \
  "SELECT 1 / ((NOT principal.rolsuper AND NOT principal.rolbypassrls AND NOT principal.rolcreatedb AND NOT principal.rolcreaterole AND NOT principal.rolreplication AND principal.rolinherit AND (SELECT count(*)=1 AND bool_or(granted.rolname='runtime_outbox_relay') FROM pg_auth_members membership JOIN pg_roles granted ON granted.oid=membership.roleid WHERE membership.member=principal.oid))::integer) FROM pg_roles principal WHERE principal.rolname=session_user;"
psql_ok "${RUNTIME_PLATFORM_WORKER_LEASE_DATABASE_URL}" \
  "SELECT 1 / ((NOT principal.rolsuper AND NOT principal.rolbypassrls AND NOT principal.rolcreatedb AND NOT principal.rolcreaterole AND NOT principal.rolreplication AND principal.rolinherit AND (SELECT count(*)=1 AND bool_or(granted.rolname='runtime_platform_worker') FROM pg_auth_members membership JOIN pg_roles granted ON granted.oid=membership.roleid WHERE membership.member=principal.oid))::integer) FROM pg_roles principal WHERE principal.rolname=session_user;"

psql_denied "${RUNTIME_WORKER_LEASE_DATABASE_URL}" \
  "SELECT register_platform_worker_runtime_process_lease_v2(gen_random_uuid(),'understanding','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','verification',clock_timestamp(),'verification-cluster','platform-automation','platform-worker','sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd');"
psql_denied "${RUNTIME_PLATFORM_WORKER_LEASE_DATABASE_URL}" \
  "SELECT register_worker_runtime_process_lease_v2(gen_random_uuid(),'understanding','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','verification',clock_timestamp(),'verification-cluster','default','customer-worker','sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd');"

psql_denied "${RUNTIME_API_LEASE_DATABASE_URL}" \
  "SELECT register_worker_runtime_process_lease('40000000-0000-4000-8000-000000000004','understanding','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','20260816220000_production_parity_budget_runtime',clock_timestamp());"
psql_denied "${RUNTIME_API_LEASE_DATABASE_URL}" \
  "SELECT terminalize_worker_runtime_process_lease('40000000-0000-4000-8000-000000000004','understanding','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','20260816220000_production_parity_budget_runtime',clock_timestamp(),clock_timestamp());"
psql_denied "${RUNTIME_WORKER_LEASE_DATABASE_URL}" \
  "SELECT register_api_runtime_process_lease('50000000-0000-4000-8000-000000000005',NULL,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','20260816220000_production_parity_budget_runtime',clock_timestamp());"
psql_denied "${RUNTIME_OUTBOX_RELAY_LEASE_DATABASE_URL}" \
  "SELECT register_worker_runtime_process_lease('60000000-0000-4000-8000-000000000006','understanding','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','20260816220000_production_parity_budget_runtime',clock_timestamp());"
psql_denied "${RUNTIME_API_LEASE_DATABASE_URL}" \
  "SELECT register_runtime_process_lease('70000000-0000-4000-8000-000000000007','API',NULL,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','20260816220000_production_parity_budget_runtime',clock_timestamp());"
psql_denied "${APP_DATABASE_URL}" \
  "INSERT INTO runtime_process_lease(instance_id,role,state,build_sha,image_digest,artifact_digest,migration_revision,started_at,last_seen_at) VALUES ('80000000-0000-4000-8000-000000000008','API','STARTING','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','20260816220000_production_parity_budget_runtime',clock_timestamp(),clock_timestamp());"
psql_denied "${APP_DATABASE_URL}" \
  "SELECT register_api_runtime_process_lease('90000000-0000-4000-8000-000000000009',NULL,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','20260816220000_production_parity_budget_runtime',clock_timestamp());"
psql_denied "${APP_DATABASE_URL}" \
  "SELECT terminalize_api_runtime_process_lease('90000000-0000-4000-8000-000000000009',NULL,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','20260816220000_production_parity_budget_runtime',clock_timestamp(),clock_timestamp());"
psql_ok "${APP_DATABASE_URL}" "SELECT count(*) FROM runtime_process_lease;"
psql_ok "${APP_DATABASE_URL}" \
  "SELECT 1 / ((session_user='app_user' AND current_user='app_user' AND NOT principal.rolsuper AND NOT principal.rolbypassrls AND NOT principal.rolcreatedb AND NOT principal.rolcreaterole AND NOT principal.rolreplication AND principal.rolinherit AND NOT EXISTS (SELECT 1 FROM pg_auth_members membership WHERE membership.member=principal.oid))::integer) FROM pg_roles principal WHERE principal.rolname=session_user;"

echo "runtime lease principal positive and negative permission checks passed"
